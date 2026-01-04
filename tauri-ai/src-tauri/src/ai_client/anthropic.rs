//! Anthropic API client implementation

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::traits::{AiClient, AiError, StreamEvent};
use crate::models::{Message, MessageRole, ModelConfig};

/// Anthropic API client
pub struct AnthropicClient {
    client: Client,
}

impl AnthropicClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl Default for AnthropicClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Anthropic message format
#[derive(Debug, Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

/// Anthropic messages API request
#[derive(Debug, Serialize)]
struct MessagesRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    stream: bool,
}


/// Anthropic messages API response (non-streaming)
#[derive(Debug, Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

/// Anthropic streaming event types
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum StreamingEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: MessageStartData },
    #[serde(rename = "content_block_start")]
    ContentBlockStart { content_block: ContentBlock },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: ContentDelta },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop {},
    #[serde(rename = "message_delta")]
    MessageDelta { delta: MessageDeltaData },
    #[serde(rename = "message_stop")]
    MessageStop {},
    #[serde(rename = "ping")]
    Ping {},
    #[serde(rename = "error")]
    Error { error: AnthropicErrorDetail },
}

#[derive(Debug, Deserialize)]
struct MessageStartData {
    #[allow(dead_code)]
    id: String,
}

#[derive(Debug, Deserialize)]
struct ContentDelta {
    #[serde(rename = "type")]
    delta_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MessageDeltaData {
    #[allow(dead_code)]
    stop_reason: Option<String>,
}

/// Anthropic error response
#[derive(Debug, Deserialize)]
struct AnthropicErrorResponse {
    error: AnthropicErrorDetail,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorDetail {
    message: String,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    error_type: Option<String>,
}


fn convert_messages(messages: &[Message]) -> Vec<AnthropicMessage> {
    messages
        .iter()
        .filter(|msg| msg.role != MessageRole::System)
        .map(|msg| {
            let role = match msg.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::System => "user", // Should not reach here due to filter
            };
            AnthropicMessage {
                role: role.to_string(),
                content: msg.content.clone(),
            }
        })
        .collect()
}

#[async_trait]
impl AiClient for AnthropicClient {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
    ) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.anthropic.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let anthropic_messages = convert_messages(&messages);

        let request = MessagesRequest {
            model: config.model.clone(),
            messages: anthropic_messages,
            max_tokens: config.parameters.max_tokens.unwrap_or(4096),
            system: config.parameters.system_prompt.clone(),
            temperature: Some(config.parameters.temperature),
            top_p: config.parameters.top_p,
            stream: false,
        };

        let response = self
            .client
            .post(format!("{api_base}/messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<AnthropicErrorResponse>(&error_text) {
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            return Err(AiError::RequestFailed(error_text));
        }

        let completion: MessagesResponse = response
            .json()
            .await
            .map_err(|e| AiError::InvalidResponse(e.to_string()))?;

        let content = completion
            .content
            .iter()
            .filter(|block| block.content_type == "text")
            .filter_map(|block| block.text.clone())
            .collect::<Vec<_>>()
            .join("");

        if content.is_empty() {
            Err(AiError::InvalidResponse("No content in response".to_string()))
        } else {
            Ok(content)
        }
    }


    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.anthropic.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let anthropic_messages = convert_messages(&messages);

        let request = MessagesRequest {
            model: config.model.clone(),
            messages: anthropic_messages,
            max_tokens: config.parameters.max_tokens.unwrap_or(4096),
            system: config.parameters.system_prompt.clone(),
            temperature: Some(config.parameters.temperature),
            top_p: config.parameters.top_p,
            stream: true,
        };

        let response = self
            .client
            .post(format!("{api_base}/messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<AnthropicErrorResponse>(&error_text) {
                let _ = token_sender
                    .send(StreamEvent::Error(error_response.error.message.clone()))
                    .await;
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            let _ = token_sender.send(StreamEvent::Error(error_text.clone())).await;
            return Err(AiError::RequestFailed(error_text));
        }

        let mut full_content = String::new();
        let mut stream = response.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| AiError::StreamError(e.to_string()))?;
            let chunk_str = String::from_utf8_lossy(&chunk);

            // Parse SSE events
            for line in chunk_str.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(event) = serde_json::from_str::<StreamingEvent>(data) {
                        match event {
                            StreamingEvent::ContentBlockDelta { delta } => {
                                if delta.delta_type == "text_delta" {
                                    if let Some(text) = delta.text {
                                        full_content.push_str(&text);
                                        let _ = token_sender.send(StreamEvent::Token(text)).await;
                                    }
                                }
                            }
                            StreamingEvent::MessageStop {} => {
                                let _ = token_sender.send(StreamEvent::Done(full_content.clone())).await;
                                return Ok(());
                            }
                            StreamingEvent::Error { error } => {
                                let _ = token_sender
                                    .send(StreamEvent::Error(error.message.clone()))
                                    .await;
                                return Err(AiError::StreamError(error.message));
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        let _ = token_sender.send(StreamEvent::Done(full_content)).await;
        Ok(())
    }
}
