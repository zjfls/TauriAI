use std::collections::VecDeque;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::agents::chat::resolve_chat_model;
use crate::ai_client::ToolCall;
use crate::config::ConfigManager;
use crate::external_agents::{
    build_replay_prompt, default_command_candidates, invoke_cli_transport,
    ExternalAgentInvocationOutput, ExternalAgentReplayMessage, ExternalAgentReplayRole,
};
use crate::models::{
    AppConfig, AskForApproval, ExternalAgentConfig, ExternalAgentTransportType, SandboxPolicy,
};
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::sandbox::{
    dedupe_paths, effective_workspace_roots, is_path_under_any_root, normalize_root_for_join,
};
use crate::runtime::tools::spec::ToolSpec;

pub const AGENT_RUN_TOOL_NAME: &str = "agent_run";
pub const AGENT_SESSION_TOOL_NAME: &str = "agent_session";

const STDERR_TAIL_LIMIT: usize = 24;
const STDOUT_TAIL_LIMIT: usize = 24;
const DEFAULT_RUNTIME_TIMEOUT_MS: u64 = 120_000;
const WAIT_TIMEOUT_BUFFER_MS: u64 = 8_000;
const SESSION_PREVIEW_LIMIT: usize = 240;
const SESSION_STORE_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunArgs {
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
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentSessionAction {
    Start,
    Send,
    Info,
    List,
    Close,
}

impl AgentSessionAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Send => "send",
            Self::Info => "info",
            Self::List => "list",
            Self::Close => "close",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionArgs {
    action: AgentSessionAction,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    model_ref: Option<String>,
    #[serde(default)]
    run_mode: Option<String>,
    #[serde(default)]
    thinking: Option<Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    delete_session_db: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExternalAgentSessionStatus {
    Active,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalAgentSessionRecord {
    id: String,
    parent_conversation_id: String,
    agent_name: String,
    remote_agent_name: String,
    title: String,
    status: ExternalAgentSessionStatus,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default)]
    transport_type: ExternalAgentTransportType,
    child_conversation_id: String,
    db_path: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<Value>,
    cwd: Option<String>,
    #[serde(default)]
    replay_messages: Vec<ExternalAgentReplayMessage>,
    last_result_preview: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalAgentSessionStore {
    #[serde(default = "default_session_store_version")]
    version: u32,
    #[serde(default)]
    sessions: Vec<ExternalAgentSessionRecord>,
}

fn default_session_store_version() -> u32 {
    SESSION_STORE_VERSION
}

struct HeadlessInvocationOutput {
    parsed: Value,
    binary_display: String,
    exit_code: Option<i32>,
}

pub struct AgentRunTool;
pub struct AgentSessionTool;

fn build_agent_run_spec() -> ToolSpec {
    ToolSpec {
        name: AGENT_RUN_TOOL_NAME.to_string(),
        description: Some(
            "执行一次性的外部 agent 委托。适合隔离的单次子任务；输入 external agent 名称与 prompt，返回结构化结果。"
                .to_string(),
        ),
        parameters: json!({
            "type": "object",
            "properties": {
                "agent_name": { "type": "string", "description": "外部 agent 配置名（必填）" },
                "prompt": { "type": "string", "description": "子任务提示词（推荐）" },
                "content": { "type": "string", "description": "子任务提示词（兼容字段，与 prompt 等价）" },
                "model_ref": { "type": "string", "description": "可选：覆盖外部 agent 默认 model_ref" },
                "run_mode": { "type": "string", "description": "可选：覆盖外部 agent 默认 run_mode" },
                "thinking": { "description": "可选：覆盖外部 agent 默认 thinking 参数（boolean/string/object）" },
                "timeout_ms": { "type": "integer", "description": "可选：超时（毫秒）" },
                "cwd": { "type": "string", "description": "可选：外部 agent 进程工作目录" }
            },
            "required": ["agent_name"],
            "additionalProperties": false
        }),
        required_permissions: vec![ToolPermission::ShellExec],
    }
}

fn build_agent_session_spec() -> ToolSpec {
    ToolSpec {
        name: AGENT_SESSION_TOOL_NAME.to_string(),
        description: Some(
            "管理持久化外部 agent 会话。支持 start/send/info/list/close，用于跨多次 follow-up 的子代理协作。"
                .to_string(),
        ),
        parameters: json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "send", "info", "list", "close"],
                    "description": "会话动作"
                },
                "session_id": { "type": "string", "description": "会话 ID（send/info/close 必填）" },
                "agent_name": { "type": "string", "description": "外部 agent 配置名（start 必填）" },
                "prompt": { "type": "string", "description": "会话输入（start/send 推荐）" },
                "content": { "type": "string", "description": "会话输入（兼容字段，与 prompt 等价）" },
                "title": { "type": "string", "description": "可选：start 时的会话标题" },
                "model_ref": { "type": "string", "description": "可选：覆盖默认 model_ref" },
                "run_mode": { "type": "string", "description": "可选：覆盖默认 run_mode" },
                "thinking": { "description": "可选：覆盖默认 thinking 参数（boolean/string/object）" },
                "timeout_ms": { "type": "integer", "description": "可选：超时（毫秒）" },
                "cwd": { "type": "string", "description": "可选：外部 agent 进程工作目录" },
                "delete_session_db": { "type": "boolean", "description": "可选：close 时同时删除会话 DB 文件" }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        required_permissions: vec![ToolPermission::ShellExec],
    }
}

