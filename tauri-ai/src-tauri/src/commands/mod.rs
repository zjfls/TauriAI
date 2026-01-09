//! Tauri commands module for TauriAI
//!
//! This module contains all Tauri command handlers that bridge
//! the frontend and backend functionality.

mod chat;
mod config;
mod conversation;

pub use chat::{abort_chat, chat_stream, ChatState};
pub use config::{get_app_config, save_app_config, test_connection};
pub use conversation::{
    create_conversation, delete_conversation, generate_title, get_conversations, get_messages,
    update_conversation_title,
};
