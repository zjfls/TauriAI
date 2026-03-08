use std::collections::{HashSet, VecDeque};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::agents::chat::{build_model_config, build_request_messages, resolve_chat_model};
use crate::config::ConfigManager;
use crate::models::{
    AgentType, AppConfig, AskForApproval, InternalAgentImplementation, Message, MessageRole,
    MessageStatus,
};
use crate::runtime::tools::registry::{ToolCallResult, ToolError, ToolExecutionContext};

const STDERR_TAIL_LIMIT: usize = 24;
const STDOUT_TAIL_LIMIT: usize = 24;
const DEFAULT_RUNTIME_TIMEOUT_MS: u64 = 120_000;
const INTERNAL_AGENT_LABEL: &str = "subagent_call(internal)";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InternalAgentRunRequest {
    pub prompt: String,
    pub agent_name: Option<String>,
    pub model_ref: Option<String>,
    pub run_mode: Option<String>,
    pub thinking: Option<Value>,
    pub timeout_ms: Option<u64>,
}

fn agent_type_label(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::Chat => "chat",
        AgentType::Tool => "tool",
        AgentType::TaskAgent => "task_agent",
        AgentType::Practice => "practice",
    }
}

fn resolve_target_task_agent_name(
    config: &AppConfig,
    requested_agent_name: Option<&str>,
) -> Result<String, ToolError> {
    if let Some(name) = requested_agent_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let Some(agent) = config.get_agent(name) else {
            return Err(ToolError::invalid(format!(
                "{INTERNAL_AGENT_LABEL} 指定的 TaskAgent 不存在或已禁用：{name}"
            )));
        };
        if !matches!(agent.agent_type, AgentType::TaskAgent) {
            return Err(ToolError::denied(format!(
                "{INTERNAL_AGENT_LABEL} 仅允许调用 type=task_agent 的智能体；`{name}` 当前类型为 `{}`",
                agent_type_label(agent.agent_type)
            )));
        }
        return Ok(agent.name.clone());
    }

    if let Some(agent) = config
        .get_default_agent()
        .filter(|a| matches!(a.agent_type, AgentType::TaskAgent))
    {
        return Ok(agent.name.clone());
    }

    if let Some(agent) = config
        .agents
        .iter()
        .find(|a| a.enabled && matches!(a.agent_type, AgentType::TaskAgent))
    {
        return Ok(agent.name.clone());
    }

    Err(ToolError::denied(
        "当前没有可用的 TaskAgent。请先创建 type=task_agent 的内部智能体，并填写 taskUsage。",
    ))
}

fn resolve_subprocess_approval_policy(
    config: &AppConfig,
    target_agent_name: &str,
    model_ref: Option<&str>,
    run_mode: Option<&str>,
) -> Result<AskForApproval, ToolError> {
    let resolved = resolve_chat_model(config, Some(target_agent_name), model_ref).map_err(|e| {
        ToolError::new(format!(
            "{INTERNAL_AGENT_LABEL}(subprocess) 解析 TaskAgent/model 失败: {e:?}"
        ))
    })?;
    let requested_mode = run_mode.unwrap_or("").trim();
    let use_custom_security = requested_mode == "agent-custom";
    let base_policy = config
        .security
        .resolve_policy(resolved.agent.security_policy.as_deref());
    Ok(if use_custom_security {
        resolved
            .agent
            .approval_policy
            .unwrap_or(base_policy.approval_policy)
    } else {
        base_policy.approval_policy
    })
}

fn tail_push(tail: &mut VecDeque<String>, line: String, limit: usize) {
    if limit == 0 {
        return;
    }
    if tail.len() >= limit {
        tail.pop_front();
    }
    tail.push_back(line);
}

fn tail_to_text(tail: &VecDeque<String>) -> String {
    if tail.is_empty() {
        return "(空)".to_string();
    }
    tail.iter().cloned().collect::<Vec<_>>().join("\n")
}

fn headless_binary_stem() -> &'static str {
    "tauri-ai-headless"
}

fn headless_binary_names() -> Vec<String> {
    let mut names = vec![if cfg!(target_os = "windows") {
        "tauri-ai-headless.exe".to_string()
    } else {
        "tauri-ai-headless".to_string()
    }];
    if let Some(target) = option_env!("TARGET")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let suffixed = if cfg!(target_os = "windows") {
            format!("{}-{target}.exe", headless_binary_stem())
        } else {
            format!("{}-{target}", headless_binary_stem())
        };
        if !names.iter().any(|existing| existing == &suffixed) {
            names.push(suffixed);
        }
    }
    names
}