fn parse_agent_run_args(call: &ToolCall) -> Result<AgentRunArgs, ToolError> {
    serde_json::from_str::<AgentRunArgs>(&call.arguments)
        .map_err(|e| ToolError::invalid(format!("agent_run 参数不是合法 JSON: {e}")))
}

fn parse_agent_session_args(call: &ToolCall) -> Result<AgentSessionArgs, ToolError> {
    serde_json::from_str::<AgentSessionArgs>(&call.arguments)
        .map_err(|e| ToolError::invalid(format!("agent_session 参数不是合法 JSON: {e}")))
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_prompt(
    tool_name: &str,
    prompt: Option<&str>,
    content: Option<&str>,
) -> Result<String, ToolError> {
    normalize_optional_string(prompt)
        .or_else(|| normalize_optional_string(content))
        .ok_or_else(|| ToolError::invalid(format!("{tool_name} 缺少 prompt（或 content）参数")))
}

fn resolve_required_external_agent_name(
    tool_name: &str,
    agent_name: Option<&str>,
) -> Result<String, ToolError> {
    normalize_optional_string(agent_name)
        .ok_or_else(|| ToolError::invalid(format!("{tool_name} 缺少 agent_name 参数")))
}

fn resolve_required_session_id(args: &AgentSessionArgs) -> Result<String, ToolError> {
    normalize_optional_string(args.session_id.as_deref())
        .ok_or_else(|| ToolError::invalid("agent_session 缺少 session_id 参数"))
}

fn load_app_config() -> Result<AppConfig, ToolError> {
    let manager = ConfigManager::new()
        .map_err(|e| ToolError::new(format!("external agent 初始化配置失败: {e}")))?;
    manager
        .ensure_default()
        .map_err(|e| ToolError::new(format!("external agent 读取配置失败: {e}")))
}

fn resolve_external_agent<'a>(
    config: &'a AppConfig,
    requested_name: &str,
) -> Result<&'a ExternalAgentConfig, ToolError> {
    config.get_external_agent(requested_name).ok_or_else(|| {
        ToolError::invalid(format!("external agent 不存在或已禁用：{requested_name}"))
    })
}

fn effective_remote_agent_name(external_agent: &ExternalAgentConfig) -> String {
    normalize_optional_string(external_agent.remote_agent_name.as_deref())
        .unwrap_or_else(|| external_agent.name.clone())
}

fn resolve_local_headless_approval_policy(
    config: &AppConfig,
    external_agent: &ExternalAgentConfig,
    model_ref: Option<&str>,
    run_mode: Option<&str>,
) -> Result<AskForApproval, ToolError> {
    let target_agent_name = effective_remote_agent_name(external_agent);
    let resolved = resolve_chat_model(config, Some(target_agent_name.as_str()), model_ref)
        .map_err(|e| {
            ToolError::new(format!(
                "external agent 解析本地 headless 目标 agent/model 失败: {e:?}"
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

fn validate_desktop_subprocess_support(tool_name: &str) -> Result<(), ToolError> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err(ToolError::denied(format!(
            "{tool_name} 当前仅支持桌面端外部子进程。"
        )));
    }
    Ok(())
}

fn maybe_validate_auto_headless_target(
    config: &AppConfig,
    external_agent: &ExternalAgentConfig,
    model_ref: Option<&str>,
    run_mode: Option<&str>,
) -> Result<(), ToolError> {
    let command = normalize_optional_string(external_agent.transport.command.as_deref());
    if command.is_some() {
        return Ok(());
    }

    let approval =
        resolve_local_headless_approval_policy(config, external_agent, model_ref, run_mode)?;
    if !matches!(approval, AskForApproval::Never) {
        return Err(ToolError::denied(
            "agent_run/agent_session 当前未接入审批回传；自动使用本地 tauri-ai-headless 时，目标 agent 的 approval policy 必须为 never。若需自定义外部执行器，请在 externalAgents 配置里显式指定 transport.command。",
        ));
    }
    Ok(())
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

fn parse_headless_final_json(stdout_text: &str, tool_name: &str) -> Result<Value, ToolError> {
    let trimmed = stdout_text.trim();
    if trimmed.is_empty() {
        return Err(ToolError::new(format!(
            "{tool_name} 子进程输出为空（未返回 final_json）"
        )));
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

    Err(ToolError::new(format!(
        "{tool_name} 子进程输出不是合法 JSON（无法解析 final_json）"
    )))
}

fn app_data_dir() -> Result<PathBuf, ToolError> {
    let manager = ConfigManager::new()
        .map_err(|e| ToolError::new(format!("external agent 初始化配置失败: {e}")))?;
    manager
        .config_path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| ToolError::internal("无法确定 ~/.tauri-ai 配置目录"))
}

fn session_store_path() -> Result<PathBuf, ToolError> {
    Ok(app_data_dir()?.join("external_agent_sessions.json"))
}

fn session_db_path(session_id: &str) -> Result<PathBuf, ToolError> {
    Ok(app_data_dir()?
        .join("external_agents")
        .join("sessions")
        .join(format!("{session_id}.sqlite")))
}

fn load_session_store() -> Result<ExternalAgentSessionStore, ToolError> {
    let path = session_store_path()?;
    if !path.exists() {
        return Ok(ExternalAgentSessionStore {
            version: SESSION_STORE_VERSION,
            sessions: Vec::new(),
        });
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| ToolError::new(format!("读取 external agent session store 失败: {e}")))?;
    serde_json::from_str::<ExternalAgentSessionStore>(&content).map_err(|e| {
        ToolError::new(format!(
            "解析 external agent session store 失败（{}）: {e}",
            path.display()
        ))
    })
}

fn save_session_store(store: &ExternalAgentSessionStore) -> Result<(), ToolError> {
    let path = session_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            ToolError::new(format!(
                "创建 external agent session store 目录失败（{}）: {e}",
                parent.display()
            ))
        })?;
    }
    let content = serde_json::to_string_pretty(store).map_err(|e| {
        ToolError::internal(format!("序列化 external agent session store 失败: {e}"))
    })?;
    fs::write(&path, content).map_err(|e| {
        ToolError::new(format!(
            "写入 external agent session store 失败（{}）: {e}",
            path.display()
        ))
    })
}

fn resolve_effective_workdir(
    ctx: &ToolExecutionContext<'_>,
    requested_cwd: Option<&str>,
    transport_cwd: Option<&PathBuf>,
) -> Result<Option<PathBuf>, ToolError> {
    let policy = &ctx.sandbox_policy;
    let mut resolved = normalize_optional_string(requested_cwd)
        .map(PathBuf::from)
        .or_else(|| transport_cwd.cloned())
        .or_else(|| ctx.default_workdir.clone());

    if !policy.has_full_disk_write_access() {
        let base_dir_for_roots = ctx
            .default_workdir
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));

        let mut roots =
            effective_workspace_roots(ctx.default_workdir.as_ref(), &ctx.workspace_roots);
        if let SandboxPolicy::WorkspaceWrite { writable_roots, .. } = policy {
            for root in writable_roots {
                if let Some(path) = normalize_root_for_join(&base_dir_for_roots, root) {
                    roots.push(path);
                }
            }
        }
        let roots = dedupe_paths(roots);
        if roots.is_empty() {
            return Err(ToolError::denied(
                "当前沙盒策略要求绑定工作区目录，但当前未绑定",
            ));
        }

        let chosen = resolved.clone().unwrap_or_else(|| roots[0].clone());
        if !is_path_under_any_root(&chosen, &roots) {
            return Err(ToolError::denied(format!(
                "cwd 不在允许范围内: {}",
                chosen.display()
            )));
        }
        resolved = Some(chosen);
    }

    Ok(resolved)
}

