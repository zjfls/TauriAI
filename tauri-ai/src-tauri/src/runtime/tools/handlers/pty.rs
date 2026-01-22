use std::io::Write;
use std::path::PathBuf;

use async_trait::async_trait;
use serde::Deserialize;

use crate::ai_client::ToolCall;
use crate::runtime::events::RunEvent;
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{ToolCallResult, ToolError, ToolExecutionContext, ToolHandler};
use crate::runtime::tools::spec::ToolSpec;

pub struct ExecCommandTool;
pub struct WriteStdinTool;

#[derive(Debug, Deserialize)]
struct ExecCommandArgs {
    cmd: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default = "default_login")]
    login: bool,
    #[serde(default = "default_exec_yield_time_ms")]
    yield_time_ms: u64,
    #[serde(default)]
    max_output_tokens: Option<usize>,
    #[serde(default)]
    sandbox_permissions: Option<String>,
    #[serde(default)]
    justification: Option<String>,
}

fn default_exec_yield_time_ms() -> u64 {
    10_000
}

fn default_login() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct WriteStdinArgs {
    session_id: i32,
    #[serde(default)]
    chars: String,
    #[serde(default = "default_write_yield_time_ms")]
    yield_time_ms: u64,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

fn default_write_yield_time_ms() -> u64 {
    250
}

fn build_shell_invocation(command: &str, shell: Option<&str>, login: bool) -> Vec<String> {
    let shell = shell.unwrap_or_default().trim();
    #[cfg(windows)]
    {
        let shell_lower = shell.to_ascii_lowercase();

        // Default: cmd.exe /C
        if shell.is_empty() || shell_lower.contains("cmd") {
            return vec!["cmd.exe".to_string(), "/C".to_string(), command.to_string()];
        }

        // PowerShell-family: treat `cmd` as a PowerShell script.
        if shell_lower.contains("pwsh") {
            return vec![
                "pwsh".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ];
        }
        if shell_lower.contains("powershell") {
            return vec![
                "powershell.exe".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ];
        }

        // POSIX-like shells that may exist on Windows (Git Bash / MSYS2 / WSL bash on PATH)
        if shell_lower.contains("bash")
            || shell_lower.contains("zsh")
            || shell_lower.ends_with("sh")
        {
            let flag = if login { "-lc" } else { "-c" };
            return vec![shell.to_string(), flag.to_string(), command.to_string()];
        }

        // Fallback: keep previous behavior for unknown shell strings.
        vec!["cmd.exe".to_string(), "/C".to_string(), command.to_string()]
    }
    #[cfg(not(windows))]
    {
        if shell.is_empty() {
            // Default to /bin/sh; if login requested and bash exists, prefer bash -lc.
            if login && std::path::Path::new("/bin/bash").exists() {
                return vec![
                    "/bin/bash".to_string(),
                    "-lc".to_string(),
                    command.to_string(),
                ];
            }
            return vec!["/bin/sh".to_string(), "-c".to_string(), command.to_string()];
        }

        let shell_lower = shell.to_ascii_lowercase();
        let flag = if login && (shell_lower.ends_with("bash") || shell_lower.ends_with("zsh")) {
            "-lc"
        } else {
            "-c"
        };
        vec![shell.to_string(), flag.to_string(), command.to_string()]
    }
}

fn is_pipe_closing_error(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::BrokenPipe {
        return true;
    }

    // Windows: ERROR_NO_DATA (232) = "The pipe is being closed."
    #[cfg(windows)]
    {
        if err.raw_os_error() == Some(232) {
            return true;
        }
    }

    false
}

fn maybe_truncate_output(output: String, max_output_tokens: Option<usize>) -> String {
    let Some(max_tokens) = max_output_tokens.filter(|n| *n > 0) else {
        return output;
    };

    // 粗略近似：1 token ≈ 4 chars（只用于避免把过长输出塞进上下文）。
    let max_chars = max_tokens.saturating_mul(4);
    if max_chars == 0 {
        return String::new();
    }

    let mut iter = output.chars();
    let mut truncated: String = iter.by_ref().take(max_chars).collect();
    let is_truncated = iter.next().is_some();
    if !is_truncated {
        return output;
    }
    truncated.push_str("\n...[truncated]\n");
    truncated
}

async fn drain_pty_output(
    ctx: &mut ToolExecutionContext<'_>,
    session_id: i32,
    call_id: &str,
    yield_time_ms: u64,
) -> Result<String, ToolError> {
    let session = ctx
        .services
        .pty
        .get_session(session_id)
        .await
        .ok_or_else(|| ToolError::invalid(format!("PTY session 不存在: {session_id}")))?;

    let mut output = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(yield_time_ms);

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline - now;

        let mut guard = session.lock().await;

        tokio::select! {
            _ = ctx.abort_rx.recv() => {
                // best-effort kill & remove
                let _ = guard.child.kill();
                drop(guard);
                let _ = ctx.services.pty.remove_session(session_id).await;
                return Err(ToolError::aborted("已中止 PTY 会话"));
            }
            recv = tokio::time::timeout(remaining, guard.rx.recv()) => {
                match recv {
                    Ok(Some(bytes)) => {
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        output.push_str(&text);
                        ctx.emitter.emit(RunEvent::BlockDelta {
                            task_id: ctx.task_id.to_string(),
                            turn_id: ctx.turn_id.to_string(),
                            assistant_message_id: Some(ctx.assistant_message_id.to_string()),
                            block_id: format!("tool_result:{}", call_id),
                            block_type: "tool_result".to_string(),
                            format: Some("plain".to_string()),
                            delta: text,
                        });
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        }
    }

    Ok(output)
}

async fn check_and_maybe_close_session(
    ctx: &mut ToolExecutionContext<'_>,
    session_id: i32,
) -> Result<(bool, Option<u32>), ToolError> {
    let Some(session) = ctx.services.pty.get_session(session_id).await else {
        return Ok((true, None));
    };

    let mut guard = session.lock().await;
    match guard.child.try_wait() {
        Ok(Some(status)) => {
            let code = status.exit_code();
            drop(guard);
            let _ = ctx.services.pty.remove_session(session_id).await;
            Ok((true, Some(code)))
        }
        Ok(None) => {
            // 某些平台/边界情况下 try_wait 可能短暂返回 None，但 PTY reader 已经退出（rx 关闭）。
            // 这时继续保留 session 会导致下一轮 write_stdin 触发 BrokenPipe/232。
            if guard.rx.is_closed() {
                drop(guard);

                // 尽量在回收前拿到退出码（短命令在 Windows/ConPTY 上比较容易发生竞态）。
                let mut exit_code: Option<u32> = None;
                let deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_millis(250);
                loop {
                    {
                        let mut guard = session.lock().await;
                        match guard.child.try_wait() {
                            Ok(Some(status)) => {
                                exit_code = Some(status.exit_code());
                            }
                            Ok(None) => {}
                            Err(_) => {}
                        }
                    }

                    if exit_code.is_some() || tokio::time::Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }

                // 兜底：如果管道已关闭但仍拿不到退出码，说明 session 已不可用；尽量避免子进程泄漏。
                if exit_code.is_none() {
                    let mut guard = session.lock().await;
                    let _ = guard.child.kill();
                }

                let _ = ctx.services.pty.remove_session(session_id).await;
                return Ok((true, exit_code));
            }
            Ok((false, None))
        }
        Err(e) => Err(ToolError::new(format!("检查 PTY 进程状态失败: {e}"))),
    }
}

#[async_trait]
impl ToolHandler for ExecCommandTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "exec_command".to_string(),
            description: Some("在 PTY 中执行命令（可交互），返回 session_id 与输出".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "cmd": { "type": "string", "description": "要执行的命令（由 shell 解析）" },
                    "workdir": { "type": "string", "description": "可选工作目录" },
                    "shell": { "type": "string", "description": "可选：指定启动的 shell（例如 powershell/pwsh/cmd/bash）。为空则使用默认 shell。" },
                    "login": { "type": "boolean", "description": "可选：是否以 login shell 语义运行（默认 true）。" },
                    "yield_time_ms": { "type": "integer", "description": "可选：读取输出的时间窗口（毫秒，默认 10000）。" },
                    "max_output_tokens": { "type": "integer", "description": "可选：最大输出 token（超出将截断）。" },
                    "sandbox_permissions": { "type": "string", "description": "可选：沙箱权限（当前后端暂不实现，仅为兼容）。" },
                    "justification": { "type": "string", "description": "可选：申请更高权限的理由（当前后端暂不实现，仅为兼容）。" }
                },
                // 约定：
                // - workdir 为空字符串表示“使用默认工作目录”
                // - chars 允许为空（用于轮询输出）
                "required": ["cmd"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::PtyExec],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        true
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: ExecCommandArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 exec_command 参数失败: {e}")))?;

        if args.cmd.trim().is_empty() {
            return Err(ToolError::invalid("cmd 不能为空"));
        }

        let command = build_shell_invocation(&args.cmd, args.shell.as_deref(), args.login);
        let workdir = args
            .workdir
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);

        let session_id = ctx
            .services
            .pty
            .create_session(command, workdir)
            .await
            .map_err(ToolError::new)?;

        let output = drain_pty_output(ctx, session_id, &call.id, args.yield_time_ms).await?;
        let output = maybe_truncate_output(output, args.max_output_tokens);
        let (done, exit_code) = check_and_maybe_close_session(ctx, session_id).await?;

        Ok(ToolCallResult {
            content: serde_json::json!({
                // 与 Codex unified exec 语义对齐：只有进程仍在运行时才返回 session_id。
                //
                // Codex 侧的测试/调试字段名是 `process_id`；为了兼容模型的既有习惯，这里同时返回：
                // - `session_id`: i32（write_stdin 入参）
                // - `process_id`: i32（仅用于对齐 Codex “进程还活着才有 id”的强约束语义）
                "session_id": if done { serde_json::Value::Null } else { serde_json::Value::from(session_id) },
                "process_id": if done { serde_json::Value::Null } else { serde_json::Value::from(session_id) },
                "output": output,
                "done": done,
                "exit_code": exit_code
            })
            .to_string(),
        })
    }
}

