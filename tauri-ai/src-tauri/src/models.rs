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
    /// Optional workstudio binding (many conversations can map to one workstudio).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workstudio_id: Option<String>,
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
// New Provider-Model-Agent Architecture
// ============================================================================

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
    /// - When unset: default to 3 (runtime default).
    /// - When `general.manualTurnRetry=true`: automatic retries are disabled regardless of this value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempts: Option<u32>,
    /// Whether to allow reconnecting and resuming when a stream breaks after partial output.
    /// Default false to avoid duplicated output on providers that don't support resume.
    #[serde(default)]
    pub resume_partial_output: bool,
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
            max_images: None,
            thinking_budget_tokens: None,
            use_reasoning_effort: None,
            reinject_reasoning_content: false,
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

impl Default for Provider {
    fn default() -> Self {
        Self {
            name: String::new(),
            display_name: String::new(),
            provider_type: ProviderType::default(),
            api_base: String::new(),
            api_key: None,
            enabled: true,
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
            // Backward-compat: map deprecated kinds.
            "code" => Self::Tool,
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
    /// Model reference in format "provider_name/model_name"
    pub model_ref: String,
    /// System prompt for this agent
    #[serde(default)]
    pub system_prompt: String,
    /// Output format type
    #[serde(default)]
    pub format_type: FormatPromptType,
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
    /// - None: use default (Tool => true; others => false)
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
    /// - None：等价于 Disabled（不做自动 compact/裁剪）
    /// - Some(...)：启用对应策略（例如 NormalCompact）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_policy: Option<ContextPolicyConfig>,
}

impl Default for Agent {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            agent_type: AgentType::default(),
            display_name: String::new(),
            description: None,
            model_ref: String::new(),
            system_prompt: String::new(),
            format_type: FormatPromptType::default(),
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
    /// Disable all automatic context management (default).
    Disabled,
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
        Self::Disabled
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
    /// Turn-level automatic retry attempts (default: 3 when unset).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempts: Option<u32>,
    /// Whether to allow reconnecting and resuming when a stream breaks after partial output.
    /// Default false to avoid duplicated output on providers that don't support resume.
    #[serde(default)]
    pub resume_partial_output: bool,
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
    /// Tooling settings (toolsets)
    #[serde(default)]
    pub tools: ToolsSettings,
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
            tools: ToolsSettings::default(),
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
                max_images: None,
                thinking_budget_tokens: None,
                use_reasoning_effort: None,
                reinject_reasoning_content: false,
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
                model_ref,
                system_prompt: model_config
                    .parameters
                    .system_prompt
                    .clone()
                    .unwrap_or_default(),
                format_type: FormatPromptType::Chat,
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
