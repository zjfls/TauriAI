//! Conversation commands for TauriAI
//!
//! This module contains Tauri commands for managing conversations
//! including CRUD operations and message retrieval.

use std::sync::Arc;
use tokio::sync::Mutex;

use crate::models::{Conversation, Message};
use crate::storage::Database;

/// Get all conversations sorted by update time descending
#[tauri::command]
pub async fn get_conversations(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Conversation>, String> {
    let db = db.lock().await;
    db.get_conversations().map_err(|e| e.to_string())
}

/// Get messages for a conversation with pagination
///
/// # Arguments
/// * `conversation_id` - The conversation to get messages from
/// * `limit` - Maximum number of messages to return (default: 50)
/// * `before_id` - If provided, only return messages before this message ID
#[tauri::command]
pub async fn get_messages(
    conversation_id: String,
    limit: Option<usize>,
    before_id: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Message>, String> {
    let db = db.lock().await;
    let limit = limit.unwrap_or(50);
    db.get_messages(&conversation_id, limit, before_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Create a new conversation
///
/// # Arguments
/// * `title` - Optional title for the conversation (defaults to "New Conversation")
#[tauri::command]
pub async fn create_conversation(
    title: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Conversation, String> {
    let db = db.lock().await;
    let title = title.unwrap_or_else(|| "New Conversation".to_string());
    db.create_conversation(&title).map_err(|e| e.to_string())
}

/// Delete a conversation and all its messages
#[tauri::command]
pub async fn delete_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.delete_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

/// Update a conversation's title
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
