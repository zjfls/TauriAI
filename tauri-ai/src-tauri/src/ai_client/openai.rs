//! OpenAI API client implementation

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::traits::{AiClient, AiError, StreamEvent};
use crate::models::{Message, MessageRole, ModelConfig};

/// OpenAI API client
pub struct OpenAiClient {
    client: Client,
}

impl OpenAiClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl Default for OpenAiClient {
    fn default() -> Self {
        Self::new()
    }
}

/// OpenAI chat message format
#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: String,
    content: String,
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
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

/// OpenAI error response
#[derive(Debug, Deserialize)]
struct OpenAiErrorResponse {
    error: OpenAiErrorDetail,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorDetail {
    message: String,
    #[serde(rename = "type")]
    error_type: Option<String>,
}

fn convert_messages(messages: &[Message], system_prompt: Option<&str>) -> Vec<OpenAiMessage> {
    let mut result = Vec::new();

    // Add system prompt if provided
    if let Some(prompt) = system_prompt {
        result.push(OpenAiMessage {
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
        };
        result.push(OpenAiMessage {
            role: role.to_string(),
            content: msg.content.clone(),
        });
    }

    result
}


#[async_trait]
impl AiClient for OpenAiClient {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
    ) -> Result<String, AiError> {
        let api_base = config
            .api_base
            .as_deref()
            .unwrap_or("https://api.openai.com/v1");
        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::AuthenticationFailed("API key is required".to_string()))?;

        let openai_messages = convert_messages(&messages, config.parameters.system_prompt.as_deref());

        let request = ChatCompletionRequest {
            model: config.model.clone(),
            messages: openai_messages,
            temperature: Some(config.parameters.temperature),
            max_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            frequency_penalty: config.parameters.frequency_penalty,
            presence_penalty: config.parameters.presence_penalty,
            stream: false,
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

        let openai_messages = convert_messages(&messages, config.parameters.system_prompt.as_deref());

        let request = ChatCompletionRequest {
            model: config.model.clone(),
            messages: openai_messages,
            temperature: Some(config.parameters.temperature),
            max_tokens: config.parameters.max_tokens,
            top_p: config.parameters.top_p,
            frequency_penalty: config.parameters.frequency_penalty,
            presence_penalty: config.parameters.presence_penalty,
            stream: true,
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
                    if data.trim() == "[DONE]" {
                        let _ = token_sender.send(StreamEvent::Done(full_content.clone())).await;
                        return Ok(());
                    }

                    if let Ok(stream_chunk) = serde_json::from_str::<StreamChunk>(data) {
                        if let Some(choice) = stream_chunk.choices.first() {
                            if let Some(content) = &choice.delta.content {
                                full_content.push_str(content);
                                let _ = token_sender.send(StreamEvent::Token(content.clone())).await;
                            }
                        }
                    }
                }
            }
        }

        let _ = token_sender.send(StreamEvent::Done(full_content)).await;
        Ok(())
    }
}
