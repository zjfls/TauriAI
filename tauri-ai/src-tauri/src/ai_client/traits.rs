//! AI Client traits and common types

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;

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

/// Debug information for HTTP request/response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugInfoData {
    pub request: Option<DebugRequestData>,
    pub response: Option<DebugResponseData>,
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
    ) -> Result<String, AiError>;

    /// Send a chat request with streaming response
    async fn chat_stream(
        &self,
        messages: Vec<crate::models::Message>,
        config: &crate::models::ModelConfig,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError>;
}
