//! 通用终端（PTY）命令：为 UI 提供可复用的终端会话能力。
//!
//! 设计目标：
//! - 统一 Workspace 终端标签 / Workstudio 终端面板 的后端接口
//! - 通过 scope 做隔离：每个 scope 拥有自己的 PTY 会话集合
//! - 保持实现复用：Workstudio 旧命令可作为 wrapper 调用这里

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, MutexGuard};

use crate::runtime::text::decode_process_output;
use crate::runtime::tools::services::{PtySession, PtySessionScope};
use crate::runtime::RunState;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalScope {
    /// Workstudio 内嵌终端（或以 workstudio 为作用域的终端实例）
    Workstudio { id: String },
    /// Workspace 顶部终端标签（tabId 作为作用域 id）
    WorkspaceTerminal { id: String },
}

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

fn conv_key(scope: &TerminalScope) -> String {
    match scope {
        TerminalScope::Workstudio { id } => format!("terminal:workstudio:{id}"),
        TerminalScope::WorkspaceTerminal { id } => format!("terminal:workspace_terminal:{id}"),
    }
}

fn default_shell_command(is_dark: Option<bool>) -> Vec<String> {
    #[cfg(windows)]
    {
        // Windows UI terminal 固定走 PowerShell 体系（不再回退到 cmd）。
        // 优先顺序：pwsh (PowerShell 7+) -> powershell (Windows PowerShell)。
        fn find_in_path(candidates: &[&str]) -> Option<String> {
            let path = std::env::var_os("PATH")?;
            for dir in std::env::split_paths(&path) {
                for name in candidates {
                    let full = dir.join(name);
                    if full.is_file() {
                        return Some(full.to_string_lossy().to_string());
                    }
                }
            }
            None
        }

        fn resolve_windows_powershell() -> String {
            if let Some(shell) = find_in_path(&["pwsh.exe", "powershell.exe"]) {
                return shell;
            }

            // 常见安装位置兜底（某些环境下 PATH 不完整）。
            let mut candidates: Vec<std::path::PathBuf> = Vec::new();
            for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
                if let Some(base) = std::env::var_os(key) {
                    candidates.push(
                        std::path::PathBuf::from(base)
                            .join("PowerShell")
                            .join("7")
                            .join("pwsh.exe"),
                    );
                }
            }
            if let Some(windir) = std::env::var_os("WINDIR") {
                candidates.push(
                    std::path::PathBuf::from(windir)
                        .join("System32")
                        .join("WindowsPowerShell")
                        .join("v1.0")
                        .join("powershell.exe"),
                );
            }
            for path in candidates {
                if path.is_file() {
                    return path.to_string_lossy().to_string();
                }
            }

            // 最终兜底：交给系统路径解析；若系统确实没有 PowerShell，会在 spawn 阶段给出明确错误。
            "powershell.exe".to_string()
        }

        let shell = resolve_windows_powershell();
        // 统一 UTF-8：避免中文输出在前端出现 “�” 乱码（ConPTY + xterm 默认按 UTF-8 解码）。
        // - `chcp 65001` 影响原生控制台程序（GetConsoleOutputCP）
        // - `[Console]::OutputEncoding` 影响 PowerShell / native command 输出编码
        // - `$OutputEncoding` 影响 native command 管道编码
        // PowerShell init script for the embedded UI terminal.
        //
        // Goals:
        // - UTF-8 I/O to avoid mojibake.
        // - Make input text more readable (use brighter colors).
        let input_color = if is_dark.unwrap_or(false) { "White" } else { "Blue" };
        let init = format!(
            "try {{ chcp 65001 | Out-Null }} catch {{}}; \
             try {{ [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() }} catch {{}}; \
             $OutputEncoding = [Console]::OutputEncoding; \
             try {{ Import-Module PSReadLine -ErrorAction Stop }} catch {{}}; \
             try {{ Set-PSReadLineOption -Colors @{{ Default='{c}'; Command='{c}'; Parameter='{c}'; String='{c}'; Number='{c}'; Operator='{c}'; Variable='{c}'; Type='{c}'; Member='{c}'; Keyword='{c}' }} }} catch {{}};",
            c = input_color
        );
        vec![
            shell,
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            init,
        ]
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        // Use interactive login shell to approximate user terminal environment.
        // - login: load profile (.zprofile/.bash_profile)
        // - interactive: ensure rc hooks (e.g. env managers) behave like a real terminal
        let shell_lower = shell.to_ascii_lowercase();
        let flag = if shell_lower.ends_with("zsh") || shell_lower.ends_with("bash") {
            "-il"
        } else {
            "-l"
        };
        vec![shell, flag.to_string()]
    }
}

