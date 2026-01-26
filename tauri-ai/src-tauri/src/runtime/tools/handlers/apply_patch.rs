use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::fs;

use crate::ai_client::ToolCall;
use crate::runtime::events::RunEvent;
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{ToolCallResult, ToolError, ToolExecutionContext, ToolHandler};
use crate::runtime::tools::spec::ToolSpec;

pub struct ApplyPatchTool;

#[derive(Debug, Deserialize)]
struct ApplyPatchArgs {
    input: String,
}

#[derive(Debug)]
enum Hunk {
    AddFile { path: PathBuf, contents: String },
    DeleteFile { path: PathBuf },
    UpdateFile {
        path: PathBuf,
        move_path: Option<PathBuf>,
        chunks: Vec<UpdateChunk>,
    },
}

#[derive(Debug, Clone)]
struct UpdateChunk {
    change_context: Option<String>,
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
            name: "apply_patch".to_string(),
            description: Some(
                "使用补丁格式编辑工作区文件（Add/Delete/Update/Move）。文件路径必须为相对路径，且必须落在当前默认工作目录内。".to_string(),
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "补丁正文（自定义 apply_patch 格式，以 `*** Begin Patch` 开头、`*** End Patch` 结尾）。"
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
        let args: ApplyPatchArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 apply_patch 参数失败: {e}")))?;
        let patch_text = args.input.trim();
        if patch_text.is_empty() {
            return Err(ToolError::invalid("input 不能为空"));
        }

        let base_dir = ctx
            .default_workdir
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| ToolError::internal("无法确定默认工作目录"))?;

        let hunks = parse_patch(patch_text)?;
        let affected = apply_hunks(&base_dir, &hunks).await?;

        let summary = format_summary(&base_dir, &affected);
        emit_tool_result(ctx, call.id.as_str(), &summary);

        Ok(ToolCallResult { content: summary })
    }
}

#[derive(Debug, Default)]
struct AffectedPaths {
    added: Vec<PathBuf>,
    modified: Vec<PathBuf>,
    deleted: Vec<PathBuf>,
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

async fn apply_hunks(base_dir: &Path, hunks: &[Hunk]) -> Result<AffectedPaths, ToolError> {
    if hunks.is_empty() {
        return Err(ToolError::invalid("补丁为空：没有任何文件操作"));
    }

    let mut affected = AffectedPaths::default();

    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let abs = resolve_under_base(base_dir, path)?;
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
                let abs = resolve_under_base(base_dir, path)?;
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
                let src_abs = resolve_under_base(base_dir, path)?;
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
                    let dest_abs = resolve_under_base(base_dir, dest_rel)?;
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

fn resolve_under_base(base_dir: &Path, rel: &Path) -> Result<PathBuf, ToolError> {
    if rel.as_os_str().is_empty() {
        return Err(ToolError::invalid("文件路径不能为空"));
    }
    if rel.is_absolute() {
        return Err(ToolError::invalid("补丁文件路径必须为相对路径（不允许绝对路径）"));
    }

    let mut out = PathBuf::from(base_dir);
    let mut depth: usize = 0;

    for comp in rel.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                return Err(ToolError::invalid(
                    "补丁文件路径必须为相对路径（不允许盘符/根路径）",
                ))
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return Err(ToolError::invalid(
                        "补丁文件路径越界：不允许使用 .. 跳出默认工作目录",
                    ));
                }
                out.pop();
                depth -= 1;
            }
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.contains(':') {
                    return Err(ToolError::invalid(
                        "补丁文件路径不允许包含 ':'（疑似 Windows 盘符）",
                    ));
                }
                out.push(part.as_ref());
                depth += 1;
            }
        }
    }

    Ok(out)
}

