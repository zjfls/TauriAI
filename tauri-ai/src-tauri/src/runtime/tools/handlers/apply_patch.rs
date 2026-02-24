use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tokio::fs;

use crate::ai_client::ToolCall;
use crate::git_tools::{
    abs_to_repo_rel, create_ghost_commit_for_paths, create_ghost_commit_for_paths_with_worktree,
    ensure_git_repo, repo_prefix, resolve_repo_root, GhostCommit,
};
use crate::models::SandboxPolicy;
use crate::runtime::events::RunEvent;
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::sandbox::{
    dedupe_paths, effective_workspace_roots, is_path_under_any_root, normalize_root_for_join,
};
use crate::runtime::tools::spec::ToolSpec;

pub const APPLY_PATCH_TOOL_NAME: &str = "apply_patch";
pub const APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME: &str = "apply_patch_unified_diff";

pub struct ApplyPatchTool;
pub struct ApplyPatchUnifiedDiffTool;

#[derive(Debug, Deserialize)]
struct ApplyPatchArgs {
    input: String,
}

#[derive(Debug)]
enum Hunk {
    AddFile {
        path: PathBuf,
        contents: String,
    },
    DeleteFile {
        path: PathBuf,
    },
    UpdateFile {
        path: PathBuf,
        move_path: Option<PathBuf>,
        chunks: Vec<UpdateChunk>,
    },
}

#[derive(Debug, Clone)]
struct UpdateChunk {
    change_context: Option<String>,
    /// Whether `change_context` is a "soft" hint (best-effort) instead of a strict requirement.
    ///
    /// - Custom apply_patch format: `@@ some exact line` -> strict
    /// - Unified diff header: `@@ -a,b +c,d @@ heading` -> soft (heading may not exist verbatim)
    change_context_soft: bool,
    /// 0-based line hint extracted from unified diff headers (`@@ -old_start,... +... @@`).
    /// Used to pick the closest match when multiple candidates exist.
    line_hint: Option<usize>,
    old_lines: Vec<String>,
    new_lines: Vec<String>,
    is_end_of_file: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineEnding {
    Lf,
    CrLf,
}

impl LineEnding {
    fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
        }
    }
}

#[async_trait]
impl ToolHandler for ApplyPatchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: APPLY_PATCH_TOOL_NAME.to_string(),
            description: Some(
                "编辑工作区文件（Add/Delete/Update/Move）。补丁必须以 `*** Begin Patch` 开头、`*** End Patch` 结尾；`*** Update File` 内用 `@@` 开启变更块，可选 `@@ <单行锚定原文>` 用于推进定位（锚定行只用于定位，不会被替换）。变更块行必须以 ` ` / `-` / `+`（或新的 `@@`）开头；前导空格需精确匹配，且 `+`/`-` 后不要额外加空格。路径使用相对路径。".to_string(),
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "补丁正文（apply_patch 格式文本，以 `*** Begin Patch` 开头、`*** End Patch` 结尾）。"
                    }
                },
                "required": ["input"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::FileWrite],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        true
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        call_apply_patch_tool(APPLY_PATCH_TOOL_NAME, ctx, call, parse_patch_custom).await
    }
}

#[async_trait]
impl ToolHandler for ApplyPatchUnifiedDiffTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME.to_string(),
            description: Some(
                "使用 `apply_patch_unified_diff` 编辑工作区文件（Add/Delete/Update/Move）。`*** Update File` 内的每个变更块必须使用 unified diff 块头：`@@ -old_start,old_count +new_start,new_count @@ ...`；块内行必须以 ` ` / `-` / `+` 开头。".to_string(),
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "补丁正文（补丁外壳 + unified diff 变更块头）。"
                    }
                },
                "required": ["input"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::FileWrite],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        true
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        call_apply_patch_tool(
            APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME,
            ctx,
            call,
            parse_patch_unified_diff,
        )
        .await
    }
}

type PatchParser = fn(&str) -> Result<Vec<Hunk>, ToolError>;

