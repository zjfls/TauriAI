//! Tauri commands module for TauriAI
//!
//! This module contains all Tauri command handlers that bridge
//! the frontend and backend functionality.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod clipboard;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod code_intel;
mod config;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod conversation;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod db_debug;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod devtools;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod drag_ghost;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod external_agent_sessions;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod file;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod git_tools;
mod mcp;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod mermaid_cache;
mod mobile_chat;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod prompts;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod run;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod skills;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod terminal;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tools;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod window_control;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod window_layout_state;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod workstudio;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod workstudio_fs;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod workstudio_security;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod workstudio_state;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod workstudio_terminal;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use clipboard::clipboard_write_png_base64;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use code_intel::{
    ai_analyze_workstudio_symbol, ai_code_completion, ast_document_symbols,
    code_index_request_document_symbols, code_index_search_workspace_symbols,
    code_index_start_workspace_scan, code_index_status, code_index_summary,
    delete_workstudio_chat_with_record, delete_workstudio_chat_with_records_for_file,
    delete_workstudio_chat_with_thread, delete_workstudio_folder_analysis,
    delete_workstudio_symbol_analysis, find_workstudio_chat_with_thread,
    get_workstudio_chat_with_scope_for_conversation,
    get_workstudio_chat_with_thread_by_conversation, get_workstudio_folder_analysis,
    get_workstudio_symbol_analysis, list_workstudio_chat_with_file_summaries,
    list_workstudio_chat_with_records_for_file, list_workstudio_chat_with_threads_for_file,
    list_workstudio_folder_analysis_summaries, list_workstudio_symbol_analysis_keys_for_file,
    list_workstudio_symbol_analysis_summaries_for_file, lsp_detect_server, lsp_ensure_server,
    lsp_notify, lsp_request, lsp_shutdown_language, lsp_shutdown_workstudio, lsp_status,
    save_workstudio_chat_with_thread, save_workstudio_folder_analysis,
    save_workstudio_symbol_analysis, touch_workstudio_chat_with_thread_for_conversation,
    upsert_workstudio_chat_with_index,
};
pub use config::{
    fetch_provider_models, get_app_config, probe_external_agents, save_app_config, test_connection,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use conversation::{
    clone_conversation, create_conversation, delete_conversation, delete_messages_from,
    ensure_conversation_file_indexes, generate_title, get_conversations, get_messages,
    get_turn_debug_info, update_conversation_metadata, update_conversation_title,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use db_debug::get_db_lock_snapshot;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use devtools::open_devtools_current_window;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use drag_ghost::{
    debug_drag_ghost_create, debug_drag_ghost_destroy, debug_drag_ghost_move, drag_ghost_create,
    drag_ghost_destroy, drag_ghost_follow_start, drag_ghost_follow_stop, drag_ghost_move,
    drag_ghost_move_client,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use external_agent_sessions::{
    close_external_agent_session, send_external_agent_session, start_external_agent_session,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use file::{
    delete_local_path, list_local_directory, read_local_file_base64, write_local_text_file,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use git_tools::{
    git_checkout_branch, git_create_and_checkout_branch, git_diff_commits, git_diff_ghost_worktree,
    git_get_current_branch, git_list_local_branches, undo_apply_patch,
};
pub use mcp::{
    delete_mcp_server, delete_mcp_set, list_mcp_server_resources, list_mcp_server_tools,
    list_mcp_servers, list_mcp_sets, set_agent_mcp_set, test_mcp_server, upsert_mcp_server,
    upsert_mcp_set, warmup_mcp_servers,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use mermaid_cache::{get_mermaid_svg_cache, set_mermaid_svg_cache};
pub use mobile_chat::{
    mobile_chat, mobile_chat_stream_cancel, mobile_chat_stream_start, mobile_generate_title,
    practice_chat, practice_generate_title,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use prompts::{get_format_prompt, get_system_prompt, render_skills_section};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use run::respond_approval;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use run::{abort_run, retry_turn, run_task};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use skills::{create_skill, list_skills};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use terminal::{
    terminal_close, terminal_create, terminal_read, terminal_read_base64, terminal_resize,
    terminal_write,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use tools::{close_pty_session, list_pty_sessions};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use window_control::{close_invoking_window, hide_invoking_window};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use window_layout_state::{
    get_window_layout_state, persist_all_open_window_layouts_now,
    persist_window_layout_snapshot_now, remove_window_layout_record,
    schedule_persist_window_layout_snapshot, schedule_remove_window_layout_record_if_still_closed,
    upsert_window_layout_record,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use workstudio::{
    add_workstudio_folder, create_workstudio, ensure_workstudio_for_conversation, get_workstudio,
    remove_workstudio_folder, resolve_workstudio_file_target, set_workstudio_main_folder,
    workstudio_find_files, workstudio_main_folder_has_real_content,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use workstudio_fs::{
    get_local_file_snapshots, workstudio_fs_sync_watch, workstudio_fs_unwatch, WorkstudioFsWatcher,
    WorkstudioFsWatcherState,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use workstudio_security::{get_workstudio_security_config, set_workstudio_security_config};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use workstudio_state::{get_workstudio_ui_state, set_workstudio_ui_state};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use workstudio_terminal::{
    workstudio_terminal_close, workstudio_terminal_create, workstudio_terminal_read,
    workstudio_terminal_read_base64, workstudio_terminal_resize, workstudio_terminal_write,
};
