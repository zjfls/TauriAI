//! Data models for TauriAI
//!
//! This module contains all the core data structures used throughout the application.

use crate::prompts::FormatPromptType;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Role of a message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    /// Tool message (OpenAI-compatible function calling)
    Tool,
}

// ============================================================================
// Multimodal Content Types
// ============================================================================

/// Image detail level for vision models
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageDetail {
    #[default]
    Auto,
    Low,
    High,
}

/// PDF single page data
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
    pub page_number: u32,
    pub text: String,
    pub image: String, // Base64 data URL
}

/// PDF metadata
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
}

/// Code snippet range (1-based editor coordinates)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSnippetRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// A single part of message content (text, image, text file, or PDF document)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    /// Text content
    Text { text: String },
    /// Image content (base64 data URL or HTTP URL)
    Image {
        url: String,
        #[serde(default)]
        detail: ImageDetail,
    },
    /// Text file content
    TextFile { filename: String, content: String },
    /// File reference (path only; contents are NOT inlined)
    FileRef {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Code snippet (selection-based, referenced by token `@{snippet:<id>}` in text)
    CodeSnippet {
        id: String,
        label: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "languageId")]
        language_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "filePath")]
        file_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<CodeSnippetRange>,
    },
    /// PDF document (multimodal: text + images)
    PdfDocument {
        filename: String,
        pages: Vec<PdfPage>,
        #[serde(rename = "totalPages")]
        total_pages: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<PdfMetadata>,
    },
}

impl ContentPart {
    /// Create a text content part
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// Create an image content part from URL or base64 data
    pub fn image(url: impl Into<String>) -> Self {
        Self::Image {
            url: url.into(),
            detail: ImageDetail::Auto,
        }
    }

    /// Create an image content part with specific detail level
    pub fn image_with_detail(url: impl Into<String>, detail: ImageDetail) -> Self {
        Self::Image {
            url: url.into(),
            detail,
        }
    }

    /// Create a text file content part
    pub fn text_file(filename: impl Into<String>, content: impl Into<String>) -> Self {
        Self::TextFile {
            filename: filename.into(),
            content: content.into(),
        }
    }

    /// Create a file reference content part (do NOT inline file contents)
    pub fn file_ref(path: impl Into<String>, label: Option<String>) -> Self {
        Self::FileRef {
            path: path.into(),
            label,
        }
    }

    pub fn code_snippet(
        id: impl Into<String>,
        label: impl Into<String>,
        text: impl Into<String>,
        language_id: Option<String>,
        file_path: Option<String>,
        range: Option<CodeSnippetRange>,
    ) -> Self {
        Self::CodeSnippet {
            id: id.into(),
            label: label.into(),
            text: text.into(),
            language_id,
            file_path,
            range,
        }
    }

    /// Create a PDF document content part
    pub fn pdf_document(
        filename: impl Into<String>,
        pages: Vec<PdfPage>,
        metadata: Option<PdfMetadata>,
    ) -> Self {
        let total_pages = pages.len() as u32;
        Self::PdfDocument {
            filename: filename.into(),
            pages,
            total_pages,
            metadata,
        }
    }
}

/// Metadata associated with a message
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MessageMeta {
    /// The model used to generate the response
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Number of tokens in the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u32>,
    /// Duration in milliseconds to generate the response
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    /// Tool call id for role=tool (OpenAI: tool_call_id)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool calls for role=assistant (OpenAI: tool_calls)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<crate::ai_client::ToolCall>>,

    /// Persisted structured output blocks for assistant messages.
    ///
    /// - Mainly used to restore multi-turn tool runs after reload.
    /// - Stored in `messages.meta` for DB compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,

    /// Persisted per-turn metadata (without sensitive debug headers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<MessageTurn>>,

    /// Token usage for the message (usually from the final model call of the task).
    ///
    /// NOTE:
    /// - We persist it inside `meta` for DB compatibility (no schema migration needed).
    /// - Frontend will lift it to `message.usage` when hydrating history.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::ai_client::TokenUsage>,

    /// Context compaction metadata (e.g. normal compact summary snapshots).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_compaction: Option<ContextCompactionMeta>,
}

/// Metadata for a persisted context compaction summary.
///
/// NOTE:
/// - We keep original messages in DB for audit/UI.
/// - The runtime prompt builder may prefer the latest summary and skip messages
///   covered by `compacted_until_*` when constructing context for the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompactionMeta {
    /// Strategy name (e.g. "normal_compact").
    pub strategy: String,
    /// The last message id covered by this summary (inclusive).
    pub compacted_until_message_id: String,
    /// The timestamp of the last message covered by this summary (inclusive).
    pub compacted_until_created_at: DateTime<Utc>,
    /// Keep window used when this summary was produced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_last_messages: Option<u32>,
    /// How many older messages were dropped from the compaction transcript to fit the budget.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_for_fit: Option<u32>,
    /// Best-effort cap applied when building the compaction transcript.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_compact_input_messages: Option<u32>,
}

// ============================================================================
// Structured Message Output (blocks/turns)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessageBlock {
    #[serde(rename_all = "camelCase")]
    Text {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        format: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Thinking {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        call_id: String,
        name: String,
        arguments: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        call_id: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Approval {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        request_id: String,
        tool_name: String,
        arguments: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    WebSearch {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        call_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Unknown {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        data: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTurn {
    pub turn_id: String,
    pub turn_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<crate::runtime::types::TurnStatus>,
    /// Whether this turn has persisted debug info available.
    ///
    /// - Used for lazy-loading debug info in the frontend (do not inline by default).
    /// - This field is optional to keep stored history compact; it's derived from `debug_info`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_debug_info: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_info: Option<crate::ai_client::DebugInfoData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::ai_client::TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_trim: Option<crate::runtime::types::TurnContextTrimInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Status of a message
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Pending,
    Success,
    Failed,
}

impl Default for MessageStatus {
    fn default() -> Self {
        Self::Success
    }
}

/// A single message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    /// Message content - can be plain text (String) or multimodal (Vec<ContentPart>)
    /// For backward compatibility, we store as String in DB but support both formats in API
    pub content: String,
    /// Multimodal content parts (images, etc.) - stored separately for DB compatibility
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_parts: Vec<ContentPart>,
    /// Thinking/reasoning content (optional, stored for history display)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<MessageMeta>,
    pub created_at: DateTime<Utc>,
    /// Status of the message (pending, success, failed)
    #[serde(default)]
    pub status: MessageStatus,
    /// Optional error message if the status is Failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl Message {
    /// Check if this message contains images
    pub fn has_images(&self) -> bool {
        self.content_parts
            .iter()
            .any(|p| matches!(p, ContentPart::Image { .. }))
    }

    /// Check if this message contains multimodal content (images, text files, or PDF documents)
    pub fn has_multimodal_content(&self) -> bool {
        self.content_parts.iter().any(|p| {
            matches!(
                p,
                ContentPart::Image { .. }
                    | ContentPart::TextFile { .. }
                    | ContentPart::PdfDocument { .. }
            )
        })
    }

    /// Get all content parts, converting plain text content if needed
    pub fn get_content_parts(&self) -> Vec<ContentPart> {
        if self.content_parts.is_empty() {
            // Legacy: only text content
            vec![ContentPart::text(&self.content)]
        } else {
            self.content_parts.clone()
        }
    }
}

/// A conversation containing multiple messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// Agent name used for this conversation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Model reference (format: "provider_name/model_name")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    /// Cached merged system prompt for this conversation.
    ///
    /// 说明：
    /// - 这是“缓存”（cache），用于避免每次请求都重新组装多段 system prompt。
    /// - 当相关配置/开关变化时会自动失效并重建，而不是“冻结”。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Cache key for `system_prompt` (used to decide whether the cache is still valid).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_cache_key: Option<String>,
    /// Conversation-scoped runtime settings (persisted).
    ///
    /// 说明：
    /// - 这是“对话级别”的状态，不属于全局配置，也不属于临时 session。
    /// - 目前仅用于保存 thinkingMode，避免切换/重开对话后重置为默认值。
    /// - 使用 JSON value 存储以便后续扩展更多设置（draft、rag、memory 开关等）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<serde_json::Value>,
    /// Conversation-scoped run mode (persisted).
    ///
    /// Semantics:
    /// - "chat": normal chat mode
    /// - "agent"/"agent-custom"/"agent-full-access": tool/agentic modes
    ///
    /// Note: stored as String for forward-compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<String>,
    /// Optional workstudio binding (many conversations can map to one workstudio).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workstudio_id: Option<String>,
    /// Prompt-view hard trim cutoff (persisted).
    ///
    /// 说明：
    /// - hard trim 会在超出 hard limit 时删掉最老的整轮（按 user 边界分组）。
    /// - 为了避免“下一次请求又把刚裁掉的旧轮次重新塞回 prompt，导致统计/行为跳变”，
    ///   这里记录本对话的“prompt 视图起点”（最早保留的 user message id）。
    /// - UI 仍然保留完整历史；该字段只影响发送给模型的 runtime prompt 视图。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cutoff_message_id: Option<String>,
    /// Conversation message count (denormalized for list display).
    ///
    /// 说明：
    /// - 仅用于前端列表/概览展示；不参与持久化写入。
    /// - 目前在 `get_conversations` 里按需计算并填充。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    /// Conversation total turn count (sum of `meta.turns` across messages).
    ///
    /// 说明：
    /// - 用于让用户直观看到“一个 message 包含多个 turn”时的规模。
    /// - 仅用于展示；不参与持久化写入。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<u32>,
    /// Latest message timestamp for this conversation (denormalized for list display).
    ///
    /// 说明：
    /// - 仅用于前端列表/概览展示；不参与持久化写入。
    /// - 用于判断文件索引（active_files）是否覆盖到最新消息。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<DateTime<Utc>>,
    /// Primary bind path inferred from tool/file activity (relative to workstudio mainFolder when possible).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path: Option<String>,
    /// Kind of primary path: file | folder | workspace
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path_kind: Option<String>,
    /// Preference used when computing primary_path: file | folder
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path_pref: Option<String>,
    /// Top active files/dirs inferred from recent tool usage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_files: Option<Vec<ConversationActivePath>>,
    /// The latest message timestamp covered by the stored active_files index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_files_updated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A scored active path (file or directory) inferred from tool usage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationActivePath {
    pub path: String,
    pub score: u32,
    /// file | dir
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<DateTime<Utc>>,
}

/// A workstudio (workspace) definition, bound to a main folder and optional additional folders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workstudio {
    pub id: String,
    /// Workstudio 类型（例如 code / doc / mindmap 等）。
    ///
    /// 说明：
    /// - 用于区分同一主文件夹下，不同“工作室类型”的持久化状态（打开的文件、布局等）。
    /// - 默认 "code"，以保持向后兼容。
    #[serde(default = "default_workstudio_kind")]
    pub kind: String,
    pub main_folder: String,
    pub folders: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_workstudio_kind() -> String {
    "code".to_string()
}

/// Workstudio UI 持久化状态（用于恢复上次打开的文件/分屏等）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioUiState {
    pub open_files: Vec<String>,
    /// WindowPane 体系（统一分屏布局）。
    #[serde(default)]
    pub panes: Vec<WorkstudioUiPaneState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    /// 动态分屏：多个编辑组（每组有自己的标签页与激活文件）。
    #[serde(default)]
    pub groups: Vec<WorkstudioUiGroupState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_group_index: Option<usize>,
    /// Explorer 展开状态（目录 path 列表）。
    #[serde(default)]
    pub expanded_dirs: Vec<String>,

    // 兼容旧版本（固定左右 split）的字段：保留读取能力
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_left_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_right_file: Option<String>,
    #[serde(default)]
    pub split_open: bool,

    /// Monaco 编辑器字体大小（px），用于 Workstudio 字体缩放。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_font_size: Option<u32>,

    /// Workstudio 级别的代码智能偏好（可选）。
    /// - 未设置：默认使用全局 Code Intelligence 配置（所有已配置语言可用）
    /// - 设置后：仅对该 Workstudio 启用指定语言
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_intelligence: Option<WorkstudioCodeIntelligenceState>,

    /// Outline 折叠/浏览状态（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<WorkstudioOutlineState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioCodeIntelligenceState {
    /// 允许启用的 Monaco language id 列表（例如 rust/python/cpp）。
    #[serde(default)]
    pub enabled_language_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioOutlineState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<bool>,
    /// 是否优先使用 LSP 生成 Outline（可选；未设置时由前端使用默认值）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer_lsp: Option<bool>,
    /// Outline 符号排序方式（可选；例如 position/kind/name）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_mode: Option<String>,
    #[serde(default)]
    pub files: HashMap<String, WorkstudioOutlineFileState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioOutlineFileState {
    #[serde(default)]
    pub collapsed_keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_key: Option<String>,
    #[serde(default)]
    pub recent_keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_top: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioUiPaneState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub tab_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioUiGroupState {
    pub open_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_file: Option<String>,
    #[serde(default = "default_group_weight")]
    pub weight: f32,
}

fn default_group_weight() -> f32 {
    1.0
}

// ============================================================================
// Workstudio Symbol Analysis (AI, persisted)
// ============================================================================

/// Diagnosis counters for symbol analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioSymbolDiagnosisCounts {
    pub errors: u32,
    pub defects: u32,
    pub improvements: u32,
}

/// Persisted AI analysis result for a symbol in Workstudio outline.
///
/// 说明：
/// - 用于右键 Outline 元素 -> “分析类/函数/变量”等能力的结果缓存。
/// - 存储为 Markdown（前端用富文本渲染组件展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioSymbolAnalysis {
    pub id: String,
    pub workstudio_id: String,
    pub file_path: String,
    pub language_id: String,
    /// Symbol origin for the analysis: e.g. "lsp" or "ast_cst" (optional for backward compat).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_source: Option<String>,
    /// A stable key from Outline item (frontend-generated).
    pub symbol_key: String,
    pub symbol_name: String,
    pub symbol_kind: String,
    pub selection_line: u32,
    pub selection_column: u32,
    pub range: CodeSnippetRange,
    /// Markdown content (rich text).
    pub answer_md: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Health score (1..=10). 10 is best, 1 is critical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_level: Option<u8>,
    /// Verdict: HEALTHY | IMPROVABLE | RISKY | CRITICAL | POSSIBLY_UNUSED
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// Confidence for the diagnosis (0.0..=1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// Short 1-line diagnosis summary for Outline tooltip / menu.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_summary: Option<String>,
    /// Counters for Errors/Defects/Improvements.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_counts: Option<WorkstudioSymbolDiagnosisCounts>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Lightweight diagnosis summary for Workstudio Outline prefetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioSymbolAnalysisSummary {
    pub symbol_key: String,
    /// Symbol origin for the analysis: e.g. "lsp" or "ast_cst" (optional for backward compat).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_level: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_counts: Option<WorkstudioSymbolDiagnosisCounts>,
    pub updated_at: DateTime<Utc>,
}

// ============================================================================
// Workstudio Folder Analysis (AI, persisted)
// ============================================================================

/// Persisted AI analysis result for a folder in Workstudio explorer.
///
/// 说明：
/// - 用于右键 Explorer 文件夹 -> “分析文件夹”等能力的结果缓存。
/// - 存储为 Markdown（前端用富文本渲染组件展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioFolderAnalysis {
    pub id: String,
    pub workstudio_id: String,
    pub folder_path: String,
    /// Markdown content (rich text).
    pub answer_md: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Health score (1..=10). 10 is best, 1 is critical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_level: Option<u8>,
    /// Verdict: HEALTHY | IMPROVABLE | RISKY | CRITICAL | POSSIBLY_UNUSED
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// Confidence for the diagnosis (0.0..=1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// Short 1-line diagnosis summary for Explorer tooltip / menu.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_summary: Option<String>,
    /// Counters for Errors/Defects/Improvements.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_counts: Option<WorkstudioSymbolDiagnosisCounts>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Lightweight diagnosis summary for Workstudio explorer prefetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioFolderAnalysisSummary {
    pub folder_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_level: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis_counts: Option<WorkstudioSymbolDiagnosisCounts>,
    pub updated_at: DateTime<Utc>,
}

// ============================================================================
// Workstudio Chat With (Inline Chat, persisted)
// ============================================================================

/// Persisted Chat-with (inline chat) record for a file selection in Workstudio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioChatWithRecord {
    pub id: String,
    pub workstudio_id: String,
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    pub file_path: String,
    pub language_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<CodeSnippetRange>,
    pub question: String,
    pub code: String,
    pub answer_md: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Lightweight summary for "Chat with" records grouped by file (used by Explorer markers).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioChatWithFileSummary {
    pub file_path: String,
    pub record_count: u32,
    pub updated_at: DateTime<Utc>,
}

// ============================================================================
// New Provider-Model-Agent Architecture
// ====================================================== ======================

/// Provider type for API compatibility
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderType {
    Openai,
    OpenaiCompatible,
    /// OpenAI Responses API for reasoning models (o1, o3, gpt-4.1)
    OpenaiResponses,
    Anthropic,
    /// Google Gemini API
    Google,
    Ollama,
}

impl Default for ProviderType {
    fn default() -> Self {
        Self::OpenaiCompatible
    }
}

impl Serialize for ProviderType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_client_str())
    }
}