async fn call_apply_patch_tool(
    tool_name: &str,
    ctx: &mut ToolExecutionContext<'_>,
    call: &ToolCall,
    parse: PatchParser,
) -> Result<ToolCallResult, ToolError> {
    let args: ApplyPatchArgs = serde_json::from_str(&call.arguments)
        .map_err(|e| ToolError::invalid(format!("解析 {tool_name} 参数失败: {e}")))?;
    let patch_text = args.input.trim();
    if patch_text.is_empty() {
        return Err(ToolError::invalid("input 不能为空"));
    }

    if matches!(ctx.sandbox_policy, SandboxPolicy::ReadOnly) {
        return Err(ToolError::denied(format!(
            "当前沙盒策略为 read-only：禁止使用 {tool_name} 写入文件"
        )));
    }

    let base_dir = ctx
        .default_workdir
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| ToolError::internal("无法确定默认工作目录"))?;

    let hunks = parse(patch_text)?;

    // Collect patch pathspecs for git snapshot/diff/undo meta (best-effort).
    // IMPORTANT: apply_patch is not transactional; meta helps UI show "what actually changed" and support Undo.
    let (affected_abs_paths, created_abs_paths) = collect_patch_paths(&base_dir, &hunks)?;
    let mut apply_patch_meta: serde_json::Value = json!({
        "applyPatch": {
            "baseDir": base_dir.display().to_string(),
        }
    });

    // Best-effort git snapshots (ghost commits) for:
    // - Undo: restore to "before"
    // - Diff: compare before..after (includes untracked in affected scope)
    let mut repo_root: Option<PathBuf> = None;
    let mut work_tree: Option<PathBuf> = None;
    let mut affected_rel: Vec<String> = Vec::new();
    let mut created_rel: Vec<String> = Vec::new();
    let mut ghost_before: Option<GhostCommit> = None;
    let mut ghost_after: Option<GhostCommit> = None;
    let mut snapshot_err_before: Option<String> = None;
    let mut snapshot_err_after: Option<String> = None;

    let abs_to_worktree_rel = |work_tree: &Path, abs: &Path| -> Option<String> {
        let rel = abs.strip_prefix(work_tree).ok()?;
        if rel.as_os_str().is_empty() {
            return None;
        }
        let mut parts: Vec<String> = Vec::new();
        for c in rel.components() {
            let s = match c {
                Component::Normal(v) => v.to_string_lossy().to_string(),
                Component::CurDir => ".".to_string(),
                Component::ParentDir => "..".to_string(),
                _ => continue,
            };
            if s.is_empty() {
                continue;
            }
            parts.push(s);
        }
        Some(parts.join("/"))
    };

    match resolve_repo_root(&base_dir).await {
        Ok(root) => {
            let prefix = repo_prefix(&root, &base_dir).map(|p| p.to_string_lossy().to_string());
            repo_root = Some(root.clone());
            work_tree = Some(root.clone());

            for abs in &affected_abs_paths {
                if let Some(rel) = abs_to_repo_rel(&root, abs) {
                    affected_rel.push(rel);
                }
            }
            affected_rel.sort();
            affected_rel.dedup();

            for abs in &created_abs_paths {
                if let Some(rel) = abs_to_repo_rel(&root, abs) {
                    created_rel.push(rel);
                }
            }
            created_rel.sort();
            created_rel.dedup();

            if !affected_rel.is_empty() {
                match create_ghost_commit_for_paths(
                    &root,
                    &affected_rel,
                    "tauri-ai apply_patch snapshot (before)",
                )
                .await
                {
                    Ok(c) => ghost_before = Some(c),
                    Err(e) => snapshot_err_before = Some(e),
                }
            }

            apply_patch_meta["applyPatch"]["git"] = json!({
                "repoRoot": root.display().to_string(),
                "workTree": root.display().to_string(),
                "repoPrefix": prefix,
                "affectedPaths": affected_rel,
                "createdPaths": created_rel,
                "ghostBefore": ghost_before.as_ref().map(|c| c.id.clone()),
            });
            if let Some(e) = snapshot_err_before.as_ref() {
                apply_patch_meta["applyPatch"]["git"]["snapshotErrorBefore"] = json!(e);
            }
        }
        Err(e) => {
            // Fallback: base_dir not in a git repo. Create a small snapshot repo under `<base_dir>/.tauriai/`.
            let snapshot_repo_root = base_dir.join(".tauriai").join("apply_patch_git");
            match ensure_git_repo(&snapshot_repo_root).await {
                Ok(()) => {
                    repo_root = Some(snapshot_repo_root.clone());
                    work_tree = Some(base_dir.clone());

                    for abs in &affected_abs_paths {
                        if let Some(rel) = abs_to_worktree_rel(&base_dir, abs) {
                            affected_rel.push(rel);
                        }
                    }
                    affected_rel.sort();
                    affected_rel.dedup();

                    for abs in &created_abs_paths {
                        if let Some(rel) = abs_to_worktree_rel(&base_dir, abs) {
                            created_rel.push(rel);
                        }
                    }
                    created_rel.sort();
                    created_rel.dedup();

                    if !affected_rel.is_empty() {
                        match create_ghost_commit_for_paths_with_worktree(
                            &snapshot_repo_root,
                            &base_dir,
                            &affected_rel,
                            "tauri-ai apply_patch snapshot (before)",
                        )
                        .await
                        {
                            Ok(c) => ghost_before = Some(c),
                            Err(err) => snapshot_err_before = Some(err),
                        }
                    }

                    apply_patch_meta["applyPatch"]["git"] = json!({
                        "repoRoot": snapshot_repo_root.display().to_string(),
                        "workTree": base_dir.display().to_string(),
                        "repoPrefix": null,
                        "affectedPaths": affected_rel,
                        "createdPaths": created_rel,
                        "ghostBefore": ghost_before.as_ref().map(|c| c.id.clone()),
                    });
                    if let Some(err) = snapshot_err_before.as_ref() {
                        apply_patch_meta["applyPatch"]["git"]["snapshotErrorBefore"] = json!(err);
                    }
                    apply_patch_meta["applyPatch"]["git"]["repoDetectError"] = json!(e);
                }
                Err(err) => {
                    apply_patch_meta["applyPatch"]["git"] = json!({
                        "error": format!("未检测到 git 仓库，且无法初始化快照仓库: {err}"),
                        "repoDetectError": e,
                    });
                }
            }
        }
    }

    let affected =
        match apply_hunks(&base_dir, &ctx.sandbox_policy, &ctx.workspace_roots, &hunks).await {
            Ok(v) => Ok(v),
            Err(err) => Err(err),
        };

    // Snapshot "after" even if apply_hunks failed (best-effort), so UI can still render what was written.
    if let (Some(root), Some(work_tree)) = (repo_root.as_ref(), work_tree.as_ref()) {
        let affected_paths = apply_patch_meta["applyPatch"]["git"]["affectedPaths"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        if !affected_paths.is_empty() {
            match create_ghost_commit_for_paths_with_worktree(
                root,
                work_tree,
                &affected_paths,
                "tauri-ai apply_patch snapshot (after)",
            )
            .await
            {
                Ok(c) => ghost_after = Some(c),
                Err(e) => snapshot_err_after = Some(e),
            }
        }
    }

    if apply_patch_meta["applyPatch"].get("git").is_some() {
        if let Some(c) = ghost_after.as_ref() {
            apply_patch_meta["applyPatch"]["git"]["ghostAfter"] = json!(c.id.clone());
        }
        if let Some(e) = snapshot_err_after.as_ref() {
            apply_patch_meta["applyPatch"]["git"]["snapshotErrorAfter"] = json!(e);
        }
    }

    let affected = affected.map_err(|e| e.with_meta(apply_patch_meta.clone()))?;

    let summary = format_summary(&base_dir, &affected);
    emit_tool_result(ctx, call.id.as_str(), &summary);

    Ok(ToolCallResult {
        content: summary,
        meta: Some(apply_patch_meta),
    })
}

#[derive(Debug, Default)]
struct AffectedPaths {
    added: Vec<PathBuf>,
    modified: Vec<PathBuf>,
    deleted: Vec<PathBuf>,
}

fn collect_patch_paths(
    base_dir: &Path,
    hunks: &[Hunk],
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), ToolError> {
    let mut affected: Vec<PathBuf> = Vec::new();
    let mut created: Vec<PathBuf> = Vec::new();

    for h in hunks {
        match h {
            Hunk::AddFile { path, .. } => {
                let abs = resolve_patch_path(base_dir, path)?;
                affected.push(abs.clone());
                created.push(abs);
            }
            Hunk::DeleteFile { path } => {
                let abs = resolve_patch_path(base_dir, path)?;
                affected.push(abs);
            }
            Hunk::UpdateFile {
                path, move_path, ..
            } => {
                let src_abs = resolve_patch_path(base_dir, path)?;
                affected.push(src_abs.clone());
                if let Some(dest_rel) = move_path {
                    let dest_abs = resolve_patch_path(base_dir, dest_rel)?;
                    if dest_abs != src_abs {
                        affected.push(dest_abs.clone());
                        created.push(dest_abs);
                    }
                }
            }
        }
    }

    affected.sort();
    affected.dedup();
    created.sort();
    created.dedup();
    Ok((affected, created))
}

fn emit_tool_result(ctx: &mut ToolExecutionContext<'_>, call_id: &str, content: &str) {
    ctx.emitter.emit(RunEvent::BlockDelta {
        task_id: ctx.task_id.to_string(),
        turn_id: ctx.turn_id.to_string(),
        assistant_message_id: Some(ctx.assistant_message_id.to_string()),
        block_id: format!("tool_result:{call_id}"),
        block_type: "tool_result".to_string(),
        format: Some("plain".to_string()),
        delta: content.to_string(),
    });
}

