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
use crate::prompts::{PERSISTENT_PROCESS_PROMPT, PYTHON3_FALLBACK_PROMPT, WORKSTUDIO_PROMPT_GUIDE};
use crate::runtime::events::RunEvent;
use crate::runtime::types::{TaskKind, TurnPhase, TurnStatus};
use crate::storage::Database;

use super::emitter::RunEmitter;
use super::approvals::ApprovalDecision;
use super::run_state::RunState;
use super::tools::{
    tool_specs_to_definitions, ToolOrchestrator, ToolOrchestratorConfig, ToolServices,
};

/// 前端一次 invoke 对应的输入（Task Request）
pub struct RunTaskInput {
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub content: String,
    pub content_parts: Option<Vec<ContentPart>>,
    pub agent_name: Option<String>,
    pub model_ref: Option<String>,
    pub thinking: Option<serde_json::Value>,
    pub web_search_enabled: Option<bool>,
    pub debug_mode: Option<bool>,
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
    /// Per-conversation approval cache (for "approve for session").
    approval_store: Arc<Mutex<super::approvals::ApprovalStore>>,
    run_state: Arc<RunState>,
    runtime_messages: Vec<Message>,
    conversation_id: String,
    task_id: String,
    assistant_message_id: String,
    output_format: Option<String>,
    max_turns: u32,
    /// 是否把 thinking 回灌到“同一 Task 的下一轮上下文”（由 Agent 配置控制）。
    reinject_thinking: bool,
    debug_mode: bool,
    emitter: &'a mut RunEmitter,
}

