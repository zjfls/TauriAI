//! TaskRunner：把「一次用户请求」运行成统一事件流（`run:event`）。
//!
//! 目标：
//! - `commands/run.rs` 只负责 Tauri 参数接入
//! - 运行时抽象集中在这里：Task / Turn / ReAct（Think → Act → Observe）
//! - Chat = 最简单的 Task（通常单 Turn）
//! - Tool = 多 Turn 循环（后续可扩展）

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::OnceLock;

use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::{mpsc, Mutex};

use crate::agents::chat::{
    build_model_config, build_request_messages, get_output_format, resolve_chat_model,
};
use crate::ai_client::{
    get_client, DebugInfoData, DebugRequestData, DebugResponseData, StreamEvent, TokenUsage,
    ToolCall, ToolDefinition,
};
use crate::config::ConfigManager;
use crate::errors::{AppErrorCode, SerializableError};
use crate::models::{
    AgentType, AskForApproval, ContentPart, Message, MessageBlock, MessageMeta, MessageRole,
    MessageStatus, MessageTurn,
};
use crate::prompts::{
    APPLY_PATCH_TOOL_PROMPT, APPLY_PATCH_UNIFIED_DIFF_TOOL_PROMPT, MCP_RESOURCE_TOOL_PROMPT,
    PERSISTENT_PROCESS_PROMPT, PYTHON3_FALLBACK_PROMPT, WEB_SEARCH_TOOL_PROMPT,
    WORKSTUDIO_PROMPT_GUIDE, WRITE_FILE_REPLACE_STRING_TOOL_PROMPT,
};
use crate::runtime::context_manager::{
    auto_compact_threshold_tokens, estimate_prompt_tokens, hard_limit_tokens, run_normal_compact,
    trim_runtime_messages_to_hard_limit, ContextManager,
};
use crate::runtime::events::RunEvent;
use crate::runtime::mcp::global_mcp_runtime;
use crate::runtime::types::{TaskKind, TurnContextTrimInfo, TurnPhase, TurnStatus};
use crate::skills::loader::{
    index_by_name as index_skills_by_name, load_skills as load_skill_files,
};
use crate::skills::SkillEntry;
use crate::storage::async_db;
use crate::storage::Database;
use crate::workstudio_security::read_workstudio_security_config;

use super::approvals::ApprovalDecision;
use super::emitter::{RunEmitter, RunEventCallback};
use super::run_state::RunState;
use super::tools::handlers::agent_task::AGENT_TASK_TOOL_NAME;
use super::tools::handlers::external_agent::AGENT_RUN_TOOL_NAME;
use super::tools::registry::{
    register_builtin_handlers_with_options, BuiltinHandlerOptions, ToolRegistry,
};
use super::tools::{
    tool_specs_to_definitions, ToolOrchestrator, ToolOrchestratorConfig, ToolServices,
};
use sha1::{Digest, Sha1};

/// 前端一次 invoke 对应的输入（Task Request）
pub struct RunTaskInput {
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub content: String,
    pub content_parts: Option<Vec<ContentPart>>,
    pub agent_name: Option<String>,
    pub model_ref: Option<String>,
    pub run_mode: Option<String>,
    pub thinking: Option<serde_json::Value>,
    pub web_search_provider: Option<String>,
    pub debug_mode: Option<bool>,
    // Internal-only overrides (not exposed as Tauri command params)
    pub base_messages_override: Option<Vec<Message>>,
    pub start_turn_index: Option<u32>,
    /// When set, reuse an existing assistant message id (manual turn retry semantics).
    /// This makes the retried run overwrite the same assistant bubble instead of appending a new one.
    pub assistant_message_id_override: Option<String>,
}

#[derive(Debug)]
enum TurnStreamResult {
    Final {
        content: String,
        thinking: String,
        debug_info: Option<DebugInfoData>,
        usage: Option<TokenUsage>,
    },
    ToolCalls {
        /// Some providers may stream visible text before requesting tool calls.
        /// Keep it so the next turn can receive the full assistant context.
        content: String,
        thinking: String,
        tool_calls: Vec<ToolCall>,
        debug_info: Option<DebugInfoData>,
        usage: Option<TokenUsage>,
    },
    Error {
        content: String,
        thinking: String,
        error: String,
        debug_info: Option<DebugInfoData>,
        usage: Option<TokenUsage>,
    },
    Aborted {
        content: String,
        thinking: String,
    },
}

#[derive(Debug)]
enum TaskOutcome {
    Success {
        last_turn_id: String,
        content: String,
        thinking: String,
        debug_info: Option<DebugInfoData>,
        usage: Option<TokenUsage>,
        blocks: Vec<MessageBlock>,
        turns: Vec<MessageTurn>,
    },
    Aborted {
        last_turn_id: String,
        content: String,
        thinking: String,
        blocks: Vec<MessageBlock>,
        turns: Vec<MessageTurn>,
    },
    Failed {
        turn_id: String,
        error: String,
        debug_info: Option<DebugInfoData>,
        content: String,
        thinking: String,
        blocks: Vec<MessageBlock>,
        turns: Vec<MessageTurn>,
    },
}

fn count_prompt_task_groups(messages: &[Message]) -> u32 {
    let mut groups = 0u32;
    let mut seen_non_system = false;

    for message in messages {
        if !seen_non_system && message.role == MessageRole::System {
            continue;
        }

        if !seen_non_system {
            seen_non_system = true;
            groups = groups.saturating_add(1);
            continue;
        }

        if message.role == MessageRole::User {
            groups = groups.saturating_add(1);
        }
    }

    groups
}

/// TurnLoop：把 run_task 内部「按 Turn 迭代」的零碎逻辑集中到一个结构里，保持 run_task 干净。
struct TurnLoop<'a> {
    client: Arc<dyn crate::ai_client::AiClient>,
    model_config: crate::models::ModelConfig,
    /// Agent-level context management policy (trim/compact).
    ctx_mgr: ContextManager,
    /// Model context length (used for hard trim budgeting).
    context_length: Option<u32>,
    tools: Option<Vec<ToolDefinition>>,
    allowed_tool_names: Option<HashSet<String>>,
    /// 工具编排器（权限/路由/gate/pty 会话等都在 tools 子系统内部处理）
    tool_orchestrator: Option<ToolOrchestrator>,
    /// 工具运行时依赖与状态（例如 PTY 会话管理）
    tool_services: Arc<ToolServices>,
    /// Default working directory for tools (when workspace support is enabled).
    default_workdir: Option<std::path::PathBuf>,
    /// Workspace root folders (main folder + additional mounts) for this run.
    workspace_roots: Vec<std::path::PathBuf>,
    /// Effective sandbox policy for this run.
    sandbox_policy: crate::models::SandboxPolicy,
    /// Effective approval policy for this run.
    approval_policy: AskForApproval,
    /// Whether this run is in chat mode (`run_mode == "chat"`).
    chat_mode: bool,
    /// Effective security policy name for this run.
    security_policy_name: String,
    /// Trusted commands (used with AskForApproval::UnlessTrusted).
    trusted_commands: Vec<crate::models::TrustedCommandConfig>,
    /// Per-conversation approval cache (for "approve for session").
    approval_store: Arc<Mutex<super::approvals::ApprovalStore>>,
    /// Persisted conversation state (used for prompt-view cutoff / compaction markers).
    db: Arc<Mutex<Database>>,
    run_state: Arc<RunState>,
    runtime_messages: Vec<Message>,
    conversation_id: String,
    task_id: String,
    assistant_message_id: String,
    output_format: Option<String>,
    max_turns: u32,
    /// First logical turn index (default: 1). Used by manual turn retry.
    start_turn_index: u32,
    /// 是否把 thinking 回灌到“同一 Task 的下一轮上下文”（由 Agent 配置控制）。
    reinject_thinking: bool,
    debug_mode: bool,
    /// Turn-level automatic retry attempts (effective value after applying manualTurnRetry).
    turn_retry_attempts: u32,
    emitter: &'a mut RunEmitter,
}

const MCP_TOOL_NAME_DELIMITER: &str = "__";
const MAX_TOOL_NAME_LENGTH: usize = 64;

fn qualify_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let mut qualified =
        format!("mcp{MCP_TOOL_NAME_DELIMITER}{server_name}{MCP_TOOL_NAME_DELIMITER}{tool_name}");
    if qualified.len() <= MAX_TOOL_NAME_LENGTH {
        return qualified;
    }

    let mut hasher = Sha1::new();
    hasher.update(qualified.as_bytes());
    let sha1 = hasher.finalize();
    let sha1_str = format!("{sha1:x}");
    let prefix_len = MAX_TOOL_NAME_LENGTH.saturating_sub(sha1_str.len());
    qualified.truncate(prefix_len);
    format!("{qualified}{sha1_str}")
}

fn build_assistant_context_content(
    content: String,
    thinking: &str,
    reinject_thinking: bool,
) -> String {
    if !reinject_thinking || thinking.trim().is_empty() {
        return content;
    }

    // 把 thinking 写入“上下文可见内容”，用于同一 Task 的多 Turn 续写。
    // NOTE: 新任务开始时我们会剔除历史 thinking（见 run_task_inner），避免跨任务污染与上下文爆炸。
    if content.trim().is_empty() {
        format!("[thinking]\n{thinking}\n[/thinking]")
    } else {
        format!("[thinking]\n{thinking}\n[/thinking]\n\n{content}")
    }
}

fn extract_tool_call_thought_signature(meta: &Option<serde_json::Value>) -> Option<String> {
    meta.as_ref()
        .and_then(|m| m.get("thought_signature"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn build_tool_call_block_meta_for_call(call: &ToolCall) -> Option<serde_json::Value> {
    call.thought_signature
        .as_ref()
        .map(|sig| serde_json::json!({ "thought_signature": sig }))
}

fn merge_tool_call_block_meta(existing: &mut Option<serde_json::Value>, patch: &serde_json::Value) {
    match existing {
        Some(current) => {
            if let (Some(dst), Some(src)) = (current.as_object_mut(), patch.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            } else {
                *existing = Some(patch.clone());
            }
        }
        None => {
            *existing = Some(patch.clone());
        }
    }
}

fn block_turn_index(block: &MessageBlock) -> Option<u32> {
    match block {
        MessageBlock::Text { turn_index, .. }
        | MessageBlock::Thinking { turn_index, .. }
        | MessageBlock::ToolCall { turn_index, .. }
        | MessageBlock::ToolResult { turn_index, .. }
        | MessageBlock::Approval { turn_index, .. }
        | MessageBlock::Error { turn_index, .. }
        | MessageBlock::WebSearch { turn_index, .. }
        | MessageBlock::Unknown { turn_index, .. } => *turn_index,
    }
}

#[derive(Default)]
struct ReplayTurnParts {
    thinking: Vec<String>,
    text: Vec<String>,
    tool_calls: Vec<ToolCall>,
    tool_results: Vec<(String, String)>, // (call_id, text)
    errors: Vec<String>,
}

fn replay_messages_from_blocks(
    conversation_id: &str,
    blocks: &[MessageBlock],
    max_turn_index_exclusive: u32,
    reinject_thinking: bool,
) -> Vec<Message> {
    if max_turn_index_exclusive <= 1 {
        return Vec::new();
    }

    let mut by_turn: BTreeMap<u32, ReplayTurnParts> = BTreeMap::new();
    for b in blocks {
        let Some(turn_index) = block_turn_index(b) else {
            continue;
        };
        if turn_index >= max_turn_index_exclusive {
            continue;
        }
        let entry = by_turn.entry(turn_index).or_default();
        match b {
            MessageBlock::Thinking { text, .. } => entry.thinking.push(text.clone()),
            MessageBlock::Text { text, .. } => entry.text.push(text.clone()),
            MessageBlock::ToolCall {
                call_id,
                name,
                arguments,
                meta,
                ..
            } => entry.tool_calls.push(ToolCall {
                id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
                thought_signature: extract_tool_call_thought_signature(meta),
            }),
            MessageBlock::ToolResult { call_id, text, .. } => {
                entry.tool_results.push((call_id.clone(), text.clone()))
            }
            MessageBlock::Approval { status, reason, .. } => {
                let mut s = format!("APPROVAL: {status}");
                if let Some(r) = reason.as_deref().filter(|v| !v.trim().is_empty()) {
                    s.push_str(&format!("\n{r}"));
                }
                entry.errors.push(s);
            }
            MessageBlock::Error { text, .. } => entry.errors.push(text.clone()),
            MessageBlock::WebSearch { .. } | MessageBlock::Unknown { .. } => {}
        }
    }

    let mut out: Vec<Message> = Vec::new();
    for (_turn_index, parts) in by_turn {
        let thinking = parts.thinking.join("\n");
        let mut content = parts.text.join("\n");
        if content.trim().is_empty() && !parts.errors.is_empty() {
            content = parts.errors.join("\n");
        } else if !parts.errors.is_empty() {
            content.push_str("\n\n");
            content.push_str(&parts.errors.join("\n"));
        }

        let content_for_context =
            build_assistant_context_content(content, &thinking, reinject_thinking);
        let assistant_meta = if parts.tool_calls.is_empty() {
            None
        } else {
            Some(MessageMeta {
                tool_calls: Some(parts.tool_calls),
                ..Default::default()
            })
        };
        if !content_for_context.trim().is_empty()
            || !thinking.trim().is_empty()
            || assistant_meta
                .as_ref()
                .is_some_and(|m| m.tool_calls.as_ref().is_some_and(|t| !t.is_empty()))
        {
            out.push(Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                role: MessageRole::Assistant,
                content: content_for_context,
                content_parts: Vec::new(),
                thinking: if thinking.trim().is_empty() {
                    None
                } else {
                    Some(thinking)
                },
                meta: assistant_meta,
                created_at: chrono::Utc::now(),
                status: MessageStatus::Success,
                error_message: None,
            });
        }

        for (call_id, text) in parts.tool_results {
            out.push(Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                role: MessageRole::Tool,
                content: text,
                content_parts: Vec::new(),
                thinking: None,
                meta: Some(MessageMeta {
                    tool_call_id: Some(call_id),
                    ..Default::default()
                }),
                created_at: chrono::Utc::now(),
                status: MessageStatus::Success,
                error_message: None,
            });
        }
    }

    out
}

#[derive(Clone, Copy, Debug, Default)]
struct PythonAvailability {
    has_python: bool,
    has_python3: bool,
}

static PYTHON_AVAILABILITY: OnceLock<PythonAvailability> = OnceLock::new();

fn python_availability() -> PythonAvailability {
    *PYTHON_AVAILABILITY.get_or_init(detect_python_availability)
}

fn detect_python_availability() -> PythonAvailability {
    #[cfg(windows)]
    {
        fn path_contains_exe(name: &str) -> bool {
            let Some(paths) = std::env::var_os("PATH") else {
                return false;
            };
            for dir in std::env::split_paths(&paths) {
                if dir.join(name).is_file() {
                    return true;
                }
            }
            false
        }

        return PythonAvailability {
            has_python: path_contains_exe("python.exe"),
            has_python3: path_contains_exe("python3.exe"),
        };
    }

    #[cfg(not(windows))]
    {
        // Best-effort probe in a login shell to match tool execution semantics.
        // Use sentinel strings to tolerate any rc output.
        let shell = std::env::var("SHELL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| std::path::Path::new(s).exists())
            .unwrap_or_else(|| {
                if std::path::Path::new("/bin/bash").exists() {
                    "/bin/bash".to_string()
                } else {
                    "/bin/sh".to_string()
                }
            });
        let shell_lower = shell.to_ascii_lowercase();
        // Only bash/zsh reliably support "-lc". Fall back to "-c" for other shells.
        let shell_flag = if shell_lower.ends_with("bash") || shell_lower.ends_with("zsh") {
            "-lc"
        } else {
            "-c"
        };

        let probe_cmd = "command -v python >/dev/null 2>&1 && echo __TAURIAI_HAS_PYTHON__ ; command -v python3 >/dev/null 2>&1 && echo __TAURIAI_HAS_PYTHON3__";

        if let Ok(out) = std::process::Command::new(shell)
            .arg(shell_flag)
            .arg(probe_cmd)
            .output()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            return PythonAvailability {
                has_python: stdout.contains("__TAURIAI_HAS_PYTHON__"),
                has_python3: stdout.contains("__TAURIAI_HAS_PYTHON3__"),
            };
        }

        // Fallback: use the backend process PATH.
        let Some(paths) = std::env::var_os("PATH") else {
            return PythonAvailability::default();
        };
        let mut has_python = false;
        let mut has_python3 = false;
        for dir in std::env::split_paths(&paths) {
            if dir.join("python").is_file() {
                has_python = true;
            }
            if dir.join("python3").is_file() {
                has_python3 = true;
            }
        }
        PythonAvailability {
            has_python,
            has_python3,
        }
    }
}

fn merge_system_messages_into_single_in_place(
    messages: &mut Vec<Message>,
    conversation_id: &str,
) -> Option<String> {
    let mut system_chunks: Vec<String> = Vec::new();
    let mut non_system: Vec<Message> = Vec::with_capacity(messages.len());

    for m in messages.drain(..) {
        if m.role == MessageRole::System {
            if !m.content.trim().is_empty() {
                system_chunks.push(m.content.trim_end().to_string());
            }
        } else {
            non_system.push(m);
        }
    }

    let merged = system_chunks.join("\n\n");
    if merged.trim().is_empty() {
        *messages = non_system;
        return None;
    }

    let merged_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::System,
        content: merged.clone(),
        content_parts: Vec::new(),
        thinking: None,
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };

    messages.push(merged_message);
    messages.extend(non_system);

    Some(merged)
}

fn compute_system_prompt_cache_key(
    agent: &crate::models::Agent,
    workstudio: Option<&crate::models::Workstudio>,
    allow_persistent_pty: bool,
    enable_apply_patch_tool_prompt: bool,
    enable_apply_patch_unified_diff_tool_prompt: bool,
    enable_write_file_replace_string_tool_prompt: bool,
    enable_local_web_search_tool: bool,
    enable_mcp_resource_tool_prompt: bool,
    task_agent_tool_prompt: Option<&str>,
    external_agent_run_tool_prompt: Option<&str>,
    enabled_skills: &[SkillEntry],
    py: PythonAvailability,
) -> String {
    use std::fmt::Write as _;

    let mut h = Sha1::new();
    // NOTE: Cache key must include any prompt text that can affect the actual HTTP request.
    // Bump this version whenever the cache inputs change.
    h.update(b"v10\n");
    h.update(agent.name.as_bytes());
    h.update(b"\n");
    h.update(agent.system_prompt.as_bytes());
    h.update(b"\n");
    h.update(format!("{:?}", agent.format_type).as_bytes());
    h.update(b"\n");
    if let Some(format_prompt) = crate::prompts::compose_system_prompt(None, agent.format_type) {
        h.update(format_prompt.as_bytes());
        h.update(b"\n");
    }

    if let Some(ws) = workstudio {
        h.update(b"ws\n");
        h.update(ws.id.as_bytes());
        h.update(b"\n");
        h.update(ws.main_folder.as_bytes());
        h.update(b"\n");
        for f in &ws.folders {
            h.update(f.as_bytes());
            h.update(b"\n");
        }
    } else {
        h.update(b"no-ws\n");
    }

    h.update(format!("pty:{allow_persistent_pty}\n").as_bytes());
    h.update(format!("apply_patch_prompt:{enable_apply_patch_tool_prompt}\n").as_bytes());
    h.update(
        format!("apply_patch_unified_diff_prompt:{enable_apply_patch_unified_diff_tool_prompt}\n")
            .as_bytes(),
    );
    h.update(
        format!(
            "write_file_replace_string_prompt:{enable_write_file_replace_string_tool_prompt}\n"
        )
        .as_bytes(),
    );
    h.update(format!("py:{}/{}\n", py.has_python, py.has_python3).as_bytes());
    h.update(format!("local_web_search:{enable_local_web_search_tool}\n").as_bytes());
    h.update(format!("mcp_resource_prompt:{enable_mcp_resource_tool_prompt}\n").as_bytes());
    h.update(b"task_agent_prompt\n");
    if let Some(prompt) = task_agent_tool_prompt {
        h.update(prompt.as_bytes());
    } else {
        h.update(b"<none>");
    }
    h.update(b"\n");
    h.update(b"external_agent_run_prompt\n");
    if let Some(prompt) = external_agent_run_tool_prompt {
        h.update(prompt.as_bytes());
    } else {
        h.update(b"<none>");
    }
    h.update(b"\n");

    // Skills section only depends on metadata (not contents).
    h.update(b"skills\n");
    for s in enabled_skills {
        h.update(s.meta.name.as_bytes());
        h.update(b"\n");
        h.update(s.meta.description.as_bytes());
        h.update(b"\n");
        h.update(s.meta.path.as_bytes());
        h.update(b"\n");
    }

    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}

