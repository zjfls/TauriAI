//! Configuration commands for TauriAI
//!
//! This module contains Tauri commands for managing application configuration
//! including loading, saving, and testing AI provider connections.

use std::sync::Arc;

use crate::ai_client::get_client;
use crate::config::ConfigManager;
use crate::models::{AppConfig, Message, MessageRole, MessageStatus, ModelConfig, ModelParameters};

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
    provider_type: String,
    api_base: String,
    api_key: Option<String>,
    model_name: String,
) -> Result<TestConnectionResult, String> {
    println!(
        "[TestConnection] Testing provider: {}, model: {}",
        provider_type, model_name
    );

    let model_config = ModelConfig {
        id: "test".to_string(),
        name: "test".to_string(),
        provider: provider_type.clone(),
        api_base: Some(api_base),
        api_key,
        model: model_name,
        parameters: ModelParameters::default(),
        thinking_enabled: None, // Don't send thinking parameter for connection test
    };

    let client = get_client(&provider_type).map_err(|e| e.to_string())?;

    let test_message = Message {
        id: "test".to_string(),
        conversation_id: "test".to_string(),
        role: MessageRole::User,
        content: "Hi".to_string(),
        content_parts: Vec::new(),
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };

    let start = std::time::Instant::now();

    match client.chat(vec![test_message], &model_config).await {
        Ok(_) => {
            let elapsed = start.elapsed().as_millis() as u64;
            Ok(TestConnectionResult {
                success: true,
                message: "连接成功".to_string(),
                response_time_ms: Some(elapsed),
            })
        }
        Err(e) => Ok(TestConnectionResult {
            success: false,
            message: e.to_string(),
            response_time_ms: None,
        }),
    }
}

/// Model info returned from provider API
#[derive(serde::Serialize, serde::Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub owned_by: Option<String>,
}

/// Response from OpenAI-compatible /models endpoint
#[derive(serde::Deserialize)]
struct ModelsResponse {
    data: Vec<ModelData>,
}

#[derive(serde::Deserialize)]
struct ModelData {
    id: String,
    owned_by: Option<String>,
}

/// Fetch available models from a provider's API
#[tauri::command]
pub async fn fetch_provider_models(
    _provider_type: String,
    api_base: String,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    println!("[FetchModels] Fetching models from: {}", api_base);

    let client = reqwest::Client::new();

    let mut request = client.get(format!("{}/models", api_base));

    if let Some(key) = &api_key {
        if !key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", key));
        }
    }

    let response = request.send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("获取模型列表失败: {}", error_text));
    }

    let models_response: ModelsResponse = response.json().await.map_err(|e| e.to_string())?;

    let models: Vec<ModelInfo> = models_response
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id,
            owned_by: m.owned_by,
        })
        .collect();

    println!("[FetchModels] Found {} models", models.len());
    Ok(models)
}
