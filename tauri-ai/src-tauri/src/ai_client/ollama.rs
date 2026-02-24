//! Ollama API client implementation

use std::collections::HashMap;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::traits::{
    AiClient, AiError, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent,
    StreamTerminationInfo, StreamTerminationSource, ToolDefinition,
};
use super::utf8_stream::Utf8StreamDecoder;
use super::{
    format_reqwest_stream_error, summarize_reqwest_error, summarize_reqwest_stream_error,
    StreamProtocolContext,
};
use crate::models::{Message, MessageRole, ModelConfig};

/// Ollama API client
pub struct OllamaClient {
    client: Client,
}

impl OllamaClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl Default for OllamaClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Ollama message format
#[derive(Debug, Serialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

/// Ollama chat API request
#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

/// Ollama model options
#[derive(Debug, Serialize)]
struct OllamaOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
}

/// Ollama chat API response (non-streaming)
#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: OllamaMessageResponse,
}

#[derive(Debug, Deserialize)]
struct OllamaMessageResponse {
    content: String,
}

/// Ollama streaming response chunk
#[derive(Debug, Deserialize)]
struct StreamResponse {
    message: Option<OllamaMessageResponse>,
    done: bool,
}

/// Ollama error response
#[derive(Debug, Deserialize)]
struct OllamaErrorResponse {
    error: String,
}

fn convert_messages(messages: &[Message], system_prompt: Option<&str>) -> Vec<OllamaMessage> {
    let mut result = Vec::new();

    // Add system prompt if provided
    if let Some(prompt) = system_prompt {
        result.push(OllamaMessage {
            role: "system".to_string(),
            content: prompt.to_string(),
        });
    }

    // Convert messages
    for msg in messages {
        let role = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
            // Ollama chat format doesn't define a tool role; treat it as user text.
            MessageRole::Tool => "user",
        };
        result.push(OllamaMessage {
            role: role.to_string(),
            content: msg.content.clone(),
        });
    }

    result
}