impl<'de> Deserialize<'de> for ProviderType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "openai" => Self::Openai,
            "openai_responses" => Self::OpenaiResponses,
            "anthropic" => Self::Anthropic,
            "google" | "gemini" => Self::Google,
            "ollama" => Self::Ollama,
            // "openai_compatible" and any other value defaults to OpenaiCompatible
            _ => Self::OpenaiCompatible,
        })
    }
}

impl ProviderType {
    /// Convert to client provider string
    pub fn to_client_str(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::OpenaiCompatible => "openai_compatible",
            Self::OpenaiResponses => "openai_responses",
            Self::Anthropic => "anthropic",
            Self::Google => "google",
            Self::Ollama => "ollama",
        }
    }
}

/// Model capabilities (what features the model supports)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    /// Whether the model supports thinking/reasoning (e.g., DeepSeek-R1, GLM-4.7)
    #[serde(default)]
    pub thinking: bool,
    /// Whether the model supports vision/image input
    #[serde(default)]
    pub vision: bool,
    /// Whether the model supports function calling
    #[serde(default)]
    pub function_calling: bool,
    /// Whether the model supports server-side web search (provider-native)
    #[serde(default)]
    pub web_search: bool,
}

/// 文本编辑工具实现类型（由“模型”决定具体用哪一种编辑工具）。
///
/// - `apply_patch`：Codex 风格 patch（自定义 `@@ <锚定行>`）
/// - `apply_patch_unified_diff`：unified diff 头（`@@ -a,b +c,d @@`）
/// - `write_file_replace_string`：用 `write_file`（整文件写入）+ `replace_string`（唯一替换）实现编辑
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextEditImplementation {
    ApplyPatch,
    ApplyPatchUnifiedDiff,
    WriteFileReplaceString,
}

impl Default for TextEditImplementation {
    fn default() -> Self {
        Self::ApplyPatch
    }
}

/// Shell 工具实现类型（由“模型”决定具体用哪一种 shell 能力）。
///
/// - `shell_command`：一次性 shell 命令（默认）
/// - `pty`：临时 PTY（exec_command + write_stdin）
/// - `pty_persistent`：持久 PTY（exec_command_persistent + write_stdin_persistent）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShellImplementation {
    ShellCommand,
    Pty,
    PtyPersistent,
}

impl Default for ShellImplementation {
    fn default() -> Self {
        Self::ShellCommand
    }
}

/// Agent 子任务工具实现类型（`agenttask`）。
///
/// - `in_process`：在当前进程内直接调用 AI client（轻量、低开销）
/// - `subprocess`：通过 `tauri-ai-headless` 子进程执行（隔离性更好）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskImplementation {
    InProcess,
    Subprocess,
}

impl Default for AgentTaskImplementation {
    fn default() -> Self {
        Self::InProcess
    }
}

/// Model configuration (pure model parameters, no system prompt)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// Model name, e.g., "deepseek-v3", unique within provider
    pub name: String,
    pub temperature: f32,
    // 默认启用；仅在禁用时写入配置（需要持久化 false）
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub temperature_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    // 默认启用；仅在禁用时写入配置（需要持久化 false）
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub top_p_enabled: bool,
    /// Maximum context length in tokens (e.g., 128000 for GPT-4o)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
    /// Model capabilities (auto-inferred if not set)
    #[serde(default)]
    pub capabilities: ModelCapabilities,
    /// Turn-level automatic retry attempts.
    /// - When unset: default to 8 (runtime default).
    /// - When `general.manualTurnRetry=true`: automatic retries are disabled regardless of this value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempts: Option<u32>,
    /// Whether to allow reconnecting and resuming when a stream breaks after partial output.
    /// Default false to avoid duplicated output on providers that don't support resume.
    #[serde(default)]
    pub resume_partial_output: bool,
    /// For OpenAI Chat Completions streaming:
    /// controls whether to send `stream_options.include_usage`.
    /// Default true.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub stream_include_usage: bool,
    /// Maximum number of images allowed (default: 10, only for vision models)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_images: Option<u32>,
    /// Anthropic extended thinking budget (Claude)
    /// - Must be >= 1024 and < max_tokens when enabled
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget_tokens: Option<u32>,
    /// Use reasoning_effort parameter for Chat Completions API (OpenAI GPT-5 series)
    /// - When true: use reasoning_effort parameter (none/minimal/low/medium/high)
    /// - When false/None: use thinking parameter (enabled/disabled)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_reasoning_effort: Option<bool>,
    /// Kimi thinking: whether to include historical `reasoning_content` in next requests.
    /// Default false: do not send historical thinking content (but may still include empty placeholder for strict providers).
    #[serde(default)]
    pub reinject_reasoning_content: bool,
    /// Text edit tool implementation preference for this model (default: apply_patch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_edit_implementation: Option<TextEditImplementation>,
    /// Agent 子任务工具（agenttask）实现偏好（默认：in_process）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_task_implementation: Option<AgentTaskImplementation>,
    /// Shell 工具实现偏好（默认：shell_command）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_implementation: Option<ShellImplementation>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            name: String::new(),
            temperature: 0.7,
            temperature_enabled: true,
            max_tokens: None,
            top_p: None,
            top_p_enabled: true,
            context_length: None,
            capabilities: ModelCapabilities::default(),
            retry_attempts: None,
            resume_partial_output: false,
            stream_include_usage: true,
            max_images: None,
            thinking_budget_tokens: None,
            use_reasoning_effort: None,
            reinject_reasoning_content: false,
            text_edit_implementation: None,
            agent_task_implementation: None,
            shell_implementation: None,
        }
    }
}

/// Provider configuration (contains API info and models)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// Unique identifier, e.g., "siliconflow"
    pub name: String,
    /// Display name, e.g., "硅基流动"
    pub display_name: String,
    /// Provider type for API compatibility
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    /// API base URL
    pub api_base: String,
    /// API key (optional for local providers like Ollama)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Whether this provider is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// For OpenAI-compatible Chat Completions:
    /// force response-style reasoning object (e.g. `reasoning: { effort, summary }`)
    /// instead of top-level `reasoning_effort`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub force_responses_reasoning: bool,
    /// For Seasun (Xishanju) OpenAI-compatible gateways:
    /// thinking switch uses `think: { type: "true" }` instead of `thinking: { type: ... }`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub seasun_thinking: bool,
    /// Models available from this provider
    #[serde(default)]
    pub models: Vec<Model>,
}

fn default_true() -> bool {
    true
}

fn is_true(v: &bool) -> bool {
    *v
}

fn is_false(v: &bool) -> bool {
    !*v
}

impl Default for Provider {
    fn default() -> Self {
        Self {
            name: String::new(),
            display_name: String::new(),
            provider_type: ProviderType::default(),
            api_base: String::new(),
            api_key: None,
            enabled: true,
            force_responses_reasoning: false,
            seasun_thinking: false,
            models: Vec::new(),
        }
    }
}

/// Agent runtime type (controls behavior and capabilities)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentType {
    /// 最简单的 Chat Agent（LLM 单轮/多轮对话）
    Chat,
    /// 工具型 Agent（function/tool calling loop）
    Tool,
    /// 子任务 Agent（仅供 `agenttask` 工具调用）
    TaskAgent,
}

impl Default for AgentType {
    fn default() -> Self {
        Self::Chat
    }
}

impl Serialize for AgentType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            Self::Chat => "chat",
            Self::Tool => "tool",
            Self::TaskAgent => "task_agent",
        })
    }
}

impl<'de> Deserialize<'de> for AgentType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "tool" => Self::Tool,
            "task_agent" | "taskagent" => Self::TaskAgent,
            // Backward-compat: map deprecated kinds.
            "code" | "coding" => Self::Tool,
            "solution" => Self::Chat,
            _ => Self::Chat,
        })
    }
}

