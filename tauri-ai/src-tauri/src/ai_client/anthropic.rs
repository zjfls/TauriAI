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
use crate::models::{ContentPart, Message, MessageRole, ModelConfig};

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
    /// Content can be a string or an array of content blocks for multimodal
    content: AnthropicContent,
}

/// Anthropic content format - either simple string or array of blocks
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnthropicContent {
    /// Simple text content
    Text(String),
    /// Multimodal content (text + images)
    Blocks(Vec<AnthropicContentBlock>),
}

/// A single content block for multimodal messages
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicContentBlock {
    /// Text content block
    Text { text: String },
    /// Image content block
    Image { source: ImageSource },
}

/// Image source data structure
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ImageSource {
    /// Base64 encoded image
    Base64 {
        media_type: String,
        data: String,
    },
    /// URL image (not supported by Anthropic, but kept for future)
    #[allow(dead_code)]
    Url {
        url: String,
    },
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

            // Check if message has multimodal content
            let content = if msg.has_multimodal_content() {
                // Convert to multimodal format
                let blocks: Vec<AnthropicContentBlock> = msg
                    .get_content_parts()
                    .into_iter()
                    .flat_map(|part| match part {
                        ContentPart::Text { text } => vec![AnthropicContentBlock::Text { text }],
                        ContentPart::Image { url, detail: _ } => {
                            // Parse data URL to extract media type and base64 data
                            if let Some((media_type, data)) = parse_data_url(&url) {
                                vec![AnthropicContentBlock::Image {
                                    source: ImageSource::Base64 { media_type, data },
                                }]
                            } else {
                                // If not a data URL, skip (Anthropic doesn't support URL images)
                                vec![]
                            }
                        }
                        ContentPart::TextFile { filename, content } => {
                            // Format text file as markdown code block
                            vec![AnthropicContentBlock::Text {
                                text: format!("📄 {}\n```\n{}\n```", filename, content),
                            }]
                        }
                        ContentPart::PdfDocument {
                            filename,
                            pages,
                            ..
                        } => {
                            // Convert PDF to alternating text and image blocks
                            pages
                                .into_iter()
                                .flat_map(|page| {
                                    let mut blocks = vec![AnthropicContentBlock::Text {
                                        text: format!(
                                            "📄 {} - 第{}页\n```\n{}\n```",
                                            filename, page.page_number, page.text
                                        ),
                                    }];
                                    
                                    // Add image block if we can parse the data URL
                                    if let Some((media_type, data)) = parse_data_url(&page.image) {
                                        blocks.push(AnthropicContentBlock::Image {
                                            source: ImageSource::Base64 { media_type, data },
                                        });
                                    }
                                    
                                    blocks
                                })
                                .collect()
                        }
                    })
                    .collect();
                AnthropicContent::Blocks(blocks)
            } else {
                // Simple text content
                AnthropicContent::Text(msg.content.clone())
            };

            AnthropicMessage {
                role: role.to_string(),
                content,
            }
        })
        .collect()
}