fn inject_persistent_process_prompt(messages: &mut Vec<Message>, conversation_id: &str) {
    let mut content = PERSISTENT_PROCESS_PROMPT.trim().to_string();
    if content.is_empty() {
        return;
    }

    let py = python_availability();
    if !py.has_python && py.has_python3 {
        let snippet = PYTHON3_FALLBACK_PROMPT.trim();
        if !snippet.is_empty() {
            content.push_str("\n\n");
            content.push_str(snippet);
        }
    }

    // Keep the original system prompt as the first message, then append guidance right after
    // any leading system messages.
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();

    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn inject_workstudio_prompt(
    messages: &mut Vec<Message>,
    conversation_id: &str,
    ws: &crate::models::Workstudio,
) {
    let main = ws.main_folder.trim();
    if main.is_empty() {
        return;
    }

    let folders_preview = if ws.folders.is_empty() {
        String::new()
    } else {
        let mut lines = String::new();
        for f in &ws.folders {
            if f.trim().is_empty() {
                continue;
            }
            lines.push_str("- `");
            lines.push_str(f);
            lines.push_str("`\n");
        }
        lines
    };

    let mut content = String::new();
    content.push_str("\n\n## 当前工作区\n\n");
    content.push_str("- 主文件夹（默认 workdir；工具参数省略 `workdir` 时就在这里执行）：`");
    content.push_str(main);
    content.push_str("`\n");
    content.push_str("- workstudio_id: `");
    content.push_str(&ws.id);
    content.push_str("`\n");
    if !folders_preview.is_empty() {
        content.push_str("\n额外工作文件夹：\n");
        content.push_str(&folders_preview);
        content.push('\n');
    }
    content.push('\n');
    content.push_str(WORKSTUDIO_PROMPT_GUIDE.trim());

    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();

    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn inject_apply_patch_tool_prompt(messages: &mut Vec<Message>, conversation_id: &str) {
    let content = APPLY_PATCH_TOOL_PROMPT.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn inject_apply_patch_unified_diff_tool_prompt(messages: &mut Vec<Message>, conversation_id: &str) {
    let content = APPLY_PATCH_UNIFIED_DIFF_TOOL_PROMPT.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn inject_write_file_replace_string_tool_prompt(
    messages: &mut Vec<Message>,
    conversation_id: &str,
) {
    let content = WRITE_FILE_REPLACE_STRING_TOOL_PROMPT.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn inject_web_search_tool_prompt(messages: &mut Vec<Message>, conversation_id: &str) {
    let content = WEB_SEARCH_TOOL_PROMPT.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn inject_mcp_resource_tool_prompt(messages: &mut Vec<Message>, conversation_id: &str) {
    let content = MCP_RESOURCE_TOOL_PROMPT.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn render_task_agent_tool_prompt(config: &crate::models::AppConfig) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("## agenttask 可用 TaskAgent".to_string());
    lines.push(
        "调用 `agenttask` 时只能使用 `type=task_agent` 的智能体。请根据“TaskAgent 用法说明（taskUsage）”选择最匹配的一项。"
            .to_string(),
    );

    let mut task_agents: Vec<&crate::models::Agent> = config
        .agents
        .iter()
        .filter(|a| a.enabled && matches!(a.agent_type, AgentType::TaskAgent))
        .collect();
    task_agents.sort_by(|a, b| a.name.cmp(&b.name));

    if task_agents.is_empty() {
        lines.push("当前没有可用 TaskAgent，请不要调用 `agenttask`。".to_string());
        return lines.join("\n");
    }

    lines.push("可用列表：".to_string());
    for agent in task_agents {
        let display_name = agent.display_name.trim();
        let task_usage = agent.task_usage.as_deref().unwrap_or("").trim();
        let description = agent.description.as_deref().unwrap_or("").trim();
        let raw_summary = if !task_usage.is_empty() {
            task_usage.to_string()
        } else if !description.is_empty() {
            description.to_string()
        } else if !display_name.is_empty() {
            display_name.to_string()
        } else {
            "（未配置 taskUsage）".to_string()
        };
        let summary = raw_summary.split_whitespace().collect::<Vec<_>>().join(" ");
        lines.push(format!("- `{}`：{}", agent.name.trim(), summary));
    }

    lines.join("\n")
}

fn inject_task_agent_tool_prompt(
    messages: &mut Vec<Message>,
    conversation_id: &str,
    task_agent_prompt: &str,
) {
    let content = task_agent_prompt.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn render_external_agent_run_tool_prompt(config: &crate::models::AppConfig) -> String {
    let mut lines: Vec<String> = vec![
        "## `agent_run` 外部委托用法".to_string(),
        "- 只有在你明确需要把一个子任务委托给外部 agent 程序时，才调用 `agent_run`。".to_string(),
        "- `agent_run` 是一次性调用：必须填写精确的 `agent_name`，并提供自包含的 `prompt`；如任务依赖仓库或目录上下文，请显式传 `cwd`。".to_string(),
        "- `timeout_ms` 只在预计任务会明显超过默认超时时再覆盖。".to_string(),
        "- 下面只列出当前已激活、且可通过 `agent_run` 调用的 adapter；不要臆造新的 `agent_name`。".to_string(),
    ];

    let mut external_agents = config
        .external_agents
        .agents
        .iter()
        .filter(|agent| agent.enabled)
        .collect::<Vec<_>>();
    external_agents.sort_by(|a, b| a.name.cmp(&b.name));

    if external_agents.is_empty() {
        lines.push("当前没有已激活的 external agent adapter，请不要调用 `agent_run`。".to_string());
        return lines.join("\n");
    }

    lines.push("可用 adapter：".to_string());
    for agent in external_agents {
        let name = agent.name.trim();
        let description = agent
            .description
            .as_deref()
            .or(agent.task_usage.as_deref())
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let default_model_ref = agent
            .model_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        lines.push(format!("### `agent_name={name}`"));
        match agent.transport.transport_type {
            crate::models::ExternalAgentTransportType::Headless => {
                lines.push(
                    "- 底层执行器：`tauri-ai-headless`；适合把任务委托给本应用内部的 TauriAI agent。"
                        .to_string(),
                );
                lines.push(
                    "- 参数语义：`model_ref`、`run_mode`、`thinking` 会真实透传给内部 TauriAI agent；`cwd` 会成为子任务工作目录。"
                        .to_string(),
                );
                if let Some(target_agent) = agent
                    .remote_agent_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    lines.push(format!(
                        "- 当前绑定的内部 agent：`{target_agent}`；若要复用这个内部 agent 的能力，优先使用它。"
                    ));
                } else {
                    lines.push(
                        "- 当前未显式绑定内部 agent：会回退为同名内部 agent；若内部不存在同名 agent，调用会失败。"
                            .to_string(),
                    );
                }
                if let Some(model_ref) = default_model_ref {
                    lines.push(format!("- 当前默认 `model_ref`：`{model_ref}`。"));
                }
                lines.push(
                    "- 适用：当你希望外部委托仍复用 TauriAI 自身的 agent / model / run_mode / thinking 能力时，优先选择它。"
                        .to_string(),
                );
                lines.push(format!(
                    "- 推荐调用形态：{{\"agent_name\":\"{name}\",\"cwd\":\"<repo-or-dir>\",\"prompt\":\"<自包含子任务>\"}}"
                ));
            }
            crate::models::ExternalAgentTransportType::CodexCli => {
                lines.push(
                    "- 底层执行器：`codex exec`；非交互、一次性返回最终文本。".to_string(),
                );
                lines.push(
                    "- 参数语义：`prompt` 必须自包含；`cwd` 对仓库/文件任务非常重要；`model_ref` 会映射到 codex 的 `--model`。"
                        .to_string(),
                );
                lines.push(
                    "- 当前 adapter 会忽略 `run_mode` 与 `thinking`，不要依赖这两个参数。"
                        .to_string(),
                );
                if let Some(model_ref) = default_model_ref {
                    lines.push(format!("- 当前默认 `model_ref`：`{model_ref}`。"));
                }
                lines.push(
                    "- 适用：独立的一次性编码、改代码、调试、代码审查、仓库分析任务。"
                        .to_string(),
                );
                lines.push(format!(
                    "- 推荐调用形态：{{\"agent_name\":\"{name}\",\"cwd\":\"<repo-root>\",\"prompt\":\"<自包含编码任务>\"}}"
                ));
            }
            crate::models::ExternalAgentTransportType::ClaudeCode => {
                lines.push(
                    "- 底层执行器：`claude -p --output-format text`；非交互、一次性返回最终文本。"
                        .to_string(),
                );
                lines.push(
                    "- 参数语义：`prompt` 必须自包含；`cwd` 对仓库/文件任务很重要；`model_ref` 会映射到 Claude Code 的 `--model`。"
                        .to_string(),
                );
                lines.push(
                    "- 当前 adapter 会忽略 `run_mode` 与 `thinking`，不要依赖这两个参数。"
                        .to_string(),
                );
                if let Some(model_ref) = default_model_ref {
                    lines.push(format!("- 当前默认 `model_ref`：`{model_ref}`。"));
                }
                lines.push(
                    "- 适用：独立的一次性编码、分析、解释、文档整理任务。"
                        .to_string(),
                );
                lines.push(format!(
                    "- 推荐调用形态：{{\"agent_name\":\"{name}\",\"cwd\":\"<repo-root>\",\"prompt\":\"<自包含分析或编码任务>\"}}"
                ));
            }
        }
        if !description.is_empty() {
            lines.push(format!("- 补充说明：{description}"));
        }
        lines.push(String::new());
    }

    lines.join("\n")
}

fn inject_external_agent_run_tool_prompt(
    messages: &mut Vec<Message>,
    conversation_id: &str,
    external_agent_run_tool_prompt: &str,
) {
    let content = external_agent_run_tool_prompt.trim().to_string();
    if content.is_empty() {
        return;
    }
    let insert_at = messages
        .iter()
        .take_while(|m| m.role == MessageRole::System)
        .count();
    messages.insert(
        insert_at,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    );
}

fn normalize_path_for_compare(path: &str) -> String {
    let p = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        p.to_ascii_lowercase()
    } else {
        p
    }
}

fn is_ascii_mention_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-'))
}

fn effective_mcp_server_slugs_lower(
    config: &crate::models::AppConfig,
    agent: &crate::models::Agent,
    sandbox_policy: &crate::models::SandboxPolicy,
) -> HashSet<String> {
    if !sandbox_policy.has_full_network_access() {
        return HashSet::new();
    }
    let Some(set_name) = agent
        .mcp_set
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HashSet::new();
    };
    let Some(mcp_set) = config.mcp.sets.iter().find(|s| s.name == set_name) else {
        return HashSet::new();
    };

    let server_map: HashMap<String, crate::models::McpServerConfig> = config
        .mcp
        .servers
        .iter()
        .map(|e| (e.name.clone(), e.config.clone()))
        .collect();

    let mut out = HashSet::new();
    for set_server in &mcp_set.servers {
        if !set_server.enabled {
            continue;
        }
        let Some(server_cfg) = server_map.get(&set_server.server) else {
            continue;
        };
        if !server_cfg.enabled {
            continue;
        }
        out.insert(set_server.server.to_ascii_lowercase());
    }
    out
}

fn find_skill_mentions(
    text: &str,
    skills: &[SkillEntry],
    reserved_names_lower: &HashSet<String>,
) -> Vec<SkillEntry> {
    // Codex-like parsing:
    // - `$name` mentions (with boundaries) for name matching
    // - `[$name](path)` for explicit path matching
    // - When a `$name` conflicts with an "App/MCP" name, do not treat it as a skill.
    let mentions = crate::mentions::extract_tool_mentions(text);

    let mention_skill_paths: HashSet<String> = mentions
        .paths
        .iter()
        .filter(|path| {
            !matches!(
                crate::mentions::tool_kind_for_path(path),
                crate::mentions::ToolMentionKind::App | crate::mentions::ToolMentionKind::Mcp
            )
        })
        .map(|path| normalize_path_for_compare(crate::mentions::normalize_skill_path(path)))
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut matches: Vec<SkillEntry> = Vec::new();
    for skill in skills {
        if !seen.insert(skill.meta.name.clone()) {
            continue;
        }

        let is_reserved = reserved_names_lower.contains(&skill.meta.name.to_ascii_lowercase());

        let name_match = mentions.plain_names.contains(&skill.meta.name) && !is_reserved;

        // Backward-compat / UX: allow `$<any name>` substring matching for skill names
        // that cannot be represented as a Codex-style `$name` token (non [A-Za-z0-9_-]).
        // (Still keep the Codex-like strict parsing for mention-safe names to avoid
        // accidental prefix matches like `$alpha-skillx`.)
        let legacy_name_match = !name_match
            && !is_reserved
            && !is_ascii_mention_name(&skill.meta.name)
            && text.contains(&format!("${}", skill.meta.name));

        let path_match =
            mention_skill_paths.contains(&normalize_path_for_compare(&skill.meta.path));

        if name_match || legacy_name_match || path_match {
            matches.push(skill.clone());
        }
    }
    matches
}

fn select_enabled_skills(
    config: &crate::models::AppConfig,
    agent: &crate::models::Agent,
    app_skills_dir: Option<&std::path::Path>,
    repo_skills_dir: Option<&std::path::Path>,
    workstudio_skills_dir: Option<&std::path::Path>,
    include_contents: bool,
) -> Vec<SkillEntry> {
    let Some(set_name) = agent
        .skill_set
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return Vec::new();
    };
    let Some(set) = config.skills.sets.iter().find(|s| s.name == set_name) else {
        return Vec::new();
    };
    if !set.enabled {
        return Vec::new();
    }

    let disabled_global: HashSet<&str> = config
        .skills
        .disabled_skills
        .iter()
        .map(|s| s.as_str())
        .collect();
    let disabled_set: HashSet<&str> = set.disabled_skills.iter().map(|s| s.as_str()).collect();

    let allow: Vec<&str> = set
        .skills
        .iter()
        .map(|s| s.as_str())
        .filter(|name| !disabled_global.contains(name) && !disabled_set.contains(name))
        .collect();

    let outcome = load_skill_files(
        app_skills_dir,
        repo_skills_dir,
        workstudio_skills_dir,
        include_contents,
    );

    // Special-case: "标准skill集" can omit explicit allow-list and defaults to "all discovered skills",
    // subject to global/set-level disabled lists.
    let is_standard_set = set.name == "标准skill集";
    if allow.is_empty() && is_standard_set {
        return outcome
            .skills
            .into_iter()
            .filter(|s| {
                !disabled_global.contains(s.meta.name.as_str())
                    && !disabled_set.contains(s.meta.name.as_str())
            })
            .collect();
    }

    if allow.is_empty() {
        return Vec::new();
    }

    let map = index_skills_by_name(&outcome);
    allow
        .into_iter()
        .filter_map(|name| map.get(name).cloned())
        .collect()
}

impl<'a> TurnLoop<'a> {
    fn is_safe_readonly_tool(tool_name: &str) -> bool {
        matches!(
            tool_name,
            "echo" | "get_time" | "read_file" | "list_dir" | "rg"
        )
    }

    fn is_exec_tool(tool_name: &str) -> bool {
        matches!(
            tool_name,
            "shell_command"
                | "exec_command"
                | "write_stdin"
                | "exec_command_persistent"
                | "write_stdin_persistent"
        )
    }

    fn is_write_tool(tool_name: &str) -> bool {
        matches!(
            tool_name,
            "apply_patch" | "apply_patch_unified_diff" | "write_file" | "replace_string"
        )
    }

    fn is_network_tool(tool_name: &str) -> bool {
        matches!(tool_name, "web_search")
    }

    fn approval_cache_key(call: &ToolCall) -> String {
        // Chat UX: allow "approve for session" to apply to *all* web_search calls
        // in the same conversation, regardless of query text.
        if call.name == "web_search" {
            return "web_search".to_string();
        }

        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut h = DefaultHasher::new();
        call.name.hash(&mut h);
        call.arguments.hash(&mut h);
        format!("{}:{:x}", call.name, h.finish())
    }

    fn trusted_command_key(call: &ToolCall) -> Option<(String, String)> {
        let field = match call.name.as_str() {
            "web_search" => return Some((call.name.clone(), "*".to_string())),
            "shell_command" => "command",
            "exec_command" | "exec_command_persistent" => "cmd",
            _ => return None,
        };

        let v: serde_json::Value = serde_json::from_str(&call.arguments).ok()?;
        let cmd = v.get(field)?.as_str()?.trim();
        if cmd.is_empty() {
            return None;
        }

        Some((call.name.clone(), cmd.to_string()))
    }

    fn is_trusted_call(&self, call: &ToolCall) -> bool {
        let Some((tool, command)) = Self::trusted_command_key(call) else {
            return false;
        };
        self.trusted_commands
            .iter()
            .any(|t| t.tool == tool && t.command == command)
    }

    fn sandbox_policy_for_approved_call(
        &self,
        tool_name: &str,
        escalated: bool,
    ) -> crate::models::SandboxPolicy {
        if escalated {
            return crate::models::SandboxPolicy::DangerFullAccess;
        }

        // Network tools: approval can be used to temporarily lift network restrictions.
        if Self::is_network_tool(tool_name) && !self.sandbox_policy.has_full_network_access() {
            return match &self.sandbox_policy {
                crate::models::SandboxPolicy::DangerFullAccess => {
                    crate::models::SandboxPolicy::DangerFullAccess
                }
                crate::models::SandboxPolicy::ReadOnly => {
                    crate::models::SandboxPolicy::WorkspaceWrite {
                        writable_roots: Vec::new(),
                        network_access: true,
                        exclude_tmpdir_env_var: false,
                        exclude_slash_tmp: false,
                    }
                }
                crate::models::SandboxPolicy::ExternalSandbox { .. } => {
                    crate::models::SandboxPolicy::ExternalSandbox {
                        network_access: crate::models::NetworkAccess::Enabled,
                    }
                }
                crate::models::SandboxPolicy::WorkspaceWrite {
                    writable_roots,
                    exclude_tmpdir_env_var,
                    exclude_slash_tmp,
                    ..
                } => crate::models::SandboxPolicy::WorkspaceWrite {
                    writable_roots: writable_roots.clone(),
                    network_access: true,
                    exclude_tmpdir_env_var: *exclude_tmpdir_env_var,
                    exclude_slash_tmp: *exclude_slash_tmp,
                },
            };
        }

        // In "read-only" mode, a successful approval implies we can temporarily
        // lift restrictions for this call. To stay close to Codex semantics,
        // we upgrade to "workspace-write" (still confined to workspace roots).
        if matches!(self.sandbox_policy, crate::models::SandboxPolicy::ReadOnly)
            && (Self::is_exec_tool(tool_name) || Self::is_write_tool(tool_name))
        {
            return crate::models::SandboxPolicy::WorkspaceWrite {
                writable_roots: Vec::new(),
                network_access: true,
                exclude_tmpdir_env_var: false,
                exclude_slash_tmp: false,
            };
        }

        self.sandbox_policy.clone()
    }

    fn decision_status(decision: ApprovalDecision) -> &'static str {
        match decision {
            ApprovalDecision::Approved => "approved",
            ApprovalDecision::ApprovedForSession => "approved_for_session",
            ApprovalDecision::Denied => "denied",
            ApprovalDecision::Abort => "abort",
        }
    }

    fn should_prompt_for_tool(&self, tool_name: &str) -> bool {
        // Tools not enabled for this run should not pop approval UIs.
        if let Some(allowed) = self.allowed_tool_names.as_ref() {
            if !allowed.contains(tool_name) {
                return false;
            }
        }

        // Always allow safe read-only tools without asking.
        if Self::is_safe_readonly_tool(tool_name) {
            return false;
        }

        // Chat mode: rely on sandbox for local tools. Only network tools may trigger approvals.
        if self.chat_mode && !Self::is_network_tool(tool_name) {
            return false;
        }

        // Network tools: when sandbox forbids network, require approval (if policy allows).
        if Self::is_network_tool(tool_name) {
            if self.sandbox_policy.has_full_network_access() {
                return false;
            }
            // Chat mode: always ask before enabling network access.
            if self.chat_mode {
                return true;
            }
            return match self.approval_policy {
                AskForApproval::Never | AskForApproval::OnFailure => false,
                AskForApproval::OnRequest | AskForApproval::UnlessTrusted => true,
            };
        }

        // Only exec/write tools participate in approval flow for now.
        if !Self::is_exec_tool(tool_name) && !Self::is_write_tool(tool_name) {
            return false;
        }

        match self.approval_policy {
            AskForApproval::Never | AskForApproval::OnFailure => false,
            AskForApproval::OnRequest => {
                // Read-only sandbox still needs approval to lift restrictions.
                // Workspace-write allows `apply_patch` without prompting (Codex-like).
                if Self::is_write_tool(tool_name)
                    && matches!(
                        self.sandbox_policy,
                        crate::models::SandboxPolicy::WorkspaceWrite { .. }
                    )
                {
                    return false;
                }
                !self.sandbox_policy.has_full_disk_write_access()
            }
            AskForApproval::UnlessTrusted => true,
        }
    }

    async fn request_tool_approval(
        &mut self,
        abort_rx: &mut mpsc::Receiver<()>,
        turn_id: &str,
        _turn_index: u32,
        call: &ToolCall,
        reason: Option<String>,
        escalated: bool,
        force_prompt: bool,
    ) -> (bool, ApprovalDecision, Option<crate::models::SandboxPolicy>) {
        let tool_name = call.name.as_str();

        if self
            .allowed_tool_names
            .as_ref()
            .is_some_and(|s| !s.contains(tool_name))
        {
            return (false, ApprovalDecision::Approved, None);
        }

        if Self::is_safe_readonly_tool(tool_name) {
            return (false, ApprovalDecision::Approved, None);
        }

        // Network tools: let "approve for session" short-circuit even when policy wouldn't prompt
        // (e.g., AskForApproval::OnFailure first attempt).
        if Self::is_network_tool(tool_name) {
            let approval_key = Self::approval_cache_key(call);
            let already_approved_for_session = {
                let store = self.approval_store.lock().await;
                store.is_approved_for_session(&approval_key)
            };
            if already_approved_for_session {
                let sandbox = self.sandbox_policy_for_approved_call(tool_name, escalated);
                return (false, ApprovalDecision::ApprovedForSession, Some(sandbox));
            }
        }

        let mut needs_prompt = if force_prompt {
            !matches!(self.approval_policy, AskForApproval::Never)
        } else {
            self.should_prompt_for_tool(tool_name)
        };

        // OnFailure: first attempt never prompts; only retry will.
        if matches!(self.approval_policy, AskForApproval::OnFailure)
            && !force_prompt
            && !self.chat_mode
        {
            needs_prompt = false;
        }

        let is_trusted = self.is_trusted_call(call);

        // Trusted list: allow trusted network tool calls without prompting (even in OnRequest),
        // and keep the existing "UnlessTrusted" behavior for exec/write tools.
        if needs_prompt
            && ((Self::is_network_tool(tool_name) && is_trusted)
                || (matches!(self.approval_policy, AskForApproval::UnlessTrusted) && is_trusted))
        {
            needs_prompt = false;
        }

        if !needs_prompt {
            // Policy allows running without asking; keep the current sandbox policy.
            // Special-case: trusted network tools may need a temporary sandbox override to enable
            // network access (no approval UI).
            let sandbox = if Self::is_network_tool(tool_name)
                && is_trusted
                && !self.sandbox_policy.has_full_network_access()
            {
                self.sandbox_policy_for_approved_call(tool_name, escalated)
            } else {
                self.sandbox_policy.clone()
            };
            return (false, ApprovalDecision::Approved, Some(sandbox));
        }

        let approval_key = Self::approval_cache_key(call);
        let already_approved_for_session = {
            let store = self.approval_store.lock().await;
            store.is_approved_for_session(&approval_key)
        };
        if already_approved_for_session {
            let sandbox = self.sandbox_policy_for_approved_call(tool_name, escalated);
            return (false, ApprovalDecision::ApprovedForSession, Some(sandbox));
        }

        let request_id = call.id.clone();
        let block_id = format!("approval:{request_id}");

        let payload = serde_json::json!({
            "request_id": request_id,
            "call_id": call.id,
            "tool_name": call.name,
            "arguments": call.arguments,
            "status": "pending",
            "escalated": escalated,
            "security_policy": self.security_policy_name.clone(),
            "reason": reason,
        })
        .to_string();

        self.emitter.emit(RunEvent::BlockDelta {
            task_id: self.task_id.clone(),
            turn_id: turn_id.to_string(),
            assistant_message_id: Some(self.assistant_message_id.clone()),
            block_id: block_id.clone(),
            block_type: "approval".to_string(),
            format: Some("json".to_string()),
            delta: payload,
        });

        let mut rx = self
            .run_state
            .register_approval_waiter(&self.conversation_id, request_id.clone())
            .await;

        let decision = tokio::select! {
            _ = abort_rx.recv() => ApprovalDecision::Abort,
            v = &mut rx => v.unwrap_or(ApprovalDecision::Abort),
        };

        if decision == ApprovalDecision::ApprovedForSession {
            let mut store = self.approval_store.lock().await;
            store.put(approval_key, decision);
        }

        let resolved = serde_json::json!({
            "request_id": request_id,
            "call_id": call.id,
            "tool_name": call.name,
            "arguments": call.arguments,
            "status": Self::decision_status(decision),
            "escalated": escalated,
            "reason": reason,
        })
        .to_string();

        self.emitter.emit(RunEvent::BlockDelta {
            task_id: self.task_id.clone(),
            turn_id: turn_id.to_string(),
            assistant_message_id: Some(self.assistant_message_id.clone()),
            block_id,
            block_type: "approval".to_string(),
            format: Some("json".to_string()),
            delta: resolved,
        });

        let sandbox = match decision {
            ApprovalDecision::Approved | ApprovalDecision::ApprovedForSession => {
                Some(self.sandbox_policy_for_approved_call(tool_name, escalated))
            }
            _ => None,
        };

        (true, decision, sandbox)
    }

    async fn run(&mut self, abort_rx: &mut mpsc::Receiver<()>) -> TaskOutcome {
        // Persisted structured outputs for history restore (stored into assistant message meta).
        // NOTE: We only persist redacted per-turn DebugInfo to avoid leaking sensitive headers.
        let mut blocks: Vec<MessageBlock> = Vec::new();
        let mut turns: Vec<MessageTurn> = Vec::new();

        for step in 0..self.max_turns {
            let turn_index = self.start_turn_index.saturating_add(step);
            let turn_id = uuid::Uuid::new_v4().to_string();

            self.emitter.emit(RunEvent::TurnStarted {
                task_id: self.task_id.clone(),
                turn_id: turn_id.clone(),
                turn_index,
            });

            // Phase: Think（模型输出：thinking/text/tool_calls/web_search/...）
            self.emitter.emit(RunEvent::TurnPhaseStarted {
                task_id: self.task_id.clone(),
                turn_id: turn_id.clone(),
                phase: TurnPhase::Think,
            });

            // Per-turn hard trimming: runtime_messages grows during multi-turn tool runs.
            // Ensure each model call stays under the configured hard cap to avoid "context window exceeded".
            let mut turn_context_trim: Option<TurnContextTrimInfo> = None;
            if let Some(ctx_len) = self.context_length.filter(|v| *v > 0) {
                let hard_pct = self.ctx_mgr.hard_limit_percent();
                let trim_target_pct = self.ctx_mgr.trim_target_percent();
                let hard_limit = hard_limit_tokens(ctx_len, hard_pct);
                let trim_target = hard_limit_tokens(ctx_len, trim_target_pct);

                if self.ctx_mgr.should_trim() {
                    let runtime_before_trim = std::mem::take(&mut self.runtime_messages);
                    let task_groups_before = count_prompt_task_groups(&runtime_before_trim);
                    let trim = trim_runtime_messages_to_hard_limit(
                        runtime_before_trim,
                        hard_limit,
                        trim_target,
                    );
                    let kept_tasks = count_prompt_task_groups(&trim.trimmed_messages);
                    let removed_tasks = task_groups_before.saturating_sub(kept_tasks);
                    let target_unreachable = trim.estimated_tokens_before > trim_target
                        && trim.estimated_tokens_after > trim_target;

                    // Persist prompt-view cutoff (best-effort): after a hard trim removes old turns,
                    // remember the earliest kept user message so the next user request won't
                    // re-introduce already-trimmed history into runtime_messages.
                    if trim.removed_messages > 0 {
                        if let Some(cutoff_id) = trim
                            .trimmed_messages
                            .iter()
                            .find(|m| m.role == MessageRole::User)
                            .map(|m| m.id.clone())
                        {
                            let conversation_id = self.conversation_id.clone();
                            let _ = async_db::with_db(
                                &self.db,
                                "run_task:update_prompt_cutoff_message_id",
                                |db| {
                                    db.update_conversation_prompt_cutoff_message_id(
                                        &conversation_id,
                                        Some(cutoff_id.as_str()),
                                    )
                                },
                            )
                            .await;
                        }
                    }

                    turn_context_trim = Some(TurnContextTrimInfo {
                        enabled: true,
                        removed_messages: u32::try_from(trim.removed_messages).unwrap_or(u32::MAX),
                        estimated_tokens_before: trim.estimated_tokens_before,
                        estimated_tokens_after: trim.estimated_tokens_after,
                        hard_limit_tokens: trim.hard_limit_tokens,
                        trim_target_tokens: trim_target,
                        removed_tasks,
                        kept_tasks,
                        trimmed_tasks_since_last: None,
                        added_tasks_since_last: None,
                        delta_tokens_since_last: None,
                        target_unreachable: Some(target_unreachable),
                    });
                    self.runtime_messages = trim.trimmed_messages;
                } else {
                    let estimated = estimate_prompt_tokens(&self.runtime_messages);
                    let kept_tasks = count_prompt_task_groups(&self.runtime_messages);
                    turn_context_trim = Some(TurnContextTrimInfo {
                        enabled: false,
                        removed_messages: 0,
                        estimated_tokens_before: estimated,
                        estimated_tokens_after: estimated,
                        hard_limit_tokens: hard_limit,
                        trim_target_tokens: trim_target,
                        removed_tasks: 0,
                        kept_tasks,
                        trimmed_tasks_since_last: None,
                        added_tasks_since_last: None,
                        delta_tokens_since_last: None,
                        target_unreachable: Some(false),
                    });
                }
            }

            let turn_result = stream_one_turn(
                self.client.clone(),
                self.model_config.clone(),
                self.tools.clone(),
                self.runtime_messages.clone(),
                self.emitter,
                &self.task_id,
                &turn_id,
                &self.assistant_message_id,
                self.output_format.clone(),
                abort_rx,
                self.turn_retry_attempts,
            )
            .await;

            match turn_result {
                TurnStreamResult::Final {
                    content,
                    thinking,
                    debug_info,
                    usage,
                } => {
                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Think,
                    });

                    let turn_debug_info = if self.debug_mode {
                        debug_info.clone()
                    } else {
                        None
                    };
                    let turn_usage = usage.clone();
                    let persisted_debug_info =
                        turn_debug_info.as_ref().map(redact_debug_info_for_store);
                    self.emitter.emit(RunEvent::TurnFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        status: TurnStatus::Success,
                        turn_index: Some(turn_index),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        debug_info: turn_debug_info,
                        usage: turn_usage,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });

                    if !thinking.trim().is_empty() {
                        blocks.push(MessageBlock::Thinking {
                            id: format!("{turn_id}:assistant_thinking"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            text: thinking.clone(),
                        });
                    }
                    if !content.trim().is_empty() {
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: content.clone(),
                        });
                    }
                    turns.push(MessageTurn {
                        turn_id: turn_id.clone(),
                        turn_index,
                        status: Some(TurnStatus::Success),
                        has_debug_info: None,
                        debug_info: persisted_debug_info,
                        usage: usage.clone(),
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });

                    return TaskOutcome::Success {
                        last_turn_id: turn_id,
                        content,
                        thinking,
                        debug_info: if self.debug_mode { debug_info } else { None },
                        usage,
                        blocks,
                        turns,
                    };
                }
                TurnStreamResult::ToolCalls {
                    content,
                    thinking,
                    tool_calls,
                    debug_info,
                    usage,
                } => {
                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Think,
                    });

                    let persisted_usage = usage.clone();
                    let turn_debug_info = if self.debug_mode { debug_info } else { None };
                    let turn_usage = usage.clone();
                    let persisted_debug_info =
                        turn_debug_info.as_ref().map(redact_debug_info_for_store);

                    // 防止无限循环：达到 max_turns 后仍然在请求工具调用
                    let is_last_turn = step.saturating_add(1) >= self.max_turns;
                    let max_turns_error = if is_last_turn {
                        Some(format!(
                            "超过最大 Turn 数({})，仍然需要工具调用",
                            self.max_turns
                        ))
                    } else {
                        None
                    };

                    // Phase: Act（工具调用）
                    if !thinking.trim().is_empty() {
                        blocks.push(MessageBlock::Thinking {
                            id: format!("{turn_id}:assistant_thinking"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            text: thinking.clone(),
                        });
                    }
                    if !content.trim().is_empty() {
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: content.clone(),
                        });
                    }

                    self.emitter.emit(RunEvent::TurnPhaseStarted {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Act,
                    });

                    let mut normalized_calls: Vec<ToolCall> = Vec::new();
                    for (i, call) in tool_calls.into_iter().enumerate() {
                        let id = if call.id.trim().is_empty() {
                            format!("call_{}_{}", turn_index, i)
                        } else {
                            call.id
                        };
                        let call = ToolCall {
                            id: id.clone(),
                            name: call.name,
                            arguments: call.arguments,
                            thought_signature: call.thought_signature,
                        };

                        self.emitter.emit(RunEvent::BlockDelta {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            block_id: format!("tool_call:{}", id),
                            block_type: "tool_call".to_string(),
                            format: Some("json".to_string()),
                            delta: serde_json::json!({
                                "id": call.id,
                                "name": call.name,
                                "arguments": call.arguments,
                                "thoughtSignature": call.thought_signature,
                            })
                            .to_string(),
                        });

                        blocks.push(MessageBlock::ToolCall {
                            id: format!("{turn_id}:tool_call:{id}"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            call_id: id.clone(),
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                            meta: build_tool_call_block_meta_for_call(&call),
                        });

                        normalized_calls.push(call);
                    }

                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Act,
                    });

                    if let Some(error) = max_turns_error {
                        let error_display =
                            decorate_user_error_with_origin(&error, turn_debug_info.as_ref());
                        let mut reply_content = content.clone();
                        if reply_content.trim().is_empty() {
                            reply_content =
                                build_fallback_reply_markdown("任务失败", &error_display);
                            self.emitter.emit(RunEvent::BlockDelta {
                                task_id: self.task_id.clone(),
                                turn_id: turn_id.clone(),
                                assistant_message_id: Some(self.assistant_message_id.clone()),
                                block_id: "assistant_text".to_string(),
                                block_type: "text".to_string(),
                                format: self.output_format.clone(),
                                delta: reply_content.clone(),
                            });
                            blocks.push(MessageBlock::Text {
                                id: format!("{turn_id}:assistant_text"),
                                turn_id: Some(turn_id.clone()),
                                turn_index: Some(turn_index),
                                format: self
                                    .output_format
                                    .clone()
                                    .unwrap_or_else(|| "markdown".to_string()),
                                text: reply_content.clone(),
                            });
                        }

                        self.emitter.emit(RunEvent::BlockDelta {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            block_id: "assistant_error".to_string(),
                            block_type: "error".to_string(),
                            format: Some("plain".to_string()),
                            delta: error_display.clone(),
                        });
                        blocks.push(MessageBlock::Error {
                            id: format!("{turn_id}:assistant_error"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            text: error_display.clone(),
                        });

                        self.emitter.emit(RunEvent::TurnFinished {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            status: TurnStatus::Failed,
                            turn_index: Some(turn_index),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            debug_info: turn_debug_info.clone(),
                            usage: turn_usage.clone(),
                            context_trim: turn_context_trim.clone(),
                            model: Some(self.model_config.model.clone()),
                        });

                        turns.push(MessageTurn {
                            turn_id: turn_id.clone(),
                            turn_index,
                            status: Some(TurnStatus::Failed),
                            has_debug_info: None,
                            debug_info: persisted_debug_info.clone(),
                            usage: persisted_usage,
                            context_trim: turn_context_trim.clone(),
                            model: Some(self.model_config.model.clone()),
                        });

                        return TaskOutcome::Failed {
                            turn_id,
                            error,
                            debug_info: turn_debug_info,
                            content: reply_content,
                            thinking,
                            blocks,
                            turns,
                        };
                    }

                    // 把 assistant 的 tool_calls（以及本轮 thinking）写入运行时消息链，供下一轮继续
                    let content_for_context =
                        build_assistant_context_content(content, &thinking, self.reinject_thinking);
                    self.runtime_messages.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: self.conversation_id.clone(),
                        role: MessageRole::Assistant,
                        content: content_for_context,
                        content_parts: Vec::new(),
                        thinking: if thinking.trim().is_empty() {
                            None
                        } else {
                            Some(thinking)
                        },
                        meta: Some(MessageMeta {
                            tool_calls: Some(normalized_calls.clone()),
                            ..Default::default()
                        }),
                        created_at: chrono::Utc::now(),
                        status: MessageStatus::Success,
                        error_message: None,
                    });

                    // Phase: Observe（工具结果）
                    self.emitter.emit(RunEvent::TurnPhaseStarted {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Observe,
                    });

                    let mut aborted_in_tools: Option<String> = None;
                    for call in &normalized_calls {
                        if self.tool_orchestrator.is_none() {
                            let result: String = format!(
                                "TOOL_ERROR: 当前任务未启用工具系统，但模型请求了工具 '{}'",
                                call.name
                            );
                            self.emitter.emit(RunEvent::BlockDelta {
                                task_id: self.task_id.clone(),
                                turn_id: turn_id.clone(),
                                assistant_message_id: Some(self.assistant_message_id.clone()),
                                block_id: format!("tool_result:{}", call.id),
                                block_type: "tool_result".to_string(),
                                format: Some("plain".to_string()),
                                delta: result.clone(),
                            });
                            blocks.push(MessageBlock::ToolResult {
                                id: format!("{turn_id}:tool_result:{}", call.id),
                                turn_id: Some(turn_id.clone()),
                                turn_index: Some(turn_index),
                                call_id: call.id.clone(),
                                text: result.clone(),
                            });
                            self.runtime_messages.push(Message {
                                id: uuid::Uuid::new_v4().to_string(),
                                conversation_id: self.conversation_id.clone(),
                                role: MessageRole::Tool,
                                content: result,
                                content_parts: Vec::new(),
                                thinking: None,
                                meta: Some(MessageMeta {
                                    tool_call_id: Some(call.id.clone()),
                                    ..Default::default()
                                }),
                                created_at: chrono::Utc::now(),
                                status: MessageStatus::Success,
                                error_message: None,
                            });
                            continue;
                        };

                        let mut approval_record: Option<(String, Option<String>)> = None;

                        // 1) Policy-based approval (AskForApproval)
                        let (asked, decision, sandbox_override) = self
                            .request_tool_approval(
                                abort_rx, &turn_id, turn_index, call, None, false, false,
                            )
                            .await;
                        if asked {
                            approval_record =
                                Some((Self::decision_status(decision).to_string(), None));
                        }

                        match decision {
                            ApprovalDecision::Abort => {
                                let msg = "TOOL_ABORTED: 用户终止了工具审批".to_string();
                                aborted_in_tools = Some("用户终止了工具审批".to_string());
                                if let Some((status, reason)) = approval_record.take() {
                                    blocks.push(MessageBlock::Approval {
                                        id: format!("{turn_id}:approval:{}", call.id),
                                        turn_id: Some(turn_id.clone()),
                                        turn_index: Some(turn_index),
                                        request_id: call.id.clone(),
                                        tool_name: call.name.clone(),
                                        arguments: call.arguments.clone(),
                                        status,
                                        reason,
                                    });
                                }

                                self.emitter.emit(RunEvent::BlockDelta {
                                    task_id: self.task_id.clone(),
                                    turn_id: turn_id.clone(),
                                    assistant_message_id: Some(self.assistant_message_id.clone()),
                                    block_id: format!("tool_result:{}", call.id),
                                    block_type: "tool_result".to_string(),
                                    format: Some("plain".to_string()),
                                    delta: msg.clone(),
                                });
                                blocks.push(MessageBlock::ToolResult {
                                    id: format!("{turn_id}:tool_result:{}", call.id),
                                    turn_id: Some(turn_id.clone()),
                                    turn_index: Some(turn_index),
                                    call_id: call.id.clone(),
                                    text: msg.clone(),
                                });
                                self.runtime_messages.push(Message {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    conversation_id: self.conversation_id.clone(),
                                    role: MessageRole::Tool,
                                    content: msg,
                                    content_parts: Vec::new(),
                                    thinking: None,
                                    meta: Some(MessageMeta {
                                        tool_call_id: Some(call.id.clone()),
                                        ..Default::default()
                                    }),
                                    created_at: chrono::Utc::now(),
                                    status: MessageStatus::Success,
                                    error_message: None,
                                });
                                break;
                            }
                            ApprovalDecision::Denied => {
                                let msg = format!("TOOL_DENIED: 用户拒绝执行工具 '{}'", call.name);
                                self.emitter.emit(RunEvent::BlockDelta {
                                    task_id: self.task_id.clone(),
                                    turn_id: turn_id.clone(),
                                    assistant_message_id: Some(self.assistant_message_id.clone()),
                                    block_id: format!("tool_result:{}", call.id),
                                    block_type: "tool_result".to_string(),
                                    format: Some("plain".to_string()),
                                    delta: msg.clone(),
                                });

                                if let Some((status, reason)) = approval_record.take() {
                                    blocks.push(MessageBlock::Approval {
                                        id: format!("{turn_id}:approval:{}", call.id),
                                        turn_id: Some(turn_id.clone()),
                                        turn_index: Some(turn_index),
                                        request_id: call.id.clone(),
                                        tool_name: call.name.clone(),
                                        arguments: call.arguments.clone(),
                                        status,
                                        reason,
                                    });
                                }

                                blocks.push(MessageBlock::ToolResult {
                                    id: format!("{turn_id}:tool_result:{}", call.id),
                                    turn_id: Some(turn_id.clone()),
                                    turn_index: Some(turn_index),
                                    call_id: call.id.clone(),
                                    text: msg.clone(),
                                });
                                self.runtime_messages.push(Message {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    conversation_id: self.conversation_id.clone(),
                                    role: MessageRole::Tool,
                                    content: msg,
                                    content_parts: Vec::new(),
                                    thinking: None,
                                    meta: Some(MessageMeta {
                                        tool_call_id: Some(call.id.clone()),
                                        ..Default::default()
                                    }),
                                    created_at: chrono::Utc::now(),
                                    status: MessageStatus::Success,
                                    error_message: None,
                                });
                                continue;
                            }
                            ApprovalDecision::Approved | ApprovalDecision::ApprovedForSession => {}
                        }

                        let mut sandbox_policy_for_call =
                            sandbox_override.unwrap_or_else(|| self.sandbox_policy.clone());

                        let mut exec = {
                            let mut tool_ctx = super::tools::registry::ToolExecutionContext {
                                conversation_id: &self.conversation_id,
                                task_id: &self.task_id,
                                turn_id: &turn_id,
                                assistant_message_id: &self.assistant_message_id,
                                default_workdir: self.default_workdir.clone(),
                                workspace_roots: self.workspace_roots.clone(),
                                sandbox_policy: sandbox_policy_for_call.clone(),
                                emitter: self.emitter,
                                abort_rx,
                                services: self.tool_services.as_ref(),
                            };
                            let orchestrator = self
                                .tool_orchestrator
                                .as_ref()
                                .expect("tool_orchestrator checked above");
                            orchestrator.execute_one(&mut tool_ctx, call).await
                        };

                        // 2) OnFailure: if denied by sandbox, ask to retry with escalation.
                        // Chat mode: do not escalate; rely on sandbox deny results directly.
                        if matches!(self.approval_policy, AskForApproval::OnFailure)
                            && !self.chat_mode
                        {
                            if let Err(e) = &exec {
                                let web_search_needs_network = call.name == "web_search"
                                    && !sandbox_policy_for_call.has_full_network_access();
                                if e.kind == super::tools::registry::ToolErrorKind::Denied
                                    && (!sandbox_policy_for_call.has_full_disk_write_access()
                                        || web_search_needs_network)
                                {
                                    let (retry_reason, escalated) = if web_search_needs_network {
                                        (
                                            format!(
                                                "工具被沙盒拒绝：{}。是否允许为 web_search 临时开启网络访问并重试？",
                                                e.message
                                            ),
                                            false,
                                        )
                                    } else {
                                        (
                                            format!(
                                                "工具被沙盒拒绝：{}。是否允许以完全访问权限重试？",
                                                e.message
                                            ),
                                            true,
                                        )
                                    };
                                    let (asked2, decision2, sandbox2) = self
                                        .request_tool_approval(
                                            abort_rx,
                                            &turn_id,
                                            turn_index,
                                            call,
                                            Some(retry_reason.clone()),
                                            escalated,
                                            true,
                                        )
                                        .await;
                                    if asked2 {
                                        approval_record = Some((
                                            Self::decision_status(decision2).to_string(),
                                            Some(retry_reason),
                                        ));
                                    }

                                    match decision2 {
                                        ApprovalDecision::Abort => {
                                            let msg =
                                                "TOOL_ABORTED: 用户终止了工具提权审批".to_string();
                                            aborted_in_tools =
                                                Some("用户终止了工具提权审批".to_string());
                                            if let Some((status, reason)) = approval_record.take() {
                                                blocks.push(MessageBlock::Approval {
                                                    id: format!("{turn_id}:approval:{}", call.id),
                                                    turn_id: Some(turn_id.clone()),
                                                    turn_index: Some(turn_index),
                                                    request_id: call.id.clone(),
                                                    tool_name: call.name.clone(),
                                                    arguments: call.arguments.clone(),
                                                    status,
                                                    reason,
                                                });
                                            }

                                            self.emitter.emit(RunEvent::BlockDelta {
                                                task_id: self.task_id.clone(),
                                                turn_id: turn_id.clone(),
                                                assistant_message_id: Some(
                                                    self.assistant_message_id.clone(),
                                                ),
                                                block_id: format!("tool_result:{}", call.id),
                                                block_type: "tool_result".to_string(),
                                                format: Some("plain".to_string()),
                                                delta: msg.clone(),
                                            });
                                            blocks.push(MessageBlock::ToolResult {
                                                id: format!("{turn_id}:tool_result:{}", call.id),
                                                turn_id: Some(turn_id.clone()),
                                                turn_index: Some(turn_index),
                                                call_id: call.id.clone(),
                                                text: msg.clone(),
                                            });
                                            self.runtime_messages.push(Message {
                                                id: uuid::Uuid::new_v4().to_string(),
                                                conversation_id: self.conversation_id.clone(),
                                                role: MessageRole::Tool,
                                                content: msg,
                                                content_parts: Vec::new(),
                                                thinking: None,
                                                meta: Some(MessageMeta {
                                                    tool_call_id: Some(call.id.clone()),
                                                    ..Default::default()
                                                }),
                                                created_at: chrono::Utc::now(),
                                                status: MessageStatus::Success,
                                                error_message: None,
                                            });
                                            break;
                                        }
                                        ApprovalDecision::Denied => {
                                            let msg = format!(
                                                "TOOL_DENIED: 用户拒绝重试（原始错误：{}）",
                                                e.message
                                            );
                                            self.emitter.emit(RunEvent::BlockDelta {
                                                task_id: self.task_id.clone(),
                                                turn_id: turn_id.clone(),
                                                assistant_message_id: Some(
                                                    self.assistant_message_id.clone(),
                                                ),
                                                block_id: format!("tool_result:{}", call.id),
                                                block_type: "tool_result".to_string(),
                                                format: Some("plain".to_string()),
                                                delta: msg.clone(),
                                            });

                                            if let Some((status, reason)) = approval_record.take() {
                                                blocks.push(MessageBlock::Approval {
                                                    id: format!("{turn_id}:approval:{}", call.id),
                                                    turn_id: Some(turn_id.clone()),
                                                    turn_index: Some(turn_index),
                                                    request_id: call.id.clone(),
                                                    tool_name: call.name.clone(),
                                                    arguments: call.arguments.clone(),
                                                    status,
                                                    reason,
                                                });
                                            }

                                            blocks.push(MessageBlock::ToolResult {
                                                id: format!("{turn_id}:tool_result:{}", call.id),
                                                turn_id: Some(turn_id.clone()),
                                                turn_index: Some(turn_index),
                                                call_id: call.id.clone(),
                                                text: msg.clone(),
                                            });
                                            self.runtime_messages.push(Message {
                                                id: uuid::Uuid::new_v4().to_string(),
                                                conversation_id: self.conversation_id.clone(),
                                                role: MessageRole::Tool,
                                                content: msg,
                                                content_parts: Vec::new(),
                                                thinking: None,
                                                meta: Some(MessageMeta {
                                                    tool_call_id: Some(call.id.clone()),
                                                    ..Default::default()
                                                }),
                                                created_at: chrono::Utc::now(),
                                                status: MessageStatus::Success,
                                                error_message: None,
                                            });
                                            continue;
                                        }
                                        ApprovalDecision::Approved
                                        | ApprovalDecision::ApprovedForSession => {
                                            sandbox_policy_for_call = if let Some(policy) = sandbox2
                                            {
                                                policy
                                            } else if escalated {
                                                crate::models::SandboxPolicy::DangerFullAccess
                                            } else {
                                                sandbox_policy_for_call.clone()
                                            };
                                            exec = {
                                                let mut tool_ctx =
                                                    super::tools::registry::ToolExecutionContext {
                                                        conversation_id: &self.conversation_id,
                                                        task_id: &self.task_id,
                                                        turn_id: &turn_id,
                                                        assistant_message_id: &self
                                                            .assistant_message_id,
                                                        default_workdir: self
                                                            .default_workdir
                                                            .clone(),
                                                        workspace_roots: self
                                                            .workspace_roots
                                                            .clone(),
                                                        sandbox_policy: sandbox_policy_for_call
                                                            .clone(),
                                                        emitter: self.emitter,
                                                        abort_rx,
                                                        services: self.tool_services.as_ref(),
                                                    };
                                                let orchestrator = self
                                                    .tool_orchestrator
                                                    .as_ref()
                                                    .expect("tool_orchestrator checked above");
                                                orchestrator.execute_one(&mut tool_ctx, call).await
                                            };
                                        }
                                    }
                                }
                            }
                        }

                        if let Some((status, reason)) = approval_record.take() {
                            blocks.push(MessageBlock::Approval {
                                id: format!("{turn_id}:approval:{}", call.id),
                                turn_id: Some(turn_id.clone()),
                                turn_index: Some(turn_index),
                                request_id: call.id.clone(),
                                tool_name: call.name.clone(),
                                arguments: call.arguments.clone(),
                                status,
                                reason,
                            });
                        }

                        let tool_meta: Option<serde_json::Value>;
                        let result = match exec {
                            Ok(v) => {
                                tool_meta = v.meta.clone();
                                v.content
                            }
                            Err(e) => {
                                tool_meta = e.meta.clone();
                                if e.kind == super::tools::registry::ToolErrorKind::Aborted {
                                    let msg = format!("TOOL_ABORTED: {}", e.message);
                                    self.emitter.emit(RunEvent::BlockDelta {
                                        task_id: self.task_id.clone(),
                                        turn_id: turn_id.clone(),
                                        assistant_message_id: Some(
                                            self.assistant_message_id.clone(),
                                        ),
                                        block_id: format!("tool_result:{}", call.id),
                                        block_type: "tool_result".to_string(),
                                        format: Some("plain".to_string()),
                                        delta: msg.clone(),
                                    });
                                    // Best-effort: persist tool meta into the corresponding tool_call block.
                                    if let Some(meta) = tool_meta.as_ref() {
                                        for b in blocks.iter_mut().rev() {
                                            if let MessageBlock::ToolCall {
                                                call_id, meta: m, ..
                                            } = b
                                            {
                                                if call_id == &call.id {
                                                    merge_tool_call_block_meta(m, meta);
                                                    break;
                                                }
                                            }
                                        }
                                        self.emitter.emit(RunEvent::BlockDelta {
                                            task_id: self.task_id.clone(),
                                            turn_id: turn_id.clone(),
                                            assistant_message_id: Some(
                                                self.assistant_message_id.clone(),
                                            ),
                                            block_id: format!("tool_call:{}", call.id),
                                            block_type: "tool_call".to_string(),
                                            format: Some("json".to_string()),
                                            delta: serde_json::json!({
                                                "id": call.id,
                                                "name": call.name,
                                                "arguments": call.arguments,
                                                "meta": meta,
                                            })
                                            .to_string(),
                                        });
                                    }

                                    blocks.push(MessageBlock::ToolResult {
                                        id: format!("{turn_id}:tool_result:{}", call.id),
                                        turn_id: Some(turn_id.clone()),
                                        turn_index: Some(turn_index),
                                        call_id: call.id.clone(),
                                        text: msg.clone(),
                                    });
                                    self.runtime_messages.push(Message {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        conversation_id: self.conversation_id.clone(),
                                        role: MessageRole::Tool,
                                        content: msg,
                                        content_parts: Vec::new(),
                                        thinking: None,
                                        meta: Some(MessageMeta {
                                            tool_call_id: Some(call.id.clone()),
                                            ..Default::default()
                                        }),
                                        created_at: chrono::Utc::now(),
                                        status: MessageStatus::Success,
                                        error_message: None,
                                    });
                                    aborted_in_tools = Some(e.message);
                                    break;
                                }
                                let msg = format!("TOOL_ERROR: {}", e.message);
                                self.emitter.emit(RunEvent::BlockDelta {
                                    task_id: self.task_id.clone(),
                                    turn_id: turn_id.clone(),
                                    assistant_message_id: Some(self.assistant_message_id.clone()),
                                    block_id: format!("tool_result:{}", call.id),
                                    block_type: "tool_result".to_string(),
                                    format: Some("plain".to_string()),
                                    delta: msg.clone(),
                                });
                                msg
                            }
                        };

                        // Best-effort: persist tool meta into the corresponding tool_call block.
                        if let Some(meta) = tool_meta.as_ref() {
                            for b in blocks.iter_mut().rev() {
                                if let MessageBlock::ToolCall {
                                    call_id, meta: m, ..
                                } = b
                                {
                                    if call_id == &call.id {
                                        merge_tool_call_block_meta(m, meta);
                                        break;
                                    }
                                }
                            }
                            self.emitter.emit(RunEvent::BlockDelta {
                                task_id: self.task_id.clone(),
                                turn_id: turn_id.clone(),
                                assistant_message_id: Some(self.assistant_message_id.clone()),
                                block_id: format!("tool_call:{}", call.id),
                                block_type: "tool_call".to_string(),
                                format: Some("json".to_string()),
                                delta: serde_json::json!({
                                    "id": call.id,
                                    "name": call.name,
                                    "arguments": call.arguments,
                                    "meta": meta,
                                })
                                .to_string(),
                            });
                        }

                        blocks.push(MessageBlock::ToolResult {
                            id: format!("{turn_id}:tool_result:{}", call.id),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            call_id: call.id.clone(),
                            text: result.clone(),
                        });

                        self.runtime_messages.push(Message {
                            id: uuid::Uuid::new_v4().to_string(),
                            conversation_id: self.conversation_id.clone(),
                            role: MessageRole::Tool,
                            content: result,
                            content_parts: Vec::new(),
                            thinking: None,
                            meta: Some(MessageMeta {
                                tool_call_id: Some(call.id.clone()),
                                ..Default::default()
                            }),
                            created_at: chrono::Utc::now(),
                            status: MessageStatus::Success,
                            error_message: None,
                        });
                    }

                    if aborted_in_tools.is_some() {
                        let reason = aborted_in_tools
                            .clone()
                            .unwrap_or_else(|| "工具执行已中止".to_string());
                        let reply_content = build_fallback_reply_markdown(
                            "任务已中止",
                            &format!(
                                "工具执行被中止：{reason}\n\n你可以点击“重试”或重新发送消息继续。"
                            ),
                        );

                        self.emitter.emit(RunEvent::BlockDelta {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            block_id: "assistant_text".to_string(),
                            block_type: "text".to_string(),
                            format: self.output_format.clone(),
                            delta: reply_content.clone(),
                        });
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: reply_content.clone(),
                        });

                        self.emitter.emit(RunEvent::TurnPhaseFinished {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            phase: TurnPhase::Observe,
                        });
                        self.emitter.emit(RunEvent::TurnFinished {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            status: TurnStatus::Aborted,
                            turn_index: Some(turn_index),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            debug_info: turn_debug_info,
                            usage: turn_usage,
                            context_trim: turn_context_trim.clone(),
                            model: Some(self.model_config.model.clone()),
                        });
                        turns.push(MessageTurn {
                            turn_id: turn_id.clone(),
                            turn_index,
                            status: Some(TurnStatus::Aborted),
                            has_debug_info: None,
                            debug_info: persisted_debug_info.clone(),
                            usage: persisted_usage,
                            context_trim: turn_context_trim.clone(),
                            model: Some(self.model_config.model.clone()),
                        });
                        return TaskOutcome::Aborted {
                            last_turn_id: turn_id,
                            content: reply_content,
                            thinking: String::new(),
                            blocks,
                            turns,
                        };
                    }

                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Observe,
                    });

                    self.emitter.emit(RunEvent::TurnFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        status: TurnStatus::Success,
                        turn_index: Some(turn_index),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        debug_info: turn_debug_info,
                        usage: turn_usage,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });

                    // 继续下一轮 Turn（Think）
                    turns.push(MessageTurn {
                        turn_id: turn_id.clone(),
                        turn_index,
                        status: Some(TurnStatus::Success),
                        has_debug_info: None,
                        debug_info: persisted_debug_info.clone(),
                        usage: persisted_usage,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });
                    continue;
                }
                TurnStreamResult::Error {
                    content,
                    thinking,
                    error,
                    debug_info,
                    usage,
                } => {
                    let error_display =
                        decorate_user_error_with_origin(&error, debug_info.as_ref());
                    let reply_content = if content.trim().is_empty() {
                        build_fallback_reply_markdown("任务失败", &error_display)
                    } else {
                        content.clone()
                    };

                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Think,
                    });

                    let persisted_usage = usage.clone();
                    // 失败时即使未开启 debug_mode，也应提供“已脱敏”的调试上下文，避免黑盒报错。
                    // - 前端全局弹窗/DebugModal 依赖 RunEvent::Error/TurnFinished 携带 debugInfo
                    // - 仅对失败兜底，避免常规成功路径产生过大/过敏感的调试负担
                    let persisted_debug_info = debug_info.as_ref().map(redact_debug_info_for_store);
                    let turn_debug_info = if self.debug_mode {
                        debug_info.clone()
                    } else {
                        persisted_debug_info.clone()
                    };
                    let turn_usage = usage.clone();

                    if !thinking.trim().is_empty() {
                        blocks.push(MessageBlock::Thinking {
                            id: format!("{turn_id}:assistant_thinking"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            text: thinking.clone(),
                        });
                    }
                    if !content.trim().is_empty() {
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: content.clone(),
                        });
                    }
                    if content.trim().is_empty() {
                        self.emitter.emit(RunEvent::BlockDelta {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            block_id: "assistant_text".to_string(),
                            block_type: "text".to_string(),
                            format: self.output_format.clone(),
                            delta: reply_content.clone(),
                        });
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: reply_content.clone(),
                        });
                    }

                    self.emitter.emit(RunEvent::BlockDelta {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        block_id: "assistant_error".to_string(),
                        block_type: "error".to_string(),
                        format: Some("plain".to_string()),
                        delta: error_display.clone(),
                    });
                    blocks.push(MessageBlock::Error {
                        id: format!("{turn_id}:assistant_error"),
                        turn_id: Some(turn_id.clone()),
                        turn_index: Some(turn_index),
                        text: error_display.clone(),
                    });

                    self.emitter.emit(RunEvent::TurnFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        status: TurnStatus::Failed,
                        turn_index: Some(turn_index),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        debug_info: turn_debug_info.clone(),
                        usage: turn_usage,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });

                    turns.push(MessageTurn {
                        turn_id: turn_id.clone(),
                        turn_index,
                        status: Some(TurnStatus::Failed),
                        has_debug_info: None,
                        debug_info: persisted_debug_info,
                        usage: persisted_usage,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });
                    return TaskOutcome::Failed {
                        turn_id,
                        error,
                        debug_info: turn_debug_info,
                        content: reply_content,
                        thinking,
                        blocks,
                        turns,
                    };
                }
                TurnStreamResult::Aborted { content, thinking } => {
                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Think,
                    });
                    self.emitter.emit(RunEvent::TurnFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        status: TurnStatus::Aborted,
                        turn_index: Some(turn_index),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        debug_info: None,
                        usage: None,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });
                    let reply_content = if content.trim().is_empty() && thinking.trim().is_empty() {
                        build_fallback_reply_markdown(
                            "任务已中止",
                            "运行已被用户或系统中止。\n\n你可以点击“重试”或重新发送消息继续。",
                        )
                    } else {
                        content.clone()
                    };

                    if content.trim().is_empty() && thinking.trim().is_empty() {
                        self.emitter.emit(RunEvent::BlockDelta {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            block_id: "assistant_text".to_string(),
                            block_type: "text".to_string(),
                            format: self.output_format.clone(),
                            delta: reply_content.clone(),
                        });
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: reply_content.clone(),
                        });
                    }

                    if !thinking.trim().is_empty() {
                        blocks.push(MessageBlock::Thinking {
                            id: format!("{turn_id}:assistant_thinking"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            text: thinking.clone(),
                        });
                    }
                    if !content.trim().is_empty() {
                        blocks.push(MessageBlock::Text {
                            id: format!("{turn_id}:assistant_text"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            format: self
                                .output_format
                                .clone()
                                .unwrap_or_else(|| "markdown".to_string()),
                            text: content.clone(),
                        });
                    }
                    turns.push(MessageTurn {
                        turn_id: turn_id.clone(),
                        turn_index,
                        status: Some(TurnStatus::Aborted),
                        has_debug_info: None,
                        debug_info: None,
                        usage: None,
                        context_trim: turn_context_trim.clone(),
                        model: Some(self.model_config.model.clone()),
                    });
                    return TaskOutcome::Aborted {
                        last_turn_id: turn_id,
                        content: reply_content,
                        thinking,
                        blocks,
                        turns,
                    };
                }
            }
        }

        // 理论上不会走到这里（max_turns >= 1，且每轮都会 return）
        TaskOutcome::Success {
            last_turn_id: uuid::Uuid::nil().to_string(),
            content: String::new(),
            thinking: String::new(),
            debug_info: None,
            usage: None,
            blocks,
            turns,
        }
    }
}

