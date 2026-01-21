//! TaskRunner：把「一次用户请求」运行成统一事件流（`run:event`）。
//!
//! 目标：
//! - `commands/run.rs` 只负责 Tauri 参数接入
//! - 运行时抽象集中在这里：Task / Turn / ReAct（Think → Act → Observe）
//! - Chat = 最简单的 Task（通常单 Turn）
//! - Tool/Code = 多 Turn 循环（后续可扩展）

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::{mpsc, Mutex};

use crate::agents::chat::{
    build_model_config, build_request_messages, get_output_format, resolve_chat_model,
};
use crate::ai_client::{
    get_client, DebugInfoData, StreamEvent, TokenUsage, ToolCall, ToolDefinition,
};
use crate::config::ConfigManager;
use crate::errors::{AppErrorCode, SerializableError};
use crate::models::{AgentType, ContentPart, Message, MessageMeta, MessageRole, MessageStatus};
use crate::runtime::events::RunEvent;
use crate::runtime::types::{TaskKind, TurnPhase, TurnStatus};
use crate::storage::Database;

use super::emitter::RunEmitter;
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
        thinking: String,
        tool_calls: Vec<ToolCall>,
        debug_info: Option<DebugInfoData>,
        usage: Option<TokenUsage>,
    },
    Error {
        error: String,
        debug_info: Option<DebugInfoData>,
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
    },
    Aborted {
        last_turn_id: String,
        content: String,
        thinking: String,
    },
    Failed {
        turn_id: String,
        error: String,
        debug_info: Option<DebugInfoData>,
    },
}

/// TurnLoop：把 run_task 内部「按 Turn 迭代」的零碎逻辑集中到一个结构里，保持 run_task 干净。
struct TurnLoop<'a> {
    client: Arc<dyn crate::ai_client::AiClient>,
    model_config: crate::models::ModelConfig,
    tools: Option<Vec<ToolDefinition>>,
    /// 工具编排器（权限/路由/gate/pty 会话等都在 tools 子系统内部处理）
    tool_orchestrator: Option<ToolOrchestrator>,
    /// 工具运行时依赖与状态（例如 PTY 会话管理）
    tool_services: ToolServices,
    runtime_messages: Vec<Message>,
    conversation_id: String,
    task_id: String,
    assistant_message_id: String,
    output_format: Option<String>,
    max_turns: u32,
    debug_mode: bool,
    emitter: &'a mut RunEmitter,
}