/// Agent configuration (references a model, contains system prompt)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// Unique identifier
    pub name: String,
    /// Whether this agent is enabled (visible/selectable).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Agent type (default: chat)
    #[serde(default, rename = "type")]
    pub agent_type: AgentType,
    /// Display name
    pub display_name: String,
    /// Description of the agent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// TaskAgent 用法说明（仅 `type=task_agent` 使用）。
    ///
    /// 用于告诉上层智能体：这个 TaskAgent 擅长什么任务、输入输出约定、调用边界。
    /// 会在注册 `agenttask` 工具时作为“可用 TaskAgent 清单”的一部分注入系统提示词。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_usage: Option<String>,
    /// Model reference in format "provider_name/model_name"
    pub model_ref: String,
    /// System prompt for this agent
    #[serde(default)]
    pub system_prompt: String,
    /// Output format type
    #[serde(default)]
    pub format_type: FormatPromptType,
    /// Default run mode for new/opened sessions.
    ///
    /// Semantics:
    /// - None: auto (Tool/TaskAgent => "agent"; Chat => "chat")
    /// - Some(...): explicit override (e.g. "agent", "agent-custom", "agent-full-access")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_run_mode: Option<String>,
    /// Optional toolset name (bind different tool collections per agent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toolset: Option<String>,
    /// Optional MCP Set name (bind a group of MCP servers/tools per agent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_set: Option<String>,
    /// Optional Skill Set name (bind a group of skills per agent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_set: Option<String>,
    /// Optional security policy name (defaults to global default policy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security_policy: Option<String>,
    /// Optional sandbox policy override (defaults to global security policy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<SandboxPolicy>,
    /// Optional approval policy override (defaults to global security policy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<AskForApproval>,
    /// Whether to enable workspace/workstudio support for Tool agents.
    ///
    /// Semantics:
    /// - None: use default (Tool/TaskAgent => true; others => false)
    /// - Some(true/false): explicit override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_support: Option<bool>,
    /// Max turns for a single run/task (tool agents may need multi-turn)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,

    /// 是否把 thinking（思考过程）回灌进“同一 Task 的下一轮上下文”。
    ///
    /// - 默认关闭：thinking 只用于 UI 展示/调试，不参与后续 turn 的提示词上下文。
    /// - 打开后：在多 Turn（tool agent）场景里，会把 thinking 作为显式文本插入到
    ///   assistant 的上下文内容中（用于下一轮续写/继续工具循环）。
    #[serde(default)]
    pub reinject_thinking: bool,

    /// Context 管理策略（可选，按 agent 级配置）。
    ///
    /// - None：默认使用 Simple（仅做硬裁剪 Trim，不自动 compact），避免超出上下文窗口
    /// - Some(...)：启用对应策略（例如 Simple/NormalCompact）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_policy: Option<ContextPolicyConfig>,

    /// 是否在 Workstudio / Workspace AI 相关界面中展示该智能体（纯前端用途）。
    ///
    /// 说明：
    /// - 这个字段不影响后端运行时的 agent 解析/执行逻辑；
    /// - 仅用于前端把“聊天智能体”与“Workspace AI 智能体”分组展示与管理。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workstudio_enabled: Option<bool>,
}

impl Default for Agent {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            agent_type: AgentType::default(),
            display_name: String::new(),
            description: None,
            task_usage: None,
            model_ref: String::new(),
            system_prompt: String::new(),
            format_type: FormatPromptType::default(),
            default_run_mode: None,
            toolset: None,
            mcp_set: None,
            skill_set: None,
            security_policy: None,
            sandbox_policy: None,
            approval_policy: None,
            workspace_support: None,
            max_turns: None,
            reinject_thinking: false,
            context_policy: None,
            workstudio_enabled: None,
        }
    }
}

// ============================================================================
// Context Management (agent-level)
// ============================================================================

/// Context 管理策略配置（可扩展）。
///
/// 设计目标：
/// - 允许未来接入不同于 Codex 的策略与参数
/// - 允许以 `custom` 形式携带任意 JSON 参数（UI 可用 JSON 编辑器）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContextPolicyConfig {
    /// Simple context management: hard trimming only (no compaction).
    ///
    /// Backward compatibility:
    /// - older configs used `type: "disabled"` to represent this "simple" behavior.
    #[serde(rename = "simple", alias = "disabled")]
    Simple(SimplePolicyConfig),
    /// Codex-like compaction + hard trimming.
    #[serde(rename_all = "camelCase")]
    NormalCompact(NormalCompactPolicyConfig),
    /// Custom strategy name + JSON params for forward compatibility.
    #[serde(rename_all = "camelCase")]
    Custom {
        name: String,
        params: serde_json::Value,
    },
}

impl Default for ContextPolicyConfig {
    fn default() -> Self {
        Self::Simple(SimplePolicyConfig::default())
    }
}

/// A minimal "simple" policy: trimming only, no compaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimplePolicyConfig {
    /// Master switch for this policy.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Enable hard trimming for the *runtime prompt* to avoid context window exceeded.
    ///
    /// - This does NOT mutate persisted history.
    /// - Disabling this may cause model requests to fail when the context gets too long.
    #[serde(default = "default_true")]
    pub trim_enabled: bool,

    /// Hard cap in percent of model context length used for the final prompt (after trimming).
    /// Default: 90 (%).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hard_limit_percent: Option<u8>,

    /// Target watermark in percent of model context length after trimming.
    /// Must be smaller than `hard_limit_percent`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trim_target_percent: Option<u8>,
}

impl Default for SimplePolicyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            trim_enabled: true,
            hard_limit_percent: Some(90),
            trim_target_percent: None,
        }
    }
}

/// A Codex-like "normal compact" policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalCompactPolicyConfig {
    /// Master switch for this policy.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Enable history compaction (rewrite older history into a summary message).
    ///
    /// When disabled, the policy can still perform hard trimming (if enabled) to avoid context overflow.
    #[serde(default = "default_true")]
    pub compact_enabled: bool,

    /// Whether to auto-run compaction when the estimated prompt usage reaches `auto_compact_threshold_percent`.
    #[serde(default = "default_true")]
    pub auto_compact: bool,

    /// Enable hard trimming for the *runtime prompt* to avoid context window exceeded.
    ///
    /// - This does NOT mutate persisted history.
    /// - Disabling this may cause model requests to fail when the context gets too long.
    #[serde(default = "default_true")]
    pub trim_enabled: bool,

    /// Trigger threshold in percent of model context length.
    /// Default: 85 (%).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_compact_threshold_percent: Option<u8>,

    /// Hard cap in percent of model context length used for the final prompt (after trimming).
    /// Default: 90 (%).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hard_limit_percent: Option<u8>,

    /// Target watermark in percent of model context length after trimming.
    /// Must be smaller than `hard_limit_percent`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trim_target_percent: Option<u8>,

    /// After compaction, keep the last N messages (excluding the inserted summary).
    /// Default: 60.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_last_messages: Option<u32>,

    /// Max tokens for the compaction summary generation output.
    /// Default: 800.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_summary_tokens: Option<u32>,

    /// Best-effort cap for how many historical messages to feed into the compaction prompt.
    /// Default: 400.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_compact_input_messages: Option<u32>,
}

impl Default for NormalCompactPolicyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            compact_enabled: true,
            auto_compact: true,
            trim_enabled: true,
            auto_compact_threshold_percent: None,
            hard_limit_percent: None,
            trim_target_percent: None,
            keep_last_messages: None,
            max_summary_tokens: None,
            max_compact_input_messages: None,
        }
    }
}

// ============================================================================
// Skills (discovered from filesystem)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSetConfig {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Explicit allow-list of skill names for this set. Empty means "no skills".
    #[serde(default)]
    pub skills: Vec<String>,
    /// Optional deny-list (applied after `skills`).
    #[serde(default)]
    pub disabled_skills: Vec<String>,
}

impl Default for SkillSetConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            skills: Vec::new(),
            disabled_skills: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsSettings {
    /// Globally disabled skill names (applies to all sets).
    #[serde(default)]
    pub disabled_skills: Vec<String>,
    /// Named skill sets.
    #[serde(default)]
    pub sets: Vec<SkillSetConfig>,
}

impl Default for SkillsSettings {
    fn default() -> Self {
        Self {
            disabled_skills: Vec::new(),
            sets: Vec::new(),
        }
    }
}

// ============================================================================
// Legacy types (kept for migration)
// ============================================================================

/// Parameters for model configuration (legacy)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParameters {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

impl Default for ModelParameters {
    fn default() -> Self {
        Self {
            temperature: Some(0.7),
            max_tokens: None,
            top_p: None,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        }
    }
}

/// Configuration for an AI model (legacy)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub model: String,
    pub parameters: ModelParameters,
    /// Thinking level control for models that support it
    /// - None: Model doesn't support thinking, don't send thinking parameter
    /// - Some("disabled"): Explicitly disable thinking
    /// - Some("low" | "medium" | "high" | "very_high"): Enable with specific effort level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// Provider-specific thinking budget tokens (e.g., Anthropic extended thinking)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget_tokens: Option<u32>,
    /// Whether the model supports vision/image input
    #[serde(default)]
    pub vision_enabled: bool,
    /// Whether to enable provider-native server-side web search (if supported by the selected model/provider)
    #[serde(default)]
    pub web_search_enabled: bool,
    /// Maximum number of images allowed (default: 10, only for vision models)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_images: Option<u32>,
    /// Whether to use reasoning_effort parameter (for OpenAI GPT-5 series)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_reasoning_effort: Option<bool>,
    /// OpenAI-compatible chat/completions:
    /// force response-style reasoning object (reasoning.effort/summary).
    #[serde(default)]
    pub force_responses_reasoning: bool,
    /// OpenAI-compatible (Seasun): use `think: { type: "true" }` as thinking switch.
    #[serde(default)]
    pub seasun_thinking: bool,
    /// Turn-level automatic retry attempts (default: 8 when unset).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempts: Option<u32>,
    /// Whether to allow reconnecting and resuming when a stream breaks after partial output.
    /// Default false to avoid duplicated output on providers that don't support resume.
    #[serde(default)]
    pub resume_partial_output: bool,
    /// For OpenAI Chat Completions streaming:
    /// controls whether to send `stream_options.include_usage`.
    /// Default true.
    #[serde(default = "default_true")]
    pub stream_include_usage: bool,
    /// Debug: log raw SSE lines from providers (streaming only)
    #[serde(default)]
    pub debug_sse: bool,
    /// Kimi thinking: whether to include historical `reasoning_content` in messages.
    #[serde(default)]
    pub reinject_reasoning_content: bool,
}

/// A preset combining model config and system prompt (legacy)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub model_config_id: String,
    pub system_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters_override: Option<ModelParameters>,
}

/// Appearance settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub theme: String,
    pub always_on_top: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            always_on_top: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionNotificationSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub notify_on_success: bool,
    #[serde(default = "default_true")]
    pub notify_on_failure: bool,
    #[serde(default = "default_true")]
    pub include_preview: bool,
    #[serde(default = "default_true")]
    pub request_attention: bool,
}

impl Default for CompletionNotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            notify_on_success: true,
            notify_on_failure: true,
            include_preview: true,
            request_attention: true,
        }
    }
}

/// General application settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub language: String,
    pub auto_start: bool,
    /// Keyboard shortcuts settings (per-platform overrides)
    #[serde(default)]
    pub keyboard_shortcuts: KeyboardShortcutsSettings,
    /// When enabled, disable automatic turn retries (use manual retry buttons instead).
    #[serde(default)]
    pub manual_turn_retry: bool,
    /// Enable debug mode to show raw HTTP messages
    #[serde(default)]
    pub debug_mode: bool,
    /// Debug: log raw SSE lines from providers (streaming only)
    #[serde(default)]
    pub debug_sse: bool,
    /// Whether to show the "task end" Debug button in the message toolbar.
    /// Default true: this toggle only affects UI visibility, not debug collection.
    #[serde(default = "default_task_end_debug_button")]
    pub task_end_debug_button: bool,
    /// Show token usage in messages
    #[serde(default)]
    pub show_usage: bool,
    /// ANSI render mode for tool output (color/strip/raw)
    #[serde(default = "default_ansi_render_mode")]
    pub ansi_render_mode: String,
    /// ANSI palette selection (auto/xterm/vscode-dark/vscode-light)
    #[serde(default = "default_ansi_color_mode")]
    pub ansi_color_mode: String,
    /// Whether to open DevTools on startup (dev builds only)
    #[serde(default)]
    pub open_devtools_on_start: bool,
    /// Desktop notification preferences for task completion / failure.
    #[serde(default)]
    pub completion_notifications: CompletionNotificationSettings,
    /// Hidden: local web search tool settings (used only when model has no native web search)
    #[serde(default)]
    pub web_search_tool: WebSearchToolSettings,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            language: "zh-CN".to_string(),
            auto_start: false,
            keyboard_shortcuts: KeyboardShortcutsSettings::default(),
            manual_turn_retry: false,
            debug_mode: false,
            debug_sse: false,
            task_end_debug_button: true,
            show_usage: true,
            ansi_render_mode: "color".to_string(),
            ansi_color_mode: "auto".to_string(),
            open_devtools_on_start: false,
            completion_notifications: CompletionNotificationSettings::default(),
            web_search_tool: WebSearchToolSettings::default(),
        }
    }
}

/// Keyboard shortcuts settings (per-platform overrides; defaults are defined in frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardShortcutsSettings {
    #[serde(default = "default_keyboard_shortcuts_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub mac: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub windows: std::collections::BTreeMap<String, String>,
}

fn default_keyboard_shortcuts_enabled() -> bool {
    true
}

impl Default for KeyboardShortcutsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mac: std::collections::BTreeMap::new(),
            windows: std::collections::BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchProvider {
    Tavily,
    Google,
    Brave,
}

impl Default for WebSearchProvider {
    fn default() -> Self {
        Self::Tavily
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchToolSettings {
    /// Legacy field for backward compatibility (master switch)
    #[serde(default)]
    pub enabled: bool,
    /// Legacy field for backward compatibility (selected provider)
    #[serde(default)]
    pub provider: WebSearchProvider,
    /// Per-provider enabled flags
    #[serde(default)]
    pub tavily_enabled: bool,
    #[serde(default)]
    pub google_enabled: bool,
    #[serde(default)]
    pub brave_enabled: bool,
    /// Minimum interval between requests (rate limit), ms
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tavily_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brave_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub google_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub google_cx: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
}

impl Default for WebSearchToolSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: WebSearchProvider::default(),
            tavily_enabled: false,
            google_enabled: false,
            brave_enabled: false,
            min_interval_ms: Some(1200),
            tavily_api_key: None,
            brave_api_key: None,
            google_api_key: None,
            google_cx: None,
            max_results: Some(5),
        }
    }
}

