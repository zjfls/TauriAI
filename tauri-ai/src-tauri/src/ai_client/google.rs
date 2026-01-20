//! Google Gemini API client implementation

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

use super::content_converter::{content_parts_to_blocks_with_limit, parse_data_url, ContentBlock};
use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent, TokenUsage,
    ToolDefinition,
};
use crate::models::{Message, MessageRole, ModelConfig};

/// Google Gemini API client
pub struct GoogleClient {
    client: Client,
}

impl GoogleClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl Default for GoogleClient {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Request Types
// ============================================================================

/// Google Gemini content structure
#[derive(Debug, Clone, Serialize)]
struct GeminiContent {
    role: String,
    parts: Vec<GeminiPart>,
}

/// Google Gemini part - can be text or image
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
enum GeminiPart {
    /// Text content
    Text { text: String },
    /// Inline image data (base64)
    InlineData { inline_data: InlineData },
}

/// Inline data for images
#[derive(Debug, Clone, Serialize)]
struct InlineData {
    mime_type: String,
    data: String,
}

/// System instruction for Gemini
#[derive(Debug, Clone, Serialize)]
struct SystemInstruction {
    parts: Vec<GeminiPart>,
}

/// Thinking configuration for Gemini 3.0+
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingConfig {
    /// Thinking level: "MINIMAL", "LOW", "MEDIUM", "HIGH"
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_level: Option<String>,
    /// Include thought summaries in response
    #[serde(skip_serializing_if = "Option::is_none")]
    include_thoughts: Option<bool>,
}

/// Generation configuration
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    /// Thinking configuration for Gemini 3.0+ models
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_config: Option<ThinkingConfig>,
}

/// Generate content request
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateContentRequest {
    contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<SystemInstruction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
}

// ============================================================================
// Response Types
// ============================================================================

/// Generate content response (non-streaming)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateContentResponse {
    candidates: Option<Vec<Candidate>>,
    usage_metadata: Option<UsageMetadata>,
}

/// Response candidate
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    content: Option<CandidateContent>,
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

/// Candidate content
#[derive(Debug, Deserialize)]
struct CandidateContent {
    parts: Option<Vec<ResponsePart>>,
    #[allow(dead_code)]
    role: Option<String>,
}

/// Response part
#[derive(Debug, Deserialize)]
struct ResponsePart {
    text: Option<String>,
    /// If true, this part contains thought/reasoning content
    #[serde(default)]
    thought: bool,
}

/// Usage metadata
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageMetadata {
    #[serde(default)]
    prompt_token_count: u32,
    #[serde(default)]
    candidates_token_count: u32,
    #[serde(default)]
    total_token_count: u32,
    #[serde(default)]
    cached_content_token_count: Option<u32>,
    #[serde(default)]
    thoughts_token_count: Option<u32>,
}

/// Streaming response chunk
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunk {
    candidates: Option<Vec<Candidate>>,
    usage_metadata: Option<UsageMetadata>,
}

/// Google API error response
#[derive(Debug, Deserialize)]
struct GoogleErrorResponse {
    error: GoogleErrorDetail,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorDetail {
    message: String,
    #[allow(dead_code)]
    code: Option<i32>,
    #[allow(dead_code)]
    status: Option<String>,
}

// ============================================================================
// Message Conversion
// ============================================================================

fn convert_messages(
    messages: &[Message],
    vision_enabled: bool,
    max_images: Option<u32>,
) -> Vec<GeminiContent> {
    messages
        .iter()
        .filter(|msg| msg.role != MessageRole::System)
        .map(|msg| {
            let role = match msg.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "model",
                MessageRole::System => "user", // Should not reach here due to filter
                // Gemini API history doesn't use OpenAI-style `tool` role.
                // Keep compatibility by treating tool outputs as user messages.
                MessageRole::Tool => "user",
            };

            let parts = if msg.has_multimodal_content() {
                let content_parts = msg.get_content_parts();
                let (converted_blocks, _) =
                    content_parts_to_blocks_with_limit(&content_parts, vision_enabled, max_images);

                converted_blocks
                    .into_iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(GeminiPart::Text { text }),
                        ContentBlock::ImageUrl { url, .. } => {
                            // Try to convert URL to Base64
                            // First parse the data URL to get base64 data
                            if let Some((media_type, data)) = parse_data_url(&url) {
                                Some(GeminiPart::InlineData {
                                    inline_data: InlineData {
                                        mime_type: media_type,
                                        data,
                                    },
                                })
                            } else {
                                // Non-data URLs are not supported for inline data
                                None
                            }
                        }
                        ContentBlock::ImageBase64 {
                            media_type, data, ..
                        } => Some(GeminiPart::InlineData {
                            inline_data: InlineData {
                                mime_type: media_type,
                                data,
                            },
                        }),
                    })
                    .collect()
            } else {
                vec![GeminiPart::Text {
                    text: msg.content.clone(),
                }]
            };

