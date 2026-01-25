use std::collections::HashMap;
use std::process::Stdio;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::ai_client::ToolCall;
use crate::runtime::events::RunEvent;
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{ToolCallResult, ToolError, ToolExecutionContext, ToolHandler};
use crate::runtime::tools::spec::ToolSpec;

pub struct ShellCommandTool;

#[derive(Debug, Deserialize)]
struct EnvVar {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum EnvSpec {
    Map(HashMap<String, String>),
    List(Vec<EnvVar>),
}

#[derive(Debug, Deserialize)]
struct ShellCommandArgs {
    command: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default = "default_login")]
    login: bool,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    env: Option<EnvSpec>,
    #[serde(default)]
    sandbox_permissions: Option<String>,
    #[serde(default)]
    justification: Option<String>,
}

fn default_login() -> bool {
    true
}

fn is_known_safe_command(command: &str) -> bool {
    let cmd = command.trim();
    let first = cmd.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
    matches!(
        first.as_str(),
        "ls"
            | "dir"
            | "pwd"
            | "whoami"
            | "cat"
            | "type"
            | "echo"
            | "git"
    )
}

fn build_shell_invocation(command: &str, login: bool) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let _ = login;
        ("cmd.exe".to_string(), vec!["/C".to_string(), command.to_string()])
    }
    #[cfg(not(windows))]
    {
        // 尽量贴近用户在 Terminal 里的体验：优先使用 $SHELL（通常是 /bin/zsh 或 /bin/bash）。
        let shell = std::env::var("SHELL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| std::path::Path::new(s).exists());

        if let Some(shell) = shell {
            let flag = if login { "-lc" } else { "-c" };
            return (shell, vec![flag.to_string(), command.to_string()]);
        }

        if login && std::path::Path::new("/bin/bash").exists() {
            ("/bin/bash".to_string(), vec!["-lc".to_string(), command.to_string()])
        } else {
            ("/bin/sh".to_string(), vec!["-c".to_string(), command.to_string()])
        }
    }
}

#[async_trait]
impl ToolHandler for ShellCommandTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "shell_command".to_string(),
            description: Some("在本地 shell 执行命令，并返回输出".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "要执行的命令（由 shell 解析）" },
                    "workdir": { "type": "string", "description": "可选工作目录" },
                    "login": { "type": "boolean", "description": "可选：是否以 login shell 语义运行（默认 true）。" },
                    "timeout_ms": { "type": "integer", "description": "可选超时（毫秒）" },
                    "env": {
                        "type": "array",
                        "description": "可选环境变量（键值对列表）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": { "type": "string" },
                                "value": { "type": "string" }
                            },
                            "required": ["key", "value"],
                            "additionalProperties": false
                        }
                    },
                    "sandbox_permissions": { "type": "string", "description": "可选：沙箱权限（当前后端暂不实现，仅为兼容）。" },
                    "justification": { "type": "string", "description": "可选：申请更高权限的理由（当前后端暂不实现，仅为兼容）。" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::ShellExec],
        }
    }

    async fn is_mutating(&self, call: &ToolCall) -> bool {
        let Ok(args) = serde_json::from_str::<ShellCommandArgs>(&call.arguments) else {
            return true;
        };
        !is_known_safe_command(&args.command)
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args: ShellCommandArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 shell_command 参数失败: {e}")))?;
        if args.command.trim().is_empty() {
            return Err(ToolError::invalid("command 不能为空"));
        }

        let (program, program_args) = build_shell_invocation(&args.command, args.login);

        let mut cmd = Command::new(program);
        cmd.args(program_args);
        let resolved_workdir = args
            .workdir
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| ctx.default_workdir.clone());
        if let Some(dir) = resolved_workdir.as_ref() {
            cmd.current_dir(dir);
        }
        if let Some(env) = args.env {
            match env {
                EnvSpec::Map(m) => {
                    cmd.envs(m);
                }
                EnvSpec::List(list) => {
                    for v in list {
                        if v.key.trim().is_empty() {
                            continue;
                        }
                        cmd.env(&v.key, &v.value);
                    }
                }
            }
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| ToolError::new(format!("启动命令失败: {e}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::internal("无法获取 stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::internal("无法获取 stderr"))?;

        let (tx, mut rx) = mpsc::channel::<(bool, Vec<u8>)>(256);

        // stdout reader
        {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut r = stdout;
                let mut buf = [0u8; 4096];
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if tx.send((false, buf[..n].to_vec())).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // stderr reader
        {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut r = stderr;
                let mut buf = [0u8; 4096];
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if tx.send((true, buf[..n].to_vec())).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        drop(tx);

        let mut output = String::new();

        let deadline = args.timeout_ms.filter(|ms| *ms > 0).map(|ms| {
            Instant::now() + std::time::Duration::from_millis(ms)
        });

        loop {
            if let Some(d) = deadline {
                if Instant::now() >= d {
                    let _ = child.kill().await;
                    return Err(ToolError::timeout("shell_command 超时"));
                }
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    // 退出后尽量再 drain 一小段时间，拿到剩余输出
                    loop {
                        match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
                            Ok(Some((_is_stderr, bytes))) => {
                                let text = String::from_utf8_lossy(&bytes).to_string();
                                output.push_str(&text);
                                ctx.emitter.emit(RunEvent::BlockDelta {
                                    task_id: ctx.task_id.to_string(),
                                    turn_id: ctx.turn_id.to_string(),
                                    assistant_message_id: Some(ctx.assistant_message_id.to_string()),
                                    block_id: format!("tool_result:{}", call.id),
                                    block_type: "tool_result".to_string(),
                                    format: Some("plain".to_string()),
                                    delta: text,
                                });
                            }
                            _ => break,
                        }
                    }

                    let code = status.code().unwrap_or(-1);
                    if code != 0 {
                        let tail = format!("\n[exit_code={code}]");
                        output.push_str(&tail);
                        ctx.emitter.emit(RunEvent::BlockDelta {
                            task_id: ctx.task_id.to_string(),
                            turn_id: ctx.turn_id.to_string(),
                            assistant_message_id: Some(ctx.assistant_message_id.to_string()),
                            block_id: format!("tool_result:{}", call.id),
                            block_type: "tool_result".to_string(),
                            format: Some("plain".to_string()),
                            delta: tail,
                        });
                    }
                    return Ok(ToolCallResult { content: output });
                }
                Ok(None) => {}
                Err(e) => return Err(ToolError::new(format!("检查进程状态失败: {e}"))),
            }

            tokio::select! {
                _ = ctx.abort_rx.recv() => {
                    let _ = child.kill().await;
                    return Err(ToolError::aborted("已中止 shell_command"));
                }
                chunk = rx.recv() => {
                    match chunk {
                        Some((_is_stderr, bytes)) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            output.push_str(&text);
                            ctx.emitter.emit(RunEvent::BlockDelta {
                                task_id: ctx.task_id.to_string(),
                                turn_id: ctx.turn_id.to_string(),
                                assistant_message_id: Some(ctx.assistant_message_id.to_string()),
                                block_id: format!("tool_result:{}", call.id),
                                block_type: "tool_result".to_string(),
                                format: Some("plain".to_string()),
                                delta: text,
                            });
                        }
                        None => {
                            // output channel closed; continue to poll process exit
                        }
                    }
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
            }
        }
    }
}