async fn ensure_session_owned(
    run_state: &RunState,
    scope: &TerminalScope,
    session_id: i32,
) -> Result<Arc<Mutex<PtySession>>, String> {
    let conv = conv_key(scope);
    let services = run_state.get_tool_services(&conv).await;
    let meta = services
        .pty
        .get_session_meta(session_id)
        .await
        .ok_or_else(|| format!("PTY session 不存在: {session_id}"))?;
    if meta.conversation_id != conv {
        return Err("PTY session 不属于当前 scope".to_string());
    }
    services
        .pty
        .get_session(session_id)
        .await
        .ok_or_else(|| format!("PTY session 不存在: {session_id}"))
}

#[tauri::command]
pub async fn terminal_create(
    scope: TerminalScope,
    workdir: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    is_dark: Option<bool>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<i32, String> {
    let conv = conv_key(&scope);
    let services = run_state.get_tool_services(&conv).await;
    let cmd = default_shell_command(is_dark);
    let dir = workdir.as_ref().map(PathBuf::from);
    let size = portable_pty::PtySize {
        cols: cols.unwrap_or(80).max(1),
        rows: rows.unwrap_or(24).max(1),
        pixel_width: 0,
        pixel_height: 0,
    };

    services
        .pty
        .create_session(cmd, dir, &conv, "ui", PtySessionScope::Conversation, Some(size))
        .await
}

#[tauri::command]
pub async fn terminal_write(
    scope: TerminalScope,
    session_id: i32,
    chars: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    let session = ensure_session_owned(&run_state, &scope, session_id).await?;
    let writer = {
        let guard = session.lock().await;
        Arc::clone(&guard.writer)
    };
    let mut guard = writer.lock().await;
    if let Some(writer) = guard.as_mut() {
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
pub async fn terminal_resize(
    scope: TerminalScope,
    session_id: i32,
    cols: u16,
    rows: u16,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    let session = ensure_session_owned(&run_state, &scope, session_id).await?;
    let guard = session.lock().await;
    let cols = cols.max(1);
    let rows = rows.max(1);
    guard
        ._master
        .resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize pty 失败: {e}"))
}

#[tauri::command]
pub async fn terminal_read(
    scope: TerminalScope,
    session_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<String, String> {
    let session = ensure_session_owned(&run_state, &scope, session_id).await?;

    // NOTE: This locks the session while waiting; keep timeouts short on the frontend.
    let rx = {
        let guard: MutexGuard<'_, PtySession> = session.lock().await;
        Arc::clone(&guard.rx)
    };
    let mut guard = rx.lock().await;

    let mut out: Vec<u8> = Vec::new();
    let deadline = Duration::from_millis(timeout_ms.max(10));

    let chunk = match tokio::time::timeout(deadline, guard.recv()).await {
        Ok(Some(chunk)) => chunk,
        _ => Vec::new(),
    };
    if !chunk.is_empty() {
        out.extend_from_slice(&chunk);
    }

    while out.len() < max_bytes {
        match guard.try_recv() {
            Ok(chunk) => out.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }

    if out.len() > max_bytes {
        out.truncate(max_bytes);
    }

    Ok(decode_process_output(&out))
}

#[tauri::command]
pub async fn terminal_read_base64(
    scope: TerminalScope,
    session_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<String, String> {
    let session = ensure_session_owned(&run_state, &scope, session_id).await?;

    // NOTE: This locks the session while waiting; keep timeouts short on the frontend.
    let rx = {
        let guard: MutexGuard<'_, PtySession> = session.lock().await;
        Arc::clone(&guard.rx)
    };
    let mut guard = rx.lock().await;

    let mut out: Vec<u8> = Vec::new();
    let deadline = Duration::from_millis(timeout_ms.max(10));

    let chunk = match tokio::time::timeout(deadline, guard.recv()).await {
        Ok(Some(chunk)) => chunk,
        _ => Vec::new(),
    };
    if !chunk.is_empty() {
        out.extend_from_slice(&chunk);
    }

    while out.len() < max_bytes {
        match guard.try_recv() {
            Ok(chunk) => out.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }

    if out.len() > max_bytes {
        out.truncate(max_bytes);
    }

    Ok(encode_base64(&out))
}

#[tauri::command]
pub async fn terminal_close(
    scope: TerminalScope,
    session_id: i32,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<bool, String> {
    let conv = conv_key(&scope);
    let services = run_state.get_tool_services(&conv).await;
    let meta = services.pty.get_session_meta(session_id).await;
    let Some(meta) = meta else {
        return Ok(false);
    };
    if meta.conversation_id != conv {
        return Ok(false);
    }
    Ok(services.pty.close_session(session_id).await)
}