impl<'a> TurnLoop<'a> {
    async fn run(&mut self, abort_rx: &mut mpsc::Receiver<()>) -> TaskOutcome {
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
                    return TaskOutcome::Success {
                        last_turn_id: turn_id,
                        content,
                        thinking,
                        debug_info: if self.debug_mode { debug_info } else { None },
                        usage: if self.debug_mode { usage } else { None },
                    };
                }
                TurnStreamResult::ToolCalls {
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

                    let turn_debug_info = if self.debug_mode { debug_info } else { None };
                    let turn_usage = if self.debug_mode { usage } else { None };

                    // 防止无限循环：达到 max_turns 后仍然在请求工具调用
                    if turn_index >= self.max_turns {
                        let error =
                            format!("超过最大 Turn 数({})，仍然需要工具调用", self.max_turns);
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
                        return TaskOutcome::Failed {
                            turn_id,
                            error,
                            debug_info: turn_debug_info,
                        };
                    }

                    // Phase: Act（工具调用）
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

                        normalized_calls.push(call);
                    }

                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Act,
                    });

                    // 把 assistant 的 tool_calls（以及本轮 thinking）写入运行时消息链，供下一轮继续
                    self.runtime_messages.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: self.conversation_id.clone(),
                        role: MessageRole::Assistant,
                        content: String::new(),
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
                        let Some(orchestrator) = self.tool_orchestrator.as_ref() else {
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

                        let mut tool_ctx = super::tools::registry::ToolExecutionContext {
                            conversation_id: &self.conversation_id,
                            task_id: &self.task_id,
                            turn_id: &turn_id,
                            assistant_message_id: &self.assistant_message_id,
                            emitter: self.emitter,
                            abort_rx,
                            services: &self.tool_services,
                        };

                        let result = match orchestrator.execute_one(&mut tool_ctx, call).await {
                            Ok(v) => v.content,
                            Err(e) => {
                                if e.kind == super::tools::registry::ToolErrorKind::Aborted {
                                    tool_ctx.emitter.emit(RunEvent::BlockDelta {
                                        task_id: self.task_id.clone(),
                                        turn_id: turn_id.clone(),
                                        assistant_message_id: Some(self.assistant_message_id.clone()),
                                        block_id: format!("tool_result:{}", call.id),
                                        block_type: "tool_result".to_string(),
                                        format: Some("plain".to_string()),
                                        delta: format!("TOOL_ABORTED: {}", e.message),
                                    });
                                    aborted_in_tools = Some(e.message);
                                    break;
                                }
                                let msg = format!("TOOL_ERROR: {}", e.message);
                                tool_ctx.emitter.emit(RunEvent::BlockDelta {
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
                        return TaskOutcome::Aborted {
                            last_turn_id: turn_id,
                            content: String::new(),
                            thinking: String::new(),
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
                    continue;
                }
                TurnStreamResult::Error { error, debug_info } => {
                    self.emitter.emit(RunEvent::TurnPhaseFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        phase: TurnPhase::Think,
                    });
                    self.emitter.emit(RunEvent::TurnFinished {
                        task_id: self.task_id.clone(),
                        turn_id: turn_id.clone(),
                        status: TurnStatus::Failed,
                        turn_index: Some(turn_index),
                        assistant_message_id: Some(self.assistant_message_id.clone()),
                        debug_info: if self.debug_mode { debug_info.clone() } else { None },
                        usage: None,
                        model: Some(self.model_config.model.clone()),
                    });
                    return TaskOutcome::Failed {
                        turn_id,
                        error,
                        debug_info: if self.debug_mode { debug_info } else { None },
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
                    return TaskOutcome::Aborted {
                        last_turn_id: turn_id,
                        content,
                        thinking,
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
        }
    }
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
    let debug_mode = config.general.debug_mode;
    // Debug: 在日志输出原始 SSE（仅流式请求）
    model_config.debug_sse = debug_mode;
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
            AgentType::Code => TaskKind::Code,
            AgentType::Solution => TaskKind::Solution,
            AgentType::Chat => TaskKind::Chat,
        },
        title: None,
    });

    // 4) TurnLoop：Chat = 单 Turn；Tool/Code = 多 Turn（上限可由 Agent 配置）
    // - 未配置时：Tool/Code 默认 10000（按你的需求），其他类型默认 1
    let default_max_turns: u32 = match agent.agent_type {
        AgentType::Tool | AgentType::Code => 10_000,
        _ => 1,
    };
    let max_turns: u32 = agent
        .max_turns
        .unwrap_or(default_max_turns)
        .max(1);

    // tools：按 Agent 选择工具集，并在这里完成“权限过滤 -> 传给模型的 ToolDefinition”
    // - 真实执行时仍会再次做权限检查（防止前端/模型绕过）
    let tool_services = ToolServices::default();
    let (tool_orchestrator, tools) = match agent.agent_type {
        AgentType::Tool | AgentType::Code => {
            // ToolSet：Agent 可以绑定不同工具集合；未配置则默认 allow_all（由权限再做过滤）。
            let toolset = match agent.toolset.as_deref().filter(|s| !s.trim().is_empty()) {
                Some(name) => match config.tools.toolsets.iter().find(|t| t.name == name) {
                    Some(ts) => super::tools::spec::ToolSet::allow_list(name, ts.tools.clone()),
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
                    })
                };

            let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig {
                toolset,
                permission_policy,
            });
            let specs = orchestrator.tool_specs_for_model();
            (Some(orchestrator), Some(tool_specs_to_definitions(&specs)))
        }
        _ => (None, None),
    };

    let mut turn_loop = TurnLoop {
        client,
        model_config: model_config.clone(),
        tools,
        tool_orchestrator,
        tool_services,
        runtime_messages: base_messages,
        conversation_id: input.conversation_id.clone(),
        task_id: task_id.clone(),
        assistant_message_id: assistant_message_id.clone(),
        output_format: output_format.clone(),
        max_turns,
        debug_mode,
        emitter: &mut emitter,
    };

    let outcome = turn_loop.run(&mut abort_rx).await;

    match outcome {
        TaskOutcome::Failed {
            turn_id,
            error,
            debug_info,
        } => {
            {
                let db = db.lock().await;
                let _ = db.update_message_status(
                    &user_message.id,
                    MessageStatus::Failed,
                    Some(error.clone()),
                );
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
        } => {
            {
                let db = db.lock().await;
                let _ = db.update_message_status(&user_message.id, MessageStatus::Success, None);
            }

            if !content.is_empty() || !thinking.is_empty() {
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
        } => {
            {
                let db = db.lock().await;
                let _ = db.update_message_status(&user_message.id, MessageStatus::Success, None);
            }

            if !content.is_empty() || !thinking.is_empty() {
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
            thinking: full_thinking,
            tool_calls: calls,
            debug_info,
            usage,
        };
    }

    if let Some(error) = last_error {
        return TurnStreamResult::Error { error, debug_info };
    }

    TurnStreamResult::Final {
        content: full_content,
        thinking: full_thinking,
        debug_info,
        usage,
    }
}
