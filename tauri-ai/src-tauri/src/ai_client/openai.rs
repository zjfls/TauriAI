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

use super::traits::{AiClient, AiError, StreamEvent, DebugInfoData, DebugRequestData, DebugResponseData, TokenUsage};
use crate::models::{Message, MessageRole, ModelConfig};

// ============================================================================
// Shared types and utilities
// ============================================================================

/// OpenAI chat message format
#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: String,
    content: String,
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

/// OpenAI chat completion request
#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
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
    /// Thinking mode for DeepSeek models
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingConfig>,
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

fn convert_messages(messages: &[Message], system_prompt: Option<&str>, system_role: SystemRole) -> Vec<OpenAiMessage> {
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
                content: prompt.to_string(),
            });
        }
    }

    // Convert messages
    for msg in messages {
        let role = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
        };
        result.push(OpenAiMessage {
            role: role.to_string(),
            content: msg.content.clone(),
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

    async fn chat_impl(&self, messages: Vec<Message>, config: &ModelConfig) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.openai.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let openai_messages =
            convert_messages(&messages, config.parameters.system_prompt.as_deref(), self.system_role);

        // Build thinking config based on thinking_enabled:
        // - None: Model doesn't support thinking, don't send parameter
        // - Some(true): Enable thinking
        // - Some(false): Disable thinking explicitly
        let thinking = config.thinking_enabled.map(|enabled| {
            ThinkingConfig {
                thinking_type: if enabled { "enabled" } else { "disabled" }.to_string(),
            }
        });

        let request = ChatCompletionRequest {
            model: config.model.clone(),
            messages: openai_messages,
            temperature: Some(config.parameters.temperature),
            max_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            frequency_penalty: config.parameters.frequency_penalty,
            presence_penalty: config.parameters.presence_penalty,
            stream: false,
            stream_options: None,
            thinking,
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

        let openai_messages =
            convert_messages(&messages, config.parameters.system_prompt.as_deref(), self.system_role);

        // Build thinking config based on thinking_enabled:
        // - None: Model doesn't support thinking, don't send parameter
        // - Some(true): Enable thinking
        // - Some(false): Disable thinking explicitly
        let thinking = config.thinking_enabled.map(|enabled| {
            ThinkingConfig {
                thinking_type: if enabled { "enabled" } else { "disabled" }.to_string(),
            }
        });

        let request = ChatCompletionRequest {
            model: config.model.clone(),
            messages: openai_messages,
            temperature: Some(config.parameters.temperature),
            max_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            frequency_penalty: config.parameters.frequency_penalty,
            presence_penalty: config.parameters.presence_penalty,
            stream: true,
            stream_options: Some(StreamOptions { include_usage: true }),
            thinking,
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
                    body: serde_json::from_str(&error_text).unwrap_or(serde_json::Value::String(error_text.clone())),
                }),
            };
            
            if let Ok(error_response) = serde_json::from_str::<OpenAiErrorResponse>(&error_text) {
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
        let mut final_usage: Option<TokenUsage> = None;
        let mut stream = response.bytes_stream();
        let mut all_chunks: Vec<String> = Vec::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| AiError::StreamError(e.to_string()))?;
            let chunk_str = String::from_utf8_lossy(&chunk).to_string();
            all_chunks.push(chunk_str.clone());

            // Parse SSE events
            for line in chunk_str.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if data.trim() == "[DONE]" {
                        // Build debug info with full content and chunk count
                        let debug_response_body = serde_json::json!({
                            "_sseInfo": {
                                "chunkCount": all_chunks.len(),
                                "note": "SSE stream response"
                            },
                            "content": full_content,
                            "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
                            "usage": final_usage.as_ref().map(|u| serde_json::json!({
                                "prompt_tokens": u.prompt_tokens,
                                "completion_tokens": u.completion_tokens,
                                "total_tokens": u.total_tokens,
                                "cached_tokens": u.cached_tokens,
                                "reasoning_tokens": u.reasoning_tokens
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
                                thinking: if full_thinking.is_empty() { None } else { Some(full_thinking.clone()) },
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
                                cached_tokens: usage.prompt_tokens_details.as_ref().and_then(|d| d.cached_tokens),
                                reasoning_tokens: usage.completion_tokens_details.as_ref().and_then(|d| d.reasoning_tokens),
                                cache_creation_input_tokens: None,
                                cache_read_input_tokens: None,
                            });
                        }
                        
                        if let Some(choice) = stream_chunk.choices.first() {
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
                        }
                    }
                }
            }
        }

        // Build debug info for stream end without [DONE]
        // Include full content and chunk count in response body
        let debug_response_body = serde_json::json!({
            "_sseInfo": {
                "chunkCount": all_chunks.len(),
                "note": "SSE stream response"
            },
            "content": full_content,
            "thinking": if full_thinking.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(full_thinking.clone()) },
            "usage": final_usage.as_ref().map(|u| serde_json::json!({
                "prompt_tokens": u.prompt_tokens,
                "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens,
                "cached_tokens": u.cached_tokens,
                "reasoning_tokens": u.reasoning_tokens
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
                thinking: if full_thinking.is_empty() { None } else { Some(full_thinking) },
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
    async fn chat(&self, messages: Vec<Message>, config: &ModelConfig) -> Result<String, AiError> {
        self.base.chat_impl(messages, config).await
    }

    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError> {
        self.base.chat_stream_impl(messages, config, token_sender).await
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
    async fn chat(&self, messages: Vec<Message>, config: &ModelConfig) -> Result<String, AiError> {
        self.base.chat_impl(messages, config).await
    }

    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError> {
        self.base.chat_stream_impl(messages, config, token_sender).await
    }
}