fn current_exe_headless_candidates() -> Vec<PathBuf> {
    let mut out = Vec::<PathBuf>::new();

    if let Ok(bin) = std::env::var("TAURIAI_HEADLESS_BIN") {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            out.push(PathBuf::from(trimmed));
        }
    }

    let binary_names = headless_binary_names();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            for name in &binary_names {
                out.push(dir.join(name));
            }
            if let Some(parent) = dir.parent() {
                for name in &binary_names {
                    out.push(parent.join("MacOS").join(name));
                    out.push(parent.join("Resources").join(name));
                }
            }
        }
    }
    for name in binary_names {
        out.push(PathBuf::from(name));
    }

    let mut dedup = Vec::<PathBuf>::new();
    let mut seen = HashSet::<String>::new();
    for path in out {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            dedup.push(path);
        }
    }
    dedup
}

fn parse_headless_final_json(stdout_text: &str) -> Result<Value, ToolError> {
    let trimmed = stdout_text.trim();
    if trimmed.is_empty() {
        return Err(ToolError::new(
            "内部 TaskAgent 子进程输出为空（未返回 final_json）",
        ));
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }

    for line in trimmed.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            return Ok(value);
        }
    }

    Err(ToolError::new(
        "内部 TaskAgent 子进程输出不是合法 JSON（无法解析 final_json）",
    ))
}

async fn run_in_process_agent_task(
    request_id: &str,
    request: &InternalAgentRunRequest,
    ctx: &ToolExecutionContext<'_>,
    config: &AppConfig,
    target_agent_name: &str,
) -> Result<ToolCallResult, ToolError> {
    let resolved = resolve_chat_model(
        config,
        Some(target_agent_name),
        request.model_ref.as_deref(),
    )
    .map_err(|e| {
        ToolError::new(format!(
            "{INTERNAL_AGENT_LABEL}(in_process) 解析 TaskAgent/model 失败: {e:?}"
        ))
    })?;
    if !matches!(resolved.agent.agent_type, AgentType::TaskAgent) {
        return Err(ToolError::denied(format!(
            "{INTERNAL_AGENT_LABEL}(in_process) 仅允许 TaskAgent；当前解析到 `{}`（type={}）",
            resolved.agent.name,
            agent_type_label(resolved.agent.agent_type)
        )));
    }

    let model_config = build_model_config(
        resolved.provider,
        resolved.model,
        request.thinking.clone(),
        None,
    );
    let client = crate::ai_client::get_client(&model_config.provider).map_err(|e| {
        ToolError::new(format!(
            "{INTERNAL_AGENT_LABEL}(in_process) 创建 client 失败: {e}"
        ))
    })?;

    let conversation_id = format!("internal_agent:{}:{request_id}", ctx.conversation_id);
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: request.prompt.clone(),
        content_parts: Vec::new(),
        thinking: None,
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };
    let messages = build_request_messages(vec![user_message], &conversation_id, resolved.agent);

    let content = client
        .chat(messages, &model_config, None)
        .await
        .map_err(|e| ToolError::new(format!("{INTERNAL_AGENT_LABEL}(in_process) 执行失败: {e}")))?;

    Ok(ToolCallResult {
        content,
        meta: Some(json!({
            "internalAgent": {
                "implementation": "in_process",
                "agentName": resolved.agent.name,
                "modelRef": format!("{}/{}", resolved.provider.name, resolved.model.name),
            }
        })),
    })
}

