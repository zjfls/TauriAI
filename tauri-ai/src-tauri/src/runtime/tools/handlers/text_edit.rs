use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::fs;

use crate::ai_client::ToolCall;
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

pub const WRITE_FILE_TOOL_NAME: &str = "write_file";
pub const REPLACE_STRING_TOOL_NAME: &str = "replace_string";

pub struct WriteFileTool;
pub struct ReplaceStringTool;

#[derive(Deserialize)]
struct WriteFileArgs {
    file_path: String,
    content: String,
    #[serde(default = "default_true")]
    create_dirs: bool,
}

#[derive(Deserialize)]
struct ReplaceStringArgs {
    file_path: String,
    old_string: String,
    new_string: String,
}

fn byte_index_for_char_boundary(s: &str, char_index: usize) -> usize {
    if char_index == 0 {
        return 0;
    }
    s.char_indices()
        .nth(char_index)
        .map(|(i, _)| i)
        .unwrap_or_else(|| s.len())
}

fn first_n_chars(s: &str, n: usize) -> &str {
    if n == 0 {
        return "";
    }
    let end = byte_index_for_char_boundary(s, n);
    &s[..end]
}

fn last_n_chars(s: &str, n: usize) -> &str {
    if n == 0 {
        return "";
    }
    let total = s.chars().count();
    if total <= n {
        return s;
    }
    let start = byte_index_for_char_boundary(s, total - n);
    &s[start..]
}

fn format_replace_string_audit(
    file_path: &str,
    abs_path: &Path,
    original: &str,
    old_string: &str,
    new_string: &str,
) -> (String, serde_json::Value) {
    let Some(match_start) = original.find(old_string) else {
        let content = [
            "replace_string: 已替换 1 处（唯一匹配）",
            &format!("file_path: {file_path}"),
            &format!("abs_path: {}", abs_path.display()),
            "位置: <unknown>",
            "",
            "审计预览生成失败：无法在原始内容中再次定位 old_string（可能是内部一致性错误）",
        ]
        .join("\n");

        let meta = serde_json::json!({
            "replaceString": {
                "path": abs_path.to_string_lossy().to_string(),
                "matches": 1,
                "location": { "line": 0, "column": 0 },
                "truncated": true,
                "auditError": "old_string_not_found_in_original"
            }
        });

        return (content, meta);
    };
    let prefix = &original[..match_start];
    let line = prefix.bytes().filter(|b| *b == b'\n').count() + 1;
    let col = prefix
        .rsplit('\n')
        .next()
        .map(|s| s.chars().count() + 1)
        .unwrap_or(1);

    let mut lines_out: Vec<String> = Vec::new();
    lines_out.push("replace_string: 已替换 1 处（唯一匹配）".to_string());
    lines_out.push(format!("file_path: {file_path}"));
    lines_out.push(format!("abs_path: {}", abs_path.display()));
    lines_out.push(format!("位置: 第 {line} 行, 第 {col} 列"));
    lines_out.push(String::new());

    lines_out.push(format!("--- a/{file_path}"));
    lines_out.push(format!("+++ b/{file_path}"));
    lines_out.push(format!("@@ line {line}, col {col} @@"));

    let is_single_line = !old_string.contains('\n') && !new_string.contains('\n');
    let mut truncated = false;

    let (old_preview, new_preview) = if is_single_line {
        let match_end = match_start + old_string.len();
        let line_start = prefix.rfind('\n').map(|i| i + 1).unwrap_or(0);
        let line_end = original[match_end..]
            .find('\n')
            .map(|off| match_end + off)
            .unwrap_or_else(|| original.len());
        let old_line = &original[line_start..line_end];

        let rel = match_start.saturating_sub(line_start);
        let line_prefix = &old_line[..rel];
        let line_suffix = &old_line[rel + old_string.len()..];

        const WINDOW_CHARS: usize = 120;
        let prefix_tail = last_n_chars(line_prefix, WINDOW_CHARS);
        let suffix_head = first_n_chars(line_suffix, WINDOW_CHARS);

        let prefix_truncated = prefix_tail.len() != line_prefix.len();
        let suffix_truncated = suffix_head.len() != line_suffix.len();
        truncated = prefix_truncated || suffix_truncated;

        let old_preview = format!(
            "{}{}{}{}{}",
            if prefix_truncated { "…" } else { "" },
            prefix_tail,
            old_string,
            suffix_head,
            if suffix_truncated { "…" } else { "" }
        );
        let new_preview = format!(
            "{}{}{}{}{}",
            if prefix_truncated { "…" } else { "" },
            prefix_tail,
            new_string,
            suffix_head,
            if suffix_truncated { "…" } else { "" }
        );
        (old_preview, new_preview)
    } else {
        const MAX_LINES: usize = 60;
        const MAX_CHARS: usize = 12_000;

        let mut old_lines: Vec<&str> = old_string.split('\n').collect();
        let mut new_lines: Vec<&str> = new_string.split('\n').collect();
        let old_total_lines = old_lines.len();
        let new_total_lines = new_lines.len();
        let old_total_chars = old_string.chars().count();
        let new_total_chars = new_string.chars().count();

        if old_lines.len() > MAX_LINES {
            old_lines.truncate(MAX_LINES);
            truncated = true;
        }
        if new_lines.len() > MAX_LINES {
            new_lines.truncate(MAX_LINES);
            truncated = true;
        }

        let mut old_preview = old_lines.join("\n");
        let mut new_preview = new_lines.join("\n");

        if old_preview.chars().count() > MAX_CHARS {
            let head = first_n_chars(&old_preview, MAX_CHARS);
            old_preview = format!("{head}\n…(old_string 已截断)");
            truncated = true;
        }
        if new_preview.chars().count() > MAX_CHARS {
            let head = first_n_chars(&new_preview, MAX_CHARS);
            new_preview = format!("{head}\n…(new_string 已截断)");
            truncated = true;
        }

        if truncated {
            if old_total_lines > MAX_LINES || old_total_chars > MAX_CHARS {
                old_preview = format!(
                    "{old_preview}\n…(old_string 总计 {old_total_lines} 行 / {old_total_chars} 字符)"
                );
            }
            if new_total_lines > MAX_LINES || new_total_chars > MAX_CHARS {
                new_preview = format!(
                    "{new_preview}\n…(new_string 总计 {new_total_lines} 行 / {new_total_chars} 字符)"
                );
            }
        }

        (old_preview, new_preview)
    };

    if truncated {
        lines_out.push(" (预览已截断：仅显示替换附近文本 / 限制行数)".to_string());
    }

    if is_single_line {
        lines_out.push(format!("-{old_preview}"));
        lines_out.push(format!("+{new_preview}"));
    } else {
        for l in old_preview.split('\n') {
            lines_out.push(format!("-{l}"));
        }
        for l in new_preview.split('\n') {
            lines_out.push(format!("+{l}"));
        }
    }

    let content = lines_out.join("\n");
    let meta = serde_json::json!({
        "replaceString": {
            "path": abs_path.to_string_lossy().to_string(),
            "matches": 1,
            "location": { "line": line as u64, "column": col as u64 },
            "truncated": truncated,
        }
    });
    (content, meta)
}