fn format_summary(base_dir: &Path, affected: &AffectedPaths) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Base dir: {}", base_dir.display()));

    if !affected.added.is_empty() {
        lines.push("Added:".to_string());
        for p in &affected.added {
            lines.push(format!("- {}", p.display()));
        }
    }
    if !affected.modified.is_empty() {
        lines.push("Modified:".to_string());
        for p in &affected.modified {
            lines.push(format!("- {}", p.display()));
        }
    }
    if !affected.deleted.is_empty() {
        lines.push("Deleted:".to_string());
        for p in &affected.deleted {
            lines.push(format!("- {}", p.display()));
        }
    }

    if affected.added.is_empty() && affected.modified.is_empty() && affected.deleted.is_empty() {
        lines.push("No files were modified.".to_string());
    }

    lines.join("\n")
}

async fn apply_hunks(
    base_dir: &Path,
    policy: &SandboxPolicy,
    workspace_roots: &[PathBuf],
    hunks: &[Hunk],
) -> Result<AffectedPaths, ToolError> {
    if hunks.is_empty() {
        return Err(ToolError::invalid("补丁为空：没有任何文件操作"));
    }

    let mut affected = AffectedPaths::default();

    let allowed_roots: Option<Vec<PathBuf>> = match policy {
        SandboxPolicy::WorkspaceWrite {
            writable_roots,
            exclude_tmpdir_env_var,
            exclude_slash_tmp,
            ..
        } => {
            let base_dir_buf = base_dir.to_path_buf();
            let mut roots = effective_workspace_roots(Some(&base_dir_buf), workspace_roots);

            for r in writable_roots {
                if let Some(p) = normalize_root_for_join(base_dir, r) {
                    roots.push(p);
                }
            }

            if !*exclude_tmpdir_env_var {
                roots.push(std::env::temp_dir());
            }

            #[cfg(not(unix))]
            let _ = exclude_slash_tmp;

            #[cfg(unix)]
            if !*exclude_slash_tmp && std::path::Path::new("/tmp").exists() {
                roots.push(PathBuf::from("/tmp"));
            }

            let roots = dedupe_paths(roots);
            if roots.is_empty() {
                return Err(ToolError::denied(
                    "workspace-write 策略需要可写根目录，但当前未绑定工作区目录",
                ));
            }
            Some(roots)
        }
        SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => None,
        SandboxPolicy::ReadOnly => {
            return Err(ToolError::denied("当前沙盒策略为 read-only：禁止写入文件"))
        }
    };

    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let abs = resolve_patch_path(base_dir, path)?;
                ensure_writable(policy, allowed_roots.as_ref(), &abs)?;
                if let Ok(meta) = fs::metadata(&abs).await {
                    if meta.is_dir() {
                        return Err(ToolError::invalid(format!(
                            "Add File 目标是目录: {}",
                            abs.display()
                        )));
                    }
                    return Err(ToolError::invalid(format!(
                        "Add File 目标已存在: {}",
                        abs.display()
                    )));
                }
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent)
                        .await
                        .map_err(|e| ToolError::new(format!("创建父目录失败: {e}")))?;
                }
                fs::write(&abs, contents)
                    .await
                    .map_err(|e| ToolError::new(format!("写入文件失败: {e}")))?;
                affected.added.push(abs);
            }
            Hunk::DeleteFile { path } => {
                let abs = resolve_patch_path(base_dir, path)?;
                ensure_writable(policy, allowed_roots.as_ref(), &abs)?;
                let meta = fs::metadata(&abs)
                    .await
                    .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;
                if meta.is_dir() {
                    return Err(ToolError::invalid(format!(
                        "Delete File 目标是目录: {}",
                        abs.display()
                    )));
                }
                fs::remove_file(&abs)
                    .await
                    .map_err(|e| ToolError::new(format!("删除文件失败: {e}")))?;
                affected.deleted.push(abs);
            }
            Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            } => {
                let src_abs = resolve_patch_path(base_dir, path)?;
                ensure_writable(policy, allowed_roots.as_ref(), &src_abs)?;
                let meta = fs::metadata(&src_abs)
                    .await
                    .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;
                if meta.is_dir() {
                    return Err(ToolError::invalid(format!(
                        "Update File 目标是目录: {}",
                        src_abs.display()
                    )));
                }

                let new_contents = if chunks.is_empty() {
                    fs::read_to_string(&src_abs)
                        .await
                        .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?
                } else {
                    apply_update_chunks(&src_abs, chunks).await?
                };

                if let Some(dest_rel) = move_path {
                    let dest_abs = resolve_patch_path(base_dir, dest_rel)?;
                    ensure_writable(policy, allowed_roots.as_ref(), &dest_abs)?;
                    if dest_abs == src_abs {
                        fs::write(&src_abs, new_contents)
                            .await
                            .map_err(|e| ToolError::new(format!("写入文件失败: {e}")))?;
                        affected.modified.push(src_abs);
                        continue;
                    }
                    if let Ok(meta) = fs::metadata(&dest_abs).await {
                        if meta.is_dir() {
                            return Err(ToolError::invalid(format!(
                                "Move to 目标是目录: {}",
                                dest_abs.display()
                            )));
                        }
                        return Err(ToolError::invalid(format!(
                            "Move to 目标已存在: {}",
                            dest_abs.display()
                        )));
                    }
                    if let Some(parent) = dest_abs.parent() {
                        fs::create_dir_all(parent)
                            .await
                            .map_err(|e| ToolError::new(format!("创建父目录失败: {e}")))?;
                    }
                    fs::write(&dest_abs, new_contents)
                        .await
                        .map_err(|e| ToolError::new(format!("写入文件失败: {e}")))?;
                    fs::remove_file(&src_abs)
                        .await
                        .map_err(|e| ToolError::new(format!("删除原文件失败: {e}")))?;
                    affected.modified.push(dest_abs);
                    affected.deleted.push(src_abs);
                } else {
                    fs::write(&src_abs, new_contents)
                        .await
                        .map_err(|e| ToolError::new(format!("写入文件失败: {e}")))?;
                    affected.modified.push(src_abs);
                }
            }
        }
    }

    Ok(affected)
}

fn resolve_patch_path(base_dir: &Path, path: &Path) -> Result<PathBuf, ToolError> {
    if path.as_os_str().is_empty() {
        return Err(ToolError::invalid("文件路径不能为空"));
    }

    // Absolute patch paths are allowed, but still need to pass sandbox checks later.
    if path.is_absolute() {
        for comp in path.components() {
            if matches!(comp, Component::ParentDir) {
                return Err(ToolError::invalid(
                    "补丁文件路径不允许包含 '..'（禁止路径穿越）",
                ));
            }
        }
        return Ok(path.to_path_buf());
    }

    // Relative patch paths are resolved under base_dir.
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                return Err(ToolError::invalid("相对路径不允许包含盘符/根路径"))
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(ToolError::invalid(
                    "相对路径不允许包含 '..'（禁止路径穿越）",
                ))
            }
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.contains(':') {
                    return Err(ToolError::invalid(
                        "相对路径不允许包含 ':'（疑似 Windows 盘符）",
                    ));
                }
            }
        }
    }

    Ok(base_dir.join(path))
}

