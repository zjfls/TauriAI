//! OpenAI API client implementations
//!
//! This module provides two clients:
//! - `OpenAiClient`: For OpenAI official API (uses "developer" role for system prompts)
//! - `OpenAiCompatibleClient`: For OpenAI-compatible APIs (uses "system" role)

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

use super::content_converter::{content_part_to_blocks, ContentBlock};
use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent, TokenUsage,
    ToolCall, ToolDefinition,
};
use crate::models::{ImageDetail, Message, MessageRole, ModelConfig};

// ============================================================================
// Shared types and utilities
// ============================================================================

/// OpenAI chat message format
#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: String,
    /// Required for role=tool messages (OpenAI: `tool_call_id`)
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    /// Tool calls for role=assistant messages (OpenAI: `tool_calls`)
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAiToolCall>>,
    /// Content can be a string or an array of content parts for multimodal
    /// When tool calls are present, OpenAI allows content to be `null`.
    content: Option<OpenAiContent>,
}

/// OpenAI tool call (assistant -> tools)
#[derive(Debug, Serialize)]
struct OpenAiToolCall {
    id: String,
    #[serde(rename = "type")]
    tool_type: String,
    function: OpenAiToolCallFunction,
}

#[derive(Debug, Serialize)]
struct OpenAiToolCallFunction {
    name: String,
    arguments: String,
}

/// OpenAI tool definition (sent in request)
#[derive(Debug, Serialize)]
struct OpenAiTool {
    #[serde(rename = "type")]
    tool_type: String,
    function: OpenAiToolFunction,
}

#[derive(Debug, Serialize)]
struct OpenAiToolFunction {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    parameters: serde_json::Value,
}

/// OpenAI content format - either simple string or array of parts
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum OpenAiContent {
    /// Simple text content
    Text(String),
    /// Multimodal content (text + images)
    Parts(Vec<OpenAiContentPart>),
}

/// A single content part for multimodal messages
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OpenAiContentPart {
    /// Text content part
    Text { text: String },
    /// Image URL content part
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlData },
}

/// Image URL data structure
#[derive(Debug, Serialize)]
struct ImageUrlData {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Thinking mode configuration for DeepSeek models
#[derive(Debug, Serialize)]
struct ThinkingConfig {
    #[serde(rename = "type")]
    thinking_type: String,
}

/// Stream options for including usage in streaming responses
#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// OpenAI Chat Completions web search options (`web_search_options`)
#[derive(Debug, Serialize)]
struct WebSearchOptions {
    /// High level guidance for the amount of context window space to use for the search.
    /// One of: `low` | `medium` | `high`
    #[serde(skip_serializing_if = "Option::is_none")]
    search_context_size: Option<String>,
}

/// OpenAI chat completion request
#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    /// Tools (OpenAI function calling)
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<OpenAiTool>>,
    /// Tool choice ("auto" | "none" | { ... })
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
    /// Provider-native web search (OpenAI official API)
    #[serde(skip_serializing_if = "Option::is_none")]
    web_search_options: Option<WebSearchOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presence_penalty: Option<f32>,
    stream: bool,
    /// Stream options for including usage stats
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
    /// Thinking mode for DeepSeek models (legacy)
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingConfig>,
    /// Reasoning effort for OpenAI GPT-5 series (new)
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

/// OpenAI chat completion response (non-streaming)
#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

/// OpenAI streaming response chunk
#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
    /// Usage stats (only in final chunk when stream_options.include_usage is true)
    usage: Option<UsageStats>,
}

/// Usage statistics from OpenAI API
#[derive(Debug, Deserialize)]
struct UsageStats {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
    /// DeepSeek style cache hits
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    cached_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct CompletionTokensDetails {
    reasoning_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
    /// Reasoning content for thinking models (DeepSeek-R1, etc.)
    reasoning_content: Option<String>,
    /// OpenAI tool calls (streaming delta)
    #[serde(default)]
    tool_calls: Option<Vec<StreamToolCallDelta>>,
    /// Legacy function_call (older OpenAI-compatible endpoints)
    #[serde(default)]
    function_call: Option<StreamFunctionCallDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "type")]
    tool_type: Option<String>,
    #[serde(default)]
    function: Option<StreamToolCallFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamFunctionCallDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// OpenAI error response