fn parse_patch(input: &str) -> Result<Vec<Hunk>, ToolError> {
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
            let path = parse_rel_path(rest)?;
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
            let path = parse_rel_path(rest)?;
            idx += 1;
            hunks.push(Hunk::DeleteFile { path });
            continue;
        }

        if let Some(rest) = line.strip_prefix("*** Update File:") {
            let path = parse_rel_path(rest)?;
            idx += 1;

            let mut move_path: Option<PathBuf> = None;
            if idx < end_idx {
                if let Some(rest) = lines[idx].strip_prefix("*** Move to:") {
                    move_path = Some(parse_rel_path(rest)?);
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
                    let header = header.strip_prefix(' ').unwrap_or(header).trim();
                    current = Some(UpdateChunk {
                        change_context: if header.is_empty() {
                            None
                        } else {
                            Some(header.to_string())
                        },
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
                        "Update File 变更行必须以 ' ' / '+' / '-' / '@@' 开头：{change_line}"
                    )));
                }
                if current.is_none() {
                    current = Some(UpdateChunk {
                        change_context: None,
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

fn is_hunk_start(line: &str) -> bool {
    line.starts_with("*** Add File:")
        || line.starts_with("*** Delete File:")
        || line.starts_with("*** Update File:")
        || line.trim_end() == "*** End Patch"
}

fn parse_rel_path(rest: &str) -> Result<PathBuf, ToolError> {
    let raw = rest.trim();
    if raw.is_empty() {
        return Err(ToolError::invalid("文件路径不能为空"));
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Err(ToolError::invalid("补丁文件路径必须为相对路径"));
    }
    Ok(path)
}

fn finish_chunk(current: &mut Option<UpdateChunk>, out: &mut Vec<UpdateChunk>) {
    let Some(chunk) = current.take() else {
        return;
    };
    if chunk.old_lines.is_empty() && chunk.new_lines.is_empty() && chunk.change_context.is_none() {
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
            if let Some(idx) = seek_sequence(original_lines, &ctx_pattern, line_index, false) {
                line_index = idx + 1;
            } else {
                return Err(ToolError::new(format!(
                    "无法找到上下文 '{}'（{}）",
                    ctx_line,
                    path.display()
                )));
            }
        }

        if chunk.old_lines.is_empty() {
            replacements.push((original_lines.len(), 0, chunk.new_lines.clone()));
            continue;
        }

        let mut pattern: &[String] = &chunk.old_lines;
        let mut new_slice: &[String] = &chunk.new_lines;
        let mut found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
            found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        }

        if let Some(start_idx) = found {
            replacements.push((start_idx, pattern.len(), new_slice.to_vec()));
            line_index = start_idx + pattern.len();
        } else {
            return Err(ToolError::new(format!(
                "无法在 {} 中定位待替换的内容:\n{}",
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

fn seek_sequence(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }

    let search_start = if eof && lines.len() >= pattern.len() {
        lines.len() - pattern.len()
    } else {
        start
    };

    for idx in search_start..=lines.len().saturating_sub(pattern.len()) {
        if lines[idx..idx + pattern.len()] == *pattern {
            return Some(idx);
        }
    }

    for idx in search_start..=lines.len().saturating_sub(pattern.len()) {
        let mut ok = true;
        for (pat_idx, pat) in pattern.iter().enumerate() {
            if lines[idx + pat_idx].trim_end() != pat.trim_end() {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(idx);
        }
    }

    for idx in search_start..=lines.len().saturating_sub(pattern.len()) {
        let mut ok = true;
        for (pat_idx, pat) in pattern.iter().enumerate() {
            if lines[idx + pat_idx].trim() != pat.trim() {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(idx);
        }
    }

    fn normalise(s: &str) -> String {
        s.trim()
            .chars()
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

    for idx in search_start..=lines.len().saturating_sub(pattern.len()) {
        let mut ok = true;
        for (pat_idx, pat) in pattern.iter().enumerate() {
            if normalise(&lines[idx + pat_idx]) != normalise(pat) {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(idx);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let hunks = parse_patch(patch).expect("parse");
        let affected = apply_hunks(base, &hunks).await.expect("apply");
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
        let hunks = parse_patch(patch).expect("parse");
        let _ = apply_hunks(base, &hunks).await.expect("apply");
        let updated = fs::read_to_string(&file_path).await.expect("read");
        assert!(updated.contains("\r\n"));
        assert_eq!(updated, "a\r\nB\r\n");
    }
}

