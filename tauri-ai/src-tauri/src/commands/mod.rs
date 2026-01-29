//! Tauri commands module for TauriAI
//!
//! This module contains all Tauri command handlers that bridge
//! the frontend and backend functionality.

mod run;
mod config;
mod conversation;
mod file;
mod tools;
mod mcp;
mod skills;
mod workstudio;
mod workstudio_terminal;
mod workstudio_state;
mod prompts;

pub use run::{abort_run, run_task};
pub use run::respond_approval;
pub use config::{fetch_provider_models, get_app_config, save_app_config, test_connection};
pub use conversation::{
    create_conversation, delete_conversation, delete_messages_from, generate_title,
    get_conversations, get_messages, update_conversation_metadata, update_conversation_title,
};
pub use file::{list_local_directory, read_local_file_base64, write_local_text_file};
pub use tools::{close_pty_session, list_pty_sessions};
pub use mcp::{
    delete_mcp_server, delete_mcp_set, list_mcp_server_tools, list_mcp_servers, list_mcp_sets,
    set_agent_mcp_set, test_mcp_server, upsert_mcp_server, upsert_mcp_set,
};
pub use skills::{create_skill, list_skills};
pub use prompts::get_format_prompt;
pub use workstudio::{
    add_workstudio_folder, create_workstudio, ensure_workstudio_for_conversation, get_workstudio,
    remove_workstudio_folder, set_workstudio_main_folder, workstudio_find_files,
};
pub use workstudio_terminal::{
    workstudio_terminal_close, workstudio_terminal_create, workstudio_terminal_read,
    workstudio_terminal_read_base64, workstudio_terminal_write,
};
pub use workstudio_state::{get_workstudio_ui_state, set_workstudio_ui_state};
