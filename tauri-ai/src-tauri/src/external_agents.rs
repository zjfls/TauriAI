use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::models::{
    ExternalAgentConfig, ExternalAgentTransportConfig, ExternalAgentTransportType,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::runtime::tools::registry::ToolError;

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Clone)]
struct ToolError {
    message: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl ToolError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    fn timeout(message: impl Into<String>) -> Self {
        Self::new(message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(message)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl std::error::Error for ToolError {}

const STDERR_TAIL_LIMIT: usize = 24;
const STDOUT_TAIL_LIMIT: usize = 24;
const VERSION_TIMEOUT_MS: u64 = 2_500;
const WAIT_TIMEOUT_BUFFER_MS: u64 = 8_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAgentSessionMode {
    Native,
    Replay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentProbeInfo {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub transport_type: ExternalAgentTransportType,
    pub program_name: String,
    pub detected: bool,
    pub command_path: Option<String>,
    pub command_source: String,
    pub version: Option<String>,
    pub supports_run: bool,
    pub supports_session: bool,
    pub session_mode: ExternalAgentSessionMode,
    pub suggested_config: ExternalAgentConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAgentReplayRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentReplayMessage {
    pub role: ExternalAgentReplayRole,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ExternalAgentInvocationOutput {
    pub content: String,
    pub thinking: Option<String>,
    pub model: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub session_ref: Option<serde_json::Value>,
    pub binary_display: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy)]
struct KnownExternalAgentSpec {
    name: &'static str,
    display_name: &'static str,
    description: &'static str,
    program_name: &'static str,
    transport_type: ExternalAgentTransportType,
    supports_run: bool,
    supports_session: bool,
    session_mode: ExternalAgentSessionMode,
}

#[derive(Debug, Clone)]
struct CommandCandidate {
    path: PathBuf,
    source: &'static str,
}

const KNOWN_EXTERNAL_AGENTS: [KnownExternalAgentSpec; 3] = [
    KnownExternalAgentSpec {
        name: "tauri_headless",
        display_name: "TauriAI Headless",
        description: "调用本地 tauri-ai-headless sidecar，复用当前 TauriAI 配置中的智能体。",
        program_name: "tauri-ai-headless",
        transport_type: ExternalAgentTransportType::Headless,
        supports_run: true,
        supports_session: true,
        session_mode: ExternalAgentSessionMode::Native,
    },
    KnownExternalAgentSpec {
        name: "codex",
        display_name: "Codex CLI",
        description: "调用本机 codex CLI，适合一次性委托或回放式子会话。",
        program_name: "codex",
        transport_type: ExternalAgentTransportType::CodexCli,
        supports_run: true,
        supports_session: true,
        session_mode: ExternalAgentSessionMode::Replay,
    },
    KnownExternalAgentSpec {
        name: "claude_code",
        display_name: "Claude Code",
        description: "调用本机 Claude Code CLI，适合一次性委托或原生持久会话。",
        program_name: "claude",
        transport_type: ExternalAgentTransportType::ClaudeCode,
        supports_run: true,
        supports_session: true,
        session_mode: ExternalAgentSessionMode::Native,
    },
];

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
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

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    match fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn unique_candidates(candidates: Vec<CommandCandidate>) -> Vec<CommandCandidate> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::<CommandCandidate>::new();
    for candidate in candidates {
        let key = candidate.path.to_string_lossy().to_string();
        if seen.insert(key) {
            out.push(candidate);
        }
    }
    out
}

fn path_command_candidates(program_names: &[&str]) -> Vec<CommandCandidate> {
    let mut candidates = Vec::<CommandCandidate>::new();
    let path_entries = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let extensions = std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter_map(|entry| {
                    let trimmed = entry.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                })
                .collect::<Vec<_>>()
        })
        .filter(|entries| !entries.is_empty())
        .unwrap_or_else(|| vec![".exe".to_string(), ".cmd".to_string(), ".bat".to_string()]);

    #[cfg(not(target_os = "windows"))]
    let extensions = vec![String::new()];

    for program_name in program_names {
        for dir in &path_entries {
            for extension in &extensions {
                let file_name = if extension.is_empty() || program_name.ends_with(extension) {
                    (*program_name).to_string()
                } else {
                    format!("{program_name}{extension}")
                };
                candidates.push(CommandCandidate {
                    path: dir.join(file_name),
                    source: "path",
                });
            }
        }
    }

    unique_candidates(candidates)
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

fn headless_command_candidates() -> Vec<CommandCandidate> {
    let mut candidates = Vec::<CommandCandidate>::new();

    if let Some(bin) = std::env::var("TAURIAI_HEADLESS_BIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        candidates.push(CommandCandidate {
            path: PathBuf::from(bin),
            source: "env",
        });
    }

    let binary_names = headless_binary_names();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            for name in &binary_names {
                candidates.push(CommandCandidate {
                    path: dir.join(name),
                    source: "sidecar",
                });
            }
            if let Some(parent) = dir.parent() {
                for name in &binary_names {
                    candidates.push(CommandCandidate {
                        path: parent.join("MacOS").join(name),
                        source: "sidecar",
                    });
                    candidates.push(CommandCandidate {
                        path: parent.join("Resources").join(name),
                        source: "sidecar",
                    });
                }
            }
        }
    }

    let path_refs = binary_names.iter().map(String::as_str).collect::<Vec<_>>();
    candidates.extend(path_command_candidates(&path_refs));

    unique_candidates(candidates)
}

