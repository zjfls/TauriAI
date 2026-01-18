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
//!
//! ## Multimodal Support
//!
//! This client supports multimodal content (images, text files, PDF documents) through
//! the unified `content_converter` module. The Responses API supports images via data URLs
//! in the `content` field as typed `input_*` items:
//!
//! - **Images**: `{ type: "input_image", image_url: "data:image/png;base64,...", detail: "auto" }`
//! - **Text files**: Formatted as markdown code blocks with filename, sent as `input_text`
//! - **PDF documents**: Each page becomes `input_text` (+ `input_image` when vision enabled)
//!
//! The `vision_enabled` configuration controls whether image content is included.
//! When disabled, only text content is sent to the API.

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent, TokenUsage,
};
use super::content_converter::ContentBlock;
use crate::models::{ImageDetail, Message, MessageRole, ModelConfig};
use std::collections::HashMap;

// ============================================================================
// Request types
// ============================================================================

/// Input message for Responses API
#[derive(Debug, Serialize, PartialEq, Eq)]
struct ResponsesInput {
    role: String,
    content: ResponsesContent,
}

/// Responses API message content - either plain text or a list of typed inputs
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum ResponsesContent {
    Text(String),
    Parts(Vec<ResponsesContentPart>),
}

/// A single typed content item for Responses API
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ResponsesContentPart {
    InputText { text: String },
    InputImage { detail: ImageDetail, image_url: String },
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

/// Convert ContentBlocks to typed Responses API content parts.
///
/// # Conversion Rules
/// - **Text blocks** -> `input_text`
/// - **ImageUrl blocks** -> `input_image` (`image_url` preserved, including data URLs)
/// - **ImageBase64 blocks** -> `input_image` (reconstructed as data URL)
fn content_blocks_to_parts(blocks: Vec<ContentBlock>) -> Vec<ResponsesContentPart> {
    blocks
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text { text } => ResponsesContentPart::InputText { text },
            ContentBlock::ImageUrl { url, detail } => ResponsesContentPart::InputImage {
                detail,
                image_url: url,
            },
            ContentBlock::ImageBase64 {
                media_type,
                data,
                detail,
            } => ResponsesContentPart::InputImage {
                detail,
                image_url: format!("data:{};base64,{}", media_type, data),
            },
        })
        .collect()
}