fn default_ansi_render_mode() -> String {
    "color".to_string()
}

fn default_ansi_color_mode() -> String {
    "auto".to_string()
}

fn default_task_end_debug_button() -> bool {
    true
}

// ============================================================================
// Tooling (toolsets)
// ============================================================================

/// 可复用的工具集合（不同 Agent 可绑定不同 toolset）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSetConfig {
    pub name: String,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Experimental: persistent shell/pty enhancement (opt-in per toolset).
    #[serde(default)]
    pub persistance_shell_enhance: bool,
}

impl Default for ToolSetConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            tools: Vec::new(),
            persistance_shell_enhance: false,
        }
    }
}

/// Tools 总配置：仅包含 toolsets（不提供全局系统级权限开关）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsSettings {
    #[serde(default)]
    pub toolsets: Vec<ToolSetConfig>,
}

impl Default for ToolsSettings {
    fn default() -> Self {
        Self {
            toolsets: Vec::new(),
        }
    }
}

// ============================================================================
// Code Intelligence (LSP / AST)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerConfig {
    /// Monaco language id（例如：rust / python / cpp）
    pub language_id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 启动命令（例如：rust-analyzer / pyright-langserver / pylsp / clangd）
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 可选环境变量注入（避免污染全局 PATH；仅影响该 LSP 进程）
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// initialize 的 initializationOptions（按 LSP server 约定）
    #[serde(default)]
    pub initialization_options: serde_json::Value,
    /// 用于响应 `workspace/configuration` 的 settings（通常为 JSON object）
    #[serde(default)]
    pub settings: serde_json::Value,
}

