//! Chat commands for TauriAI

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::ai_client::{get_client, StreamEvent};
use crate::config::ConfigManager;
use crate::errors::{AppErrorCode, SerializableError};
use crate::models::{Message, MessageRole, ModelConfig, ModelParameters};
use crate::prompts::compose_system_prompt;
use crate::storage::Database;

#[derive(Clone, serde::Serialize)]
pub struct StreamTokenPayload {
    pub conversation_id: String,
    pub token: String,
}

#[derive(Clone, serde::Serialize)]
pub struct StreamDonePayload {
    pub conversation_id: String,
    pub full_content: String,
}

#[derive(Clone, serde::Serialize)]
pub struct StreamErrorPayload {
    pub conversation_id: String,
    pub error: String,
}

pub struct ChatState {
    abort_senders: RwLock<HashMap<String, mpsc::Sender<()>>>,
}

impl ChatState {
    pub fn new() -> Self {
        Self { abort_senders: RwLock::new(HashMap::new()) }
    }
}

impl Default for ChatState {
    fn default() -> Self { Self::new() }
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    conversation_id: String,
    content: String,
    agent_name: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    chat_state: tauri::State<'_, Arc<ChatState>>,
) -> Result<(), SerializableError> {
    let config = config_manager.ensure_default()
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    let agent_name_str = agent_name.unwrap_or_else(|| config.default_agent.clone());
    let (provider, model, agent) = config.resolve_agent(&agent_name_str)
        .ok_or_else(|| AppErrorCode::ModelConfigMissing)?;

    if !provider.enabled {
        return Err(AppErrorCode::AiServiceError(format!("Provider '{}' is disabled", provider.display_name)).into());
    }

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
    };

    let client = get_client(&model_config.provider)
        .map_err(|e| AppErrorCode::AiServiceError(e.to_string()))?;

    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: content.clone(),
        meta: None,
        created_at: chrono::Utc::now(),
    };

    { let db = db.lock().await; db.add_message(&conversation_id, &user_message).map_err(|e| AppErrorCode::UnknownError(e.to_string()))?; }

    let mut messages = { let db = db.lock().await; db.get_messages(&conversation_id, 100, None).map_err(|e| AppErrorCode::UnknownError(e.to_string()))? };

    let base_prompt = if agent.system_prompt.is_empty() { None } else { Some(agent.system_prompt.as_str()) };
    if let Some(system_content) = compose_system_prompt(base_prompt, agent.format_type) {
        let system_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: MessageRole::System,
            content: system_content,
            meta: None,
            created_at: chrono::Utc::now(),
        };
        messages.insert(0, system_message);
    }

    let (abort_tx, mut abort_rx) = mpsc::channel::<()>(1);
    { let mut senders = chat_state.abort_senders.write().await; senders.insert(conversation_id.clone(), abort_tx); }

    let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);
    let conv_id = conversation_id.clone();
    let app_handle = app.clone();
    let db_clone = db.inner().clone();
    let model_name = model_config.model.clone();

    let stream_handle = tokio::spawn(async move { client.chat_stream(messages, &model_config, token_tx).await });

    let mut full_content = String::new();
    loop {
        tokio::select! {
            _ = abort_rx.recv() => { stream_handle.abort(); break; }
            event = token_rx.recv() => {
                match event {
                    Some(StreamEvent::Token(token)) => {
                        full_content.push_str(&token);
                        let _ = app_handle.emit("chat:token", StreamTokenPayload { conversation_id: conv_id.clone(), token });
                    }
                    Some(StreamEvent::Done(content)) => { full_content = content; break; }
                    Some(StreamEvent::Error(error)) => {
                        let _ = app_handle.emit("chat:error", StreamErrorPayload { conversation_id: conv_id.clone(), error });
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    { let mut senders = chat_state.abort_senders.write().await; senders.remove(&conv_id); }

    if !full_content.is_empty() {
        let assistant_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv_id.clone(),
            role: MessageRole::Assistant,
            content: full_content.clone(),
            meta: Some(crate::models::MessageMeta { model: Some(model_name), tokens: None, duration: None }),
            created_at: chrono::Utc::now(),
        };
        let db = db_clone.lock().await;
        db.add_message(&conv_id, &assistant_message).map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    }

    let _ = app.emit("chat:done", StreamDonePayload { conversation_id: conv_id, full_content });
    Ok(())
}

#[tauri::command]
pub async fn abort_chat(
    conversation_id: String,
    chat_state: tauri::State<'_, Arc<ChatState>>,
) -> Result<(), String> {
    let senders = chat_state.abort_senders.read().await;
    if let Some(sender) = senders.get(&conversation_id) {
        sender.send(()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