fn append_tool_trace_for_model_input(mut messages: Vec<Message>) -> Vec<Message> {
    for msg in &mut messages {
        if msg.role != MessageRole::Assistant {
            continue;
        }

        let Some(meta) = msg.meta.as_ref() else {
            continue;
        };
        let Some(blocks) = meta.blocks.as_ref() else {
            continue;
        };

        let mut lines: Vec<String> = Vec::new();
        for b in blocks {
            match b {
                MessageBlock::ToolCall {
                    call_id,
                    name,
                    arguments,
                    turn_index,
                    ..
                } => {
                    lines.push(format!(
                        "[tool_call] turn={} id={} name={} args={}",
                        turn_index.unwrap_or_default(),
                        call_id,
                        name,
                        arguments
                    ));
                }
                MessageBlock::ToolResult {
                    call_id,
                    text,
                    turn_index,
                    ..
                } => {
                    let cleaned = sanitize_tool_text_for_model(text);
                    lines.push(format!(
                        "[tool_result] turn={} id={} text={}",
                        turn_index.unwrap_or_default(),
                        call_id,
                        cleaned
                    ));
                }
                MessageBlock::WebSearch {
                    call_id,
                    status,
                    action,
                    turn_index,
                    ..
                } => {
                    let action_str = action
                        .as_ref()
                        .and_then(|v| serde_json::to_string(v).ok())
                        .unwrap_or_else(|| "null".to_string());
                    lines.push(format!(
                        "[web_search] turn={} id={} status={} action={}",
                        turn_index.unwrap_or_default(),
                        call_id,
                        status,
                        action_str
                    ));
                }
                _ => {}
            }
        }

        if lines.is_empty() {
            continue;
        }

        // Append as plain text trace for maximum cross-provider compatibility.
        msg.content.push_str("\n\n---\n\n[tool_trace]\n");
        msg.content.push_str(&lines.join("\n"));
    }

    messages
}