#[derive(Debug, Deserialize)]
struct OpenAiErrorResponse {
    error: OpenAiErrorDetail,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorDetail {
    message: String,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    error_type: Option<String>,
}

/// System prompt role type
#[derive(Debug, Clone, Copy)]
enum SystemRole {
    /// Use "system" role (for OpenAI-compatible APIs)
    System,
    /// Use "developer" role (for OpenAI official API with newer models)
    Developer,
}

fn convert_messages(
    messages: &[Message],
    system_prompt: Option<&str>,
    system_role: SystemRole,
    supports_vision: bool,
) -> Vec<OpenAiMessage> {
    let mut result = Vec::new();

    // Add system prompt if provided and not empty
    if let Some(prompt) = system_prompt {
        if !prompt.is_empty() {
            let role = match system_role {
                SystemRole::System => "system",
                SystemRole::Developer => "developer",
            };
            result.push(OpenAiMessage {
                role: role.to_string(),
                tool_call_id: None,
                tool_calls: None,
                content: Some(OpenAiContent::Text(prompt.to_string())),
            });
        }
    }

    // Convert messages using unified content converter
    for msg in messages {
        let role = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
            MessageRole::Tool => "tool",
        };

        let tool_call_id = match msg.role {
            MessageRole::Tool => msg
                .meta
                .as_ref()
                .and_then(|m| m.tool_call_id.as_ref())
                .cloned(),
            _ => None,
        };

        let tool_calls = match msg.role {
            MessageRole::Assistant => {
                msg.meta
                    .as_ref()
                    .and_then(|m| m.tool_calls.as_ref())
                    .map(|calls| {
                        calls
                            .iter()
                            .map(|c| OpenAiToolCall {
                                id: c.id.clone(),
                                tool_type: "function".to_string(),
                                function: OpenAiToolCallFunction {
                                    name: c.name.clone(),
                                    arguments: c.arguments.clone(),
                                },
                            })
                            .collect::<Vec<_>>()
                    })
            }
            _ => None,
        };

        // Check if message has multimodal content
        let content = if msg.has_multimodal_content() {
            // Use unified converter to get content blocks
            let blocks: Vec<OpenAiContentPart> = msg
                .get_content_parts()
                .iter()
                .flat_map(|part| {
                    content_part_to_blocks(part, supports_vision)
                        .into_iter()
                        .map(|block| match block {
                            ContentBlock::Text { text } => OpenAiContentPart::Text { text },
                            ContentBlock::ImageUrl { url, detail } => OpenAiContentPart::ImageUrl {
                                image_url: ImageUrlData {
                                    url,
                                    detail: match detail {
                                        ImageDetail::Auto => None,
                                        ImageDetail::Low => Some("low".to_string()),
                                        ImageDetail::High => Some("high".to_string()),
                                    },
                                },
                            },
                            ContentBlock::ImageBase64 { data, .. } => {
                                // OpenAI supports data URLs, reconstruct from base64
                                OpenAiContentPart::ImageUrl {
                                    image_url: ImageUrlData {
                                        url: format!("data:image/png;base64,{}", data),
                                        detail: Some("high".to_string()),
                                    },
                                }
                            }
                        })
                })
                .collect();
            Some(OpenAiContent::Parts(blocks))
        } else if tool_calls.is_some() && msg.content.trim().is_empty() {
            // Tool call turn: content is allowed to be null when tool_calls exist.
            None
        } else {
            // Simple text content
            Some(OpenAiContent::Text(msg.content.clone()))
        };

        result.push(OpenAiMessage {
            role: role.to_string(),
            tool_call_id,
            tool_calls,
            content,
        });
    }

    result
}

// ============================================================================
// Base implementation (shared logic)
// ============================================================================

struct OpenAiBaseClient {
    client: Client,
    system_role: SystemRole,
}

impl OpenAiBaseClient {
    fn new(system_role: SystemRole) -> Self {
        Self {
            client: Client::new(),
            system_role,
        }
    }

    async fn chat_impl(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
    ) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.openai.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let openai_messages = convert_messages(
            &messages,
            config.parameters.system_prompt.as_deref(),
            self.system_role,
            config.vision_enabled,
        );

        let tools = tools.and_then(|defs| {
            if defs.is_empty() {
                None
            } else {
                Some(
                    defs.into_iter()
                        .map(|t| OpenAiTool {
                            tool_type: "function".to_string(),
                            function: OpenAiToolFunction {
                                name: t.name,
                                description: t.description,
                                parameters: t.parameters,
                            },
                        })
                        .collect::<Vec<_>>(),
                )
            }
        });