impl Default for LspServerConfig {
    fn default() -> Self {
        Self {
            language_id: String::new(),
            enabled: true,
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            initialization_options: serde_json::Value::Object(serde_json::Map::new()),
            settings: serde_json::Value::Object(serde_json::Map::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiCompletionQueueScope {
    Global,
    Language,
}

impl Default for AiCompletionQueueScope {
    fn default() -> Self {
        Self::Global
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiCompletionTriggerMode {
    Auto,
    Manual,
    Hybrid,
}

impl Default for AiCompletionTriggerMode {
    fn default() -> Self {
        Self::Hybrid
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompletionSettings {
    /// 总开关：关闭后不请求模型
    #[serde(default)]
    pub enabled: bool,
    /// 绑定的智能体标识（Agent Name），为空则回退到系统默认智能体
    #[serde(default)]
    pub agent_ref: String,
    /// 绑定的代码对话 (Chat With) 智能体标识
    #[serde(default)]
    pub chat_with_agent_ref: String,
    /// 幽灵补全（Inline）
    #[serde(default = "default_true")]
    pub inline_enabled: bool,
    /// Ctrl+Space 建议列表
    #[serde(default = "default_true")]
    pub list_enabled: bool,
    /// 触发模式：auto/manual/hybrid
    #[serde(default)]
    pub trigger_mode: AiCompletionTriggerMode,
    /// 请求队列作用域：global/language
    #[serde(default)]
    pub queue_scope: AiCompletionQueueScope,
    /// 自动触发去抖（毫秒）
    #[serde(default = "default_ai_completion_debounce_ms")]
    pub debounce_ms: u64,
    /// 单次请求超时（毫秒）
    #[serde(default = "default_ai_completion_timeout_ms")]
    pub timeout_ms: u64,
    /// 最大生成 tokens（补全建议小一些，避免延迟过高）
    #[serde(default = "default_ai_completion_max_tokens")]
    pub max_tokens: u32,
    /// 温度（补全建议低温）
    #[serde(default = "default_ai_completion_temperature")]
    pub temperature: f64,
    /// 发送给模型的 prefix 最大字符数
    #[serde(default = "default_ai_completion_max_prefix_chars")]
    pub max_prefix_chars: usize,
    /// 发送给模型的 suffix 最大字符数
    #[serde(default = "default_ai_completion_max_suffix_chars")]
    pub max_suffix_chars: usize,
    /// 是否允许发送项目上下文（路径、工作区信息等）
    #[serde(default = "default_true")]
    pub include_project_context: bool,
    /// Ctrl+Space 列表候选条数
    #[serde(default = "default_ai_completion_list_suggestion_count")]
    pub list_suggestion_count: u32,
}

fn default_ai_completion_debounce_ms() -> u64 {
    350
}

fn default_ai_completion_timeout_ms() -> u64 {
    2_500
}

fn default_ai_completion_max_tokens() -> u32 {
    8192
}

fn default_ai_completion_temperature() -> f64 {
    0.2
}

fn default_ai_completion_max_prefix_chars() -> usize {
    8_000
}

fn default_ai_completion_max_suffix_chars() -> usize {
    2_000
}

fn default_ai_completion_list_suggestion_count() -> u32 {
    3
}

impl Default for AiCompletionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            agent_ref: String::new(),
            chat_with_agent_ref: String::new(),
            inline_enabled: true,
            list_enabled: true,
            trigger_mode: AiCompletionTriggerMode::Hybrid,
            queue_scope: AiCompletionQueueScope::Global,
            debounce_ms: default_ai_completion_debounce_ms(),
            timeout_ms: default_ai_completion_timeout_ms(),
            max_tokens: default_ai_completion_max_tokens(),
            temperature: default_ai_completion_temperature(),
            max_prefix_chars: default_ai_completion_max_prefix_chars(),
            max_suffix_chars: default_ai_completion_max_suffix_chars(),
            include_project_context: true,
            list_suggestion_count: default_ai_completion_list_suggestion_count(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolAnalysisAgentBinding {
    /// 绑定的智能体标识（Agent Name）
    #[serde(default)]
    pub agent_ref: String,
    /// 该智能体的最大并发数（同一时间允许跑多少个符号分析任务）
    #[serde(default = "default_symbol_analysis_concurrency")]
    pub concurrency: u32,
}

fn default_symbol_analysis_concurrency() -> u32 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolAnalysisSettings {
    /// 总开关：关闭后不请求模型
    #[serde(default)]
    pub enabled: bool,
    /// 绑定的智能体标识（Agent Name），为空则回退到系统默认智能体
    #[serde(default)]
    pub agent_ref: String,
    /// 符号分析的思考强度（主要用于 OpenAI Responses API 的 reasoning.effort）。
    /// - None: 未配置（等同于“无”，保持默认不思考）
    /// - Some("low" | "medium" | "high" | "xhigh"): 思考强度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// 默认绑定智能体的最大并发数
    #[serde(default = "default_symbol_analysis_concurrency")]
    pub concurrency: u32,
    /// 附加智能体（用于多模型/多并发）
    #[serde(default)]
    pub additional_agents: Vec<SymbolAnalysisAgentBinding>,
    /// “全部解析”是否跳过变量/字段（这些数量可能很多）。不影响右键单个符号分析。
    #[serde(default = "default_true")]
    pub bulk_exclude_variables: bool,
    /// 单次请求超时（毫秒）
    #[serde(default = "default_symbol_analysis_timeout_ms")]
    pub timeout_ms: u64,
    /// 最大生成 tokens
    #[serde(default = "default_symbol_analysis_max_tokens")]
    pub max_tokens: u32,
    /// 温度（分析建议低温）
    #[serde(default = "default_symbol_analysis_temperature")]
    pub temperature: f64,
    /// 是否允许发送项目上下文（路径、工作区信息等）
    #[serde(default = "default_true")]
    pub include_project_context: bool,
}

fn default_symbol_analysis_timeout_ms() -> u64 {
    20_000
}

fn default_symbol_analysis_max_tokens() -> u32 {
    8192
}

fn default_symbol_analysis_temperature() -> f64 {
    0.2
}

impl Default for SymbolAnalysisSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            agent_ref: String::new(),
            thinking_level: None,
            concurrency: default_symbol_analysis_concurrency(),
            additional_agents: Vec::new(),
            bulk_exclude_variables: true,
            timeout_ms: default_symbol_analysis_timeout_ms(),
            max_tokens: default_symbol_analysis_max_tokens(),
            temperature: default_symbol_analysis_temperature(),
            include_project_context: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAnalysisAgentBinding {
    /// 绑定的智能体标识（Agent Name）
    #[serde(default)]
    pub agent_ref: String,
    /// 该智能体的最大并发数（同一时间允许跑多少个文件夹分析任务）
    #[serde(default = "default_folder_analysis_concurrency")]
    pub concurrency: u32,
}

fn default_folder_analysis_concurrency() -> u32 {
    1
}

fn default_folder_analysis_timeout_ms() -> u64 {
    30_000
}

fn default_folder_analysis_max_tokens() -> u32 {
    8192
}

fn default_folder_analysis_temperature() -> f64 {
    0.2
}

fn default_folder_analysis_max_depth() -> u32 {
    3
}

fn default_folder_analysis_max_files() -> u32 {
    200
}

fn default_folder_analysis_max_total_bytes() -> u64 {
    5_000_000
}

fn default_folder_analysis_ignore_globs() -> Vec<String> {
    vec![
        "**/.git/**".to_string(),
        "**/node_modules/**".to_string(),
        "**/target/**".to_string(),
        "**/dist/**".to_string(),
        "**/build/**".to_string(),
        "**/.next/**".to_string(),
        "**/.turbo/**".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAnalysisSettings {
    /// 总开关：关闭后不请求模型
    #[serde(default)]
    pub enabled: bool,
    /// 绑定的智能体标识（Agent Name），为空则回退到系统默认智能体
    #[serde(default)]
    pub agent_ref: String,
    /// 文件夹分析的思考强度（主要用于 OpenAI Responses API 的 reasoning.effort）。
    /// - None: 未配置（等同于“无”，保持默认不思考）
    /// - Some("low" | "medium" | "high" | "xhigh"): 思考强度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// 默认绑定智能体的最大并发数
    #[serde(default = "default_folder_analysis_concurrency")]
    pub concurrency: u32,
    /// 附加智能体（用于多模型/多并发）
    #[serde(default)]
    pub additional_agents: Vec<FolderAnalysisAgentBinding>,
    /// 单次请求超时（毫秒）
    #[serde(default = "default_folder_analysis_timeout_ms")]
    pub timeout_ms: u64,
    /// 最大生成 tokens
    #[serde(default = "default_folder_analysis_max_tokens")]
    pub max_tokens: u32,
    /// 温度（分析建议低温）
    #[serde(default = "default_folder_analysis_temperature")]
    pub temperature: f64,
    /// 是否允许发送项目上下文（路径、工作区信息等）
    #[serde(default = "default_true")]
    pub include_project_context: bool,
    /// 文件夹扫描最大深度（用于生成树/采样，非强制，模型仍可用工具继续探索）
    #[serde(default = "default_folder_analysis_max_depth")]
    pub max_depth: u32,
    /// 文件夹扫描最大文件数（用于生成树/采样）
    #[serde(default = "default_folder_analysis_max_files")]
    pub max_files: u32,
    /// 文件夹扫描最大总字节数（用于读取文件内容采样）
    #[serde(default = "default_folder_analysis_max_total_bytes")]
    pub max_total_bytes: u64,
    /// 是否包含隐藏文件（以 . 开头）
    #[serde(default)]
    pub include_hidden: bool,
    /// 忽略规则（glob 风格）
    #[serde(default = "default_folder_analysis_ignore_globs")]
    pub ignore_globs: Vec<String>,
}

impl Default for FolderAnalysisSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            agent_ref: String::new(),
            thinking_level: None,
            concurrency: default_folder_analysis_concurrency(),
            additional_agents: Vec::new(),
            timeout_ms: default_folder_analysis_timeout_ms(),
            max_tokens: default_folder_analysis_max_tokens(),
            temperature: default_folder_analysis_temperature(),
            include_project_context: true,
            max_depth: default_folder_analysis_max_depth(),
            max_files: default_folder_analysis_max_files(),
            max_total_bytes: default_folder_analysis_max_total_bytes(),
            include_hidden: false,
            ignore_globs: default_folder_analysis_ignore_globs(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIntelligenceSettings {
    /// 总开关：关闭后前端不会启动/请求 LSP（保留纯编辑器能力）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 是否启用 LSP completion（建议列表）。关闭后仍可保留 hover/定义跳转/诊断等其它能力，便于调试 AI Completion。
    #[serde(default = "default_true")]
    pub lsp_completion_enabled: bool,
    /// 是否启用 Monaco 内置“词汇建议”（来自打开的文件内容，不依赖 LSP）。关闭后 Suggest 列表更“干净”，便于调试 AI Completion。
    #[serde(default = "default_true")]
    pub monaco_word_suggestions_enabled: bool,
    #[serde(default)]
    pub lsp_servers: Vec<LspServerConfig>,
    /// AI 辅助补全（幽灵补全 + Ctrl+Space 建议列表）
    #[serde(default)]
    pub ai_completion: AiCompletionSettings,
    /// Workstudio 符号分析（Outline 右键“分析类/函数/变量”等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol_analysis: Option<SymbolAnalysisSettings>,
    /// Workstudio 文件夹分析（Explorer 右键“分析文件夹”等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_analysis: Option<FolderAnalysisSettings>,
}

impl Default for CodeIntelligenceSettings {
    fn default() -> Self {
        // 默认开启 Rust/Python/Go（若本机未安装对应语言服务器，会在 UI 层提示；不会影响其它功能）
        Self {
            enabled: true,
            lsp_completion_enabled: true,
            monaco_word_suggestions_enabled: true,
            lsp_servers: vec![
                LspServerConfig {
                    language_id: "rust".to_string(),
                    enabled: true,
                    command: "rust-analyzer".to_string(),
                    // rust-analyzer 默认使用 stdio 通信；无需传 `--stdio`（部分版本会报 unknown flag）。
                    args: vec![],
                    ..Default::default()
                },
                LspServerConfig {
                    language_id: "python".to_string(),
                    enabled: true,
                    command: "pyright-langserver".to_string(),
                    args: vec!["--stdio".to_string()],
                    ..Default::default()
                },
                LspServerConfig {
                    language_id: "go".to_string(),
                    enabled: true,
                    command: "gopls".to_string(),
                    // 显式使用 `serve`（兼容旧版本 gopls；新版本无参也会默认 serve）。
                    args: vec!["serve".to_string()],
                    ..Default::default()
                },
            ],
            ai_completion: AiCompletionSettings::default(),
            symbol_analysis: Some(SymbolAnalysisSettings::default()),
            folder_analysis: Some(FolderAnalysisSettings::default()),
        }
    }
}

fn ensure_default_lsp_server_configs(cfg: &mut CodeIntelligenceSettings) -> bool {
    let mut changed = false;

    // vNext defaults: ensure Python LSP is present for existing configs.
    if !cfg.lsp_servers.iter().any(|s| s.language_id == "python") {
        cfg.lsp_servers.push(LspServerConfig {
            language_id: "python".to_string(),
            enabled: true,
            command: "pyright-langserver".to_string(),
            args: vec!["--stdio".to_string()],
            ..Default::default()
        });
        changed = true;
    }

    // vNext defaults: ensure Go LSP is present for existing configs.
    if !cfg.lsp_servers.iter().any(|s| s.language_id == "go") {
        cfg.lsp_servers.push(LspServerConfig {
            language_id: "go".to_string(),
            enabled: true,
            command: "gopls".to_string(),
            args: vec!["serve".to_string()],
            ..Default::default()
        });
        changed = true;
    }

    changed
}

#[cfg(test)]
mod context_policy_tests {
    use super::*;

    #[test]
    fn context_policy_disabled_alias_deserializes_to_simple() {
        let json = r#"{"type":"disabled"}"#;
        let policy: ContextPolicyConfig =
            serde_json::from_str(json).expect("should parse legacy disabled");
        match &policy {
            ContextPolicyConfig::Simple(cfg) => {
                assert!(cfg.enabled);
                assert!(cfg.trim_enabled);
                // legacy config may not specify this field; runtime falls back to 90.
                assert!(cfg.hard_limit_percent.is_none() || cfg.hard_limit_percent == Some(90));
            }
            _ => panic!("expected Simple variant"),
        }

        let out = serde_json::to_string(&policy).expect("should serialize");
        assert!(
            out.contains(r#""type":"simple""#),
            "should serialize as type=simple, got: {out}"
        );
    }
}

// ============================================================================
// MCP (Model Context Protocol)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum McpServerTransportConfig {
    /// Stdio transport: spawn a local process and talk JSON-RPC via stdin/stdout.
    #[serde(rename_all = "camelCase")]
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
        #[serde(default)]
        env_vars: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<PathBuf>,
    },
    /// Streamable HTTP transport: talk to a remote MCP server via HTTP.
    #[serde(rename_all = "camelCase")]
    StreamableHttp {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bearer_token_env_var: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        http_headers: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env_http_headers: Option<HashMap<String, String>>,
    },
    /// SSE transport: connect to `url` via Server-Sent Events (GET), then POST JSON-RPC to the
    /// `event: endpoint` provided by the server.
    ///
    /// 注意：DeepWiki 的 SSE 传输已弃用（`/sse` 会返回 410），请改用 streamable_http 的 `/mcp`：
    /// - transport: streamable_http
    /// - url: https://mcp.deepwiki.com/mcp
    #[serde(rename_all = "camelCase")]
    Sse {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bearer_token_env_var: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        http_headers: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env_http_headers: Option<HashMap<String, String>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub transport: McpServerTransportConfig,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Startup timeout in ms for initialize + initial tools/list
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_timeout_ms: Option<u64>,
    /// Default timeout in ms for tools/call
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_timeout_ms: Option<u64>,
    /// Allow-list of tools exposed from this server (empty = allow all)
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    /// Deny-list of tools (applied after enabled_tools)
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    /// Allow-list of resources (by uri) exposed from this server (empty = allow all)
    #[serde(default)]
    pub enabled_resources: Vec<String>,
    /// Deny-list of resources (by uri) (applied after enabled_resources)
    #[serde(default)]
    pub disabled_resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCachedToolInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCachedResourceInfo {
    pub uri: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDiscoveryCache {
    /// Unix epoch milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
    #[serde(default)]
    pub tools: Vec<McpCachedToolInfo>,
    #[serde(default)]
    pub resources: Vec<McpCachedResourceInfo>,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            transport: McpServerTransportConfig::Stdio {
                command: String::new(),
                args: Vec::new(),
                env: None,
                env_vars: Vec::new(),
                cwd: None,
            },
            enabled: true,
            startup_timeout_ms: None,
            tool_timeout_ms: None,
            enabled_tools: Vec::new(),
            disabled_tools: Vec::new(),
            enabled_resources: Vec::new(),
            disabled_resources: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    pub config: McpServerConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<McpServerDiscoveryCache>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetServerConfig {
    pub server: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Allow-list (empty = allow all tools from this server)
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    /// Deny-list (applied after enabled_tools)
    #[serde(default)]
    pub disabled_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetConfig {
    pub name: String,
    #[serde(default)]
    pub servers: Vec<McpSetServerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    #[serde(default)]
    pub servers: Vec<McpServerEntry>,
    #[serde(default)]
    pub sets: Vec<McpSetConfig>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            servers: Vec::new(),
            sets: Vec::new(),
        }
    }
}

// ============================================================================
// Security (sandbox policy)
// ============================================================================

/// Determines the conditions under which the user is consulted to approve
/// running the tool action proposed by the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AskForApproval {
    /// Only "known safe" read-only actions are auto-approved; everything else asks.
    #[serde(rename = "untrusted")]
    UnlessTrusted,
    /// Auto-approve in sandbox; if denied by sandbox, ask to retry with escalation.
    OnFailure,
    /// The model decides when to ask the user for approval.
    #[default]
    OnRequest,
    /// Never ask the user for approval.
    Never,
}

/// Represents whether outbound network access is available to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkAccess {
    #[default]
    Restricted,
    Enabled,
}

impl NetworkAccess {
    pub fn is_enabled(self) -> bool {
        matches!(self, NetworkAccess::Enabled)
    }
}

/// Determines execution restrictions for model shell/PTY commands.
///
/// Notes:
/// - This models Codex's sandbox policy shape for compatibility.
/// - Enforcement happens in the tool runtime layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SandboxPolicy {
    /// No restrictions whatsoever. Use with caution.
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,

    /// Read-only execution environment.
    #[serde(rename = "read-only")]
    ReadOnly,

    /// Indicates the process is already in an external sandbox.
    #[serde(rename = "external-sandbox")]
    ExternalSandbox {
        /// Whether the external sandbox permits outbound network traffic.
        #[serde(default, rename = "networkAccess")]
        network_access: NetworkAccess,
    },

    /// Same as `ReadOnly` but additionally grants write access to the workspace roots.
    #[serde(rename = "workspace-write")]
    WorkspaceWrite {
        /// Additional writable roots (beyond workspace roots).
        #[serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            rename = "writableRoots"
        )]
        writable_roots: Vec<String>,

        /// When set to `true`, outbound network access is allowed. `false` by default.
        #[serde(default = "default_true", rename = "networkAccess")]
        network_access: bool,

        /// When set to `true`, will NOT include the per-user `TMPDIR` env var among defaults.
        #[serde(default, rename = "excludeTmpdirEnvVar")]
        exclude_tmpdir_env_var: bool,

        /// When set to `true`, will NOT include `/tmp` among defaults on UNIX.
        #[serde(default, rename = "excludeSlashTmp")]
        exclude_slash_tmp: bool,
    },
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }
}

impl SandboxPolicy {
    pub fn has_full_disk_write_access(&self) -> bool {
        matches!(
            self,
            SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. }
        )
    }

    pub fn has_full_network_access(&self) -> bool {
        match self {
            SandboxPolicy::DangerFullAccess => true,
            SandboxPolicy::ExternalSandbox { network_access } => network_access.is_enabled(),
            SandboxPolicy::ReadOnly => false,
            SandboxPolicy::WorkspaceWrite { network_access, .. } => *network_access,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedCommandConfig {
    pub tool: String,
    pub command: String,
}

/// A named security policy (sandbox + approvals + trust list).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPolicyConfig {
    pub name: String,
    #[serde(default)]
    pub sandbox_policy: SandboxPolicy,
    #[serde(default)]
    pub approval_policy: AskForApproval,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trusted_commands: Vec<TrustedCommandConfig>,
}

/// Security settings (multiple policies).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    #[serde(default)]
    pub policies: Vec<SecurityPolicyConfig>,
    #[serde(default)]
    pub default_policy: String,

    // Legacy fields for migration (v1: single global sandbox/approval).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<SandboxPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<AskForApproval>,
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            policies: vec![SecurityPolicyConfig {
                name: "default".to_string(),
                sandbox_policy: SandboxPolicy::default(),
                approval_policy: AskForApproval::default(),
                trusted_commands: Vec::new(),
            }],
            default_policy: "default".to_string(),
            sandbox_policy: None,
            approval_policy: None,
        }
    }
}

impl SecuritySettings {
    pub fn normalize(&mut self) -> bool {
        let mut changed = false;

        if self.policies.is_empty() {
            let sandbox_policy = self.sandbox_policy.take().unwrap_or_default();
            let approval_policy = self.approval_policy.take().unwrap_or_default();
            self.policies.push(SecurityPolicyConfig {
                name: "default".to_string(),
                sandbox_policy,
                approval_policy,
                trusted_commands: Vec::new(),
            });
            self.default_policy = "default".to_string();
            changed = true;
        }

        let default_missing = self.default_policy.trim().is_empty()
            || !self.policies.iter().any(|p| p.name == self.default_policy);
        if default_missing {
            self.default_policy = self
                .policies
                .first()
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "default".to_string());
            changed = true;
        }

        if self.sandbox_policy.is_some() {
            self.sandbox_policy = None;
            changed = true;
        }
        if self.approval_policy.is_some() {
            self.approval_policy = None;
            changed = true;
        }

        changed
    }

    pub fn resolve_policy(&self, name: Option<&str>) -> &SecurityPolicyConfig {
        if let Some(name) = name.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if let Some(p) = self.policies.iter().find(|p| p.name == name) {
                return p;
            }
        }

        if let Some(p) = self.policies.iter().find(|p| p.name == self.default_policy) {
            return p;
        }

        // Defensive fallback: should not happen after normalize().
        self.policies
            .first()
            .expect("SecuritySettings.policies should not be empty")
    }
}

/// Application configuration (new structure)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub appearance: AppearanceSettings,
    pub general: GeneralSettings,
    /// 严格报错模式（开发者选项，默认 false）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict_error_mode: Option<bool>,
    /// 拦截控制台报错日志转弹窗（默认 true）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intercept_console_error: Option<bool>,
    /// Tooling settings (toolsets)
    #[serde(default)]
    pub tools: ToolsSettings,
    /// Code intelligence settings (LSP / AST)
    #[serde(default)]
    pub code_intelligence: CodeIntelligenceSettings,
    /// MCP settings (servers + sets)
    #[serde(default)]
    pub mcp: McpSettings,
    /// Skills settings (skill sets + disabled list)
    #[serde(default)]
    pub skills: SkillsSettings,
    /// Security settings (sandbox policy, etc.)
    #[serde(default)]
    pub security: SecuritySettings,
    /// AI service providers
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// AI agents
    #[serde(default)]
    pub agents: Vec<Agent>,
    /// Default agent name
    #[serde(default)]
    pub default_agent: String,
    /// Currently selected agent (runtime state)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_agent: Option<String>,
    /// Currently selected model ref (can differ from agent's default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model_ref: Option<String>,
    // Legacy fields for migration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<Preset>>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            appearance: AppearanceSettings::default(),
            general: GeneralSettings::default(),
            strict_error_mode: None,
            intercept_console_error: Some(true),
            tools: ToolsSettings::default(),
            code_intelligence: CodeIntelligenceSettings::default(),
            mcp: McpSettings::default(),
            skills: SkillsSettings::default(),
            security: SecuritySettings::default(),
            providers: Vec::new(),
            agents: Vec::new(),
            default_agent: String::new(),
            current_agent: None,
            current_model_ref: None,
            active_model_id: None,
            models: None,
            presets: None,
        }
    }
}

impl AppConfig {
    pub fn normalize(&mut self) -> bool {
        let mut changed = false;
        if self.security.normalize() {
            changed = true;
        }

        if ensure_default_lsp_server_configs(&mut self.code_intelligence) {
            changed = true;
        }

        // Toolsets: 文本编辑工具统一收敛为抽象开关 `text_edit`（避免同时暴露多种实现，造成配置与提示词混乱）。
        if ensure_toolset_text_edit_normalized(self) {
            changed = true;
        }
        // Toolsets: shell 工具统一收敛为抽象开关 `shell`（默认由模型选择 shell_command）。
        if ensure_toolset_shell_normalized(self) {
            changed = true;
        }

        // Backward compatibility: symbol analysis used to reuse aiCompletion settings.
        // If existing config doesn't have symbolAnalysis, initialize it based on aiCompletion so
        // upgrading won't silently break Workstudio 的“分析类/函数/变量”等功能。
        if self.code_intelligence.symbol_analysis.is_none() {
            let mut migrated = SymbolAnalysisSettings::default();
            migrated.enabled = self.code_intelligence.ai_completion.enabled;
            migrated.max_tokens = self.code_intelligence.ai_completion.max_tokens;
            migrated.temperature = self.code_intelligence.ai_completion.temperature;
            migrated.include_project_context =
                self.code_intelligence.ai_completion.include_project_context;
            // Keep analysis timeout reasonably large even if aiCompletion.timeoutMs was small.
            migrated.timeout_ms = default_symbol_analysis_timeout_ms()
                .max(self.code_intelligence.ai_completion.timeout_ms);
            self.code_intelligence.symbol_analysis = Some(migrated);
            changed = true;
        }

        // Backward compatibility: folder analysis is a newer feature.
        // If existing config doesn't have folderAnalysis, initialize it based on symbolAnalysis
        // to keep the "AI analysis" features consistent after upgrading.
        if self.code_intelligence.folder_analysis.is_none() {
            let mut migrated = FolderAnalysisSettings::default();
            if let Some(sym) = self.code_intelligence.symbol_analysis.as_ref() {
                migrated.enabled = sym.enabled;
                migrated.thinking_level = sym.thinking_level.clone();
                migrated.timeout_ms = default_folder_analysis_timeout_ms().max(sym.timeout_ms);
                migrated.max_tokens = sym.max_tokens;
                migrated.temperature = sym.temperature;
                migrated.include_project_context = sym.include_project_context;
            }
            self.code_intelligence.folder_analysis = Some(migrated);
            changed = true;
        }

        // Best-effort defaults for existing configs: infer missing model context lengths.
        for provider in &mut self.providers {
            for model in &mut provider.models {
                if model.context_length.is_some() {
                    continue;
                }
                if let Some(v) = infer_context_length(&model.name) {
                    model.context_length = Some(v);
                    changed = true;
                }
            }
        }

        // Ensure built-in Workspace AI defaults exist (system agents + readonly toolset),
        // so Workstudio features (符号分析/Chat With/补全) can run even before the user manually
        // adds these agents into config.json.
        if ensure_system_workspace_defaults(self) {
            changed = true;
        }

        changed
    }