/// Parse data URL to extract media type and base64 data
/// Format: data:image/png;base64,iVBORw0KGgo...
fn parse_data_url(url: &str) -> Option<(String, String)> {
    if !url.starts_with("data:") {
        return None;
    }
    
    let url = url.strip_prefix("data:")?;
    let parts: Vec<&str> = url.splitn(2, ',').collect();
    if parts.len() != 2 {
        return None;
    }
    
    let header = parts[0];
    let data = parts[1];
    
    // Extract media type (before ;base64)
    let media_type = if let Some(semicolon_pos) = header.find(';') {
        &header[..semicolon_pos]
    } else {
        header
    };
    
    // Verify it's base64 encoded
    if !header.contains("base64") {
        return None;
    }
    
    Some((media_type.to_string(), data.to_string()))
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

        // Extract system prompt from config and messages (System role messages)
        // System prompt from config should come first
        let mut system_parts: Vec<String> = Vec::new();
        
        // First add system_prompt from config
        if let Some(config_prompt) = &config.parameters.system_prompt {
            if !config_prompt.is_empty() {
                system_parts.push(config_prompt.clone());
            }
        }
        
        // Then add any System role messages from the conversation
        for msg in &messages {
            if msg.role == MessageRole::System && !msg.content.is_empty() {
                system_parts.push(msg.content.clone());
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

        // Extract system prompt from config and messages (System role messages)
        // Anthropic API expects system prompt as a separate parameter, not in messages
        // System prompt from config should come first
        let mut system_parts: Vec<String> = Vec::new();

        // First add system_prompt from config
        if let Some(config_prompt) = &config.parameters.system_prompt {
            if !config_prompt.is_empty() {
                system_parts.push(config_prompt.clone());
            }
        }

        // Then add any System role messages from the conversation
        for msg in &messages {
            if msg.role == MessageRole::System && !msg.content.is_empty() {
                system_parts.push(msg.content.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{MessageStatus, PdfPage};
    use chrono::Utc;

    #[test]
    fn test_parse_data_url() {
        // Valid PNG data URL
        let url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA";
        let result = parse_data_url(url);
        assert!(result.is_some());
        let (media_type, data) = result.unwrap();
        assert_eq!(media_type, "image/png");
        assert_eq!(data, "iVBORw0KGgoAAAANSUhEUgAAAAUA");

        // Valid JPEG data URL
        let url = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
        let result = parse_data_url(url);
        assert!(result.is_some());
        let (media_type, data) = result.unwrap();
        assert_eq!(media_type, "image/jpeg");
        assert_eq!(data, "/9j/4AAQSkZJRgABAQAAAQABAAD");

        // Invalid: not a data URL
        let url = "https://example.com/image.png";
        assert!(parse_data_url(url).is_none());

        // Invalid: missing base64
        let url = "data:image/png,notbase64";
        assert!(parse_data_url(url).is_none());

        // Invalid: malformed
        let url = "data:image/png";
        assert!(parse_data_url(url).is_none());
    }

    #[test]
    fn test_convert_messages_text_only() {
        let messages = vec![Message {
            id: "1".to_string(),
            conversation_id: "conv1".to_string(),
            role: MessageRole::User,
            content: "Hello, world!".to_string(),
            content_parts: vec![],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }];

        let anthropic_messages = convert_messages(&messages);
        assert_eq!(anthropic_messages.len(), 1);
        assert_eq!(anthropic_messages[0].role, "user");
        
        // Check content is text
        match &anthropic_messages[0].content {
            AnthropicContent::Text(text) => {
                assert_eq!(text, "Hello, world!");
            }
            _ => panic!("Expected Text content"),
        }
    }

    #[test]
    fn test_convert_messages_with_image() {
        let messages = vec![Message {
            id: "1".to_string(),
            conversation_id: "conv1".to_string(),
            role: MessageRole::User,
            content: "Look at this".to_string(),
            content_parts: vec![
                ContentPart::text("Look at this"),
                ContentPart::image("data:image/png;base64,iVBORw0KGgo="),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }];

        let anthropic_messages = convert_messages(&messages);
        assert_eq!(anthropic_messages.len(), 1);
        
        // Check content is blocks
        match &anthropic_messages[0].content {
            AnthropicContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                
                // First block should be text
                match &blocks[0] {
                    AnthropicContentBlock::Text { text } => {
                        assert_eq!(text, "Look at this");
                    }
                    _ => panic!("Expected Text block"),
                }
                
                // Second block should be image
                match &blocks[1] {
                    AnthropicContentBlock::Image { source } => {
                        match source {
                            ImageSource::Base64 { media_type, data } => {
                                assert_eq!(media_type, "image/png");
                                assert_eq!(data, "iVBORw0KGgo=");
                            }
                            _ => panic!("Expected Base64 image source"),
                        }
                    }
                    _ => panic!("Expected Image block"),
                }
            }
            _ => panic!("Expected Blocks content"),
        }
    }

    #[test]
    fn test_convert_messages_with_text_file() {
        let messages = vec![Message {
            id: "1".to_string(),
            conversation_id: "conv1".to_string(),
            role: MessageRole::User,
            content: "Analyze this file".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze this file"),
                ContentPart::text_file("config.json", r#"{"key": "value"}"#),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }];

        let anthropic_messages = convert_messages(&messages);
        assert_eq!(anthropic_messages.len(), 1);
        
        match &anthropic_messages[0].content {
            AnthropicContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                
                // Second block should be formatted text file
                match &blocks[1] {
                    AnthropicContentBlock::Text { text } => {
                        assert!(text.contains("📄 config.json"));
                        assert!(text.contains(r#"{"key": "value"}"#));
                        assert!(text.contains("```"));
                    }
                    _ => panic!("Expected Text block"),
                }
            }
            _ => panic!("Expected Blocks content"),
        }
    }

    #[test]
    fn test_convert_messages_with_pdf() {
        let messages = vec![Message {
            id: "1".to_string(),
            conversation_id: "conv1".to_string(),
            role: MessageRole::User,
            content: "Analyze this PDF".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze this PDF"),
                ContentPart::pdf_document(
                    "report.pdf",
                    vec![
                        PdfPage {
                            page_number: 1,
                            text: "Page 1 content".to_string(),
                            image: "data:image/png;base64,page1data".to_string(),
                        },
                        PdfPage {
                            page_number: 2,
                            text: "Page 2 content".to_string(),
                            image: "data:image/png;base64,page2data".to_string(),
                        },
                    ],
                    None,
                ),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }];

        let anthropic_messages = convert_messages(&messages);
        assert_eq!(anthropic_messages.len(), 1);
        
        match &anthropic_messages[0].content {
            AnthropicContent::Blocks(blocks) => {
                // Should have: 1 initial text + (2 pages * 2 blocks each) = 5 blocks
                assert_eq!(blocks.len(), 5);
                
                // First block: initial text
                match &blocks[0] {
                    AnthropicContentBlock::Text { text } => {
                        assert_eq!(text, "Analyze this PDF");
                    }
                    _ => panic!("Expected Text block"),
                }
                
                // Second block: page 1 text
                match &blocks[1] {
                    AnthropicContentBlock::Text { text } => {
                        assert!(text.contains("📄 report.pdf - 第1页"));
                        assert!(text.contains("Page 1 content"));
                    }
                    _ => panic!("Expected Text block"),
                }
                
                // Third block: page 1 image
                match &blocks[2] {
                    AnthropicContentBlock::Image { source } => {
                        match source {
                            ImageSource::Base64 { media_type, data } => {
                                assert_eq!(media_type, "image/png");
                                assert_eq!(data, "page1data");
                            }
                            _ => panic!("Expected Base64 image source"),
                        }
                    }
                    _ => panic!("Expected Image block"),
                }
                
                // Fourth block: page 2 text
                match &blocks[3] {
                    AnthropicContentBlock::Text { text } => {
                        assert!(text.contains("📄 report.pdf - 第2页"));
                        assert!(text.contains("Page 2 content"));
                    }
                    _ => panic!("Expected Text block"),
                }
                
                // Fifth block: page 2 image
                match &blocks[4] {
                    AnthropicContentBlock::Image { source } => {
                        match source {
                            ImageSource::Base64 { media_type, data } => {
                                assert_eq!(media_type, "image/png");
                                assert_eq!(data, "page2data");
                            }
                            _ => panic!("Expected Base64 image source"),
                        }
                    }
                    _ => panic!("Expected Image block"),
                }
            }
            _ => panic!("Expected Blocks content"),
        }
    }

    #[test]
    fn test_convert_messages_filters_system_role() {
        let messages = vec![
            Message {
                id: "1".to_string(),
                conversation_id: "conv1".to_string(),
                role: MessageRole::System,
                content: "You are a helpful assistant".to_string(),
                content_parts: vec![],
                meta: None,
                created_at: Utc::now(),
                status: MessageStatus::Success,
                error_message: None,
            },
            Message {
                id: "2".to_string(),
                conversation_id: "conv1".to_string(),
                role: MessageRole::User,
                content: "Hello".to_string(),
                content_parts: vec![],
                meta: None,
                created_at: Utc::now(),
                status: MessageStatus::Success,
                error_message: None,
            },
        ];

        let anthropic_messages = convert_messages(&messages);
        // System message should be filtered out
        assert_eq!(anthropic_messages.len(), 1);
        assert_eq!(anthropic_messages[0].role, "user");
    }
}
