//! Tool/session management commands (PTY long-lived sessions).

use std::sync::Arc;

use crate::runtime::tools::services::PtySessionInfo;
use crate::runtime::RunState;

#[tauri::command]
pub async fn list_pty_sessions(
    conversation_id: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<Vec<PtySessionInfo>, String> {
    Ok(run_state.list_pty_sessions(&conversation_id).await)
}

#[tauri::command]
pub async fn close_pty_session(
    conversation_id: String,
    session_id: i32,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<bool, String> {
    Ok(run_state
        .close_pty_session(&conversation_id, session_id)
        .await)
}