    /// Check if config needs migration from legacy format
    pub fn needs_migration(&self) -> bool {
        self.models.is_some() && self.providers.is_empty()
    }

    /// Migrate from legacy format to new provider-model-agent structure
    pub fn migrate(&mut self) {
        if !self.needs_migration() {
            return;
        }

        let legacy_models = match self.models.take() {
            Some(m) => m,
            None => return,
        };

        // Group models by provider + apiBase
        use std::collections::HashMap;
        let mut provider_map: HashMap<(String, String), Provider> = HashMap::new();

        for model_config in &legacy_models {
            let api_base = model_config.api_base.clone().unwrap_or_default();
            let key = (model_config.provider.clone(), api_base.clone());

            let provider = provider_map.entry(key).or_insert_with(|| {
                let provider_type = match model_config.provider.as_str() {
                    "anthropic" => ProviderType::Anthropic,
                    "ollama" => ProviderType::Ollama,
                    _ => ProviderType::Openai,
                };
                Provider {
                    name: model_config.provider.clone(),
                    display_name: model_config.provider.clone(),
                    provider_type,
                    api_base,
                    api_key: model_config.api_key.clone(),
                    enabled: true,
                    force_responses_reasoning: false,
                    seasun_thinking: false,
                    models: Vec::new(),
                }
            });

            // Add model to provider
            provider.models.push(Model {
                name: model_config.model.clone(),
                temperature: model_config.parameters.temperature.unwrap_or(0.7),
                temperature_enabled: model_config.parameters.temperature.is_some(),
                max_tokens: model_config.parameters.max_tokens,
                top_p: model_config.parameters.top_p,
                top_p_enabled: model_config.parameters.top_p.is_some(),
                context_length: None,
                capabilities: ModelCapabilities::default(),
                retry_attempts: None,
                resume_partial_output: model_config.resume_partial_output,
                stream_include_usage: model_config.stream_include_usage,
                max_images: None,
                thinking_budget_tokens: None,
                use_reasoning_effort: None,
                reinject_reasoning_content: false,
                text_edit_implementation: None,
                agent_task_implementation: None,
                shell_implementation: None,
            });

            // Create agent from model's system prompt
            let agent_name = format!("agent_{}", model_config.id);
            let model_ref = format!("{}/{}", model_config.provider, model_config.model);
            self.agents.push(Agent {
                name: agent_name.clone(),
                enabled: true,
                agent_type: AgentType::Chat,
                display_name: model_config.name.clone(),
                description: None,
                task_usage: None,
                model_ref,
                system_prompt: model_config
                    .parameters
                    .system_prompt
                    .clone()
                    .unwrap_or_default(),
                format_type: FormatPromptType::Chat,
                default_run_mode: None,
                toolset: None,
                mcp_set: None,
                skill_set: None,
                security_policy: None,
                sandbox_policy: None,
                approval_policy: None,
                workspace_support: None,
                max_turns: None,
                reinject_thinking: false,
                context_policy: None,
                workstudio_enabled: None,
            });

            // Set default agent
            if self.active_model_id.as_ref() == Some(&model_config.id) {
                self.default_agent = agent_name;
            }
        }

        self.providers = provider_map.into_values().collect();
        self.active_model_id = None;
        self.presets = None;
    }

    /// Get provider by name
    pub fn get_provider(&self, name: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.name == name)
    }

    /// Get agent by name
    pub fn get_agent(&self, name: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.name == name && a.enabled)
    }

    /// Get default agent
    pub fn get_default_agent(&self) -> Option<&Agent> {
        if self.default_agent.is_empty() {
            self.agents.iter().find(|a| a.enabled)
        } else {
            self.get_agent(&self.default_agent)
        }
    }

    /// Parse model reference "provider/model" into (provider_name, model_name)
    pub fn parse_model_ref(model_ref: &str) -> Option<(&str, &str)> {
        let parts: Vec<&str> = model_ref.splitn(2, '/').collect();
        if parts.len() == 2 {
            Some((parts[0], parts[1]))
        } else {
            None
        }
    }

    /// Resolve agent to provider and model
    pub fn resolve_agent(&self, agent_name: &str) -> Option<(&Provider, &Model, &Agent)> {
        let agent = self.get_agent(agent_name)?;
        let (provider_name, model_name) = Self::parse_model_ref(&agent.model_ref)?;
        let provider = self.get_provider(provider_name)?;
        let model = provider.models.iter().find(|m| m.name == model_name)?;
        Some((provider, model, agent))
    }
}

fn ensure_system_workspace_defaults(cfg: &mut AppConfig) -> bool {
    const TOOLSET_NAME: &str = "__system_workspace_readonly";

    const AGENT_CODE_COMPLETION: &str = "__system_code_completion";
    const AGENT_CHAT_WITH: &str = "__system_chat_with";
    const AGENT_SYMBOL_ANALYSIS: &str = "__system_symbol_analysis";
    const AGENT_FOLDER_ANALYSIS: &str = "__system_folder_analysis";
    const AGENT_TASK_EXAMPLE: &str = "__system_taskagent_example";

    let mut changed = false;

    const LEGACY_SYMBOL_ANALYSIS_PROMPT: &str = r#"你是 IDE 中的“代码符号分析助手”。

你会收到：
- 一个代码符号（类/函数/变量等）的元信息
- 该符号对应的代码片段（可能不完整）
- 一些工程元信息（languageId、filePath、projectRoot）

请输出 **Markdown**，并遵循：
- 先给结论摘要（1-3 句）
- 再给结构化分析（分点/小标题均可）
- 尽可能指出潜在问题与可执行改进建议
- 当缺少关键上下文时，明确指出需要看的文件/关键搜索词，而不是臆测
"#;

    const LEGACY_CHAT_WITH_PROMPT: &str = r#"你是 IDE 中的“内联代码问答助手”。

你会收到：
- 用户的问题
- 一个“选中代码片段”（可能只是一部分，需要你自行推断上下文）
- 一些元信息（languageId、filePath、projectRoot）

请按用户问题直接作答，并遵循：
- 如缺少关键上下文，请明确指出需要哪些信息/文件。
- 可给出可执行的下一步（例如：要看的文件、要跑的命令、要加的日志点）。
- 输出使用 Markdown，必要时可包含代码块。
"#;

    const CHAT_WITH_PROMPT_V2: &str = r#"你是 IDE 中的“代码对话助手（Chat With）”。

你会收到：
- 用户问题（可能是连续追问）
- 一个选中代码片段（可能不完整）
- 元信息（languageId、filePath、projectRoot）

输出必须使用 Markdown，并遵循：
1) 先给结论摘要，再给结构化分析，最后给可执行建议/验证步骤。
2) 关键结论尽量附代码定位，文件引用格式仅允许：
   - `path:line` / `path:line:column`
   - `path#Lline` / `path#LlineCcolumn`
   禁止使用 `[label](path)` 这种文件链接写法；不要编造行号。
   - 所有 `path` 都必须相对 `projectRoot` 输出；如果仓库里还有嵌套子项目，不能省略外层目录前缀。
   - 例如：若 `projectRoot` 是仓库根目录，而代码位于 `tauri-ai/` 子项目中，应写 `tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`，不要写 `apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`。
3) 解释调用链/模块关系/生命周期时，优先给 Mermaid UML（flowchart / sequence / classDiagram）。
4) 若 Mermaid 节点需要可点击跳转代码，请使用 `click` 语法并绑定到 `path:line`。
5) 缺少上下文时明确指出需要查看的文件/符号/命令，不要臆测。
"#;

    const SYMBOL_ANALYSIS_PROMPT_V2: &str = r#"你是 IDE 中的“代码符号分析助手”（Symbol Analysis）。

你的目标：在不臆测的前提下，基于符号的代码片段 + 工程上下文，给出“可执行、可验证”的分析结论。

你会收到：
- 一个代码符号的元信息（symbolName、symbolKind、filePath、location 等）
- 该符号对应的代码片段（可能不完整）
- 一些工程元信息（languageId、projectRoot）
- 你可以在需要时使用工具（read_file / rg / list_dir / web_search）来补齐上下文，但不要修改文件。

输出要求（必须）：
- 使用 Markdown。
- 先给结论摘要（1-3 句），再给结构化分析（分点/小标题均可），最后给风险点 + 可执行改进建议 + 验证清单。
- 当缺少关键上下文时：明确列出需要看的文件/需要搜索的关键字/需要补充的信息，不要猜。

### 文件引用（必须严格遵守）
当你在讨论代码定位、调用链、实现细节或引用关系时，所有关键结论必须附带**可点击文件引用**，格式只允许：
- `相对路径:行` 或 `相对路径:行:列`
- `相对路径#L行` 或 `相对路径#L行C列`
禁止使用 Markdown 链接语法引用文件（例如 `[label](path)`）；不要编造行号：拿不到行号时请先用 `rg`/打开文件定位，再输出引用。
- 所有路径都必须相对 `projectRoot` 或主工作区根目录输出；若仓库中存在嵌套子项目，必须保留最外层子目录前缀。
- 例如：若主工作区根目录是仓库根，而代码位于 `tauri-ai/` 子项目，应写 `tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`，不要写 `apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`。

### 分析策略（按符号类型自适应）
1) 若符号是大型类型/容器（class/struct/trait/enum/module…）：
- 优先做偏宏观的分析：职责边界、对外 API、关键字段/方法分组、依赖关系、生命周期、并发/线程安全、错误处理、扩展点。
- 避免逐行复述；选择最关键的 3-8 个点展开，并用文件引用指向定义与关键成员。

2) 若符号是函数/方法：
- 先解释“业务意图”：它在业务流程中解决什么问题，输入/输出代表什么，关键分支与副作用是什么。
- 再调查“可能的业务调用路径”：尽量找到调用者（入口/上游）与被调用的下游依赖，给出 2-5 条可能调用链，并为链路节点提供文件引用。
- 同时分析失败路径与可观测性（日志/错误返回/指标）。

3) 若符号是变量/字段/常量：
- 做引用分析：解释语义与不变量（单位/范围/默认值/可变性），并尽量找出写入点/读取点/传递路径。
- 说明它如何影响系统行为（配置、状态机、缓存、并发共享状态等），列出代表性的引用位置（带文件引用）；引用过多时按模块聚类，避免穷举。
	"#;

    const FOLDER_ANALYSIS_PROMPT_V1: &str = r#"你是 IDE 中的“文件夹分析助手”（Folder Analysis）。