        // Build thinking/reasoning config based on thinking_level and use_reasoning_effort:
        // - If use_reasoning_effort is true: use reasoning_effort parameter (OpenAI GPT-5)
        // - Otherwise: use thinking parameter (DeepSeek, legacy)
        let (thinking, reasoning_effort) = if config.use_reasoning_effort.unwrap_or(false) {
            // Use reasoning_effort parameter for OpenAI GPT-5 series
            let effort = config.thinking_level.as_ref().and_then(|level| {
                match level.as_str() {
                    "disabled" => Some("none".to_string()),
                    "low" => Some("low".to_string()),
                    "medium" => Some("medium".to_string()),
                    "high" => Some("high".to_string()),
                    "xhigh" => Some("high".to_string()), // Chat Completions API doesn't support xhigh
                    _ => None,
                }
            });
            (None, effort)
        } else {
            // Use thinking parameter for DeepSeek and other models
            let thinking_cfg = config.thinking_level.as_ref().map(|level| ThinkingConfig {
                thinking_type: if level == "disabled" {
                    "disabled"
                } else {
                    "enabled"
                }
                .to_string(),
            });
            (thinking_cfg, None)
        };

        // Only send OpenAI-native `web_search_options` to the official OpenAI API client.
        // (Avoid passing unknown fields to OpenAI-compatible services that may 400.)
        let web_search_options = match self.system_role {
            SystemRole::Developer if config.web_search_enabled => Some(WebSearchOptions {
                search_context_size: Some("medium".to_string()),
            }),
            _ => None,
        };

        let request = ChatCompletionRequest {
            model: config.model.clone(),
            messages: openai_messages,
            tool_choice: tools.as_ref().map(|_| "auto".to_string()),
            tools,
            web_search_options,
            temperature: Some(config.parameters.temperature),
            max_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            frequency_penalty: config.parameters.frequency_penalty,
            presence_penalty: config.parameters.presence_penalty,
            stream: false,
            stream_options: None,
            thinking,
            reasoning_effort,
        };

        let response = self
            .client
            .post(format!("{api_base}/chat/completions"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            if let Ok(error_response) = serde_json::from_str::<OpenAiErrorResponse>(&error_text) {
                return Err(AiError::RequestFailed(error_response.error.message));
            }
            return Err(AiError::RequestFailed(error_text));
        }

        let completion: ChatCompletionResponse = response
            .json()
            .await
            .map_err(|e| AiError::InvalidResponse(e.to_string()))?;

        completion
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or_else(|| AiError::InvalidResponse("No content in response".to_string()))
    }