#[async_trait]
impl ToolHandler for WriteStdinTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write_stdin".to_string(),
            description: Some("向 PTY session 写入输入，并读取一段输出".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "integer", "description": "exec_command 返回的 session_id" },
                    "chars": { "type": "string", "description": "要写入 stdin 的字符（可包含换行）" },
                    "yield_time_ms": { "type": "integer", "description": "可选：读取输出的时间窗口（毫秒，默认 250）。" },
                    "max_output_tokens": { "type": "integer", "description": "可选：最大输出 token（超出将截断）。" }
                },
                "required": ["session_id"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::PtyExec],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        true
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: WriteStdinArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 write_stdin 参数失败: {e}")))?;

        let session = ctx
            .services
            .pty
            .get_session(args.session_id)
            .await
            .ok_or_else(|| ToolError::invalid(format!("PTY session 不存在: {}", args.session_id)))?;

        // 允许 chars 为空：仅轮询输出（避免对已退出进程 flush 触发 BrokenPipe/232）。
        // NOTE: 模型可能会在 exec_command(done=false) 后用 write_stdin(chars="") 来“继续读输出”。
        let mut pipe_closed_during_write = false;
        if !args.chars.is_empty() {
            // 写 stdin（用 take/move 避免在 spawn_blocking 里借用 &mut）
            let mut guard = session.lock().await;
            let mut writer = guard
                .writer
                .take()
                .ok_or_else(|| ToolError::internal("PTY writer 不可用"))?;
            drop(guard);

            let bytes = args.chars.clone().into_bytes();
            let (writer, write_result) = tokio::task::spawn_blocking(move || {
                let res = (|| {
                    writer.write_all(&bytes)?;
                    writer.flush()?;
                    Ok::<(), std::io::Error>(())
                })();
                (writer, res)
            })
            .await
            .map_err(|e| ToolError::new(format!("write_stdin 线程失败: {e}")))?;

            // 无论成功/失败都放回 writer，避免 session 被“写坏”导致后续无法收尾。
            let mut guard = session.lock().await;
            guard.writer = Some(writer);
            drop(guard);

            if let Err(e) = write_result {
                if is_pipe_closing_error(&e) {
                    pipe_closed_during_write = true;
                } else {
                    return Err(ToolError::new(format!("write_stdin IO 失败: {e}")));
                }
            }
        }

        let output = drain_pty_output(ctx, args.session_id, &call.id, args.yield_time_ms).await?;
        let output = maybe_truncate_output(output, args.max_output_tokens);
        let (mut done, mut exit_code) = check_and_maybe_close_session(ctx, args.session_id).await?;

        // 如果本轮写入遇到“管道正在被关闭”，但 try_wait 尚未返回状态：主动回收 session，避免模型下一轮继续写导致报错。
        if pipe_closed_during_write && !done {
            let _ = ctx.services.pty.remove_session(args.session_id).await;
            done = true;
            exit_code = None;
        }

        Ok(ToolCallResult {
            content: serde_json::json!({
                "session_id": if done { serde_json::Value::Null } else { serde_json::Value::from(args.session_id) },
                "process_id": if done { serde_json::Value::Null } else { serde_json::Value::from(args.session_id) },
                "output": output,
                "done": done,
                "exit_code": exit_code
            })
            .to_string(),
        })
    }
}
