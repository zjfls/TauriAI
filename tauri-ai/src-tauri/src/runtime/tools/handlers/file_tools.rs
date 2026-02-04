use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::ai_client::ToolCall;
use crate::runtime::events::RunEvent;
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::spec::ToolSpec;

const MAX_LINE_LENGTH: usize = 500;
const TAB_WIDTH: usize = 4;
const COMMENT_PREFIXES: &[&str] = &["#", "//", "--"];
const MAX_RG_LIMIT: usize = 2000;
const DEFAULT_RG_LIMIT: usize = 100;
const DEFAULT_READ_LIMIT: usize = 2000;
const DEFAULT_LIST_LIMIT: usize = 25;
const DEFAULT_LIST_DEPTH: usize = 2;
const DIR_INDENT_SPACES: usize = 2;
const RG_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ReadFileTool;
pub struct ListDirTool;
pub struct RgTool;

#[derive(Deserialize)]
struct ReadFileArgs {
    file_path: String,
    #[serde(default = "default_offset")]
    offset: usize,
    #[serde(default = "default_read_limit")]
    limit: usize,
    #[serde(default)]
    mode: ReadMode,
    #[serde(default)]
    indentation: Option<IndentationArgs>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReadMode {
    Slice,
    Indentation,
}

#[derive(Deserialize, Clone)]
struct IndentationArgs {
    #[serde(default)]
    anchor_line: Option<usize>,
    #[serde(default = "default_max_levels")]
    max_levels: usize,
    #[serde(default = "default_include_siblings")]
    include_siblings: bool,
    #[serde(default = "default_include_header")]
    include_header: bool,
    #[serde(default)]
    max_lines: Option<usize>,
}

#[derive(Clone, Debug)]
struct LineRecord {
    number: usize,
    raw: String,
    display: String,
    indent: usize,
}

impl LineRecord {
    fn trimmed(&self) -> &str {
        self.raw.trim_start()
    }

    fn is_blank(&self) -> bool {
        self.trimmed().is_empty()
    }

    fn is_comment(&self) -> bool {
        COMMENT_PREFIXES
            .iter()
            .any(|prefix| self.raw.trim().starts_with(prefix))
    }
}

#[derive(Deserialize)]
struct ListDirArgs {
    dir_path: String,
    #[serde(default = "default_offset")]
    offset: usize,
    #[serde(default = "default_list_limit")]
    limit: usize,
    #[serde(default = "default_list_depth")]
    depth: usize,
}

#[derive(Deserialize)]
struct RgArgs {
    pattern: String,
    #[serde(default)]
    include: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default = "default_rg_limit")]
    limit: usize,
}

fn default_offset() -> usize {
    1
}

fn default_read_limit() -> usize {
    DEFAULT_READ_LIMIT
}

fn default_list_limit() -> usize {
    DEFAULT_LIST_LIMIT
}

fn default_list_depth() -> usize {
    DEFAULT_LIST_DEPTH
}

fn default_rg_limit() -> usize {
    DEFAULT_RG_LIMIT
}

fn default_max_levels() -> usize {
    0
}

fn default_include_siblings() -> bool {
    false
}

fn default_include_header() -> bool {
    true
}

impl Default for IndentationArgs {
    fn default() -> Self {
        Self {
            anchor_line: None,
            max_levels: default_max_levels(),
            include_siblings: default_include_siblings(),
            include_header: default_include_header(),
            max_lines: None,
        }
    }
}

impl Default for ReadMode {
    fn default() -> Self {
        Self::Slice
    }
}

