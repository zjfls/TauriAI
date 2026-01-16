//! OpenAI Responses API client implementation
//!
//! This module provides a client for OpenAI's new Responses API (`/v1/responses`),
//! which is designed for reasoning models like o1, o3, and gpt-4.1.
//!
//! Key differences from Chat Completions API:
//! - Uses `/v1/responses` endpoint instead of `/v1/chat/completions`
//! - Input format uses `input` array instead of `messages`
//! - Response format uses `output` array with typed items
//! - Supports reasoning configuration for thinking models

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent,
};
use crate::models::{Message, MessageRole, ModelConfig};
use std::collections::HashMap;

// ============================================================================
// Request types
// ============================================================================

/// Input message for Responses API
#[derive(Debug, Serialize)]
struct ResponsesInput {
    role: String,
    content: String,
}

/// Reasoning configuration for thinking models
#[derive(Debug, Serialize)]
struct ReasoningConfig {
    /// Effort level: "low", "medium", or "high"
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    /// Whether to return reasoning summary: "auto" or null
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

/// OpenAI Responses API request
#[derive(Debug, Serialize)]
struct ResponsesRequest {
    model: String,
    input: Vec<ResponsesInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ReasoningConfig>,
    stream: bool,
}

// ============================================================================
// Response types (non-streaming)
// ============================================================================

/// OpenAI Responses API response
#[derive(Debug, Deserialize)]
struct ResponsesResponse {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    status: String,
    output: Vec<OutputItem>,
}

/// Output item in response
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum OutputItem {
    #[serde(rename = "message")]
    Message(MessageOutput),
    #[serde(rename = "reasoning")]
    Reasoning(ReasoningOutput),
    #[serde(other)]
    Other,
}

/// Message output item
#[derive(Debug, Deserialize)]
struct MessageOutput {
    #[allow(dead_code)]
    role: String,
    content: Vec<ContentItem>,
}

/// Reasoning output item
#[derive(Debug, Deserialize)]
struct ReasoningOutput {
    #[serde(default)]
    summary: Vec<SummaryItem>,
}

/// Content item in message
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ContentItem {
    #[serde(rename = "output_text")]
    OutputText { text: String },
    #[serde(other)]
    Other,
}

/// Summary item in reasoning
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum SummaryItem {
    #[serde(rename = "summary_text")]
    SummaryText { text: String },
    #[serde(other)]
    Other,
}

// ============================================================================
// Streaming response types
// ============================================================================

/// Streaming event from Responses API
#[derive(Debug, Deserialize)]
struct StreamingEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

/// Error response
#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
struct ErrorDetail {
    message: String,
}

// ============================================================================
// Helper functions
// ============================================================================

fn convert_messages(
    messages: &[Message],
    system_prompt: Option<&str>,
) -> (Vec<ResponsesInput>, Option<String>) {
    let mut inputs = Vec::new();
    let mut instructions = system_prompt.map(|s| s.to_string());

    for msg in messages {
        match msg.role {
            MessageRole::System => {
                // System messages become instructions
                if instructions.is_none() {
                    instructions = Some(msg.content.clone());
                } else {
                    // Append to existing instructions
                    if let Some(ref mut inst) = instructions {
                        inst.push_str("\n\n");
                        inst.push_str(&msg.content);
                    }
                }
            }
            MessageRole::User => {
                inputs.push(ResponsesInput {
                    role: "user".to_string(),
                    content: msg.content.clone(),
                });
            }
            MessageRole::Assistant => {
                inputs.push(ResponsesInput {
                    role: "assistant".to_string(),
                    content: msg.content.clone(),
                });
            }
        }
    }

    (inputs, instructions)
}

// ============================================================================
// OpenAI Responses Client
// ============================================================================

/// OpenAI Responses API client
/// Uses the new `/v1/responses` endpoint for reasoning models
pub struct OpenAiResponsesClient {
    client: Client,
}

impl OpenAiResponsesClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl Default for OpenAiResponsesClient {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AiClient for OpenAiResponsesClient {
    async fn chat(&self, messages: Vec<Message>, config: &ModelConfig) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.openai.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let (inputs, instructions) =
            convert_messages(&messages, config.parameters.system_prompt.as_deref());

        let request = ResponsesRequest {
            model: config.model.clone(),
            input: inputs,
            instructions,
            temperature: Some(config.parameters.temperature),
            max_output_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            reasoning: None, // Can be configured later
            stream: false,
        };