你的目标：在不臆测的前提下，对给定文件夹进行宏观结构分析 + 风险诊断，输出“可执行、可验证”的建议。

你会收到：
- 一个文件夹路径（folderPath）
- 一些工程元信息（projectRoot、workstudioMainFolder 等）
- 你可以在需要时使用工具（read_file / rg / list_dir / web_search）来补齐上下文，但不要修改文件。

输出要求（必须）：
- 使用 Markdown。
- 先给结论摘要（1-3 句），再给结构化分析（模块分层/入口与关键流程/数据与状态/依赖与边界/错误处理/可观测性/测试），最后给风险点 + 可执行改进建议 + 验证清单。
- 当缺少关键上下文时：明确列出需要看的文件/需要搜索的关键字/需要补充的信息，不要猜。

### 文件引用（必须严格遵守）
当你在讨论代码定位、调用链、实现细节或引用关系时，所有关键结论必须附带**可点击文件引用**，格式只允许：
- `相对路径:行` 或 `相对路径:行:列`
- `相对路径#L行` 或 `相对路径#L行C列`
禁止使用 Markdown 链接语法引用文件（例如 `[label](path)`）；不要编造行号：拿不到行号时请先用 `rg`/打开文件定位，再输出引用。
"#;

    const TASK_AGENT_EXAMPLE_PROMPT_V1: &str = r#"你是一个 TaskAgent 示例，专门处理“边界清晰、输入明确”的子任务。

工作方式：
1) 先复述你理解到的子任务目标（1-2 句）。
2) 必要时使用只读工具（read_file / rg / list_dir）补齐上下文，不要修改文件。
3) 输出结构化结果：
   - 结论摘要
   - 关键依据（尽量附文件引用）
   - 下一步建议（可执行）

