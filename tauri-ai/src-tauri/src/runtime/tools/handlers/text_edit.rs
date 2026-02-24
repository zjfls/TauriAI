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
                "在指定文件中做一次“精确字符串替换”（old_string 必须唯一命中 1 次）。"
                    .to_string(),
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "文件路径（相对工作区；建议不要用绝对路径）" },
                    "old_string": { "type": "string", "description": "要被替换的原始字符串（必须在文件中唯一出现 1 次）" },
                    "new_string": { "type": "string", "description": "替换后的字符串" }
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

        let summary = format!("Replaced 1 occurrence in: {}", abs_path.display());
        emit_tool_result(ctx, call.id.as_str(), &summary);

        Ok(ToolCallResult {
            content: summary,
            meta: Some(serde_json::json!({
                "replaceString": {
                    "path": abs_path.to_string_lossy().to_string(),
                    "matches": matches
                }
            })),
        })
    }
}