#[async_trait]
impl ToolHandler for ReadFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read_file".to_string(),
            description: Some("读取本地文件并返回带行号的文本片段".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "文件路径（绝对或相对）" },
                    "offset": { "type": "integer", "description": "起始行号（1 开始，默认 1）" },
                    "limit": { "type": "integer", "description": "最大返回行数（默认 2000）" },
                    "mode": { "type": "string", "description": "读取模式：slice（默认）或 indentation" },
                    "indentation": {
                        "type": "object",
                        "description": "indentation 模式的可选配置",
                        "properties": {
                            "anchor_line": { "type": "integer", "description": "锚点行号（默认 offset）" },
                            "max_levels": { "type": "integer", "description": "向上扩展的缩进层级（0 表示不限制）" },
                            "include_siblings": { "type": "boolean", "description": "是否包含同层级兄弟块" },
                            "include_header": { "type": "boolean", "description": "是否包含锚点上方注释/标注" },
                            "max_lines": { "type": "integer", "description": "indentation 模式的硬性最大行数" }
                        },
                        "additionalProperties": false
                    }
                },
                "required": ["file_path"],
                "additionalProperties": false
            }),
            required_permissions: vec![],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: ReadFileArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 read_file 参数失败: {e}")))?;

        if args.offset == 0 {
            return Err(ToolError::invalid("offset 必须从 1 开始"));
        }
        if args.limit == 0 {
            return Err(ToolError::invalid("limit 必须大于 0"));
        }

        let path = resolve_path(ctx, &args.file_path)?;
        let metadata = fs::metadata(&path)
            .await
            .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;
        if !metadata.is_file() {
            return Err(ToolError::invalid("file_path 不是文件"));
        }

        let lines = match args.mode {
            ReadMode::Slice => read_lines_with_numbers(&path, args.offset, args.limit).await?,
            ReadMode::Indentation => {
                let options = args.indentation.unwrap_or_default();
                read_block_with_numbers(&path, args.offset, args.limit, options).await?
            }
        };
        let output = lines.join("\n");
        emit_tool_result(ctx, call.id.as_str(), &output);

        Ok(ToolCallResult { content: output })
    }
}

#[async_trait]
impl ToolHandler for ListDirTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_dir".to_string(),
            description: Some("列出目录结构（带缩进）".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "dir_path": { "type": "string", "description": "目录路径（绝对或相对）" },
                    "offset": { "type": "integer", "description": "起始条目序号（1 开始，默认 1）" },
                    "limit": { "type": "integer", "description": "最大返回条目数（默认 25）" },
                    "depth": { "type": "integer", "description": "最大遍历深度（默认 2）" }
                },
                "required": ["dir_path"],
                "additionalProperties": false
            }),
            required_permissions: vec![],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: ListDirArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 list_dir 参数失败: {e}")))?;

        if args.offset == 0 {
            return Err(ToolError::invalid("offset 必须从 1 开始"));
        }
        if args.limit == 0 {
            return Err(ToolError::invalid("limit 必须大于 0"));
        }
        if args.depth == 0 {
            return Err(ToolError::invalid("depth 必须大于 0"));
        }

        let path = resolve_path(ctx, &args.dir_path)?;
        let metadata = fs::metadata(&path)
            .await
            .map_err(|e| ToolError::new(format!("读取目录失败: {e}")))?;
        if !metadata.is_dir() {
            return Err(ToolError::invalid("dir_path 不是目录"));
        }

        let mut output_lines = Vec::new();
        output_lines.push(format!("Absolute path: {}", path.display()));
        let entries = list_dir_slice(&path, args.offset, args.limit, args.depth).await?;
        output_lines.extend(entries);

        let output = output_lines.join("\n");
        emit_tool_result(ctx, call.id.as_str(), &output);

        Ok(ToolCallResult { content: output })
    }
}