pub(crate) fn default_command_candidates(
    transport_type: ExternalAgentTransportType,
) -> Vec<PathBuf> {
    let candidates = match transport_type {
        ExternalAgentTransportType::Headless => headless_command_candidates(),
        ExternalAgentTransportType::CodexCli => path_command_candidates(&["codex"]),
        ExternalAgentTransportType::ClaudeCode => path_command_candidates(&["claude"]),
    };
    candidates
        .into_iter()
        .map(|candidate| candidate.path)
        .collect()
}

async fn probe_version(path: &Path) -> Option<String> {
    let output = tokio::time::timeout(Duration::from_millis(VERSION_TIMEOUT_MS), async {
        Command::new(path)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
    })
    .await
    .ok()?
    .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn suggested_config(spec: KnownExternalAgentSpec) -> ExternalAgentConfig {
    ExternalAgentConfig {
        name: spec.name.to_string(),
        enabled: false,
        display_name: spec.display_name.to_string(),
        description: Some(spec.description.to_string()),
        task_usage: None,
        remote_agent_name: None,
        model_ref: None,
        run_mode: None,
        thinking: None,
        default_timeout_ms: Some(120_000),
        transport: ExternalAgentTransportConfig {
            transport_type: spec.transport_type,
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            env_vars: Vec::new(),
            cwd: None,
        },
    }
}

pub(crate) async fn probe_known_external_agents() -> Vec<ExternalAgentProbeInfo> {
    let mut results = Vec::<ExternalAgentProbeInfo>::new();

    for spec in KNOWN_EXTERNAL_AGENTS {
        let mut detected = false;
        let mut command_path = None;
        let mut command_source = "missing".to_string();
        let mut version = None;

        let candidates = match spec.transport_type {
            ExternalAgentTransportType::Headless => headless_command_candidates(),
            ExternalAgentTransportType::CodexCli => path_command_candidates(&["codex"]),
            ExternalAgentTransportType::ClaudeCode => path_command_candidates(&["claude"]),
        };

        for candidate in candidates {
            if !is_executable(&candidate.path) {
                continue;
            }
            detected = true;
            command_source = candidate.source.to_string();
            command_path = Some(candidate.path.to_string_lossy().to_string());
            version = probe_version(&candidate.path).await;
            break;
        }

        results.push(ExternalAgentProbeInfo {
            name: spec.name.to_string(),
            display_name: spec.display_name.to_string(),
            description: Some(spec.description.to_string()),
            transport_type: spec.transport_type,
            program_name: spec.program_name.to_string(),
            detected,
            command_path,
            command_source,
            version,
            supports_run: spec.supports_run,
            supports_session: spec.supports_session,
            session_mode: spec.session_mode,
            suggested_config: suggested_config(spec),
        });
    }

    results
}

fn apply_transport_env(
    command: &mut Command,
    external_agent: &ExternalAgentConfig,
    parent_conversation_id: &str,
    session_id: Option<&str>,
    action: Option<&str>,
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
        command.env("TAURIAI_AGENT_SESSION_ACTION", action);
    }
}

