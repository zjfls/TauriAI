//! 通用任务入口（run_task）
//!
//! 这层是 Tauri command 层：
//! - 参数接入（前端 invoke）
//! - DB 读写（消息与会话）
//! - 调用 agent / ai_client
//! - 统一事件流输出（`run:event`）
//!
//! 关键抽象：
//! - Task：一次用户请求
//! - Turn：Task 内部一次 ReAct 循环（Think→Act→Observe）
//!   - 当前 Chat 任务等价于“单 Task + 单 Turn + 仅模型生成”
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use crate::agents::chat::{
    build_model_config, build_request_messages, get_output_format, resolve_chat_model,
};
use crate::ai_client::{get_client, StreamEvent};
use crate::config::ConfigManager;
use crate::errors::{AppErrorCode, SerializableError};
use crate::models::{ContentPart, Message, MessageMeta, MessageRole, MessageStatus};
use crate::runtime::events::{RunEvent, RunEventPayload, RUN_EVENT_NAME};
use crate::runtime::types::{TaskKind, TurnStatus};
use crate::storage::Database;

use super::RunState;

#[tauri::command]
pub async fn run_task(
    app: AppHandle,
    conversation_id: String,
    message_id: Option<String>,
    content: String,
    content_parts: Option<Vec<ContentPart>>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    thinking: Option<serde_json::Value>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), SerializableError> {
    let config = config_manager
        .ensure_default()
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    // run_id：一次调用的追踪 ID
    // task_id：一次用户请求（Task）
    // turn_id：一次 ReAct 循环（Turn）
    // assistant_message_id：本次 assistant 输出对应的稳定 messageId（用于撤回/重放/重启恢复）
    let run_id = uuid::Uuid::new_v4().to_string();
    let task_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    let assistant_message_id = uuid::Uuid::new_v4().to_string();

    let resolved = resolve_chat_model(&config, agent_name.as_deref(), model_ref.as_deref())?;
    let (provider, model, agent) = (resolved.provider, resolved.model, resolved.agent);
    let output_format = get_output_format(agent);

    if !provider.enabled {
        return Err(AppErrorCode::AiServiceError(format!(
            "Provider '{}' is disabled",
            provider.display_name
        ))
        .into());
    }

    let model_config = build_model_config(provider, model, thinking);

    let client = get_client(&model_config.provider)
        .map_err(|e| AppErrorCode::AiServiceError(e.to_string()))?;

    let user_message = Message {
        id: message_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: content.clone(),
        content_parts: content_parts.unwrap_or_default(),
        thinking: None,
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Pending,
        error_message: None,
    };

    {
        let db = db.lock().await;
        db.add_message(&conversation_id, &user_message)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    }

    let messages = {
        let db = db.lock().await;
        db.get_messages(&conversation_id, 100, None)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
            .into_iter()
            .filter(|m| m.status == MessageStatus::Success || m.id == user_message.id)
            .collect::<Vec<_>>()
    };

    let messages = build_request_messages(messages, &conversation_id, agent);

    // 允许 stop/撤回 等并发操作中断当前 run。
    let (abort_tx, mut abort_rx) = mpsc::channel::<()>(1);
    {
        let mut senders = run_state.abort_senders.write().await;
        senders.insert(conversation_id.clone(), abort_tx);
    }
    // 注册 completion notifier：撤回/删除/stop 可以等待 run 完整退出，避免并发写回导致状态错乱。
    run_state.register_run(&conversation_id).await;

    let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);
    let conv_id = conversation_id.clone();
    let app_handle = app.clone();
    let db_clone = db.inner().clone();
    let model_name = model_config.model.clone();
    let run_id_clone = run_id.clone();
    let task_id_clone = task_id.clone();
    let turn_id_clone = turn_id.clone();
    let assistant_message_id_clone = assistant_message_id.clone();
    let output_format_clone = output_format.clone();

    // lifecycle：Task/Turn 开始
    let mut seq: u64 = 0;
    seq += 1;
    let _ = app_handle.emit(
        RUN_EVENT_NAME,
        RunEventPayload {
            conversation_id: conv_id.clone(),
            run_id: run_id_clone.clone(),
            seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event: RunEvent::TaskStarted {
                task_id: task_id_clone.clone(),
                task_kind: TaskKind::Chat,
                title: None,
            },
        },
    );
    seq += 1;
    let _ = app_handle.emit(
        RUN_EVENT_NAME,
        RunEventPayload {
            conversation_id: conv_id.clone(),
            run_id: run_id_clone.clone(),
            seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event: RunEvent::TurnStarted {
                task_id: task_id_clone.clone(),
                turn_id: turn_id_clone.clone(),
                turn_index: 1,
            },
        },
    );

    let stream_handle =
        tokio::spawn(async move { client.chat_stream(messages, &model_config, token_tx).await });

    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut debug_info = None;
    let mut usage = None;
    let mut last_error: Option<String> = None;

    loop {
        tokio::select! {
            _ = abort_rx.recv() => { stream_handle.abort(); break; }
            event = token_rx.recv() => {
                match event {
                    Some(StreamEvent::Token(token)) => {
                        full_content.push_str(&token);

                        seq += 1;
                        let _ = app_handle.emit(
                            RUN_EVENT_NAME,
                            RunEventPayload {
                                conversation_id: conv_id.clone(),
                                run_id: run_id_clone.clone(),
                                seq,
                                timestamp_ms: chrono::Utc::now().timestamp_millis(),
                                event: RunEvent::BlockDelta {
                                    task_id: task_id_clone.clone(),
                                    turn_id: turn_id_clone.clone(),
                                    assistant_message_id: Some(assistant_message_id_clone.clone()),
                                    block_id: "assistant_text".to_string(),
                                    block_type: "text".to_string(),
                                    format: output_format_clone.clone(),
                                    delta: token,
                                },
                            },
                        );
                    }
                    Some(StreamEvent::Thinking(token)) => {
                        full_thinking.push_str(&token);

                        seq += 1;
                        let _ = app_handle.emit(
                            RUN_EVENT_NAME,
                            RunEventPayload {
                                conversation_id: conv_id.clone(),
                                run_id: run_id_clone.clone(),
                                seq,
                                timestamp_ms: chrono::Utc::now().timestamp_millis(),
                                event: RunEvent::BlockDelta {
                                    task_id: task_id_clone.clone(),
                                    turn_id: turn_id_clone.clone(),
                                    assistant_message_id: Some(assistant_message_id_clone.clone()),
                                    block_id: "assistant_thinking".to_string(),
                                    block_type: "thinking".to_string(),
                                    format: Some("plain".to_string()),
                                    delta: token,
                                },
                            },
                        );
                    }
                    Some(StreamEvent::Done(content)) => { full_content = content; break; }
                    Some(StreamEvent::DoneWithThinking { content, thinking }) => {
                        full_content = content;
                        full_thinking = thinking;
                        break;
                    }
                    Some(StreamEvent::DoneWithDebug { content, thinking, debug_info: di, usage: u }) => {
                        full_content = content;
                        if let Some(t) = thinking {
                            full_thinking = t;
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

    {
        let mut senders = run_state.abort_senders.write().await;
        senders.remove(&conv_id);
    }

    // Error path
    if let Some(ref error) = last_error {
        let db = db_clone.lock().await;
        let _ = db.update_message_status(&user_message.id, MessageStatus::Failed, Some(error.clone()));

        seq += 1;
        let _ = app.emit(
            RUN_EVENT_NAME,
            RunEventPayload {
                conversation_id: conv_id.clone(),
                run_id: run_id.clone(),
                seq,
                timestamp_ms: chrono::Utc::now().timestamp_millis(),
                event: RunEvent::TurnFinished {
                    task_id: task_id.clone(),
                    turn_id: turn_id.clone(),
                    status: TurnStatus::Failed,
                },
            },
        );

        seq += 1;
        let _ = app.emit(
            RUN_EVENT_NAME,
            RunEventPayload {
                conversation_id: conv_id.clone(),
                run_id,
                seq,
                timestamp_ms: chrono::Utc::now().timestamp_millis(),
                event: RunEvent::Error {
                    task_id: Some(task_id),
                    turn_id: Some(turn_id),
                    assistant_message_id: Some(assistant_message_id),
                    error: error.clone(),
                    debug_info,
                },
            },
        );
        run_state.finish_run(&conv_id).await;
        return Ok(());
    }

    // Success path
    {
        let db = db_clone.lock().await;
        let _ = db.update_message_status(&user_message.id, MessageStatus::Success, None);
    }

    if !full_content.is_empty() || !full_thinking.is_empty() {
        let assistant_message = Message {
            id: assistant_message_id.clone(),
            conversation_id: conv_id.clone(),
            role: MessageRole::Assistant,
            content: full_content.clone(),
            content_parts: Vec::new(),
            thinking: if full_thinking.is_empty() {
                None
            } else {
                Some(full_thinking.clone())
            },
            meta: Some(MessageMeta {
                model: Some(model_name.clone()),
                tokens: None,
                duration: None,
            }),
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };

        let db = db_clone.lock().await;
        db.add_message(&conv_id, &assistant_message)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    }

    seq += 1;
    let _ = app.emit(
        RUN_EVENT_NAME,
        RunEventPayload {
            conversation_id: conv_id.clone(),
            run_id: run_id.clone(),
            seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event: RunEvent::TurnFinished {
                task_id: task_id.clone(),
                turn_id: turn_id.clone(),
                status: TurnStatus::Success,
            },
        },
    );

    seq += 1;
    let _ = app.emit(
        RUN_EVENT_NAME,
        RunEventPayload {
            conversation_id: conv_id.clone(),
            run_id,
            seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event: RunEvent::Done {
                task_id,
                turn_id,
                assistant_message_id: Some(assistant_message_id),
                full_content,
                format: output_format,
                thinking: if full_thinking.is_empty() {
                    None
                } else {
                    Some(full_thinking)
                },
                debug_info,
                usage,
                model: Some(model_name),
            },
        },
    );

    run_state.finish_run(&conv_id).await;
    Ok(())
}

#[tauri::command]
pub async fn abort_run(
    conversation_id: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    // Best-effort：abort + wait，确保 stream fully 退出（避免并发写入导致状态错乱）
    run_state.abort_and_wait(&conversation_id, 5_000).await;
    Ok(())
}

