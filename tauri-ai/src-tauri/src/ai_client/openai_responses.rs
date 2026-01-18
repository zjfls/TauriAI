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
//! in the `content` field:
//!
//! - **Images**: Included as full data URLs (e.g., "data:image/png;base64,...")
//! - **Text files**: Formatted as markdown code blocks with filename
//! - **PDF documents**: Each page becomes text + image data URL
//!
//! The `vision_enabled` configuration controls whether image content is included.
//! When disabled, only text content is sent to the API.

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent,
};
use super::content_converter::ContentBlock;
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

/// Convert ContentBlocks to text format for Responses API
/// 
/// The Responses API supports multimodal content including images via data URLs.
/// This function converts ContentBlocks to a format suitable for the API.
/// 
/// # Arguments
/// * `blocks` - The content blocks to convert
/// 
/// # Returns
/// A single string with all blocks joined by double newlines
/// 
/// # Conversion Rules
/// - **Text blocks**: Included as-is
/// - **ImageUrl blocks**: 
///   - Data URLs: Included as-is (full data URL preserved for API)
///   - HTTP URLs: Included as-is
/// - **ImageBase64 blocks**: Reconstructed as data URL format
fn content_blocks_to_text(blocks: Vec<ContentBlock>) -> String {
    blocks
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text,
            ContentBlock::ImageUrl { url, .. } => {
                // Responses API supports data URLs directly
                // Keep the full URL (both data URLs and HTTP URLs)
                url
            }
            ContentBlock::ImageBase64 { media_type, data, .. } => {
                // Reconstruct as data URL for Responses API
                format!("data:{};base64,{}", media_type, data)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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
/// - `instructions`: Optional combined system instructions
/// 
/// # Conversion Logic
/// - **System messages**: Converted to `instructions` field (not in input array)
/// - **User messages**: 
///   - Multimodal content: Converted via content_converter, then to text
///   - Plain text: Used directly
/// - **Assistant messages**: 
///   - Multimodal content: Only text parts extracted (API limitation)
///   - Plain text: Used directly
/// 
/// # Multimodal Handling
/// Uses `content_converter::content_part_to_blocks()` to convert ContentParts
/// to ContentBlocks, then `content_blocks_to_text()` to convert to plain text
/// suitable for the Responses API.
fn convert_messages(
    messages: &[Message],
    system_prompt: Option<&str>,
    vision_enabled: bool,
) -> (Vec<ResponsesInput>, Option<String>) {
    let mut inputs = Vec::new();
    let mut instructions = system_prompt.map(|s| s.to_string());

    for msg in messages {
        match msg.role {
            MessageRole::System => {
                // 系统消息转换为 instructions
                if instructions.is_none() {
                    instructions = Some(msg.content.clone());
                } else {
                    // 追加到现有的 instructions
                    if let Some(ref mut inst) = instructions {
                        inst.push_str("\n\n");
                        inst.push_str(&msg.content);
                    }
                }
            }
            MessageRole::User => {
                // 检查消息是否包含多模态内容
                let content = if msg.has_multimodal_content() {
                    // 获取所有内容部分
                    let parts = msg.get_content_parts();
                    
                    // 使用统一的 content_converter 将每个部分转换为 ContentBlocks
                    // vision_enabled 控制是否包含图片内容
                    let blocks: Vec<ContentBlock> = parts
                        .iter()
                        .flat_map(|part| {
                            super::content_converter::content_part_to_blocks(part, vision_enabled)
                        })
                        .collect();
                    
                    // 将 ContentBlocks 转换为 Responses API 所需的纯文本格式
                    content_blocks_to_text(blocks)
                } else {
                    // 纯文本消息 - 直接使用 content 字段
                    msg.content.clone()
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
                    
                    content_blocks_to_text(text_blocks)
                } else {
                    msg.content.clone()
                };

                inputs.push(ResponsesInput {
                    role: "assistant".to_string(),
                    content,
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
            convert_messages(&messages, config.parameters.system_prompt.as_deref(), config.vision_enabled);

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

        let (inputs, instructions) =
            convert_messages(&messages, config.parameters.system_prompt.as_deref(), config.vision_enabled);

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
        let mut full_thinking = String::new();
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
                            "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
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
                                thinking: if full_thinking.is_empty() { None } else { Some(full_thinking.clone()) },
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
                            "response.reasoning.delta" | "response.reasoning_summary.delta" => {
                                // Handle reasoning/thinking content
                                if let Some(delta) = event.delta {
                                    full_thinking.push_str(&delta);
                                    let _ = token_sender.send(StreamEvent::Thinking(delta)).await;
                                } else if let Some(text) = event.text {
                                    full_thinking.push_str(&text);
                                    let _ = token_sender.send(StreamEvent::Thinking(text)).await;
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
                                    "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
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
                                        thinking: if full_thinking.is_empty() { None } else { Some(full_thinking.clone()) },
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
            "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
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
                thinking: if full_thinking.is_empty() { None } else { Some(full_thinking) },
                debug_info: Some(debug_info),
                usage: None,
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
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }
    }

    // ============================================================================
    // content_blocks_to_text 函数的测试
    // ============================================================================

    #[test]
    /// 测试单个文本块的转换
    fn test_content_blocks_to_text_single_text() {
        let blocks = vec![ContentBlock::Text {
            text: "Hello, world!".to_string(),
        }];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "Hello, world!");
    }

    #[test]
    /// 测试多个文本块的转换（应该用双换行符连接）
    fn test_content_blocks_to_text_multiple_text() {
        let blocks = vec![
            ContentBlock::Text {
                text: "First paragraph".to_string(),
            },
            ContentBlock::Text {
                text: "Second paragraph".to_string(),
            },
        ];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "First paragraph\n\nSecond paragraph");
    }

    #[test]
    /// 测试 HTTP URL 图片的转换（保留完整 URL）
    fn test_content_blocks_to_text_image_url_http() {
        let blocks = vec![ContentBlock::ImageUrl {
            url: "https://example.com/image.png".to_string(),
            detail: ImageDetail::Auto,
        }];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "https://example.com/image.png");
    }

    #[test]
    /// 测试 data URL 图片的转换（保留完整 data URL）
    fn test_content_blocks_to_text_image_url_data() {
        let blocks = vec![ContentBlock::ImageUrl {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA".to_string(),
            detail: ImageDetail::High,
        }];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA");
    }

    #[test]
    /// 测试 JPEG data URL 图片的转换（保留完整 data URL）
    fn test_content_blocks_to_text_image_url_data_jpeg() {
        let blocks = vec![ContentBlock::ImageUrl {
            url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD".to_string(),
            detail: ImageDetail::Low,
        }];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD");
    }

    #[test]
    /// 测试 Base64 图片块的转换（重构为 data URL）
    fn test_content_blocks_to_text_image_base64() {
        let blocks = vec![ContentBlock::ImageBase64 {
            media_type: "image/png".to_string(),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAUA".to_string(),
            detail: ImageDetail::Auto,
        }];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA");
    }

    #[test]
    /// 测试混合内容的转换（文本 + 图片 + 文本文件）
    fn test_content_blocks_to_text_mixed_content() {
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
        let result = content_blocks_to_text(blocks);
        assert_eq!(
            result,
            "请分析这张图片：\n\ndata:image/png;base64,abc123\n\n这是一个测试文件：\n\n📄 test.txt\n```\nHello World\n```"
        );
    }

    #[test]
    /// 测试空内容块列表的转换
    fn test_content_blocks_to_text_empty() {
        let blocks = vec![];
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "");
    }

    #[test]
    /// 测试文本和 Base64 图片的混合转换
    fn test_content_blocks_to_text_text_and_base64_image() {
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
        let result = content_blocks_to_text(blocks);
        assert_eq!(result, "这是文本内容\n\ndata:image/jpeg;base64,base64data");
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

        let (inputs, instructions) = convert_messages(&messages, None, true);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        assert_eq!(inputs[0].content, "Hello, how are you?");
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

        let (inputs, _) = convert_messages(&messages, None, true);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        // Should contain both text and full image data URL
        assert!(inputs[0].content.contains("分析这张图片"));
        assert!(inputs[0].content.contains("data:image/png;base64,abc123"));
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

        let (inputs, _) = convert_messages(&messages, None, false);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        // Should only contain text, no image
        assert_eq!(inputs[0].content, "分析这张图片");
        assert!(!inputs[0].content.contains("[图片"));
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

        let (inputs, _) = convert_messages(&messages, None, true);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        // Should contain text and formatted file content
        assert!(inputs[0].content.contains("请查看这个文件"));
        assert!(inputs[0].content.contains("📄 config.json"));
        assert!(inputs[0].content.contains(r#"{"key": "value"}"#));
        assert!(inputs[0].content.contains("```"));
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

        let (inputs, _) = convert_messages(&messages, None, true);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        // Should contain text, PDF page text, and full PDF page image data URL
        assert!(inputs[0].content.contains("分析这个PDF"));
        assert!(inputs[0].content.contains("📄 report.pdf - 第1页"));
        assert!(inputs[0].content.contains("Page 1 content"));
        // Image should be included as full data URL
        assert!(inputs[0].content.contains("data:image/png;base64,page1"));
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

        let (inputs, _) = convert_messages(&messages, None, false);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        // Should contain text and PDF page text, but NOT PDF page image
        assert!(inputs[0].content.contains("分析这个PDF"));
        assert!(inputs[0].content.contains("📄 report.pdf - 第1页"));
        assert!(inputs[0].content.contains("Page 1 content"));
        assert!(!inputs[0].content.contains("data:image/png;base64,page1"));
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

        let (inputs, _) = convert_messages(&messages, None, true);

        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "assistant");
        // Assistant messages should only contain text, even with vision_enabled=true
        assert_eq!(inputs[0].content, "这是回复");
        assert!(!inputs[0].content.contains("data:image"));
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

        let (inputs, instructions) = convert_messages(&messages, None, true);

        // System message should not be in inputs
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].role, "user");
        
        // System message should be in instructions
        assert!(instructions.is_some());
        assert_eq!(instructions.unwrap(), "You are a helpful assistant.");
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

        let (inputs, _) = convert_messages(&messages, None, true);

        assert_eq!(inputs.len(), 1);
        // Should contain all parts with full data URL
        assert!(inputs[0].content.contains("请分析"));
        assert!(inputs[0].content.contains("data:image/png;base64,img1"));
        assert!(inputs[0].content.contains("📄 data.txt"));
        assert!(inputs[0].content.contains("file content"));
    }
}
