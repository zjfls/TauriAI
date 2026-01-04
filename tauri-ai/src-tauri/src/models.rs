//! Data models for TauriAI
//!
//! This module contains all the core data structures used throughout the application.

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

/// A single message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<MessageMeta>,
    pub created_at: DateTime<Utc>,
}

/// A conversation containing multiple messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Parameters for model configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Configuration for an AI model
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// A preset combining model config and system prompt
#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct GeneralSettings {
    pub language: String,
    pub auto_start: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            language: "en".to_string(),
            auto_start: false,
        }
    }
}

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub appearance: AppearanceSettings,
    pub general: GeneralSettings,
    pub active_model_id: String,
    pub models: Vec<ModelConfig>,
    pub presets: Vec<Preset>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            appearance: AppearanceSettings::default(),
            general: GeneralSettings::default(),
            active_model_id: String::new(),
            models: Vec::new(),
            presets: Vec::new(),
        }
    }
}