fn build_assistant_context_content(content: String, thinking: &str, reinject_thinking: bool) -> String {
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

impl<'a> TurnLoop<'a> {
    fn is_safe_readonly_tool(tool_name: &str) -> bool {
        matches!(tool_name, "echo" | "get_time" | "read_file" | "list_dir" | "rg")
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

    fn approval_cache_key(call: &ToolCall) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut h = DefaultHasher::new();
        call.name.hash(&mut h);
        call.arguments.hash(&mut h);
        format!("{}:{:x}", call.name, h.finish())
    }

    fn sandbox_policy_for_approved_call(
        &self,
        tool_name: &str,
        escalated: bool,
    ) -> crate::models::SandboxPolicy {
        if escalated {
            return crate::models::SandboxPolicy::DangerFullAccess;
        }

        // In "read-only" mode, a successful approval implies we can temporarily
        // lift restrictions for this call. To stay close to Codex semantics,
        // we upgrade to "workspace-write" (still confined to workspace roots).
        if matches!(self.sandbox_policy, crate::models::SandboxPolicy::ReadOnly)
            && (Self::is_exec_tool(tool_name) || Self::is_write_tool(tool_name))
        {
            return crate::models::SandboxPolicy::WorkspaceWrite {
                writable_roots: Vec::new(),
                network_access: false,
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
                    && matches!(self.sandbox_policy, crate::models::SandboxPolicy::WorkspaceWrite { .. })
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

        if self.allowed_tool_names.as_ref().is_some_and(|s| !s.contains(tool_name)) {
            return (false, ApprovalDecision::Approved, None);
        }

        if Self::is_safe_readonly_tool(tool_name) {
            return (false, ApprovalDecision::Approved, None);
        }

        let mut needs_prompt = if force_prompt {
            !matches!(self.approval_policy, AskForApproval::Never)
        } else {
            self.should_prompt_for_tool(tool_name)
        };

        // OnFailure: first attempt never prompts; only retry will.
        if matches!(self.approval_policy, AskForApproval::OnFailure) && !force_prompt {
            needs_prompt = false;
        }

        if !needs_prompt {
            // Policy allows running without asking; keep the current sandbox policy.
            return (false, ApprovalDecision::Approved, Some(self.sandbox_policy.clone()));
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

        for turn_index in 1..=self.max_turns {
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
                    let max_turns_error = if turn_index >= self.max_turns {
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
                            debug_info: persisted_debug_info.clone(),
                            usage: persisted_usage,
                            model: Some(self.model_config.model.clone()),
                        });

                        return TaskOutcome::Failed {
                            turn_id,
                            error,
                            debug_info: turn_debug_info,
                            content,
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
                                abort_rx,
                                &turn_id,
                                turn_index,
                                call,
                                None,
                                false,
                                false,
                            )
                            .await;
                        if asked {
                            approval_record = Some((Self::decision_status(decision).to_string(), None));
                        }

                        match decision {
                            ApprovalDecision::Abort => {
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
                        if matches!(self.approval_policy, AskForApproval::OnFailure) {
                            if let Err(e) = &exec {
                                if e.kind == super::tools::registry::ToolErrorKind::Denied
                                    && !sandbox_policy_for_call.has_full_disk_write_access()
                                {
                                    let retry_reason = format!(
                                        "工具被沙盒拒绝：{}。是否允许以完全访问权限重试？",
                                        e.message
                                    );
                                    let (asked2, decision2, sandbox2) = self
                                        .request_tool_approval(
                                            abort_rx,
                                            &turn_id,
                                            turn_index,
                                            call,
                                            Some(retry_reason.clone()),
                                            true,
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
                                            break;
                                        }
                                        ApprovalDecision::Denied => {
                                            let msg = format!(
                                                "TOOL_DENIED: 用户拒绝提升权限重试（原始错误：{}）",
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
                                            sandbox_policy_for_call = sandbox2.unwrap_or(
                                                crate::models::SandboxPolicy::DangerFullAccess,
                                            );
                                            exec = {
                                                let mut tool_ctx =
                                                    super::tools::registry::ToolExecutionContext {
                                                        conversation_id: &self.conversation_id,
                                                        task_id: &self.task_id,
                                                        turn_id: &turn_id,
                                                        assistant_message_id:
                                                            &self.assistant_message_id,
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
                                                        services: self
                                                            .tool_services
                                                            .as_ref(),
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
                                    self.emitter.emit(RunEvent::BlockDelta {
                                        task_id: self.task_id.clone(),
                                        turn_id: turn_id.clone(),
                                        assistant_message_id: Some(self.assistant_message_id.clone()),
                                        block_id: format!("tool_result:{}", call.id),
                                        block_type: "tool_result".to_string(),
                                        format: Some("plain".to_string()),
                                        delta: format!("TOOL_ABORTED: {}", e.message),
                                    });
                                    blocks.push(MessageBlock::ToolResult {
                                        id: format!("{turn_id}:tool_result:{}", call.id),
                                        turn_id: Some(turn_id.clone()),
                                        turn_index: Some(turn_index),
                                        call_id: call.id.clone(),
                                        text: format!("TOOL_ABORTED: {}", e.message),
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
                            debug_info: persisted_debug_info.clone(),
                            usage: persisted_usage,
                            model: Some(self.model_config.model.clone()),
                        });
                        return TaskOutcome::Aborted {
                            last_turn_id: turn_id,
                            content: String::new(),
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
                        debug_info: persisted_debug_info,
                        usage: persisted_usage,
                        model: Some(self.model_config.model.clone()),
                    });
                    return TaskOutcome::Failed {
                        turn_id,
                        error,
                        debug_info: turn_debug_info,
                        content,
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
                        debug_info: None,
                        usage: None,
                        model: Some(self.model_config.model.clone()),
                    });
                    return TaskOutcome::Aborted {
                        last_turn_id: turn_id,
                        content,
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
            tool_calls: Vec<ToolCall>,
            tool_results: Vec<(String, String)>,
        }

        let out_start_len = out.len();
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

            // Skip empty turns unless they contain tool calls (tool-only turns are valid).
            if content.trim().is_empty() && !has_tool_calls {
                continue;
            }

            out.push(Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: msg.conversation_id.clone(),
                role: MessageRole::Assistant,
                content,
                content_parts: Vec::new(),
                thinking: None,
                meta: if has_tool_calls {
                    Some(MessageMeta {
                        tool_calls: Some(bundle.tool_calls),
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
                for (call_id, text) in bundle.tool_results {
                    out.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: msg.conversation_id.clone(),
                        role: MessageRole::Tool,
                        content: text,
                        content_parts: Vec::new(),
                        thinking: None,
                        meta: Some(MessageMeta {
                            tool_call_id: Some(call_id),
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

async fn run_task_inner(
    app: AppHandle,
    input: RunTaskInput,
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

    let mut emitter = RunEmitter::new(app, input.conversation_id.clone(), run_id.clone());

    let resolved = resolve_chat_model(
        &config,
        input.agent_name.as_deref(),
        input.model_ref.as_deref(),
    )?;
    let (provider, model, agent) = (resolved.provider, resolved.model, resolved.agent);
    let output_format = get_output_format(agent);

    if !provider.enabled {
        return Err(AppErrorCode::AiServiceError(format!(
            "Provider '{}' is disabled",
            provider.display_name
        ))
        .into());
    }

    let mut model_config =
        build_model_config(provider, model, input.thinking, input.web_search_enabled);
    let debug_mode = input.debug_mode.unwrap_or(config.general.debug_mode);
    // Debug: 在日志输出原始 SSE（仅流式请求）
    model_config.debug_sse = debug_mode && config.general.debug_sse;
    let client = get_client(&model_config.provider)
        .map_err(|e| AppErrorCode::AiServiceError(e.to_string()))?;

    // 1) 落库用户消息（Pending）
    let user_message = Message {
        id: input
            .message_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        conversation_id: input.conversation_id.clone(),
        role: MessageRole::User,
        content: input.content.clone(),
        content_parts: input.content_parts.unwrap_or_default(),
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

    // 2) 历史消息作为“基础上下文”（只取 Success + 本次 Pending 用户消息）
    let base_messages = {
        let db = db.lock().await;
        db.get_messages(&input.conversation_id, 100, None)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
            .into_iter()
            .filter(|m| m.status == MessageStatus::Success || m.id == user_message.id)
            .collect::<Vec<_>>()
    };
    let base_messages = build_request_messages(base_messages, &input.conversation_id, agent);
    // DeepSeek 工具调用建议：新任务开始时不传历史 reasoning_content（thinking），仅在同一 Task 的多 Turn 内回传。
    let base_messages = base_messages
        .into_iter()
        .map(|mut m| {
            if m.role == MessageRole::Assistant {
                m.thinking = None;
            }
            m
        })
        .collect::<Vec<_>>();
    let base_messages = match agent.agent_type {
        AgentType::Tool => match provider.provider_type {
            crate::models::ProviderType::Openai
            | crate::models::ProviderType::OpenaiCompatible
            | crate::models::ProviderType::OpenaiResponses
            | crate::models::ProviderType::Anthropic
            | crate::models::ProviderType::Google => expand_persisted_blocks_for_model_input(base_messages),
            _ => append_tool_trace_for_model_input(base_messages),
        },
        _ => append_tool_trace_for_model_input(base_messages),
    };

    // 2.5) Workstudio: tool agents can bind a working directory (main folder).
    let workspace_enabled = matches!(agent.agent_type, AgentType::Tool)
        && agent.workspace_support.unwrap_or(true);
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
            roots.extend(ws.folders.iter().map(|p| std::path::PathBuf::from(p.clone())));
            roots
        })
        .unwrap_or_default();

    let sandbox_policy = agent
        .sandbox_policy
        .clone()
        .unwrap_or_else(|| config.security.sandbox_policy.clone());

    let approval_policy = agent
        .approval_policy
        .unwrap_or(config.security.approval_policy);

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
        task_kind: match agent.agent_type {
            AgentType::Tool => TaskKind::Tool,
            AgentType::Chat => TaskKind::Chat,
        },
        title: None,
    });

    // tools：按 Agent 选择工具集，并在这里完成“权限过滤 -> 传给模型的 ToolDefinition”
    // - 真实执行时仍会再次做权限检查（防止前端/模型绕过）
    let tool_services = run_state.get_tool_services(&input.conversation_id).await;
    let approval_store = run_state.get_approval_store(&input.conversation_id).await;
    let mut allow_persistent_pty = false;
    let (tool_orchestrator, tools, allowed_tool_names) = match agent.agent_type {
        AgentType::Tool => {
            // ToolSet：Agent 可以绑定不同工具集合；未配置则默认 allow_all（由权限再做过滤）。
            let toolset = match agent.toolset.as_deref().filter(|s| !s.trim().is_empty()) {
                Some(name) => match config.tools.toolsets.iter().find(|t| t.name == name) {
                    Some(ts) => super::tools::spec::ToolSet::allow_list(name, ts.tools.clone())
                        .with_persistance_shell_enhance(ts.persistance_shell_enhance),
                    // 安全优先：引用了不存在的 toolset 时，默认 deny_all，避免“悄悄变成 allow_all”
                    None => super::tools::spec::ToolSet::deny_all(name),
                },
                None => super::tools::spec::ToolSet::allow_all(),
            };

            // 权限策略：由 AppConfig 驱动（默认：只允许无权限工具；shell/pty 默认关闭）。
            let permission_policy: Arc<dyn super::tools::permissions::ToolPermissionPolicy> =
                if !config.tools.enabled {
                    Arc::new(super::tools::permissions::DenyAllPolicy::default())
                } else {
                    Arc::new(super::tools::permissions::BasicToolPermissionPolicy {
                        allow_shell_exec: config.tools.permissions.shell_exec,
                        allow_pty_exec: config.tools.permissions.pty_exec,
                        allow_file_write: config.tools.permissions.file_write,
                    })
                };

            allow_persistent_pty = toolset.persistance_shell_enhance;

            let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig {
                toolset,
                permission_policy,
            });
            let specs = orchestrator.tool_specs_for_model();
            let allowed_tool_names: HashSet<String> =
                specs.iter().map(|s| s.name.clone()).collect();
            (
                Some(orchestrator),
                Some(tool_specs_to_definitions(&specs)),
                Some(allowed_tool_names),
            )
        }
        AgentType::Chat => {
            // Chat 也允许使用只读工具（read_file/list_dir/rg 等），用于“读代码/查文件”。
            let permission_policy: Arc<dyn super::tools::permissions::ToolPermissionPolicy> =
                if !config.tools.enabled {
                    Arc::new(super::tools::permissions::DenyAllPolicy::default())
                } else {
                    Arc::new(super::tools::permissions::DenyByDefaultPolicy::default())
                };

            let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig {
                toolset: super::tools::spec::ToolSet::allow_all(),
                permission_policy,
            });
            let specs = orchestrator.tool_specs_for_model();
            let allowed_tool_names: HashSet<String> =
                specs.iter().map(|s| s.name.clone()).collect();
            (
                Some(orchestrator),
                Some(tool_specs_to_definitions(&specs)),
                Some(allowed_tool_names),
            )
        }
    };

    // 4) TurnLoop：Chat 默认单 Turn，但只要启用了工具调用，就至少需要 2 Turn 才能完成
    //    （Turn1: tool_calls -> 执行工具；Turn2: 带工具结果继续生成最终回复）。
    let has_tools = tools.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
    let default_max_turns: u32 = match agent.agent_type {
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
    if matches!(agent.agent_type, AgentType::Chat) && has_tools && agent.max_turns.is_none() {
        max_turns = max_turns.max(2);
    }

    let mut runtime_messages = base_messages;
    if let Some(ws) = workstudio.as_ref() {
        inject_workstudio_prompt(&mut runtime_messages, &input.conversation_id, ws);
    }
    if allow_persistent_pty {
        inject_persistent_process_prompt(&mut runtime_messages, &input.conversation_id);
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
        approval_store,
        run_state: run_state.clone(),
        runtime_messages,
        conversation_id: input.conversation_id.clone(),
        task_id: task_id.clone(),
        assistant_message_id: assistant_message_id.clone(),
        output_format: output_format.clone(),
        max_turns,
        reinject_thinking: agent.reinject_thinking,
        debug_mode,
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
                let _ = db.update_message_status(
                    &user_message.id,
                    MessageStatus::Failed,
                    Some(error.clone()),
                );
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
                        blocks: if blocks.is_empty() { None } else { Some(blocks) },
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
                let _ = db.update_message_status(&user_message.id, MessageStatus::Success, None);
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
                        blocks: if blocks.is_empty() { None } else { Some(blocks) },
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
                let _ = db.update_message_status(&user_message.id, MessageStatus::Success, None);
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
                        blocks: if blocks.is_empty() { None } else { Some(blocks) },
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

#[allow(clippy::too_many_arguments)]
async fn stream_one_turn(
    client: Arc<dyn crate::ai_client::AiClient>,
    model_config: crate::models::ModelConfig,
    tools: Option<Vec<ToolDefinition>>,
    messages: Vec<Message>,
    emitter: &mut RunEmitter,
    task_id: &str,
    turn_id: &str,
    assistant_message_id: &str,
    output_format: Option<String>,
    abort_rx: &mut mpsc::Receiver<()>,
) -> TurnStreamResult {
    let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);

    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut debug_info: Option<DebugInfoData> = None;
    let mut usage: Option<TokenUsage> = None;
    let mut last_error: Option<String> = None;
    let mut tool_calls: Option<Vec<ToolCall>> = None;

    let messages = sanitize_messages_for_model_input(messages);
    let stream_handle = tokio::spawn(async move {
        client
            .chat_stream(messages, &model_config, tools, token_tx)
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
                    Some(StreamEvent::ToolCalls(calls)) => {
                        tool_calls = Some(calls);
                        // Tool call turn：不要立刻 break，继续等 DoneWithDebug（如果有的话）以便拿到 debug/usage
                    }
                    Some(StreamEvent::Done(content)) => { full_content = content; break; }
                    Some(StreamEvent::DoneWithThinking { content, thinking }) => {
                        full_content = content;
                        full_thinking = thinking;
                        break;
                    }
                    Some(StreamEvent::DoneWithDebug { content, thinking, debug_info: di, usage: u }) => {
                        full_content = content;
                        if let Some(t) = thinking { full_thinking = t; }
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

    // 确保任务退出（忽略具体错误）
    let _ = stream_handle.await;

    if let Some(calls) = tool_calls {
        return TurnStreamResult::ToolCalls {
            content: full_content,
            thinking: full_thinking,
            tool_calls: calls,
            debug_info,
            usage,
        };
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

    TurnStreamResult::Final {
        content: full_content,
        thinking: full_thinking,
        debug_info,
        usage,
    }
}