    async fn chat_stream_impl(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
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

        let openai_messages = convert_messages(
            &messages,
            config.parameters.system_prompt.as_deref(),
            self.system_role,
            config.vision_enabled,
        );

        let tools = tools.and_then(|defs| {
            if defs.is_empty() {
                None
            } else {
                Some(
                    defs.into_iter()
                        .map(|t| OpenAiTool {
                            tool_type: "function".to_string(),
                            function: OpenAiToolFunction {
                                name: t.name,
                                description: t.description,
                                parameters: t.parameters,
                            },
                        })
                        .collect::<Vec<_>>(),
                )
            }
        });

        // Build thinking/reasoning config based on thinking_level and use_reasoning_effort:
        // - If use_reasoning_effort is true: use reasoning_effort parameter (OpenAI GPT-5)
        // - Otherwise: use thinking parameter (DeepSeek, legacy)
        let (thinking, reasoning_effort) = if config.use_reasoning_effort.unwrap_or(false) {
            // Use reasoning_effort parameter for OpenAI GPT-5 series
            let effort = config.thinking_level.as_ref().and_then(|level| {
                match level.as_str() {
                    "disabled" => Some("none".to_string()),
                    "low" => Some("low".to_string()),
                    "medium" => Some("medium".to_string()),
                    "high" => Some("high".to_string()),
                    "xhigh" => Some("high".to_string()), // Chat Completions API doesn't support xhigh
                    _ => None,
                }
            });
            (None, effort)
        } else {
            // Use thinking parameter for DeepSeek and other models
            let thinking_cfg = config.thinking_level.as_ref().map(|level| ThinkingConfig {
                thinking_type: if level == "disabled" {
                    "disabled"
                } else {
                    "enabled"
                }
                .to_string(),
            });
            (thinking_cfg, None)
        };

        // Only send OpenAI-native `web_search_options` to the official OpenAI API client.
        let web_search_options = match self.system_role {
            SystemRole::Developer if config.web_search_enabled => Some(WebSearchOptions {
                search_context_size: Some("medium".to_string()),
            }),
            _ => None,
        };

        let request = ChatCompletionRequest {
            model: config.model.clone(),
            messages: openai_messages,
            tool_choice: tools.as_ref().map(|_| "auto".to_string()),
            tools,
            web_search_options,
            temperature: Some(config.parameters.temperature),
            max_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            frequency_penalty: config.parameters.frequency_penalty,
            presence_penalty: config.parameters.presence_penalty,
            stream: true,
            stream_options: Some(StreamOptions {
                include_usage: true,
            }),
            thinking,
            reasoning_effort,
        };

        let url = format!("{api_base}/chat/completions");

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

            // Send Error event FIRST, then DoneWithDebug for debug/usage
            // (runtime/task_runner will pick up the error but still keep debug info if available).
            if let Ok(error_response) = serde_json::from_str::<OpenAiErrorResponse>(&error_text) {
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

        struct ToolCallAccum {
            id: Option<String>,
            name: Option<String>,
            arguments: String,
        }

        let mut full_content = String::new();
        let mut full_thinking = String::new();
        let mut final_usage: Option<TokenUsage> = None;
        let mut tool_calls_accum: HashMap<usize, ToolCallAccum> = HashMap::new();
        let mut legacy_function_name: Option<String> = None;
        let mut legacy_function_args = String::new();
        let mut tool_calls_sent = false;
        let mut stream = response.bytes_stream();
        let mut all_chunks: Vec<String> = Vec::new();
        // SSE 可能在任意字节边界切片；用行缓冲拼接，避免 JSON 被拆分后解析失败导致丢 token。
        let mut sse_buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| AiError::StreamError(e.to_string()))?;
            let chunk_str = String::from_utf8_lossy(&chunk).to_string();
            all_chunks.push(chunk_str.clone());

            sse_buffer.push_str(&chunk_str);

            // Parse SSE events (line-buffered, handles chunk boundary splits)
            while let Some(pos) = sse_buffer.find('\n') {
                let mut line = sse_buffer[..pos].to_string();
                sse_buffer.drain(..pos + 1);
                if line.ends_with('\r') {
                    line.pop();
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if data.trim() == "[DONE]" {
                        if !tool_calls_sent {
                            let mut calls: Vec<ToolCall> = Vec::new();

                            if !tool_calls_accum.is_empty() {
                                let mut items: Vec<(usize, ToolCallAccum)> =
                                    tool_calls_accum.drain().collect();
                                items.sort_by_key(|(i, _)| *i);
                                for (i, acc) in items {
                                    let id = acc.id.unwrap_or_else(|| format!("call_{i}"));
                                    let name = acc.name.unwrap_or_else(|| "unknown".to_string());
                                    calls.push(ToolCall {
                                        id,
                                        name,
                                        arguments: acc.arguments,
                                    });
                                }
                            } else if let Some(name) = legacy_function_name.clone() {
                                calls.push(ToolCall {
                                    id: "call_0".to_string(),
                                    name,
                                    arguments: legacy_function_args.clone(),
                                });
                            }

                            if !calls.is_empty() {
                                let _ = token_sender.send(StreamEvent::ToolCalls(calls)).await;
                            }
                        }

                        // Build debug info with full content - using OpenAI Chat Completions API format
                        let debug_response_body = serde_json::json!({
                            "choices": [{
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": full_content,
                                    "reasoning_content": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) }
                                },
                                "finish_reason": "stop"
                            }],
                            "usage": final_usage.as_ref().map(|u| serde_json::json!({
                                "prompt_tokens": u.prompt_tokens,
                                "completion_tokens": u.completion_tokens,
                                "total_tokens": u.total_tokens,
                                "prompt_tokens_details": {
                                    "cached_tokens": u.cached_tokens
                                },
                                "completion_tokens_details": {
                                    "reasoning_tokens": u.reasoning_tokens
                                }
                            }))
                        });

                        let debug_info = DebugInfoData {
                            request: Some(debug_request.clone()),
                            response: Some(DebugResponseData {
                                status: response_status,
                                headers: response_headers.clone(),
                                body: debug_response_body,
                            }),
                        };

                        // Always send DoneWithDebug for debug info and usage
                        let _ = token_sender
                            .send(StreamEvent::DoneWithDebug {
                                content: full_content.clone(),
                                thinking: if full_thinking.is_empty() {
                                    None
                                } else {
                                    Some(full_thinking.clone())
                                },
                                debug_info: Some(debug_info),
                                usage: final_usage.clone(),
                            })
                            .await;
                        return Ok(());
                    }

