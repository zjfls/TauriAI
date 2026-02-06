//! Tauri commands module for TauriAI
//!
//! This module contains all Tauri command handlers that bridge
//! the frontend and backend functionality.

mod clipboard;
mod config;
mod conversation;
mod devtools;
mod drag_ghost;
mod file;
mod mcp;
mod mermaid_cache;
mod prompts;
mod run;
mod skills;
mod terminal;
mod tools;
mod window_control;
mod workstudio;
mod workstudio_security;
mod workstudio_state;
mod workstudio_terminal;

pub use clipboard::clipboard_write_png_base64;
pub use config::{fetch_provider_models, get_app_config, save_app_config, test_connection};
pub use conversation::{
    clone_conversation, create_conversation, delete_conversation, delete_messages_from,
    ensure_conversation_file_indexes, generate_title, get_conversations, get_messages,
    get_turn_debug_info,
    update_conversation_metadata, update_conversation_title,
};
pub use devtools::open_devtools_current_window;
pub use drag_ghost::{
    debug_drag_ghost_create, debug_drag_ghost_destroy, debug_drag_ghost_move, drag_ghost_create,
    drag_ghost_destroy, drag_ghost_move, drag_ghost_move_client,
};
pub use file::{list_local_directory, read_local_file_base64, write_local_text_file};
pub use mcp::{
    delete_mcp_server, delete_mcp_set, list_mcp_server_tools, list_mcp_servers, list_mcp_sets,
    set_agent_mcp_set, test_mcp_server, upsert_mcp_server, upsert_mcp_set,
};
pub use mermaid_cache::{get_mermaid_svg_cache, set_mermaid_svg_cache};
pub use prompts::get_format_prompt;
pub use run::respond_approval;
pub use run::{abort_run, retry_turn, run_task};
pub use skills::{create_skill, list_skills};
pub use terminal::{
    terminal_close, terminal_create, terminal_read, terminal_read_base64, terminal_write,
};
pub use tools::{close_pty_session, list_pty_sessions};
pub use window_control::close_invoking_window;
pub use workstudio::{
    add_workstudio_folder, create_workstudio, ensure_workstudio_for_conversation, get_workstudio,
    remove_workstudio_folder, set_workstudio_main_folder, workstudio_find_files,
};
pub use workstudio_security::{get_workstudio_security_config, set_workstudio_security_config};
pub use workstudio_state::{get_workstudio_ui_state, set_workstudio_ui_state};
pub use workstudio_terminal::{
    workstudio_terminal_close, workstudio_terminal_create, workstudio_terminal_read,
    workstudio_terminal_read_base64, workstudio_terminal_write,
};