fn apply_transport_env(
    command: &mut Command,
    external_agent: &ExternalAgentConfig,
    parent_conversation_id: &str,
    session_id: Option<&str>,
    action: Option<AgentSessionAction>,
) {
    for name in &external_agent.transport.env_vars {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = std::env::var(trimmed) {
            command.env(trimmed, value);
        }
    }
    if !external_agent.transport.env.is_empty() {
        command.envs(external_agent.transport.env.iter());
    }
    command.env("TAURIAI_EXTERNAL_AGENT_NAME", external_agent.name.as_str());
    command.env(
        "TAURIAI_EXTERNAL_AGENT_DISPLAY_NAME",
        external_agent.display_name.as_str(),
    );
    command.env("TAURIAI_PARENT_CONVERSATION_ID", parent_conversation_id);
    if let Some(session_id) = session_id {
        command.env("TAURIAI_AGENT_SESSION_ID", session_id);
    }
    if let Some(action) = action {
        command.env("TAURIAI_AGENT_SESSION_ACTION", action.as_str());
    }
}

async fn invoke_external_headless(
    tool_name: &str,
    external_agent: &ExternalAgentConfig,
    request_payload: &Value,
    timeout_ms: u64,
    workdir: Option<PathBuf>,
    parent_conversation_id: &str,
    session_id: Option<&str>,
    action: Option<AgentSessionAction>,
) -> Result<HeadlessInvocationOutput, ToolError> {
    match external_agent.transport.transport_type {
        ExternalAgentTransportType::Headless => {}
        ExternalAgentTransportType::CodexCli | ExternalAgentTransportType::ClaudeCode => {
            return Err(ToolError::internal(format!(
                "{tool_name} 收到了非 headless transport"
            )));
        }
    }

    let requested_command = normalize_optional_string(external_agent.transport.command.as_deref());
    let candidates = if let Some(command) = requested_command.as_ref() {
        vec![PathBuf::from(command)]
    } else {
        default_command_candidates(ExternalAgentTransportType::Headless)
    };

    let payload_text = serde_json::to_string(request_payload)
        .map_err(|e| ToolError::internal(format!("{tool_name} 构造请求失败: {e}")))?;

    let mut last_spawn_error: Option<String> = None;
    for candidate in candidates {
        let bin_display = candidate.to_string_lossy().to_string();
        let mut command = Command::new(&candidate);
        command.args(&external_agent.transport.args);
        if let Some(dir) = workdir.as_ref() {
            command.current_dir(dir);
        }
        apply_transport_env(
            &mut command,
            external_agent,
            parent_conversation_id,
            session_id,
            action,
        );
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let spawn_result = command.spawn();
        let mut child = match spawn_result {
            Ok(child) => child,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                last_spawn_error = Some(format!("{} 不存在", candidate.display()));
                continue;
            }
            Err(err) => {
                last_spawn_error = Some(format!("启动 {} 失败: {err}", candidate.display()));
                continue;
            }
        };

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload_text.as_bytes())
                .await
                .map_err(|e| ToolError::new(format!("{tool_name} 写入 stdin 失败: {e}")))?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|e| ToolError::new(format!("{tool_name} 写入换行失败: {e}")))?;
            stdin
                .flush()
                .await
                .map_err(|e| ToolError::new(format!("{tool_name} flush 失败: {e}")))?;
        }

        let wait_timeout = Duration::from_millis(timeout_ms.saturating_add(WAIT_TIMEOUT_BUFFER_MS));
        let output = tokio::time::timeout(wait_timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                ToolError::timeout(format!(
                    "{tool_name} 等待超时（{}ms）",
                    wait_timeout.as_millis()
                ))
            })?
            .map_err(|e| ToolError::new(format!("{tool_name} wait 失败: {e}")))?;

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

        let parsed = match parse_headless_final_json(&stdout_text, tool_name) {
            Ok(parsed) => parsed,
            Err(err) => {
                return Err(ToolError::new(format!(
                    "{}\nstdout_tail:\n{}\nstderr_tail:\n{}",
                    err.message,
                    tail_to_text(&stdout_tail),
                    tail_to_text(&stderr_tail)
                )));
            }
        };

        let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if ok {
            return Ok(HeadlessInvocationOutput {
                parsed,
                binary_display: bin_display,
                exit_code: output.status.code(),
            });
        }

        let err_code = parsed
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("external_agent_failed");
        let err_msg = parsed
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("外部 agent 执行失败");
        let details = parsed
            .get("error")
            .and_then(|e| e.get("details"))
            .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "<invalid json>".to_string()))
            .unwrap_or_else(|| "{}".to_string());
        return Err(ToolError::new(format!(
            "{tool_name} 失败: code={err_code}, message={err_msg}\nerror.details={details}\nstdout_tail:\n{}\nstderr_tail:\n{}",
            tail_to_text(&stdout_tail),
            tail_to_text(&stderr_tail)
        )));
    }

    let detail =
        last_spawn_error.unwrap_or_else(|| "未找到可执行的 headless 兼容子进程".to_string());
    Err(ToolError::new(format!(
        "{tool_name} 无法启动外部 agent 子进程：{detail}"
    )))
}

