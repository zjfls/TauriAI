use std::collections::VecDeque;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::agents::chat::{build_model_config, build_request_messages, resolve_chat_model};
use crate::ai_client::{get_client, ToolCall};
use crate::config::ConfigManager;
use crate::models::{
    AgentTaskImplementation, AgentType, AppConfig, AskForApproval, Message, MessageRole,
    MessageStatus,
};
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::spec::ToolSpec;

pub const AGENT_TASK_TOOL_NAME: &str = "agenttask";

const STDERR_TAIL_LIMIT: usize = 24;
const STDOUT_TAIL_LIMIT: usize = 24;
const DEFAULT_RUNTIME_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskArgs {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    model_ref: Option<String>,
    #[serde(default)]
    run_mode: Option<String>,
    #[serde(default)]
    thinking: Option<Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

pub struct AgentTaskInProcessTool;
pub struct AgentTaskSubprocessTool;

fn build_spec(implementation: AgentTaskImplementation) -> ToolSpec {
    let impl_label = match implementation {
        AgentTaskImplementation::InProcess => "in_process（进程内）",
        AgentTaskImplementation::Subprocess => "subprocess（headless 子进程）",
    };

    ToolSpec {
        name: AGENT_TASK_TOOL_NAME.to_string(),
        description: Some(format!(
            "执行 Agent 子任务（当前实现：{impl_label}，仅允许调用 type=task_agent 的智能体）。输入 prompt，可选指定 agent/model。"
        )),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "子任务提示词（推荐）" },
                "content": { "type": "string", "description": "子任务提示词（兼容字段，与 prompt 等价）" },
                "agent_name": { "type": "string", "description": "可选：指定 agent 名称" },
                "model_ref": { "type": "string", "description": "可选：指定 model_ref（优先级高于 agent 默认）" },
                "run_mode": { "type": "string", "description": "可选：chat/agent/agent-custom/agent-full-access" },
                "thinking": { "description": "可选：thinking 参数（boolean/string/object）" },
                "timeout_ms": { "type": "integer", "description": "可选：子任务超时（毫秒，默认 120000）" }
            },
            "required": [],
            "additionalProperties": false
        }),
        required_permissions: vec![],
    }
}

fn parse_args(call: &ToolCall) -> Result<AgentTaskArgs, ToolError> {
    serde_json::from_str::<AgentTaskArgs>(&call.arguments)
        .map_err(|e| ToolError::invalid(format!("agenttask 参数不是合法 JSON: {e}")))
}