fn ensure_writable(
    policy: &SandboxPolicy,
    allowed_roots: Option<&Vec<PathBuf>>,
    abs_path: &Path,
) -> Result<(), ToolError> {
    if policy.has_full_disk_write_access() {
        return Ok(());
    }

    match policy {
        SandboxPolicy::WorkspaceWrite { .. } => {
            let Some(roots) = allowed_roots else {
                return Err(ToolError::internal(
                    "workspace-write 策略缺少 allowed_roots 计算结果",
                ));
            };
            if !is_path_under_any_root(abs_path, roots) {
                return Err(ToolError::denied(format!(
                    "路径不在允许写入的根目录内: {}",
                    abs_path.display()
                )));
            }
            Ok(())
        }
        SandboxPolicy::ReadOnly => Err(ToolError::denied("当前沙盒策略为 read-only：禁止写入文件")),
        SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => Ok(()),
    }
}

fn parse_patch_custom(input: &str) -> Result<Vec<Hunk>, ToolError> {
    let lines = input.lines().collect::<Vec<_>>();
    if lines.len() < 2 {
        return Err(ToolError::invalid("补丁格式错误：缺少 Begin/End 标记"));
    }
    if lines.first().map(|l| l.trim_end()) != Some("*** Begin Patch") {
        return Err(ToolError::invalid("补丁第一行必须是 '*** Begin Patch'"));
    }
    if lines.last().map(|l| l.trim_end()) != Some("*** End Patch") {
        return Err(ToolError::invalid("补丁最后一行必须是 '*** End Patch'"));
    }

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut idx = 1usize;
    let end_idx = lines.len() - 1;

    while idx < end_idx {
        let line = lines[idx];
        if line.trim().is_empty() {
            idx += 1;
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Add File:") {
            let path = parse_patch_path(rest)?;
            idx += 1;
            let mut contents_lines: Vec<String> = Vec::new();
            while idx < end_idx && !is_hunk_start(lines[idx]) {
                let content_line = lines[idx];
                let Some(stripped) = content_line.strip_prefix('+') else {
                    return Err(ToolError::invalid(
                        "Add File 块内每行必须以 '+' 开头（空行用 '+' 表示）",
                    ));
                };
                contents_lines.push(stripped.to_string());
                idx += 1;
            }
            if contents_lines.is_empty() {
                return Err(ToolError::invalid("Add File 必须至少包含一行内容"));
            }
            let contents = contents_lines.join("\n") + "\n";
            hunks.push(Hunk::AddFile { path, contents });
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Delete File:") {
            let path = parse_patch_path(rest)?;
            idx += 1;
            hunks.push(Hunk::DeleteFile { path });
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Update File:") {
            let path = parse_patch_path(rest)?;
            idx += 1;

            let mut move_path: Option<PathBuf> = None;
            if idx < end_idx {
                if let Some(rest) = lines[idx].strip_prefix("*** Move to:") {
                    move_path = Some(parse_patch_path(rest)?);
                    idx += 1;
                }
            }

            let mut chunks: Vec<UpdateChunk> = Vec::new();
            let mut current: Option<UpdateChunk> = None;
            while idx < end_idx && !is_hunk_start(lines[idx]) {
                let change_line = lines[idx];
                if change_line == "*** End of File" {
                    if let Some(chunk) = current.as_mut() {
                        chunk.is_end_of_file = true;
                    } else {
                        return Err(ToolError::invalid(
                            "'*** End of File' 只能出现在 Update File 的变更块末尾",
                        ));
                    }
                    idx += 1;
                    continue;
                }

                if let Some(header) = change_line.strip_prefix("@@") {
                    finish_chunk(&mut current, &mut chunks);
                    let header = header.strip_prefix(' ').unwrap_or(header);
                    let parsed = parse_update_header_custom(header.trim())?;
                    current = Some(UpdateChunk {
                        change_context: parsed.change_context,
                        change_context_soft: parsed.change_context_soft,
                        line_hint: parsed.line_hint,
                        old_lines: Vec::new(),
                        new_lines: Vec::new(),
                        is_end_of_file: false,
                    });
                    idx += 1;
                    continue;
                }

                let first = change_line
                    .chars()
                    .next()
                    .ok_or_else(|| ToolError::invalid("Update File 变更行不能为空"))?;
                if !matches!(first, ' ' | '+' | '-') {
                    return Err(ToolError::invalid(format!(
                        "Update File 的变更块内每一行都必须以 ` ` / `-` / `+` / `@@` 开头（语义前缀）。检测到裸行：{change_line}\n如果这是上下文行，请写成：` {change_line}`（行首加 1 个空格）"
                    )));
                }
                if current.is_none() {
                    current = Some(UpdateChunk {
                        change_context: None,
                        change_context_soft: false,
                        line_hint: None,
                        old_lines: Vec::new(),
                        new_lines: Vec::new(),
                        is_end_of_file: false,
                    });
                }

                let remainder = change_line[1..].to_string();
                let chunk = current.as_mut().expect("chunk exists");
                match first {
                    ' ' => {
                        chunk.old_lines.push(remainder.clone());
                        chunk.new_lines.push(remainder);
                    }
                    '-' => chunk.old_lines.push(remainder),
                    '+' => chunk.new_lines.push(remainder),
                    _ => {}
                }
                idx += 1;
            }
            finish_chunk(&mut current, &mut chunks);
            hunks.push(Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            });
            continue;
        }

        return Err(ToolError::invalid(format!("未知补丁段落: {line}")));
    }

    Ok(hunks)
}