fn strip_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for child in map.values_mut() {
                strip_nulls(child);
            }
            map.retain(|_, child| !child.is_null());
        }
        Value::Array(items) => {
            for child in items.iter_mut() {
                strip_nulls(child);
            }
        }
        _ => {}
    }
}

fn to_pretty_json_string(mut value: Value) -> String {
    strip_nulls(&mut value);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
}

fn response_content(parsed: &Value) -> String {
    parsed
        .get("result")
        .and_then(|v| v.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn response_thinking(parsed: &Value) -> Option<String> {
    parsed
        .get("result")
        .and_then(|v| v.get("thinking"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn response_model(parsed: &Value) -> Option<String> {
    parsed
        .get("result")
        .and_then(|v| v.get("model"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn response_session_ref(parsed: &Value) -> Value {
    parsed
        .get("sessionRef")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn response_usage(parsed: &Value) -> Option<Value> {
    parsed.get("usage").cloned()
}

fn response_session_ref_option(parsed: &Value) -> Option<Value> {
    let session_ref = response_session_ref(parsed);
    match &session_ref {
        Value::Object(map) if map.is_empty() => None,
        _ => Some(session_ref),
    }
}

fn headless_output_to_invocation(output: HeadlessInvocationOutput) -> ExternalAgentInvocationOutput {
    ExternalAgentInvocationOutput {
        content: response_content(&output.parsed),
        thinking: response_thinking(&output.parsed),
        model: response_model(&output.parsed),
        usage: response_usage(&output.parsed),
        session_ref: response_session_ref_option(&output.parsed),
        binary_display: output.binary_display,
        exit_code: output.exit_code,
    }
}

fn preview_text(content: &str) -> Option<String> {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.trim();
    if compact.is_empty() {
        return None;
    }
    let mut out = String::new();
    for ch in compact.chars() {
        if out.chars().count() >= SESSION_PREVIEW_LIMIT {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    Some(out)
}

fn session_summary_value(record: &ExternalAgentSessionRecord, display_name: Option<&str>) -> Value {
    json!({
        "sessionId": record.id,
        "agentName": record.agent_name,
        "displayName": display_name,
        "remoteAgentName": record.remote_agent_name,
        "transport": record.transport_type.as_str(),
        "sessionMode": if record.transport_type == ExternalAgentTransportType::Headless { "native" } else { "replay" },
        "title": record.title,
        "status": record.status,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "childConversationId": record.child_conversation_id,
        "dbPath": record.db_path,
        "modelRef": record.model_ref,
        "runMode": record.run_mode,
        "cwd": record.cwd,
        "lastResultPreview": record.last_result_preview,
        "lastError": record.last_error,
    })
}

fn find_owned_session_mut<'a>(
    store: &'a mut ExternalAgentSessionStore,
    session_id: &str,
    parent_conversation_id: &str,
) -> Result<&'a mut ExternalAgentSessionRecord, ToolError> {
    let record = store
        .sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| ToolError::invalid(format!("agent_session 未找到会话：{session_id}")))?;
    if record.parent_conversation_id != parent_conversation_id {
        return Err(ToolError::denied(
            "agent_session 只允许访问当前对话创建的外部会话",
        ));
    }
    Ok(record)
}

async fn run_agent_run(
    ctx: &mut ToolExecutionContext<'_>,
    call: &ToolCall,
) -> Result<ToolCallResult, ToolError> {
    validate_desktop_subprocess_support(AGENT_RUN_TOOL_NAME)?;
    let args = parse_agent_run_args(call)?;
    let prompt = resolve_prompt(
        AGENT_RUN_TOOL_NAME,
        args.prompt.as_deref(),
        args.content.as_deref(),
    )?;
    let config = load_app_config()?;
    let external_agent_name =
        resolve_required_external_agent_name(AGENT_RUN_TOOL_NAME, args.agent_name.as_deref())?;
    let external_agent = resolve_external_agent(&config, &external_agent_name)?;

    let effective_model_ref = normalize_optional_string(args.model_ref.as_deref())
        .or_else(|| normalize_optional_string(external_agent.model_ref.as_deref()));
    let effective_run_mode = normalize_optional_string(args.run_mode.as_deref())
        .or_else(|| normalize_optional_string(external_agent.run_mode.as_deref()));
    let effective_thinking = args
        .thinking
        .clone()
        .or_else(|| external_agent.thinking.clone());
    let effective_timeout_ms = args
        .timeout_ms
        .or(external_agent.default_timeout_ms)
        .unwrap_or(DEFAULT_RUNTIME_TIMEOUT_MS)
        .clamp(1_000, 3_600_000);
    if external_agent.transport.transport_type == ExternalAgentTransportType::Headless {
        maybe_validate_auto_headless_target(
            &config,
            external_agent,
            effective_model_ref.as_deref(),
            effective_run_mode.as_deref(),
        )?;
    }

    let workdir = resolve_effective_workdir(
        ctx,
        args.cwd.as_deref(),
        external_agent.transport.cwd.as_ref(),
    )?;

    let output = match external_agent.transport.transport_type {
        ExternalAgentTransportType::Headless => {
            let request_payload = json!({
                "requestId": format!("agent_run_{}", uuid::Uuid::new_v4()),
                "task": {
                    "content": prompt,
                    "agentName": effective_remote_agent_name(external_agent),
                    "modelRef": effective_model_ref.clone(),
                    "runMode": effective_run_mode.clone(),
                    "thinking": effective_thinking.clone(),
                },
                "session": {
                    "backend": "memory",
                    "mode": "new",
                    "title": format!("agent_run:{}", external_agent.name),
                },
                "output": {
                    "mode": "final_json",
                    "includeEvents": false,
                    "includeMessages": false,
                },
                "runtime": {
                    "timeoutMs": effective_timeout_ms,
                }
            });
            headless_output_to_invocation(
                invoke_external_headless(
                    AGENT_RUN_TOOL_NAME,
                    external_agent,
                    &request_payload,
                    effective_timeout_ms,
                    workdir.clone(),
                    ctx.conversation_id,
                    None,
                    None,
                )
                .await?,
            )
        }
        ExternalAgentTransportType::CodexCli | ExternalAgentTransportType::ClaudeCode => {
            invoke_cli_transport(
                AGENT_RUN_TOOL_NAME,
                external_agent,
                &prompt,
                effective_model_ref.as_deref(),
                effective_timeout_ms,
                workdir.as_deref(),
                ctx.conversation_id,
                None,
                None,
            )
            .await?
        }
    };

    let cwd = workdir
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let remote_agent_name = normalize_optional_string(external_agent.remote_agent_name.as_deref());
    let binary_display = output.binary_display;
    let exit_code = output.exit_code;
    let content = output.content;
    let thinking = output.thinking;
    let model = output.model.or_else(|| effective_model_ref.clone());
    let usage = output.usage;
    let session = output.session_ref;
    let response = to_pretty_json_string(json!({
        "agentName": external_agent.name,
        "displayName": external_agent.display_name,
        "remoteAgentName": remote_agent_name,
        "transport": external_agent.transport.transport_type.as_str(),
        "content": content,
        "thinking": thinking,
        "model": model,
        "usage": usage,
        "session": session,
        "cwd": cwd,
    }));

    Ok(ToolCallResult {
        content: response,
        meta: Some(json!({
            "agentRun": {
                "implementation": external_agent.transport.transport_type.as_str(),
                "agentName": external_agent.name,
                "displayName": external_agent.display_name,
                "binary": binary_display,
                "exitCode": exit_code,
                "timeoutMs": effective_timeout_ms,
                "cwd": cwd,
            }
        })),
    })
}

async fn run_agent_session_start(
    ctx: &mut ToolExecutionContext<'_>,
    config: &AppConfig,
    external_agent: &ExternalAgentConfig,
    args: &AgentSessionArgs,
    prompt: &str,
    store: &mut ExternalAgentSessionStore,
) -> Result<ToolCallResult, ToolError> {
    let session_id = format!("agent_session_{}", uuid::Uuid::new_v4());
    let remote_agent_name = effective_remote_agent_name(external_agent);
    let effective_model_ref = normalize_optional_string(args.model_ref.as_deref())
        .or_else(|| normalize_optional_string(external_agent.model_ref.as_deref()));
    let effective_run_mode = normalize_optional_string(args.run_mode.as_deref())
        .or_else(|| normalize_optional_string(external_agent.run_mode.as_deref()));
    let effective_thinking = args
        .thinking
        .clone()
        .or_else(|| external_agent.thinking.clone());
    let effective_timeout_ms = args
        .timeout_ms
        .or(external_agent.default_timeout_ms)
        .unwrap_or(DEFAULT_RUNTIME_TIMEOUT_MS)
        .clamp(1_000, 3_600_000);
    if external_agent.transport.transport_type == ExternalAgentTransportType::Headless {
        maybe_validate_auto_headless_target(
            config,
            external_agent,
            effective_model_ref.as_deref(),
            effective_run_mode.as_deref(),
        )?;
    }

    let workdir = resolve_effective_workdir(
        ctx,
        args.cwd.as_deref(),
        external_agent.transport.cwd.as_ref(),
    )?;
    let title = normalize_optional_string(args.title.as_deref())
        .unwrap_or_else(|| format!("{} Session", external_agent.display_name));

    let (record, output) = match external_agent.transport.transport_type {
        ExternalAgentTransportType::Headless => {
            let db_path = session_db_path(&session_id)?;
            if let Some(parent) = db_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    ToolError::new(format!(
                        "创建 external agent session DB 目录失败（{}）: {e}",
                        parent.display()
                    ))
                })?;
            }

            let request_payload = json!({
                "requestId": format!("agent_session_start_{}", uuid::Uuid::new_v4()),
                "task": {
                    "content": prompt,
                    "agentName": remote_agent_name.clone(),
                    "modelRef": effective_model_ref.clone(),
                    "runMode": effective_run_mode.clone(),
                    "thinking": effective_thinking.clone(),
                },
                "session": {
                    "backend": "db",
                    "mode": "new",
                    "dbPath": db_path.to_string_lossy().to_string(),
                    "title": title.clone(),
                },
                "output": {
                    "mode": "final_json",
                    "includeEvents": false,
                    "includeMessages": false,
                },
                "runtime": {
                    "timeoutMs": effective_timeout_ms,
                }
            });

            let output = headless_output_to_invocation(
                invoke_external_headless(
                    AGENT_SESSION_TOOL_NAME,
                    external_agent,
                    &request_payload,
                    effective_timeout_ms,
                    workdir.clone(),
                    ctx.conversation_id,
                    Some(session_id.as_str()),
                    Some(AgentSessionAction::Start),
                )
                .await?,
            );
            let session_ref = output.session_ref.clone().ok_or_else(|| {
                ToolError::new("agent_session(start) 缺少 sessionRef.conversationId")
            })?;
            let child_conversation_id = session_ref
                .get("conversationId")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::new("agent_session(start) 缺少 sessionRef.conversationId"))?
                .to_string();
            let stored_db_path = session_ref
                .get("dbPath")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| Some(db_path.to_string_lossy().to_string()));
            let now = Utc::now();
            (
                ExternalAgentSessionRecord {
                    id: session_id.clone(),
                    parent_conversation_id: ctx.conversation_id.to_string(),
                    agent_name: external_agent.name.clone(),
                    remote_agent_name: remote_agent_name.clone(),
                    title: title.clone(),
                    status: ExternalAgentSessionStatus::Active,
                    created_at: now,
                    updated_at: now,
                    transport_type: external_agent.transport.transport_type,
                    child_conversation_id,
                    db_path: stored_db_path,
                    model_ref: effective_model_ref.clone(),
                    run_mode: effective_run_mode.clone(),
                    thinking: effective_thinking.clone(),
                    cwd: workdir
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                    replay_messages: Vec::new(),
                    last_result_preview: preview_text(&output.content),
                    last_error: None,
                },
                output,
            )
        }
        ExternalAgentTransportType::CodexCli | ExternalAgentTransportType::ClaudeCode => {
            let output = invoke_cli_transport(
                AGENT_SESSION_TOOL_NAME,
                external_agent,
                prompt,
                effective_model_ref.as_deref(),
                effective_timeout_ms,
                workdir.as_deref(),
                ctx.conversation_id,
                Some(session_id.as_str()),
                Some(AgentSessionAction::Start.as_str()),
            )
            .await?;
            let now = Utc::now();
            (
                ExternalAgentSessionRecord {
                    id: session_id.clone(),
                    parent_conversation_id: ctx.conversation_id.to_string(),
                    agent_name: external_agent.name.clone(),
                    remote_agent_name: remote_agent_name.clone(),
                    title: title.clone(),
                    status: ExternalAgentSessionStatus::Active,
                    created_at: now,
                    updated_at: now,
                    transport_type: external_agent.transport.transport_type,
                    child_conversation_id: session_id.clone(),
                    db_path: None,
                    model_ref: effective_model_ref.clone(),
                    run_mode: effective_run_mode.clone(),
                    thinking: effective_thinking.clone(),
                    cwd: workdir
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                    replay_messages: vec![
                        ExternalAgentReplayMessage {
                            role: ExternalAgentReplayRole::User,
                            content: prompt.to_string(),
                        },
                        ExternalAgentReplayMessage {
                            role: ExternalAgentReplayRole::Assistant,
                            content: output.content.clone(),
                        },
                    ],
                    last_result_preview: preview_text(&output.content),
                    last_error: None,
                },
                output,
            )
        }
    };

    store.sessions.push(record.clone());
    save_session_store(store)?;

    let binary_display = output.binary_display;
    let exit_code = output.exit_code;
    let content = output.content;
    let thinking = output.thinking;
    let model = output.model.or_else(|| effective_model_ref.clone());
    let usage = output.usage;
    let response = to_pretty_json_string(json!({
        "action": AgentSessionAction::Start,
        "session": session_summary_value(&record, Some(external_agent.display_name.as_str())),
        "content": content,
        "thinking": thinking,
        "model": model,
        "usage": usage,
    }));

    Ok(ToolCallResult {
        content: response,
        meta: Some(json!({
            "agentSession": {
                "action": "start",
                "sessionId": session_id,
                "agentName": external_agent.name,
                "displayName": external_agent.display_name,
                "implementation": external_agent.transport.transport_type.as_str(),
                "binary": binary_display,
                "exitCode": exit_code,
                "timeoutMs": effective_timeout_ms,
            }
        })),
    })
}

async fn run_agent_session_send(
    ctx: &mut ToolExecutionContext<'_>,
    config: &AppConfig,
    args: &AgentSessionArgs,
    prompt: &str,
    store: &mut ExternalAgentSessionStore,
) -> Result<ToolCallResult, ToolError> {
    let session_id = resolve_required_session_id(args)?;
    let record = find_owned_session_mut(store, &session_id, ctx.conversation_id)?;
    if record.status != ExternalAgentSessionStatus::Active {
        return Err(ToolError::denied(format!(
            "agent_session 会话已关闭：{session_id}"
        )));
    }
    let external_agent = resolve_external_agent(config, &record.agent_name)?;
    if external_agent.transport.transport_type != record.transport_type {
        return Err(ToolError::new(format!(
            "agent_session 当前配置的 transport 已变化：session={}, current={}",
            record.transport_type.as_str(),
            external_agent.transport.transport_type.as_str()
        )));
    }

    let effective_model_ref =
        normalize_optional_string(args.model_ref.as_deref()).or_else(|| record.model_ref.clone());
    let effective_run_mode =
        normalize_optional_string(args.run_mode.as_deref()).or_else(|| record.run_mode.clone());
    let effective_thinking = args.thinking.clone().or_else(|| record.thinking.clone());
    let effective_timeout_ms = args
        .timeout_ms
        .or(external_agent.default_timeout_ms)
        .unwrap_or(DEFAULT_RUNTIME_TIMEOUT_MS)
        .clamp(1_000, 3_600_000);
    if record.transport_type == ExternalAgentTransportType::Headless {
        maybe_validate_auto_headless_target(
            config,
            external_agent,
            effective_model_ref.as_deref(),
            effective_run_mode.as_deref(),
        )?;
    }

    let workdir = resolve_effective_workdir(
        ctx,
        args.cwd.as_deref().or(record.cwd.as_deref()),
        external_agent.transport.cwd.as_ref(),
    )?;

    let output_result = match record.transport_type {
        ExternalAgentTransportType::Headless => {
            let db_path = record.db_path.clone().ok_or_else(|| {
                ToolError::new(format!("agent_session 会话缺少 dbPath：{session_id}"))
            })?;
            let request_payload = json!({
                "requestId": format!("agent_session_send_{}", uuid::Uuid::new_v4()),
                "task": {
                    "content": prompt,
                    "agentName": record.remote_agent_name.clone(),
                    "modelRef": effective_model_ref.clone(),
                    "runMode": effective_run_mode.clone(),
                    "thinking": effective_thinking.clone(),
                },
                "session": {
                    "backend": "db",
                    "mode": "resume",
                    "conversationId": record.child_conversation_id.clone(),
                    "dbPath": db_path,
                    "title": record.title.clone(),
                },
                "output": {
                    "mode": "final_json",
                    "includeEvents": false,
                    "includeMessages": false,
                },
                "runtime": {
                    "timeoutMs": effective_timeout_ms,
                }
            });
            invoke_external_headless(
                AGENT_SESSION_TOOL_NAME,
                external_agent,
                &request_payload,
                effective_timeout_ms,
                workdir.clone(),
                ctx.conversation_id,
                Some(session_id.as_str()),
                Some(AgentSessionAction::Send),
            )
            .await
            .map(headless_output_to_invocation)
        }
        ExternalAgentTransportType::CodexCli | ExternalAgentTransportType::ClaudeCode => {
            let replay_prompt = build_replay_prompt(&record.title, &record.replay_messages, prompt);
            invoke_cli_transport(
                AGENT_SESSION_TOOL_NAME,
                external_agent,
                &replay_prompt,
                effective_model_ref.as_deref(),
                effective_timeout_ms,
                workdir.as_deref(),
                ctx.conversation_id,
                Some(session_id.as_str()),
                Some(AgentSessionAction::Send.as_str()),
            )
            .await
        }
    };

    let output = match output_result {
        Ok(output) => output,
        Err(err) => {
            record.updated_at = Utc::now();
            record.last_error = Some(err.message.clone());
            save_session_store(store)?;
            return Err(err);
        }
    };

    record.updated_at = Utc::now();
    record.model_ref = effective_model_ref.clone();
    record.run_mode = effective_run_mode.clone();
    record.thinking = effective_thinking.clone();
    record.cwd = workdir
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    if record.transport_type != ExternalAgentTransportType::Headless {
        record.replay_messages.push(ExternalAgentReplayMessage {
            role: ExternalAgentReplayRole::User,
            content: prompt.to_string(),
        });
        record.replay_messages.push(ExternalAgentReplayMessage {
            role: ExternalAgentReplayRole::Assistant,
            content: output.content.clone(),
        });
    }
    record.last_result_preview = preview_text(&output.content);
    record.last_error = None;
    let implementation = record.transport_type.as_str().to_string();
    let summary = session_summary_value(record, Some(external_agent.display_name.as_str()));
    save_session_store(store)?;

    let binary_display = output.binary_display;
    let exit_code = output.exit_code;
    let content = output.content;
    let thinking = output.thinking;
    let model = output.model.or_else(|| effective_model_ref.clone());
    let usage = output.usage;
    let response = to_pretty_json_string(json!({
        "action": AgentSessionAction::Send,
        "session": summary,
        "content": content,
        "thinking": thinking,
        "model": model,
        "usage": usage,
    }));

    Ok(ToolCallResult {
        content: response,
        meta: Some(json!({
            "agentSession": {
                "action": "send",
                "sessionId": session_id,
                "agentName": external_agent.name,
                "displayName": external_agent.display_name,
                "implementation": implementation,
                "binary": binary_display,
                "exitCode": exit_code,
                "timeoutMs": effective_timeout_ms,
            }
        })),
    })
}

fn run_agent_session_info(
    ctx: &ToolExecutionContext<'_>,
    config: &AppConfig,
    args: &AgentSessionArgs,
    store: &ExternalAgentSessionStore,
) -> Result<ToolCallResult, ToolError> {
    let session_id = resolve_required_session_id(args)?;
    let record = store
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| ToolError::invalid(format!("agent_session 未找到会话：{session_id}")))?;
    if record.parent_conversation_id != ctx.conversation_id {
        return Err(ToolError::denied(
            "agent_session 只允许访问当前对话创建的外部会话",
        ));
    }
    let display_name = config
        .get_external_agent(&record.agent_name)
        .map(|agent| agent.display_name.as_str());
    Ok(ToolCallResult {
        content: to_pretty_json_string(json!({
            "action": AgentSessionAction::Info,
            "session": session_summary_value(record, display_name),
        })),
        meta: Some(json!({
            "agentSession": {
                "action": "info",
                "sessionId": session_id,
            }
        })),
    })
}

fn run_agent_session_list(
    ctx: &ToolExecutionContext<'_>,
    config: &AppConfig,
    store: &ExternalAgentSessionStore,
) -> Result<ToolCallResult, ToolError> {
    let mut sessions = store
        .sessions
        .iter()
        .filter(|session| session.parent_conversation_id == ctx.conversation_id)
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let sessions = sessions
        .into_iter()
        .map(|session| {
            let display_name = config
                .get_external_agent(&session.agent_name)
                .map(|agent| agent.display_name.as_str());
            session_summary_value(session, display_name)
        })
        .collect::<Vec<_>>();
    Ok(ToolCallResult {
        content: to_pretty_json_string(json!({
            "action": AgentSessionAction::List,
            "sessions": sessions,
        })),
        meta: Some(json!({
            "agentSession": {
                "action": "list",
                "count": sessions.len(),
            }
        })),
    })
}

fn run_agent_session_close(
    ctx: &ToolExecutionContext<'_>,
    config: &AppConfig,
    args: &AgentSessionArgs,
    store: &mut ExternalAgentSessionStore,
) -> Result<ToolCallResult, ToolError> {
    let session_id = resolve_required_session_id(args)?;
    let delete_session_db = args.delete_session_db.unwrap_or(false);
    let record = find_owned_session_mut(store, &session_id, ctx.conversation_id)?;
    let existing_db_path = record.db_path.clone();
    let mut deleted_db = false;
    if delete_session_db {
        if let Some(path) = existing_db_path.as_deref() {
            match fs::remove_file(path) {
                Ok(()) => {
                    deleted_db = true;
                    record.db_path = None;
                }
                Err(err) if err.kind() == ErrorKind::NotFound => {
                    deleted_db = true;
                    record.db_path = None;
                }
                Err(err) => {
                    return Err(ToolError::new(format!(
                        "agent_session 删除 DB 文件失败（{}）: {err}",
                        path
                    )));
                }
            }
        }
    }
    record.status = ExternalAgentSessionStatus::Closed;
    record.updated_at = Utc::now();
    let display_name = config
        .get_external_agent(&record.agent_name)
        .map(|agent| agent.display_name.as_str());
    let summary = session_summary_value(record, display_name);
    save_session_store(store)?;

    Ok(ToolCallResult {
        content: to_pretty_json_string(json!({
            "action": AgentSessionAction::Close,
            "deletedDb": deleted_db,
            "session": summary,
        })),
        meta: Some(json!({
            "agentSession": {
                "action": "close",
                "sessionId": session_id,
                "deletedDb": deleted_db,
            }
        })),
    })
}

async fn run_agent_session(
    ctx: &mut ToolExecutionContext<'_>,
    call: &ToolCall,
) -> Result<ToolCallResult, ToolError> {
    validate_desktop_subprocess_support(AGENT_SESSION_TOOL_NAME)?;
    let args = parse_agent_session_args(call)?;
    let config = load_app_config()?;
    let mut store = load_session_store()?;

    match args.action {
        AgentSessionAction::Start => {
            let external_agent_name = resolve_required_external_agent_name(
                AGENT_SESSION_TOOL_NAME,
                args.agent_name.as_deref(),
            )?;
            let external_agent = resolve_external_agent(&config, &external_agent_name)?;
            let prompt = resolve_prompt(
                AGENT_SESSION_TOOL_NAME,
                args.prompt.as_deref(),
                args.content.as_deref(),
            )?;
            run_agent_session_start(ctx, &config, external_agent, &args, &prompt, &mut store).await
        }
        AgentSessionAction::Send => {
            let prompt = resolve_prompt(
                AGENT_SESSION_TOOL_NAME,
                args.prompt.as_deref(),
                args.content.as_deref(),
            )?;
            run_agent_session_send(ctx, &config, &args, &prompt, &mut store).await
        }
        AgentSessionAction::Info => run_agent_session_info(ctx, &config, &args, &store),
        AgentSessionAction::List => run_agent_session_list(ctx, &config, &store),
        AgentSessionAction::Close => run_agent_session_close(ctx, &config, &args, &mut store),
    }
}

#[async_trait]
impl ToolHandler for AgentRunTool {
    fn spec(&self) -> ToolSpec {
        build_agent_run_spec()
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        run_agent_run(ctx, call).await
    }
}

#[async_trait]
impl ToolHandler for AgentSessionTool {
    fn spec(&self) -> ToolSpec {
        build_agent_session_spec()
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        run_agent_session(ctx, call).await
    }
}
