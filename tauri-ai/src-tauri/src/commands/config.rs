//! Configuration commands for TauriAI
//!
//! This module contains Tauri commands for managing application configuration
//! including loading, saving, and testing AI provider connections.

use std::sync::Arc;

use crate::ai_client::get_client;
use crate::config::ConfigManager;
use crate::models::{AppConfig, Message, MessageRole, ModelConfig};

/// Get the current application configuration
#[tauri::command]
pub async fn get_app_config(
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<AppConfig, String> {
    config_manager.ensure_default().map_err(|e| e.to_string())
}

/// Save the application configuration
#[tauri::command]
pub async fn save_app_config(
    config: AppConfig,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    config_manager.save(&config).map_err(|e| e.to_string())
}

/// Test result for connection testing
#[derive(serde::Serialize)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub response_time_ms: Option<u64>,
}

/// Test a model configuration by sending a minimal request
#[tauri::command]
pub async fn test_connection(
    model_config: ModelConfig,
) -> Result<TestConnectionResult, String> {
    let client = get_client(&model_config.provider)
        .map_err(|e| e.to_string())?;

    // Create a minimal test message
    let test_message = Message {
        id: "test".to_string(),
        conversation_id: "test".to_string(),
        role: MessageRole::User,
        content: "Hi".to_string(),
        meta: None,
        created_at: chrono::Utc::now(),
    };

    let start = std::time::Instant::now();
    
    match client.chat(vec![test_message], &model_config).await {
        Ok(_) => {
            let elapsed = start.elapsed().as_millis() as u64;
            Ok(TestConnectionResult {
                success: true,
                message: "Connection successful".to_string(),
                response_time_ms: Some(elapsed),
            })
        }
        Err(e) => {
            Ok(TestConnectionResult {
                success: false,
                message: e.to_string(),
                response_time_ms: None,
            })
        }
    }
}