async fn wait_for_command(
    tool_name: &str,
    child: tokio::process::Child,
    timeout_ms: u64,
) -> Result<std::process::Output, ToolError> {
    let wait_timeout = Duration::from_millis(timeout_ms.saturating_add(WAIT_TIMEOUT_BUFFER_MS));
    tokio::time::timeout(wait_timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            ToolError::timeout(format!(
                "{tool_name} 等待外部 CLI 超时（{}ms）",
                wait_timeout.as_millis()
            ))
        })?
        .map_err(|e| ToolError::new(format!("{tool_name} wait 失败: {e}")))
}

fn resolve_command_path(
    external_agent: &ExternalAgentConfig,
) -> Result<(PathBuf, String), ToolError> {
    if let Some(command) = normalize_optional_string(external_agent.transport.command.as_deref()) {
        let path = PathBuf::from(&command);
        return Ok((path, command));
    }

    let candidates = default_command_candidates(external_agent.transport.transport_type);
    for candidate in candidates {
        if is_executable(&candidate) {
            let display = candidate.to_string_lossy().to_string();
            return Ok((candidate, display));
        }
    }

    Err(ToolError::new(format!(
        "external agent 未找到可执行程序：{}（transport={}）",
        external_agent.name,
        external_agent.transport.transport_type.as_str()
    )))
}

fn read_output_tails(stdout: &[u8], stderr: &[u8]) -> (String, String, String, String) {
    let stdout_text = String::from_utf8_lossy(stdout).to_string();
    let stderr_text = String::from_utf8_lossy(stderr).to_string();
    let mut stdout_tail = VecDeque::<String>::new();
    let mut stderr_tail = VecDeque::<String>::new();
    for line in stdout_text.lines() {
        tail_push(&mut stdout_tail, line.to_string(), STDOUT_TAIL_LIMIT);
    }
    for line in stderr_text.lines() {
        tail_push(&mut stderr_tail, line.to_string(), STDERR_TAIL_LIMIT);
    }
    (
        stdout_text,
        stderr_text,
        tail_to_text(&stdout_tail),
        tail_to_text(&stderr_tail),
    )
}

fn trimmed_output_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClaudeCodeJson {
    System {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    Assistant {
        message: ClaudeCodeMessage,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        uuid: Option<String>,
    },
    User {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        uuid: Option<String>,
    },
    ToolUse {
        #[serde(default)]
        session_id: Option<String>,
    },
    ToolResult {
        #[serde(default)]
        session_id: Option<String>,
    },
    StreamEvent {
        event: ClaudeCodeStreamEvent,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        uuid: Option<String>,
    },
    Result {
        #[serde(default, alias = "sessionId")]
        session_id: Option<String>,
        #[serde(default)]
        usage: Option<ClaudeCodeUsage>,
    },
    #[serde(untagged)]
    Unknown {
        #[serde(flatten)]
        data: HashMap<String, Value>,
    },
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    content: ClaudeCodeMessageContent,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ClaudeCodeMessageContent {
    Array(Vec<ClaudeCodeContentItem>),
    Text(String),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClaudeCodeContentItem {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClaudeCodeStreamEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: ClaudeCodeMessage },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: ClaudeCodeContentBlockDelta },
    #[serde(rename = "message_delta")]
    MessageDelta {
        #[serde(default)]
        usage: Option<ClaudeCodeUsage>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClaudeCodeContentBlockDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { thinking: String },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ClaudeCodeUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default, rename = "cache_creation_input_tokens")]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default, rename = "cache_read_input_tokens")]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    service_tier: Option<String>,
}

