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
    #[serde(default = "default_exec_yield_time_ms")]
    yield_time_ms: u64,
}

fn default_exec_yield_time_ms() -> u64 {
    10_000
}

#[derive(Debug, Deserialize)]
struct WriteStdinArgs {
    session_id: i32,
    #[serde(default)]
    chars: String,
    #[serde(default = "default_write_yield_time_ms")]
    yield_time_ms: u64,
}

fn default_write_yield_time_ms() -> u64 {
    250
}

fn build_shell_invocation(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec!["cmd.exe".to_string(), "/C".to_string(), command.to_string()]
    }
    #[cfg(not(windows))]
    {
        vec!["/bin/sh".to_string(), "-c".to_string(), command.to_string()]
    }
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
        Ok(None) => Ok((false, None)),
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
                    "yield_time_ms": { "type": "integer", "description": "读取输出的时间窗口（毫秒）" }
                },
                "required": ["cmd"]
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

        let command = build_shell_invocation(&args.cmd);
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
        let (done, exit_code) = check_and_maybe_close_session(ctx, session_id).await?;

        Ok(ToolCallResult {
            content: serde_json::json!({
                "session_id": session_id,
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
                    "yield_time_ms": { "type": "integer", "description": "读取输出的时间窗口（毫秒）" }
                },
                "required": ["session_id", "chars"]
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

        // 写 stdin（用 take/move 避免在 spawn_blocking 里借用 &mut）
        let mut guard = session.lock().await;
        let mut writer = guard
            .writer
            .take()
            .ok_or_else(|| ToolError::internal("PTY writer 不可用"))?;
        drop(guard);

        let bytes = args.chars.clone().into_bytes();
        writer = tokio::task::spawn_blocking(move || -> Result<_, std::io::Error> {
            writer.write_all(&bytes)?;
            writer.flush()?;
            Ok(writer)
        })
        .await
        .map_err(|e| ToolError::new(format!("write_stdin 线程失败: {e}")))?
        .map_err(|e| ToolError::new(format!("write_stdin IO 失败: {e}")))?;

        let mut guard = session.lock().await;
        guard.writer = Some(writer);
        drop(guard);

        let output = drain_pty_output(ctx, args.session_id, &call.id, args.yield_time_ms).await?;
        let (done, exit_code) = check_and_maybe_close_session(ctx, args.session_id).await?;

        Ok(ToolCallResult {
            content: serde_json::json!({
                "session_id": args.session_id,
                "output": output,
                "done": done,
                "exit_code": exit_code
            })
            .to_string(),
        })
    }
}