注意：
- 当信息不足时，明确说出缺什么，不要臆测。
- 保持简洁，优先可验证结论。
"#;

    // 1) Toolset: safe read-only tools for Workstudio AI (no apply_patch / no exec).
    if !cfg.tools.toolsets.iter().any(|t| t.name == TOOLSET_NAME) {
        cfg.tools.toolsets.push(ToolSetConfig {
            name: TOOLSET_NAME.to_string(),
            tools: vec![
                "read_file".to_string(),
                "list_dir".to_string(),
                "rg".to_string(),
                "view_image".to_string(),
                // Optional: only injected when enabled + configured.
                "web_search".to_string(),
            ],
            persistance_shell_enhance: false,
        });
        changed = true;
    }

    let current_model_ref = cfg
        .current_model_ref
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();

    // Helper to insert or patch system agents in-place (best-effort; do not overwrite user fields unless missing).
    let mut ensure_agent = |name: &str,
                            display_name: &str,
                            description: &str,
                            system_prompt: &str,
                            legacy_system_prompt: Option<&str>,
                            toolset: Option<&str>| {
        match cfg.agents.iter_mut().find(|a| a.name == name) {
            Some(a) => {
                // These are system fallback agents; keep them enabled and workspace-capable.
                if !a.enabled {
                    a.enabled = true;
                    changed = true;
                }
                if !matches!(a.agent_type, AgentType::Tool) {
                    a.agent_type = AgentType::Tool;
                    changed = true;
                }
                if a.display_name.trim().is_empty() {
                    a.display_name = display_name.to_string();
                    changed = true;
                }
                if a.description.as_deref().unwrap_or("").trim().is_empty() {
                    a.description = Some(description.to_string());
                    changed = true;
                }
                if !matches!(a.agent_type, AgentType::TaskAgent) {
                    if a.task_usage.is_some() {
                        a.task_usage = None;
                        changed = true;
                    }
                }
                let normalize_prompt = |s: &str| s.replace("\r\n", "\n").trim().to_string();
                let legacy = legacy_system_prompt.unwrap_or("");
                let legacy_norm = normalize_prompt(legacy);
                let cur_norm = normalize_prompt(&a.system_prompt);
                if cur_norm.is_empty() || (!legacy_norm.is_empty() && cur_norm == legacy_norm) {
                    a.system_prompt = system_prompt.to_string();
                    changed = true;
                }
                if a.format_type == FormatPromptType::None {
                    a.format_type = FormatPromptType::Chat;
                    changed = true;
                }
                // Default run mode: keep it conservative (chat permission + tools).
                if a.default_run_mode
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    a.default_run_mode = Some("chat".to_string());
                    changed = true;
                }
                if a.workspace_support.is_none() {
                    a.workspace_support = Some(true);
                    changed = true;
                }
                if a.workstudio_enabled.is_none() {
                    a.workstudio_enabled = Some(true);
                    changed = true;
                }
                if a.model_ref.trim().is_empty() && !current_model_ref.is_empty() {
                    a.model_ref = current_model_ref.clone();
                    changed = true;
                }
                if let Some(ts) = toolset {
                    let needs = a
                        .toolset
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true);
                    if needs {
                        a.toolset = Some(ts.to_string());
                        changed = true;
                    }
                }
            }
            None => {
                cfg.agents.push(Agent {
                    name: name.to_string(),
                    enabled: true,
                    agent_type: AgentType::Tool,
                    display_name: display_name.to_string(),
                    description: Some(description.to_string()),
                    task_usage: None,
                    model_ref: if current_model_ref.is_empty() {
                        String::new()
                    } else {
                        current_model_ref.clone()
                    },
                    system_prompt: system_prompt.to_string(),
                    format_type: FormatPromptType::Chat,
                    default_run_mode: Some("chat".to_string()),
                    toolset: toolset.map(|s| s.to_string()),
                    mcp_set: None,
                    skill_set: None,
                    security_policy: None,
                    sandbox_policy: None,
                    approval_policy: None,
                    workspace_support: Some(true),
                    max_turns: None,
                    reinject_thinking: false,
                    context_policy: None,
                    workstudio_enabled: Some(true),
                });
                changed = true;
            }
        }
    };

    ensure_agent(
        AGENT_CODE_COMPLETION,
        "代码补全",
        "为编辑器提供智能代码补全（InlineCompletion）服务",
        r#"你是一个 IDE 里的代码补全引擎。

你必须只输出一个 JSON 对象，且只能包含这些字段：
{
  "items": [
    { "label": "短描述", "insertText": "要插入的文本" }
  ]
}

严格规则：
- 只输出 JSON，不要输出任何解释、注释、Markdown、代码块围栏（```）。
- insertText 只包含“需要在光标处插入的内容”，不要重复 prefix，也不要包含 suffix。
- 使用 \n 表示换行；不要输出 JSON 之外的任何字符。
"#,
        None,
        None,
    );

    ensure_agent(
        AGENT_CHAT_WITH,
        "代码对话（Chat With）",
        "对选中代码片段进行问答的内联对话服务",
        CHAT_WITH_PROMPT_V2,
        Some(LEGACY_CHAT_WITH_PROMPT),
        Some(TOOLSET_NAME),
    );

    ensure_agent(
        AGENT_SYMBOL_ANALYSIS,
        "符号分析（Symbol Analysis）",
        "对代码符号（函数/类/变量）进行深度解析的服务",
        SYMBOL_ANALYSIS_PROMPT_V2,
        Some(LEGACY_SYMBOL_ANALYSIS_PROMPT),
        Some(TOOLSET_NAME),
    );

    ensure_agent(
        AGENT_FOLDER_ANALYSIS,
        "文件夹分析（Folder Analysis）",
        "对工作区文件夹做宏观结构与风险诊断的服务",
        FOLDER_ANALYSIS_PROMPT_V1,
        None,
        Some(TOOLSET_NAME),
    );

    // TaskAgent 示例：用于 `agenttask` 子任务链路验证（可作为默认兜底）。
    match cfg.agents.iter_mut().find(|a| a.name == AGENT_TASK_EXAMPLE) {
        Some(a) => {
            if !a.enabled {
                a.enabled = true;
                changed = true;
            }
            if !matches!(a.agent_type, AgentType::TaskAgent) {
                a.agent_type = AgentType::TaskAgent;
                changed = true;
            }
            if a.display_name.trim().is_empty() {
                a.display_name = "TaskAgent 示例".to_string();
                changed = true;
            }
            if a.description.as_deref().unwrap_or("").trim().is_empty() {
                a.description = Some("用于 `agenttask` 的示例子任务代理（只读分析）".to_string());
                changed = true;
            }
            if a.task_usage.as_deref().unwrap_or("").trim().is_empty() {
                a.task_usage = Some(
                    "适用场景：边界清晰的只读分析子任务；输入建议包含目标、约束与期望输出结构。输出将给出结论、依据与下一步建议。"
                        .to_string(),
                );
                changed = true;
            }
            if a.system_prompt.trim().is_empty() {
                a.system_prompt = TASK_AGENT_EXAMPLE_PROMPT_V1.to_string();
                changed = true;
            }
            if a.format_type == FormatPromptType::None {
                a.format_type = FormatPromptType::Chat;
                changed = true;
            }
            if a.default_run_mode
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                a.default_run_mode = Some("agent".to_string());
                changed = true;
            }
            if a.workspace_support.is_none() {
                a.workspace_support = Some(true);
                changed = true;
            }
            if a.model_ref.trim().is_empty() && !current_model_ref.is_empty() {
                a.model_ref = current_model_ref.clone();
                changed = true;
            }
            if a.toolset.as_deref().unwrap_or("").trim().is_empty() {
                a.toolset = Some(TOOLSET_NAME.to_string());
                changed = true;
            }
        }
        None => {
            cfg.agents.push(Agent {
                name: AGENT_TASK_EXAMPLE.to_string(),
                enabled: true,
                agent_type: AgentType::TaskAgent,
                display_name: "TaskAgent 示例".to_string(),
                description: Some("用于 `agenttask` 的示例子任务代理（只读分析）".to_string()),
                task_usage: Some(
                    "适用场景：边界清晰的只读分析子任务；输入建议包含目标、约束与期望输出结构。输出将给出结论、依据与下一步建议。"
                        .to_string(),
                ),
                model_ref: if current_model_ref.is_empty() {
                    String::new()
                } else {
                    current_model_ref.clone()
                },
                system_prompt: TASK_AGENT_EXAMPLE_PROMPT_V1.to_string(),
                format_type: FormatPromptType::Chat,
                default_run_mode: Some("agent".to_string()),
                toolset: Some(TOOLSET_NAME.to_string()),
                mcp_set: None,
                skill_set: None,
                security_policy: None,
                sandbox_policy: None,
                approval_policy: None,
                workspace_support: Some(true),
                max_turns: None,
                reinject_thinking: false,
                context_policy: None,
                workstudio_enabled: None,
            });
            changed = true;
        }
    }

    changed
}

fn ensure_toolset_text_edit_normalized(cfg: &mut AppConfig) -> bool {
    const MARKER: &str = "text_edit";
    const APPLY_PATCH: &str = "apply_patch";
    const APPLY_PATCH_UNIFIED: &str = "apply_patch_unified_diff";
    const WRITE_FILE: &str = "write_file";
    const REPLACE_STRING: &str = "replace_string";

    let mut changed = false;
    for ts in &mut cfg.tools.toolsets {
        if ts.tools.is_empty() {
            continue;
        }

        // Trim + stable dedupe (preserve order).
        let mut cleaned: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for raw in ts.tools.iter() {
            let name = raw.trim();
            if name.is_empty() {
                changed = true;
                continue;
            }
            if seen.insert(name.to_string()) {
                cleaned.push(name.to_string());
            } else {
                changed = true;
            }
        }

        // 文本编辑工具统一收敛为抽象开关 `text_edit`：
        // - 旧配置可能直接包含 apply_patch / apply_patch_unified_diff / write_file / replace_string
        // - 新配置只保留 `text_edit`，具体实现由“模型的 textEditImplementation”选择
        let edit_tools = [
            MARKER,
            APPLY_PATCH,
            APPLY_PATCH_UNIFIED,
            WRITE_FILE,
            REPLACE_STRING,
        ];
        let first_edit_idx = cleaned
            .iter()
            .position(|t| edit_tools.contains(&t.as_str()));
        let has_any_edit = first_edit_idx.is_some();
        if has_any_edit {
            let before = cleaned.clone();
            cleaned.retain(|t| !edit_tools.contains(&t.as_str()));
            let insert_at = first_edit_idx
                .unwrap_or_else(|| cleaned.len())
                .min(cleaned.len());
            cleaned.insert(insert_at, MARKER.to_string());
            if cleaned != before {
                changed = true;
            }
        }

        if cleaned != ts.tools {
            ts.tools = cleaned;
            changed = true;
        }
    }

    changed
}

fn ensure_toolset_shell_normalized(cfg: &mut AppConfig) -> bool {
    const MARKER: &str = "shell";
    const SHELL_COMMAND: &str = "shell_command";
    const EXEC_COMMAND: &str = "exec_command";
    const WRITE_STDIN: &str = "write_stdin";
    const EXEC_COMMAND_PERSISTENT: &str = "exec_command_persistent";
    const WRITE_STDIN_PERSISTENT: &str = "write_stdin_persistent";

    let mut changed = false;
    for ts in &mut cfg.tools.toolsets {
        if ts.tools.is_empty() {
            continue;
        }

        // Trim + stable dedupe (preserve order).
        let mut cleaned: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for raw in ts.tools.iter() {
            let name = raw.trim();
            if name.is_empty() {
                changed = true;
                continue;
            }
            if seen.insert(name.to_string()) {
                cleaned.push(name.to_string());
            } else {
                changed = true;
            }
        }

        // shell 工具统一收敛为抽象开关 `shell`：
        // - 旧配置可能直接包含 shell_command / exec_command / write_stdin / *_persistent
        // - 新配置只保留 `shell`，具体实现由“模型的 shellImplementation”选择
        let shell_tools = [
            MARKER,
            SHELL_COMMAND,
            EXEC_COMMAND,
            WRITE_STDIN,
            EXEC_COMMAND_PERSISTENT,
            WRITE_STDIN_PERSISTENT,
        ];
        let first_shell_idx = cleaned
            .iter()
            .position(|t| shell_tools.contains(&t.as_str()));
        let has_any_shell = first_shell_idx.is_some();
        if has_any_shell {
            let before = cleaned.clone();
            cleaned.retain(|t| !shell_tools.contains(&t.as_str()));
            let insert_at = first_shell_idx
                .unwrap_or_else(|| cleaned.len())
                .min(cleaned.len());
            cleaned.insert(insert_at, MARKER.to_string());
            if cleaned != before {
                changed = true;
            }
        }

        if cleaned != ts.tools {
            ts.tools = cleaned;
            changed = true;
        }
    }

    changed
}

fn infer_context_length(model_name: &str) -> Option<u32> {
    let name = model_name.trim().to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }

    // GLM series
    if name.contains("glm-4.7") {
        return Some(256_000);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy for generating arbitrary ContentPart::TextFile
    fn arb_text_file() -> impl Strategy<Value = ContentPart> {
        // Generate non-empty strings for filename and content
        ("[a-zA-Z0-9_.-]{1,50}", ".*")
            .prop_map(|(filename, content)| ContentPart::text_file(filename, content))
    }

    /// Strategy for generating arbitrary PdfPage
    fn arb_pdf_page() -> impl Strategy<Value = PdfPage> {
        (
            1u32..100u32,
            ".*",
            "data:image/png;base64,[a-zA-Z0-9+/=]{10,100}",
        )
            .prop_map(|(page_number, text, image)| PdfPage {
                page_number,
                text,
                image,
            })
    }

    /// Strategy for generating arbitrary PdfMetadata
    fn arb_pdf_metadata() -> impl Strategy<Value = Option<PdfMetadata>> {
        prop::option::of((
            prop::option::of("[a-zA-Z0-9 ]{1,50}"),
            prop::option::of("[a-zA-Z0-9 ]{1,50}"),
            prop::option::of("[0-9]{4}-[0-9]{2}-[0-9]{2}"),
            prop::option::of("[a-zA-Z0-9 ]{1,50}"),
            prop::option::of("[a-zA-Z0-9 ]{1,50}"),
            prop::option::of("[a-zA-Z0-9, ]{1,50}"),
        ))
        .prop_map(|opt| {
            opt.map(
                |(title, author, created_at, producer, subject, keywords)| PdfMetadata {
                    title,
                    author,
                    created_at,
                    producer,
                    subject,
                    keywords,
                },
            )
        })
    }

    /// Strategy for generating arbitrary ContentPart::PdfDocument
    fn arb_pdf_document() -> impl Strategy<Value = ContentPart> {
        (
            "[a-zA-Z0-9_.-]{1,50}\\.pdf",
            prop::collection::vec(arb_pdf_page(), 1..10),
            arb_pdf_metadata(),
        )
            .prop_map(|(filename, pages, metadata)| {
                ContentPart::pdf_document(filename, pages, metadata)
            })
    }

    proptest! {
        /// **Property 7: ContentPart Serialization Round-Trip**
        /// *For any* valid ContentPart::TextFile with arbitrary filename and content,
        /// serializing to JSON and then deserializing SHALL produce an equivalent
        /// ContentPart with the same filename and content.
        /// **Validates: Requirements 6.2, 6.3, 6.4**
        #[test]
        fn prop_content_part_text_file_roundtrip(part in arb_text_file()) {
            // Serialize to JSON
            let json = serde_json::to_string(&part).expect("Serialization should succeed");

            // Verify JSON contains correct tag
            prop_assert!(json.contains(r#""type":"text_file""#), "JSON should contain text_file type tag");

            // Deserialize back
            let deserialized: ContentPart = serde_json::from_str(&json).expect("Deserialization should succeed");

            // Verify round-trip equality
            prop_assert_eq!(part, deserialized, "Round-trip should preserve ContentPart");
        }

        /// **Property 1: PdfDocument Serialization Round-Trip**
        /// *For any* valid ContentPart::PdfDocument with arbitrary filename, pages, and metadata,
        /// serializing to JSON and then deserializing SHALL produce an equivalent
        /// ContentPart with the same filename, pages, total_pages, and metadata.
        /// **Validates: Requirements 8.2, 8.3**
        #[test]
        fn prop_content_part_pdf_document_roundtrip(part in arb_pdf_document()) {
            // Serialize to JSON
            let json = serde_json::to_string(&part).expect("Serialization should succeed");

            // Verify JSON contains correct tag
            prop_assert!(json.contains(r#""type":"pdf_document""#), "JSON should contain pdf_document type tag");

            // Deserialize back
            let deserialized: ContentPart = serde_json::from_str(&json).expect("Deserialization should succeed");

            // Verify round-trip equality
            prop_assert_eq!(&part, &deserialized, "Round-trip should preserve PdfDocument ContentPart");

            // Additional verification for PdfDocument-specific fields
            if let ContentPart::PdfDocument { filename, pages, total_pages, metadata } = &part {
                if let ContentPart::PdfDocument {
                    filename: d_filename,
                    pages: d_pages,
                    total_pages: d_total_pages,
                    metadata: d_metadata
                } = &deserialized {
                    prop_assert_eq!(filename, d_filename, "Filename should be preserved");
                    prop_assert_eq!(pages.len(), d_pages.len(), "Number of pages should be preserved");
                    prop_assert_eq!(total_pages, d_total_pages, "Total pages should be preserved");
                    prop_assert_eq!(*total_pages, pages.len() as u32, "Total pages should match pages vector length");
                    prop_assert_eq!(metadata, d_metadata, "Metadata should be preserved");

                    // Verify each page
                    for (i, (page, d_page)) in pages.iter().zip(d_pages.iter()).enumerate() {
                        prop_assert_eq!(page.page_number, d_page.page_number, "Page {} number should be preserved", i);
                        prop_assert_eq!(&page.text, &d_page.text, "Page {} text should be preserved", i);
                        prop_assert_eq!(&page.image, &d_page.image, "Page {} image should be preserved", i);
                    }
                }
            }
        }
    }

    #[test]
    fn test_text_file_serialization_format() {
        let part = ContentPart::text_file("test.txt", "Hello, World!");
        let json = serde_json::to_string(&part).unwrap();

        // Verify JSON structure
        assert!(json.contains(r#""type":"text_file""#));
        assert!(json.contains(r#""filename":"test.txt""#));
        assert!(json.contains(r#""content":"Hello, World!""#));
    }

    #[test]
    fn test_text_file_deserialization() {
        let json =
            r#"{"type":"text_file","filename":"config.json","content":"{\"key\":\"value\"}"}"#;
        let part: ContentPart = serde_json::from_str(json).unwrap();

        match part {
            ContentPart::TextFile { filename, content } => {
                assert_eq!(filename, "config.json");
                assert_eq!(content, r#"{"key":"value"}"#);
            }
            _ => panic!("Expected TextFile variant"),
        }
    }

    #[test]
    fn test_has_multimodal_content() {
        use chrono::Utc;

        // Test with only text content
        let text_only_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Hello".to_string(),
            content_parts: vec![],
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(!text_only_message.has_multimodal_content());
        assert!(!text_only_message.has_images());

        // Test with text file
        let text_file_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze this file".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze this file"),
                ContentPart::text_file("main.rs", "fn main() {}"),
            ],
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(text_file_message.has_multimodal_content());
        assert!(!text_file_message.has_images());

        // Test with image
        let image_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Look at this".to_string(),
            content_parts: vec![
                ContentPart::text("Look at this"),
                ContentPart::image("data:image/png;base64,..."),
            ],
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(image_message.has_multimodal_content());
        assert!(image_message.has_images());

        // Test with both image and text file
        let mixed_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze both".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze both"),
                ContentPart::image("data:image/png;base64,..."),
                ContentPart::text_file("config.json", r#"{"key": "value"}"#),
            ],
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(mixed_message.has_multimodal_content());
        assert!(mixed_message.has_images());

        // Test with PDF document
        let pdf_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze this PDF".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze this PDF"),
                ContentPart::pdf_document(
                    "report.pdf",
                    vec![PdfPage {
                        page_number: 1,
                        text: "Page 1 content".to_string(),
                        image: "data:image/png;base64,iVBORw0KG...".to_string(),
                    }],
                    None,
                ),
            ],
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(pdf_message.has_multimodal_content());
        assert!(!pdf_message.has_images()); // PDF pages contain images but not direct Image ContentParts
    }

    #[test]
    fn test_pdf_document_constructor() {
        let pages = vec![
            PdfPage {
                page_number: 1,
                text: "First page".to_string(),
                image: "data:image/png;base64,page1".to_string(),
            },
            PdfPage {
                page_number: 2,
                text: "Second page".to_string(),
                image: "data:image/png;base64,page2".to_string(),
            },
        ];

        let metadata = Some(PdfMetadata {
            title: Some("Test Document".to_string()),
            author: Some("Test Author".to_string()),
            created_at: Some("2024-01-01".to_string()),
            producer: None,
            subject: None,
            keywords: None,
        });

        let part = ContentPart::pdf_document("test.pdf", pages.clone(), metadata.clone());

        match part {
            ContentPart::PdfDocument {
                filename,
                pages: pdf_pages,
                total_pages,
                metadata: pdf_metadata,
            } => {
                assert_eq!(filename, "test.pdf");
                assert_eq!(total_pages, 2);
                assert_eq!(pdf_pages.len(), 2);
                assert_eq!(pdf_pages[0].page_number, 1);
                assert_eq!(pdf_pages[0].text, "First page");
                assert_eq!(pdf_pages[1].page_number, 2);
                assert_eq!(pdf_pages[1].text, "Second page");
                assert!(pdf_metadata.is_some());
                let meta = pdf_metadata.unwrap();
                assert_eq!(meta.title, Some("Test Document".to_string()));
                assert_eq!(meta.author, Some("Test Author".to_string()));
            }
            _ => panic!("Expected PdfDocument variant"),
        }
    }

    #[test]
    fn test_pdf_document_serialization_format() {
        let pages = vec![PdfPage {
            page_number: 1,
            text: "Test content".to_string(),
            image: "data:image/png;base64,test".to_string(),
        }];

        let part = ContentPart::pdf_document("document.pdf", pages, None);
        let json = serde_json::to_string(&part).unwrap();

        // Verify JSON structure (now using camelCase)
        assert!(json.contains(r#""type":"pdf_document""#));
        assert!(json.contains(r#""filename":"document.pdf""#));
        assert!(json.contains(r#""totalPages":1"#));
        assert!(json.contains(r#""pageNumber":1"#));
        assert!(json.contains(r#""text":"Test content""#));
    }

    #[test]
    fn test_pdf_document_deserialization() {
        // Test with camelCase (from frontend)
        let json = r#"{
            "type": "pdf_document",
            "filename": "test.pdf",
            "pages": [
                {
                    "pageNumber": 1,
                    "text": "Page 1",
                    "image": "data:image/png;base64,abc"
                }
            ],
            "totalPages": 1
        }"#;

        let part: ContentPart = serde_json::from_str(json).unwrap();

        match part {
            ContentPart::PdfDocument {
                filename,
                pages,
                total_pages,
                metadata,
            } => {
                assert_eq!(filename, "test.pdf");
                assert_eq!(total_pages, 1);
                assert_eq!(pages.len(), 1);
                assert_eq!(pages[0].page_number, 1);
                assert_eq!(pages[0].text, "Page 1");
                assert_eq!(pages[0].image, "data:image/png;base64,abc");
                assert!(metadata.is_none());
            }
            _ => panic!("Expected PdfDocument variant"),
        }
    }

    #[test]
    fn test_pdf_document_with_metadata_serialization() {
        let pages = vec![PdfPage {
            page_number: 1,
            text: "Content".to_string(),
            image: "data:image/png;base64,img".to_string(),
        }];

        let metadata = Some(PdfMetadata {
            title: Some("My Document".to_string()),
            author: Some("John Doe".to_string()),
            created_at: Some("2024-01-15".to_string()),
            producer: Some("PDF Generator".to_string()),
            subject: Some("Test Subject".to_string()),
            keywords: Some("test, pdf".to_string()),
        });

        let part = ContentPart::pdf_document("doc.pdf", pages, metadata);
        let json = serde_json::to_string(&part).unwrap();

        // Verify metadata is included (now using camelCase)
        assert!(json.contains(r#""title":"My Document""#));
        assert!(json.contains(r#""author":"John Doe""#));
        assert!(json.contains(r#""createdAt":"2024-01-15""#));

        // Deserialize and verify
        let deserialized: ContentPart = serde_json::from_str(&json).unwrap();
        assert_eq!(part, deserialized);
    }
}