#[async_trait]
impl AiClient for OllamaClient {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        _tools: Option<Vec<ToolDefinition>>,
    ) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("http://localhost:11434");

        let ollama_messages =
            convert_messages(&messages, config.parameters.system_prompt.as_deref());

        let options = OllamaOptions {
            temperature: config.parameters.temperature,
            num_predict: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
        };

        let request = ChatRequest {
            model: config.model.clone(),
            messages: ollama_messages,
            stream: false,
            options: Some(options),
        };

        let response = self
            .client
            .post(format!("{api_base}/api/chat"))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::ConnectionError(e.to_string()))?;

        let status_code = response.status().as_u16();
        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = if let Ok(error_response) =
                serde_json::from_str::<OllamaErrorResponse>(&error_text)
            {
                error_response.error
            } else {
                error_text
            };
            return Err(match status_code {
                401 | 403 => AiError::AuthenticationFailed(error_msg),
                429 => AiError::RateLimited(error_msg),
                _ => AiError::RequestFailed(error_msg),
            });
        }

        let completion: ChatResponse = response
            .json()
            .await
            .map_err(|e| AiError::InvalidResponse(e.to_string()))?;

        Ok(completion.message.content)
    }

    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        _tools: Option<Vec<ToolDefinition>>,
        token_sender: mpsc::Sender<StreamEvent>,
        _options: super::StreamOptions,
    ) -> Result<(), AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("http://localhost:11434");

        let ollama_messages =
            convert_messages(&messages, config.parameters.system_prompt.as_deref());

        let options = OllamaOptions {
            temperature: config.parameters.temperature,
            num_predict: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
        };

        let request = ChatRequest {
            model: config.model.clone(),
            messages: ollama_messages,
            stream: true,
            options: Some(options),
        };

        let url = format!("{api_base}/api/chat");
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

            let debug_info = DebugInfoData {
                request: Some(debug_request.clone()),
                response: Some(DebugResponseData {
                    status: status_code,
                    headers: response_headers.clone(),
                    body: serde_json::from_str(&error_text)
                        .unwrap_or(serde_json::Value::String(error_text.clone())),
                }),
                stream_termination: Some(StreamTerminationInfo {
                    protocol_complete: Some(false),
                    termination_source: Some(StreamTerminationSource::HttpError),
                    protocol_kind: Some("ndjson_field".to_string()),
                    expected_signal: Some("done=true".to_string()),
                    observed_signal: None,
                    last_event_type: None,
                    chunk_count: Some(0),
                }),
            };

            let error_msg = serde_json::from_str::<OllamaErrorResponse>(&error_text)
                .ok()
                .map(|e| e.error)
                .unwrap_or_else(|| error_text.clone());

            // Send Error FIRST, then DoneWithDebug so the UI always has the debug context.
            let _ = token_sender.send(StreamEvent::Error(error_msg.clone())).await;
            let _ = token_sender
                .send(StreamEvent::DoneWithDebug {
                    content: String::new(),
                    thinking: None,
                    debug_info: Some(debug_info),
                    usage: None,
                })
                .await;
            return Err(match status_code {
                401 | 403 => AiError::AuthenticationFailed(error_msg),
                429 => AiError::RateLimited(error_msg),
                _ => AiError::RequestFailed(error_msg),
            });
        }

        let mut full_content = String::new();
        let mut stream = response.bytes_stream();
        // Ollama 返回的是 NDJSON；同样可能在任意字节边界切片，需做行缓冲避免 JSON 被拆分。
        let mut line_buffer = String::new();
        let mut utf8 = Utf8StreamDecoder::default();
        let mut chunk_count: u32 = 0;
        let mut line_count: u32 = 0;
        let mut last_line: Option<String> = None;

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(v) => v,
                Err(e) => {
                    let stream_ctx = StreamProtocolContext {
                        expected_protocol: Some("ndjson_field (JSON per line)".to_string()),
                        expected_signal: Some("done=true".to_string()),
                        observed_signal: None,
                        last_event_type: None,
                        last_data_snippet: last_line.clone(),
                        buffer_tail: Some(line_buffer.clone()),
                        chunks_received: Some(chunk_count),
                        events_received: Some(line_count),
                    };
                    let details = format_reqwest_stream_error(
                        &config.provider,
                        &config.model,
                        Some(&url),
                        Some(status_code),
                        Some(&response_headers),
                        &e,
                        Some(&stream_ctx),
                    );
                    let error_text = summarize_reqwest_stream_error(&e);
                    let facts = summarize_reqwest_error(&e);

                    let debug_info = DebugInfoData {
                        request: Some(debug_request.clone()),
                        response: Some(DebugResponseData {
                            status: status_code,
                            headers: response_headers.clone(),
                            body: serde_json::json!({
                                "_streamError": error_text,
                                "_streamErrorDetails": details,
                                "_streamErrorSummary": serde_json::to_value(&facts).unwrap_or(serde_json::Value::Null),
                                "message": {
                                    "role": "assistant",
                                    "content": full_content.clone()
                                },
                                "done": false
                            }),
                        }),
                        stream_termination: Some(StreamTerminationInfo {
                            protocol_complete: Some(false),
                            termination_source: Some(StreamTerminationSource::Unknown),
                            protocol_kind: Some("ndjson_field".to_string()),
                            expected_signal: Some("done=true".to_string()),
                            observed_signal: None,
                            last_event_type: Some("transport_error".to_string()),
                            chunk_count: Some(chunk_count),
                        }),
                    };

                    let _ = token_sender
                        .send(StreamEvent::Error(error_text.clone()))
                        .await;
                    let _ = token_sender
                        .send(StreamEvent::DoneWithDebug {
                            content: full_content.clone(),
                            thinking: None,
                            debug_info: Some(debug_info),
                            usage: None,
                        })
                        .await;
                    return Err(AiError::StreamError(error_text));
                }
            };
            let chunk_str = utf8.push(&chunk);
            chunk_count = chunk_count.saturating_add(1);
            line_buffer.push_str(&chunk_str);

            // Ollama sends newline-delimited JSON
            while let Some(pos) = line_buffer.find('\n') {
                let mut line = line_buffer[..pos].to_string();
                line_buffer.drain(..pos + 1);
                if line.ends_with('\r') {
                    line.pop();
                }

                if line.trim().is_empty() {
                    continue;
                }

                line_count = line_count.saturating_add(1);
                last_line = Some(line.chars().take(1200).collect::<String>());

                if let Ok(stream_response) = serde_json::from_str::<StreamResponse>(&line) {
                    if let Some(message) = stream_response.message {
                        if !message.content.is_empty() {
                            full_content.push_str(&message.content);
                            let _ = token_sender.send(StreamEvent::Token(message.content)).await;
                        }
                    }

                    if stream_response.done {
                        let debug_info = DebugInfoData {
                            request: Some(debug_request.clone()),
                            response: Some(DebugResponseData {
                                status: status_code,
                                headers: response_headers.clone(),
                                body: serde_json::json!({
                                    "message": {
                                        "role": "assistant",
                                        "content": full_content.clone()
                                    },
                                    "done": true,
                                    "thinking": serde_json::Value::Null
                                }),
                            }),
                            stream_termination: Some(StreamTerminationInfo {
                                protocol_complete: Some(true),
                                termination_source: Some(StreamTerminationSource::ProtocolSignal),
                                protocol_kind: Some("ndjson_field".to_string()),
                                expected_signal: Some("done=true".to_string()),
                                observed_signal: Some("done=true".to_string()),
                                last_event_type: Some("done".to_string()),
                                chunk_count: Some(chunk_count),
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
                }
            }
        }

        // Flush the last partial line if it exists
        let tail = line_buffer.trim();
        if !tail.is_empty() {
            if let Ok(stream_response) = serde_json::from_str::<StreamResponse>(tail) {
                if let Some(message) = stream_response.message {
                    if !message.content.is_empty() {
                        full_content.push_str(&message.content);
                        let _ = token_sender.send(StreamEvent::Token(message.content)).await;
                    }
                }
            }
        }

        let debug_info = DebugInfoData {
            request: Some(debug_request),
            response: Some(DebugResponseData {
                status: status_code,
                headers: response_headers,
                body: serde_json::json!({
                    "message": {
                        "role": "assistant",
                        "content": full_content.clone()
                    },
                    "done": true,
                    "thinking": serde_json::Value::Null,
                    "_ndjsonInfo": {
                        "note": "NDJSON stream ended without an explicit done=true line"
                    }
                }),
            }),
            stream_termination: Some(StreamTerminationInfo {
                protocol_complete: Some(false),
                termination_source: Some(StreamTerminationSource::EofFallback),
                protocol_kind: Some("ndjson_field".to_string()),
                expected_signal: Some("done=true".to_string()),
                observed_signal: None,
                last_event_type: Some("stream_eof".to_string()),
                chunk_count: Some(chunk_count),
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