#[derive(Debug)]
struct ClaudeCodeParsedOutput {
    content: String,
    thinking: Option<String>,
    model: Option<String>,
    usage: Option<Value>,
    session_id: Option<String>,
    message_id: Option<String>,
}

fn merge_optional_string(target: &mut Option<String>, candidate: Option<String>) {
    if target.is_none() {
        *target = candidate.filter(|value| !value.trim().is_empty());
    }
}

fn append_nonempty(target: &mut String, value: &str) {
    if !value.is_empty() {
        target.push_str(value);
    }
}

fn claude_message_text(content: &ClaudeCodeMessageContent) -> Option<String> {
    match content {
        ClaudeCodeMessageContent::Text(text) => trimmed_output_text(text),
        ClaudeCodeMessageContent::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| match item {
                    ClaudeCodeContentItem::Text { text } => Some(text.as_str()),
                    ClaudeCodeContentItem::Thinking { .. } | ClaudeCodeContentItem::Unknown => None,
                })
                .collect::<Vec<_>>()
                .join("");
            trimmed_output_text(&text)
        }
    }
}

fn claude_message_thinking(content: &ClaudeCodeMessageContent) -> Option<String> {
    match content {
        ClaudeCodeMessageContent::Text(_) => None,
        ClaudeCodeMessageContent::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| match item {
                    ClaudeCodeContentItem::Thinking { thinking } => Some(thinking.as_str()),
                    ClaudeCodeContentItem::Text { .. } | ClaudeCodeContentItem::Unknown => None,
                })
                .collect::<Vec<_>>()
                .join("");
            trimmed_output_text(&text)
        }
    }
}

fn claude_usage_to_json(usage: &ClaudeCodeUsage) -> Option<Value> {
    let cache_creation_input_tokens = usage.cache_creation_input_tokens.unwrap_or(0);
    let cache_read_input_tokens = usage.cache_read_input_tokens.unwrap_or(0);
    let prompt_tokens = usage
        .input_tokens
        .unwrap_or(0)
        .saturating_add(cache_creation_input_tokens)
        .saturating_add(cache_read_input_tokens);
    let completion_tokens = usage.output_tokens.unwrap_or(0);
    let total_tokens = prompt_tokens.saturating_add(completion_tokens);
    if prompt_tokens == 0
        && completion_tokens == 0
        && cache_creation_input_tokens == 0
        && cache_read_input_tokens == 0
    {
        return None;
    }
    let mut usage_value = json!({
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "cacheCreationInputTokens": cache_creation_input_tokens,
        "cacheReadInputTokens": cache_read_input_tokens,
    });
    if let Some(service_tier) = usage.service_tier.as_ref() {
        if let Some(map) = usage_value.as_object_mut() {
            map.insert(
                "serviceTier".to_string(),
                Value::String(service_tier.clone()),
            );
        }
    }
    Some(usage_value)
}