fn parse_patch_unified_diff(input: &str) -> Result<Vec<Hunk>, ToolError> {
    let lines = input.lines().collect::<Vec<_>>();
    if lines.len() < 2 {
        return Err(ToolError::invalid("补丁格式错误：缺少 Begin/End 标记"));
    }
    if lines.first().map(|l| l.trim_end()) != Some("*** Begin Patch") {
        return Err(ToolError::invalid("补丁第一行必须是 '*** Begin Patch'"));
    }
    if lines.last().map(|l| l.trim_end()) != Some("*** End Patch") {
        return Err(ToolError::invalid("补丁最后一行必须是 '*** End Patch'"));
    }

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut idx = 1usize;
    let end_idx = lines.len() - 1;

    while idx < end_idx {
        let line = lines[idx];
        if line.trim().is_empty() {
            idx += 1;
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Add File:") {
            let path = parse_patch_path(rest)?;
            idx += 1;
            let mut contents_lines: Vec<String> = Vec::new();
            while idx < end_idx && !is_hunk_start(lines[idx]) {
                let content_line = lines[idx];
                let Some(stripped) = content_line.strip_prefix('+') else {
                    return Err(ToolError::invalid(
                        "Add File 块内每行必须以 '+' 开头（空行用 '+' 表示）",
                    ));
                };
                contents_lines.push(stripped.to_string());
                idx += 1;
            }
            if contents_lines.is_empty() {
                return Err(ToolError::invalid("Add File 必须至少包含一行内容"));
            }
            let contents = contents_lines.join("\n") + "\n";
            hunks.push(Hunk::AddFile { path, contents });
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Delete File:") {
            let path = parse_patch_path(rest)?;
            idx += 1;
            hunks.push(Hunk::DeleteFile { path });
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Update File:") {
            let path = parse_patch_path(rest)?;
            idx += 1;

            let mut move_path: Option<PathBuf> = None;
            if idx < end_idx {
                if let Some(rest) = lines[idx].strip_prefix("*** Move to:") {
                    move_path = Some(parse_patch_path(rest)?);
                    idx += 1;
                }
            }

            let mut chunks: Vec<UpdateChunk> = Vec::new();
            let mut current: Option<UpdateChunk> = None;
            while idx < end_idx && !is_hunk_start(lines[idx]) {
                let change_line = lines[idx];
                if change_line == "*** End of File" {
                    if let Some(chunk) = current.as_mut() {
                        chunk.is_end_of_file = true;
                    } else {
                        return Err(ToolError::invalid(
                            "'*** End of File' 只能出现在 Update File 的变更块末尾",
                        ));
                    }
                    idx += 1;
                    continue;
                }

                if let Some(header) = change_line.strip_prefix("@@") {
                    finish_chunk(&mut current, &mut chunks);
                    let header = header.strip_prefix(' ').unwrap_or(header);
                    let parsed = parse_update_header_unified_diff(header.trim())?;
                    current = Some(UpdateChunk {
                        change_context: parsed.change_context,
                        change_context_soft: parsed.change_context_soft,
                        line_hint: parsed.line_hint,
                        old_lines: Vec::new(),
                        new_lines: Vec::new(),
                        is_end_of_file: false,
                    });
                    idx += 1;
                    continue;
                }

                let first = change_line
                    .chars()
                    .next()
                    .ok_or_else(|| ToolError::invalid("Update File 变更行不能为空"))?;
                if !matches!(first, ' ' | '+' | '-') {
                    return Err(ToolError::invalid(format!(
                        "Update File 的变更块内每一行都必须以 ` ` / `-` / `+` / `@@` 开头（语义前缀）。检测到裸行：{change_line}\n如果这是上下文行，请写成：` {change_line}`（行首加 1 个空格）"
                    )));
                }

                // Unified diff patches must always start a chunk with an explicit unified header.
                if current.is_none() {
                    return Err(ToolError::invalid(
                        "apply_patch_unified_diff 要求每个变更块都以 unified diff 头开始：`@@ -old_start,old_count +new_start,new_count @@ optional heading`",
                    ));
                }

                let remainder = change_line[1..].to_string();
                let chunk = current.as_mut().expect("chunk exists");
                match first {
                    ' ' => {
                        chunk.old_lines.push(remainder.clone());
                        chunk.new_lines.push(remainder);
                    }
                    '-' => chunk.old_lines.push(remainder),
                    '+' => chunk.new_lines.push(remainder),
                    _ => {}
                }
                idx += 1;
            }
            finish_chunk(&mut current, &mut chunks);
            hunks.push(Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            });
            continue;
        }

        return Err(ToolError::invalid(format!("未知补丁段落: {line}")));
    }

    Ok(hunks)
}

/// Detect whether a freeform text is actually an `apply_patch` body.
///
/// This is used to intercept common model mistakes where the patch text is
/// sent to `shell_command` / `exec_command` instead of calling the `apply_patch`
/// tool directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VerifiedApplyPatchKind {
    Custom,
    UnifiedDiff,
}

pub(crate) fn extract_verified_apply_patch_from_text(
    text: &str,
) -> Option<(String, VerifiedApplyPatchKind)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Accept either a raw patch body, or a patch body prefixed by the literal tool name
    // (common when a model tries to "run" apply_patch).
    let candidate = if trimmed.starts_with("*** Begin Patch") {
        trimmed
    } else {
        let mut rest = None;
        for prefix in [APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME, APPLY_PATCH_TOOL_NAME] {
            if let Some(r) = trimmed.strip_prefix(prefix) {
                rest = Some(r.trim_start());
                break;
            }
        }
        let rest = rest?;
        if rest.starts_with("*** Begin Patch") {
            rest
        } else {
            return None;
        }
    };

    // Fast reject before invoking the full parser.
    if !candidate.contains("*** End Patch") {
        return None;
    }

    if parse_patch_custom(candidate).is_ok() {
        return Some((candidate.to_string(), VerifiedApplyPatchKind::Custom));
    }
    if parse_patch_unified_diff(candidate).is_ok() {
        return Some((candidate.to_string(), VerifiedApplyPatchKind::UnifiedDiff));
    }
    None
}

fn is_hunk_start(line: &str) -> bool {
    line.starts_with("*** Add File:")
        || line.starts_with("*** Delete File:")
        || line.starts_with("*** Update File:")
        || line.trim_end() == "*** End Patch"
}

fn parse_patch_path(rest: &str) -> Result<PathBuf, ToolError> {
    let raw = rest.trim();
    if raw.is_empty() {
        return Err(ToolError::invalid("文件路径不能为空"));
    }
    Ok(PathBuf::from(raw))
}

#[derive(Debug, Clone)]
struct ParsedUpdateHeader {
    change_context: Option<String>,
    change_context_soft: bool,
    line_hint: Option<usize>,
}

fn parse_update_header_custom(header: &str) -> Result<ParsedUpdateHeader, ToolError> {
    // Custom anchors treat the header as an exact line match (leading whitespace is significant).
    // Only trim line-ending whitespace; `seek_sequence` already tolerates `trim_end` when matching.
    let trimmed = header.trim_end();
    if trimmed.is_empty() {
        return Ok(ParsedUpdateHeader {
            change_context: None,
            change_context_soft: false,
            line_hint: None,
        });
    }

    if try_parse_unified_diff_header(trimmed).is_some() {
        // Keep standards isolated: unified diff patches must use the dedicated tool.
        return Err(ToolError::invalid(format!(
            "{APPLY_PATCH_TOOL_NAME} 不支持 unified diff 变更块头（检测到: '@@ {trimmed}'）。请改用 {APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME}。",
        )));
    }

    // Custom apply_patch header: `@@ some exact line`
    Ok(ParsedUpdateHeader {
        change_context: Some(trimmed.to_string()),
        change_context_soft: false,
        line_hint: None,
    })
}

fn parse_update_header_unified_diff(header: &str) -> Result<ParsedUpdateHeader, ToolError> {
    let trimmed = header.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid(format!(
            "{APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME} 的变更块头不能为空；需要 unified diff 头：`@@ -old_start,old_count +new_start,new_count @@ optional heading`",
        )));
    }

    // Support unified diff hunk headers:
    //   @@ -old_start,old_count +new_start,new_count @@ optional heading
    // We ignore the counts, use `old_start` as a 0-based hint, and treat the optional heading
    // as a *soft* anchor (best-effort), because it may not exist verbatim in the file.
    if let Some(parsed) = try_parse_unified_diff_header(trimmed) {
        return Ok(parsed);
    }

    Err(ToolError::invalid(format!(
        "{APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME} 仅支持 unified diff 变更块头：`@@ -old_start,old_count +new_start,new_count @@ optional heading`（收到: '@@ {trimmed}'）",
    )))
}

