//! Chat commands for TauriAI
//!
//! This module contains Tauri commands for chat functionality including
//! streaming chat and abort operations.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};
use tauri::{AppHandle, Emitter};

use crate::ai_client::{get_client, StreamEvent};
use crate::config::ConfigManager;
use crate::models::{Message, MessageRole};
use crate::storage::Database;

/// Payload for streaming token events
#[derive(Clone, serde::Serialize)]
pub struct StreamTokenPayload {
    pub conversation_id: String,
    pub token: String,
}

/// Payload for stream completion events
#[derive(Clone, serde::Serialize)]
pub struct StreamDonePayload {
    pub conversation_id: String,
    pub full_content: String,
}

/// Payload for stream error events
#[derive(Clone, serde::Serialize)]
pub struct StreamErrorPayload {
    pub conversation_id: String,
    pub error: String,
}

/// Global state for managing active chat streams
pub struct ChatState {
    /// Map of conversation_id to abort sender
    abort_senders: RwLock<HashMap<String, mpsc::Sender<()>>>,
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            abort_senders: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for ChatState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start a streaming chat request
///
/// Emits events:
/// - `chat:token` - For each token received
/// - `chat:done` - When streaming completes
/// - `chat:error` - If an error occurs
#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    conversation_id: String,
    content: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    chat_state: tauri::State<'_, Arc<ChatState>>,
) -> Result<(), String> {
    // Load config to get active model
    let config = config_manager
        .ensure_default()
        .map_err(|e| e.to_string())?;

    // Find the active model config
    let model_config = config
        .models
        .iter()
        .find(|m| m.id == config.active_model_id)
        .ok_or_else(|| "No active model configured".to_string())?
        .clone();

    // Get the AI client for this provider
    let client = get_client(&model_config.provider)
        .map_err(|e| e.to_string())?;

    // Create user message
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: content.clone(),
        meta: None,
        created_at: chrono::Utc::now(),
    };

    // Save user message to database
    {
        let db = db.lock().await;
        db.add_message(&conversation_id, &user_message)
            .map_err(|e| e.to_string())?;
    }

    // Get conversation history
    let messages = {
        let db = db.lock().await;
        db.get_messages(&conversation_id, 100, None)
            .map_err(|e| e.to_string())?
    };

    // Create abort channel
    let (abort_tx, mut abort_rx) = mpsc::channel::<()>(1);
    
    // Store abort sender
    {
        let mut senders = chat_state.abort_senders.write().await;
        senders.insert(conversation_id.clone(), abort_tx);
    }

    // Create token channel
    let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);

    // Clone values for the spawned task
    let conv_id = conversation_id.clone();
    let app_handle = app.clone();
    let db_clone = db.inner().clone();
    let model_name = model_config.model.clone();

    // Spawn task to handle streaming
    let stream_handle = tokio::spawn(async move {
        client.chat_stream(messages, &model_config, token_tx).await
    });

    // Process stream events
    let mut full_content = String::new();
    
    loop {
        tokio::select! {
            // Check for abort signal
            _ = abort_rx.recv() => {
                stream_handle.abort();
                break;
            }
            // Process stream events
            event = token_rx.recv() => {
                match event {
                    Some(StreamEvent::Token(token)) => {
                        full_content.push_str(&token);
                        let _ = app_handle.emit("chat:token", StreamTokenPayload {
                            conversation_id: conv_id.clone(),
                            token,
                        });
                    }
                    Some(StreamEvent::Done(content)) => {
                        full_content = content;
                        break;
                    }
                    Some(StreamEvent::Error(error)) => {
                        let _ = app_handle.emit("chat:error", StreamErrorPayload {
                            conversation_id: conv_id.clone(),
                            error,
                        });
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    // Remove abort sender
    {
        let mut senders = chat_state.abort_senders.write().await;
        senders.remove(&conv_id);
    }

    // Save assistant message if we have content
    if !full_content.is_empty() {
        let assistant_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv_id.clone(),
            role: MessageRole::Assistant,
            content: full_content.clone(),
            meta: Some(crate::models::MessageMeta {
                model: Some(model_name),
                tokens: None,
                duration: None,
            }),
            created_at: chrono::Utc::now(),
        };

        let db = db_clone.lock().await;
        db.add_message(&conv_id, &assistant_message)
            .map_err(|e| e.to_string())?;
    }

    // Emit done event
    let _ = app.emit("chat:done", StreamDonePayload {
        conversation_id: conv_id,
        full_content,
    });

    Ok(())
}

/// Abort an ongoing chat generation
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