fn default_true() -> bool {
    true
}

fn base_dir_from_ctx(ctx: &ToolExecutionContext<'_>) -> PathBuf {
    ctx.default_workdir.clone().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    })
}

fn resolve_edit_path(base_dir: &Path, raw: &str) -> Result<PathBuf, ToolError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid("file_path 不能为空"));
    }
    let path = PathBuf::from(trimmed);

    // Allow absolute paths (still constrained by sandbox), but forbid '..' to avoid traversal.
    if path.is_absolute() {
        for comp in path.components() {
            if matches!(comp, Component::ParentDir) {
                return Err(ToolError::invalid(
                    "file_path 不允许包含 '..'（禁止路径穿越）",
                ));
            }
        }
        return Ok(path);
    }

    // Validate relative paths.
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                return Err(ToolError::invalid("相对路径不允许包含盘符/根路径"));
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(ToolError::invalid(
                    "相对路径不允许包含 '..'（禁止路径穿越）",
                ));
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

fn compute_allowed_roots(
    base_dir: &Path,
    policy: &SandboxPolicy,
    workspace_roots: &[PathBuf],
) -> Result<Option<Vec<PathBuf>>, ToolError> {
    if policy.has_full_disk_write_access() {
        return Ok(None);
    }

    match policy {
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
                    "当前沙盒策略要求绑定工作区目录，但当前未绑定",
                ));
            }
            Ok(Some(roots))
        }
        SandboxPolicy::ReadOnly => Ok(Some(Vec::new())),
        SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => Ok(None),
    }
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
            if roots.is_empty() {
                return Err(ToolError::denied(
                    "当前沙盒策略要求绑定工作区目录，但当前未绑定",
                ));
            }
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