fn try_parse_unified_diff_header(header: &str) -> Option<ParsedUpdateHeader> {
    let header = header.trim_start();
    if !header.starts_with('-') {
        return None;
    }

    // Unified diff header has a trailing "@@" separator.
    let atat_pos = header.find("@@")?;
    let (range_part, tail) = header.split_at(atat_pos);
    let range_part = range_part.trim();
    let heading = tail.strip_prefix("@@").unwrap_or("").trim();

    let old_start_0 = parse_unified_diff_range_old_start(range_part)?;
    let ctx = if heading.is_empty() {
        None
    } else {
        Some(heading.to_string())
    };

    Some(ParsedUpdateHeader {
        change_context: ctx,
        change_context_soft: true,
        line_hint: Some(old_start_0),
    })
}

fn parse_unified_diff_range_old_start(range: &str) -> Option<usize> {
    // Expected: "-<old_start>[,<old_count>] +<new_start>[,<new_count>]"
    // Counts are optional. We only use old_start.
    let mut chars = range.trim().chars().peekable();

    if chars.next()? != '-' {
        return None;
    }
    let old_start = parse_usize_from_chars(&mut chars)?;
    if matches!(chars.peek(), Some(',')) {
        let _ = chars.next();
        let _ = parse_usize_from_chars(&mut chars)?;
    }

    consume_spaces(&mut chars);

    if chars.next()? != '+' {
        return None;
    }
    let _new_start = parse_usize_from_chars(&mut chars)?;
    if matches!(chars.peek(), Some(',')) {
        let _ = chars.next();
        let _ = parse_usize_from_chars(&mut chars)?;
    }

    consume_spaces(&mut chars);
    if chars.peek().is_some() {
        return None;
    }

    Some(old_start.saturating_sub(1))
}

fn parse_usize_from_chars<I: Iterator<Item = char>>(
    chars: &mut std::iter::Peekable<I>,
) -> Option<usize> {
    let mut n: usize = 0;
    let mut any = false;
    while let Some(c) = chars.peek().copied() {
        if !c.is_ascii_digit() {
            break;
        }
        any = true;
        chars.next();
        n = n
            .saturating_mul(10)
            .saturating_add((c as u8 - b'0') as usize);
    }
    if any {
        Some(n)
    } else {
        None
    }
}

fn consume_spaces<I: Iterator<Item = char>>(chars: &mut std::iter::Peekable<I>) {
    while matches!(chars.peek(), Some(' ' | '\t')) {
        let _ = chars.next();
    }
}

fn finish_chunk(current: &mut Option<UpdateChunk>, out: &mut Vec<UpdateChunk>) {
    let Some(chunk) = current.take() else {
        return;
    };
    if chunk.old_lines.is_empty()
        && chunk.new_lines.is_empty()
        && chunk.change_context.is_none()
        && chunk.line_hint.is_none()
    {
        return;
    }
    out.push(chunk);
}

async fn apply_update_chunks(path: &Path, chunks: &[UpdateChunk]) -> Result<String, ToolError> {
    let original = fs::read_to_string(path)
        .await
        .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;
    let line_ending = if original.contains("\r\n") {
        LineEnding::CrLf
    } else {
        LineEnding::Lf
    };

    let mut original_lines: Vec<String> = original
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    if original_lines.last().is_some_and(|l| l.is_empty()) {
        original_lines.pop();
    }

    let replacements = compute_replacements(&original_lines, chunks, path)?;
    let mut new_lines = apply_replacements(original_lines, &replacements);
    if !new_lines.last().is_some_and(|l| l.is_empty()) {
        new_lines.push(String::new());
    }

    Ok(new_lines.join(line_ending.as_str()))
}