#[async_trait]
impl ToolHandler for RgTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "rg".to_string(),
            description: Some("使用 ripgrep 查找包含 pattern 的文件路径".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "正则匹配模式" },
                    "include": { "type": "string", "description": "可选：glob 过滤，如 \"*.rs\"" },
                    "path": { "type": "string", "description": "可选：搜索路径（默认当前工作目录）" },
                    "limit": { "type": "integer", "description": "最大返回文件数（默认 100）" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            required_permissions: vec![],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: RgArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 rg 参数失败: {e}")))?;

        let pattern = args.pattern.trim();
        if pattern.is_empty() {
            return Err(ToolError::invalid("pattern 不能为空"));
        }
        if args.limit == 0 {
            return Err(ToolError::invalid("limit 必须大于 0"));
        }

        let search_root = if let Some(path) = args.path.as_ref().filter(|s| !s.trim().is_empty()) {
            resolve_path(ctx, path)?
        } else if let Some(default_workdir) = ctx.default_workdir.as_ref() {
            default_workdir.clone()
        } else {
            std::env::current_dir().map_err(|e| ToolError::new(format!("无法获取当前目录: {e}")))?
        };

        fs::metadata(&search_root)
            .await
            .map_err(|e| ToolError::new(format!("无法访问搜索路径: {e}")))?;

        let output_lines =
            run_rg_search(pattern, args.include.as_deref(), &search_root, args.limit).await?;

        let output = if output_lines.is_empty() {
            "No matches found.".to_string()
        } else {
            output_lines.join("\n")
        };

        emit_tool_result(ctx, call.id.as_str(), &output);
        Ok(ToolCallResult { content: output })
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

fn resolve_path(ctx: &ToolExecutionContext<'_>, input: &str) -> Result<PathBuf, ToolError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid("路径不能为空"));
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Ok(path);
    }
    if let Some(default_workdir) = ctx.default_workdir.as_ref() {
        return Ok(default_workdir.join(path));
    }
    let cwd =
        std::env::current_dir().map_err(|e| ToolError::new(format!("无法获取当前目录: {e}")))?;
    Ok(cwd.join(path))
}

async fn read_lines_with_numbers(
    path: &Path,
    offset: usize,
    limit: usize,
) -> Result<Vec<String>, ToolError> {
    let file = fs::File::open(path)
        .await
        .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;

    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut seen = 0usize;
    let mut collected = Vec::new();

    loop {
        buffer.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut buffer)
            .await
            .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;

        if bytes_read == 0 {
            break;
        }

        if buffer.last() == Some(&b'\n') {
            buffer.pop();
            if buffer.last() == Some(&b'\r') {
                buffer.pop();
            }
        }

        seen += 1;
        if seen < offset {
            continue;
        }
        if collected.len() >= limit {
            break;
        }

        let line = format_line(&buffer);
        collected.push(format!("L{seen}: {line}"));
        if collected.len() >= limit {
            break;
        }
    }

    if seen < offset {
        return Err(ToolError::invalid("offset 超过文件总行数"));
    }

    Ok(collected)
}

async fn read_block_with_numbers(
    path: &Path,
    offset: usize,
    limit: usize,
    options: IndentationArgs,
) -> Result<Vec<String>, ToolError> {
    let anchor_line = options.anchor_line.unwrap_or(offset);
    if anchor_line == 0 {
        return Err(ToolError::invalid("anchor_line 必须从 1 开始"));
    }

    let guard_limit = options.max_lines.unwrap_or(limit);
    if guard_limit == 0 {
        return Err(ToolError::invalid("max_lines 必须大于 0"));
    }

    let collected = collect_file_lines(path).await?;
    if collected.is_empty() || anchor_line > collected.len() {
        return Err(ToolError::invalid("anchor_line 超过文件总行数"));
    }

    let anchor_index = anchor_line - 1;
    let effective_indents = compute_effective_indents(&collected);
    let anchor_indent = effective_indents[anchor_index];
    let min_indent = if options.max_levels == 0 {
        0
    } else {
        anchor_indent.saturating_sub(options.max_levels * TAB_WIDTH)
    };

    let final_limit = limit.min(guard_limit).min(collected.len());
    if final_limit == 1 {
        return Ok(vec![format!(
            "L{}: {}",
            collected[anchor_index].number, collected[anchor_index].display
        )]);
    }

    let mut i: isize = anchor_index as isize - 1;
    let mut j: usize = anchor_index + 1;
    let mut i_counter_min_indent = 0;
    let mut j_counter_min_indent = 0;

    let mut out: VecDeque<&LineRecord> = VecDeque::with_capacity(final_limit);
    out.push_back(&collected[anchor_index]);

    while out.len() < final_limit {
        let mut progressed = 0;

        if i >= 0 {
            let iu = i as usize;
            if effective_indents[iu] >= min_indent {
                out.push_front(&collected[iu]);
                progressed += 1;
                i -= 1;

                if effective_indents[iu] == min_indent && !options.include_siblings {
                    let allow_header_comment = options.include_header && collected[iu].is_comment();
                    let can_take_line = allow_header_comment || i_counter_min_indent == 0;

                    if can_take_line {
                        i_counter_min_indent += 1;
                    } else {
                        out.pop_front();
                        progressed -= 1;
                        i = -1;
                    }
                }

                if out.len() >= final_limit {
                    break;
                }
            } else {
                i = -1;
            }
        }

        if j < collected.len() {
            let ju = j;
            if effective_indents[ju] >= min_indent {
                out.push_back(&collected[ju]);
                progressed += 1;
                j += 1;

                if effective_indents[ju] == min_indent && !options.include_siblings {
                    if j_counter_min_indent > 0 {
                        out.pop_back();
                        progressed -= 1;
                        j = collected.len();
                    }
                    j_counter_min_indent += 1;
                }
            } else {
                j = collected.len();
            }
        }

        if progressed == 0 {
            break;
        }
    }

    trim_empty_lines(&mut out);

    Ok(out
        .into_iter()
        .map(|record| format!("L{}: {}", record.number, record.display))
        .collect())
}

