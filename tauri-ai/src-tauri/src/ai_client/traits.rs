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
    /// The stream completed successfully with the full content
    Done(String),
    /// An error occurred during streaming
    Error(String),
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
