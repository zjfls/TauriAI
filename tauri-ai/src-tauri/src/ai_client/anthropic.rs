//! Anthropic API client implementation

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent, TokenUsage,
};
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

/// Cache control for prompt caching
#[derive(Debug, Clone, Serialize)]
struct CacheControl {
    #[serde(rename = "type")]
    control_type: String,
}

/// System content block with optional cache control
#[derive(Debug, Serialize)]
struct SystemContent {
    #[serde(rename = "type")]
    content_type: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<CacheControl>,
}

/// Anthropic messages API request
#[derive(Debug, Serialize)]
struct MessagesRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<Vec<SystemContent>>,
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
#[allow(dead_code)]
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
    #[serde(default)]
    usage: Option<AnthropicUsage>,
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

/// Anthropic usage data
#[derive(Debug, Deserialize, Clone, Default)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
    #[serde(default)]
    cache_creation_input_tokens: Option<u32>,
    #[serde(default)]
    cache_read_input_tokens: Option<u32>,
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
    async fn chat(&self, messages: Vec<Message>, config: &ModelConfig) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.anthropic.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let anthropic_messages = convert_messages(&messages);

        // Extract system prompt from messages (System role messages) and config
        let mut system_parts: Vec<String> = Vec::new();
        for msg in &messages {
            if msg.role == MessageRole::System && !msg.content.is_empty() {
                system_parts.push(msg.content.clone());
            }
        }
        if let Some(config_prompt) = &config.parameters.system_prompt {
            if !config_prompt.is_empty() && !system_parts.iter().any(|p| p == config_prompt) {
                system_parts.push(config_prompt.clone());
            }
        }
        let system = if system_parts.is_empty() {
            None
        } else {
            Some(vec![SystemContent {
                content_type: "text".to_string(),
                text: system_parts.join("\n\n"),
                cache_control: Some(CacheControl {
                    control_type: "ephemeral".to_string(),
                }),
            }])
        };

        let request = MessagesRequest {
            model: config.model.clone(),
            messages: anthropic_messages,
            max_tokens: config.parameters.max_tokens.unwrap_or(4096),
            system,
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
            if let Ok(error_response) = serde_json::from_str::<AnthropicErrorResponse>(&error_text)
            {
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
            Err(AiError::InvalidResponse(
                "No content in response".to_string(),
            ))
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

        // Extract system prompt from messages (System role messages) and config
        // Anthropic API expects system prompt as a separate parameter, not in messages
        let mut system_parts: Vec<String> = Vec::new();

        // First add any System role messages from the conversation
        for msg in &messages {
            if msg.role == MessageRole::System && !msg.content.is_empty() {
                system_parts.push(msg.content.clone());
            }
        }

        // Then add system_prompt from config (if different from messages)
        if let Some(config_prompt) = &config.parameters.system_prompt {
            if !config_prompt.is_empty() && !system_parts.iter().any(|p| p == config_prompt) {
                system_parts.push(config_prompt.clone());
            }
        }

        // Combine all system content into Anthropic format
        let system = if system_parts.is_empty() {
            None
        } else {
            Some(vec![SystemContent {
                content_type: "text".to_string(),
                text: system_parts.join("\n\n"),
                cache_control: Some(CacheControl {
                    control_type: "ephemeral".to_string(),
                }),
            }])
        };

        let request = MessagesRequest {
            model: config.model.clone(),
            messages: anthropic_messages,
            max_tokens: config.parameters.max_tokens.unwrap_or(4096),
            system,
            temperature: Some(config.parameters.temperature),
            top_p: config.parameters.top_p,
            stream: true,
        };

        let url = format!("{api_base}/messages");

        // Capture request info for debug
        let debug_request = DebugRequestData {
            url: url.clone(),
            method: "POST".to_string(),
            headers: {
                let mut h = HashMap::new();
                h.insert(
                    "x-api-key".to_string(),
                    format!("{}...", &api_key[..8.min(api_key.len())]),
                );
                h.insert("anthropic-version".to_string(), "2023-06-01".to_string());
                h.insert("Content-Type".to_string(), "application/json".to_string());
                h
            },
            body: serde_json::to_value(&request).unwrap_or(serde_json::Value::Null),
        };

        let response = self
            .client
            .post(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        // Capture response info for debug
        let status_code = response.status().as_u16();
        let response_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<AnthropicErrorResponse>(&error_text)
            {
                let _ = token_sender
                    .send(StreamEvent::Error(error_response.error.message.clone()))
                    .await;
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            let _ = token_sender
                .send(StreamEvent::Error(error_text.clone()))
                .await;
            return Err(AiError::RequestFailed(error_text));
        }

        let mut full_content = String::new();
        let mut stream = response.bytes_stream();
        let mut token_usage: Option<TokenUsage> = None;

        // Store debug parts for later assembly
        // We'll build the final debug_info with full_content at the end

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| AiError::StreamError(e.to_string()))?;
            let chunk_str = String::from_utf8_lossy(&chunk);

            // Parse SSE events
            for line in chunk_str.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(event) = serde_json::from_str::<StreamingEvent>(data) {
                        match event {
                            StreamingEvent::MessageStart { message } => {
                                // Capture initial usage from message_start
                                if let Some(usage) = message.usage {
                                    token_usage = Some(TokenUsage {
                                        prompt_tokens: usage.input_tokens,
                                        completion_tokens: usage.output_tokens,
                                        total_tokens: usage.input_tokens + usage.output_tokens,
                                        cached_tokens: None,
                                        reasoning_tokens: None,
                                        cache_creation_input_tokens: usage
                                            .cache_creation_input_tokens,
                                        cache_read_input_tokens: usage.cache_read_input_tokens,
                                    });
                                }
                            }
                            StreamingEvent::ContentBlockDelta { delta } => {
                                if delta.delta_type == "text_delta" {
                                    if let Some(text) = delta.text {
                                        full_content.push_str(&text);
                                        let _ = token_sender.send(StreamEvent::Token(text)).await;
                                    }
                                }
                            }
                            StreamingEvent::MessageDelta { delta: _ } => {
                                // message_delta may contain updated output_tokens, but we'll use the final value
                                // For now we just continue; the usage from message_start is usually sufficient
                            }
                            StreamingEvent::MessageStop {} => {
                                // Build debug info with response content
                                let debug_info = DebugInfoData {
                                    request: Some(debug_request.clone()),
                                    response: Some(DebugResponseData {
                                        status: status_code,
                                        headers: response_headers.clone(),
                                        body: serde_json::json!({
                                            "content": full_content.clone(),
                                            "usage": token_usage.clone(),
                                        }),
                                    }),
                                };
                                let _ = token_sender
                                    .send(StreamEvent::DoneWithDebug {
                                        content: full_content.clone(),
                                        thinking: None,
                                        debug_info: Some(debug_info),
                                        usage: token_usage.clone(),
                                    })
                                    .await;
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

        // Fallback: stream ended without MessageStop event
        let debug_info = DebugInfoData {
            request: Some(debug_request),
            response: Some(DebugResponseData {
                status: status_code,
                headers: response_headers,
                body: serde_json::json!({
                    "content": full_content.clone(),
                    "usage": token_usage.clone(),
                }),
            }),
        };
        let _ = token_sender
            .send(StreamEvent::DoneWithDebug {
                content: full_content,
                thinking: None,
                debug_info: Some(debug_info),
                usage: token_usage,
            })
            .await;
        Ok(())
    }
}
