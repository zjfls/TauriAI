//! Configuration module for TauriAI
//!
//! This module handles loading and saving application configuration
//! from ~/.tauri-ai/config.json.

use std::fs;
use std::path::PathBuf;
use thiserror::Error;

use crate::models::AppConfig;

/// Errors that can occur during configuration operations
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("IO error: {0}")]
    Io(String),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Home directory not found")]
    HomeDirNotFound,
}

impl From<std::io::Error> for ConfigError {
    fn from(err: std::io::Error) -> Self {
        ConfigError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for ConfigError {
    fn from(err: serde_json::Error) -> Self {
        ConfigError::Parse(err.to_string())
    }
}

/// Configuration manager for TauriAI
///
/// Handles loading, saving, and managing application configuration
/// stored at ~/.tauri-ai/config.json
pub struct ConfigManager {
    config_path: PathBuf,
}

impl ConfigManager {
    /// Creates a new ConfigManager with the default config path (~/.tauri-ai/config.json)
    pub fn new() -> Result<Self, ConfigError> {
        let config_path = Self::default_config_path()?;
        Ok(Self { config_path })
    }

    /// Creates a new ConfigManager with a custom config path
    pub fn with_path(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    /// Returns the default configuration file path (~/.tauri-ai/config.json)
    fn default_config_path() -> Result<PathBuf, ConfigError> {
        let home_dir = dirs::home_dir().ok_or(ConfigError::HomeDirNotFound)?;
        Ok(home_dir.join(".tauri-ai").join("config.json"))
    }

    /// Returns the path to the configuration file
    pub fn config_path(&self) -> &PathBuf {
        &self.config_path
    }

    /// Loads the configuration from the config file
    ///
    /// Returns an error if the file doesn't exist or cannot be parsed.
    /// Use `ensure_default()` to create a default config if it doesn't exist.
    pub fn load(&self) -> Result<AppConfig, ConfigError> {
        let content = fs::read_to_string(&self.config_path)?;
        let config: AppConfig = serde_json::from_str(&content)?;
        Ok(config)
    }

    /// Saves the configuration to the config file
    ///
    /// Creates the parent directory if it doesn't exist.
    pub fn save(&self, config: &AppConfig) -> Result<(), ConfigError> {
        // Ensure parent directory exists
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(config)?;
        fs::write(&self.config_path, content)?;
        Ok(())
    }

    /// Ensures a configuration file exists, creating a default one if necessary
    ///
    /// If the config file exists, loads and returns it.
    /// If it doesn't exist, creates a default configuration, saves it, and returns it.
    pub fn ensure_default(&self) -> Result<AppConfig, ConfigError> {
        if self.config_path.exists() {
            let mut config = self.load()?;
            let mut changed = false;

            // Auto-migrate if needed
            if config.needs_migration() {
                config.migrate();
                changed = true;
            }

            // Ensure new defaults / shape are present (e.g. security policies)
            if config.normalize() {
                changed = true;
            }

            if changed {
                self.save(&config)?;
            }
            Ok(config)
        } else {
            let mut config = Self::create_default_config();
            let _ = config.normalize();
            self.save(&config)?;
            Ok(config)
        }
    }

    /// Creates a default application configuration
    fn create_default_config() -> AppConfig {
        AppConfig::default()
    }
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new().expect("Failed to create default ConfigManager")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_config_manager() -> (ConfigManager, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.json");
        let manager = ConfigManager::with_path(config_path);
        (manager, temp_dir)
    }

    #[test]
    fn test_ensure_default_creates_config() {
        let (manager, _temp_dir) = create_test_config_manager();

        // Config file should not exist initially
        assert!(!manager.config_path().exists());

        // ensure_default should create the config
        let config = manager.ensure_default().unwrap();

        // Config file should now exist
        assert!(manager.config_path().exists());

        // Should be empty initially
        assert!(config.providers.is_empty());
        // normalize() 会注入系统内置的 Workspace 默认 agent/toolset，使 Workstudio 功能在用户未配置前可用。
        assert!(!config.agents.is_empty());
        assert!(
            config
                .agents
                .iter()
                .any(|a| a.name == "__system_symbol_analysis"),
            "missing __system_symbol_analysis system agent"
        );
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        use crate::models::{Agent, Model, Provider, ProviderType};
        use crate::prompts::FormatPromptType;

        let (manager, _temp_dir) = create_test_config_manager();

        let config = AppConfig {
            providers: vec![Provider {
                name: "test-provider".to_string(),
                display_name: "Test Provider".to_string(),
                provider_type: ProviderType::OpenaiCompatible,
                api_base: "https://api.example.com".to_string(),
                api_key: Some("test-key".to_string()),
                enabled: true,
                models: vec![Model {
                    name: "gpt-4".to_string(),
                    temperature: 0.5,
                    temperature_enabled: true,
                    max_tokens: Some(1000),
                    top_p: Some(0.9),
                    top_p_enabled: true,
                    context_length: Some(8192),
                    capabilities: crate::models::ModelCapabilities::default(),
                    retry_attempts: None,
                    resume_partial_output: false,
                    max_images: None,
                    thinking_budget_tokens: None,
                    use_reasoning_effort: None,
                    reinject_reasoning_content: false,
                }],
            }],
            agents: vec![Agent {
                name: "test-agent".to_string(),
                enabled: true,
                agent_type: crate::models::AgentType::Chat,
                display_name: "Test Agent".to_string(),
                description: Some("A test agent".to_string()),
                model_ref: "test-provider/gpt-4".to_string(),
                system_prompt: "You are a helpful assistant.".to_string(),
                format_type: FormatPromptType::Chat,
                default_run_mode: None,
                toolset: None,
                mcp_set: None,
                skill_set: None,
                security_policy: None,
                sandbox_policy: None,
                approval_policy: None,
                workspace_support: None,
                max_turns: None,
                reinject_thinking: false,
                context_policy: None,
                workstudio_enabled: None,
            }],
            default_agent: "test-agent".to_string(),
            ..Default::default()
        };

        // Save the config
        manager.save(&config).unwrap();

        // Load it back
        let loaded_config = manager.load().unwrap();

        // Verify the loaded config matches
        assert_eq!(loaded_config.providers.len(), 1);
        assert_eq!(loaded_config.providers[0].name, "test-provider");
        assert_eq!(loaded_config.agents.len(), 1);
        assert_eq!(loaded_config.agents[0].name, "test-agent");
        assert_eq!(loaded_config.default_agent, "test-agent");
    }

    #[test]
    fn test_load_nonexistent_file_returns_error() {
        let (manager, _temp_dir) = create_test_config_manager();

        let result = manager.load();
        assert!(result.is_err());
    }

    #[test]
    fn test_ensure_default_loads_existing_config() {
        let (manager, _temp_dir) = create_test_config_manager();

        // Create a custom config first
        let custom_config = AppConfig {
            default_agent: "custom-agent".to_string(),
            ..Default::default()
        };
        manager.save(&custom_config).unwrap();

        // ensure_default should load the existing config, not create a new one
        let loaded = manager.ensure_default().unwrap();
        assert_eq!(loaded.default_agent, "custom-agent");
    }

    #[test]
    fn test_save_creates_parent_directories() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir
            .path()
            .join("nested")
            .join("dir")
            .join("config.json");
        let manager = ConfigManager::with_path(config_path.clone());

        let config = AppConfig::default();
        manager.save(&config).unwrap();

        assert!(config_path.exists());
    }
}
