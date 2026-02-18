//! AI Client traits and common types

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;

/// Streaming options (runtime-only; not persisted).
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    /// Provider-specific resume token/state used for stream reconnection.
    /// When set, the client may attach it to the next request (e.g. `x-codex-turn-state`).
    pub resume_state: Option<String>,
}

/// Tool definition (function-calling compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON schema for arguments (OpenAI style)
    pub parameters: serde_json::Value,
}

/// A tool call requested by the model
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// Tool call id (OpenAI: `tool_call_id`)
    pub id: String,
    pub name: String,
    /// JSON string arguments (OpenAI: `function.arguments`)
    pub arguments: String,
}

/// Errors that can occur during AI client operations
#[derive(Debug, Error)]
pub enum AiError {
    #[error("API request failed: {0}")]
    RequestFailed(String),

    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    #[error("Stream error: {0}")]
    StreamError(String),

    #[error("Connection error: {0}")]
    ConnectionError(String),

    #[error("Rate limited: {0}")]
    RateLimited(String),
}

/// Events emitted during streaming responses
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamEvent {
    /// A token was received
    Token(String),
    /// A thinking/reasoning token was received (for models like DeepSeek-R1)
    Thinking(String),
    /// The stream completed successfully with the full content
    Done(String),
    /// The stream completed with both thinking and content
    DoneWithThinking { content: String, thinking: String },
    /// The stream completed with debug info and usage
    DoneWithDebug {
        content: String,
        thinking: Option<String>,
        debug_info: Option<DebugInfoData>,
        usage: Option<TokenUsage>,
    },
    /// The model requested tool calls (turn should continue after executing tools)
    ToolCalls(Vec<ToolCall>),
    /// Provider-native web search tool call update (e.g., OpenAI `web_search_preview`)
    WebSearch {
        /// Tool call / output item id
        id: String,
        /// Status: `in_progress` | `searching` | `completed` | `failed`
        status: String,
        /// Optional action payload (query/sources/open_page/find, etc.)
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<serde_json::Value>,
    },
    /// Provider-specific stream resume state (if supported).
    /// Runtime uses it to reconnect without re-emitting already-streamed deltas.
    TurnState(String),
    /// An error occurred during streaming
    Error(String),
}

/// Token usage statistics
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    /// Cached tokens (OpenAI prompt caching)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u32>,
    /// Reasoning tokens (for o1 models)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,
    /// Cache creation input tokens (Anthropic)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    /// Cache read input tokens (Anthropic)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
}

/// Source of stream termination for provider protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamTerminationSource {
    /// Received explicit protocol-level completion marker/event.
    ProtocolSignal,
    /// Underlying stream ended (EOF) before explicit completion marker.
    EofFallback,
    /// Request failed at HTTP layer before a streaming completion marker.
    HttpError,
    /// Stream terminated due to local/user abort.
    Aborted,
    /// Unknown termination source.
    Unknown,
}

/// Protocol-level stream completion diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamTerminationInfo {
    /// Whether provider protocol completed explicitly (e.g. [DONE], message_stop, done=true).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_complete: Option<bool>,
    /// Where completion result comes from (explicit marker vs EOF fallback, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub termination_source: Option<StreamTerminationSource>,
    /// Protocol family (e.g. sse_marker, sse_event, ndjson_field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_kind: Option<String>,
    /// Expected completion signal for this provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_signal: Option<String>,
    /// Observed completion signal if detected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_signal: Option<String>,
    /// Last parsed provider event type (if available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_type: Option<String>,
    /// Number of received stream chunks (for diagnostics).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_count: Option<u32>,
}

/// Debug information for HTTP request/response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugInfoData {
    pub request: Option<DebugRequestData>,
    pub response: Option<DebugResponseData>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "streamTermination")]
    pub stream_termination: Option<StreamTerminationInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugRequestData {
    pub url: String,
    pub method: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugResponseData {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: serde_json::Value,
}

/// Trait for AI client implementations
#[async_trait]
pub trait AiClient: Send + Sync {
    /// Send a chat request and get a complete response
    async fn chat(
        &self,
        messages: Vec<crate::models::Message>,
        config: &crate::models::ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
    ) -> Result<String, AiError>;

    /// Send a chat request with streaming response
    async fn chat_stream(
        &self,
        messages: Vec<crate::models::Message>,
        config: &crate::models::ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
        token_sender: mpsc::Sender<StreamEvent>,
        options: StreamOptions,
    ) -> Result<(), AiError>;
}