/// Convert messages to Responses API input format
/// 
/// This function converts our internal Message format to the Responses API's
/// input format, handling multimodal content through the unified content_converter.
/// 
/// # Arguments
/// * `messages` - The messages to convert
/// * `system_prompt` - Optional system prompt from configuration
/// * `vision_enabled` - Whether to include image content (for vision-capable models)
/// 
/// # Returns
/// A tuple of (inputs, instructions) where:
/// - `inputs`: Vec of ResponsesInput for the API request
/// - `instructions`: Always None (we use `developer` role instead)
/// 
/// # Conversion Logic
/// - **System messages**: Collected and emitted as a single `developer` role message
/// - **User messages**: 
///   - Multimodal content: Converted via content_converter, then to typed `input_*` parts
///   - Plain text: Used directly
/// - **Assistant messages**: 
///   - Multimodal content: Only text parts extracted (API limitation)
///   - Plain text: Used directly
/// 
/// # Multimodal Handling
/// Uses `content_converter::content_part_to_blocks()` to convert ContentParts
/// to ContentBlocks, then converts to Responses API `input_text` / `input_image` items.
fn convert_messages(
    messages: &[Message],
    system_prompt: Option<&str>,
    vision_enabled: bool,
    max_images: Option<u32>,
) -> (Vec<ResponsesInput>, Option<String>) {
    let mut inputs = Vec::new();
    let mut developer_prompt = system_prompt.map(|s| s.to_string());

    for msg in messages {
        match msg.role {
            MessageRole::System => {
                // 系统消息收集为 developer prompt（Responses API 支持 developer role）
                if developer_prompt.is_none() {
                    developer_prompt = Some(msg.content.clone());
                } else if let Some(ref mut inst) = developer_prompt {
                    inst.push_str("\n\n");
                    inst.push_str(&msg.content);
                }
            }
            MessageRole::User => {
                // 检查消息是否包含多模态内容
                let content = if msg.has_multimodal_content() {
                    // 使用统一转换器（包含图片上限策略）将内容部分转换为 ContentBlocks
                    let parts = msg.get_content_parts();
                    use super::content_converter::content_parts_to_blocks_with_limit;
                    let (blocks, _pdf_images_skipped) =
                        content_parts_to_blocks_with_limit(&parts, vision_enabled, max_images);

                    ResponsesContent::Parts(content_blocks_to_parts(blocks))
                } else {
                    // 纯文本消息 - 直接使用 content 字段
                    ResponsesContent::Text(msg.content.clone())
                };

                inputs.push(ResponsesInput {
                    role: "user".to_string(),
                    content,
                });
            }
            MessageRole::Assistant => {
                // 对于助手消息，仅提取文本内容
                // （Responses API 不支持助手消息中的多模态内容）
                let content = if msg.has_multimodal_content() {
                    let parts = msg.get_content_parts();
                    
                    // 仅提取文本部分，跳过图片（vision_enabled=false）
                    let text_blocks: Vec<ContentBlock> = parts
                        .iter()
                        .flat_map(|part| {
                            super::content_converter::content_part_to_blocks(part, false)
                        })
                        .collect();
                    
                    ResponsesContent::Parts(content_blocks_to_parts(text_blocks))
                } else {
                    ResponsesContent::Text(msg.content.clone())
                };

                inputs.push(ResponsesInput {
                    role: "assistant".to_string(),
                    content,
                });
            }
        }
    }

    // 将 developer prompt 作为最高优先级消息放在输入数组最前面
    if let Some(prompt) = developer_prompt.filter(|s| !s.is_empty()) {
        inputs.insert(
            0,
            ResponsesInput {
                role: "developer".to_string(),
                content: ResponsesContent::Text(prompt),
            },
        );
    }

    // 保持向后兼容：不再使用 instructions 字段
    (inputs, None)
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

        let (inputs, instructions) = convert_messages(
            &messages,
            config.parameters.system_prompt.as_deref(),
            config.vision_enabled,
            config.max_images,
        );

        // Build reasoning config if thinking is enabled
        let reasoning = config.thinking_level.as_ref().and_then(|level| {
            if level == "disabled" {
                None
            } else {
                Some(ReasoningConfig {
                    effort: Some(level.clone()),
                    summary: Some("auto".to_string()),
                })
            }
        });

        let request = ResponsesRequest {
            model: config.model.clone(),
            input: inputs,
            instructions,
            temperature: Some(config.parameters.temperature),
            max_output_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            reasoning,
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

        let (inputs, instructions) = convert_messages(
            &messages,
            config.parameters.system_prompt.as_deref(),
            config.vision_enabled,
            config.max_images,
        );

        // Build reasoning config if thinking is enabled
        let reasoning = config.thinking_level.as_ref().and_then(|level| {
            if level == "disabled" {
                None
            } else {
                Some(ReasoningConfig {
                    effort: Some(level.clone()),
                    summary: Some("auto".to_string()),
                })
            }
        });

        let request = ResponsesRequest {
            model: config.model.clone(),
            input: inputs,
            instructions,
            temperature: Some(config.parameters.temperature),
            max_output_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            reasoning,
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
                    .send(StreamEvent::Error(error_response.error.message.clone()))
                    .await;
                let _ = token_sender
                    .send(StreamEvent::DoneWithDebug {
                        content: String::new(),
                        thinking: None,
                        debug_info: Some(debug_info),
                        usage: None,
                    })
                    .await;
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            let _ = token_sender
                .send(StreamEvent::Error(error_text.clone()))
                .await;
            let _ = token_sender
                .send(StreamEvent::DoneWithDebug {
                    content: String::new(),
                    thinking: None,
                    debug_info: Some(debug_info),
                    usage: None,
                })
                .await;
            return Err(AiError::RequestFailed(error_text));
        }

        let mut full_content = String::new();
        let mut full_thinking = String::new();
        let mut final_usage: Option<TokenUsage> = None;
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
                        let debug_usage = final_usage.as_ref().map(|u| {
                            serde_json::json!({
                                "prompt_tokens": u.prompt_tokens,
                                "completion_tokens": u.completion_tokens,
                                "total_tokens": u.total_tokens,
                                "cached_tokens": u.cached_tokens,
                                "reasoning_tokens": u.reasoning_tokens
                            })
                        });

                        // Build debug info with full content
                        let debug_response_body = serde_json::json!({
                            "_sseInfo": {
                                "chunkCount": chunk_count,
                                "note": "SSE stream response (Responses API)"
                            },
                            "content": full_content,
                            "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
                            "usage": debug_usage
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
                                thinking: if full_thinking.is_empty() { None } else { Some(full_thinking.clone()) },
                                debug_info: Some(debug_info),
                                usage: final_usage.clone(),
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
                                if let Some(delta) = event.delta.or(event.text) {
                                    full_content.push_str(&delta);
                                    let _ = token_sender.send(StreamEvent::Token(delta)).await;
                                }
                            }
                            "response.reasoning_text.delta"
                            | "response.reasoning_summary_text.delta"
                            | "response.reasoning.delta"
                            | "response.reasoning_summary.delta" => {
                                // Handle reasoning/thinking content
                                if let Some(delta) = event.delta.or(event.text) {
                                    full_thinking.push_str(&delta);
                                    let _ = token_sender.send(StreamEvent::Thinking(delta)).await;
                                }
                            }
                            "error" => {
                                let error_msg = serde_json::from_str::<serde_json::Value>(data)
                                    .ok()
                                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
                                    .or(event.delta)
                                    .unwrap_or_else(|| "Unknown error".to_string());
                                let _ = token_sender.send(StreamEvent::Error(error_msg.clone())).await;
                                return Err(AiError::StreamError(error_msg));
                            }
                            "response.failed" | "response.incomplete" => {
                                let error_msg = serde_json::from_str::<serde_json::Value>(data)
                                    .ok()
                                    .and_then(|v| {
                                        v.get("response")
                                            .and_then(|r| r.get("error"))
                                            .and_then(|e| e.get("message"))
                                            .and_then(|m| m.as_str())
                                            .map(|s| s.to_string())
                                    })
                                    .unwrap_or_else(|| "Response failed".to_string());
                                let _ = token_sender.send(StreamEvent::Error(error_msg.clone())).await;
                                return Err(AiError::StreamError(error_msg));
                            }
                            "response.completed" | "response.done" => {
                                // Capture usage from response.completed event (Responses API)
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(u) = v
                                        .get("response")
                                        .and_then(|r| r.get("usage"))
                                        .and_then(|u| u.as_object())
                                    {
                                        let input_tokens = u
                                            .get("input_tokens")
                                            .and_then(|v| v.as_u64())
                                            .map(|v| v as u32);
                                        let output_tokens = u
                                            .get("output_tokens")
                                            .and_then(|v| v.as_u64())
                                            .map(|v| v as u32);
                                        let total_tokens = u
                                            .get("total_tokens")
                                            .and_then(|v| v.as_u64())
                                            .map(|v| v as u32);
                                        if let (Some(prompt_tokens), Some(completion_tokens), Some(total_tokens)) =
                                            (input_tokens, output_tokens, total_tokens)
                                        {
                                            let cached_tokens = u
                                                .get("input_tokens_details")
                                                .and_then(|d| d.get("cached_tokens"))
                                                .and_then(|v| v.as_u64())
                                                .map(|v| v as u32);
                                            let reasoning_tokens = u
                                                .get("output_tokens_details")
                                                .and_then(|d| d.get("reasoning_tokens"))
                                                .and_then(|v| v.as_u64())
                                                .map(|v| v as u32);

                                            final_usage = Some(TokenUsage {
                                                prompt_tokens,
                                                completion_tokens,
                                                total_tokens,
                                                cached_tokens,
                                                reasoning_tokens,
                                                cache_creation_input_tokens: None,
                                                cache_read_input_tokens: None,
                                            });
                                        }
                                    }
                                }

                                let debug_usage = final_usage.as_ref().map(|u| {
                                    serde_json::json!({
                                        "prompt_tokens": u.prompt_tokens,
                                        "completion_tokens": u.completion_tokens,
                                        "total_tokens": u.total_tokens,
                                        "cached_tokens": u.cached_tokens,
                                        "reasoning_tokens": u.reasoning_tokens
                                    })
                                });

                                // Build debug info
                                let debug_response_body = serde_json::json!({
                                    "_sseInfo": {
                                        "chunkCount": chunk_count,
                                        "note": "SSE stream response (Responses API)"
                                    },
                                    "content": full_content,
                                    "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
                                    "usage": debug_usage
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
                                        thinking: if full_thinking.is_empty() { None } else { Some(full_thinking.clone()) },
                                        debug_info: Some(debug_info),
                                        usage: final_usage.clone(),
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

        let debug_usage = final_usage.as_ref().map(|u| {
            serde_json::json!({
                "prompt_tokens": u.prompt_tokens,
                "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens,
                "cached_tokens": u.cached_tokens,
                "reasoning_tokens": u.reasoning_tokens
            })
        });

        // Build debug info for stream end
        let debug_response_body = serde_json::json!({
            "_sseInfo": {
                "chunkCount": chunk_count,
                "note": "SSE stream response (Responses API)"
            },
            "content": full_content,
            "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
            "usage": debug_usage
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
                thinking: if full_thinking.is_empty() { None } else { Some(full_thinking) },
                debug_info: Some(debug_info),
                usage: final_usage,
            })
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ImageDetail, ContentPart, PdfPage, MessageStatus};
    use chrono::Utc;

    // Helper function to create a test message
    fn create_test_message(role: MessageRole, content: String, content_parts: Vec<ContentPart>) -> Message {
        Message {
            id: "test-id".to_string(),
            conversation_id: "test-conv".to_string(),
            role,
            content,
            content_parts,
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }
    }

    // ============================================================================
    // content_blocks_to_parts 函数的测试
    // ============================================================================

    #[test]
    /// 测试单个文本块的转换
    fn test_content_blocks_to_parts_single_text() {
        let blocks = vec![ContentBlock::Text {
            text: "Hello, world!".to_string(),
        }];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![ResponsesContentPart::InputText {
                text: "Hello, world!".to_string(),
            }]
        );
    }

    #[test]
    /// 测试多个文本块的转换（应该按顺序保留）
    fn test_content_blocks_to_parts_multiple_text() {
        let blocks = vec![
            ContentBlock::Text {
                text: "First paragraph".to_string(),
            },
            ContentBlock::Text {
                text: "Second paragraph".to_string(),
            },
        ];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![
                ResponsesContentPart::InputText {
                    text: "First paragraph".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "Second paragraph".to_string(),
                },
            ]
        );
    }

    #[test]
    /// 测试 HTTP URL 图片的转换（保留完整 URL）
    fn test_content_blocks_to_parts_image_url_http() {
        let blocks = vec![ContentBlock::ImageUrl {
            url: "https://example.com/image.png".to_string(),
            detail: ImageDetail::Auto,
        }];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![ResponsesContentPart::InputImage {
                detail: ImageDetail::Auto,
                image_url: "https://example.com/image.png".to_string(),
            }]
        );
    }

    #[test]
    /// 测试 data URL 图片的转换（保留完整 data URL）
    fn test_content_blocks_to_parts_image_url_data() {
        let blocks = vec![ContentBlock::ImageUrl {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA".to_string(),
            detail: ImageDetail::High,
        }];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![ResponsesContentPart::InputImage {
                detail: ImageDetail::High,
                image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA".to_string(),
            }]
        );
    }

    #[test]
    /// 测试 JPEG data URL 图片的转换（保留完整 data URL）
    fn test_content_blocks_to_parts_image_url_data_jpeg() {
        let blocks = vec![ContentBlock::ImageUrl {
            url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD".to_string(),
            detail: ImageDetail::Low,
        }];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![ResponsesContentPart::InputImage {
                detail: ImageDetail::Low,
                image_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD".to_string(),
            }]
        );
    }

    #[test]
    /// 测试 Base64 图片块的转换（重构为 data URL）
    fn test_content_blocks_to_parts_image_base64() {
        let blocks = vec![ContentBlock::ImageBase64 {
            media_type: "image/png".to_string(),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAUA".to_string(),
            detail: ImageDetail::Auto,
        }];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![ResponsesContentPart::InputImage {
                detail: ImageDetail::Auto,
                image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA".to_string(),
            }]
        );
    }

    #[test]
    /// 测试混合内容的转换（文本 + 图片 + 文本文件）
    fn test_content_blocks_to_parts_mixed_content() {
        let blocks = vec![
            ContentBlock::Text {
                text: "请分析这张图片：".to_string(),
            },
            ContentBlock::ImageUrl {
                url: "data:image/png;base64,abc123".to_string(),
                detail: ImageDetail::High,
            },
            ContentBlock::Text {
                text: "这是一个测试文件：".to_string(),
            },
            ContentBlock::Text {
                text: "📄 test.txt\n```\nHello World\n```".to_string(),
            },
        ];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![
                ResponsesContentPart::InputText {
                    text: "请分析这张图片：".to_string(),
                },
                ResponsesContentPart::InputImage {
                    detail: ImageDetail::High,
                    image_url: "data:image/png;base64,abc123".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "这是一个测试文件：".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "📄 test.txt\n```\nHello World\n```".to_string(),
                },
            ]
        );
    }

    #[test]
    /// 测试空内容块列表的转换
    fn test_content_blocks_to_parts_empty() {
        let blocks = vec![];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(result, vec![]);
    }

    #[test]
    /// 测试文本和 Base64 图片的混合转换
    fn test_content_blocks_to_parts_text_and_base64_image() {
        let blocks = vec![
            ContentBlock::Text {
                text: "这是文本内容".to_string(),
            },
            ContentBlock::ImageBase64 {
                media_type: "image/jpeg".to_string(),
                data: "base64data".to_string(),
                detail: ImageDetail::High,
            },
        ];
        let result = content_blocks_to_parts(blocks);
        assert_eq!(
            result,
            vec![
                ResponsesContentPart::InputText {
                    text: "这是文本内容".to_string(),
                },
                ResponsesContentPart::InputImage {
                    detail: ImageDetail::High,
                    image_url: "data:image/jpeg;base64,base64data".to_string(),
                },
            ]
        );
    }

    // ============================================================================
    // convert_messages 函数的多模态内容测试
    // ============================================================================

    #[test]
    /// 测试纯文本消息的转换
    fn test_convert_messages_plain_text() {
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "Hello, how are you?".to_string(),
                vec![],
            ),
        ];

        let (inputs, instructions) = convert_messages(&messages, None, true, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Text("Hello, how are you?".to_string())
        );
        assert!(instructions.is_none());
    }

    #[test]
    /// 测试启用视觉功能时单张图片的转换
    fn test_convert_messages_single_image_vision_enabled() {
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "分析这张图片".to_string(),
                vec![
                    ContentPart::text("分析这张图片"),
                    ContentPart::image("data:image/png;base64,abc123"),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, true, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![
                ResponsesContentPart::InputText {
                    text: "分析这张图片".to_string(),
                },
                ResponsesContentPart::InputImage {
                    detail: ImageDetail::Auto,
                    image_url: "data:image/png;base64,abc123".to_string(),
                },
            ])
        );
    }

    #[test]
    /// 测试禁用视觉功能时单张图片的转换（应跳过图片）
    fn test_convert_messages_single_image_vision_disabled() {
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "分析这张图片".to_string(),
                vec![
                    ContentPart::text("分析这张图片"),
                    ContentPart::image("data:image/png;base64,abc123"),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, false, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![ResponsesContentPart::InputText {
                text: "分析这张图片".to_string(),
            }])
        );
    }

    #[test]
    /// 测试文本文件的转换（应格式化为 markdown 代码块）
    fn test_convert_messages_text_file() {
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "请查看这个文件".to_string(),
                vec![
                    ContentPart::text("请查看这个文件"),
                    ContentPart::text_file("config.json", r#"{"key": "value"}"#),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, true, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![
                ResponsesContentPart::InputText {
                    text: "请查看这个文件".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "📄 config.json\n```\n{\"key\": \"value\"}\n```".to_string(),
                },
            ])
        );
    }

    #[test]
    /// 测试启用视觉功能时 PDF 文档的转换（包含文本和图片）
    fn test_convert_messages_pdf_document_vision_enabled() {
        let pages = vec![
            PdfPage {
                page_number: 1,
                text: "Page 1 content".to_string(),
                image: "data:image/png;base64,page1".to_string(),
            },
        ];
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "分析这个PDF".to_string(),
                vec![
                    ContentPart::text("分析这个PDF"),
                    ContentPart::pdf_document("report.pdf", pages, None),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, true, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![
                ResponsesContentPart::InputText {
                    text: "分析这个PDF".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "📄 report.pdf - 第1页\n```\nPage 1 content\n```".to_string(),
                },
                ResponsesContentPart::InputImage {
                    detail: ImageDetail::High,
                    image_url: "data:image/png;base64,page1".to_string(),
                },
            ])
        );
    }

    #[test]
    /// 测试禁用视觉功能时 PDF 文档的转换（仅包含文本，不包含图片）
    fn test_convert_messages_pdf_document_vision_disabled() {
        let pages = vec![
            PdfPage {
                page_number: 1,
                text: "Page 1 content".to_string(),
                image: "data:image/png;base64,page1".to_string(),
            },
        ];
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "分析这个PDF".to_string(),
                vec![
                    ContentPart::text("分析这个PDF"),
                    ContentPart::pdf_document("report.pdf", pages, None),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, false, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![
                ResponsesContentPart::InputText {
                    text: "分析这个PDF".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "📄 report.pdf - 第1页\n```\nPage 1 content\n```".to_string(),
                },
            ])
        );
    }

    #[test]
    /// 测试助手消息的多模态内容转换（应仅提取文本）
    fn test_convert_messages_assistant_multimodal_extracts_text_only() {
        let messages = vec![
            create_test_message(
                MessageRole::Assistant,
                "这是回复".to_string(),
                vec![
                    ContentPart::text("这是回复"),
                    ContentPart::image("data:image/png;base64,abc123"),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, true, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "assistant");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![ResponsesContentPart::InputText {
                text: "这是回复".to_string(),
            }])
        );
    }

    #[test]
    /// 测试系统提示词的处理（应转换为 instructions）
    fn test_convert_messages_system_prompt() {
        let messages = vec![
            create_test_message(
                MessageRole::System,
                "You are a helpful assistant.".to_string(),
                vec![],
            ),
            create_test_message(
                MessageRole::User,
                "Hello".to_string(),
                vec![],
            ),
        ];

        let (inputs, instructions) = convert_messages(&messages, None, true, None);

        assert!(instructions.is_none());

        // System message should be converted to a developer role message
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].role, "developer");
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Text("You are a helpful assistant.".to_string())
        );

        assert_eq!(inputs[1].role, "user");
        assert_eq!(
            inputs[1].content,
            ResponsesContent::Text("Hello".to_string())
        );
    }

    #[test]
    /// 测试混合内容的转换（文本 + 图片 + 文本文件）
    fn test_convert_messages_mixed_content() {
        let messages = vec![
            create_test_message(
                MessageRole::User,
                "请分析".to_string(),
                vec![
                    ContentPart::text("请分析"),
                    ContentPart::image("data:image/png;base64,img1"),
                    ContentPart::text_file("data.txt", "file content"),
                ],
            ),
        ];

        let (inputs, _) = convert_messages(&messages, None, true, None);

        assert_eq!(inputs.len(), 1);
        assert_eq!(
            inputs[0].content,
            ResponsesContent::Parts(vec![
                ResponsesContentPart::InputText {
                    text: "请分析".to_string(),
                },
                ResponsesContentPart::InputImage {
                    detail: ImageDetail::Auto,
                    image_url: "data:image/png;base64,img1".to_string(),
                },
                ResponsesContentPart::InputText {
                    text: "📄 data.txt\n```\nfile content\n```".to_string(),
                },
            ])
        );
    }
}