fn expand_persisted_blocks_for_model_input(messages: Vec<Message>) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::new();

    for msg in messages {
        if msg.role != MessageRole::Assistant {
            out.push(msg);
            continue;
        }

        let created_at = msg.created_at.clone();

        let Some(meta) = msg.meta.as_ref() else {
            out.push(msg);
            continue;
        };
        let Some(blocks) = meta.blocks.as_ref().filter(|b| !b.is_empty()) else {
            out.push(msg);
            continue;
        };

        #[derive(Default)]
        struct TurnBundle {
            turn_index: Option<u32>,
            text_parts: Vec<String>,
            thinking_parts: Vec<String>,
            tool_calls: Vec<ToolCall>,
            tool_results: Vec<(String, String)>,
        }

        let out_start_len = out.len();
        let fallback_thinking = msg.thinking.clone().filter(|t| !t.trim().is_empty());
        let mut bundles: Vec<TurnBundle> = Vec::new();
        let mut idx_by_key: HashMap<String, usize> = HashMap::new();

        fn get_bundle_index(
            bundles: &mut Vec<TurnBundle>,
            idx_by_key: &mut HashMap<String, usize>,
            turn_id: &Option<String>,
            turn_index: &Option<u32>,
        ) -> usize {
            let key = turn_id.clone().unwrap_or_else(|| "__legacy__".to_string());
            if let Some(idx) = idx_by_key.get(&key).copied() {
                // Fill missing turn_index if we later encounter it.
                if bundles[idx].turn_index.is_none() {
                    bundles[idx].turn_index = *turn_index;
                }
                return idx;
            }

            let idx = bundles.len();
            bundles.push(TurnBundle {
                turn_index: *turn_index,
                ..Default::default()
            });
            idx_by_key.insert(key, idx);
            idx
        }

        for block in blocks {
            match block {
                MessageBlock::Text {
                    text,
                    turn_id,
                    turn_index,
                    ..
                } => {
                    let idx = get_bundle_index(&mut bundles, &mut idx_by_key, turn_id, turn_index);
                    if !text.trim().is_empty() {
                        bundles[idx].text_parts.push(text.clone());
                    }
                }
                MessageBlock::Thinking {
                    text,
                    turn_id,
                    turn_index,
                    ..
                } => {
                    let idx = get_bundle_index(&mut bundles, &mut idx_by_key, turn_id, turn_index);
                    if !text.trim().is_empty() {
                        bundles[idx].thinking_parts.push(text.clone());
                    }
                }
                MessageBlock::ToolCall {
                    call_id,
                    name,
                    arguments,
                    meta,
                    turn_id,
                    turn_index,
                    ..
                } => {
                    let idx = get_bundle_index(&mut bundles, &mut idx_by_key, turn_id, turn_index);
                    bundles[idx].tool_calls.push(ToolCall {
                        id: call_id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                        thought_signature: extract_tool_call_thought_signature(meta),
                    });
                }
                MessageBlock::ToolResult {
                    call_id,
                    text,
                    turn_id,
                    turn_index,
                    ..
                } => {
                    let idx = get_bundle_index(&mut bundles, &mut idx_by_key, turn_id, turn_index);
                    bundles[idx]
                        .tool_results
                        .push((call_id.clone(), text.clone()));
                }
                _ => {}
            }
        }

        if let Some(thinking) = fallback_thinking {
            if !bundles.is_empty() && bundles.iter().all(|b| b.thinking_parts.is_empty()) {
                bundles[0].thinking_parts.push(thinking);
            }
        }

        // Preserve turn order by turn_index if available; otherwise keep insertion order.
        bundles.sort_by(|a, b| match (a.turn_index, b.turn_index) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });

        for bundle in bundles {
            let content = bundle.text_parts.join("\n\n");
            let has_tool_calls = !bundle.tool_calls.is_empty();
            let thinking = if bundle.thinking_parts.is_empty() {
                None
            } else {
                let joined = bundle.thinking_parts.join("");
                if joined.trim().is_empty() {
                    None
                } else {
                    Some(joined)
                }
            };
            let has_thinking = thinking.is_some();

            // Skip empty turns unless they contain tool calls or thinking (thinking-only turns are valid for Kimi reasoning_content).
            if content.trim().is_empty() && !has_tool_calls && !has_thinking {
                continue;
            }

            out.push(Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: msg.conversation_id.clone(),
                role: MessageRole::Assistant,
                content,
                content_parts: Vec::new(),
                thinking,
                meta: if has_tool_calls {
                    Some(MessageMeta {
                        tool_calls: Some(bundle.tool_calls.clone()),
                        ..Default::default()
                    })
                } else {
                    None
                },
                created_at: created_at.clone(),
                status: MessageStatus::Success,
                error_message: None,
            });

            if has_tool_calls {
                let call_ids: HashSet<String> =
                    bundle.tool_calls.iter().map(|c| c.id.clone()).collect();
                let mut results_by_id: HashMap<String, String> = HashMap::new();
                for (call_id, text) in bundle.tool_results {
                    if !call_ids.contains(&call_id) {
                        continue;
                    }
                    results_by_id.entry(call_id).or_insert(text);
                }

                // 严格模型要求：每个 tool_call_id 都必须有对应的 tool 输出。
                // 对于历史数据里缺失的结果（例如审批被中断/工具异常未落库），这里补一个占位输出，避免请求直接失败。
                for call in bundle.tool_calls {
                    let text = results_by_id.remove(&call.id).unwrap_or_else(|| {
                        format!(
                            "TOOL_RESULT_MISSING: 未收到该工具调用的返回值（可能因审批中断/执行异常）。tool={} call_id={}",
                            call.name, call.id
                        )
                    });
                    out.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: msg.conversation_id.clone(),
                        role: MessageRole::Tool,
                        content: text,
                        content_parts: Vec::new(),
                        thinking: None,
                        meta: Some(MessageMeta {
                            tool_call_id: Some(call.id),
                            ..Default::default()
                        }),
                        created_at: created_at.clone(),
                        status: MessageStatus::Success,
                        error_message: None,
                    });
                }
            }
        }

        // Defensive fallback: if blocks existed but we produced nothing, keep the original message.
        if out.len() == out_start_len {
            out.push(msg);
        }
    }

    out
}

fn strip_ansi_codes(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != 0x1b {
            out.push(bytes[i]);
            i += 1;
            continue;
        }

        // ESC
        i += 1;
        if i >= bytes.len() {
            break;
        }

        match bytes[i] {
            b'[' => {
                // CSI
                i += 1;
                // parameter bytes 0x30-0x3F
                while i < bytes.len() && (0x30..=0x3f).contains(&bytes[i]) {
                    i += 1;
                }
                // intermediate bytes 0x20-0x2F
                while i < bytes.len() && (0x20..=0x2f).contains(&bytes[i]) {
                    i += 1;
                }
                // final byte 0x40-0x7E
                if i < bytes.len() && (0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
            }
            b']' => {
                // OSC
                i += 1;
                while i < bytes.len() {
                    // BEL terminator
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    // ST terminator: ESC \
                    if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            // Other escape sequences: best-effort drop ESC + one byte.
            _ => {
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).to_string()
}

fn sanitize_tool_text_for_model(text: &str) -> String {
    // 1) Try JSON: sanitize known output-bearing string fields.
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(obj) = v.as_object_mut() {
            for key in ["output", "stdout", "stderr", "text", "result"] {
                if let Some(serde_json::Value::String(s)) = obj.get_mut(key) {
                    let cleaned = strip_ansi_codes(s);
                    *s = cleaned;
                }
            }
        }

        return serde_json::to_string(&v).unwrap_or_else(|_| strip_ansi_codes(text));
    }

    // 2) Plain text.
    strip_ansi_codes(text)
}

fn is_sensitive_header_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "x-api-key"
            | "api-key"
            | "apikey"
            | "x-authorization"
            | "x-auth-token"
            | "x-access-token"
            | "x-session-token"
            | "x-goog-api-key"
            | "anthropic-api-key"
    )
}

fn is_sensitive_query_param_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "key"
            | "api_key"
            | "apikey"
            | "access_token"
            | "token"
            | "auth"
            | "authorization"
            | "sig"
            | "signature"
            | "secret"
            | "client_secret"
            | "password"
    )
}

fn redact_debug_url(url: &str) -> String {
    // Best-effort URL redaction: keep non-sensitive query params, but mask known secret-ish ones.
    // This prevents accidental leakage in persisted debugInfo (e.g. Google `?key=...`).
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }

    let (before_hash, frag) = match trimmed.split_once('#') {
        Some((a, b)) => (a, Some(b)),
        None => (trimmed, None),
    };
    let (base, query) = match before_hash.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (before_hash, None),
    };
    let Some(query) = query else {
        return trimmed.to_string();
    };

    let mut out_params: Vec<String> = Vec::new();
    for part in query.split('&') {
        if part.trim().is_empty() {
            continue;
        }
        if let Some((k, v)) = part.split_once('=') {
            if is_sensitive_query_param_name(k) {
                out_params.push(format!("{k}=***"));
            } else {
                out_params.push(format!("{k}={v}"));
            }
        } else {
            // A bare key without "=".
            if is_sensitive_query_param_name(part) {
                out_params.push(format!("{part}=***"));
            } else {
                out_params.push(part.to_string());
            }
        }
    }

    let mut out = String::new();
    out.push_str(base);
    if !out_params.is_empty() {
        out.push('?');
        out.push_str(&out_params.join("&"));
    }
    if let Some(f) = frag {
        out.push('#');
        out.push_str(f);
    }
    out
}

fn redact_debug_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(key, value)| {
            if is_sensitive_header_name(key) {
                (key.clone(), "***".to_string())
            } else {
                (key.clone(), value.clone())
            }
        })
        .collect()
}

fn redact_debug_info_for_store(debug_info: &DebugInfoData) -> DebugInfoData {
    DebugInfoData {
        request: debug_info.request.as_ref().map(|req| DebugRequestData {
            url: redact_debug_url(&req.url),
            method: req.method.clone(),
            headers: redact_debug_headers(&req.headers),
            body: req.body.clone(),
        }),
        response: debug_info.response.as_ref().map(|resp| DebugResponseData {
            status: resp.status,
            headers: redact_debug_headers(&resp.headers),
            body: resp.body.clone(),
        }),
        stream_termination: debug_info.stream_termination.clone(),
        error_origin: debug_info.error_origin.clone(),
    }
}

fn error_layer_cn(layer: &crate::ai_client::ErrorLayer) -> &'static str {
    use crate::ai_client::ErrorLayer;
    match layer {
        ErrorLayer::Config => "配置/输入",
        ErrorLayer::Transport => "网络/传输",
        ErrorLayer::Http => "HTTP",
        ErrorLayer::Protocol => "协议",
        ErrorLayer::Content => "内容/解析",
        ErrorLayer::Runtime => "运行时",
        ErrorLayer::Tool => "工具",
        ErrorLayer::Db => "数据库",
        ErrorLayer::Unknown => "未知",
    }
}

fn format_error_origin_line(origin: &crate::ai_client::ErrorOrigin) -> String {
    let layer = error_layer_cn(&origin.layer);
    let op = origin.operation.as_deref().unwrap_or("<none>");
    format!("错误来源：层次={layer} 模块={} 操作={op}", origin.module)
}

fn decorate_user_error_with_origin(error: &str, debug_info: Option<&DebugInfoData>) -> String {
    let Some(origin) = debug_info.and_then(|d| d.error_origin.as_ref()) else {
        return error.to_string();
    };
    let header = format_error_origin_line(origin);
    if error.starts_with("错误来源：") {
        return error.to_string();
    }
    if error.contains(&header) {
        return error.to_string();
    }
    format!("{header}\n\n{error}")
}

fn build_fallback_reply_markdown(title: &str, message: &str) -> String {
    let mut out = String::new();
    out.push_str("### ");
    out.push_str(title);
    out.push_str("\n\n");
    out.push_str(message.trim());
    out.push('\n');

    out
}

fn sanitize_messages_for_model_input(mut messages: Vec<Message>) -> Vec<Message> {
    for msg in &mut messages {
        if msg.role != MessageRole::Tool {
            continue;
        }
        msg.content = sanitize_tool_text_for_model(&msg.content);
    }
    messages
}

pub async fn run_task(
    app: AppHandle,
    input: RunTaskInput,
    db: Arc<Mutex<Database>>,
    config_manager: Arc<ConfigManager>,
    run_state: Arc<RunState>,
) -> Result<(), SerializableError> {
    let conversation_id = input.conversation_id.clone();

    let result = run_task_inner(
        Some(app),
        None,
        input,
        db,
        config_manager,
        run_state.clone(),
    )
    .await;

    // 统一收尾：无论成功/失败/异常，都确保 run_state 与 abort sender 被清理，避免并发状态错乱。
    run_state.finish_run(&conversation_id).await;
    cleanup_abort_sender(&run_state, &conversation_id).await;

    result
}

pub async fn run_task_with_event_callback(
    input: RunTaskInput,
    db: Arc<Mutex<Database>>,
    config_manager: Arc<ConfigManager>,
    run_state: Arc<RunState>,
    event_callback: RunEventCallback,
) -> Result<(), SerializableError> {
    let conversation_id = input.conversation_id.clone();

    let result = run_task_inner(
        None,
        Some(event_callback),
        input,
        db,
        config_manager,
        run_state.clone(),
    )
    .await;

    run_state.finish_run(&conversation_id).await;
    cleanup_abort_sender(&run_state, &conversation_id).await;
    result
}

