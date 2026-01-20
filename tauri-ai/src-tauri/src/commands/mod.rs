//! Tauri commands module for TauriAI
//!
//! This module contains all Tauri command handlers that bridge
//! the frontend and backend functionality.

mod run;
mod config;
mod conversation;

pub use run::{abort_run, run_task};
pub use config::{fetch_provider_models, get_app_config, save_app_config, test_connection};
pub use conversation::{
    create_conversation, delete_conversation, delete_messages_from, generate_title,
    get_conversations, get_messages, update_conversation_metadata, update_conversation_title,
};
