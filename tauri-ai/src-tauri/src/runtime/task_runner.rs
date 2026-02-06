//! TaskRunner：把「一次用户请求」运行成统一事件流（`run:event`）。
//!
//! 目标：
//! - `commands/run.rs` 只负责 Tauri 参数接入
//! - 运行时抽象集中在这里：Task / Turn / ReAct（Think → Act → Observe）
//! - Chat = 最简单的 Task（通常单 Turn）
//! - Tool = 多 Turn 循环（后续可扩展）

use std::collections::{HashMap, HashSet};
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
    APPLY_PATCH_TOOL_PROMPT, MCP_RESOURCE_TOOL_PROMPT, PERSISTENT_PROCESS_PROMPT,
    PYTHON3_FALLBACK_PROMPT, WEB_SEARCH_TOOL_PROMPT, WORKSTUDIO_PROMPT_GUIDE,
};
use crate::runtime::context_manager::{
    auto_compact_threshold_tokens, estimate_prompt_tokens, hard_limit_tokens, run_normal_compact,
    trim_runtime_messages_to_hard_limit, ContextManager,
};
use crate::runtime::events::RunEvent;
use crate::runtime::mcp::global_mcp_runtime;
use crate::runtime::types::{TaskKind, TurnPhase, TurnStatus};
use crate::skills::loader::{
    index_by_name as index_skills_by_name, load_skills as load_skill_files,
};
use crate::skills::SkillEntry;
use crate::storage::Database;
use crate::workstudio_security::read_workstudio_security_config;

use super::approvals::ApprovalDecision;
use super::emitter::RunEmitter;
use super::run_state::RunState;
use super::tools::registry::{register_builtin_handlers, ToolRegistry};
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

