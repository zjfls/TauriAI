//! Workstudio terminal commands (PTY sessions for UI).
//!
//! These sessions are keyed by a synthetic conversation id:
//!   `workstudio:<workstudio_id>`
//! so we can reuse the existing PTY service infrastructure.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, MutexGuard};

use crate::runtime::RunState;
use crate::runtime::tools::services::{PtySession, PtySessionScope};

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((data.len() + 2) / 3) * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };

        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        let c0 = TABLE[((n >> 18) & 63) as usize] as char;
        let c1 = TABLE[((n >> 12) & 63) as usize] as char;
        let c2 = TABLE[((n >> 6) & 63) as usize] as char;
        let c3 = TABLE[(n & 63) as usize] as char;

        out.push(c0);
        out.push(c1);
        if i + 1 < data.len() {
            out.push(c2);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(c3);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn conv_key(workstudio_id: &str) -> String {
    format!("workstudio:{workstudio_id}")
}

fn default_shell_command() -> Vec<String> {
    #[cfg(windows)]
    {
        // Minimal fallback. (Workstudio UI currently targets macOS/Linux primarily.)
        vec!["cmd.exe".to_string()]
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        // Use login shell to approximate user terminal environment.
        vec![shell, "-l".to_string()]
    }
}

async fn ensure_session_owned(
    run_state: &RunState,
    workstudio_id: &str,
    session_id: i32,
) -> Result<Arc<Mutex<PtySession>>, String> {
    let services = run_state.get_tool_services(&conv_key(workstudio_id)).await;
    let meta = services
        .pty
        .get_session_meta(session_id)
        .await
        .ok_or_else(|| format!("PTY session 不存在: {session_id}"))?;
    if meta.conversation_id != conv_key(workstudio_id) {
        return Err("PTY session 不属于当前 workstudio".to_string());
    }
    services
        .pty
        .get_session(session_id)
        .await
        .ok_or_else(|| format!("PTY session 不存在: {session_id}"))
}

#[tauri::command]
pub async fn workstudio_terminal_create(
    workstudio_id: String,
    workdir: Option<String>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<i32, String> {
    let conv = conv_key(&workstudio_id);
    let services = run_state.get_tool_services(&conv).await;
    let cmd = default_shell_command();
    let dir = workdir
        .as_ref()
        .map(|d| PathBuf::from(d))
        .or_else(|| None);

    services
        .pty
        .create_session(cmd, dir, &conv, "ui", PtySessionScope::Conversation)
        .await
}

#[tauri::command]
pub async fn workstudio_terminal_write(
    workstudio_id: String,
    session_id: i32,
    chars: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    let session = ensure_session_owned(&run_state, &workstudio_id, session_id).await?;
    let mut guard = session.lock().await;
    if let Some(writer) = guard.writer.as_mut() {
        writer
            .write_all(chars.as_bytes())
            .map_err(|e| format!("write stdin 失败: {e}"))?;
        writer.flush().ok();
        Ok(())
    } else {
        Err("PTY writer 不可用".to_string())
    }
}

#[tauri::command]
pub async fn workstudio_terminal_read(
    workstudio_id: String,
    session_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<String, String> {
    let session = ensure_session_owned(&run_state, &workstudio_id, session_id).await?;

    // NOTE: This locks the session while waiting; keep timeouts short on the frontend.
    let mut guard: MutexGuard<'_, PtySession> = session.lock().await;

    let mut out: Vec<u8> = Vec::new();
    let deadline = Duration::from_millis(timeout_ms.max(10));

    let chunk = match tokio::time::timeout(deadline, guard.rx.recv()).await {
        Ok(Some(chunk)) => chunk,
        _ => Vec::new(),
    };
    if !chunk.is_empty() {
        out.extend_from_slice(&chunk);
    }

    while out.len() < max_bytes {
        match guard.rx.try_recv() {
            Ok(chunk) => {
                out.extend_from_slice(&chunk);
            }
            Err(_) => break,
        }
    }

    if out.len() > max_bytes {
        out.truncate(max_bytes);
    }

    Ok(String::from_utf8_lossy(&out).to_string())
}

#[tauri::command]
pub async fn workstudio_terminal_read_base64(
    workstudio_id: String,
    session_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<String, String> {
    let session = ensure_session_owned(&run_state, &workstudio_id, session_id).await?;

    // NOTE: This locks the session while waiting; keep timeouts short on the frontend.
    let mut guard: MutexGuard<'_, PtySession> = session.lock().await;

    let mut out: Vec<u8> = Vec::new();
    let deadline = Duration::from_millis(timeout_ms.max(10));

    let chunk = match tokio::time::timeout(deadline, guard.rx.recv()).await {
        Ok(Some(chunk)) => chunk,
        _ => Vec::new(),
    };
    if !chunk.is_empty() {
        out.extend_from_slice(&chunk);
    }

    while out.len() < max_bytes {
        match guard.rx.try_recv() {
            Ok(chunk) => {
                out.extend_from_slice(&chunk);
            }
            Err(_) => break,
        }
    }

    if out.len() > max_bytes {
        out.truncate(max_bytes);
    }

    Ok(encode_base64(&out))
}

#[tauri::command]
pub async fn workstudio_terminal_close(
    workstudio_id: String,
    session_id: i32,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<bool, String> {
    let services = run_state.get_tool_services(&conv_key(&workstudio_id)).await;
    let meta = services.pty.get_session_meta(session_id).await;
    let Some(meta) = meta else {
        return Ok(false);
    };
    if meta.conversation_id != conv_key(&workstudio_id) {
        return Ok(false);
    }
    Ok(services.pty.close_session(session_id).await)
}