async fn run_subprocess_agent_task(
    request: &InternalAgentRunRequest,
    target_agent_name: &str,
) -> Result<ToolCallResult, ToolError> {
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_RUNTIME_TIMEOUT_MS)
        .max(1_000);
    let payload = json!({
        "requestId": format!("internal_agent_{}", uuid::Uuid::new_v4()),
        "task": {
            "content": request.prompt,
            "agentName": target_agent_name,
            "modelRef": request.model_ref.clone(),
            "runMode": request.run_mode.clone(),
            "thinking": request.thinking.clone(),
            "debugMode": false
        },
        "session": {
            "backend": "memory",
            "mode": "new",
            "title": "internal agent subprocess"
        },
        "output": {
            "mode": "final_json",
            "includeEvents": false,
            "includeMessages": false
        },
        "runtime": {
            "timeoutMs": timeout_ms,
            "maxEvents": 1000,
            "maxSnapshotMessages": 200
        }
    });
    let payload_text = serde_json::to_string(&payload).map_err(|e| {
        ToolError::new(format!(
            "{INTERNAL_AGENT_LABEL}(subprocess) 构造请求失败: {e}"
        ))
    })?;

    let mut last_spawn_error: Option<String> = None;

    for candidate in current_exe_headless_candidates() {
        let bin_display = candidate.to_string_lossy().to_string();
        let mut command = Command::new(&candidate);
        command
            .arg("--output-mode")
            .arg("final_json")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                last_spawn_error = Some(format!("{bin_display}: {err}"));
                if err.kind() == ErrorKind::NotFound {
                    continue;
                }
                continue;
            }
        };

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload_text.as_bytes())
                .await
                .map_err(|e| {
                    ToolError::new(format!(
                        "{INTERNAL_AGENT_LABEL}(subprocess) 写入 stdin 失败: {e}"
                    ))
                })?;
            stdin.write_all(b"\n").await.map_err(|e| {
                ToolError::new(format!(
                    "{INTERNAL_AGENT_LABEL}(subprocess) 写入换行失败: {e}"
                ))
            })?;
            stdin.flush().await.map_err(|e| {
                ToolError::new(format!(
                    "{INTERNAL_AGENT_LABEL}(subprocess) flush 失败: {e}"
                ))
            })?;
        }

        let wait_timeout = Duration::from_millis(timeout_ms.saturating_add(8_000));
        let output = tokio::time::timeout(wait_timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                ToolError::timeout(format!(
                    "{INTERNAL_AGENT_LABEL}(subprocess) 等待超时（{}ms）",
                    wait_timeout.as_millis()
                ))
            })?
            .map_err(|e| {
                ToolError::new(format!("{INTERNAL_AGENT_LABEL}(subprocess) wait 失败: {e}"))
            })?;

        let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
        let mut stdout_tail = VecDeque::<String>::new();
        let mut stderr_tail = VecDeque::<String>::new();
        for line in stdout_text.lines() {
            tail_push(&mut stdout_tail, line.to_string(), STDOUT_TAIL_LIMIT);
        }
        for line in stderr_text.lines() {
            tail_push(&mut stderr_tail, line.to_string(), STDERR_TAIL_LIMIT);
        }

        let parsed = parse_headless_final_json(&stdout_text)?;
        let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if ok {
            let content = parsed
                .get("result")
                .and_then(|value| value.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return Ok(ToolCallResult {
                content,
                meta: Some(json!({
                    "internalAgent": {
                        "implementation": "subprocess",
                        "agentName": target_agent_name,
                        "binary": bin_display,
                        "exitCode": output.status.code(),
                        "timeoutMs": timeout_ms,
                    }
                })),
            });
        }

        let err_code = parsed
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("internal_agent_subprocess_failed");
        let err_msg = parsed
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("内部 TaskAgent 子进程执行失败");
        let details = parsed
            .get("error")
            .and_then(|error| error.get("details"))
            .map(|value| {
                serde_json::to_string(value).unwrap_or_else(|_| "<invalid json>".to_string())
            })
            .unwrap_or_else(|| "{}".to_string());

        return Err(ToolError::new(format!(
            "{INTERNAL_AGENT_LABEL}(subprocess) 失败: code={err_code}, message={err_msg}\nerror.details={details}\nstdout_tail:\n{}\nstderr_tail:\n{}",
            tail_to_text(&stdout_tail),
            tail_to_text(&stderr_tail)
        )));
    }

    let detail =
        last_spawn_error.unwrap_or_else(|| "未找到 tauri-ai-headless 可执行文件".to_string());
    Err(ToolError::new(format!(
        "{INTERNAL_AGENT_LABEL}(subprocess) 无法启动 headless 子进程：{detail}"
    )))
}

pub(crate) async fn run_internal_agent_once(
    implementation: InternalAgentImplementation,
    request: &InternalAgentRunRequest,
    ctx: &ToolExecutionContext<'_>,
    request_id: &str,
) -> Result<ToolCallResult, ToolError> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(ToolError::invalid(
            "subagent_call 指向 internal 目标时，prompt 不能为空",
        ));
    }

    let config_manager = ConfigManager::new()
        .map_err(|e| ToolError::new(format!("{INTERNAL_AGENT_LABEL} 初始化配置失败: {e}")))?;
    let config = config_manager
        .ensure_default()
        .map_err(|e| ToolError::new(format!("{INTERNAL_AGENT_LABEL} 读取配置失败: {e}")))?;
    let target_agent_name = resolve_target_task_agent_name(&config, request.agent_name.as_deref())?;

    match implementation {
        InternalAgentImplementation::InProcess => {
            run_in_process_agent_task(request_id, request, ctx, &config, &target_agent_name).await
        }
        InternalAgentImplementation::Subprocess => {
            if cfg!(any(target_os = "android", target_os = "ios")) {
                return Err(ToolError::denied(
                    "内部 TaskAgent 的 subprocess 模式仅支持桌面端；移动端请改用 in_process。",
                ));
            }

            let approval_policy = resolve_subprocess_approval_policy(
                &config,
                &target_agent_name,
                request.model_ref.as_deref(),
                request.run_mode.as_deref(),
            )?;
            if !matches!(approval_policy, AskForApproval::Never) {
                return Err(ToolError::denied(
                    "内部 TaskAgent 的 subprocess 模式当前未接入审批回传；目标 TaskAgent 的 approval policy 必须为 never。",
                ));
            }

            run_subprocess_agent_task(request, &target_agent_name).await
        }
    }
}
