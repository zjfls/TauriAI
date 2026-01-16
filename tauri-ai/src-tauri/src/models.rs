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
    pub content: String,
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

/// A conversation containing multiple messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// Agent name used for this conversation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
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
    /// Thinking mode control for models that support it
    /// - None: Model doesn't support thinking, don't send thinking parameter
    /// - Some(true): Enable thinking mode
    /// - Some(false): Disable thinking mode explicitly
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_enabled: Option<bool>,
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
