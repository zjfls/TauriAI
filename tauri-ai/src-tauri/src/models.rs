//! Data models for TauriAI
//!
//! This module contains all the core data structures used throughout the application.

use crate::prompts::FormatPromptType;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Role of a message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

// ============================================================================
// Multimodal Content Types
// ============================================================================

/// Image detail level for vision models
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageDetail {
    #[default]
    Auto,
    Low,
    High,
}

/// PDF single page data
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PdfPage {
    pub page_number: u32,
    pub text: String,
    pub image: String, // Base64 data URL
}

/// PDF metadata
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PdfMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
}

/// A single part of message content (text, image, text file, or PDF document)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    /// Text content
    Text { text: String },
    /// Image content (base64 data URL or HTTP URL)
    Image {
        url: String,
        #[serde(default)]
        detail: ImageDetail,
    },
    /// Text file content
    TextFile { filename: String, content: String },
    /// PDF document (multimodal: text + images)
    PdfDocument {
        filename: String,
        pages: Vec<PdfPage>,
        total_pages: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<PdfMetadata>,
    },
}

impl ContentPart {
    /// Create a text content part
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// Create an image content part from URL or base64 data
    pub fn image(url: impl Into<String>) -> Self {
        Self::Image {
            url: url.into(),
            detail: ImageDetail::Auto,
        }
    }

    /// Create an image content part with specific detail level
    pub fn image_with_detail(url: impl Into<String>, detail: ImageDetail) -> Self {
        Self::Image {
            url: url.into(),
            detail,
        }
    }

    /// Create a text file content part
    pub fn text_file(filename: impl Into<String>, content: impl Into<String>) -> Self {
        Self::TextFile {
            filename: filename.into(),
            content: content.into(),
        }
    }

    /// Create a PDF document content part
    pub fn pdf_document(
        filename: impl Into<String>,
        pages: Vec<PdfPage>,
        metadata: Option<PdfMetadata>,
    ) -> Self {
        let total_pages = pages.len() as u32;
        Self::PdfDocument {
            filename: filename.into(),
            pages,
            total_pages,
            metadata,
        }
    }
}

/// Metadata associated with a message
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MessageMeta {
    /// The model used to generate the response
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Number of tokens in the message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u32>,
    /// Duration in milliseconds to generate the response
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
}

/// Status of a message
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Pending,
    Success,
    Failed,
}

impl Default for MessageStatus {
    fn default() -> Self {
        Self::Success
    }
}

/// A single message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    /// Message content - can be plain text (String) or multimodal (Vec<ContentPart>)
    /// For backward compatibility, we store as String in DB but support both formats in API
    pub content: String,
    /// Multimodal content parts (images, etc.) - stored separately for DB compatibility
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_parts: Vec<ContentPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<MessageMeta>,
    pub created_at: DateTime<Utc>,
    /// Status of the message (pending, success, failed)
    #[serde(default)]
    pub status: MessageStatus,
    /// Optional error message if the status is Failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl Message {
    /// Check if this message contains images
    pub fn has_images(&self) -> bool {
        self.content_parts
            .iter()
            .any(|p| matches!(p, ContentPart::Image { .. }))
    }

    /// Check if this message contains multimodal content (images, text files, or PDF documents)
    pub fn has_multimodal_content(&self) -> bool {
        self.content_parts.iter().any(|p| {
            matches!(
                p,
                ContentPart::Image { .. }
                    | ContentPart::TextFile { .. }
                    | ContentPart::PdfDocument { .. }
            )
        })
    }

    /// Get all content parts, converting plain text content if needed
    pub fn get_content_parts(&self) -> Vec<ContentPart> {
        if self.content_parts.is_empty() {
            // Legacy: only text content
            vec![ContentPart::text(&self.content)]
        } else {
            self.content_parts.clone()
        }
    }
}

/// A conversation containing multiple messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// Agent name used for this conversation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Model reference (format: "provider_name/model_name")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ============================================================================
// New Provider-Model-Agent Architecture
// ============================================================================