            GeminiContent {
                role: role.to_string(),
                parts,
            }
        })
        .collect()
}

fn extract_system_prompt(messages: &[Message], config: &ModelConfig) -> Option<SystemInstruction> {
    let mut system_parts: Vec<String> = Vec::new();

    // First add system_prompt from config
    if let Some(config_prompt) = &config.parameters.system_prompt {
        if !config_prompt.is_empty() {
            system_parts.push(config_prompt.clone());
        }
    }

    // Then add any System role messages from the conversation
    for msg in messages {
        if msg.role == MessageRole::System && !msg.content.is_empty() {
            system_parts.push(msg.content.clone());
        }
    }

    if system_parts.is_empty() {
        None
    } else {
        Some(SystemInstruction {
            parts: vec![GeminiPart::Text {
                text: system_parts.join("\n\n"),
            }],
        })
    }
}

// ============================================================================
// AiClient Implementation
// ============================================================================

#[async_trait]
impl AiClient for GoogleClient {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        _tools: Option<Vec<ToolDefinition>>,
    ) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://generativelanguage.googleapis.com/v1beta");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let contents = convert_messages(&messages, config.vision_enabled, config.max_images);
        let system_instruction = extract_system_prompt(&messages, config);

        // Build thinking config if model supports thinking
        let thinking_config = config.thinking_level.as_ref().and_then(|level| {
            if level == "disabled" {
                // For disabled, use minimal level (closest to off)
                Some(ThinkingConfig {
                    thinking_level: Some("MINIMAL".to_string()),
                    include_thoughts: Some(false),
                })
            } else {
                // Map thinking level to Gemini 3 levels
                let gemini_level = match level.as_str() {
                    "low" => "LOW",
                    "medium" => "MEDIUM",
                    "high" | "very_high" | "xhigh" => "HIGH",
                    _ => "HIGH", // Default to high
                };
                Some(ThinkingConfig {
                    thinking_level: Some(gemini_level.to_string()),
                    include_thoughts: Some(true),
                })
            }
        });

        let generation_config = Some(GenerationConfig {
            temperature: Some(config.parameters.temperature),
            top_p: config.parameters.top_p,
            max_output_tokens: config.parameters.max_tokens,
            thinking_config,
        });

        let request = GenerateContentRequest {
            contents,
            system_instruction,
            generation_config,
        };

        let url = format!(
            "{}/models/{}:generateContent?key={}",
            api_base, config.model, api_key
        );

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<GoogleErrorResponse>(&error_text) {
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            return Err(AiError::RequestFailed(error_text));
        }

        let completion: GenerateContentResponse = response
            .json()
            .await
            .map_err(|e| AiError::InvalidResponse(e.to_string()))?;

        let content = completion
            .candidates
            .and_then(|candidates| candidates.into_iter().next())
            .and_then(|candidate| candidate.content)
            .and_then(|content| content.parts)
            .map(|parts| {
                parts
                    .into_iter()
                    .filter_map(|part| part.text)
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

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
        _tools: Option<Vec<ToolDefinition>>,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://generativelanguage.googleapis.com/v1beta");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let contents = convert_messages(&messages, config.vision_enabled, config.max_images);
        let system_instruction = extract_system_prompt(&messages, config);

        // Build thinking config if model supports thinking
        let thinking_config = config.thinking_level.as_ref().and_then(|level| {
            if level == "disabled" {
                Some(ThinkingConfig {
                    thinking_level: Some("MINIMAL".to_string()),
                    include_thoughts: Some(false),
                })
            } else {
                let gemini_level = match level.as_str() {
                    "low" => "LOW",
                    "medium" => "MEDIUM",
                    "high" | "very_high" | "xhigh" => "HIGH",
                    _ => "HIGH",
                };
                Some(ThinkingConfig {
                    thinking_level: Some(gemini_level.to_string()),
                    include_thoughts: Some(true),
                })
            }
        });

        let generation_config = Some(GenerationConfig {
            temperature: Some(config.parameters.temperature),
            top_p: config.parameters.top_p,
            max_output_tokens: config.parameters.max_tokens,
            thinking_config,
        });

        let request = GenerateContentRequest {
            contents,
            system_instruction,
            generation_config,
        };

        let url = format!(
            "{}/models/{}:streamGenerateContent?alt=sse&key={}",
            api_base, config.model, api_key
        );

        // Capture request info for debug
        let debug_request = DebugRequestData {
            url: url.clone(),
            method: "POST".to_string(),
            headers: {
                let mut h = HashMap::new();
                h.insert("Content-Type".to_string(), "application/json".to_string());
                h
            },
            body: serde_json::to_value(&request).unwrap_or(serde_json::Value::Null),
        };

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        let status_code = response.status().as_u16();
        let response_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<GoogleErrorResponse>(&error_text) {
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
        let mut full_thinking = String::new();
        let mut stream = response.bytes_stream();
        let mut token_usage: Option<TokenUsage> = None;
        // SSE 可能跨 chunk 切分；用行缓冲拼接，避免 JSON 被拆开后无法解析、导致 thinking/text 丢失。
        let mut sse_buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| AiError::StreamError(e.to_string()))?;
            let chunk_str = String::from_utf8_lossy(&chunk);

            sse_buffer.push_str(&chunk_str);

            // Parse SSE events - Google uses "data: " prefix (line-buffered)
            while let Some(pos) = sse_buffer.find('\n') {
                let mut line = sse_buffer[..pos].to_string();
                sse_buffer.drain(..pos + 1);
                if line.ends_with('\r') {
                    line.pop();
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if data.trim().is_empty() {
                        continue;
                    }

                    if let Ok(stream_chunk) = serde_json::from_str::<StreamChunk>(data) {
                        // Extract text from candidates
                        if let Some(candidates) = stream_chunk.candidates {
                            for candidate in candidates {
                                if let Some(content) = candidate.content {
                                    if let Some(parts) = content.parts {
                                        for part in parts {
                                            if let Some(text) = part.text {
                                                if part.thought {
                                                    // This is thinking/reasoning content
                                                    full_thinking.push_str(&text);
                                                    let _ = token_sender
                                                        .send(StreamEvent::Thinking(text))
                                                        .await;
                                                } else {
                                                    // This is normal response content
                                                    full_content.push_str(&text);
                                                    let _ = token_sender
                                                        .send(StreamEvent::Token(text))
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Update usage metadata
                        if let Some(usage) = stream_chunk.usage_metadata {
                            token_usage = Some(TokenUsage {
                                prompt_tokens: usage.prompt_token_count,
                                completion_tokens: usage.candidates_token_count,
                                total_tokens: usage.total_token_count,
                                cached_tokens: usage.cached_content_token_count,
                                reasoning_tokens: usage.thoughts_token_count.filter(|&n| n > 0),
                                cache_creation_input_tokens: None,
                                cache_read_input_tokens: None,
                            });
                        }
                    }
                }
            }
        }

        // Build debug info
        let debug_info = DebugInfoData {
            request: Some(debug_request),
            response: Some(DebugResponseData {
                status: status_code,
                headers: response_headers,
                body: serde_json::json!({
                    "content": full_content.clone(),
                    "thinking": if full_thinking.is_empty() { None } else { Some(full_thinking.clone()) },
                    "usage": token_usage.clone(),
                }),
            }),
        };

        let _ = token_sender
            .send(StreamEvent::DoneWithDebug {
                content: full_content,
                thinking: if full_thinking.is_empty() {
                    None
                } else {
                    Some(full_thinking)
                },
                debug_info: Some(debug_info),
                usage: token_usage,
            })
            .await;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_google_client_creation() {
        let client = GoogleClient::new();
        // Just verify it can be created
        drop(client);
    }

    #[test]
    fn test_google_client_default() {
        let client = GoogleClient::default();
        drop(client);
    }
}
