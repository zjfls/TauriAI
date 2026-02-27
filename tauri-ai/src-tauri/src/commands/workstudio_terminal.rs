//! Workstudio terminal commands（兼容层）
//!
//! 历史原因：前端最早用 `workstudio_terminal_*` 命令来驱动 UI 终端（xterm）。
//! 现在为了长期统一，后端新增了通用的 `terminal_*`（支持 scope 隔离）。
//! 这里保留旧命令名作为 wrapper，避免外部调用方/旧版本前端直接断掉。

use std::sync::Arc;

use crate::runtime::RunState;

use super::terminal::{
    terminal_close, terminal_create, terminal_read, terminal_read_base64, terminal_resize,
    terminal_write,
    TerminalScope,
};

#[tauri::command]
pub async fn workstudio_terminal_create(
    workstudio_id: String,
    workdir: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    is_dark: Option<bool>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<i32, String> {
    terminal_create(
        TerminalScope::Workstudio { id: workstudio_id },
        workdir,
        cols,
        rows,
        is_dark,
        run_state,
    )
    .await
}

#[tauri::command]
pub async fn workstudio_terminal_write(
    workstudio_id: String,
    session_id: i32,
    chars: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    terminal_write(
        TerminalScope::Workstudio { id: workstudio_id },
        session_id,
        chars,
        run_state,
    )
    .await
}

#[tauri::command]
pub async fn workstudio_terminal_resize(
    workstudio_id: String,
    session_id: i32,
    cols: u16,
    rows: u16,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    terminal_resize(
        TerminalScope::Workstudio { id: workstudio_id },
        session_id,
        cols,
        rows,
        run_state,
    )
    .await
}

#[tauri::command]
pub async fn workstudio_terminal_read(
    workstudio_id: String,
    session_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<String, String> {
    terminal_read(
        TerminalScope::Workstudio { id: workstudio_id },
        session_id,
        timeout_ms,
        max_bytes,
        run_state,
    )
    .await
}

#[tauri::command]
pub async fn workstudio_terminal_read_base64(
    workstudio_id: String,
    session_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<String, String> {
    terminal_read_base64(
        TerminalScope::Workstudio { id: workstudio_id },
        session_id,
        timeout_ms,
        max_bytes,
        run_state,
    )
    .await
}

#[tauri::command]
pub async fn workstudio_terminal_close(
    workstudio_id: String,
    session_id: i32,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<bool, String> {
    terminal_close(
        TerminalScope::Workstudio { id: workstudio_id },
        session_id,
        run_state,
    )
    .await
}