fn parse_claude_stream_json_output(
    stdout_text: &str,
) -> Result<Option<ClaudeCodeParsedOutput>, String> {
    let mut parsed_line_count = 0usize;
    let mut assistant_text = None::<String>;
    let mut assistant_thinking = None::<String>;
    let mut stream_text = String::new();
    let mut stream_thinking = String::new();
    let mut session_id = None::<String>;
    let mut message_id = None::<String>;
    let mut model = None::<String>;
    let mut usage = None::<Value>;

    for raw_line in stdout_text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed = match serde_json::from_str::<ClaudeCodeJson>(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        parsed_line_count = parsed_line_count.saturating_add(1);
        match parsed {
            ClaudeCodeJson::System {
                session_id: line_session_id,
                model: line_model,
            } => {
                merge_optional_string(&mut session_id, line_session_id);
                merge_optional_string(&mut model, line_model);
            }
            ClaudeCodeJson::Assistant {
                message,
                session_id: line_session_id,
                uuid,
            } => {
                merge_optional_string(&mut session_id, line_session_id);
                merge_optional_string(&mut message_id, uuid.or_else(|| message.id.clone()));
                merge_optional_string(&mut model, message.model.clone());
                merge_optional_string(&mut assistant_text, claude_message_text(&message.content));
                merge_optional_string(
                    &mut assistant_thinking,
                    claude_message_thinking(&message.content),
                );
            }
            ClaudeCodeJson::User {
                session_id: line_session_id,
                uuid,
            } => {
                merge_optional_string(&mut session_id, line_session_id);
                merge_optional_string(&mut message_id, uuid);
            }
            ClaudeCodeJson::ToolUse {
                session_id: line_session_id,
            }
            | ClaudeCodeJson::ToolResult {
                session_id: line_session_id,
            } => {
                merge_optional_string(&mut session_id, line_session_id);
            }
            ClaudeCodeJson::StreamEvent {
                event,
                session_id: line_session_id,
                uuid,
            } => {
                merge_optional_string(&mut session_id, line_session_id);
                merge_optional_string(&mut message_id, uuid);
                match event {
                    ClaudeCodeStreamEvent::MessageStart { message } => {
                        merge_optional_string(&mut message_id, message.id.clone());
                        merge_optional_string(&mut model, message.model.clone());
                        merge_optional_string(
                            &mut assistant_text,
                            claude_message_text(&message.content),
                        );
                        merge_optional_string(
                            &mut assistant_thinking,
                            claude_message_thinking(&message.content),
                        );
                    }
                    ClaudeCodeStreamEvent::ContentBlockDelta { delta } => match delta {
                        ClaudeCodeContentBlockDelta::TextDelta { text } => {
                            append_nonempty(&mut stream_text, &text);
                        }
                        ClaudeCodeContentBlockDelta::ThinkingDelta { thinking } => {
                            append_nonempty(&mut stream_thinking, &thinking);
                        }
                        ClaudeCodeContentBlockDelta::Unknown => {}
                    },
                    ClaudeCodeStreamEvent::MessageDelta { usage: line_usage } => {
                        if let Some(line_usage) = line_usage.as_ref() {
                            usage = claude_usage_to_json(line_usage).or(usage);
                        }
                    }
                    ClaudeCodeStreamEvent::Unknown => {}
                }
            }
            ClaudeCodeJson::Result {
                session_id: line_session_id,
                usage: line_usage,
            } => {
                merge_optional_string(&mut session_id, line_session_id);
                if let Some(line_usage) = line_usage.as_ref() {
                    usage = claude_usage_to_json(line_usage).or(usage);
                }
            }
            ClaudeCodeJson::Unknown { data } => {
                if let Some(line_session_id) = data.get("session_id").and_then(Value::as_str) {
                    merge_optional_string(&mut session_id, Some(line_session_id.to_string()));
                }
                if let Some(line_message_id) = data.get("uuid").and_then(Value::as_str) {
                    merge_optional_string(&mut message_id, Some(line_message_id.to_string()));
                }
            }
        }
    }

    if parsed_line_count == 0 {
        return Ok(None);
    }

    let content = assistant_text
        .or_else(|| trimmed_output_text(&stream_text))
        .ok_or_else(|| "Claude stream-json 解析成功，但没有提取到 assistant 文本".to_string())?;
    let thinking = assistant_thinking.or_else(|| trimmed_output_text(&stream_thinking));
    Ok(Some(ClaudeCodeParsedOutput {
        content,
        thinking,
        model,
        usage,
        session_id,
        message_id,
    }))
}