pub async fn retry_turn(
    app: AppHandle,
    conversation_id: String,
    assistant_message_id: String,
    turn_id: String,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<serde_json::Value>,
    web_search_provider: Option<String>,
    debug_mode: Option<bool>,
    db: Arc<Mutex<Database>>,
    config_manager: Arc<ConfigManager>,
    run_state: Arc<RunState>,
) -> Result<(), SerializableError> {
    // Retry is a history-rewrite operation: ensure any in-flight run fully stops before we mutate DB.
    run_state.abort_and_wait(&conversation_id, 5_000).await;

    let cleanup_conversation_id = conversation_id.clone();

    let config = config_manager
        .ensure_default()
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    let resolved = resolve_chat_model(&config, agent_name.as_deref(), model_ref.as_deref())?;
    let reinject_thinking = resolved.agent.reinject_thinking;

    let (
        content,
        base_messages_override,
        start_turn_index,
        placeholder_assistant,
        removed_messages,
    ) = {
        let messages = async_db::read_messages(
            &db,
            "retry_turn:get_messages",
            &conversation_id,
            2_000,
            None,
        )
        .await
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

        let assistant_pos = messages
            .iter()
            .position(|m| m.id == assistant_message_id)
            .ok_or_else(|| {
                AppErrorCode::UnknownError(format!(
                    "未找到 assistant message: {}",
                    assistant_message_id
                ))
            })?;
        let assistant_msg = &messages[assistant_pos];
        if assistant_msg.role != MessageRole::Assistant {
            return Err(AppErrorCode::UnknownError(format!(
                "message {} 不是 assistant",
                assistant_message_id
            ))
            .into());
        }

        let user_pos = (0..assistant_pos)
            .rev()
            .find(|&i| messages[i].role == MessageRole::User)
            .ok_or_else(|| {
                AppErrorCode::UnknownError(format!(
                    "assistant message {} 之前未找到 user 消息",
                    assistant_message_id
                ))
            })?;
        let user_msg = &messages[user_pos];

        let meta = assistant_msg.meta.as_ref().ok_or_else(|| {
            AppErrorCode::UnknownError(format!(
                "assistant message {} 缺少 meta（无法定位 turn）",
                assistant_message_id
            ))
        })?;

        let target_turn_index: u32 = meta
            .turns
            .as_ref()
            .and_then(|turns| turns.iter().find(|t| t.turn_id == turn_id))
            .map(|t| t.turn_index)
            .or_else(|| {
                meta.blocks.as_ref().and_then(|blocks| {
                    blocks.iter().find_map(|b| match b {
                        MessageBlock::Text {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::Thinking {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::ToolCall {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::ToolResult {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::Approval {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::Error {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::WebSearch {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        }
                        | MessageBlock::Unknown {
                            turn_id: Some(id),
                            turn_index: Some(i),
                            ..
                        } if id == &turn_id => Some(*i),
                        _ => None,
                    })
                })
            })
            .ok_or_else(|| {
                AppErrorCode::UnknownError(format!(
                    "assistant message {} 内未找到 turn: {}",
                    assistant_message_id, turn_id
                ))
            })?;

        let mut base_messages = messages
            .iter()
            .take(user_pos.saturating_add(1))
            .cloned()
            .filter(|m| m.status == MessageStatus::Success || m.id == user_msg.id)
            .collect::<Vec<_>>();

        // How many persisted messages will be removed when rewinding from this assistant message.
        let removed_messages = (messages.len().saturating_sub(assistant_pos)) as u32;

        // Placeholder assistant message (same id) containing only turns *before* the retried turn.
        // We'll re-insert it after deleting the old tail so the UI can keep showing prior turns.
        let mut placeholder_assistant: Option<Message> = None;
        let mut replay_blocks: Vec<MessageBlock> = Vec::new();

        if target_turn_index > 1 {
            if let Some(blocks) = meta.blocks.as_ref() {
                let mut idx_by_turn_id: HashMap<String, u32> = HashMap::new();
                if let Some(turns) = meta.turns.as_ref() {
                    for t in turns {
                        idx_by_turn_id.insert(t.turn_id.clone(), t.turn_index);
                    }
                }

                let filtered_blocks: Vec<MessageBlock> = blocks
                    .iter()
                    .cloned()
                    .filter(|b| {
                        let (tid, idx) = match b {
                            MessageBlock::Text {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::Thinking {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::ToolCall {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::ToolResult {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::Approval {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::Error {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::WebSearch {
                                turn_id,
                                turn_index,
                                ..
                            }
                            | MessageBlock::Unknown {
                                turn_id,
                                turn_index,
                                ..
                            } => (turn_id.as_ref(), *turn_index),
                        };

                        let Some(tid) = tid else {
                            return false;
                        };
                        let resolved = idx_by_turn_id.get(tid).copied().or(idx);
                        resolved.is_some_and(|i| i < target_turn_index)
                    })
                    .collect();
                replay_blocks = filtered_blocks.clone();

                let filtered_turns = meta.turns.as_ref().map(|turns| {
                    turns
                        .iter()
                        .cloned()
                        .filter(|t| t.turn_index < target_turn_index)
                        .collect::<Vec<_>>()
                });

                let has_filtered_turns = filtered_turns
                    .as_ref()
                    .is_some_and(|turns| !turns.is_empty());

                if !filtered_blocks.is_empty() || has_filtered_turns {
                    placeholder_assistant = Some(Message {
                        id: assistant_message_id.clone(),
                        conversation_id: conversation_id.clone(),
                        role: MessageRole::Assistant,
                        content: String::new(),
                        content_parts: Vec::new(),
                        thinking: None,
                        meta: Some(MessageMeta {
                            model: meta.model.clone(),
                            blocks: if filtered_blocks.is_empty() {
                                None
                            } else {
                                Some(filtered_blocks.clone())
                            },
                            turns: filtered_turns,
                            ..Default::default()
                        }),
                        created_at: assistant_msg.created_at,
                        status: MessageStatus::Success,
                        error_message: None,
                    });
                }
            }
        }

        // Replay prior internal turns (tool calls + tool outputs) into model-visible messages.
        // NOTE: Persisted `meta.blocks` are for UI restoration. The model only sees `Message` content
        // and tool call metadata, so we must reconstruct the runtime chain here for retry_turn.
        if !replay_blocks.is_empty() {
            base_messages.extend(replay_messages_from_blocks(
                &conversation_id,
                &replay_blocks,
                target_turn_index,
                reinject_thinking,
            ));
        }

        (
            user_msg.content.clone(),
            base_messages,
            target_turn_index,
            placeholder_assistant,
            removed_messages,
        )
    };

    // Rewind persisted history: drop the original assistant message (including turns >= target)
    // and all subsequent messages/tasks, then (optionally) re-insert a placeholder containing
    // only the prefix turns so the UI can keep showing them.
    let placeholder_fields = placeholder_assistant
        .as_ref()
        .map(crate::storage::MessageDbFields::from_message)
        .transpose()
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    async_db::with_db(&db, "retry_turn:rewind_history", |db| {
        db.delete_messages_after(&cleanup_conversation_id, &assistant_message_id)?;
        if let (Some(msg), Some(fields)) =
            (placeholder_assistant.as_ref(), placeholder_fields.as_ref())
        {
            db.add_message_with_fields(&cleanup_conversation_id, msg, fields)?;
        }
        Ok::<(), crate::storage::StorageError>(())
    })
    .await
    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    // Notify UI to reload persisted history (important for other windows/tabs).
    {
        let mut emitter = RunEmitter::new(
            app.clone(),
            cleanup_conversation_id.clone(),
            uuid::Uuid::new_v4().to_string(),
        );
        emitter.emit(RunEvent::HistorySyncNeeded {
            reason: "retry_turn_rewind".to_string(),
            removed_messages: Some(removed_messages),
            dropped_for_fit: None,
        });
    }

    let result = run_task_inner(
        Some(app),
        None,
        RunTaskInput {
            conversation_id,
            message_id: None,
            content,
            content_parts: None,
            agent_name,
            model_ref,
            run_mode,
            thinking,
            web_search_provider,
            debug_mode,
            base_messages_override: Some(base_messages_override),
            start_turn_index: Some(start_turn_index),
            assistant_message_id_override: Some(assistant_message_id.clone()),
        },
        db,
        config_manager,
        run_state.clone(),
    )
    .await;

    run_state.finish_run(&cleanup_conversation_id).await;
    cleanup_abort_sender(&run_state, &cleanup_conversation_id).await;
    result
}

#[derive(Default)]
struct ToolingBuildResult {
    tool_orchestrator: Option<ToolOrchestrator>,
    tools: Option<Vec<ToolDefinition>>,
    allowed_tool_names: Option<HashSet<String>>,
    allow_persistent_pty: bool,
    enable_local_web_search_tool: bool,
    enable_mcp_resource_tool_prompt: bool,
    enable_apply_patch_tool_prompt: bool,
    enable_apply_patch_unified_diff_tool_prompt: bool,
    enable_write_file_replace_string_tool_prompt: bool,
    task_agent_tool_prompt: Option<String>,
    external_agent_run_tool_prompt: Option<String>,
}

fn resolve_text_edit_tools_in_allow_list(
    tool_names: &mut Vec<String>,
    preferred: crate::models::TextEditImplementation,
) {
    use crate::models::TextEditImplementation;

    const TEXT_EDIT: &str = "text_edit";
    const APPLY_PATCH: &str = "apply_patch";
    const UNIFIED: &str = "apply_patch_unified_diff";
    const WRITE_FILE: &str = "write_file";
    const REPLACE_STRING: &str = "replace_string";
    const EDIT_TOKENS: [&str; 5] = [TEXT_EDIT, APPLY_PATCH, UNIFIED, WRITE_FILE, REPLACE_STRING];

    let first_idx = tool_names
        .iter()
        .position(|t| EDIT_TOKENS.contains(&t.as_str()));
    let has_marker = tool_names.iter().any(|t| t == TEXT_EDIT);
    let has_apply_patch = tool_names.iter().any(|t| t == APPLY_PATCH);
    let has_unified = tool_names.iter().any(|t| t == UNIFIED);
    let has_write_file = tool_names.iter().any(|t| t == WRITE_FILE);
    let has_replace_string = tool_names.iter().any(|t| t == REPLACE_STRING);
    let has_write_replace = has_write_file && has_replace_string;

    let mut allow_apply_patch = has_apply_patch;
    let mut allow_unified = has_unified;
    let mut allow_write_replace = has_write_replace;
    if has_marker {
        allow_apply_patch = true;
        allow_unified = true;
        allow_write_replace = true;
    }
    if !allow_apply_patch && !allow_unified && !allow_write_replace {
        return;
    }

    let chosen = match preferred {
        TextEditImplementation::ApplyPatch if allow_apply_patch => {
            Some(TextEditImplementation::ApplyPatch)
        }
        TextEditImplementation::ApplyPatchUnifiedDiff if allow_unified => {
            Some(TextEditImplementation::ApplyPatchUnifiedDiff)
        }
        TextEditImplementation::WriteFileReplaceString if allow_write_replace => {
            Some(TextEditImplementation::WriteFileReplaceString)
        }
        _ => {
            if allow_apply_patch {
                Some(TextEditImplementation::ApplyPatch)
            } else if allow_unified {
                Some(TextEditImplementation::ApplyPatchUnifiedDiff)
            } else if allow_write_replace {
                Some(TextEditImplementation::WriteFileReplaceString)
            } else {
                None
            }
        }
    };
    let Some(chosen) = chosen else {
        return;
    };

    tool_names.retain(|t| !EDIT_TOKENS.contains(&t.as_str()));
    let insert_at = first_idx
        .unwrap_or_else(|| tool_names.len())
        .min(tool_names.len());
    match chosen {
        TextEditImplementation::ApplyPatch => {
            tool_names.insert(insert_at, APPLY_PATCH.to_string());
        }
        TextEditImplementation::ApplyPatchUnifiedDiff => {
            tool_names.insert(insert_at, UNIFIED.to_string());
        }
        TextEditImplementation::WriteFileReplaceString => {
            tool_names.insert(insert_at, WRITE_FILE.to_string());
            tool_names.insert(insert_at + 1, REPLACE_STRING.to_string());
        }
    }
}

fn resolve_shell_tools_in_allow_list(
    tool_names: &mut Vec<String>,
    preferred: crate::models::ShellImplementation,
    allow_persistent_pty: bool,
) {
    use crate::models::ShellImplementation;

    const SHELL: &str = "shell";
    const SHELL_COMMAND: &str = "shell_command";
    const EXEC_COMMAND: &str = "exec_command";
    const WRITE_STDIN: &str = "write_stdin";
    const EXEC_COMMAND_PERSISTENT: &str = "exec_command_persistent";
    const WRITE_STDIN_PERSISTENT: &str = "write_stdin_persistent";
    const SHELL_TOKENS: [&str; 6] = [
        SHELL,
        SHELL_COMMAND,
        EXEC_COMMAND,
        WRITE_STDIN,
        EXEC_COMMAND_PERSISTENT,
        WRITE_STDIN_PERSISTENT,
    ];

    let first_idx = tool_names
        .iter()
        .position(|t| SHELL_TOKENS.contains(&t.as_str()));
    let has_marker = tool_names.iter().any(|t| t == SHELL);
    let has_shell_command = tool_names.iter().any(|t| t == SHELL_COMMAND);
    let has_pty =
        tool_names.iter().any(|t| t == EXEC_COMMAND) && tool_names.iter().any(|t| t == WRITE_STDIN);
    let has_pty_persistent = tool_names.iter().any(|t| t == EXEC_COMMAND_PERSISTENT)
        && tool_names.iter().any(|t| t == WRITE_STDIN_PERSISTENT);

    let mut allow_shell_command = has_shell_command;
    let mut allow_pty = has_pty;
    let mut allow_pty_persistent = has_pty_persistent;
    if has_marker {
        allow_shell_command = true;
        allow_pty = true;
        allow_pty_persistent = true;
    }
    if allow_persistent_pty {
        allow_pty = false;
    } else {
        allow_pty_persistent = false;
    }
    if !allow_shell_command && !allow_pty && !allow_pty_persistent {
        return;
    }

    let chosen = match preferred {
        ShellImplementation::ShellCommand => {
            if allow_shell_command {
                Some(ShellImplementation::ShellCommand)
            } else if allow_pty {
                Some(ShellImplementation::Pty)
            } else if allow_pty_persistent {
                Some(ShellImplementation::PtyPersistent)
            } else {
                None
            }
        }
        ShellImplementation::Pty => {
            if allow_pty {
                Some(ShellImplementation::Pty)
            } else if allow_pty_persistent {
                Some(ShellImplementation::PtyPersistent)
            } else if allow_shell_command {
                Some(ShellImplementation::ShellCommand)
            } else {
                None
            }
        }
        ShellImplementation::PtyPersistent => {
            if allow_pty_persistent {
                Some(ShellImplementation::PtyPersistent)
            } else if allow_pty {
                Some(ShellImplementation::Pty)
            } else if allow_shell_command {
                Some(ShellImplementation::ShellCommand)
            } else {
                None
            }
        }
    };
    let Some(chosen) = chosen else {
        return;
    };

    tool_names.retain(|t| !SHELL_TOKENS.contains(&t.as_str()));
    let insert_at = first_idx
        .unwrap_or_else(|| tool_names.len())
        .min(tool_names.len());
    match chosen {
        ShellImplementation::ShellCommand => {
            tool_names.insert(insert_at, SHELL_COMMAND.to_string());
        }
        ShellImplementation::Pty => {
            tool_names.insert(insert_at, EXEC_COMMAND.to_string());
            tool_names.insert(insert_at + 1, WRITE_STDIN.to_string());
        }
        ShellImplementation::PtyPersistent => {
            tool_names.insert(insert_at, EXEC_COMMAND_PERSISTENT.to_string());
            tool_names.insert(insert_at + 1, WRITE_STDIN_PERSISTENT.to_string());
        }
    }
}
async fn build_tooling_for_run(
    tools_enabled: bool,
    config: &crate::models::AppConfig,
    agent: &crate::models::Agent,
    model: &crate::models::Model,
    sandbox_policy: &crate::models::SandboxPolicy,
    chat_mode: bool,
    input_content: &str,
    web_search_provider: Option<&str>,
) -> Result<ToolingBuildResult, SerializableError> {
    if !tools_enabled {
        return Ok(ToolingBuildResult::default());
    }

    let preferred_text_edit = model.text_edit_implementation.clone().unwrap_or_default();
    let preferred_agent_task = model.agent_task_implementation.clone().unwrap_or_default();
    let preferred_shell = model.shell_implementation.clone().unwrap_or_default();

    let mut toolset = match agent.toolset.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(name) => match config.tools.toolsets.iter().find(|t| t.name == name) {
            Some(ts) => {
                let mut tools = ts.tools.clone();
                resolve_text_edit_tools_in_allow_list(&mut tools, preferred_text_edit);
                resolve_shell_tools_in_allow_list(
                    &mut tools,
                    preferred_shell,
                    ts.persistance_shell_enhance,
                );
                super::tools::spec::ToolSet::allow_list(name, tools)
                    .with_persistance_shell_enhance(ts.persistance_shell_enhance)
            }
            None => super::tools::spec::ToolSet::deny_all(name),
        },
        None => super::tools::spec::ToolSet::allow_list("__unbound__", Vec::new()),
    };

    let allow_shell_exec = true;
    let allow_pty_exec =
        !chat_mode && !matches!(sandbox_policy, crate::models::SandboxPolicy::ReadOnly);
    let allow_file_write =
        !chat_mode && !matches!(sandbox_policy, crate::models::SandboxPolicy::ReadOnly);
    let allow_mcp_exec = sandbox_policy.has_full_network_access();
    let permission_policy: Arc<dyn super::tools::permissions::ToolPermissionPolicy> =
        Arc::new(super::tools::permissions::BasicToolPermissionPolicy {
            allow_shell_exec,
            allow_pty_exec,
            allow_file_write,
            allow_mcp_exec,
        });

    let allow_persistent_pty = toolset.persistance_shell_enhance;
    let mut registry = ToolRegistry::new();
    register_builtin_handlers_with_options(
        &mut registry,
        BuiltinHandlerOptions {
            agent_task_implementation: preferred_agent_task,
        },
    );

    let mut mcp_tool_names: Vec<String> = Vec::new();
    let mut mcp_resource_tool_names: Vec<String> = Vec::new();
    let mut enable_mcp_resource_tool_prompt = false;

    if allow_mcp_exec {
        let tool_mentions = crate::mentions::extract_tool_mentions(input_content);
        let mut requested_servers_lower: HashSet<String> = HashSet::new();
        for name in &tool_mentions.plain_names {
            requested_servers_lower.insert(name.to_ascii_lowercase());
        }
        for path in &tool_mentions.paths {
            match crate::mentions::tool_kind_for_path(path) {
                crate::mentions::ToolMentionKind::Mcp => {
                    if let Some(id) = crate::mentions::mcp_id_from_path(path) {
                        requested_servers_lower.insert(id.to_ascii_lowercase());
                    }
                }
                crate::mentions::ToolMentionKind::App => {
                    if let Some(id) = crate::mentions::app_id_from_path(path) {
                        requested_servers_lower.insert(id.to_ascii_lowercase());
                    }
                }
                _ => {}
            }
        }

        if let Some(set_name) = agent.mcp_set.as_deref().filter(|s| !s.trim().is_empty()) {
            let server_map: HashMap<String, crate::models::McpServerConfig> = config
                .mcp
                .servers
                .iter()
                .map(|e| (e.name.clone(), e.config.clone()))
                .collect();

            if let Some(mcp_set) = config.mcp.sets.iter().find(|s| s.name == set_name) {
                let available_in_set_lower: HashSet<String> = mcp_set
                    .servers
                    .iter()
                    .filter(|s| s.enabled)
                    .map(|s| s.server.to_ascii_lowercase())
                    .collect();
                let requested_in_set_lower: HashSet<String> = requested_servers_lower
                    .intersection(&available_in_set_lower)
                    .cloned()
                    .collect();
                let filter_by_mention = !requested_in_set_lower.is_empty();

                let mut effective_servers: HashMap<String, crate::models::McpServerConfig> =
                    HashMap::new();
                for set_server in &mcp_set.servers {
                    if !set_server.enabled {
                        continue;
                    }
                    if filter_by_mention
                        && !requested_in_set_lower.contains(&set_server.server.to_ascii_lowercase())
                    {
                        continue;
                    }
                    let Some(server_cfg) = server_map.get(&set_server.server) else {
                        continue;
                    };
                    if !server_cfg.enabled {
                        continue;
                    }
                    effective_servers.insert(set_server.server.clone(), server_cfg.clone());

                    let tools = match global_mcp_runtime()
                        .list_tools_cached(&set_server.server, server_cfg)
                        .await
                    {
                        Ok(t) => t,
                        Err(err) => {
                            eprintln!(
                                "[MCP] list_tools failed server={} err={}",
                                set_server.server, err
                            );
                            continue;
                        }
                    };
                    let mut tools = tools;
                    if !set_server.enabled_tools.is_empty() {
                        let allow: std::collections::HashSet<&str> = set_server
                            .enabled_tools
                            .iter()
                            .map(|s| s.as_str())
                            .collect();
                        tools.retain(|t| allow.contains(t.name.as_ref()));
                    }
                    if !set_server.disabled_tools.is_empty() {
                        let deny: std::collections::HashSet<&str> = set_server
                            .disabled_tools
                            .iter()
                            .map(|s| s.as_str())
                            .collect();
                        tools.retain(|t| !deny.contains(t.name.as_ref()));
                    }

                    for tool in tools {
                        let tool_name = tool.name.as_ref().to_string();
                        let qualified = qualify_mcp_tool_name(&set_server.server, &tool_name);
                        mcp_tool_names.push(qualified.clone());
                        registry.register(Arc::new(
                            crate::runtime::tools::handlers::mcp::McpToolHandler {
                                qualified_name: qualified,
                                server_name: set_server.server.clone(),
                                tool_name,
                                tool,
                                server_config: server_cfg.clone(),
                            },
                        ));
                    }
                }

                if !effective_servers.is_empty() {
                    let servers = Arc::new(effective_servers);
                    registry.register(Arc::new(
                        crate::runtime::tools::handlers::mcp_resource::ListMcpResourcesTool {
                            servers: Arc::clone(&servers),
                        },
                    ));
                    registry.register(Arc::new(
                        crate::runtime::tools::handlers::mcp_resource::ListMcpResourceTemplatesTool {
                            servers: Arc::clone(&servers),
                        },
                    ));
                    registry.register(Arc::new(
                        crate::runtime::tools::handlers::mcp_resource::ReadMcpResourceTool {
                            servers,
                        },
                    ));
                    mcp_resource_tool_names.push("list_mcp_resources".to_string());
                    mcp_resource_tool_names.push("list_mcp_resource_templates".to_string());
                    mcp_resource_tool_names.push("read_mcp_resource".to_string());
                    enable_mcp_resource_tool_prompt = true;
                }
            }
        } else if !requested_servers_lower.is_empty() {
            let server_map: HashMap<String, crate::models::McpServerConfig> = config
                .mcp
                .servers
                .iter()
                .map(|e| (e.name.clone(), e.config.clone()))
                .collect();
            let mut effective_servers: HashMap<String, crate::models::McpServerConfig> =
                HashMap::new();
            let enabled_server_names_lower: HashSet<String> = server_map
                .iter()
                .filter_map(|(name, cfg)| cfg.enabled.then_some(name.to_ascii_lowercase()))
                .collect();
            let requested_enabled_lower: HashSet<String> = requested_servers_lower
                .intersection(&enabled_server_names_lower)
                .cloned()
                .collect();
            if !requested_enabled_lower.is_empty() {
                for (server_name, server_cfg) in &server_map {
                    if !server_cfg.enabled {
                        continue;
                    }
                    if !requested_enabled_lower.contains(&server_name.to_ascii_lowercase()) {
                        continue;
                    }
                    effective_servers.insert(server_name.clone(), server_cfg.clone());

                    let tools = match global_mcp_runtime()
                        .list_tools_cached(server_name, server_cfg)
                        .await
                    {
                        Ok(t) => t,
                        Err(err) => {
                            eprintln!("[MCP] list_tools failed server={} err={}", server_name, err);
                            continue;
                        }
                    };

                    for tool in tools {
                        let tool_name = tool.name.as_ref().to_string();
                        let qualified = qualify_mcp_tool_name(server_name, &tool_name);
                        mcp_tool_names.push(qualified.clone());
                        registry.register(Arc::new(
                            crate::runtime::tools::handlers::mcp::McpToolHandler {
                                qualified_name: qualified,
                                server_name: server_name.clone(),
                                tool_name,
                                tool,
                                server_config: server_cfg.clone(),
                            },
                        ));
                    }
                }
                if !effective_servers.is_empty() {
                    let servers = Arc::new(effective_servers);
                    registry.register(Arc::new(
                        crate::runtime::tools::handlers::mcp_resource::ListMcpResourcesTool {
                            servers: Arc::clone(&servers),
                        },
                    ));
                    registry.register(Arc::new(
                        crate::runtime::tools::handlers::mcp_resource::ListMcpResourceTemplatesTool {
                            servers: Arc::clone(&servers),
                        },
                    ));
                    registry.register(Arc::new(
                        crate::runtime::tools::handlers::mcp_resource::ReadMcpResourceTool {
                            servers,
                        },
                    ));
                    mcp_resource_tool_names.push("list_mcp_resources".to_string());
                    mcp_resource_tool_names.push("list_mcp_resource_templates".to_string());
                    mcp_resource_tool_names.push("read_mcp_resource".to_string());
                    enable_mcp_resource_tool_prompt = true;
                }
            }
        }
    }

    let ws_cfg = &config.general.web_search_tool;
    let selected_provider = web_search_provider.and_then(|provider| match provider {
        "tavily" => Some(crate::models::WebSearchProvider::Tavily),
        "google" => Some(crate::models::WebSearchProvider::Google),
        "brave" => Some(crate::models::WebSearchProvider::Brave),
        _ => None,
    });
    let (provider_enabled, has_key) = if let Some(provider) = selected_provider {
        let enabled = match provider {
            crate::models::WebSearchProvider::Tavily => ws_cfg.tavily_enabled,
            crate::models::WebSearchProvider::Brave => ws_cfg.brave_enabled,
            crate::models::WebSearchProvider::Google => ws_cfg.google_enabled,
        };
        let has_key = match provider {
            crate::models::WebSearchProvider::Tavily => ws_cfg
                .tavily_api_key
                .as_ref()
                .is_some_and(|key| !key.trim().is_empty()),
            crate::models::WebSearchProvider::Brave => ws_cfg
                .brave_api_key
                .as_ref()
                .is_some_and(|key| !key.trim().is_empty()),
            crate::models::WebSearchProvider::Google => {
                ws_cfg
                    .google_api_key
                    .as_ref()
                    .is_some_and(|key| !key.trim().is_empty())
                    && ws_cfg
                        .google_cx
                        .as_ref()
                        .is_some_and(|key| !key.trim().is_empty())
            }
        };
        (enabled, has_key)
    } else {
        (false, false)
    };

    let enable_local_web_search_tool = selected_provider.is_some() && provider_enabled && has_key;
    if enable_local_web_search_tool {
        registry.register(Arc::new(
            crate::runtime::tools::handlers::web_search::WebSearchTool {
                settings: ws_cfg.clone(),
                provider_override: selected_provider,
            },
        ));
        if matches!(toolset.mode, super::tools::spec::ToolSetMode::AllowList)
            && !toolset.tools.iter().any(|tool| tool == "web_search")
        {
            toolset.tools.push("web_search".to_string());
        }
    }

    if matches!(toolset.mode, super::tools::spec::ToolSetMode::AllowList)
        && (!mcp_tool_names.is_empty() || !mcp_resource_tool_names.is_empty())
    {
        toolset.tools.extend(mcp_tool_names);
        toolset.tools.extend(mcp_resource_tool_names);
    }

    let orchestrator = ToolOrchestrator::new(
        Arc::new(registry),
        ToolOrchestratorConfig {
            toolset,
            permission_policy,
        },
    );
    let specs = orchestrator.tool_specs_for_model();
    let allowed_tool_names: HashSet<String> = specs.iter().map(|spec| spec.name.clone()).collect();
    let tools = tool_specs_to_definitions(&specs);

    let enable_apply_patch_tool_prompt = allowed_tool_names.contains("apply_patch");
    let enable_apply_patch_unified_diff_tool_prompt =
        allowed_tool_names.contains("apply_patch_unified_diff");
    let enable_write_file_replace_string_tool_prompt =
        allowed_tool_names.contains("write_file") || allowed_tool_names.contains("replace_string");
    let (enable_apply_patch_tool_prompt, enable_apply_patch_unified_diff_tool_prompt) = match (
        enable_apply_patch_tool_prompt,
        enable_apply_patch_unified_diff_tool_prompt,
    ) {
        (true, true) => (true, false),
        other => other,
    };
    let enable_write_file_replace_string_tool_prompt = enable_write_file_replace_string_tool_prompt
        && !enable_apply_patch_tool_prompt
        && !enable_apply_patch_unified_diff_tool_prompt;
    let task_agent_tool_prompt = allowed_tool_names
        .contains(AGENT_TASK_TOOL_NAME)
        .then(|| render_task_agent_tool_prompt(config));
    let external_agent_run_tool_prompt = allowed_tool_names
        .contains(AGENT_RUN_TOOL_NAME)
        .then(|| render_external_agent_run_tool_prompt(config));

    Ok(ToolingBuildResult {
        tool_orchestrator: Some(orchestrator),
        tools: Some(tools),
        allowed_tool_names: Some(allowed_tool_names),
        allow_persistent_pty,
        enable_local_web_search_tool,
        enable_mcp_resource_tool_prompt,
        enable_apply_patch_tool_prompt,
        enable_apply_patch_unified_diff_tool_prompt,
        enable_write_file_replace_string_tool_prompt,
        task_agent_tool_prompt,
        external_agent_run_tool_prompt,
    })
}

fn should_persist_assistant_message(
    reuse_assistant_message_id: bool,
    content: &str,
    thinking: &str,
    blocks: &[MessageBlock],
    turns: &[MessageTurn],
) -> bool {
    reuse_assistant_message_id
        || !content.is_empty()
        || !thinking.is_empty()
        || !blocks.is_empty()
        || !turns.is_empty()
}

fn non_empty_text(value: &str) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn build_message_db_fields(
    message: &Message,
    allow_fallback: bool,
) -> Result<crate::storage::MessageDbFields, SerializableError> {
    match crate::storage::MessageDbFields::from_message(message) {
        Ok(fields) => Ok(fields),
        Err(_) if allow_fallback => Ok(crate::storage::MessageDbFields {
            role: "assistant",
            status: match &message.status {
                MessageStatus::Pending => "pending",
                MessageStatus::Success => "success",
                MessageStatus::Failed => "failed",
            },
            created_at: message.created_at.to_rfc3339(),
            content_parts_json: None,
            meta_json: None,
        }),
        Err(err) => Err(AppErrorCode::UnknownError(err.to_string()).into()),
    }
}
async fn persist_assistant_message(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
    assistant_message_id: &str,
    model_name: &str,
    content: &str,
    thinking: &str,
    status: MessageStatus,
    error_message: Option<String>,
    usage_for_meta: Option<TokenUsage>,
    blocks: Vec<MessageBlock>,
    turns: Vec<MessageTurn>,
    reuse_assistant_message_id: bool,
    trace_get_existing: &'static str,
    trace_persist: &'static str,
    allow_fallback_fields: bool,
) -> Result<(), SerializableError> {
    let existing: Option<Message> = if reuse_assistant_message_id {
        async_db::read_message(
            db,
            trace_get_existing,
            conversation_id,
            assistant_message_id,
        )
        .await
        .ok()
    } else {
        None
    };
    let has_existing = existing.is_some();

    let (merged_blocks, merged_turns) = if let Some(existing) = existing.as_ref() {
        let prefix_meta = existing.meta.as_ref();
        let prefix_blocks = prefix_meta.and_then(|meta| meta.blocks.clone());
        let prefix_turns = prefix_meta.and_then(|meta| meta.turns.clone());
        (
            merge_message_blocks(prefix_blocks, blocks),
            merge_message_turns(prefix_turns, turns),
        )
    } else {
        (blocks, turns)
    };

    let assistant_message = Message {
        id: assistant_message_id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::Assistant,
        content: content.to_string(),
        content_parts: Vec::new(),
        thinking: non_empty_text(thinking),
        meta: Some(MessageMeta {
            model: Some(model_name.to_string()),
            blocks: if merged_blocks.is_empty() {
                None
            } else {
                Some(merged_blocks)
            },
            turns: if merged_turns.is_empty() {
                None
            } else {
                Some(merged_turns)
            },
            usage: usage_for_meta,
            ..Default::default()
        }),
        created_at: chrono::Utc::now(),
        status,
        error_message,
    };

    let assistant_fields = build_message_db_fields(&assistant_message, allow_fallback_fields)?;
    async_db::with_db(db, trace_persist, |db| {
        if reuse_assistant_message_id && has_existing {
            db.update_message_with_fields(&assistant_message, &assistant_fields)
        } else {
            db.add_message_with_fields(conversation_id, &assistant_message, &assistant_fields)
        }
    })
    .await
    .map_err(|err| AppErrorCode::UnknownError(err.to_string()))?;
    Ok(())
}

async fn update_user_message_status_silently(
    db: &Arc<Mutex<Database>>,
    trace_context: &'static str,
    message_id: Option<&str>,
    status: MessageStatus,
    error_message: Option<String>,
) {
    if let Some(id) = message_id {
        let _ = async_db::with_db(db, trace_context, |db| {
            db.update_message_status(id, status.clone(), error_message.clone())
        })
        .await;
    }
}

async fn finalize_task_outcome(
    outcome: TaskOutcome,
    db: Arc<Mutex<Database>>,
    emitter: &mut RunEmitter,
    conversation_id: &str,
    user_message_id_for_status_update: Option<&str>,
    reuse_assistant_message_id: bool,
    task_id: String,
    assistant_message_id: String,
    output_format: Option<String>,
    model_name: String,
) -> Result<(), SerializableError> {
    match outcome {
        TaskOutcome::Failed {
            turn_id,
            error,
            debug_info,
            content,
            thinking,
            blocks,
            turns,
        } => {
            let error = decorate_user_error_with_origin(&error, debug_info.as_ref());
            update_user_message_status_silently(
                &db,
                "run_task:failed:update_user_status",
                user_message_id_for_status_update,
                MessageStatus::Failed,
                Some(error.clone()),
            )
            .await;

            if should_persist_assistant_message(
                reuse_assistant_message_id,
                &content,
                &thinking,
                &blocks,
                &turns,
            ) {
                let usage_for_meta = turns.iter().rev().find_map(|turn| turn.usage.clone());
                let _ = persist_assistant_message(
                    &db,
                    conversation_id,
                    &assistant_message_id,
                    &model_name,
                    &content,
                    &thinking,
                    MessageStatus::Failed,
                    Some(error.clone()),
                    usage_for_meta,
                    blocks,
                    turns,
                    reuse_assistant_message_id,
                    "run_task:failed:get_existing_assistant",
                    "run_task:failed:persist_assistant",
                    true,
                )
                .await;
            }

            emitter.emit(RunEvent::Error {
                task_id: Some(task_id),
                turn_id: Some(turn_id),
                assistant_message_id: Some(assistant_message_id),
                error,
                debug_info,
            });
            Ok(())
        }
        TaskOutcome::Success {
            last_turn_id,
            content,
            thinking,
            debug_info,
            usage,
            blocks,
            turns,
        } => {
            update_user_message_status_silently(
                &db,
                "run_task:success:update_user_status",
                user_message_id_for_status_update,
                MessageStatus::Success,
                None,
            )
            .await;

            if should_persist_assistant_message(
                reuse_assistant_message_id,
                &content,
                &thinking,
                &blocks,
                &turns,
            ) {
                let usage_for_meta = usage
                    .clone()
                    .or_else(|| turns.iter().rev().find_map(|turn| turn.usage.clone()));
                persist_assistant_message(
                    &db,
                    conversation_id,
                    &assistant_message_id,
                    &model_name,
                    &content,
                    &thinking,
                    MessageStatus::Success,
                    None,
                    usage_for_meta,
                    blocks,
                    turns,
                    reuse_assistant_message_id,
                    "run_task:success:get_existing_assistant",
                    "run_task:success:persist_assistant",
                    false,
                )
                .await?;
            }

            emitter.emit(RunEvent::Done {
                task_id,
                turn_id: last_turn_id,
                assistant_message_id: Some(assistant_message_id),
                full_content: content,
                format: output_format,
                thinking: non_empty_text(&thinking),
                debug_info,
                usage,
                model: Some(model_name),
            });
            Ok(())
        }
        TaskOutcome::Aborted {
            last_turn_id,
            content,
            thinking,
            blocks,
            turns,
        } => {
            update_user_message_status_silently(
                &db,
                "run_task:aborted:update_user_status",
                user_message_id_for_status_update,
                MessageStatus::Success,
                None,
            )
            .await;

            if should_persist_assistant_message(
                reuse_assistant_message_id,
                &content,
                &thinking,
                &blocks,
                &turns,
            ) {
                let usage_for_meta = turns.iter().rev().find_map(|turn| turn.usage.clone());
                persist_assistant_message(
                    &db,
                    conversation_id,
                    &assistant_message_id,
                    &model_name,
                    &content,
                    &thinking,
                    MessageStatus::Success,
                    None,
                    usage_for_meta,
                    blocks,
                    turns,
                    reuse_assistant_message_id,
                    "run_task:aborted:get_existing_assistant",
                    "run_task:aborted:persist_assistant",
                    false,
                )
                .await?;
            }

            emitter.emit(RunEvent::Done {
                task_id,
                turn_id: last_turn_id,
                assistant_message_id: Some(assistant_message_id),
                full_content: content,
                format: output_format,
                thinking: non_empty_text(&thinking),
                debug_info: None,
                usage: None,
                model: Some(model_name),
            });
            Ok(())
        }
    }
}

struct SkillResolution {
    app_skills_dir: Option<std::path::PathBuf>,
    repo_skills_dir: Option<std::path::PathBuf>,
    workstudio_skills_dir: Option<std::path::PathBuf>,
    enabled_skills_meta: Vec<SkillEntry>,
}

fn resolve_skill_context(
    config_manager: &ConfigManager,
    app: Option<&AppHandle>,
    workstudio: Option<&crate::models::Workstudio>,
    config: &crate::models::AppConfig,
    agent: &crate::models::Agent,
) -> SkillResolution {
    let app_skills_dir = config_manager
        .config_path()
        .parent()
        .map(|path| path.join("skills"));
    let repo_skills_dir = {
        let from_resources = app
            .and_then(|app_handle| app_handle.path().resource_dir().ok())
            .map(|path| path.join("skills"))
            .filter(|path| path.is_dir());
        if from_resources.is_some() {
            from_resources
        } else {
            let from_manifest = option_env!("CARGO_MANIFEST_DIR").and_then(|manifest_dir| {
                let manifest = std::path::PathBuf::from(manifest_dir);
                if let Some(parent) = manifest.parent() {
                    let path = parent.join("skills");
                    if path.is_dir() {
                        return Some(path);
                    }
                }
                if let Some(grand) = manifest.parent().and_then(|path| path.parent()) {
                    let path = grand.join("tauri-ai").join("skills");
                    if path.is_dir() {
                        return Some(path);
                    }
                    let fallback = grand.join("skills");
                    if fallback.is_dir() {
                        return Some(fallback);
                    }
                }
                None
            });
            if from_manifest.is_some() {
                from_manifest
            } else {
                let try_from_ancestors = |base: &std::path::Path| -> Option<std::path::PathBuf> {
                    for dir in base.ancestors().take(8) {
                        let path = dir.join("tauri-ai").join("skills");
                        if path.is_dir() {
                            return Some(path);
                        }
                        let fallback = dir.join("skills");
                        if fallback.is_dir() {
                            return Some(fallback);
                        }
                    }
                    None
                };
                let from_exe = std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().and_then(try_from_ancestors));
                if from_exe.is_some() {
                    from_exe
                } else {
                    std::env::current_dir()
                        .ok()
                        .and_then(|cwd| try_from_ancestors(&cwd))
                }
            }
        }
    };
    let workstudio_skills_dir = workstudio
        .map(|ws| std::path::PathBuf::from(&ws.main_folder).join("skills"))
        .filter(|path| path.is_dir());
    let enabled_skills_meta = select_enabled_skills(
        config,
        agent,
        app_skills_dir.as_deref(),
        repo_skills_dir.as_deref(),
        workstudio_skills_dir.as_deref(),
        false,
    );

    SkillResolution {
        app_skills_dir,
        repo_skills_dir,
        workstudio_skills_dir,
        enabled_skills_meta,
    }
}

async fn run_task_inner(
    app: Option<AppHandle>,
    event_callback: Option<RunEventCallback>,
    mut input: RunTaskInput,
    db: Arc<Mutex<Database>>,
    config_manager: Arc<ConfigManager>,
    run_state: Arc<RunState>,
) -> Result<(), SerializableError> {
    let config = config_manager
        .ensure_default()
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let task_id = uuid::Uuid::new_v4().to_string();
    // 一个 Task 最终只落一条 assistant 消息（tool/websearch 等作为 blocks 扩展）
    let assistant_message_id = input
        .assistant_message_id_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let reuse_assistant_message_id = input
        .assistant_message_id_override
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());

    let mut emitter = if let Some(app_handle) = app.as_ref() {
        RunEmitter::new(
            app_handle.clone(),
            input.conversation_id.clone(),
            run_id.clone(),
        )
    } else if let Some(callback) = event_callback {
        RunEmitter::new_with_callback(input.conversation_id.clone(), run_id.clone(), callback)
    } else {
        return Err(AppErrorCode::UnknownError(
            "run_task_inner 缺少事件发射目标（AppHandle/Callback）".to_string(),
        )
        .into());
    };

    let resolved = resolve_chat_model(
        &config,
        input.agent_name.as_deref(),
        input.model_ref.as_deref(),
    )?;
    let (provider, model, agent) = (resolved.provider, resolved.model, resolved.agent);
    let output_format = get_output_format(agent);

    let requested_mode = input.run_mode.as_deref().unwrap_or("").trim();
    let chat_mode = requested_mode == "chat";
    let runtime_agent_type = match requested_mode {
        "chat" => AgentType::Chat,
        "agent" | "agent-custom" | "agent-full-access" => AgentType::Tool,
        _ => agent.agent_type,
    };
    let force_full_access = requested_mode == "agent-full-access";
    let use_custom_security = requested_mode == "agent-custom";
    // Tools can also be enabled in chat mode (read-only sandbox by default).
    let tools_enabled =
        matches!(runtime_agent_type, AgentType::Tool | AgentType::TaskAgent) || chat_mode;

    if !provider.enabled {
        return Err(AppErrorCode::AiServiceError(format!(
            "Provider '{}' is disabled",
            provider.display_name
        ))
        .into());
    }

    // Determine if native web search should be enabled based on provider selection
    // - "native" or None with model support => enable native web search
    // - "tavily"/"google"/"brave" => disable native (handled by local tool)
    let native_web_search_enabled = match input.web_search_provider.as_deref() {
        Some("native") => Some(true),
        Some("tavily") | Some("google") | Some("brave") => Some(false),
        None => None, // Default: let model decide based on capabilities
        _ => None,
    };

    let mut model_config =
        build_model_config(provider, model, input.thinking, native_web_search_enabled);
    let debug_mode = input.debug_mode.unwrap_or(config.general.debug_mode);
    // Debug: 在日志输出原始 SSE（仅流式请求）
    model_config.debug_sse = debug_mode && config.general.debug_sse;
    let client = get_client(&model_config.provider)
        .map_err(|e| AppErrorCode::AiServiceError(e.to_string()))?;

    let start_turn_index = input.start_turn_index.unwrap_or(1).max(1);

    // 1) 生成用户消息 + 构建基础上下文
    // - 正常 run_task：落库用户消息（Pending），并取 Success + 本次用户消息作为 base_messages
    // - retry_turn：直接使用预构建 base_messages（不新增用户消息）
    let (user_message_id_for_status_update, mut base_messages) = if let Some(prebuilt) =
        input.base_messages_override.take()
    {
        (None, prebuilt)
    } else {
        // 落库用户消息（Pending）
        let user_message = Message {
            id: input
                .message_id
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            conversation_id: input.conversation_id.clone(),
            role: MessageRole::User,
            content: input.content.clone(),
            content_parts: input.content_parts.take().unwrap_or_default(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Pending,
            error_message: None,
        };
        let user_message_fields = crate::storage::MessageDbFields::from_message(&user_message)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
        async_db::with_db(&db, "run_task:add_user_message", |db| {
            db.add_message_with_fields(&input.conversation_id, &user_message, &user_message_fields)
        })
        .await
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

        // 历史消息作为“基础上下文”（只取 Success + 本次 Pending 用户消息）
        let base_messages = async_db::read_messages(
            &db,
            "run_task:get_base_messages",
            &input.conversation_id,
            100,
            None,
        )
        .await
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
        .into_iter()
        .filter(|m| m.status == MessageStatus::Success || m.id == user_message.id)
        .collect::<Vec<_>>();

        (Some(user_message.id), base_messages)
    };
    let conversation = async_db::with_db(
        &db,
        "run_task:get_conversation_for_cached_system_prompt",
        |db| db.get_conversation(&input.conversation_id),
    )
    .await
    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    // Apply persisted prompt-view cutoff (hard trim watermark) for normal run_task flows.
    // retry_turn/base_messages_override should keep the prebuilt snapshot intact.
    if user_message_id_for_status_update.is_some() {
        if let Some(cutoff_id) = conversation
            .as_ref()
            .and_then(|c| c.prompt_cutoff_message_id.as_deref())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if let Some(pos) = base_messages.iter().position(|m| m.id == cutoff_id) {
                base_messages.drain(0..pos);
            }
        }
    }

    let cached_system_prompt: Option<(String, String)> = conversation.as_ref().and_then(|c| {
        let prompt = c.system_prompt.as_ref().and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        })?;
        let key = c.system_prompt_cache_key.as_ref().and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        })?;
        Some((prompt, key))
    });
    // 默认：新任务开始时不传历史 reasoning_content（thinking），避免跨任务污染与上下文爆炸（DeepSeek 等）。
    // 但 Moonshot Kimi thinking 模型在启用 thinking 时要求把 `reasoning_content` 保留在上下文中。
    // 这里提供 model 级开关：`reinject_reasoning_content=true` 时才保留历史 thinking。
    let is_kimi_thinking = model_config.provider == "openai_compatible"
        && model_config
            .thinking_level
            .as_deref()
            .is_some_and(|v| v != "disabled")
        && (model_config.model.to_ascii_lowercase().starts_with("kimi-")
            || model_config
                .api_base
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("moonshot"));
    let keep_history_thinking = is_kimi_thinking && model_config.reinject_reasoning_content;
    let base_messages = base_messages
        .into_iter()
        .map(|mut m| {
            if m.role == MessageRole::Assistant && !keep_history_thinking {
                m.thinking = None;
                if let Some(meta) = m.meta.as_mut() {
                    if let Some(blocks) = meta.blocks.as_mut() {
                        blocks.retain(|b| !matches!(b, MessageBlock::Thinking { .. }));
                    }
                }
            }
            m
        })
        .collect::<Vec<_>>();
    let base_messages = match runtime_agent_type {
        AgentType::Tool | AgentType::TaskAgent => match provider.provider_type {
            crate::models::ProviderType::Openai
            | crate::models::ProviderType::OpenaiCompatible
            | crate::models::ProviderType::OpenaiResponses
            | crate::models::ProviderType::Anthropic
            | crate::models::ProviderType::Google => {
                expand_persisted_blocks_for_model_input(base_messages)
            }
            _ => append_tool_trace_for_model_input(base_messages),
        },
        AgentType::Chat | AgentType::Practice => append_tool_trace_for_model_input(base_messages),
    };

    // ---------------------------------------------------------------------
    // Context management (agent-level): apply latest persisted compaction summary to the prompt view.
    //
    // NOTE: This does NOT delete/modify raw messages in DB; it only affects what we send to the model.
    // ---------------------------------------------------------------------
    let ctx_mgr = ContextManager::new(agent.context_policy.clone());
    let base_messages = if user_message_id_for_status_update.is_some() {
        ctx_mgr
            .apply_persisted_compaction_view_for_prompt(
                &input.conversation_id,
                user_message_id_for_status_update.as_deref(),
                base_messages,
                db.clone(),
            )
            .await
    } else {
        // `base_messages_override` is used by retry/restore flows; keep it intact.
        base_messages
    };

    // 2.5) Workstudio: when tools are enabled, bind a working directory (main folder) so
    // read-only tools (rg/read_file/list_dir) have a workspace root to operate on.
    //
    // Chat mode in this project can also run tools (under a stricter sandbox), so we don't
    // tie this solely to AgentType::Tool.
    let workspace_enabled = tools_enabled && agent.workspace_support.unwrap_or(true);
    let (workstudio, default_workdir) = if workspace_enabled {
        let ws = crate::storage::async_db::ensure_workstudio_for_conversation(
            &db,
            &input.conversation_id,
        )
        .await
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
        let dir = std::path::PathBuf::from(ws.main_folder.clone());
        (Some(ws), Some(dir))
    } else {
        (None, None)
    };
    let workspace_roots: Vec<std::path::PathBuf> = workstudio
        .as_ref()
        .map(|ws| {
            let mut roots = Vec::new();
            roots.push(std::path::PathBuf::from(ws.main_folder.clone()));
            roots.extend(
                ws.folders
                    .iter()
                    .map(|p| std::path::PathBuf::from(p.clone())),
            );
            roots
        })
        .unwrap_or_default();

    // Workstudio 域安全配置（存储在 main_folder/.tauriai/security.json）
    // 分层策略采用 OR：只要任一层允许即可（这里体现为对可写目录/信任命令做并集叠加）。
    let workstudio_security =
        workstudio.as_ref().and_then(
            |ws| match read_workstudio_security_config(&ws.main_folder) {
                Ok(cfg) => Some(cfg),
                Err(err) => {
                    eprintln!(
                        "[security] read workstudio security config failed ({}): {err}",
                        ws.main_folder
                    );
                    None
                }
            },
        );

    let base_security_policy = config
        .security
        .resolve_policy(agent.security_policy.as_deref());

    // RunMode semantics:
    // - chat: enable tools but block file writes / pty by default (keep network by security policy)
    // - agent: use security policy only
    // - agent-custom: use agent overrides (sandboxPolicy/approvalPolicy) on top of the security policy
    let mut sandbox_policy = if use_custom_security {
        agent
            .sandbox_policy
            .clone()
            .unwrap_or_else(|| base_security_policy.sandbox_policy.clone())
    } else {
        base_security_policy.sandbox_policy.clone()
    };
    if chat_mode {
        // Important:
        // - Chat mode should keep "network access" semantics from the security policy,
        //   otherwise MCP/web_search are silently unavailable even when the user explicitly enables them.
        // - We still block file writes/pty in chat mode via the tool permission policy below.
        let network_access = sandbox_policy.has_full_network_access();
        sandbox_policy = crate::models::SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        };
    }
    if force_full_access {
        sandbox_policy = crate::models::SandboxPolicy::DangerFullAccess;
    }

    // OR 合并：Workstudio 的额外可写目录追加到 sandboxPolicy.writableRoots（仅对 workspace-write 生效）。
    if let (Some(ws_sec), crate::models::SandboxPolicy::WorkspaceWrite { writable_roots, .. }) =
        (workstudio_security.as_ref(), &mut sandbox_policy)
    {
        if !ws_sec.writable_roots.is_empty() {
            writable_roots.extend(ws_sec.writable_roots.iter().cloned());
            // 去重（保持相对稳定的顺序）
            let mut seen = std::collections::HashSet::<String>::new();
            writable_roots.retain(|r| seen.insert(r.clone()));
        }
    }

    let approval_policy = if use_custom_security {
        agent
            .approval_policy
            .unwrap_or(base_security_policy.approval_policy)
    } else {
        base_security_policy.approval_policy
    };

    let security_policy_name = if use_custom_security {
        "custom".to_string()
    } else {
        base_security_policy.name.clone()
    };

    // OR 合并：Workstudio 的信任命令列表与 Agent 安全策略叠加。
    let mut trusted_commands = base_security_policy.trusted_commands.clone();
    if let Some(ws_sec) = workstudio_security.as_ref() {
        if !ws_sec.trusted_commands.is_empty() {
            trusted_commands.extend(ws_sec.trusted_commands.iter().cloned());
            let mut seen = std::collections::HashSet::<(String, String)>::new();
            trusted_commands.retain(|t| seen.insert((t.tool.clone(), t.command.clone())));
        }
    }

    // 3) 允许 stop/撤回 等并发操作中断当前 run
    let (abort_tx, mut abort_rx) = mpsc::channel::<()>(1);
    {
        let mut senders = run_state.abort_senders.write().await;
        senders.insert(input.conversation_id.clone(), abort_tx);
    }
    run_state.register_run(&input.conversation_id).await;

    // lifecycle：TaskStarted
    emitter.emit(RunEvent::TaskStarted {
        task_id: task_id.clone(),
        task_kind: match runtime_agent_type {
            AgentType::Tool | AgentType::TaskAgent => TaskKind::Tool,
            AgentType::Chat | AgentType::Practice => TaskKind::Chat,
        },
        title: None,
    });

    // tools：按 Agent 选择工具集，并在这里完成“权限过滤 -> 传给模型的 ToolDefinition”
    // - 真实执行时仍会再次做权限检查（防止前端/模型绕过）
    let tool_services = run_state.get_tool_services(&input.conversation_id).await;
    let approval_store = run_state.get_approval_store(&input.conversation_id).await;

    // 工具系统是否启用：由本次输入的运行模式/AgentType 决定，而不是全局开关。
    // - Chat：允许工具调用，但在更严格的沙盒策略下运行（例如禁止写文件）
    // - Agent：按 toolset + 安全策略暴露/执行
    let ToolingBuildResult {
        tool_orchestrator,
        tools,
        allowed_tool_names,
        allow_persistent_pty,
        enable_local_web_search_tool,
        enable_mcp_resource_tool_prompt,
        enable_apply_patch_tool_prompt,
        enable_apply_patch_unified_diff_tool_prompt,
        enable_write_file_replace_string_tool_prompt,
        task_agent_tool_prompt,
        external_agent_run_tool_prompt,
    } = build_tooling_for_run(
        tools_enabled,
        &config,
        agent,
        model,
        &sandbox_policy,
        chat_mode,
        &input.content,
        input.web_search_provider.as_deref(),
    )
    .await?;

    // 4) TurnLoop：max_turns 统一以配置为准（agent.max_turns），未配置则使用全局默认值。
    let default_max_turns: u32 = 10_000;
    let max_turns: u32 = agent.max_turns.unwrap_or(default_max_turns).max(1);
    // Note: 如果 max_turns 过小且模型仍然请求工具调用，会在 TurnLoop 内失败并提示用户调大 max_turns。

    // Skills: load (metadata only by default; full contents only when a skill is explicitly mentioned).
    let SkillResolution {
        app_skills_dir,
        repo_skills_dir,
        workstudio_skills_dir,
        enabled_skills_meta,
    } = resolve_skill_context(
        &config_manager,
        app.as_ref(),
        workstudio.as_ref(),
        &config,
        agent,
    );

    let py = python_availability();
    let computed_cache_key = compute_system_prompt_cache_key(
        agent,
        workstudio.as_ref(),
        allow_persistent_pty,
        enable_apply_patch_tool_prompt,
        enable_apply_patch_unified_diff_tool_prompt,
        enable_write_file_replace_string_tool_prompt,
        enable_local_web_search_tool,
        enable_mcp_resource_tool_prompt,
        task_agent_tool_prompt.as_deref(),
        external_agent_run_tool_prompt.as_deref(),
        &enabled_skills_meta,
        py,
    );

    let cache_hit = cached_system_prompt
        .as_ref()
        .is_some_and(|(_, key)| key == &computed_cache_key);

    let mut runtime_messages = if cache_hit {
        let (cached_prompt, _) = cached_system_prompt.as_ref().expect("checked cache_hit");
        let mut messages = base_messages;
        messages.insert(
            0,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: input.conversation_id.to_string(),
                role: MessageRole::System,
                content: cached_prompt.clone(),
                content_parts: Vec::new(),
                thinking: None,
                meta: None,
                created_at: chrono::Utc::now(),
                status: MessageStatus::Success,
                error_message: None,
            },
        );
        messages
    } else {
        let mut messages = build_request_messages(base_messages, &input.conversation_id, agent);

        if let Some(ws) = workstudio.as_ref() {
            inject_workstudio_prompt(&mut messages, &input.conversation_id, ws);
        }

        if !enabled_skills_meta.is_empty() {
            if let Some(section) = crate::prompts::render_skills_section(&enabled_skills_meta) {
                let insert_at = messages
                    .iter()
                    .take_while(|m| m.role == MessageRole::System)
                    .count();
                messages.insert(
                    insert_at,
                    Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: input.conversation_id.to_string(),
                        role: MessageRole::System,
                        content: section,
                        content_parts: Vec::new(),
                        thinking: None,
                        meta: None,
                        created_at: chrono::Utc::now(),
                        status: MessageStatus::Success,
                        error_message: None,
                    },
                );
            }
        }

        if allow_persistent_pty {
            inject_persistent_process_prompt(&mut messages, &input.conversation_id);
        }
        if enable_apply_patch_tool_prompt {
            inject_apply_patch_tool_prompt(&mut messages, &input.conversation_id);
        }
        if enable_apply_patch_unified_diff_tool_prompt {
            inject_apply_patch_unified_diff_tool_prompt(&mut messages, &input.conversation_id);
        }
        if enable_write_file_replace_string_tool_prompt {
            inject_write_file_replace_string_tool_prompt(&mut messages, &input.conversation_id);
        }
        if enable_local_web_search_tool {
            inject_web_search_tool_prompt(&mut messages, &input.conversation_id);
        }
        if enable_mcp_resource_tool_prompt {
            inject_mcp_resource_tool_prompt(&mut messages, &input.conversation_id);
        }
        if let Some(task_agent_prompt) = task_agent_tool_prompt.as_deref() {
            inject_task_agent_tool_prompt(&mut messages, &input.conversation_id, task_agent_prompt);
        }
        if let Some(external_agent_prompt) = external_agent_run_tool_prompt.as_deref() {
            inject_external_agent_run_tool_prompt(
                &mut messages,
                &input.conversation_id,
                external_agent_prompt,
            );
        }

        if let Some(merged_prompt) =
            merge_system_messages_into_single_in_place(&mut messages, &input.conversation_id)
        {
            async_db::with_db(&db, "run_task:update_system_prompt_cache", |db| {
                db.update_conversation_system_prompt(
                    &input.conversation_id,
                    &merged_prompt,
                    Some(computed_cache_key.as_str()),
                )
            })
            .await
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
        }

        messages
    };

    // Per-message dynamic skill injection:
    // - Do NOT cache this (depends on the current input).
    // - Keep system prompt as a single message by appending the skill blocks.
    if !enabled_skills_meta.is_empty() {
        let reserved_names_lower =
            effective_mcp_server_slugs_lower(&config, agent, &sandbox_policy);
        let mentioned =
            find_skill_mentions(&input.content, &enabled_skills_meta, &reserved_names_lower);
        if !mentioned.is_empty() {
            let mentioned_names: HashSet<String> =
                mentioned.into_iter().map(|s| s.meta.name).collect();
            let enabled_skills_full = select_enabled_skills(
                &config,
                agent,
                app_skills_dir.as_deref(),
                repo_skills_dir.as_deref(),
                workstudio_skills_dir.as_deref(),
                true,
            );
            let mentioned_full: Vec<SkillEntry> = enabled_skills_full
                .into_iter()
                .filter(|s| mentioned_names.contains(&s.meta.name))
                .collect();
            if !mentioned_full.is_empty() {
                let block = crate::prompts::build_skill_prompt_block(&mentioned_full);
                if let Some(first) = runtime_messages.first_mut() {
                    if first.role == MessageRole::System {
                        first.content.push_str("\n\n");
                        first.content.push_str(block.trim_end());
                        first.content.push('\n');
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Context management: normal compact + hard trimming (agent-level)
    // ---------------------------------------------------------------------
    let can_mutate_history = user_message_id_for_status_update.is_some();
    let context_length = model.context_length;

    if let Some(ctx_len) = context_length.filter(|v| *v > 0) {
        // Auto compact (Codex-like): when prompt usage gets high, compact persisted history.
        let estimated_tokens = estimate_prompt_tokens(&runtime_messages);
        let hard_pct = ctx_mgr.hard_limit_percent();
        let threshold_pct = ctx_mgr
            .auto_compact_threshold_percent()
            .min(hard_pct.saturating_sub(1).max(1));
        let threshold = auto_compact_threshold_tokens(ctx_len, threshold_pct);

        if can_mutate_history && ctx_mgr.should_auto_compact() && estimated_tokens >= threshold {
            if let crate::models::ContextPolicyConfig::NormalCompact(cfg) = &ctx_mgr.policy {
                match run_normal_compact(
                    cfg,
                    &input.conversation_id,
                    user_message_id_for_status_update.as_deref(),
                    context_length,
                    client.clone(),
                    &model_config,
                    db.clone(),
                )
                .await
                {
                    Ok(result) if result.compacted => {
                        // Tell frontend to reload messages, because persisted history has changed (summary inserted).
                        emitter.emit(RunEvent::HistorySyncNeeded {
                            reason: "normal_compact".to_string(),
                            removed_messages: Some(result.removed_messages as u32),
                            dropped_for_fit: Some(result.dropped_for_fit as u32),
                        });

                        // Reload base messages for this request (keep system prompt as-is).
                        let refreshed_base_messages = async_db::read_messages(
                            &db,
                            "run_task:reload_messages_after_compact",
                            &input.conversation_id,
                            100,
                            None,
                        )
                        .await
                        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
                        .into_iter()
                        .filter(|m| {
                            m.status == MessageStatus::Success
                                || user_message_id_for_status_update
                                    .as_ref()
                                    .is_some_and(|id| m.id == *id)
                        })
                        .collect::<Vec<_>>();

                        let refreshed_base_messages = refreshed_base_messages
                            .into_iter()
                            .map(|mut m| {
                                if m.role == MessageRole::Assistant && !keep_history_thinking {
                                    m.thinking = None;
                                    if let Some(meta) = m.meta.as_mut() {
                                        if let Some(blocks) = meta.blocks.as_mut() {
                                            blocks.retain(|b| {
                                                !matches!(b, MessageBlock::Thinking { .. })
                                            });
                                        }
                                    }
                                }
                                m
                            })
                            .collect::<Vec<_>>();

                        let refreshed_base_messages = match runtime_agent_type {
                            AgentType::Tool | AgentType::TaskAgent => {
                                match provider.provider_type {
                                    crate::models::ProviderType::Openai
                                    | crate::models::ProviderType::OpenaiCompatible
                                    | crate::models::ProviderType::OpenaiResponses
                                    | crate::models::ProviderType::Anthropic
                                    | crate::models::ProviderType::Google => {
                                        expand_persisted_blocks_for_model_input(
                                            refreshed_base_messages,
                                        )
                                    }
                                    _ => append_tool_trace_for_model_input(refreshed_base_messages),
                                }
                            }
                            AgentType::Chat | AgentType::Practice => {
                                append_tool_trace_for_model_input(refreshed_base_messages)
                            }
                        };

                        let refreshed_base_messages = ctx_mgr
                            .apply_persisted_compaction_view_for_prompt(
                                &input.conversation_id,
                                user_message_id_for_status_update.as_deref(),
                                refreshed_base_messages,
                                db.clone(),
                            )
                            .await;

                        let sys_prefix = runtime_messages
                            .iter()
                            .take_while(|m| m.role == MessageRole::System)
                            .count();
                        let mut rebuilt = runtime_messages[..sys_prefix].to_vec();
                        rebuilt.extend(refreshed_base_messages);
                        runtime_messages = rebuilt;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        // Compaction failure should not fail the user task; fall back to trimming.
                        eprintln!("normal_compact failed: {}", e.message);
                    }
                }
            }
        }
    }

    let mut turn_loop = TurnLoop {
        client,
        model_config: model_config.clone(),
        ctx_mgr: ctx_mgr.clone(),
        context_length,
        tools,
        allowed_tool_names,
        tool_orchestrator,
        tool_services,
        default_workdir,
        workspace_roots,
        sandbox_policy,
        approval_policy,
        chat_mode,
        security_policy_name,
        trusted_commands,
        approval_store,
        db: db.clone(),
        run_state: run_state.clone(),
        runtime_messages,
        conversation_id: input.conversation_id.clone(),
        task_id: task_id.clone(),
        assistant_message_id: assistant_message_id.clone(),
        output_format: output_format.clone(),
        max_turns,
        start_turn_index,
        reinject_thinking: agent.reinject_thinking,
        debug_mode,
        turn_retry_attempts: {
            let configured = model_config.retry_attempts.unwrap_or(8).clamp(1, 10);
            if config.general.manual_turn_retry {
                1
            } else {
                configured
            }
        },
        emitter: &mut emitter,
    };

    let outcome = turn_loop.run(&mut abort_rx).await;
    run_state
        .cleanup_task_sessions(&input.conversation_id, &task_id, allow_persistent_pty)
        .await;

    finalize_task_outcome(
        outcome,
        db,
        &mut emitter,
        &input.conversation_id,
        user_message_id_for_status_update.as_deref(),
        reuse_assistant_message_id,
        task_id,
        assistant_message_id,
        output_format,
        model_config.model,
    )
    .await
}

async fn cleanup_abort_sender(run_state: &RunState, conversation_id: &str) {
    let mut senders = run_state.abort_senders.write().await;
    senders.remove(conversation_id);
}

fn message_block_id(block: &MessageBlock) -> &str {
    match block {
        MessageBlock::Text { id, .. }
        | MessageBlock::Thinking { id, .. }
        | MessageBlock::ToolCall { id, .. }
        | MessageBlock::ToolResult { id, .. }
        | MessageBlock::Approval { id, .. }
        | MessageBlock::Error { id, .. }
        | MessageBlock::WebSearch { id, .. }
        | MessageBlock::Unknown { id, .. } => id,
    }
}

fn merge_message_blocks(
    prefix: Option<Vec<MessageBlock>>,
    next: Vec<MessageBlock>,
) -> Vec<MessageBlock> {
    let mut out: Vec<MessageBlock> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(prefix) = prefix {
        for block in prefix {
            if seen.insert(message_block_id(&block).to_string()) {
                out.push(block);
            }
        }
    }
    for block in next {
        if seen.insert(message_block_id(&block).to_string()) {
            out.push(block);
        }
    }
    out
}

fn merge_message_turns(
    prefix: Option<Vec<MessageTurn>>,
    next: Vec<MessageTurn>,
) -> Vec<MessageTurn> {
    let mut out: Vec<MessageTurn> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(prefix) = prefix {
        for t in prefix {
            if seen.insert(t.turn_id.clone()) {
                out.push(t);
            }
        }
    }
    for t in next {
        if seen.insert(t.turn_id.clone()) {
            out.push(t);
        }
    }
    out.sort_by_key(|t| t.turn_index);
    out
}

trait TurnEventEmitter: Send {
    fn emit(&mut self, event: RunEvent);
}

impl TurnEventEmitter for RunEmitter {
    fn emit(&mut self, event: RunEvent) {
        RunEmitter::emit(self, event);
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_one_turn(
    client: Arc<dyn crate::ai_client::AiClient>,
    model_config: crate::models::ModelConfig,
    tools: Option<Vec<ToolDefinition>>,
    messages: Vec<Message>,
    emitter: &mut dyn TurnEventEmitter,
    task_id: &str,
    turn_id: &str,
    assistant_message_id: &str,
    output_format: Option<String>,
    abort_rx: &mut mpsc::Receiver<()>,
    max_attempts: u32,
) -> TurnStreamResult {
    // Turn 级重试（避免 transient 网络/限流导致整个 Task 直接失败）
    // - 只在“本轮尚未向前端输出任何增量”时才自动重试，避免重复输出/状态错乱
    // - 最大尝试次数由配置决定（至少 1）
    let max_attempts = max_attempts.max(1);
    const BASE_DELAY_MS: u64 = 1_000;
    const MAX_DELAY_MS: u64 = 30_000;

    fn status_from_debug(di: Option<&DebugInfoData>) -> Option<u16> {
        di.and_then(|d| d.response.as_ref()).map(|r| r.status)
    }

    fn is_retryable_status(status: u16) -> bool {
        status == 408 || status == 429 || (500..600).contains(&status)
    }

    fn retry_after_ms(di: Option<&DebugInfoData>) -> Option<u64> {
        let headers = di.and_then(|d| d.response.as_ref()).map(|r| &r.headers)?;
        let val = headers
            .iter()
            .find(|(k, _)| k.to_ascii_lowercase() == "retry-after")
            .map(|(_, v)| v.as_str())?;

        // RFC allows either delta-seconds or HTTP date;这里只处理 delta-seconds（足够覆盖常见 429）
        let trimmed = val.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Ok(seconds) = trimmed.parse::<f64>() {
            if seconds.is_finite() && seconds >= 0.0 {
                return Some((seconds * 1000.0) as u64);
            }
        }
        None
    }

    fn retry_after_ms_from_message(message: &str) -> Option<u64> {
        // 尽量对齐 Codex：不少网关会把 retry_after 放在错误文案里（而不是 header）。
        // 示例：
        // - "Please try again in 20s."
        // - "try again in 500ms"
        // - "retry after 2 minutes"
        let lower = message.to_ascii_lowercase();
        let markers = ["try again in", "please try again in", "retry after"];

        let idx = markers
            .iter()
            .filter_map(|m| lower.find(m).map(|i| (i, *m)))
            .min_by_key(|(i, _)| *i)
            .map(|(i, m)| i + m.len())?;

        let mut s = lower[idx..].trim_start();
        if s.is_empty() {
            return None;
        }

        let mut num_end = 0usize;
        for (i, ch) in s.char_indices() {
            if ch.is_ascii_digit() || ch == '.' {
                num_end = i + ch.len_utf8();
            } else {
                break;
            }
        }
        if num_end == 0 {
            return None;
        }

        let value = s[..num_end].parse::<f64>().ok()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        s = s[num_end..].trim_start();

        let unit = s
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| !c.is_ascii_alphabetic());

        let ms = match unit {
            "ms" | "msec" | "msecs" | "millisecond" | "milliseconds" => value,
            "s" | "sec" | "secs" | "second" | "seconds" => value * 1000.0,
            "m" | "min" | "mins" | "minute" | "minutes" => value * 60_000.0,
            _ => value * 1000.0, // 默认按秒
        };

        if ms.is_finite() && ms >= 0.0 {
            Some(ms as u64)
        } else {
            None
        }
    }

    fn is_retryable_error(err: &crate::ai_client::AiError, di: Option<&DebugInfoData>) -> bool {
        fn stream_retryable_hint(di: Option<&DebugInfoData>) -> Option<bool> {
            let body = di
                .and_then(|d| d.response.as_ref())
                .map(|r| &r.body)
                .and_then(|v| v.as_object())?;
            let summary = body.get("_streamErrorSummary")?.as_object()?;
            summary.get("retryable")?.as_bool()
        }

        use crate::ai_client::AiError;
        match err {
            AiError::ConnectionError(_) | AiError::StreamError(_) => {
                stream_retryable_hint(di).unwrap_or(true)
            }
            AiError::RateLimited(_) => true,
            AiError::RequestFailed(_) => status_from_debug(di).is_some_and(is_retryable_status),
            AiError::AuthenticationFailed(_) | AiError::InvalidResponse(_) => false,
        }
    }

    fn push_delta_tail(tail: &mut Vec<String>, delta: &str) {
        const MAX_ITEMS: usize = 16;
        const MAX_CHARS: usize = 240;

        if delta.is_empty() {
            return;
        }

        let mut out = String::new();
        let mut it = delta.chars();
        for _ in 0..MAX_CHARS {
            match it.next() {
                Some(ch) => out.push(ch),
                None => break,
            }
        }
        if it.next().is_some() {
            out.push('…');
        }

        tail.push(out);
        if tail.len() > MAX_ITEMS {
            let excess = tail.len() - MAX_ITEMS;
            tail.drain(0..excess);
        }
    }

    let messages = sanitize_messages_for_model_input(messages);

    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut debug_info: Option<DebugInfoData> = None;
    let mut usage: Option<TokenUsage> = None;
    let mut last_error: Option<String> = None;
    let mut tool_calls: Option<Vec<ToolCall>> = None;
    let mut emitted_any_delta = false;
    let mut turn_state: Option<String> = None;
    let mut include_usage_override: Option<bool> = None;

    for attempt in 1..=max_attempts {
        let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);
        // 默认按 “Done” 结束；DoneWithThinking/DoneWithDebug/EOF 会覆盖此值。
        let mut end_event: &'static str = "done";
        let mut token_chunk_count: u32 = 0;
        let mut thinking_chunk_count: u32 = 0;
        let mut web_search_event_count: u32 = 0;
        let mut tool_call_event_count: u32 = 0;
        let mut error_event_count: u32 = 0;
        let mut token_delta_tail: Vec<String> = Vec::new();
        let mut thinking_delta_tail: Vec<String> = Vec::new();

        // 请求级重试：本轮尚未产生任何增量输出，可以安全清空本地缓冲。
        // 流式重连：保留已输出内容，只清理本轮临时信息。
        if attempt > 1 {
            if !emitted_any_delta {
                full_content.clear();
                full_thinking.clear();
                debug_info = None;
                usage = None;
                last_error = None;
                tool_calls = None;
                // 注意：即使本轮还没吐任何 token，也可能已经拿到了 provider 的 TurnState（可用于幂等续流）。
                // 不清理 turn_state，避免下一次 attempt 不必要地重新创建请求。
            } else {
                debug_info = None;
                usage = None;
                last_error = None;
                tool_calls = None;
            }
        }

        let client = client.clone();
        let model_config_for_stream = model_config.clone();
        let resume_partial_output_enabled = model_config_for_stream.resume_partial_output;
        let tools = tools.clone();
        let attempt_messages = messages.clone();

        let options = crate::ai_client::StreamOptions {
            // 仅在显式开启「断流后继续」时才使用 TurnState 续流。
            // 关闭该开关时允许普通重试，但不会附带 resume_state。
            resume_state: if resume_partial_output_enabled {
                turn_state.clone()
            } else {
                None
            },
            include_usage: include_usage_override,
        };

        let stream_handle = tokio::spawn(async move {
            client
                .chat_stream(
                    attempt_messages,
                    &model_config_for_stream,
                    tools,
                    token_tx,
                    options,
                )
                .await
        });

        loop {
            tokio::select! {
                _ = abort_rx.recv() => {
                    stream_handle.abort();
                    return TurnStreamResult::Aborted { content: full_content, thinking: full_thinking };
                }
                event = token_rx.recv() => {
                    match event {
                        Some(StreamEvent::Token(token)) => {
                            token_chunk_count = token_chunk_count.saturating_add(1);
                            if !token.is_empty() {
                                emitted_any_delta = true;
                                push_delta_tail(&mut token_delta_tail, &token);
                                full_content.push_str(&token);
                                emitter.emit(RunEvent::BlockDelta {
                                    task_id: task_id.to_string(),
                                    turn_id: turn_id.to_string(),
                                    assistant_message_id: Some(assistant_message_id.to_string()),
                                    block_id: "assistant_text".to_string(),
                                    block_type: "text".to_string(),
                                    format: output_format.clone(),
                                    delta: token,
                                });
                            }
                        }
                        Some(StreamEvent::Thinking(token)) => {
                            thinking_chunk_count = thinking_chunk_count.saturating_add(1);
                            if !token.is_empty() {
                                emitted_any_delta = true;
                                push_delta_tail(&mut thinking_delta_tail, &token);
                                full_thinking.push_str(&token);
                                emitter.emit(RunEvent::BlockDelta {
                                    task_id: task_id.to_string(),
                                    turn_id: turn_id.to_string(),
                                    assistant_message_id: Some(assistant_message_id.to_string()),
                                    block_id: "assistant_thinking".to_string(),
                                    block_type: "thinking".to_string(),
                                    format: Some("plain".to_string()),
                                    delta: token,
                                });
                            }
                        }
                        Some(StreamEvent::WebSearch { id, status, action }) => {
                            emitted_any_delta = true;
                            web_search_event_count = web_search_event_count.saturating_add(1);
                            emitter.emit(RunEvent::BlockDelta {
                                task_id: task_id.to_string(),
                                turn_id: turn_id.to_string(),
                                assistant_message_id: Some(assistant_message_id.to_string()),
                                block_id: format!("web_search:{}", id),
                                block_type: "web_search".to_string(),
                                format: Some("json".to_string()),
                                delta: serde_json::json!({
                                    "id": id,
                                    "status": status,
                                    "action": action,
                                })
                                .to_string(),
                            });
                        }
                        Some(StreamEvent::TurnState(state)) => {
                            if resume_partial_output_enabled {
                                let trimmed = state.trim();
                                if !trimmed.is_empty() {
                                    turn_state = Some(trimmed.to_string());
                                }
                            }
                        }
                        Some(StreamEvent::ToolCalls(calls)) => {
                            emitted_any_delta = true;
                            tool_call_event_count = tool_call_event_count.saturating_add(1);
                            tool_calls = Some(calls);
                            // Tool call turn：不要立刻 break，继续等 DoneWithDebug（如果有的话）以便拿到 debug/usage
                        }
                        Some(StreamEvent::Done(content)) => {
                            if !emitted_any_delta && !content.is_empty() {
                                full_content = content;
                            }
                            break;
                        }
                        Some(StreamEvent::DoneWithThinking { content, thinking }) => {
                            end_event = "done_with_thinking";
                            if !emitted_any_delta && !content.is_empty() {
                                full_content = content;
                            }
                            if full_thinking.is_empty() && !thinking.is_empty() {
                                full_thinking = thinking;
                            }
                            break;
                        }
                        Some(StreamEvent::DoneWithDebug { content, thinking, debug_info: di, usage: u }) => {
                            end_event = "done_with_debug";
                            if !emitted_any_delta && !content.is_empty() {
                                full_content = content;
                            }
                            if full_thinking.is_empty() {
                                if let Some(t) = thinking {
                                    if !t.is_empty() {
                                        full_thinking = t;
                                    }
                                }
                            }
                            debug_info = di;
                            usage = u;
                            break;
                        }
                        Some(StreamEvent::Error(error)) => {
                            error_event_count = error_event_count.saturating_add(1);
                            last_error = Some(error);
                            // 不立刻 break：等待可能带 debug/usage 的 DoneWithDebug
                        }
                        None => {
                            end_event = "channel_closed";
                            break;
                        }
                    }
                }
            }
        }

        // 确保任务退出，并把“没有通过 StreamEvent::Error 上报的错误”补齐（否则会被误判为成功结束）
        let mut stream_result: Result<(), crate::ai_client::AiError> = match stream_handle.await {
            Ok(v) => v,
            Err(e) => Err(crate::ai_client::AiError::StreamError(e.to_string())),
        };

        if let Some(calls) = tool_calls.take() {
            return TurnStreamResult::ToolCalls {
                content: full_content,
                thinking: full_thinking,
                tool_calls: calls,
                debug_info,
                usage,
            };
        }

        // 重要：如果流“正常结束”但没有任何可见输出（也没有工具调用/错误），不要当作成功。
        //
        // 现象（用户反馈）：
        // - Observe 阶段喂回工具结果后，模型可能直接结束流，但没有吐字（content 为空）。
        // - 旧逻辑会返回 TurnStreamResult::Final(content="")，进而被上层当作 TaskOutcome::Success，
        //   导致前端“无消息、无错误”。
        if stream_result.is_ok() && last_error.is_none() && full_content.trim().is_empty() {
            if usage.as_ref().is_some_and(|u| u.completion_tokens > 0) {
                // 某些 OpenAI-compatible 网关在 `stream_options.include_usage=true` 时会出现
                // “有 usage 但正文 delta 为空”的兼容性问题；重试时禁用 include_usage 以提高成功率。
                include_usage_override = Some(false);
            }

            let origin_module = match model_config.provider.as_str() {
                "openai" | "openai_compatible" => "ai_client/openai".to_string(),
                "openai_responses" => "ai_client/openai_responses".to_string(),
                "anthropic" => "ai_client/anthropic".to_string(),
                "google" => "ai_client/google".to_string(),
                "ollama" => "ai_client/ollama".to_string(),
                other => format!("ai_client/{other}"),
            };
            let origin = crate::ai_client::ErrorOrigin {
                layer: crate::ai_client::ErrorLayer::Content,
                module: origin_module,
                operation: Some("turn_stream:empty_content".to_string()),
            };

            if let Some(di) = debug_info.as_mut() {
                if di.error_origin.is_none() {
                    di.error_origin = Some(origin.clone());
                }
            } else {
                debug_info = Some(DebugInfoData {
                    request: None,
                    response: None,
                    stream_termination: None,
                    error_origin: Some(origin),
                });
            }

            let mut lines: Vec<String> = Vec::new();
            lines.push("模型流结束但未解析到任何可见输出（token/tool_calls）".to_string());
            lines.push("".to_string());
            lines.push("上下文：".to_string());
            lines.push(format!("- provider: {}", model_config.provider));
            lines.push(format!("- model: {}", model_config.model));
            lines.push(format!(
                "- output_format: {}",
                output_format.as_deref().unwrap_or("markdown")
            ));
            lines.push(format!("- task_id: {task_id}"));
            lines.push(format!("- turn_id: {turn_id}"));
            lines.push(format!("- assistant_message_id: {assistant_message_id}"));
            lines.push(format!("- attempt: {attempt}/{max_attempts}"));
            lines.push(format!("- runtime_end_event: {end_event}（本地）"));
            lines.push(format!("- emitted_any_delta: {emitted_any_delta}"));
            lines.push(format!("- turn_state_present: {}", turn_state.is_some()));
            lines.push(format!(
                "- chunks: token={token_chunk_count}, thinking={thinking_chunk_count}, web_search={web_search_event_count}, tool_calls={tool_call_event_count}, errors={error_event_count}"
            ));

            if let Some(term) = debug_info
                .as_ref()
                .and_then(|d| d.stream_termination.as_ref())
            {
                let mut term_lines: Vec<String> = Vec::new();
                if let Some(v) = term.protocol_complete {
                    term_lines.push(format!("protocol_complete={v}"));
                }
                if let Some(v) = term.termination_source.as_ref() {
                    term_lines.push(format!("termination_source={v:?}"));
                }
                if let Some(v) = term.protocol_kind.as_deref() {
                    term_lines.push(format!("protocol_kind={v}"));
                }
                term_lines.push(format!(
                    "expected_signal={}",
                    term.expected_signal.as_deref().unwrap_or("<none>")
                ));
                term_lines.push(format!(
                    "observed_signal={}",
                    term.observed_signal.as_deref().unwrap_or("<none>")
                ));
                if let Some(v) = term.last_event_type.as_deref() {
                    term_lines.push(format!("last_event_type={v}"));
                }
                if let Some(v) = term.chunk_count {
                    term_lines.push(format!("chunk_count={v}"));
                }
                if let Some(v) = term.event_count {
                    term_lines.push(format!("event_count={v}"));
                }
                if !term_lines.is_empty() {
                    lines.push("".to_string());
                    lines.push(format!("- stream_termination: {}", term_lines.join(", ")));
                }

                if let (Some(true), Some(obs)) =
                    (term.protocol_complete, term.observed_signal.as_deref())
                {
                    if let Some(raw_tail) = term.raw_event_tail.as_ref().filter(|t| !t.is_empty()) {
                        let observed_raw: Option<String> = if obs.trim() == "[DONE]" {
                            raw_tail
                                .iter()
                                .rev()
                                .find(|l| l.trim() == "[DONE]")
                                .cloned()
                        } else {
                            let needle = format!("\"type\":\"{obs}\"");
                            raw_tail.iter().rev().find(|l| l.contains(&needle)).cloned()
                        };
                        if let Some(line) = observed_raw {
                            lines.push(format!("- observed_signal_raw: {}", line));
                        }
                    }
                }

                if let Some(raw_tail) = term.raw_event_tail.as_ref().filter(|t| !t.is_empty()) {
                    let sample: Vec<String> = raw_tail
                        .iter()
                        .rev()
                        .take(6)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    lines.push(format!("- raw_event_tail_count: {}", raw_tail.len()));
                    lines.push("- raw_event_tail_last:".to_string());
                    for line in sample {
                        lines.push(format!("  - {line}"));
                    }
                }

                if term.protocol_complete == Some(false)
                    && term.observed_signal.as_deref().unwrap_or("").is_empty()
                    && matches!(end_event, "done" | "done_with_thinking" | "done_with_debug")
                {
                    lines.push("".to_string());
                    lines.push(
                        "说明：runtime_end_event 是本地结束事件；协议层是否发送了 response.completed/response.done/[DONE] 请以 stream_termination.protocol_complete/observed_signal 为准。".to_string()
                    );
                }
            }

            // Best-effort hints: we saw protocol payloads, but none were parsed into visible deltas.
            if let Some(raw_tail) = debug_info
                .as_ref()
                .and_then(|d| d.stream_termination.as_ref())
                .and_then(|t| t.raw_event_tail.as_ref())
                .filter(|t| !t.is_empty())
            {
                let has_tool_calls = raw_tail.iter().any(|l| l.contains("\"tool_calls\""));
                let has_function_call = raw_tail
                    .iter()
                    .any(|l| l.contains("\"function_call\"") || l.contains("\"functionCall\""));
                let has_content = raw_tail.iter().any(|l| l.contains("\"content\""));

                let mut hints: Vec<String> = Vec::new();
                if (has_tool_calls || has_function_call) && tool_call_event_count == 0 {
                    hints.push(
                        "流里疑似包含工具调用字段，但解析层未产出 tool_calls 事件；通常是网关的流式字段不兼容或解析未覆盖导致。"
                            .to_string(),
                    );
                }
                if !has_tool_calls
                    && !has_function_call
                    && !has_content
                    && token_chunk_count == 0
                    && thinking_chunk_count == 0
                    && error_event_count == 0
                {
                    hints.push(
                        "流里可能只有 role/usage/心跳等元数据，没有 content；也可能被网关截断/过滤。"
                            .to_string(),
                    );
                }

                if !hints.is_empty() {
                    lines.push("".to_string());
                    lines.push("可能原因：".to_string());
                    for hint in hints {
                        lines.push(format!("- {hint}"));
                    }
                }
            }

            if !token_delta_tail.is_empty() || !thinking_delta_tail.is_empty() {
                lines.push("".to_string());
                lines.push("收到的增量（尾部，已截断）：".to_string());
                if !token_delta_tail.is_empty() {
                    lines.push(format!(
                        "- token_delta_tail: {}",
                        serde_json::to_string(&token_delta_tail)
                            .unwrap_or_else(|_| "[]".to_string())
                    ));
                }
                if !thinking_delta_tail.is_empty() {
                    lines.push(format!(
                        "- thinking_delta_tail: {}",
                        serde_json::to_string(&thinking_delta_tail)
                            .unwrap_or_else(|_| "[]".to_string())
                    ));
                }
            }

            stream_result = Err(crate::ai_client::AiError::StreamError(lines.join("\n")));
        }

        if let Err(stream_err) = stream_result {
            if last_error.is_none() {
                last_error = Some(stream_err.to_string());
            }

            let reconnecting = emitted_any_delta;
            let resume_possible = turn_state.is_some();
            let no_visible_output_yet = full_content.trim().is_empty();
            let can_reconnect_after_partial_output =
                emitted_any_delta && resume_possible && resume_partial_output_enabled;
            // 特殊兜底：只要「还没产生任何可见输出」（token 输出为空/仅空白），
            // 允许继续重试；当 resume_partial_output 关闭时，这里走的是“普通重试”（不带 resume_state）。
            //
            // 典型场景：流里只吐了 thinking / 状态事件（或响应被网关截断），最终没有任何输出文本。
            // 这种情况下重试不会造成“重复可见内容”。
            let can_reconnect_after_no_visible_output = emitted_any_delta && no_visible_output_yet;
            let can_reconnect =
                can_reconnect_after_partial_output || can_reconnect_after_no_visible_output;
            let can_retry = attempt < max_attempts
                && is_retryable_error(&stream_err, debug_info.as_ref())
                && (!emitted_any_delta || can_reconnect);

            if can_retry {
                let shift = attempt.saturating_sub(1).min(30);
                let exp = 1u64 << shift;
                let mut delay_ms = BASE_DELAY_MS.saturating_mul(exp);
                if let Some(hint) = retry_after_ms(debug_info.as_ref()) {
                    delay_ms = delay_ms.max(hint);
                }
                if let Some(hint) = last_error.as_deref().and_then(retry_after_ms_from_message) {
                    delay_ms = delay_ms.max(hint);
                }
                delay_ms = delay_ms.min(MAX_DELAY_MS);

                // 对齐 Codex：提供类似 “Reconnecting... x/y” 的可见提示（同时保留现有 Debug 逻辑）
                let prefix = if reconnecting {
                    "重连中"
                } else {
                    "重试中"
                };
                // 注意：attempt 是当前“已发生失败”的次数（1-based）。
                // 这里展示 attempt/max_attempts，让第一次失败也能显示 1/N，避免从 2/N 开始跳号。
                emitter.emit(RunEvent::BlockDelta {
                    task_id: task_id.to_string(),
                    turn_id: turn_id.to_string(),
                    assistant_message_id: Some(assistant_message_id.to_string()),
                    block_id: format!("assistant_status:{attempt}"),
                    block_type: "status".to_string(),
                    format: Some("plain".to_string()),
                    delta: format!("{prefix}... {attempt}/{max_attempts}（等待 {delay_ms}ms）\n"),
                });

                // 避免把“上一轮错误”带到最终返回
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                continue;
            }
        }

        if let Some(error) = last_error {
            return TurnStreamResult::Error {
                content: full_content,
                thinking: full_thinking,
                error,
                debug_info,
                usage,
            };
        }

        return TurnStreamResult::Final {
            content: full_content,
            thinking: full_thinking,
            debug_info,
            usage,
        };
    }

    // 理论不可达（for loop 已 return）；兜底返回错误避免编译器误判。
    TurnStreamResult::Error {
        content: String::new(),
        thinking: String::new(),
        error: "Turn stream failed after retries".to_string(),
        debug_info: None,
        usage: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NoopEmitter;

    impl TurnEventEmitter for NoopEmitter {
        fn emit(&mut self, _event: RunEvent) {}
    }

    struct AlwaysFailClient;

    #[async_trait]
    impl crate::ai_client::AiClient for AlwaysFailClient {
        async fn chat(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Err(crate::ai_client::AiError::ConnectionError(
                "boom".to_string(),
            ))
        }

        async fn chat_stream(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            _token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            _options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            // 故意不发送任何 StreamEvent，直接返回错误。
            // 修复前：stream_one_turn 会把这种情况当作“成功完成但内容为空”（因为忽略了 JoinHandle 里的 Err）。
            Err(crate::ai_client::AiError::ConnectionError(
                "boom".to_string(),
            ))
        }
    }

    struct FlakyClient {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl crate::ai_client::AiClient for FlakyClient {
        async fn chat(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Ok("ok".to_string())
        }

        async fn chat_stream(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            _options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                // 第一次：模拟连接错误（不发事件）
                return Err(crate::ai_client::AiError::ConnectionError(
                    "boom".to_string(),
                ));
            }
            // 第二次：返回完整内容
            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Done("hello".to_string()))
                .await;
            Ok(())
        }
    }

    fn test_model_config() -> crate::models::ModelConfig {
        crate::models::ModelConfig {
            id: "test".to_string(),
            name: "test".to_string(),
            provider: "openai".to_string(),
            api_base: Some("http://127.0.0.1:0".to_string()),
            api_key: Some("test".to_string()),
            model: "test".to_string(),
            parameters: crate::models::ModelParameters::default(),
            thinking_level: None,
            thinking_budget_tokens: None,
            vision_enabled: false,
            web_search_enabled: false,
            max_images: None,
            use_reasoning_effort: None,
            force_responses_reasoning: false,
            seasun_thinking: false,
            retry_attempts: None,
            resume_partial_output: false,
            stream_include_usage: true,
            debug_sse: false,
            reinject_reasoning_content: false,
        }
    }

    fn test_user_message() -> crate::models::Message {
        crate::models::Message {
            id: "m1".to_string(),
            conversation_id: "c1".to_string(),
            role: crate::models::MessageRole::User,
            content: "hi".to_string(),
            content_parts: vec![],
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_surface_client_error_even_without_events() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(AlwaysFailClient);
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let result = stream_one_turn(
            client,
            test_model_config(),
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            3,
        )
        .await;

        match result {
            TurnStreamResult::Error { error, .. } => {
                assert!(
                    error.contains("Connection error"),
                    "unexpected error: {error}"
                );
            }
            other => panic!("expected TurnStreamResult::Error, got: {other:?}"),
        }
    }

    #[test]
    fn redact_debug_url_masks_sensitive_query_params() {
        let url = "https://generativelanguage.googleapis.com/v1beta/models/demo:streamGenerateContent?alt=sse&key=SECRET&foo=bar";
        let redacted = redact_debug_url(url);
        assert!(redacted.contains("alt=sse"));
        assert!(redacted.contains("foo=bar"));
        assert!(redacted.contains("key=***"));
        assert!(!redacted.contains("SECRET"));
    }

    struct EmptyOkClient;

    #[async_trait]
    impl crate::ai_client::AiClient for EmptyOkClient {
        async fn chat(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Ok("ok".to_string())
        }

        async fn chat_stream(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            _token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            _options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            // 故意不发送任何事件，直接返回 Ok()，模拟“流结束但无内容”的异常兜底场景。
            Ok(())
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_include_context_for_empty_stream() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(EmptyOkClient);
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let result = stream_one_turn(
            client,
            test_model_config(),
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            1,
        )
        .await;

        match result {
            TurnStreamResult::Error { error, .. } => {
                assert!(
                    error.contains("模型流结束但未解析到任何可见输出"),
                    "unexpected error: {error}"
                );
                assert!(error.contains("上下文"), "missing context: {error}");
                assert!(error.contains("provider"), "missing provider: {error}");
                assert!(error.contains("model"), "missing model: {error}");
                assert!(
                    error.contains("end_event: channel_closed"),
                    "missing end_event: {error}"
                );
            }
            other => panic!("expected TurnStreamResult::Error, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_retry_connection_error_before_any_output() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(FlakyClient {
            calls: AtomicUsize::new(0),
        });
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let result = stream_one_turn(
            client,
            test_model_config(),
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            3,
        )
        .await;

        match result {
            TurnStreamResult::Final { content, .. } => {
                assert_eq!(content, "hello");
            }
            other => panic!("expected TurnStreamResult::Final, got: {other:?}"),
        }
    }

    struct EmptyDeltaThenOkClient {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl crate::ai_client::AiClient for EmptyDeltaThenOkClient {
        async fn chat(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Ok("ok".to_string())
        }

        async fn chat_stream(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                // First attempt: default include_usage (runtime may flip it on retry after empty stream).
                assert_eq!(options.include_usage, None);

                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::Token(String::new()))
                    .await;
                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::DoneWithDebug {
                        content: String::new(),
                        thinking: None,
                        debug_info: None,
                        usage: Some(crate::ai_client::TokenUsage {
                            prompt_tokens: 1,
                            completion_tokens: 33,
                            total_tokens: 34,
                            ..Default::default()
                        }),
                    })
                    .await;
                return Ok(());
            }

            // Second attempt: runtime should disable include_usage to avoid usage-only streams on some gateways.
            assert_eq!(options.include_usage, Some(false));

            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Token("ok".to_string()))
                .await;
            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Done("ok".to_string()))
                .await;
            Ok(())
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_retry_when_only_empty_token_emitted() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(EmptyDeltaThenOkClient {
            calls: AtomicUsize::new(0),
        });
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let result = stream_one_turn(
            client,
            test_model_config(),
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            2,
        )
        .await;

        match result {
            TurnStreamResult::Final { content, .. } => assert_eq!(content, "ok"),
            other => panic!("expected TurnStreamResult::Final, got: {other:?}"),
        }
    }

    struct ResumeAfterPartialClient {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl crate::ai_client::AiClient for ResumeAfterPartialClient {
        async fn chat(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Ok("ok".to_string())
        }

        async fn chat_stream(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::TurnState(
                        "state1".to_string(),
                    ))
                    .await;
                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::Token("he".to_string()))
                    .await;
                return Err(crate::ai_client::AiError::ConnectionError(
                    "boom".to_string(),
                ));
            }

            assert_eq!(options.resume_state.as_deref(), Some("state1"));
            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Token("llo".to_string()))
                .await;
            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Done("hello".to_string()))
                .await;
            Ok(())
        }
    }

    #[tokio::test]
    async fn stream_one_turn_can_resume_after_partial_output_when_enabled() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(ResumeAfterPartialClient {
            calls: AtomicUsize::new(0),
        });
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let mut config = test_model_config();
        config.resume_partial_output = true;

        let result = stream_one_turn(
            client,
            config,
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            2,
        )
        .await;

        match result {
            TurnStreamResult::Final { content, .. } => assert_eq!(content, "hello"),
            other => panic!("expected TurnStreamResult::Final, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_not_resume_after_partial_output_when_disabled() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(ResumeAfterPartialClient {
            calls: AtomicUsize::new(0),
        });
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let mut config = test_model_config();
        config.resume_partial_output = false;

        let result = stream_one_turn(
            client,
            config,
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            2,
        )
        .await;

        match result {
            TurnStreamResult::Error { content, .. } => assert_eq!(content, "he"),
            other => panic!("expected TurnStreamResult::Error, got: {other:?}"),
        }
    }

    struct ResumeAfterThinkingOnlyClient {
        calls: AtomicUsize,
        expect_resume: bool,
    }

    #[async_trait]
    impl crate::ai_client::AiClient for ResumeAfterThinkingOnlyClient {
        async fn chat(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Ok("ok".to_string())
        }

        async fn chat_stream(
            &self,
            _messages: Vec<crate::models::Message>,
            _config: &crate::models::ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                assert!(options.resume_state.is_none());
                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::TurnState(
                        "state1".to_string(),
                    ))
                    .await;
                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::Thinking(
                        "thinking".to_string(),
                    ))
                    .await;
                let _ = token_sender
                    .send(crate::ai_client::StreamEvent::DoneWithDebug {
                        content: String::new(),
                        thinking: None,
                        debug_info: None,
                        usage: None,
                    })
                    .await;
                return Ok(());
            }

            if self.expect_resume {
                assert_eq!(options.resume_state.as_deref(), Some("state1"));
            } else {
                assert!(options.resume_state.is_none());
            }
            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Token("ok".to_string()))
                .await;
            let _ = token_sender
                .send(crate::ai_client::StreamEvent::Done("ok".to_string()))
                .await;
            Ok(())
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_retry_with_resume_when_no_visible_output_enabled() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(ResumeAfterThinkingOnlyClient {
            calls: AtomicUsize::new(0),
            expect_resume: true,
        });
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let mut config = test_model_config();
        config.resume_partial_output = true;

        let result = stream_one_turn(
            client,
            config,
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            2,
        )
        .await;

        match result {
            TurnStreamResult::Final { content, .. } => assert_eq!(content, "ok"),
            other => panic!("expected TurnStreamResult::Final, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_one_turn_should_retry_without_resume_when_no_visible_output_disabled() {
        let client: Arc<dyn crate::ai_client::AiClient> = Arc::new(ResumeAfterThinkingOnlyClient {
            calls: AtomicUsize::new(0),
            expect_resume: false,
        });
        let mut emitter = NoopEmitter;
        let (abort_tx, mut abort_rx) = mpsc::channel(1);
        let _keep_abort = abort_tx;

        let mut config = test_model_config();
        config.resume_partial_output = false;

        let result = stream_one_turn(
            client,
            config,
            None,
            vec![test_user_message()],
            &mut emitter,
            "task",
            "turn",
            "assistant",
            None,
            &mut abort_rx,
            2,
        )
        .await;

        match result {
            TurnStreamResult::Final { content, .. } => assert_eq!(content, "ok"),
            other => panic!("expected TurnStreamResult::Final, got: {other:?}"),
        }
    }

    #[test]
    fn expand_persisted_blocks_should_fill_missing_tool_results() {
        let assistant = crate::models::Message {
            id: "a1".to_string(),
            conversation_id: "c1".to_string(),
            role: crate::models::MessageRole::Assistant,
            content: "".to_string(),
            content_parts: vec![],
            thinking: None,
            meta: Some(crate::models::MessageMeta {
                blocks: Some(vec![crate::models::MessageBlock::ToolCall {
                    id: "t1:tool_call:call_1".to_string(),
                    turn_id: Some("t1".to_string()),
                    turn_index: Some(1),
                    call_id: "call_1".to_string(),
                    name: "read_file".to_string(),
                    arguments: "{\"file_path\":\"requirements.txt\"}".to_string(),
                    meta: None,
                }]),
                ..Default::default()
            }),
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let out = expand_persisted_blocks_for_model_input(vec![assistant]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].role, crate::models::MessageRole::Assistant);
        let tool_calls = out[0]
            .meta
            .as_ref()
            .and_then(|m| m.tool_calls.as_ref())
            .expect("missing tool_calls");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_1");

        assert_eq!(out[1].role, crate::models::MessageRole::Tool);
        assert_eq!(
            out[1].meta.as_ref().and_then(|m| m.tool_call_id.as_deref()),
            Some("call_1")
        );
        assert!(
            out[1].content.contains("TOOL_RESULT_MISSING"),
            "unexpected tool content: {}",
            out[1].content
        );
    }

    #[test]
    fn expand_persisted_blocks_should_preserve_tool_call_order() {
        let assistant = crate::models::Message {
            id: "a1".to_string(),
            conversation_id: "c1".to_string(),
            role: crate::models::MessageRole::Assistant,
            content: "".to_string(),
            content_parts: vec![],
            thinking: None,
            meta: Some(crate::models::MessageMeta {
                blocks: Some(vec![
                    crate::models::MessageBlock::ToolCall {
                        id: "t1:tool_call:call_1".to_string(),
                        turn_id: Some("t1".to_string()),
                        turn_index: Some(1),
                        call_id: "call_1".to_string(),
                        name: "read_file".to_string(),
                        arguments: "{}".to_string(),
                        meta: None,
                    },
                    crate::models::MessageBlock::ToolCall {
                        id: "t1:tool_call:call_2".to_string(),
                        turn_id: Some("t1".to_string()),
                        turn_index: Some(1),
                        call_id: "call_2".to_string(),
                        name: "shell_command".to_string(),
                        arguments: "{}".to_string(),
                        meta: None,
                    },
                    crate::models::MessageBlock::ToolResult {
                        id: "t1:tool_result:call_2".to_string(),
                        turn_id: Some("t1".to_string()),
                        turn_index: Some(1),
                        call_id: "call_2".to_string(),
                        text: "ok".to_string(),
                    },
                ]),
                ..Default::default()
            }),
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let out = expand_persisted_blocks_for_model_input(vec![assistant]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].role, crate::models::MessageRole::Assistant);

        assert_eq!(out[1].role, crate::models::MessageRole::Tool);
        assert_eq!(
            out[1].meta.as_ref().and_then(|m| m.tool_call_id.as_deref()),
            Some("call_1")
        );
        assert!(out[1].content.contains("TOOL_RESULT_MISSING"));

        assert_eq!(out[2].role, crate::models::MessageRole::Tool);
        assert_eq!(
            out[2].meta.as_ref().and_then(|m| m.tool_call_id.as_deref()),
            Some("call_2")
        );
        assert_eq!(out[2].content, "ok");
    }

    #[test]
    fn expand_persisted_blocks_should_preserve_tool_call_thought_signature() {
        let assistant = crate::models::Message {
            id: "a2".to_string(),
            conversation_id: "c1".to_string(),
            role: crate::models::MessageRole::Assistant,
            content: "".to_string(),
            content_parts: vec![],
            thinking: None,
            meta: Some(crate::models::MessageMeta {
                blocks: Some(vec![
                    crate::models::MessageBlock::ToolCall {
                        id: "t1:tool_call:call_sig".to_string(),
                        turn_id: Some("t1".to_string()),
                        turn_index: Some(1),
                        call_id: "call_sig".to_string(),
                        name: "shell_command".to_string(),
                        arguments: "{\"command\":\"pwd\"}".to_string(),
                        meta: Some(serde_json::json!({
                            "thought_signature": "sig_abc123"
                        })),
                    },
                    crate::models::MessageBlock::ToolResult {
                        id: "t1:tool_result:call_sig".to_string(),
                        turn_id: Some("t1".to_string()),
                        turn_index: Some(1),
                        call_id: "call_sig".to_string(),
                        text: "ok".to_string(),
                    },
                ]),
                ..Default::default()
            }),
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        let out = expand_persisted_blocks_for_model_input(vec![assistant]);
        assert_eq!(out.len(), 2);
        let calls = out[0]
            .meta
            .as_ref()
            .and_then(|m| m.tool_calls.as_ref())
            .expect("missing tool calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].thought_signature.as_deref(),
            Some("sig_abc123"),
            "thought signature should survive block expansion"
        );
    }
}