fn resolve_prompt(args: &AgentTaskArgs) -> Result<String, ToolError> {
    let prompt = args
        .prompt
        .as_deref()
        .or(args.content.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::invalid("agenttask 缺少 prompt（或 content）参数"))?;
    Ok(prompt.to_string())
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
                "agenttask 指定的 agent 不存在或已禁用：{name}"
            )));
        };
        if !matches!(agent.agent_type, AgentType::TaskAgent) {
            return Err(ToolError::denied(format!(
                "agenttask 仅允许调用 type=task_agent 的智能体；`{name}` 当前类型为 `{}`",
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
        "agenttask 没有可用的 TaskAgent。请先创建 type=task_agent 的智能体（并填写 taskUsage）。",
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
            "agenttask(subprocess) 解析 agent/model 失败: {e:?}"
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
    let mut seen = std::collections::HashSet::<String>::new();
    for p in out {
        let key = p.to_string_lossy().to_string();
        if seen.insert(key) {
            dedup.push(p);
        }
    }
    dedup
}

fn parse_headless_final_json(stdout_text: &str) -> Result<Value, ToolError> {
    let trimmed = stdout_text.trim();
    if trimmed.is_empty() {
        return Err(ToolError::new(
            "agenttask subprocess 输出为空（未返回 final_json）",
        ));
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }

    for line in trimmed.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            return Ok(v);
        }
    }

    Err(ToolError::new(
        "agenttask subprocess 输出不是合法 JSON（无法解析 final_json）",
    ))
}

async fn run_in_process_agent_task(
    call: &ToolCall,
    args: &AgentTaskArgs,
    prompt: &str,
    ctx: &ToolExecutionContext<'_>,
    config: &AppConfig,
    target_agent_name: &str,
) -> Result<ToolCallResult, ToolError> {
    let resolved = resolve_chat_model(config, Some(target_agent_name), args.model_ref.as_deref())
        .map_err(|e| {
        ToolError::new(format!(
            "agenttask(in_process) 解析 agent/model 失败: {e:?}"
        ))
    })?;
    if !matches!(resolved.agent.agent_type, AgentType::TaskAgent) {
        return Err(ToolError::denied(format!(
            "agenttask(in_process) 仅允许 task_agent；当前解析到 `{}`（type={}）",
            resolved.agent.name,
            agent_type_label(resolved.agent.agent_type)
        )));
    }

    let model_config = build_model_config(
        resolved.provider,
        resolved.model,
        args.thinking.clone(),
        None,
    );
    let client = get_client(&model_config.provider)
        .map_err(|e| ToolError::new(format!("agenttask(in_process) 创建 client 失败: {e}")))?;

    let conversation_id = format!("agenttask:{}:{}", ctx.conversation_id, call.id);
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: prompt.to_string(),
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
        .map_err(|e| ToolError::new(format!("agenttask(in_process) 执行失败: {e}")))?;

    Ok(ToolCallResult {
        content,
        meta: Some(json!({
            "agenttask": {
                "implementation": "in_process",
                "agentName": resolved.agent.name,
                "modelRef": format!("{}/{}", resolved.provider.name, resolved.model.name),
            }
        })),
    })
}

async fn run_subprocess_agent_task(
    args: &AgentTaskArgs,
    prompt: &str,
    target_agent_name: &str,
) -> Result<ToolCallResult, ToolError> {
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_RUNTIME_TIMEOUT_MS)
        .max(1_000);
    let payload = json!({
        "requestId": format!("agenttask_{}", uuid::Uuid::new_v4()),
        "task": {
            "content": prompt,
            "agentName": target_agent_name,
            "modelRef": args.model_ref.clone(),
            "runMode": args.run_mode.clone(),
            "thinking": args.thinking.clone(),
            "debugMode": false
        },
        "session": {
            "backend": "memory",
            "mode": "new",
            "title": "agenttask subprocess"
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
    let payload_text = serde_json::to_string(&payload)
        .map_err(|e| ToolError::new(format!("agenttask(subprocess) 构造请求失败: {e}")))?;

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
                    ToolError::new(format!("agenttask(subprocess) 写入 stdin 失败: {e}"))
                })?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|e| ToolError::new(format!("agenttask(subprocess) 写入换行失败: {e}")))?;
            stdin
                .flush()
                .await
                .map_err(|e| ToolError::new(format!("agenttask(subprocess) flush 失败: {e}")))?;
        }

        let wait_timeout = Duration::from_millis(timeout_ms.saturating_add(8_000));
        let output = tokio::time::timeout(wait_timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                ToolError::timeout(format!(
                    "agenttask(subprocess) 等待超时（{}ms）",
                    wait_timeout.as_millis()
                ))
            })?
            .map_err(|e| ToolError::new(format!("agenttask(subprocess) wait 失败: {e}")))?;

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
                .and_then(|v| v.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return Ok(ToolCallResult {
                content,
                meta: Some(json!({
                    "agenttask": {
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
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("agenttask_subprocess_failed");
        let err_msg = parsed
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("agenttask(subprocess) 执行失败");
        let details = parsed
            .get("error")
            .and_then(|e| e.get("details"))
            .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "<invalid json>".to_string()))
            .unwrap_or_else(|| "{}".to_string());

        return Err(ToolError::new(format!(
            "agenttask(subprocess) 失败: code={err_code}, message={err_msg}\nerror.details={details}\nstdout_tail:\n{}\nstderr_tail:\n{}",
            tail_to_text(&stdout_tail),
            tail_to_text(&stderr_tail)
        )));
    }

    let detail =
        last_spawn_error.unwrap_or_else(|| "未找到 tauri-ai-headless 可执行文件".to_string());
    Err(ToolError::new(format!(
        "agenttask(subprocess) 无法启动 headless 子进程：{detail}"
    )))
}

async fn run_agent_task(
    implementation: AgentTaskImplementation,
    call: &ToolCall,
    ctx: &ToolExecutionContext<'_>,
) -> Result<ToolCallResult, ToolError> {
    let args = parse_args(call)?;
    let prompt = resolve_prompt(&args)?;
    let config_manager = ConfigManager::new()
        .map_err(|e| ToolError::new(format!("agenttask 初始化配置失败: {e}")))?;
    let config = config_manager
        .ensure_default()
        .map_err(|e| ToolError::new(format!("agenttask 读取配置失败: {e}")))?;
    let target_agent_name = resolve_target_task_agent_name(&config, args.agent_name.as_deref())?;

    match implementation {
        AgentTaskImplementation::InProcess => {
            run_in_process_agent_task(call, &args, &prompt, ctx, &config, &target_agent_name).await
        }
        AgentTaskImplementation::Subprocess => {
            if cfg!(any(target_os = "android", target_os = "ios")) {
                return Err(ToolError::denied(
                    "agenttask(subprocess) 仅支持桌面端 headless 子进程；移动端请改用 in_process。",
                ));
            }

            let approval_policy = resolve_subprocess_approval_policy(
                &config,
                &target_agent_name,
                args.model_ref.as_deref(),
                args.run_mode.as_deref(),
            )?;
            if !matches!(approval_policy, AskForApproval::Never) {
                return Err(ToolError::denied(
                    "agenttask(subprocess) 当前未接入审批回传；目标 agent 的 approval policy 必须为 never。请改用 in_process，或把该 agent 的审批策略改为 never。",
                ));
            }

            run_subprocess_agent_task(&args, &prompt, &target_agent_name).await
        }
    }
}

#[async_trait]
impl ToolHandler for AgentTaskInProcessTool {
    fn spec(&self) -> ToolSpec {
        build_spec(AgentTaskImplementation::InProcess)
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        run_agent_task(AgentTaskImplementation::InProcess, call, ctx).await
    }
}

#[async_trait]
impl ToolHandler for AgentTaskSubprocessTool {
    fn spec(&self) -> ToolSpec {
        build_spec(AgentTaskImplementation::Subprocess)
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        run_agent_task(AgentTaskImplementation::Subprocess, call, ctx).await
    }
}