async fn invoke_codex_cli(
    tool_name: &str,
    external_agent: &ExternalAgentConfig,
    prompt: &str,
    model_ref: Option<&str>,
    timeout_ms: u64,
    workdir: Option<&Path>,
    parent_conversation_id: &str,
    session_id: Option<&str>,
    action: Option<&str>,
) -> Result<ExternalAgentInvocationOutput, ToolError> {
    let (binary, binary_display) = resolve_command_path(external_agent)?;
    let output_path = std::env::temp_dir().join(format!(
        "tauri-ai-codex-last-message-{}.txt",
        uuid::Uuid::new_v4()
    ));

    let mut command = Command::new(&binary);
    command.arg("exec");
    command.arg("--skip-git-repo-check");
    command.arg("--color");
    command.arg("never");
    command.arg("--output-last-message");
    command.arg(&output_path);
    command.arg("--full-auto");
    command.arg("--ephemeral");
    if let Some(model_ref) = normalize_optional_string(model_ref) {
        command.arg("--model");
        command.arg(model_ref);
    }
    if let Some(dir) = workdir {
        command.current_dir(dir);
        command.arg("-C");
        command.arg(dir);
    }
    command.args(&external_agent.transport.args);
    command.arg(prompt);
    apply_transport_env(
        &mut command,
        external_agent,
        parent_conversation_id,
        session_id,
        action,
    );
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let child = command.spawn().map_err(|err| match err.kind() {
        ErrorKind::NotFound => ToolError::new(format!("启动 {} 失败：命令不存在", binary_display)),
        _ => ToolError::new(format!("启动 {} 失败: {err}", binary_display)),
    })?;

    let output = wait_for_command(tool_name, child, timeout_ms).await?;
    let (stdout_text, _stderr_text, stdout_tail, stderr_tail) =
        read_output_tails(&output.stdout, &output.stderr);
    let file_content = fs::read_to_string(&output_path).ok();
    let _ = fs::remove_file(&output_path);
    let content = file_content
        .as_deref()
        .and_then(trimmed_output_text)
        .or_else(|| trimmed_output_text(&stdout_text));

    if !output.status.success() {
        return Err(ToolError::new(format!(
            "{tool_name} 调用 codex 失败（exit_code={}）\nstdout_tail:\n{}\nstderr_tail:\n{}",
            output.status.code().unwrap_or(-1),
            stdout_tail,
            stderr_tail
        )));
    }

    let content = content.ok_or_else(|| {
        ToolError::new(format!(
            "{tool_name} 调用 codex 成功，但没有拿到输出\nstdout_tail:\n{}\nstderr_tail:\n{}",
            stdout_tail, stderr_tail
        ))
    })?;

    Ok(ExternalAgentInvocationOutput {
        content,
        thinking: None,
        model: normalize_optional_string(model_ref),
        usage: None,
        session_ref: None,
        binary_display,
        exit_code: output.status.code(),
    })
}