                    if let Ok(stream_chunk) = serde_json::from_str::<StreamChunk>(data) {
                        // Capture usage from final chunk
                        if let Some(usage) = stream_chunk.usage {
                            final_usage = Some(TokenUsage {
                                prompt_tokens: usage.prompt_tokens,
                                completion_tokens: usage.completion_tokens,
                                total_tokens: usage.total_tokens,
                                cached_tokens: usage
                                    .prompt_tokens_details
                                    .as_ref()
                                    .and_then(|d| d.cached_tokens)
                                    .or(usage.prompt_cache_hit_tokens),
                                reasoning_tokens: usage
                                    .completion_tokens_details
                                    .as_ref()
                                    .and_then(|d| d.reasoning_tokens),
                                cache_creation_input_tokens: None,
                                cache_read_input_tokens: None,
                            });
                        }

                        if let Some(choice) = stream_chunk.choices.first() {
                            // Handle tool_calls deltas
                            if let Some(deltas) = &choice.delta.tool_calls {
                                for tc in deltas {
                                    let Some(index) = tc.index else { continue };
                                    let idx = index as usize;

                                    let entry = tool_calls_accum.entry(idx).or_insert_with(|| {
                                        ToolCallAccum {
                                            id: None,
                                            name: None,
                                            arguments: String::new(),
                                        }
                                    });

                                    if let Some(id) = &tc.id {
                                        entry.id = Some(id.clone());
                                    }

                                    if let Some(func) = &tc.function {
                                        if let Some(name) = &func.name {
                                            entry.name = Some(name.clone());
                                        }
                                        if let Some(args) = &func.arguments {
                                            entry.arguments.push_str(args);
                                        }
                                    }
                                }
                            }

                            // Handle legacy function_call deltas
                            if let Some(fc) = &choice.delta.function_call {
                                if let Some(name) = &fc.name {
                                    legacy_function_name = Some(name.clone());
                                }
                                if let Some(args) = &fc.arguments {
                                    legacy_function_args.push_str(args);
                                }
                            }

                            // Handle reasoning_content (thinking tokens)
                            if let Some(reasoning) = &choice.delta.reasoning_content {
                                full_thinking.push_str(reasoning);
                                let _ = token_sender
                                    .send(StreamEvent::Thinking(reasoning.clone()))
                                    .await;
                            }
                            // Handle regular content
                            if let Some(content) = &choice.delta.content {
                                full_content.push_str(content);
                                let _ =
                                    token_sender.send(StreamEvent::Token(content.clone())).await;
                            }

                            // If finish_reason indicates tool calls, emit ToolCalls once.
                            if !tool_calls_sent {
                                if let Some(reason) = choice.finish_reason.as_deref() {
                                    if reason == "tool_calls" || reason == "function_call" {
                                        let mut calls: Vec<ToolCall> = Vec::new();

                                        if !tool_calls_accum.is_empty() {
                                            let mut items: Vec<(usize, ToolCallAccum)> =
                                                tool_calls_accum
                                                    .iter()
                                                    .map(|(k, v)| {
                                                        (
                                                            *k,
                                                            ToolCallAccum {
                                                                id: v.id.clone(),
                                                                name: v.name.clone(),
                                                                arguments: v.arguments.clone(),
                                                            },
                                                        )
                                                    })
                                                    .collect();
                                            items.sort_by_key(|(i, _)| *i);
                                            for (i, acc) in items {
                                                let id =
                                                    acc.id.unwrap_or_else(|| format!("call_{i}"));
                                                let name = acc
                                                    .name
                                                    .unwrap_or_else(|| "unknown".to_string());
                                                calls.push(ToolCall {
                                                    id,
                                                    name,
                                                    arguments: acc.arguments,
                                                });
                                            }
                                        } else if let Some(name) = legacy_function_name.clone() {
                                            calls.push(ToolCall {
                                                id: "call_0".to_string(),
                                                name,
                                                arguments: legacy_function_args.clone(),
                                            });
                                        }

                                        if !calls.is_empty() {
                                            tool_calls_sent = true;
                                            let _ = token_sender
                                                .send(StreamEvent::ToolCalls(calls))
                                                .await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Build debug info for stream end without [DONE] - using OpenAI Chat Completions API format
        let debug_response_body = serde_json::json!({
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": full_content,
                    "reasoning_content": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) }
                },
                "finish_reason": "stop"
            }],
            "usage": final_usage.as_ref().map(|u| serde_json::json!({
                "prompt_tokens": u.prompt_tokens,
                "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens,
                "prompt_tokens_details": {
                    "cached_tokens": u.cached_tokens
                },
                "completion_tokens_details": {
                    "reasoning_tokens": u.reasoning_tokens
                }
            }))
        });

        let debug_info = DebugInfoData {
            request: Some(debug_request),
            response: Some(DebugResponseData {
                status: response_status,
                headers: response_headers,
                body: debug_response_body,
            }),
        };

        // Send DoneWithDebug event
        let _ = token_sender
            .send(StreamEvent::DoneWithDebug {
                content: full_content,
                thinking: if full_thinking.is_empty() {
                    None
                } else {
                    Some(full_thinking)
                },
                debug_info: Some(debug_info),
                usage: final_usage,
            })
            .await;
        Ok(())
    }
}