fn format_line(bytes: &[u8]) -> String {
    let decoded = String::from_utf8_lossy(bytes);
    if decoded.chars().count() > MAX_LINE_LENGTH {
        decoded.chars().take(MAX_LINE_LENGTH).collect()
    } else {
        decoded.into_owned()
    }
}

async fn collect_file_lines(path: &Path) -> Result<Vec<LineRecord>, ToolError> {
    let file = fs::File::open(path)
        .await
        .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;

    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut lines = Vec::new();
    let mut number = 0usize;

    loop {
        buffer.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut buffer)
            .await
            .map_err(|e| ToolError::new(format!("读取文件失败: {e}")))?;

        if bytes_read == 0 {
            break;
        }

        if buffer.last() == Some(&b'\n') {
            buffer.pop();
            if buffer.last() == Some(&b'\r') {
                buffer.pop();
            }
        }

        number += 1;
        let raw = String::from_utf8_lossy(&buffer).into_owned();
        let indent = measure_indent(&raw);
        let display = format_line(&buffer);
        lines.push(LineRecord {
            number,
            raw,
            display,
            indent,
        });
    }

    Ok(lines)
}

fn compute_effective_indents(records: &[LineRecord]) -> Vec<usize> {
    let mut effective = Vec::with_capacity(records.len());
    let mut previous_indent = 0usize;
    for record in records {
        if record.is_blank() {
            effective.push(previous_indent);
        } else {
            previous_indent = record.indent;
            effective.push(previous_indent);
        }
    }
    effective
}

fn measure_indent(line: &str) -> usize {
    line.chars()
        .take_while(|c| matches!(c, ' ' | '\t'))
        .map(|c| if c == '\t' { TAB_WIDTH } else { 1 })
        .sum()
}

fn trim_empty_lines(out: &mut VecDeque<&LineRecord>) {
    while matches!(out.front(), Some(line) if line.raw.trim().is_empty()) {
        out.pop_front();
    }
    while matches!(out.back(), Some(line) if line.raw.trim().is_empty()) {
        out.pop_back();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug)]
struct DirEntry {
    name: String,
    display_name: String,
    depth: usize,
    kind: DirEntryKind,
}

async fn list_dir_slice(
    path: &Path,
    offset: usize,
    limit: usize,
    depth: usize,
) -> Result<Vec<String>, ToolError> {
    let mut entries = Vec::new();
    collect_entries(path, Path::new(""), depth, &mut entries).await?;

    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let start_index = offset - 1;
    if start_index >= entries.len() {
        return Err(ToolError::invalid("offset 超过目录条目数量"));
    }

    let remaining = entries.len() - start_index;
    let capped_limit = limit.min(remaining);
    let end_index = start_index + capped_limit;
    let mut selected = entries[start_index..end_index].to_vec();
    selected.sort_unstable_by(|a, b| a.name.cmp(&b.name));

    let mut formatted = Vec::with_capacity(selected.len() + 1);
    for entry in &selected {
        formatted.push(format_entry_line(entry));
    }
    if end_index < entries.len() {
        formatted.push(format!("More than {capped_limit} entries found"));
    }

    Ok(formatted)
}