#[async_trait]
impl ToolHandler for WriteFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: WRITE_FILE_TOOL_NAME.to_string(),
            description: Some(
                "写入/覆写一个文本文件（提供完整内容）。适合生成新文件或一次性重写小文件。"
                    .to_string(),
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "文件路径（相对工作区；建议不要用绝对路径）" },
                    "content": { "type": "string", "description": "要写入的完整文件内容" },
                    "create_dirs": { "type": "boolean", "description": "是否自动创建父目录（默认 true）" }
                },
                "required": ["file_path", "content"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::FileWrite],
        }
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: WriteFileArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 write_file 参数失败: {e}")))?;

        let base_dir = base_dir_from_ctx(ctx);
        let abs_path = resolve_edit_path(&base_dir, &args.file_path)?;

        let allowed_roots = compute_allowed_roots(&base_dir, &ctx.sandbox_policy, &ctx.workspace_roots)?;
        ensure_writable(&ctx.sandbox_policy, allowed_roots.as_ref(), &abs_path)?;

        if args.create_dirs {
            if let Some(parent) = abs_path.parent() {
                fs::create_dir_all(parent)
                    .await
                    .map_err(|e| ToolError::new(format!("创建目录失败: {e}")))?;
            }
        }

        fs::write(&abs_path, args.content.as_bytes())
            .await
            .map_err(|e| ToolError::new(format!("写入文件失败: {e}")))?;

        let summary = format!(
            "Wrote file: {} ({} bytes)",
            abs_path.display(),
            args.content.as_bytes().len()
        );
        emit_tool_result(ctx, call.id.as_str(), &summary);

        Ok(ToolCallResult {
            content: summary,
            meta: Some(serde_json::json!({
                "writeFile": {
                    "path": abs_path.to_string_lossy().to_string(),
                    "bytes": args.content.as_bytes().len() as u64
                }
            })),
        })
    }
}

#[async_trait]
impl ToolHandler for ReplaceStringTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: REPLACE_STRING_TOOL_NAME.to_string(),
            description: Some(
                "对指定文件执行一次“精确字符串替换”。适用于小范围改动：当你能提供一段在文件中**唯一出现 1 次**的原文（old_string，包含空格/换行也算）并将其替换为新文（new_string）时，优先使用本工具（比 apply_patch 更简单、也更容易调试）。若 old_string 不唯一或需要按行上下文定位，请改用 apply_patch。"
                    .to_string(),
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "文件路径（相对工作区；建议不要用绝对路径）" },
                    "old_string": { "type": "string", "description": "要被替换的原始字符串（必须在文件中唯一出现 1 次；建议直接从文件中复制，保持所有空格与换行不变）" },
                    "new_string": { "type": "string", "description": "替换后的字符串（将原样写入；保持空格与换行符合预期）" }
                },
                "required": ["file_path", "old_string", "new_string"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::FileWrite],
        }
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: ReplaceStringArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 replace_string 参数失败: {e}")))?;

        if args.old_string.is_empty() {
            return Err(ToolError::invalid("old_string 不能为空"));
        }

        let base_dir = base_dir_from_ctx(ctx);
        let abs_path = resolve_edit_path(&base_dir, &args.file_path)?;

        let allowed_roots = compute_allowed_roots(&base_dir, &ctx.sandbox_policy, &ctx.workspace_roots)?;
        ensure_writable(&ctx.sandbox_policy, allowed_roots.as_ref(), &abs_path)?;

        let original = fs::read_to_string(&abs_path)
            .await
            .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;

        let matches = original.match_indices(&args.old_string).count();
        if matches == 0 {
            return Err(ToolError::new(format!(
                "replace_string 未命中：old_string 在文件中不存在（file_path={}）",
                abs_path.display()
            )));
        }
        if matches > 1 {
            return Err(ToolError::new(format!(
                "replace_string 匹配不唯一：old_string 在文件中出现了 {matches} 次（file_path={}）。请改用更精确的 old_string，或使用 apply_patch 增加上下文定位。",
                abs_path.display()
            )));
        }

        let updated = original.replacen(&args.old_string, &args.new_string, 1);
        fs::write(&abs_path, updated.as_bytes())
            .await
            .map_err(|e| ToolError::new(format!("写入文件失败: {e}")))?;

        let (audit, meta) = format_replace_string_audit(
            args.file_path.trim(),
            &abs_path,
            &original,
            &args.old_string,
            &args.new_string,
        );
        emit_tool_result(ctx, call.id.as_str(), &audit);

        Ok(ToolCallResult {
            content: audit,
            meta: Some(meta),
        })
    }
}