fn compute_replacements(
    original_lines: &[String],
    chunks: &[UpdateChunk],
    path: &Path,
) -> Result<Vec<(usize, usize, Vec<String>)>, ToolError> {
    let mut replacements: Vec<(usize, usize, Vec<String>)> = Vec::new();
    let mut line_index: usize = 0;

    for chunk in chunks {
            if let Some(ctx_line) = chunk.change_context.as_ref() {
                let ctx_pattern = vec![ctx_line.to_string()];
                let found = seek_sequence(
                    original_lines,
                    &ctx_pattern,
                    line_index,
                    false,
                    chunk.line_hint,
                    SeekAmbiguityPolicy::FirstMatch,
                )?;
                if let Some(idx) = found {
                    line_index = idx + 1;
                } else if !chunk.change_context_soft {
                    return Err(ToolError::new(format!(
                        "无法找到锚定行（@@）: '{ctx_line}'（文件: {}）。\n锚定行必须与文件中的整行原文精确匹配（前导空格也要一致；允许忽略行尾空白）。\n提示：如果你想修改这行本身，不要把它当作锚定行；请改锚定到它的上一行，或用上下文行（以空格开头）+ `-`/`+` 做替换。",
                        path.display()
                    )));
                }
            }

        // Anchor-only chunk (no changes). This enables multi-line anchoring by repeating
        // `@@ <exact line>` headers (Codex-like) without triggering any insertion.
        if chunk.old_lines.is_empty() && chunk.new_lines.is_empty() {
            continue;
        }

        if chunk.old_lines.is_empty() {
            // Insertion chunk (only '+' lines, no '-'/' ' context).
            //
            // Policy:
            // - If an explicit anchor was provided (`@@ <anchorline>`), insert right after the
            //   anchored location (i.e., at the current cursor).
            // - Otherwise, default to inserting at the beginning of the file.
            //
            // Note: unified diff may provide a line hint; if present, use it.
            let insert_at = if let Some(h) = chunk.line_hint {
                h
            } else if chunk.change_context.is_some() {
                line_index
            } else {
                0
            };
            let insert_at = insert_at.min(original_lines.len());
            replacements.push((insert_at, 0, chunk.new_lines.clone()));
            continue;
        }

        let mut pattern: &[String] = &chunk.old_lines;
        let mut new_slice: &[String] = &chunk.new_lines;
            let mut found = seek_sequence(
                original_lines,
                pattern,
                line_index,
                chunk.is_end_of_file,
                chunk.line_hint,
                SeekAmbiguityPolicy::RequireUniqueIfNoHint,
            )?;

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
                found = seek_sequence(
                    original_lines,
                    pattern,
                    line_index,
                    chunk.is_end_of_file,
                    chunk.line_hint,
                    SeekAmbiguityPolicy::RequireUniqueIfNoHint,
                )?;
            }

        if let Some(start_idx) = found {
            replacements.push((start_idx, pattern.len(), new_slice.to_vec()));
            line_index = start_idx + pattern.len();
        } else {
            let anchor = chunk
                .change_context
                .as_ref()
                .map(|s| format!("'{}'", s))
                .unwrap_or_else(|| "<无>".to_string());
            let start_line_1based = line_index.saturating_add(1);
            let mut extra_hint = String::new();
            if let Some(ctx) = chunk.change_context.as_ref() {
                if chunk
                    .old_lines
                    .first()
                    .is_some_and(|l| l.trim_end() == ctx.trim_end())
                {
                    extra_hint.push_str("\n提示：检测到待替换片段的第一行与锚定行相同。`@@ <锚定行>` 会把搜索起点移动到锚定行之后（下一行），因此同一块里通常无法再替换锚定行本身；请改锚定到上一行或改用上下文行定位。\n");
                }
            }

            return Err(ToolError::new(format!(
                "无法在 {} 中定位待替换片段（old code block；由上下文行 ` ` + 删除行 `-` 组成，必须连续匹配）：\n{}\n\n定位信息：\n- 搜索起点（1-based 行号）：{start_line_1based}\n- 锚定行（@@）：{anchor}\n{extra_hint}\n常见原因：\n- 前导空格/缩进不一致（只忽略行尾空白）\n- `-` 行不是整行原文，或文件已变更/补丁已应用\n- `-`/`+` 后多了空格（会把空格当作内容的一部分）\n建议：补充 1–3 行上下文行（以空格开头）来缩小范围，或把锚定行改成目标行的上一行。",
                path.display(),
                chunk.old_lines.join("\n")
            )));
        }
    }

    replacements.sort_by(|(a, _, _), (b, _, _)| a.cmp(b));
    Ok(replacements)
}

    fn apply_replacements(
        mut lines: Vec<String>,
        replacements: &[(usize, usize, Vec<String>)],
    ) -> Vec<String> {
    for (start_idx, old_len, new_segment) in replacements.iter().rev() {
        let start_idx = *start_idx;
        let old_len = *old_len;

        for _ in 0..old_len {
            if start_idx < lines.len() {
                lines.remove(start_idx);
            }
        }

        for (offset, new_line) in new_segment.iter().enumerate() {
            lines.insert(start_idx + offset, new_line.clone());
        }
    }
        lines
}

    #[derive(Debug, Clone, Copy)]
    enum SeekAmbiguityPolicy {
        /// 多处命中时选择第一处（若提供了 line_hint，则选择最接近 hint 的那一处）。
        ///
        /// 用途：`@@ <锚定行>` 只负责推进搜索起点，允许锚定行在文件中出现多次。
        FirstMatch,
        /// 多处命中时要求唯一；但如果提供了 line_hint，则用 hint 消歧并选择最接近的一处。
        ///
        /// 用途：`old_lines`（context lines + `-` lines 组成的连续片段）一旦多处命中就有较大概率“改错地方”，
        /// 因此默认拒绝并提示补充更多上下文行或更具体锚点。
        RequireUniqueIfNoHint,
}

    fn seek_sequence(
        lines: &[String],
        pattern: &[String],
        start: usize,
        eof: bool,
        hint: Option<usize>,
        ambiguity_policy: SeekAmbiguityPolicy,
    ) -> Result<Option<usize>, ToolError> {
    if pattern.is_empty() {
        return Ok(Some(start));
    }
    if pattern.len() > lines.len() {
        return Ok(None);
    }

    let max_start = lines.len().saturating_sub(pattern.len());
    let search_start = if eof && lines.len() >= pattern.len() {
        max_start
    } else {
        start.min(lines.len())
    };
    if search_start > max_start {
        return Ok(None);
    }

    fn normalise_no_trim(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
                | '\u{2212}' => '-',
                '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
                '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
                '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
                | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
                | '\u{3000}' => ' ',
                other => other,
            })
            .collect::<String>()
    }

    let mut candidates: Vec<usize> = Vec::new();

    fn scan<F: FnMut(&str, &str) -> bool>(
        out: &mut Vec<usize>,
        lines: &[String],
        pattern: &[String],
        search_start: usize,
        max_start: usize,
        mut cmp: F,
    ) {
        for idx in search_start..=max_start {
            let mut ok = true;
            for (pat_idx, pat) in pattern.iter().enumerate() {
                if !cmp(&lines[idx + pat_idx], pat) {
                    ok = false;
                    break;
                }
            }
            if ok {
                out.push(idx);
            }
        }
    }

    // 1) Exact
    scan(
        &mut candidates,
        lines,
        pattern,
        search_start,
        max_start,
        |a, b| a == b,
    );
    if candidates.is_empty() {
        // 2) trim_end
        scan(
            &mut candidates,
            lines,
            pattern,
            search_start,
            max_start,
            |a, b| a.trim_end() == b.trim_end(),
        );
    }
    if candidates.is_empty() {
        // 3) normalize unicode punctuation/whitespace (do NOT trim; keep leading whitespace strict)
        scan(
            &mut candidates,
            lines,
            pattern,
            search_start,
            max_start,
            |a, b| normalise_no_trim(a) == normalise_no_trim(b),
        );
    }

    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() == 1 {
        return Ok(Some(candidates[0]));
    }

    if let Some(h) = hint {
        let mut best = candidates[0];
        let mut best_dist = best.abs_diff(h);
        for &idx in &candidates[1..] {
            let d = idx.abs_diff(h);
            if d < best_dist || (d == best_dist && idx < best) {
                best = idx;
                best_dist = d;
            }
        }
        return Ok(Some(best));
    }

    match ambiguity_policy {
        SeekAmbiguityPolicy::FirstMatch => Ok(Some(candidates[0])),
        SeekAmbiguityPolicy::RequireUniqueIfNoHint => {
            let preview = pattern
                .iter()
                .take(3)
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let locs = candidates
                .iter()
                .take(8)
                .map(|idx| (idx + 1).to_string())
                .collect::<Vec<_>>()
                .join(", ");
            Err(ToolError::new(format!(
                "补丁定位不唯一：待替换片段（old code block：由上下文行 ` ` + 删除行 `-` 组成的连续片段）在文件中出现多处（{} 处，起始行示例：{}）。\n为避免误修改，已拒绝执行。请在补丁中添加更多上下文行（以空格开头），或使用更具体的 `@@ <锚定行>` 来缩小搜索范围。\n匹配片段预览（前 3 行）：\n{}",
                candidates.len(),
                locs,
                preview
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::tools::registry::ToolErrorKind;

    use tempfile::tempdir;

    #[tokio::test]
    async fn apply_patch_add_update_delete_roundtrip() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();

        let patch = r#"*** Begin Patch
*** Add File: a.txt
+hello
+world
*** Update File: a.txt
@@
-hello
+HELLO
*** Delete File: a.txt
*** End Patch"#;

        let hunks = parse_patch_custom(patch).expect("parse");
        let affected = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");
        assert_eq!(affected.added.len(), 1);
        assert_eq!(affected.modified.len(), 1);
        assert_eq!(affected.deleted.len(), 1);
        assert!(!base.join("a.txt").exists());
    }

    #[tokio::test]
    async fn apply_patch_update_preserves_crlf_endings() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("b.txt");
        fs::write(&file_path, "a\r\nb\r\n").await.expect("write");

        let patch = r#"*** Begin Patch
*** Update File: b.txt
@@
 a
-b
+B
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");
        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert!(updated.contains("\r\n"));
        assert_eq!(updated, "a\r\nB\r\n");
    }

    #[tokio::test]
    async fn apply_patch_unified_diff_update_accepts_unified_diff_hunk_headers() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("c.txt");
        fs::write(&file_path, "hello\nworld\n")
            .await
            .expect("write");

        let patch = r#"*** Begin Patch
*** Update File: c.txt
@@ -1,2 +1,2 @@
-hello
+HELLO
*** End Patch"#;
        let hunks = parse_patch_unified_diff(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");

        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert_eq!(updated, "HELLO\nworld\n");
    }

    #[tokio::test]
    async fn apply_patch_unified_diff_heading_is_best_effort() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("d.txt");
        fs::write(&file_path, "hello\nworld\n")
            .await
            .expect("write");

        // Heading after the second @@ is a hint in unified diff; it might not exist verbatim.
        let patch = r#"*** Begin Patch
*** Update File: d.txt
@@ -1,2 +1,2 @@ this heading does not exist
-hello
+HELLO
*** End Patch"#;
        let hunks = parse_patch_unified_diff(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");

        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert_eq!(updated, "HELLO\nworld\n");
    }

    #[tokio::test]
    async fn apply_patch_update_errors_on_ambiguous_old_lines_without_hint() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("e.txt");
        fs::write(&file_path, "alpha\nbeta\nalpha\nbeta\n")
            .await
            .expect("write");

        let patch = r#"*** Begin Patch
*** Update File: e.txt
@@
-alpha
+ALPHA
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let err = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect_err("should fail");
        assert!(err.message.contains("补丁定位不唯一"));
    }

    #[tokio::test]
    async fn apply_patch_custom_allows_ambiguous_anchor_but_requires_unique_old_lines() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("anchor.txt");
        fs::write(&file_path, "alpha\nbeta1\nalpha\nbeta2\n")
            .await
            .expect("write");

        // `@@ alpha` 在文件中出现两次，属于“锚定行不唯一”；应当选择从文件头开始的第一处命中。
        // 随后的 old_lines（beta1）在锚定之后只有一处命中，因此替换应当稳定且成功。
        let patch = r#"*** Begin Patch
*** Update File: anchor.txt
@@ alpha
-beta1
+BETA1
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");

        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert_eq!(updated, "alpha\nBETA1\nalpha\nbeta2\n");
    }

    #[tokio::test]
    async fn apply_patch_custom_allows_multi_line_anchor_via_repeated_headers() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("multi.txt");
        fs::write(&file_path, "alpha\nbeta\nalpha\nbeta\n")
            .await
            .expect("write");

        // Replace the *second* "alpha" by anchoring on the first "alpha" then the next "beta".
        let patch = r#"*** Begin Patch
*** Update File: multi.txt
@@ alpha
@@ beta
-alpha
+ALPHA
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");

        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert_eq!(updated, "alpha\nbeta\nALPHA\nbeta\n");
    }

    #[tokio::test]
    async fn apply_patch_custom_inserts_after_anchor_with_plus_only() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("insert.txt");
        fs::write(&file_path, "a\nb\n").await.expect("write");

        // Insert "X" after the anchored line "a", without repeating context lines.
        let patch = r#"*** Begin Patch