async fn collect_entries(
    dir_path: &Path,
    relative_prefix: &Path,
    depth: usize,
    entries: &mut Vec<DirEntry>,
) -> Result<(), ToolError> {
    let mut queue = VecDeque::new();
    queue.push_back((dir_path.to_path_buf(), relative_prefix.to_path_buf(), depth));

    while let Some((current_dir, prefix, remaining_depth)) = queue.pop_front() {
        let mut read_dir = fs::read_dir(&current_dir)
            .await
            .map_err(|e| ToolError::new(format!("读取目录失败: {e}")))?;
        let mut dir_entries = Vec::new();

        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| ToolError::new(format!("读取目录失败: {e}")))?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| ToolError::new(format!("获取文件类型失败: {e}")))?;
            let file_name = entry.file_name();
            let relative_path = if prefix.as_os_str().is_empty() {
                PathBuf::from(&file_name)
            } else {
                prefix.join(&file_name)
            };

            let display_name = format_entry_component(&file_name);
            let display_depth = prefix.components().count();
            let sort_key = format_entry_name(&relative_path);
            let kind = if file_type.is_dir() {
                DirEntryKind::Directory
            } else if file_type.is_symlink() {
                DirEntryKind::Symlink
            } else if file_type.is_file() {
                DirEntryKind::File
            } else {
                DirEntryKind::Other
            };

            dir_entries.push((
                entry.path(),
                relative_path,
                kind,
                DirEntry {
                    name: sort_key,
                    display_name,
                    depth: display_depth,
                    kind,
                },
            ));
        }

        dir_entries.sort_unstable_by(|a, b| a.3.name.cmp(&b.3.name));

        for (entry_path, relative_path, kind, dir_entry) in dir_entries {
            if kind == DirEntryKind::Directory && remaining_depth > 1 {
                queue.push_back((entry_path, relative_path, remaining_depth - 1));
            }
            entries.push(dir_entry);
        }
    }

    Ok(())
}

fn format_entry_name(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace("\\", "/");
    truncate_string(&normalized)
}

fn format_entry_component(name: &std::ffi::OsStr) -> String {
    let normalized = name.to_string_lossy();
    truncate_string(&normalized)
}

fn format_entry_line(entry: &DirEntry) -> String {
    let indent = " ".repeat(entry.depth * DIR_INDENT_SPACES);
    let mut name = entry.display_name.clone();
    match entry.kind {
        DirEntryKind::Directory => name.push('/'),
        DirEntryKind::Symlink => name.push('@'),
        DirEntryKind::Other => name.push('?'),
        DirEntryKind::File => {}
    }
    format!("{indent}{name}")
}

fn truncate_string(value: &str) -> String {
    if value.chars().count() > MAX_LINE_LENGTH {
        value.chars().take(MAX_LINE_LENGTH).collect()
    } else {
        value.to_string()
    }
}

async fn run_rg_search(
    pattern: &str,
    include: Option<&str>,
    search_path: &Path,
    limit: usize,
) -> Result<Vec<String>, ToolError> {
    let limit = limit.min(MAX_RG_LIMIT);
    let mut command = Command::new("rg");
    command
        .arg("--files-with-matches")
        .arg("--sortr=modified")
        .arg("--regexp")
        .arg(pattern)
        .arg("--no-messages");

    if let Some(glob) = include {
        let trimmed = glob.trim();
        if !trimmed.is_empty() {
            command.arg("--glob").arg(trimmed);
        }
    }

    command.arg("--").arg(search_path);

    let output = timeout(RG_TIMEOUT, command.output())
        .await
        .map_err(|_| ToolError::timeout("rg 超时"))?
        .map_err(|e| ToolError::new(format!("启动 rg 失败: {e}")))?;

    match output.status.code() {
        Some(0) => Ok(parse_rg_output(&output.stdout, limit)),
        Some(1) => Ok(Vec::new()),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(ToolError::new(format!("rg 执行失败: {stderr}")))
        }
    }
}

fn parse_rg_output(stdout: &[u8], limit: usize) -> Vec<String> {
    let mut results = Vec::new();
    for line in stdout.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(line) {
            if text.is_empty() {
                continue;
            }
            results.push(text.to_string());
            if results.len() >= limit {
                break;
            }
        }
    }
    results
}
