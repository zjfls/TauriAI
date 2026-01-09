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
    println!("[Conversation] Getting all conversations");
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
    println!("[Conversation] Fetching messages for: {}", conversation_id);
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
    println!("[Conversation] Creating new conversation: {}", title);
    let result = db.create_conversation(&title).map_err(|e| e.to_string());
    if let Ok(ref conv) = result {
        println!("[Conversation] Created conversation: {}", conv.id);
    } else {
        println!("[Conversation] Failed to create conversation");
    }
    result
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

/// Generate a title for a conversation based on its content
///
/// Uses AI to analyze the conversation and generate a concise, descriptive title.
#[tauri::command]
pub async fn generate_title(
    conversation_id: String,
    messages: Vec<Message>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<crate::config::ConfigManager>>,
) -> Result<String, String> {
    use crate::ai_client::get_client;
    use crate::models::MessageRole;

    println!("[Conversation] Generating title for: {}", conversation_id);

    // Load config to get active model
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;

    // Find the active model config
    let model_config = config
        .models
        .iter()
        .find(|m| m.id == config.active_model_id)
        .ok_or("No active model configured")?
        .clone();

    // Get the AI client for this provider
    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    // Build the prompt message
    let conversation_content = messages
        .iter()
        .take(6) // Only use first 6 messages
        .map(|m| {
            let role = match m.role {
                MessageRole::User => "用户",
                MessageRole::Assistant => "助手",
                _ => "系统",
            };
            format!("{}: {}", role, m.content)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "你是一个对话标题生成助手。根据下面的对话内容，生成一个简洁、准确的标题。\n\n\
         要求：\n\
         - 不超过 20 个字\n\
         - 概括对话的核心主题\n\
         - 使用中文\n\
         - 不要加引号或标点\n\n\
         对话内容：\n{}\n\n\
         请直接输出标题，不要有任何其他文字。",
        conversation_content
    );

    // Create a system prompt message
    let prompt_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: prompt,
        meta: None,
        created_at: chrono::Utc::now(),
    };

    // Call AI to generate title
    let title = client
        .chat(vec![prompt_message], &model_config)
        .await
        .map_err(|e| e.to_string())?;

    // Clean up the title (remove quotes, newlines, etc.)
    let title = title
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('《')
        .trim_matches('》')
        .to_string();

    println!("[Conversation] Generated title: {}", title);

    // Update the database
    {
        let db = db.lock().await;
        db.update_conversation_title(&conversation_id, &title)
            .map_err(|e| e.to_string())?;
    }

    Ok(title)
}