*** Update File: insert.txt
@@ a
+X
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");

        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert_eq!(updated, "a\nX\nb\n");
    }

    #[tokio::test]
    async fn apply_patch_custom_plus_only_inserts_at_bof_without_anchor() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("append.txt");
        fs::write(&file_path, "Line 1\nLine 2\nLine 3\n")
            .await
            .expect("write");

        // Without any anchor and without any old/context lines, a pure "+..." chunk defaults to
        // inserting at beginning-of-file.
        let patch = r#"*** Begin Patch
*** Update File: append.txt
@@
+Line 4
+Line 5
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let _ = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect("apply");

        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert_eq!(updated, "Line 4\nLine 5\nLine 1\nLine 2\nLine 3\n");
    }

    #[tokio::test]
    async fn apply_patch_custom_does_not_ignore_leading_whitespace() {
        let dir = tempdir().expect("tmp");
        let base = dir.path();
        let file_path = base.join("indent.txt");
        fs::write(&file_path, "NO_INDENT\nUNIQUE_NO_SPACE\nNO_INDENT2\n")
            .await
            .expect("write");

        // The file line has no leading whitespace. A patch that adds leading whitespace in the
        // `-...` line must fail to match.
        let patch = r#"*** Begin Patch
*** Update File: indent.txt
@@
-    UNIQUE_NO_SPACE
+CHANGED
*** End Patch"#;
        let hunks = parse_patch_custom(patch).expect("parse");
        let err = apply_hunks(base, &SandboxPolicy::DangerFullAccess, &[], &hunks)
            .await
            .expect_err("should fail");
        assert!(err.message.contains("无法在"));
    }

    #[test]
    fn custom_parser_rejects_unified_diff_headers() {
        let patch = r#"*** Begin Patch
*** Update File: a.txt
@@ -1,2 +1,2 @@
-hello
+HELLO
*** End Patch"#;
        let err = parse_patch_custom(patch).expect_err("should reject");
        assert_eq!(err.kind, ToolErrorKind::InvalidArguments);
        assert!(err.message.contains(APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME));
    }

    #[test]
    fn unified_diff_parser_rejects_custom_headers() {
        let patch = r#"*** Begin Patch
*** Update File: a.txt
@@ def example():
-pass
+return 1
*** End Patch"#;
        let err = parse_patch_unified_diff(patch).expect_err("should reject");
        assert_eq!(err.kind, ToolErrorKind::InvalidArguments);
        assert!(err.message.contains("unified diff"));
    }

    #[test]
    fn extract_verified_apply_patch_from_text_detects_patch_bodies() {
        let custom_patch = r#"*** Begin Patch
*** Add File: a.txt
+hello
*** End Patch"#;
        let (body, kind) =
            extract_verified_apply_patch_from_text(custom_patch).expect("detect custom");
        assert!(body.contains("*** Add File: a.txt"));
        assert_eq!(kind, VerifiedApplyPatchKind::Custom);

        let prefixed = format!("{APPLY_PATCH_TOOL_NAME}\n{custom_patch}");
        let (_, kind) =
            extract_verified_apply_patch_from_text(&prefixed).expect("detect custom prefixed");
        assert_eq!(kind, VerifiedApplyPatchKind::Custom);

        let unified_patch = r#"*** Begin Patch
*** Update File: a.txt
@@ -1,1 +1,1 @@
-a
+b
*** End Patch"#;
        let (_, kind) =
            extract_verified_apply_patch_from_text(unified_patch).expect("detect unified");
        assert_eq!(kind, VerifiedApplyPatchKind::UnifiedDiff);

        let prefixed = format!("{APPLY_PATCH_UNIFIED_DIFF_TOOL_NAME}\n{unified_patch}");
        let (_, kind) =
            extract_verified_apply_patch_from_text(&prefixed).expect("detect unified prefixed");
        assert_eq!(kind, VerifiedApplyPatchKind::UnifiedDiff);

        assert!(extract_verified_apply_patch_from_text("not a patch").is_none());
        assert!(extract_verified_apply_patch_from_text("").is_none());
    }
}