// ============================================================================
// OpenAI Official Client (uses "developer" role)
// ============================================================================

/// OpenAI official API client
/// Uses "developer" role for system prompts (recommended for newer models like o1, GPT-4.1)
pub struct OpenAiClient {
    base: OpenAiBaseClient,
}

impl OpenAiClient {
    pub fn new() -> Self {
        Self {
            base: OpenAiBaseClient::new(SystemRole::Developer),
        }
    }
}

impl Default for OpenAiClient {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AiClient for OpenAiClient {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
    ) -> Result<String, AiError> {
        self.base.chat_impl(messages, config, tools).await
    }

    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError> {
        self.base
            .chat_stream_impl(messages, config, tools, token_sender)
            .await
    }
}

// ============================================================================
// OpenAI Compatible Client (uses "system" role)
// ============================================================================

/// OpenAI-compatible API client
/// Uses "system" role for system prompts (for third-party services like SiliconFlow, DeepSeek, etc.)
pub struct OpenAiCompatibleClient {
    base: OpenAiBaseClient,
}

impl OpenAiCompatibleClient {
    pub fn new() -> Self {
        Self {
            base: OpenAiBaseClient::new(SystemRole::System),
        }
    }
}

impl Default for OpenAiCompatibleClient {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AiClient for OpenAiCompatibleClient {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
    ) -> Result<String, AiError> {
        self.base.chat_impl(messages, config, tools).await
    }

    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        tools: Option<Vec<ToolDefinition>>,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError> {
        self.base
            .chat_stream_impl(messages, config, tools, token_sender)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ContentPart, MessageRole, PdfMetadata, PdfPage};
    use proptest::prelude::*;

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
        /// **Property 6: OpenAI API Conversion**
        /// *For any* valid PdfDocument ContentPart with arbitrary filename, pages, and metadata,
        /// converting to OpenAI API format SHALL produce alternating text and image_url parts
        /// where each page generates exactly one text part followed by one image_url part.
        /// **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
        #[test]
        fn prop_pdf_document_openai_conversion(pdf_part in arb_pdf_document()) {
            // Extract PDF data
            let (filename, pages) = match &pdf_part {
                ContentPart::PdfDocument { filename, pages, .. } => (filename.clone(), pages.clone()),
                _ => panic!("Expected PdfDocument variant"),
            };

            // Create a message with the PDF document
            let message = Message {
                id: "test".to_string(),
                conversation_id: "conv".to_string(),
                role: MessageRole::User,
                content: "Analyze this PDF".to_string(),
                content_parts: vec![
                    ContentPart::text("Analyze this PDF"),
                    pdf_part.clone(),
                ],
                thinking: None,
                meta: None,
                created_at: chrono::Utc::now(),
                status: crate::models::MessageStatus::Success,
                error_message: None,
            };

            // Convert to OpenAI format
            let openai_messages = convert_messages(&[message], None, SystemRole::System, true);

            // Should have exactly one message (user message)
            prop_assert_eq!(openai_messages.len(), 1, "Should have exactly one OpenAI message");

            let openai_msg = &openai_messages[0];
            prop_assert_eq!(&openai_msg.role, "user", "Role should be 'user'");

            // Extract content parts
            let content_parts = match &openai_msg.content {
                Some(OpenAiContent::Parts(parts)) => parts,
                _ => panic!("Expected Parts variant"),
            };

            // Calculate expected number of parts:
            // 1 text part ("Analyze this PDF") + (pages.len() * 2) parts (text + image per page)
            let expected_parts = 1 + (pages.len() * 2);
            prop_assert_eq!(
                content_parts.len(),
                expected_parts,
                "Should have {} parts (1 initial text + {} pages * 2)", expected_parts, pages.len()
            );

            // First part should be the initial text
            match &content_parts[0] {
                OpenAiContentPart::Text { text } => {
                    prop_assert_eq!(text, "Analyze this PDF", "First part should be initial text");
                }
                _ => panic!("First part should be Text"),
            }

            // Verify each page generates text + image in sequence
            for (i, page) in pages.iter().enumerate() {
                let text_idx = 1 + (i * 2);
                let image_idx = text_idx + 1;

                // Verify text part
                match &content_parts[text_idx] {
                    OpenAiContentPart::Text { text } => {
                        // Should contain filename, page number, and page text
                        prop_assert!(
                            text.contains(&filename),
                            "Text part {} should contain filename '{}'", text_idx, filename
                        );
                        prop_assert!(
                            text.contains(&format!("第{}页", page.page_number)),
                            "Text part {} should contain page number {}", text_idx, page.page_number
                        );
                        prop_assert!(
                            text.contains(&page.text),
                            "Text part {} should contain page text", text_idx
                        );
                        // Should be formatted as markdown code block
                        prop_assert!(
                            text.contains("```"),
                            "Text part {} should be formatted as code block", text_idx
                        );
                    }
                    _ => panic!("Part {} should be Text", text_idx),
                }

                // Verify image part
                match &content_parts[image_idx] {
                    OpenAiContentPart::ImageUrl { image_url } => {
                        prop_assert_eq!(
                            &image_url.url, &page.image,
                            "Image part {} should have correct URL", image_idx
                        );
                        prop_assert_eq!(
                            &image_url.detail, &Some("high".to_string()),
                            "Image part {} should have 'high' detail", image_idx
                        );
                    }
                    _ => panic!("Part {} should be ImageUrl", image_idx),
                }
            }
        }
    }

    #[test]
    fn test_pdf_document_conversion_single_page() {
        // Test with a single-page PDF
        let page = PdfPage {
            page_number: 1,
            text: "This is page 1 content".to_string(),
            image: "data:image/png;base64,abc123".to_string(),
        };

        let pdf_part = ContentPart::pdf_document("test.pdf", vec![page.clone()], None);

        let message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze".to_string(),
            content_parts: vec![ContentPart::text("Analyze"), pdf_part],
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let openai_messages = convert_messages(&[message], None, SystemRole::System, true);

        assert_eq!(openai_messages.len(), 1);
        let content_parts = match &openai_messages[0].content {
            Some(OpenAiContent::Parts(parts)) => parts,
            _ => panic!("Expected Parts"),
        };

        // Should have 3 parts: initial text + (1 page * 2)
        assert_eq!(content_parts.len(), 3);

        // Verify text part
        match &content_parts[1] {
            OpenAiContentPart::Text { text } => {
                assert!(text.contains("test.pdf"));
                assert!(text.contains("第1页"));
                assert!(text.contains("This is page 1 content"));
            }
            _ => panic!("Expected Text"),
        }

        // Verify image part
        match &content_parts[2] {
            OpenAiContentPart::ImageUrl { image_url } => {
                assert_eq!(image_url.url, "data:image/png;base64,abc123");
                assert_eq!(image_url.detail, Some("high".to_string()));
            }
            _ => panic!("Expected ImageUrl"),
        }
    }

    #[test]
    fn test_pdf_document_conversion_multiple_pages() {
        // Test with a multi-page PDF
        let pages = vec![
            PdfPage {
                page_number: 1,
                text: "Page 1".to_string(),
                image: "data:image/png;base64,page1".to_string(),
            },
            PdfPage {
                page_number: 2,
                text: "Page 2".to_string(),
                image: "data:image/png;base64,page2".to_string(),
            },
            PdfPage {
                page_number: 3,
                text: "Page 3".to_string(),
                image: "data:image/png;base64,page3".to_string(),
            },
        ];

        let pdf_part = ContentPart::pdf_document("report.pdf", pages.clone(), None);

        let message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Review".to_string(),
            content_parts: vec![ContentPart::text("Review"), pdf_part],
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let openai_messages = convert_messages(&[message], None, SystemRole::System, true);

        let content_parts = match &openai_messages[0].content {
            Some(OpenAiContent::Parts(parts)) => parts,
            _ => panic!("Expected Parts"),
        };

        // Should have 7 parts: 1 initial text + (3 pages * 2)
        assert_eq!(content_parts.len(), 7);

        // Verify each page
        for (i, page) in pages.iter().enumerate() {
            let text_idx = 1 + (i * 2);
            let image_idx = text_idx + 1;

            match &content_parts[text_idx] {
                OpenAiContentPart::Text { text } => {
                    assert!(text.contains("report.pdf"));
                    assert!(text.contains(&format!("第{}页", page.page_number)));
                    assert!(text.contains(&page.text));
                }
                _ => panic!("Expected Text at index {}", text_idx),
            }

            match &content_parts[image_idx] {
                OpenAiContentPart::ImageUrl { image_url } => {
                    assert_eq!(image_url.url, page.image);
                    assert_eq!(image_url.detail, Some("high".to_string()));
                }
                _ => panic!("Expected ImageUrl at index {}", image_idx),
            }
        }
    }

    #[test]
    fn test_pdf_document_with_system_prompt() {
        // Test that system prompt is correctly added
        let page = PdfPage {
            page_number: 1,
            text: "Content".to_string(),
            image: "data:image/png;base64,img".to_string(),
        };

        let pdf_part = ContentPart::pdf_document("doc.pdf", vec![page], None);

        let message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze".to_string(),
            content_parts: vec![pdf_part],
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let openai_messages = convert_messages(
            &[message],
            Some("You are a helpful assistant."),
            SystemRole::System,
            true,
        );

        // Should have 2 messages: system + user
        assert_eq!(openai_messages.len(), 2);
        assert_eq!(openai_messages[0].role, "system");
        assert_eq!(openai_messages[1].role, "user");

        // Verify system message
        match &openai_messages[0].content {
            Some(OpenAiContent::Text(text)) => {
                assert_eq!(text, "You are a helpful assistant.");
            }
            _ => panic!("Expected Text for system message"),
        }
    }

    #[test]
    fn test_mixed_content_with_pdf() {
        // Test message with text, image, and PDF
        let page = PdfPage {
            page_number: 1,
            text: "PDF content".to_string(),
            image: "data:image/png;base64,pdf".to_string(),
        };

        let message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Mixed content".to_string(),
            content_parts: vec![
                ContentPart::text("Look at this"),
                ContentPart::image("data:image/png;base64,img1"),
                ContentPart::pdf_document("doc.pdf", vec![page], None),
            ],
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let openai_messages = convert_messages(&[message], None, SystemRole::System, true);

        let content_parts = match &openai_messages[0].content {
            Some(OpenAiContent::Parts(parts)) => parts,
            _ => panic!("Expected Parts"),
        };

        // Should have 4 parts: text + image + (1 page * 2)
        // Note: content field is not included when content_parts is present
        assert_eq!(content_parts.len(), 4);

        // Verify order: text, image, pdf_text, pdf_image
        match &content_parts[0] {
            OpenAiContentPart::Text { text } => assert_eq!(text, "Look at this"),
            _ => panic!("Expected Text"),
        }

        match &content_parts[1] {
            OpenAiContentPart::ImageUrl { image_url } => {
                assert_eq!(image_url.url, "data:image/png;base64,img1")
            }
            _ => panic!("Expected ImageUrl"),
        }

        match &content_parts[2] {
            OpenAiContentPart::Text { text } => {
                assert!(text.contains("doc.pdf"));
                assert!(text.contains("PDF content"));
            }
            _ => panic!("Expected Text"),
        }

        match &content_parts[3] {
            OpenAiContentPart::ImageUrl { image_url } => {
                assert_eq!(image_url.url, "data:image/png;base64,pdf")
            }
            _ => panic!("Expected ImageUrl"),
        }
    }
}