/// Provider type for API compatibility
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderType {
    Openai,
    OpenaiCompatible,
    /// OpenAI Responses API for reasoning models (o1, o3, gpt-4.1)
    OpenaiResponses,
    Anthropic,
    Ollama,
}

impl Default for ProviderType {
    fn default() -> Self {
        Self::OpenaiCompatible
    }
}

impl Serialize for ProviderType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_client_str())
    }
}

impl<'de> Deserialize<'de> for ProviderType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "openai" => Self::Openai,
            "openai_responses" => Self::OpenaiResponses,
            "anthropic" => Self::Anthropic,
            "ollama" => Self::Ollama,
            // "openai_compatible" and any other value defaults to OpenaiCompatible
            _ => Self::OpenaiCompatible,
        })
    }
}

impl ProviderType {
    /// Convert to client provider string
    pub fn to_client_str(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::OpenaiCompatible => "openai_compatible",
            Self::OpenaiResponses => "openai_responses",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }
}

/// Model capabilities (what features the model supports)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    /// Whether the model supports thinking/reasoning (e.g., DeepSeek-R1, GLM-4.7)
    #[serde(default)]
    pub thinking: bool,
    /// Whether the model supports vision/image input
    #[serde(default)]
    pub vision: bool,
    /// Whether the model supports function calling
    #[serde(default)]
    pub function_calling: bool,
}

/// Model configuration (pure model parameters, no system prompt)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// Model name, e.g., "deepseek-v3", unique within provider
    pub name: String,
    pub temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    /// Maximum context length in tokens (e.g., 128000 for GPT-4o)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
    /// Model capabilities (auto-inferred if not set)
    #[serde(default)]
    pub capabilities: ModelCapabilities,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            name: String::new(),
            temperature: 0.7,
            max_tokens: None,
            top_p: None,
            context_length: None,
            capabilities: ModelCapabilities::default(),
        }
    }
}

/// Provider configuration (contains API info and models)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// Unique identifier, e.g., "siliconflow"
    pub name: String,
    /// Display name, e.g., "硅基流动"
    pub display_name: String,
    /// Provider type for API compatibility
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    /// API base URL
    pub api_base: String,
    /// API key (optional for local providers like Ollama)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Whether this provider is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Models available from this provider
    #[serde(default)]
    pub models: Vec<Model>,
}

fn default_true() -> bool {
    true
}

impl Default for Provider {
    fn default() -> Self {
        Self {
            name: String::new(),
            display_name: String::new(),
            provider_type: ProviderType::default(),
            api_base: String::new(),
            api_key: None,
            enabled: true,
            models: Vec::new(),
        }
    }
}

/// Agent configuration (references a model, contains system prompt)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// Unique identifier
    pub name: String,
    /// Display name
    pub display_name: String,
    /// Description of the agent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Model reference in format "provider_name/model_name"
    pub model_ref: String,
    /// System prompt for this agent
    #[serde(default)]
    pub system_prompt: String,
    /// Output format type
    #[serde(default)]
    pub format_type: FormatPromptType,
}

impl Default for Agent {
    fn default() -> Self {
        Self {
            name: String::new(),
            display_name: String::new(),
            description: None,
            model_ref: String::new(),
            system_prompt: String::new(),
            format_type: FormatPromptType::default(),
        }
    }
}

// ============================================================================
// Legacy types (kept for migration)
// ============================================================================

/// Parameters for model configuration (legacy)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParameters {
    pub temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

impl Default for ModelParameters {
    fn default() -> Self {
        Self {
            temperature: 0.7,
            max_tokens: None,
            top_p: None,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        }
    }
}

/// Configuration for an AI model (legacy)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub model: String,
    pub parameters: ModelParameters,
    /// Thinking level control for models that support it
    /// - None: Model doesn't support thinking, don't send thinking parameter
    /// - Some("disabled"): Explicitly disable thinking
    /// - Some("low" | "medium" | "high" | "very_high"): Enable with specific effort level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// Whether the model supports vision/image input
    #[serde(default)]
    pub vision_enabled: bool,
}