        let response = self
            .client
            .post(format!("{api_base}/responses"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<ErrorResponse>(&error_text) {
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            return Err(AiError::RequestFailed(error_text));
        }

        let responses_response: ResponsesResponse = response
            .json()
            .await
            .map_err(|e| AiError::InvalidResponse(e.to_string()))?;

        // Extract text from output
        let mut result = String::new();
        for item in responses_response.output {
            match item {
                OutputItem::Message(msg) => {
                    for content in msg.content {
                        if let ContentItem::OutputText { text } = content {
                            result.push_str(&text);
                        }
                    }
                }
                OutputItem::Reasoning(reasoning) => {
                    // Optionally include reasoning summary
                    for summary in reasoning.summary {
                        if let SummaryItem::SummaryText { text } = summary {
                            result.push_str("[Reasoning: ");
                            result.push_str(&text);
                            result.push_str("]\n\n");
                        }
                    }
                }
                OutputItem::Other => {}
            }
        }

        if result.is_empty() {
            return Err(AiError::InvalidResponse(
                "No content in response".to_string(),
            ));
        }

        Ok(result)
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
            .unwrap_or("https://api.openai.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let (inputs, instructions) =
            convert_messages(&messages, config.parameters.system_prompt.as_deref());

        let request = ResponsesRequest {
            model: config.model.clone(),
            input: inputs,
            instructions,
            temperature: Some(config.parameters.temperature),
            max_output_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            reasoning: None,
            stream: true,
        };

        let url = format!("{api_base}/responses");

        // Capture request info for debug
        let debug_request = DebugRequestData {
            url: url.clone(),
            method: "POST".to_string(),
            headers: {
                let mut h = HashMap::new();
                h.insert("Authorization".to_string(), format!("Bearer {api_key}"));
                h.insert("Content-Type".to_string(), "application/json".to_string());
                h
            },
            body: serde_json::to_value(&request).unwrap_or(serde_json::Value::Null),
        };

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        // Capture response status and headers
        let response_status = response.status().as_u16();
        let response_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();

            // Build debug info for error case
            let debug_info = DebugInfoData {
                request: Some(debug_request),
                response: Some(DebugResponseData {
                    status: response_status,
                    headers: response_headers,
                    body: serde_json::from_str(&error_text)
                        .unwrap_or(serde_json::Value::String(error_text.clone())),
                }),
            };

            if let Ok(error_response) = serde_json::from_str::<ErrorResponse>(&error_text) {
                let _ = token_sender
                    .send(StreamEvent::DoneWithDebug {
                        content: String::new(),
                        thinking: None,
                        debug_info: Some(debug_info),
                        usage: None,
                    })
                    .await;
                let _ = token_sender
                    .send(StreamEvent::Error(error_response.error.message.clone()))
                    .await;
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            let _ = token_sender
                .send(StreamEvent::DoneWithDebug {
                    content: String::new(),
                    thinking: None,
                    debug_info: Some(debug_info.clone()),
                    usage: None,
                })
                .await;
            let _ = token_sender
                .send(StreamEvent::Error(error_text.clone()))
                .await;
            return Err(AiError::RequestFailed(error_text));
        }

        let mut full_content = String::new();
        let mut stream = response.bytes_stream();
        let mut chunk_count = 0;

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| AiError::StreamError(e.to_string()))?;
            let chunk_str = String::from_utf8_lossy(&chunk);
            chunk_count += 1;

            // Parse SSE events
            for line in chunk_str.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if data.trim() == "[DONE]" {
                        // Build debug info with full content
                        let debug_response_body = serde_json::json!({
                            "_sseInfo": {
                                "chunkCount": chunk_count,
                                "note": "SSE stream response (Responses API)"
                            },
                            "content": full_content,
                            "thinking": serde_json::Value::Null,
                            "usage": serde_json::Value::Null
                        });

                        let debug_info = DebugInfoData {
                            request: Some(debug_request.clone()),
                            response: Some(DebugResponseData {
                                status: response_status,
                                headers: response_headers.clone(),
                                body: debug_response_body,
                            }),
                        };

                        let _ = token_sender
                            .send(StreamEvent::DoneWithDebug {
                                content: full_content.clone(),
                                thinking: None,
                                debug_info: Some(debug_info),
                                usage: None,
                            })
                            .await;
                        return Ok(());
                    }

                    if let Ok(event) = serde_json::from_str::<StreamingEvent>(data) {
                        // Handle different event types
                        match event.event_type.as_str() {
                            "response.output_text.delta" => {
                                if let Some(delta) = event.delta {
                                    full_content.push_str(&delta);
                                    let _ = token_sender.send(StreamEvent::Token(delta)).await;
                                }
                            }
                            "response.text.delta" => {
                                if let Some(text) = event.text {
                                    full_content.push_str(&text);
                                    let _ = token_sender.send(StreamEvent::Token(text)).await;
                                }
                            }
                            "response.error" => {
                                let error_msg =
                                    event.delta.unwrap_or_else(|| "Unknown error".to_string());
                                let _ = token_sender
                                    .send(StreamEvent::Error(error_msg.clone()))
                                    .await;
                                return Err(AiError::StreamError(error_msg));
                            }
                            "response.completed" | "response.done" => {
                                // Build debug info
                                let debug_response_body = serde_json::json!({
                                    "_sseInfo": {
                                        "chunkCount": chunk_count,
                                        "note": "SSE stream response (Responses API)"
                                    },
                                    "content": full_content,
                                    "thinking": serde_json::Value::Null,
                                    "usage": serde_json::Value::Null
                                });

                                let debug_info = DebugInfoData {
                                    request: Some(debug_request.clone()),
                                    response: Some(DebugResponseData {
                                        status: response_status,
                                        headers: response_headers.clone(),
                                        body: debug_response_body,
                                    }),
                                };

                                let _ = token_sender
                                    .send(StreamEvent::DoneWithDebug {
                                        content: full_content.clone(),
                                        thinking: None,
                                        debug_info: Some(debug_info),
                                        usage: None,
                                    })
                                    .await;
                                return Ok(());
                            }
                            _ => {
                                // Ignore other event types
                            }
                        }
                    }
                }
            }
        }

        // Build debug info for stream end
        let debug_response_body = serde_json::json!({
            "_sseInfo": {
                "chunkCount": chunk_count,
                "note": "SSE stream response (Responses API)"
            },
            "content": full_content,
            "thinking": serde_json::Value::Null,
            "usage": serde_json::Value::Null
        });

        let debug_info = DebugInfoData {
            request: Some(debug_request),
            response: Some(DebugResponseData {
                status: response_status,
                headers: response_headers,
                body: debug_response_body,
            }),
        };

        let _ = token_sender
            .send(StreamEvent::DoneWithDebug {
                content: full_content,
                thinking: None,
                debug_info: Some(debug_info),
                usage: None,
            })
            .await;
        Ok(())
    }
}