async fn invoke_claude_code(
    tool_name: &str,
    external_agent: &ExternalAgentConfig,
    prompt: &str,
    model_ref: Option<&str>,
    timeout_ms: u64,
    workdir: Option<&Path>,
    parent_conversation_id: &str,
    session_id: Option<&str>,
    action: Option<&str>,
    resume_session_id: Option<&str>,
) -> Result<ExternalAgentInvocationOutput, ToolError> {
    let (binary, binary_display) = resolve_command_path(external_agent)?;
    let mut command = Command::new(&binary);
    command.arg("-p");
    command.arg("--verbose");
    command.arg("--output-format=stream-json");
    command.arg("--include-partial-messages");
    command.arg("--permission-mode");
    command.arg("auto");
    if let Some(resume_session_id) = normalize_optional_string(resume_session_id) {
        command.arg("--resume");
        command.arg(resume_session_id);
    }
    if let Some(model_ref) = normalize_optional_string(model_ref) {
        command.arg("--model");
        command.arg(model_ref);
    }
    if let Some(dir) = workdir {
        command.current_dir(dir);
    }
    command.args(&external_agent.transport.args);
    command.arg(prompt);
    apply_transport_env(
        &mut command,
        external_agent,
        parent_conversation_id,
        session_id,
        action,
    );
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let child = command.spawn().map_err(|err| match err.kind() {
        ErrorKind::NotFound => ToolError::new(format!("启动 {} 失败：命令不存在", binary_display)),
        _ => ToolError::new(format!("启动 {} 失败: {err}", binary_display)),
    })?;

    let output = wait_for_command(tool_name, child, timeout_ms).await?;
    let (stdout_text, _stderr_text, stdout_tail, stderr_tail) =
        read_output_tails(&output.stdout, &output.stderr);

    if !output.status.success() {
        return Err(ToolError::new(format!(
            "{tool_name} 调用 claude 失败（exit_code={}）
stdout_tail:
{}
stderr_tail:
{}",
            output.status.code().unwrap_or(-1),
            stdout_tail,
            stderr_tail
        )));
    }

    let parsed_output = parse_claude_stream_json_output(&stdout_text).map_err(|err| {
        ToolError::new(format!(
            "{tool_name} 调用 claude 成功，但解析 stream-json 失败: {err}
stdout_tail:
{}
stderr_tail:
{}",
            stdout_tail, stderr_tail
        ))
    })?;

    if let Some(parsed_output) = parsed_output {
        return Ok(ExternalAgentInvocationOutput {
            content: parsed_output.content,
            thinking: parsed_output.thinking,
            model: parsed_output
                .model
                .or_else(|| normalize_optional_string(model_ref)),
            usage: parsed_output.usage,
            session_ref: parsed_output.session_id.map(|conversation_id| {
                let mut session_ref = json!({
                    "conversationId": conversation_id,
                });
                if let Some(message_id) = parsed_output.message_id {
                    if let Some(map) = session_ref.as_object_mut() {
                        map.insert("messageId".to_string(), Value::String(message_id));
                    }
                }
                session_ref
            }),
            binary_display,
            exit_code: output.status.code(),
        });
    }

    let content = trimmed_output_text(&stdout_text).ok_or_else(|| {
        ToolError::new(format!(
            "{tool_name} 调用 claude 成功，但没有拿到输出
stdout_tail:
{}
stderr_tail:
{}",
            stdout_tail, stderr_tail
        ))
    })?;

    Ok(ExternalAgentInvocationOutput {
        content,
        thinking: None,
        model: normalize_optional_string(model_ref),
        usage: None,
        session_ref: None,
        binary_display,
        exit_code: output.status.code(),
    })
}

pub(crate) async fn invoke_cli_transport(
    tool_name: &str,
    external_agent: &ExternalAgentConfig,
    prompt: &str,
    model_ref: Option<&str>,
    timeout_ms: u64,
    workdir: Option<&Path>,
    parent_conversation_id: &str,
    session_id: Option<&str>,
    action: Option<&str>,
    resume_session_id: Option<&str>,
) -> Result<ExternalAgentInvocationOutput, ToolError> {
    match external_agent.transport.transport_type {
        ExternalAgentTransportType::Headless => Err(ToolError::internal(format!(
            "{tool_name} 不应通过 CLI transport 调用 headless"
        ))),
        ExternalAgentTransportType::CodexCli => {
            invoke_codex_cli(
                tool_name,
                external_agent,
                prompt,
                model_ref,
                timeout_ms,
                workdir,
                parent_conversation_id,
                session_id,
                action,
            )
            .await
        }
        ExternalAgentTransportType::ClaudeCode => {
            invoke_claude_code(
                tool_name,
                external_agent,
                prompt,
                model_ref,
                timeout_ms,
                workdir,
                parent_conversation_id,
                session_id,
                action,
                resume_session_id,
            )
            .await
        }
    }
}

