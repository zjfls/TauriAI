//! Conversation commands for TauriAI

use crate::models::{
    Conversation, Message, MessageRole, MessageStatus, ModelConfig, ModelParameters,
};
use crate::storage::Database;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn get_conversations(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Conversation>, String> {
    let db = db.lock().await;
    db.get_conversations().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_messages(
    conversation_id: String,
    limit: Option<usize>,
    before_id: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Message>, String> {
    let db = db.lock().await;
    db.get_messages(&conversation_id, limit.unwrap_or(50), before_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    title: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Conversation, String> {
    let db = db.lock().await;
    db.create_conversation(&title.unwrap_or_else(|| "New Conversation".to_string()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.delete_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_messages_from(
    conversation_id: String,
    message_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.delete_messages_after(&conversation_id, &message_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation_title(
    conversation_id: String,
    title: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.update_conversation_title(&conversation_id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation_metadata(
    conversation_id: String,
    agent_name: Option<String>,
    model_ref: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.update_conversation_metadata(
        &conversation_id,
        agent_name.as_deref(),
        model_ref.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_title(
    conversation_id: String,
    messages: Vec<Message>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<crate::config::ConfigManager>>,
) -> Result<String, String> {
    use crate::ai_client::get_client;

    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let (provider, model, _) = config
        .get_default_agent()
        .and_then(|a| config.resolve_agent(&a.name))
        .ok_or("No agent configured")?;

    let model_config = ModelConfig {
        id: format!("{}/{}", provider.name, model.name),
        name: model.name.clone(),
        provider: provider.provider_type.to_client_str().to_string(),
        api_base: Some(provider.api_base.clone()),
        api_key: provider.api_key.clone(),
        model: model.name.clone(),
        parameters: ModelParameters {
            temperature: model.temperature,
            max_tokens: model.max_tokens,
            top_p: model.top_p,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        },
        thinking_level: None, // Don't use thinking for title generation
        thinking_budget_tokens: None,
        vision_enabled: false, // Don't need vision for title generation
        max_images: None, // Not needed for title generation
    };

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;
    let content = messages
        .iter()
        .take(6)
        .map(|m| {
            format!(
                "{}: {}",
                match m.role {
                    MessageRole::User => "用户",
                    MessageRole::Assistant => "助手",
                    _ => "系统",
                },
                m.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: format!("根据对话生成简洁标题（不超20字）：\n{}", content),
        content_parts: Vec::new(),
        thinking: None,
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };
    let title = client
        .chat(vec![prompt_message], &model_config)
        .await
        .map_err(|e| e.to_string())?
        .trim()
        .trim_matches('"')
        .to_string();
    {
        let db = db.lock().await;
        db.update_conversation_title(&conversation_id, &title)
            .map_err(|e| e.to_string())?;
    }
    Ok(title)
}