/// A preset combining model config and system prompt (legacy)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub model_config_id: String,
    pub system_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters_override: Option<ModelParameters>,
}

/// Appearance settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub theme: String,
    pub always_on_top: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            always_on_top: false,
        }
    }
}

/// General application settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub language: String,
    pub auto_start: bool,
    /// Enable debug mode to show raw HTTP messages
    #[serde(default)]
    pub debug_mode: bool,
    /// Show token usage in messages
    #[serde(default)]
    pub show_usage: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            language: "zh-CN".to_string(),
            auto_start: false,
            debug_mode: false,
            show_usage: true,
        }
    }
}

/// Application configuration (new structure)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub appearance: AppearanceSettings,
    pub general: GeneralSettings,
    /// AI service providers
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// AI agents
    #[serde(default)]
    pub agents: Vec<Agent>,
    /// Default agent name
    #[serde(default)]
    pub default_agent: String,
    /// Currently selected agent (runtime state)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_agent: Option<String>,
    /// Currently selected model ref (can differ from agent's default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model_ref: Option<String>,
    // Legacy fields for migration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<Preset>>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            appearance: AppearanceSettings::default(),
            general: GeneralSettings::default(),
            providers: Vec::new(),
            agents: Vec::new(),
            default_agent: String::new(),
            current_agent: None,
            current_model_ref: None,
            active_model_id: None,
            models: None,
            presets: None,
        }
    }
}

impl AppConfig {
    /// Check if config needs migration from legacy format
    pub fn needs_migration(&self) -> bool {
        self.models.is_some() && self.providers.is_empty()
    }

    /// Migrate from legacy format to new provider-model-agent structure
    pub fn migrate(&mut self) {
        if !self.needs_migration() {
            return;
        }

        let legacy_models = match self.models.take() {
            Some(m) => m,
            None => return,
        };

        // Group models by provider + apiBase
        use std::collections::HashMap;
        let mut provider_map: HashMap<(String, String), Provider> = HashMap::new();

        for model_config in &legacy_models {
            let api_base = model_config.api_base.clone().unwrap_or_default();
            let key = (model_config.provider.clone(), api_base.clone());

            let provider = provider_map.entry(key).or_insert_with(|| {
                let provider_type = match model_config.provider.as_str() {
                    "anthropic" => ProviderType::Anthropic,
                    "ollama" => ProviderType::Ollama,
                    _ => ProviderType::Openai,
                };
                Provider {
                    name: model_config.provider.clone(),
                    display_name: model_config.provider.clone(),
                    provider_type,
                    api_base,
                    api_key: model_config.api_key.clone(),
                    enabled: true,
                    models: Vec::new(),
                }
            });

            // Add model to provider
            provider.models.push(Model {
                name: model_config.model.clone(),
                temperature: model_config.parameters.temperature,
                max_tokens: model_config.parameters.max_tokens,
                top_p: model_config.parameters.top_p,
                context_length: None,
                capabilities: ModelCapabilities::default(),
            });

            // Create agent from model's system prompt
            let agent_name = format!("agent_{}", model_config.id);
            let model_ref = format!("{}/{}", model_config.provider, model_config.model);
            self.agents.push(Agent {
                name: agent_name.clone(),
                display_name: model_config.name.clone(),
                description: None,
                model_ref,
                system_prompt: model_config
                    .parameters
                    .system_prompt
                    .clone()
                    .unwrap_or_default(),
                format_type: FormatPromptType::Chat,
            });

            // Set default agent
            if self.active_model_id.as_ref() == Some(&model_config.id) {
                self.default_agent = agent_name;
            }
        }

        self.providers = provider_map.into_values().collect();
        self.active_model_id = None;
        self.presets = None;
    }