pub(crate) fn build_replay_prompt(
    title: &str,
    history: &[ExternalAgentReplayMessage],
    latest_user_prompt: &str,
) -> String {
    let mut sections = vec![
        "你是一个被父 Agent 调用的外部子 Agent。".to_string(),
        "下面给出的是该子会话截至当前轮的完整历史，请把它当作唯一可信的上下文。".to_string(),
        "请直接继续这个会话，重点回应最后一条 user 消息，不要重复解释你正在回放历史。".to_string(),
        format!("会话标题：{title}"),
        String::new(),
        "## 历史对话".to_string(),
    ];

    if history.is_empty() {
        sections.push("（暂无历史）".to_string());
    } else {
        for message in history {
            let role = match message.role {
                ExternalAgentReplayRole::User => "User",
                ExternalAgentReplayRole::Assistant => "Assistant",
            };
            sections.push(format!("### {role}"));
            sections.push(message.content.clone());
            sections.push(String::new());
        }
    }

    sections.push("## 最新用户消息".to_string());
    sections.push(latest_user_prompt.to_string());
    sections.join("\n")
}

impl ExternalAgentTransportType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Headless => "headless",
            Self::CodexCli => "codex_cli",
            Self::ClaudeCode => "claude_code",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_claude_stream_json_output;

    #[test]
    fn parse_claude_stream_json_extracts_stream_deltas() {
        let stdout = r#"
{"type":"system","session_id":"sess_123","model":"claude-sonnet-4-5"}
{"type":"stream_event","session_id":"sess_123","uuid":"msg_1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}
{"type":"stream_event","session_id":"sess_123","uuid":"msg_1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}}
{"type":"stream_event","session_id":"sess_123","uuid":"msg_1","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoning"}}}
{"type":"result","sessionId":"sess_123","usage":{"input_tokens":12,"output_tokens":5,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}
"#;

        let parsed = parse_claude_stream_json_output(stdout)
            .expect("parse should succeed")
            .expect("should detect stream-json output");

        assert_eq!(parsed.content, "Hello world");
        assert_eq!(parsed.thinking.as_deref(), Some("reasoning"));
        assert_eq!(parsed.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(parsed.session_id.as_deref(), Some("sess_123"));
        assert_eq!(parsed.message_id.as_deref(), Some("msg_1"));
        assert_eq!(
            parsed
                .usage
                .as_ref()
                .and_then(|usage| usage.get("totalTokens"))
                .and_then(serde_json::Value::as_u64),
            Some(24)
        );
    }

    #[test]
    fn parse_claude_stream_json_prefers_final_assistant_message() {
        let stdout = r#"
{"type":"assistant","session_id":"sess_final","uuid":"msg_final","message":{"id":"assistant_msg_1","model":"claude-opus-4-6","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"Final answer"}]}}
{"type":"result","sessionId":"sess_final","usage":{"input_tokens":20,"output_tokens":8}}
"#;

        let parsed = parse_claude_stream_json_output(stdout)
            .expect("parse should succeed")
            .expect("should detect assistant output");

        assert_eq!(parsed.content, "Final answer");
        assert_eq!(parsed.thinking.as_deref(), Some("plan"));
        assert_eq!(parsed.model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(parsed.session_id.as_deref(), Some("sess_final"));
        assert_eq!(parsed.message_id.as_deref(), Some("msg_final"));
        assert_eq!(
            parsed
                .usage
                .as_ref()
                .and_then(|usage| usage.get("promptTokens"))
                .and_then(serde_json::Value::as_u64),
            Some(20)
        );
    }
}