/// TurnLoop：把 run_task 内部「按 Turn 迭代」的零碎逻辑集中到一个结构里，保持 run_task 干净。
struct TurnLoop<'a> {
    client: Arc<dyn crate::ai_client::AiClient>,
    model_config: crate::models::ModelConfig,
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
    enable_local_web_search_tool: bool,
    enable_mcp_resource_tool_prompt: bool,
    enabled_skills: &[SkillEntry],
    py: PythonAvailability,
) -> String {
    use std::fmt::Write as _;

    let mut h = Sha1::new();
    // NOTE: Cache key must include any prompt text that can affect the actual HTTP request.
    // Bump this version whenever the cache inputs change.
    h.update(b"v5\n");
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
    h.update(format!("py:{}/{}\n", py.has_python, py.has_python3).as_bytes());
    h.update(format!("local_web_search:{enable_local_web_search_tool}\n").as_bytes());
    h.update(format!("mcp_resource_prompt:{enable_mcp_resource_tool_prompt}\n").as_bytes());

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

fn render_skills_section(skills: &[SkillEntry]) -> Option<String> {
    if skills.is_empty() {
        return None;
    }

    // Align with Codex: always provide "Available skills" + "How to use skills" section,
    // and only inject SKILL.md bodies when the user explicitly mentions a skill.
    let mut lines: Vec<String> = Vec::new();
    lines.push("## Skills".to_string());
    lines.push("A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.".to_string());
    lines.push("### Available skills".to_string());
    for skill in skills {
        let path_str = skill.meta.path.replace('\\', "/");
        lines.push(format!(
            "- {name}: {description} (file: {path_str})",
            name = skill.meta.name,
            description = skill.meta.description
        ));
    }
    lines.push("### How to use skills".to_string());
    lines.push("- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.".to_string());
    lines.push("- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.".to_string());
    lines.push("- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.".to_string());
    lines.push("- How to use a skill (progressive disclosure):".to_string());
    lines.push("  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.".to_string());
    lines.push("  2) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.".to_string());
    lines.push("  3) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.".to_string());
    lines.push(
        "  4) If `assets/` or templates exist, reuse them instead of recreating from scratch."
            .to_string(),
    );
    lines.push("- Coordination and sequencing:".to_string());
    lines.push("  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.".to_string());
    lines.push("  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.".to_string());
    lines.push("- Context hygiene:".to_string());
    lines.push("  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.".to_string());
    lines.push("  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.".to_string());
    lines.push("  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.".to_string());
    lines.push("- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.".to_string());

    Some(lines.join("\n"))
}

fn find_skill_mentions(text: &str, skills: &[SkillEntry]) -> Vec<SkillEntry> {
    // Mirror Codex TUI: only consider "$skill-name" explicit mentions.
    let mut seen: HashSet<String> = HashSet::new();
    let mut matches: Vec<SkillEntry> = Vec::new();
    for skill in skills {
        if seen.contains(&skill.meta.name) {
            continue;
        }
        let needle = format!("${}", skill.meta.name);
        if text.contains(&needle) {
            seen.insert(skill.meta.name.clone());
            matches.push(skill.clone());
        }
    }
    matches
}

fn build_skill_prompt_block(skills: &[SkillEntry]) -> String {
    let mut out = String::new();
    for s in skills {
        out.push_str("<skill>\n");
        out.push_str("<name>");
        out.push_str(&s.meta.name);
        out.push_str("</name>\n");
        out.push_str("<path>");
        out.push_str(&s.meta.path);
        out.push_str("</path>\n");
        out.push_str(&s.contents);
        if !s.contents.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("</skill>\n\n");
    }
    out
}

fn inject_skills_prompt(
    messages: &mut Vec<Message>,
    conversation_id: &str,
    skills: Vec<SkillEntry>,
) {
    if skills.is_empty() {
        return;
    }
    let content = build_skill_prompt_block(&skills);
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
        matches!(tool_name, "apply_patch")
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
                    let turn_usage = if self.debug_mode { usage.clone() } else { None };
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
                        model: Some(self.model_config.model.clone()),
                    });

                    return TaskOutcome::Success {
                        last_turn_id: turn_id,
                        content,
                        thinking,
                        debug_info: if self.debug_mode { debug_info } else { None },
                        usage: if self.debug_mode { usage } else { None },
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
                    let turn_usage = if self.debug_mode { usage } else { None };
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
                        });

                        normalized_calls.push(call);
                    }

                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Act,
                    });

                    if let Some(error) = max_turns_error {
                        let mut reply_content = content.clone();
                        if reply_content.trim().is_empty() {
                            reply_content = build_fallback_reply_markdown(
                                "任务失败",
                                &error,
                                turn_debug_info.as_ref(),
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
                        }

                        self.emitter.emit(RunEvent::BlockDelta {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            block_id: "assistant_error".to_string(),
                            block_type: "error".to_string(),
                            format: Some("plain".to_string()),
                            delta: error.clone(),
                        });
                        blocks.push(MessageBlock::Error {
                            id: format!("{turn_id}:assistant_error"),
                            turn_id: Some(turn_id.clone()),
                            turn_index: Some(turn_index),
                            text: error.clone(),
                        });

                        self.emitter.emit(RunEvent::TurnFinished {
                            task_id: self.task_id.clone(),
                            turn_id: turn_id.clone(),
                            status: TurnStatus::Failed,
                            turn_index: Some(turn_index),
                            assistant_message_id: Some(self.assistant_message_id.clone()),
                            debug_info: turn_debug_info.clone(),
                            usage: turn_usage.clone(),
                            model: Some(self.model_config.model.clone()),
                        });

                        turns.push(MessageTurn {
                            turn_id: turn_id.clone(),
                            turn_index,
                            status: Some(TurnStatus::Failed),
                            has_debug_info: None,
                            debug_info: persisted_debug_info.clone(),
                            usage: persisted_usage,
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

                        let result = match exec {
                            Ok(v) => v.content,
                            Err(e) => {
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
                            turn_debug_info.as_ref(),
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
                            model: Some(self.model_config.model.clone()),
                        });
                        turns.push(MessageTurn {
                            turn_id: turn_id.clone(),
                            turn_index,
                            status: Some(TurnStatus::Aborted),
                            has_debug_info: None,
                            debug_info: persisted_debug_info.clone(),
                            usage: persisted_usage,
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
                    let reply_content = if content.trim().is_empty() {
                        build_fallback_reply_markdown("任务失败", &error, debug_info.as_ref())
                    } else {
                        content.clone()
                    };

                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Think,
                    });

                    let persisted_usage = usage.clone();
                    let turn_debug_info = if self.debug_mode {
                        debug_info.clone()
                    } else {
                        None
                    };
                    let turn_usage = if self.debug_mode { usage } else { None };
                    let persisted_debug_info =
                        turn_debug_info.as_ref().map(redact_debug_info_for_store);

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
                        delta: error.clone(),
                    });
                    blocks.push(MessageBlock::Error {
                        id: format!("{turn_id}:assistant_error"),
                        turn_id: Some(turn_id.clone()),
                        turn_index: Some(turn_index),
                        text: error.clone(),
                    });

                    self.emitter.emit(RunEvent::TurnFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        status: TurnStatus::Failed,
                        turn_index: Some(turn_index),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        debug_info: turn_debug_info.clone(),
                        usage: turn_usage,
                        model: Some(self.model_config.model.clone()),
                    });

                    turns.push(MessageTurn {
                        turn_id: turn_id.clone(),
                        turn_index,
                        status: Some(TurnStatus::Failed),
                        has_debug_info: None,
                        debug_info: persisted_debug_info,
                        usage: persisted_usage,
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
                        model: Some(self.model_config.model.clone()),
                    });
                    let reply_content = if content.trim().is_empty() && thinking.trim().is_empty() {
                        build_fallback_reply_markdown(
                            "任务已中止",
                            "运行已被用户或系统中止。\n\n你可以点击“重试”或重新发送消息继续。",
                            None,
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
            turn_id: Option<String>,
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
                turn_id: turn_id.clone(),
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
                    turn_id,
                    turn_index,
                    ..
                } => {
                    let idx = get_bundle_index(&mut bundles, &mut idx_by_key, turn_id, turn_index);
                    bundles[idx].tool_calls.push(ToolCall {
                        id: call_id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
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
            url: req.url.clone(),
            method: req.method.clone(),
            headers: redact_debug_headers(&req.headers),
            body: req.body.clone(),
        }),
        response: debug_info.response.as_ref().map(|resp| DebugResponseData {
            status: resp.status,
            headers: redact_debug_headers(&resp.headers),
            body: resp.body.clone(),
        }),
    }
}

fn format_debug_info_for_reply(debug_info: &DebugInfoData) -> String {
    let redacted = redact_debug_info_for_store(debug_info);
    serde_json::to_string_pretty(&redacted).unwrap_or_else(|_| "{}".to_string())
}

fn build_fallback_reply_markdown(
    title: &str,
    message: &str,
    debug_info: Option<&DebugInfoData>,
) -> String {
    let mut out = String::new();
    out.push_str("### ");
    out.push_str(title);
    out.push_str("\n\n");
    out.push_str(message.trim());
    out.push('\n');

    if let Some(di) = debug_info {
        out.push_str("\n<details><summary>Debug（请求/响应，已脱敏）</summary>\n\n```json\n");
        out.push_str(&format_debug_info_for_reply(di));
        out.push_str("\n```\n\n</details>\n");
    }

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

    let result = run_task_inner(app, input, db, config_manager, run_state.clone()).await;

    // 统一收尾：无论成功/失败/异常，都确保 run_state 与 abort sender 被清理，避免并发状态错乱。
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
    let cleanup_conversation_id = conversation_id.clone();

    let (content, base_messages_override, start_turn_index) = {
        let db = db.lock().await;
        let messages = db
            .get_messages(&conversation_id, 2_000, None)
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

                let filtered_turns = meta.turns.as_ref().map(|turns| {
                    turns
                        .iter()
                        .cloned()
                        .filter(|t| t.turn_index < target_turn_index)
                        .collect::<Vec<_>>()
                });

                if !filtered_blocks.is_empty() {
                    base_messages.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: conversation_id.clone(),
                        role: MessageRole::Assistant,
                        content: String::new(),
                        content_parts: Vec::new(),
                        thinking: None,
                        meta: Some(MessageMeta {
                            model: meta.model.clone(),
                            blocks: Some(filtered_blocks),
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

        (user_msg.content.clone(), base_messages, target_turn_index)
    };

    let result = run_task_inner(
        app,
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

async fn run_task_inner(
    app: AppHandle,
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
    let assistant_message_id = uuid::Uuid::new_v4().to_string();

    let mut emitter = RunEmitter::new(app.clone(), input.conversation_id.clone(), run_id.clone());

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
    let tools_enabled = matches!(runtime_agent_type, AgentType::Tool) || chat_mode;

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
    let (user_message_id_for_status_update, base_messages) =
        if let Some(prebuilt) = input.base_messages_override.take() {
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
            {
                let db = db.lock().await;
                db.add_message(&input.conversation_id, &user_message)
                    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
            }

            // 历史消息作为“基础上下文”（只取 Success + 本次 Pending 用户消息）
            let base_messages = {
                let db = db.lock().await;
                db.get_messages(&input.conversation_id, 100, None)
                    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
                    .into_iter()
                    .filter(|m| m.status == MessageStatus::Success || m.id == user_message.id)
                    .collect::<Vec<_>>()
            };

            (Some(user_message.id), base_messages)
        };
    let cached_system_prompt: Option<(String, String)> = {
        let db = db.lock().await;
        db.get_conversation(&input.conversation_id)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
            .and_then(|c| {
                let prompt = c.system_prompt.and_then(|s| {
                    let trimmed = s.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })?;
                let key = c.system_prompt_cache_key.and_then(|s| {
                    let trimmed = s.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })?;
                Some((prompt, key))
            })
    };
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
        AgentType::Tool => match provider.provider_type {
            crate::models::ProviderType::Openai
            | crate::models::ProviderType::OpenaiCompatible
            | crate::models::ProviderType::OpenaiResponses
            | crate::models::ProviderType::Anthropic
            | crate::models::ProviderType::Google => {
                expand_persisted_blocks_for_model_input(base_messages)
            }
            _ => append_tool_trace_for_model_input(base_messages),
        },
        _ => append_tool_trace_for_model_input(base_messages),
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
        let ws = {
            let db = db.lock().await;
            db.ensure_workstudio_for_conversation(&input.conversation_id)
                .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
        };
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
    // - chat: enable tools but enforce read-only sandbox (block file writes)
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
        sandbox_policy = crate::models::SandboxPolicy::ReadOnly;
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
            AgentType::Tool => TaskKind::Tool,
            AgentType::Chat => TaskKind::Chat,
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
    let mut allow_persistent_pty = false;
    let mut enable_local_web_search_tool = false;
    let mut enable_mcp_resource_tool_prompt = false;

    let (tool_orchestrator, tools, allowed_tool_names) = if !tools_enabled {
        (None, None, None)
    } else {
        // ToolSet：Agent 可以绑定不同工具集合。
        // - 若未绑定 toolset：默认只暴露 `web_search`（若本次 run 启用了 web_search），避免把本地工具“默认”下发给模型。
        //   真实执行层仍会再按 sandbox_policy 做权限校验（防止前端/模型绕过）。
        let toolset_is_unbound = agent
            .toolset
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);

        let mut toolset = match agent.toolset.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(name) => match config.tools.toolsets.iter().find(|t| t.name == name) {
                Some(ts) => super::tools::spec::ToolSet::allow_list(name, ts.tools.clone())
                    .with_persistance_shell_enhance(ts.persistance_shell_enhance),
                // 安全优先：引用了不存在的 toolset 时，默认 deny_all，避免“悄悄变成 allow_all”
                None => super::tools::spec::ToolSet::deny_all(name),
            },
            None => super::tools::spec::ToolSet::allow_list("__unbound__", Vec::new()),
        };

        // 权限策略：不再使用全局开关；改为由安全策略（sandbox_policy）决定是否暴露高危工具。
        // 实际执行时仍会在工具层再次按 sandbox_policy 做强校验（例如 read-only 拒绝写入/PTY 等）。
        let allow_shell_exec = true;
        let allow_pty_exec = !matches!(sandbox_policy, crate::models::SandboxPolicy::ReadOnly);
        let allow_file_write = !matches!(sandbox_policy, crate::models::SandboxPolicy::ReadOnly);
        let allow_mcp_exec = sandbox_policy.has_full_network_access();
        let permission_policy: Arc<dyn super::tools::permissions::ToolPermissionPolicy> =
            Arc::new(super::tools::permissions::BasicToolPermissionPolicy {
                allow_shell_exec,
                allow_pty_exec,
                allow_file_write,
                allow_mcp_exec,
            });

        allow_persistent_pty = toolset.persistance_shell_enhance;

        // Registry：每个 run 构建一次（便于按 agent/mcp set 动态注入工具）。
        let mut registry = ToolRegistry::new();
        register_builtin_handlers(&mut registry);

        // MCP tools：按 agent 绑定的 MCP Set 进行注入（工具名：mcp__{server}__{tool}）。
        let mut mcp_tool_names: Vec<String> = Vec::new();
        let mut mcp_resource_tool_names: Vec<String> = Vec::new();
        if allow_mcp_exec {
            if let Some(set_name) = agent.mcp_set.as_deref().filter(|s| !s.trim().is_empty()) {
                let server_map: HashMap<String, crate::models::McpServerConfig> = config
                    .mcp
                    .servers
                    .iter()
                    .map(|e| (e.name.clone(), e.config.clone()))
                    .collect();

                if let Some(mcp_set) = config.mcp.sets.iter().find(|s| s.name == set_name) {
                    let mut effective_servers: HashMap<String, crate::models::McpServerConfig> =
                        HashMap::new();
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
                        effective_servers.insert(set_server.server.clone(), server_cfg.clone());

                        let tools = match global_mcp_runtime()
                            .list_tools(&set_server.server, server_cfg)
                            .await
                        {
                            Ok(t) => t,
                            Err(err) => {
                                eprintln!(
                                    "[MCP] 列工具失败: server={} err={}",
                                    set_server.server, err
                                );
                                continue;
                            }
                        };

                        let mut tools = tools;
                        // Apply MCP Set per-server tool filters on top of server config filters.
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

                    // Codex-like MCP resource helpers (list/read resources) for the effective MCP server set.
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

        // Local web search tool:
        // - User explicitly selected a web_search provider for this run
        // - And the selected provider is enabled + has API key configured
        let ws_cfg = &config.general.web_search_tool;

        // Parse the selected provider from input (if any)
        let selected_provider = input
            .web_search_provider
            .as_ref()
            .and_then(|p| match p.as_str() {
                "tavily" => Some(crate::models::WebSearchProvider::Tavily),
                "google" => Some(crate::models::WebSearchProvider::Google),
                "brave" => Some(crate::models::WebSearchProvider::Brave),
                _ => None,
            });

        // Check if the selected provider is enabled and has API key
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
                    .is_some_and(|k| !k.trim().is_empty()),
                crate::models::WebSearchProvider::Brave => ws_cfg
                    .brave_api_key
                    .as_ref()
                    .is_some_and(|k| !k.trim().is_empty()),
                crate::models::WebSearchProvider::Google => {
                    ws_cfg
                        .google_api_key
                        .as_ref()
                        .is_some_and(|k| !k.trim().is_empty())
                        && ws_cfg
                            .google_cx
                            .as_ref()
                            .is_some_and(|k| !k.trim().is_empty())
                }
            };
            (enabled, has_key)
        } else {
            (false, false)
        };

        enable_local_web_search_tool = selected_provider.is_some() && provider_enabled && has_key;

        if enable_local_web_search_tool {
            registry.register(Arc::new(
                crate::runtime::tools::handlers::web_search::WebSearchTool {
                    settings: ws_cfg.clone(),
                    provider_override: selected_provider,
                },
            ));
            if matches!(toolset.mode, super::tools::spec::ToolSetMode::AllowList) {
                if !toolset.tools.iter().any(|t| t == "web_search") {
                    toolset.tools.push("web_search".to_string());
                }
            }
        }

        // 如果 agent 使用 allow_list toolset，需要把 MCP 工具名也显式加入 allow_list，
        // 否则 orchestrator 会把它们过滤掉（即使 registry 已注册）。
        // 但“未绑定 toolset”的默认模式只允许 web_search：不应把 MCP 工具自动加进来。
        if matches!(toolset.mode, super::tools::spec::ToolSetMode::AllowList)
            && !toolset_is_unbound
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
        let allowed_tool_names: HashSet<String> = specs.iter().map(|s| s.name.clone()).collect();
        (
            Some(orchestrator),
            Some(tool_specs_to_definitions(&specs)),
            Some(allowed_tool_names),
        )
    };
    let enable_apply_patch_tool_prompt = allowed_tool_names
        .as_ref()
        .is_some_and(|names| names.contains("apply_patch"));

    // 4) TurnLoop：Chat 默认单 Turn，但只要启用了工具调用，就至少需要 2 Turn 才能完成
    //    （Turn1: tool_calls -> 执行工具；Turn2: 带工具结果继续生成最终回复）。
    let has_tools = tools.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
    let default_max_turns: u32 = match runtime_agent_type {
        AgentType::Tool => 10_000,
        AgentType::Chat => {
            if has_tools {
                20
            } else {
                1
            }
        }
    };
    let mut max_turns: u32 = agent.max_turns.unwrap_or(default_max_turns).max(1);
    if matches!(runtime_agent_type, AgentType::Chat) && has_tools && agent.max_turns.is_none() {
        max_turns = max_turns.max(2);
    }

    // Skills: load (metadata only by default; full contents only when a skill is explicitly mentioned).
    let app_skills_dir = config_manager
        .config_path()
        .parent()
        .map(|p| p.join("skills"));
    let repo_skills_dir = {
        // Prefer bundled resources: `resources/skills/` -> `<resource_dir>/skills`
        let from_resources = app
            .path()
            .resource_dir()
            .ok()
            .map(|p| p.join("skills"))
            .filter(|p| p.is_dir());
        if from_resources.is_some() {
            from_resources
        } else {
            // Dev fallback: prefer build-time manifest dir (stable even if runtime cwd changes).
            let from_manifest = option_env!("CARGO_MANIFEST_DIR").and_then(|manifest_dir| {
                let manifest = std::path::PathBuf::from(manifest_dir);
                if let Some(parent) = manifest.parent() {
                    let p = parent.join("skills");
                    if p.is_dir() {
                        return Some(p);
                    }
                }
                if let Some(grand) = manifest.parent().and_then(|p| p.parent()) {
                    let p = grand.join("tauri-ai").join("skills");
                    if p.is_dir() {
                        return Some(p);
                    }
                    let p2 = grand.join("skills");
                    if p2.is_dir() {
                        return Some(p2);
                    }
                }
                None
            });
            if from_manifest.is_some() {
                from_manifest
            } else {
                // Fallbacks: search from executable directory and current working directory (and their ancestors).
                let try_from_ancestors = |base: &std::path::Path| -> Option<std::path::PathBuf> {
                    for dir in base.ancestors().take(8) {
                        let p = dir.join("tauri-ai").join("skills");
                        if p.is_dir() {
                            return Some(p);
                        }
                        let p2 = dir.join("skills");
                        if p2.is_dir() {
                            return Some(p2);
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
        .as_ref()
        .map(|ws| std::path::PathBuf::from(&ws.main_folder).join("skills"))
        .filter(|p| p.is_dir());

    // Metadata only (no SKILL.md bodies) for the cached system prompt + mention detection.
    let enabled_skills_meta = select_enabled_skills(
        &config,
        agent,
        app_skills_dir.as_deref(),
        repo_skills_dir.as_deref(),
        workstudio_skills_dir.as_deref(),
        false,
    );

    let py = python_availability();
    let computed_cache_key = compute_system_prompt_cache_key(
        agent,
        workstudio.as_ref(),
        allow_persistent_pty,
        enable_apply_patch_tool_prompt,
        enable_local_web_search_tool,
        enable_mcp_resource_tool_prompt,
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
            if let Some(section) = render_skills_section(&enabled_skills_meta) {
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
        if enable_local_web_search_tool {
            inject_web_search_tool_prompt(&mut messages, &input.conversation_id);
        }
        if enable_mcp_resource_tool_prompt {
            inject_mcp_resource_tool_prompt(&mut messages, &input.conversation_id);
        }

        if let Some(merged_prompt) =
            merge_system_messages_into_single_in_place(&mut messages, &input.conversation_id)
        {
            let db = db.lock().await;
            db.update_conversation_system_prompt(
                &input.conversation_id,
                &merged_prompt,
                Some(computed_cache_key.as_str()),
            )
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
        }

        messages
    };

    // Per-message dynamic skill injection:
    // - Do NOT cache this (depends on the current input).
    // - Keep system prompt as a single message by appending the skill blocks.
    if !enabled_skills_meta.is_empty() {
        let mentioned = find_skill_mentions(&input.content, &enabled_skills_meta);
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
                let block = build_skill_prompt_block(&mentioned_full);
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
        let hard_limit = hard_limit_tokens(ctx_len, hard_pct);
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
                        let refreshed_base_messages = {
                            let db = db.lock().await;
                            db.get_messages(&input.conversation_id, 100, None)
                                .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
                                .into_iter()
                                .filter(|m| {
                                    m.status == MessageStatus::Success
                                        || user_message_id_for_status_update
                                            .as_ref()
                                            .is_some_and(|id| m.id == *id)
                                })
                                .collect::<Vec<_>>()
                        };

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
                            AgentType::Tool => match provider.provider_type {
                                crate::models::ProviderType::Openai
                                | crate::models::ProviderType::OpenaiCompatible
                                | crate::models::ProviderType::OpenaiResponses
                                | crate::models::ProviderType::Anthropic
                                | crate::models::ProviderType::Google => {
                                    expand_persisted_blocks_for_model_input(refreshed_base_messages)
                                }
                                _ => append_tool_trace_for_model_input(refreshed_base_messages),
                            },
                            _ => append_tool_trace_for_model_input(refreshed_base_messages),
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

        // Hard trim the prompt for this request to avoid context window exceeded.
        if ctx_mgr.should_trim() {
            let trim = trim_runtime_messages_to_hard_limit(runtime_messages, hard_limit);
            runtime_messages = trim.trimmed_messages;
        }
    }

    let mut turn_loop = TurnLoop {
        client,
        model_config: model_config.clone(),
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
            let configured = model_config.retry_attempts.unwrap_or(3).clamp(1, 10);
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
            {
                let db = db.lock().await;
                if let Some(id) = user_message_id_for_status_update.as_deref() {
                    let _ =
                        db.update_message_status(id, MessageStatus::Failed, Some(error.clone()));
                }
            }

            if !content.is_empty()
                || !thinking.is_empty()
                || !blocks.is_empty()
                || !turns.is_empty()
            {
                let assistant_message = Message {
                    id: assistant_message_id.clone(),
                    conversation_id: input.conversation_id.clone(),
                    role: MessageRole::Assistant,
                    content: content.clone(),
                    content_parts: Vec::new(),
                    thinking: if thinking.trim().is_empty() {
                        None
                    } else {
                        Some(thinking.clone())
                    },
                    meta: Some(MessageMeta {
                        model: Some(model_config.model.clone()),
                        blocks: if blocks.is_empty() {
                            None
                        } else {
                            Some(blocks)
                        },
                        turns: if turns.is_empty() { None } else { Some(turns) },
                        ..Default::default()
                    }),
                    created_at: chrono::Utc::now(),
                    status: MessageStatus::Failed,
                    error_message: Some(error.clone()),
                };

                let db = db.lock().await;
                let _ = db.add_message(&input.conversation_id, &assistant_message);
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
            {
                let db = db.lock().await;
                if let Some(id) = user_message_id_for_status_update.as_deref() {
                    let _ = db.update_message_status(id, MessageStatus::Success, None);
                }
            }

            if !content.is_empty()
                || !thinking.is_empty()
                || !blocks.is_empty()
                || !turns.is_empty()
            {
                let assistant_message = Message {
                    id: assistant_message_id.clone(),
                    conversation_id: input.conversation_id.clone(),
                    role: MessageRole::Assistant,
                    content: content.clone(),
                    content_parts: Vec::new(),
                    thinking: if thinking.trim().is_empty() {
                        None
                    } else {
                        Some(thinking.clone())
                    },
                    meta: Some(MessageMeta {
                        model: Some(model_config.model.clone()),
                        blocks: if blocks.is_empty() {
                            None
                        } else {
                            Some(blocks)
                        },
                        turns: if turns.is_empty() { None } else { Some(turns) },
                        ..Default::default()
                    }),
                    created_at: chrono::Utc::now(),
                    status: MessageStatus::Success,
                    error_message: None,
                };

                let db = db.lock().await;
                db.add_message(&input.conversation_id, &assistant_message)
                    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
            }

            emitter.emit(RunEvent::Done {
                task_id,
                turn_id: last_turn_id,
                assistant_message_id: Some(assistant_message_id),
                full_content: content,
                format: output_format,
                thinking: if thinking.trim().is_empty() {
                    None
                } else {
                    Some(thinking)
                },
                debug_info,
                usage,
                model: Some(model_config.model),
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
            {
                let db = db.lock().await;
                if let Some(id) = user_message_id_for_status_update.as_deref() {
                    let _ = db.update_message_status(id, MessageStatus::Success, None);
                }
            }

            if !content.is_empty()
                || !thinking.is_empty()
                || !blocks.is_empty()
                || !turns.is_empty()
            {
                let assistant_message = Message {
                    id: assistant_message_id.clone(),
                    conversation_id: input.conversation_id.clone(),
                    role: MessageRole::Assistant,
                    content: content.clone(),
                    content_parts: Vec::new(),
                    thinking: if thinking.trim().is_empty() {
                        None
                    } else {
                        Some(thinking.clone())
                    },
                    meta: Some(MessageMeta {
                        model: Some(model_config.model.clone()),
                        blocks: if blocks.is_empty() {
                            None
                        } else {
                            Some(blocks)
                        },
                        turns: if turns.is_empty() { None } else { Some(turns) },
                        ..Default::default()
                    }),
                    created_at: chrono::Utc::now(),
                    status: MessageStatus::Success,
                    error_message: None,
                };

                let db = db.lock().await;
                db.add_message(&input.conversation_id, &assistant_message)
                    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
            }

            emitter.emit(RunEvent::Done {
                task_id,
                turn_id: last_turn_id,
                assistant_message_id: Some(assistant_message_id),
                full_content: content,
                format: output_format,
                thinking: if thinking.trim().is_empty() {
                    None
                } else {
                    Some(thinking)
                },
                debug_info: None,
                usage: None,
                model: Some(model_config.model),
            });
            Ok(())
        }
    }
}

async fn cleanup_abort_sender(run_state: &RunState, conversation_id: &str) {
    let mut senders = run_state.abort_senders.write().await;
    senders.remove(conversation_id);
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
        use crate::ai_client::AiError;
        match err {
            AiError::ConnectionError(_) | AiError::StreamError(_) | AiError::RateLimited(_) => true,
            AiError::RequestFailed(_) => status_from_debug(di).is_some_and(is_retryable_status),
            AiError::AuthenticationFailed(_) | AiError::InvalidResponse(_) => false,
        }
    }

    let messages = sanitize_messages_for_model_input(messages);

    let resume_enabled = model_config.resume_partial_output;
    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut debug_info: Option<DebugInfoData> = None;
    let mut usage: Option<TokenUsage> = None;
    let mut last_error: Option<String> = None;
    let mut tool_calls: Option<Vec<ToolCall>> = None;
    let mut emitted_any_delta = false;
    let mut turn_state: Option<String> = None;

    for attempt in 1..=max_attempts {
        let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);

        // 请求级重试：本轮尚未产生任何增量输出，可以安全清空本地缓冲。
        // 流式重连：保留已输出内容，只清理本轮临时信息。
        if !emitted_any_delta {
            full_content.clear();
            full_thinking.clear();
            debug_info = None;
            usage = None;
            last_error = None;
            tool_calls = None;
            turn_state = None;
        } else {
            debug_info = None;
            usage = None;
            last_error = None;
            tool_calls = None;
        }

        let client = client.clone();
        let model_config = model_config.clone();
        let tools = tools.clone();
        let attempt_messages = messages.clone();

        let options = crate::ai_client::StreamOptions {
            resume_state: if resume_enabled {
                turn_state.clone()
            } else {
                None
            },
        };

        let stream_handle = tokio::spawn(async move {
            client
                .chat_stream(attempt_messages, &model_config, tools, token_tx, options)
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
                            emitted_any_delta = true;
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
                        Some(StreamEvent::Thinking(token)) => {
                            emitted_any_delta = true;
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
                        Some(StreamEvent::WebSearch { id, status, action }) => {
                            emitted_any_delta = true;
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
                            let trimmed = state.trim();
                            if !trimmed.is_empty() {
                                turn_state = Some(trimmed.to_string());
                            }
                        }
                        Some(StreamEvent::ToolCalls(calls)) => {
                            emitted_any_delta = true;
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
                            if !emitted_any_delta && !content.is_empty() {
                                full_content = content;
                            }
                            if full_thinking.is_empty() && !thinking.is_empty() {
                                full_thinking = thinking;
                            }
                            break;
                        }
                        Some(StreamEvent::DoneWithDebug { content, thinking, debug_info: di, usage: u }) => {
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
                            last_error = Some(error);
                            // 不立刻 break：等待可能带 debug/usage 的 DoneWithDebug
                        }
                        None => break,
                    }
                }
            }
        }

        // 确保任务退出，并把“没有通过 StreamEvent::Error 上报的错误”补齐（否则会被误判为成功结束）
        let stream_result: Result<(), crate::ai_client::AiError> = match stream_handle.await {
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

        if let Err(stream_err) = stream_result {
            if last_error.is_none() {
                last_error = Some(stream_err.to_string());
            }

            let reconnecting = emitted_any_delta;
            let can_retry = attempt < max_attempts
                && is_retryable_error(&stream_err, debug_info.as_ref())
                && (!emitted_any_delta || (resume_enabled && turn_state.is_some()));

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
                last_error = None;
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
            retry_attempts: None,
            resume_partial_output: false,
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
                    },
                    crate::models::MessageBlock::ToolCall {
                        id: "t1:tool_call:call_2".to_string(),
                        turn_id: Some("t1".to_string()),
                        turn_index: Some(1),
                        call_id: "call_2".to_string(),
                        name: "shell_command".to_string(),
                        arguments: "{}".to_string(),
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
}