    /// Get provider by name
    pub fn get_provider(&self, name: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.name == name)
    }

    /// Get agent by name
    pub fn get_agent(&self, name: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.name == name)
    }

    /// Get default agent
    pub fn get_default_agent(&self) -> Option<&Agent> {
        if self.default_agent.is_empty() {
            self.agents.first()
        } else {
            self.get_agent(&self.default_agent)
        }
    }

    /// Parse model reference "provider/model" into (provider_name, model_name)
    pub fn parse_model_ref(model_ref: &str) -> Option<(&str, &str)> {
        let parts: Vec<&str> = model_ref.splitn(2, '/').collect();
        if parts.len() == 2 {
            Some((parts[0], parts[1]))
        } else {
            None
        }
    }

    /// Resolve agent to provider and model
    pub fn resolve_agent(&self, agent_name: &str) -> Option<(&Provider, &Model, &Agent)> {
        let agent = self.get_agent(agent_name)?;
        let (provider_name, model_name) = Self::parse_model_ref(&agent.model_ref)?;
        let provider = self.get_provider(provider_name)?;
        let model = provider.models.iter().find(|m| m.name == model_name)?;
        Some((provider, model, agent))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy for generating arbitrary ContentPart::TextFile
    fn arb_text_file() -> impl Strategy<Value = ContentPart> {
        // Generate non-empty strings for filename and content
        ("[a-zA-Z0-9_.-]{1,50}", ".*")
            .prop_map(|(filename, content)| ContentPart::text_file(filename, content))
    }

    /// Strategy for generating arbitrary PdfPage
    fn arb_pdf_page() -> impl Strategy<Value = PdfPage> {
        (1u32..100u32, ".*", "data:image/png;base64,[a-zA-Z0-9+/=]{10,100}")
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
            opt.map(|(title, author, created_at, producer, subject, keywords)| PdfMetadata {
                title,
                author,
                created_at,
                producer,
                subject,
                keywords,
            })
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
        /// **Property 7: ContentPart Serialization Round-Trip**
        /// *For any* valid ContentPart::TextFile with arbitrary filename and content,
        /// serializing to JSON and then deserializing SHALL produce an equivalent
        /// ContentPart with the same filename and content.
        /// **Validates: Requirements 6.2, 6.3, 6.4**
        #[test]
        fn prop_content_part_text_file_roundtrip(part in arb_text_file()) {
            // Serialize to JSON
            let json = serde_json::to_string(&part).expect("Serialization should succeed");

            // Verify JSON contains correct tag
            prop_assert!(json.contains(r#""type":"text_file""#), "JSON should contain text_file type tag");

            // Deserialize back
            let deserialized: ContentPart = serde_json::from_str(&json).expect("Deserialization should succeed");

            // Verify round-trip equality
            prop_assert_eq!(part, deserialized, "Round-trip should preserve ContentPart");
        }

        /// **Property 1: PdfDocument Serialization Round-Trip**
        /// *For any* valid ContentPart::PdfDocument with arbitrary filename, pages, and metadata,
        /// serializing to JSON and then deserializing SHALL produce an equivalent
        /// ContentPart with the same filename, pages, total_pages, and metadata.
        /// **Validates: Requirements 8.2, 8.3**
        #[test]
        fn prop_content_part_pdf_document_roundtrip(part in arb_pdf_document()) {
            // Serialize to JSON
            let json = serde_json::to_string(&part).expect("Serialization should succeed");

            // Verify JSON contains correct tag
            prop_assert!(json.contains(r#""type":"pdf_document""#), "JSON should contain pdf_document type tag");

            // Deserialize back
            let deserialized: ContentPart = serde_json::from_str(&json).expect("Deserialization should succeed");

            // Verify round-trip equality
            prop_assert_eq!(&part, &deserialized, "Round-trip should preserve PdfDocument ContentPart");

            // Additional verification for PdfDocument-specific fields
            if let ContentPart::PdfDocument { filename, pages, total_pages, metadata } = &part {
                if let ContentPart::PdfDocument { 
                    filename: d_filename, 
                    pages: d_pages, 
                    total_pages: d_total_pages, 
                    metadata: d_metadata 
                } = &deserialized {
                    prop_assert_eq!(filename, d_filename, "Filename should be preserved");
                    prop_assert_eq!(pages.len(), d_pages.len(), "Number of pages should be preserved");
                    prop_assert_eq!(total_pages, d_total_pages, "Total pages should be preserved");
                    prop_assert_eq!(*total_pages, pages.len() as u32, "Total pages should match pages vector length");
                    prop_assert_eq!(metadata, d_metadata, "Metadata should be preserved");
                    
                    // Verify each page
                    for (i, (page, d_page)) in pages.iter().zip(d_pages.iter()).enumerate() {
                        prop_assert_eq!(page.page_number, d_page.page_number, "Page {} number should be preserved", i);
                        prop_assert_eq!(&page.text, &d_page.text, "Page {} text should be preserved", i);
                        prop_assert_eq!(&page.image, &d_page.image, "Page {} image should be preserved", i);
                    }
                }
            }
        }
    }

    #[test]
    fn test_text_file_serialization_format() {
        let part = ContentPart::text_file("test.txt", "Hello, World!");
        let json = serde_json::to_string(&part).unwrap();

        // Verify JSON structure
        assert!(json.contains(r#""type":"text_file""#));
        assert!(json.contains(r#""filename":"test.txt""#));
        assert!(json.contains(r#""content":"Hello, World!""#));
    }

    #[test]
    fn test_text_file_deserialization() {
        let json =
            r#"{"type":"text_file","filename":"config.json","content":"{\"key\":\"value\"}"}"#;
        let part: ContentPart = serde_json::from_str(json).unwrap();

        match part {
            ContentPart::TextFile { filename, content } => {
                assert_eq!(filename, "config.json");
                assert_eq!(content, r#"{"key":"value"}"#);
            }
            _ => panic!("Expected TextFile variant"),
        }
    }

    #[test]
    fn test_has_multimodal_content() {
        use chrono::Utc;

        // Test with only text content
        let text_only_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Hello".to_string(),
            content_parts: vec![],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(!text_only_message.has_multimodal_content());
        assert!(!text_only_message.has_images());

        // Test with text file
        let text_file_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze this file".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze this file"),
                ContentPart::text_file("main.rs", "fn main() {}"),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(text_file_message.has_multimodal_content());
        assert!(!text_file_message.has_images());

        // Test with image
        let image_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Look at this".to_string(),
            content_parts: vec![
                ContentPart::text("Look at this"),
                ContentPart::image("data:image/png;base64,..."),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(image_message.has_multimodal_content());
        assert!(image_message.has_images());

        // Test with both image and text file
        let mixed_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze both".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze both"),
                ContentPart::image("data:image/png;base64,..."),
                ContentPart::text_file("config.json", r#"{"key": "value"}"#),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(mixed_message.has_multimodal_content());
        assert!(mixed_message.has_images());

        // Test with PDF document
        let pdf_message = Message {
            id: "test".to_string(),
            conversation_id: "conv".to_string(),
            role: MessageRole::User,
            content: "Analyze this PDF".to_string(),
            content_parts: vec![
                ContentPart::text("Analyze this PDF"),
                ContentPart::pdf_document(
                    "report.pdf",
                    vec![PdfPage {
                        page_number: 1,
                        text: "Page 1 content".to_string(),
                        image: "data:image/png;base64,iVBORw0KG...".to_string(),
                    }],
                    None,
                ),
            ],
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        assert!(pdf_message.has_multimodal_content());
        assert!(!pdf_message.has_images()); // PDF pages contain images but not direct Image ContentParts
    }

    #[test]
    fn test_pdf_document_constructor() {
        let pages = vec![
            PdfPage {
                page_number: 1,
                text: "First page".to_string(),
                image: "data:image/png;base64,page1".to_string(),
            },
            PdfPage {
                page_number: 2,
                text: "Second page".to_string(),
                image: "data:image/png;base64,page2".to_string(),
            },
        ];

        let metadata = Some(PdfMetadata {
            title: Some("Test Document".to_string()),
            author: Some("Test Author".to_string()),
            created_at: Some("2024-01-01".to_string()),
            producer: None,
            subject: None,
            keywords: None,
        });

        let part = ContentPart::pdf_document("test.pdf", pages.clone(), metadata.clone());

        match part {
            ContentPart::PdfDocument {
                filename,
                pages: pdf_pages,
                total_pages,
                metadata: pdf_metadata,
            } => {
                assert_eq!(filename, "test.pdf");
                assert_eq!(total_pages, 2);
                assert_eq!(pdf_pages.len(), 2);
                assert_eq!(pdf_pages[0].page_number, 1);
                assert_eq!(pdf_pages[0].text, "First page");
                assert_eq!(pdf_pages[1].page_number, 2);
                assert_eq!(pdf_pages[1].text, "Second page");
                assert!(pdf_metadata.is_some());
                let meta = pdf_metadata.unwrap();
                assert_eq!(meta.title, Some("Test Document".to_string()));
                assert_eq!(meta.author, Some("Test Author".to_string()));
            }
            _ => panic!("Expected PdfDocument variant"),
        }
    }

    #[test]
    fn test_pdf_document_serialization_format() {
        let pages = vec![PdfPage {
            page_number: 1,
            text: "Test content".to_string(),
            image: "data:image/png;base64,test".to_string(),
        }];

        let part = ContentPart::pdf_document("document.pdf", pages, None);
        let json = serde_json::to_string(&part).unwrap();

        // Verify JSON structure
        assert!(json.contains(r#""type":"pdf_document""#));
        assert!(json.contains(r#""filename":"document.pdf""#));
        assert!(json.contains(r#""total_pages":1"#));
        assert!(json.contains(r#""page_number":1"#));
        assert!(json.contains(r#""text":"Test content""#));
    }

    #[test]
    fn test_pdf_document_deserialization() {
        let json = r#"{
            "type": "pdf_document",
            "filename": "test.pdf",
            "pages": [
                {
                    "page_number": 1,
                    "text": "Page 1",
                    "image": "data:image/png;base64,abc"
                }
            ],
            "total_pages": 1
        }"#;

        let part: ContentPart = serde_json::from_str(json).unwrap();

        match part {
            ContentPart::PdfDocument {
                filename,
                pages,
                total_pages,
                metadata,
            } => {
                assert_eq!(filename, "test.pdf");
                assert_eq!(total_pages, 1);
                assert_eq!(pages.len(), 1);
                assert_eq!(pages[0].page_number, 1);
                assert_eq!(pages[0].text, "Page 1");
                assert_eq!(pages[0].image, "data:image/png;base64,abc");
                assert!(metadata.is_none());
            }
            _ => panic!("Expected PdfDocument variant"),
        }
    }

    #[test]
    fn test_pdf_document_with_metadata_serialization() {
        let pages = vec![PdfPage {
            page_number: 1,
            text: "Content".to_string(),
            image: "data:image/png;base64,img".to_string(),
        }];

        let metadata = Some(PdfMetadata {
            title: Some("My Document".to_string()),
            author: Some("John Doe".to_string()),
            created_at: Some("2024-01-15".to_string()),
            producer: Some("PDF Generator".to_string()),
            subject: Some("Test Subject".to_string()),
            keywords: Some("test, pdf".to_string()),
        });

        let part = ContentPart::pdf_document("doc.pdf", pages, metadata);
        let json = serde_json::to_string(&part).unwrap();

        // Verify metadata is included
        assert!(json.contains(r#""title":"My Document""#));
        assert!(json.contains(r#""author":"John Doe""#));
        assert!(json.contains(r#""created_at":"2024-01-15""#));

        // Deserialize and verify
        let deserialized: ContentPart = serde_json::from_str(&json).unwrap();
        assert_eq!(part, deserialized);
    }
}
