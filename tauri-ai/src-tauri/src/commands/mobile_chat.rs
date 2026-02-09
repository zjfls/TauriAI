//! Mobile chat commands (mobile-first).
//!
//! - `mobile_chat`: 非流式（一次性返回，保留兼容）。
//! - `mobile_chat_stream_*`: 流式（推荐），通过 Tauri event 推送增量到前端。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;

use crate::ai_client::get_client;
use crate::ai_client::{StreamEvent, StreamOptions};
use crate::config::ConfigManager;
use crate::models::{AppConfig, Message, MessageRole, MessageStatus, ModelConfig, ModelParameters};
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileChatResponse {
    pub content: String,
}

#[derive(Debug)]
struct MobileStreamState {
    handle: tauri::async_runtime::JoinHandle<()>,
    conversation_id: String,
    assistant_message_id: String,
}

static MOBILE_STREAMS: OnceLock<Mutex<HashMap<String, MobileStreamState>>> = OnceLock::new();

fn mobile_streams() -> &'static Mutex<HashMap<String, MobileStreamState>> {
    MOBILE_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileChatStreamPayload {
    stream_id: String,
    conversation_id: String,
    assistant_message_id: String,
    kind: String, // delta | thinking | done | error | canceled
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_mobile_stream_event(
    app: &tauri::AppHandle,
    payload: MobileChatStreamPayload,
) {
    // AppHandle.emit 会广播到所有窗口；移动端通常只有 main。
    let _ = app.emit("mobile_chat_stream", payload);
}

fn resolve_provider_model(cfg: &AppConfig, agent_name: Option<&str>) -> Option<(String, String)> {
    // Highest priority: explicit agentName from the current conversation (mobile UI)
    if let Some(agent_name) = agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(agent) = cfg.agents.iter().find(|a| a.enabled && a.name == agent_name) {
            if let Some((p, m)) = agent.model_ref.split_once('/') {
                let p = p.trim();
                let m = m.trim();
                if !p.is_empty() && !m.is_empty() {
                    return Some((p.to_string(), m.to_string()));
                }
            }
        }
    }

    // Prefer explicit currentModelRef: "provider/model"
    if let Some(model_ref) = cfg.current_model_ref.as_deref().map(str::trim).filter(|s| !s.is_empty())
    {
        if let Some((p, m)) = model_ref.split_once('/') {
            let p = p.trim();
            let m = m.trim();
            if !p.is_empty() && !m.is_empty() {
                return Some((p.to_string(), m.to_string()));
            }
        }
    }

    // Next: current agent -> its modelRef
    if let Some(agent_name) = cfg
        .current_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(agent) = cfg.agents.iter().find(|a| a.enabled && a.name == agent_name) {
            if let Some((p, m)) = agent.model_ref.split_once('/') {
                let p = p.trim();
                let m = m.trim();
                if !p.is_empty() && !m.is_empty() {
                    return Some((p.to_string(), m.to_string()));
                }
            }
        }
    }

    // Next: default agent -> its modelRef
    if !cfg.default_agent.trim().is_empty() {
        if let Some(agent) = cfg
            .agents
            .iter()
            .find(|a| a.enabled && a.name == cfg.default_agent)
        {
            if let Some((p, m)) = agent.model_ref.split_once('/') {
                let p = p.trim();
                let m = m.trim();
                if !p.is_empty() && !m.is_empty() {
                    return Some((p.to_string(), m.to_string()));
                }
            }
        }
    }

    // Fallback: first enabled provider + first model.
    for p in &cfg.providers {
        if !p.enabled {
            continue;
        }
        if let Some(m) = p.models.first() {
            if !p.name.trim().is_empty() && !m.name.trim().is_empty() {
                return Some((p.name.clone(), m.name.clone()));
            }
        }
    }

    None
}

fn build_model_config(cfg: &AppConfig, provider_name: &str, model_name: &str) -> Result<ModelConfig, String> {
    let provider = cfg
        .providers
        .iter()
        .find(|p| p.name == provider_name)
        .ok_or_else(|| format!("找不到 provider：{}", provider_name))?;

    let model = provider
        .models
        .iter()
        .find(|m| m.name == model_name)
        .ok_or_else(|| format!("找不到模型：{} / {}", provider_name, model_name))?;

    let mut parameters = ModelParameters::default();
    parameters.temperature = if model.temperature_enabled {
        Some(model.temperature)
    } else {
        None
    };
    parameters.max_tokens = model.max_tokens;
    parameters.top_p = if model.top_p_enabled { model.top_p } else { None };

    Ok(ModelConfig {
        id: "mobile".to_string(),
        name: "mobile".to_string(),
        provider: provider.provider_type.to_client_str().to_string(),
        api_base: Some(provider.api_base.clone()),
        api_key: provider.api_key.clone(),
        model: model.name.clone(),
        parameters,
        thinking_level: None,
        thinking_budget_tokens: None,
        vision_enabled: model.capabilities.vision,
        web_search_enabled: model.capabilities.web_search,
        max_images: model.max_images.map(|v| v as u32),
        use_reasoning_effort: model.use_reasoning_effort,
        retry_attempts: model.retry_attempts,
        resume_partial_output: model.resume_partial_output,
        debug_sse: false,
        reinject_reasoning_content: model.reinject_reasoning_content,
    })
}

fn to_messages(messages: Vec<MobileChatMessage>) -> Vec<Message> {
    let now = chrono::Utc::now();
    messages
        .into_iter()
        .enumerate()
        .map(|(i, m)| Message {
            id: format!("mobile_{}", i),
            conversation_id: "mobile".to_string(),
            role: match m.role.as_str() {
                "assistant" => MessageRole::Assistant,
                "system" => MessageRole::System,
                _ => MessageRole::User,
            },
            content: m.content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        })
        .collect()
}

/// Simple mobile chat endpoint.
///
/// - Uses the current provider/model from config (currentModelRef) when available.
/// - Returns a complete response string (non-streaming).
#[tauri::command]
pub async fn mobile_chat(
    messages: Vec<MobileChatMessage>,
    agent_name: Option<String>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<MobileChatResponse, String> {
    let cfg = config_manager.ensure_default().map_err(|e| e.to_string())?;

    let (provider_name, model_name) = resolve_provider_model(&cfg, agent_name.as_deref()).ok_or_else(|| {
        "未配置 provider/model。请在 Settings 中设置 Provider、API Base、API Key（如需要）以及 Model。"
            .to_string()
    })?;

    let model_cfg = build_model_config(&cfg, &provider_name, &model_name)?;
    let client = get_client(&model_cfg.provider).map_err(|e| e.to_string())?;
    let msgs = to_messages(messages);

    let content = client
        .chat(msgs, &model_cfg, None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(MobileChatResponse { content })
}

/// Start a streaming chat request for mobile.
///
/// Frontend should:
/// 1) `listen("mobile_chat_stream", ...)`
/// 2) invoke `mobile_chat_stream_start(...)`
/// 3) append `delta` into the assistant message until `done/error/canceled`.
#[tauri::command]
pub async fn mobile_chat_stream_start(
    app: tauri::AppHandle,
    stream_id: String,
    conversation_id: String,
    assistant_message_id: String,
    messages: Vec<MobileChatMessage>,
    agent_name: Option<String>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let stream_id = stream_id.trim().to_string();
    if stream_id.is_empty() {
        return Err("streamId 不能为空".to_string());
    }

    // Resolve config/model before spawning, so we can return errors synchronously.
    let cfg = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let (provider_name, model_name) =
        resolve_provider_model(&cfg, agent_name.as_deref()).ok_or_else(|| {
            "未配置 provider/model。请在 Settings 中设置 Provider、API Base、API Key（如需要）以及 Model。"
                .to_string()
        })?;
    let model_cfg = build_model_config(&cfg, &provider_name, &model_name)?;
    let client = get_client(&model_cfg.provider).map_err(|e| e.to_string())?;
    let msgs = to_messages(messages);

    // Cancel previous stream with same id if exists.
    {
        let mut map = mobile_streams().lock().await;
        if let Some(prev) = map.remove(&stream_id) {
            prev.handle.abort();
            emit_mobile_stream_event(
                &app,
                MobileChatStreamPayload {
                    stream_id: stream_id.clone(),
                    conversation_id: prev.conversation_id,
                    assistant_message_id: prev.assistant_message_id,
                    kind: "canceled".to_string(),
                    delta: None,
                    content: None,
                    thinking: None,
                    error: None,
                },
            );
        }
    }

    let app2 = app.clone();
    let stream_id2 = stream_id.clone();
    let conversation_id2 = conversation_id.clone();
    let assistant_message_id2 = assistant_message_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<StreamEvent>(128);

        // 重要：不要额外 `tokio::spawn` 一个 chat_stream 任务，否则取消（abort）外层任务时，
        // chat_stream 仍可能继续跑，导致请求无法可靠取消、占用带宽/额度。
        //
        // 这里在同一个任务里同时：
        // - 轮询 chat_stream future
        // - 消费 mpsc 里的 StreamEvent
        //
        // 这样 abort 当前 JoinHandle 时，HTTP 请求/流解析会一起被取消（future 被 drop）。
        let mut stream_fut = Box::pin({
            let client = client.clone();
            let model_cfg = model_cfg.clone();
            async move { client.chat_stream(msgs, &model_cfg, None, tx, StreamOptions::default()).await }
        });

        let mut content_buf = String::new();
        let mut thinking_buf = String::new();
        let mut final_content: Option<String> = None;
        let mut final_thinking: Option<String> = None;
        // Some("done") | Some("error") | None
        let mut terminal: Option<&'static str> = None;

        loop {
            tokio::select! {
                // 优先消费事件，确保 channel 不会堆积导致 send 卡住。
                maybe_ev = rx.recv() => {
                    let Some(ev) = maybe_ev else { break; };
                    match ev {
                        StreamEvent::Token(t) => {
                            content_buf.push_str(&t);
                            emit_mobile_stream_event(
                                &app2,
                                MobileChatStreamPayload {
                                    stream_id: stream_id2.clone(),
                                    conversation_id: conversation_id2.clone(),
                                    assistant_message_id: assistant_message_id2.clone(),
                                    kind: "delta".to_string(),
                                    delta: Some(t),
                                    content: None,
                                    thinking: None,
                                    error: None,
                                },
                            );
                        }
                        StreamEvent::Thinking(t) => {
                            thinking_buf.push_str(&t);
                            emit_mobile_stream_event(
                                &app2,
                                MobileChatStreamPayload {
                                    stream_id: stream_id2.clone(),
                                    conversation_id: conversation_id2.clone(),
                                    assistant_message_id: assistant_message_id2.clone(),
                                    kind: "thinking".to_string(),
                                    delta: Some(t),
                                    content: None,
                                    thinking: None,
                                    error: None,
                                },
                            );
                        }
                        StreamEvent::Done(content) => {
                            final_content = Some(content);
                            terminal = Some("done");
                            break;
                        }
                        StreamEvent::DoneWithThinking { content, thinking } => {
                            final_content = Some(content);
                            final_thinking = Some(thinking);
                            terminal = Some("done");
                            break;
                        }
                        StreamEvent::DoneWithDebug { content, thinking, .. } => {
                            final_content = Some(content);
                            final_thinking = thinking;
                            terminal = Some("done");
                            break;
                        }
                        StreamEvent::Error(err) => {
                            emit_mobile_stream_event(
                                &app2,
                                MobileChatStreamPayload {
                                    stream_id: stream_id2.clone(),
                                    conversation_id: conversation_id2.clone(),
                                    assistant_message_id: assistant_message_id2.clone(),
                                    kind: "error".to_string(),
                                    delta: None,
                                    content: None,
                                    thinking: None,
                                    error: Some(err),
                                },
                            );
                            terminal = Some("error");
                            break;
                        }
                        StreamEvent::TurnState(_) => {}
                        StreamEvent::ToolCalls(_) | StreamEvent::WebSearch { .. } => {
                            emit_mobile_stream_event(
                                &app2,
                                MobileChatStreamPayload {
                                    stream_id: stream_id2.clone(),
                                    conversation_id: conversation_id2.clone(),
                                    assistant_message_id: assistant_message_id2.clone(),
                                    kind: "error".to_string(),
                                    delta: None,
                                    content: None,
                                    thinking: None,
                                    error: Some("移动端流式暂不支持工具调用/网页搜索输出。".to_string()),
                                },
                            );
                            terminal = Some("error");
                            break;
                        }
                    }
                }
                stream_res = &mut stream_fut => {
                    if let Err(err) = stream_res {
                        if terminal != Some("done") && terminal != Some("error") {
                            emit_mobile_stream_event(
                                &app2,
                                MobileChatStreamPayload {
                                    stream_id: stream_id2.clone(),
                                    conversation_id: conversation_id2.clone(),
                                    assistant_message_id: assistant_message_id2.clone(),
                                    kind: "error".to_string(),
                                    delta: None,
                                    content: None,
                                    thinking: None,
                                    error: Some(err.to_string()),
                                },
                            );
                            terminal = Some("error");
                        }
                    }
                    break;
                }
            }
        }

        match terminal {
            None => {
                // 容错：如果流被关闭但已经拿到内容，按 done 处理；否则报错。
                let content_trimmed = content_buf.trim();
                let thinking_trimmed = thinking_buf.trim();
                if !content_trimmed.is_empty() || !thinking_trimmed.is_empty() {
                    let thinking = if thinking_trimmed.is_empty() {
                        None
                    } else {
                        Some(thinking_buf)
                    };
                    emit_mobile_stream_event(
                        &app2,
                        MobileChatStreamPayload {
                            stream_id: stream_id2.clone(),
                            conversation_id: conversation_id2.clone(),
                            assistant_message_id: assistant_message_id2.clone(),
                            kind: "done".to_string(),
                            delta: None,
                            content: Some(content_buf),
                            thinking,
                            error: None,
                        },
                    );
                } else {
                    emit_mobile_stream_event(
                        &app2,
                        MobileChatStreamPayload {
                            stream_id: stream_id2.clone(),
                            conversation_id: conversation_id2.clone(),
                            assistant_message_id: assistant_message_id2.clone(),
                            kind: "error".to_string(),
                            delta: None,
                            content: None,
                            thinking: None,
                            error: Some("流式响应提前结束（未收到 Done/Error）".to_string()),
                        },
                    );
                }
            }
            Some("error") => {
                // Error already emitted; do not send done.
            }
            Some("done") => {
                let thinking = final_thinking.or_else(|| {
                    let t = thinking_buf.trim();
                    if t.is_empty() {
                        None
                    } else {
                        Some(thinking_buf)
                    }
                });
                let content = final_content.take().unwrap_or(content_buf);
                emit_mobile_stream_event(
                    &app2,
                    MobileChatStreamPayload {
                        stream_id: stream_id2.clone(),
                        conversation_id: conversation_id2.clone(),
                        assistant_message_id: assistant_message_id2.clone(),
                        kind: "done".to_string(),
                        delta: None,
                        content: Some(content),
                        thinking,
                        error: None,
                    },
                );
            }
            _ => {}
        }

        // Remove state after completion.
        mobile_streams().lock().await.remove(&stream_id2);
    });

    mobile_streams().lock().await.insert(
        stream_id.clone(),
        MobileStreamState {
            handle,
            conversation_id,
            assistant_message_id,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn mobile_chat_stream_cancel(
    app: tauri::AppHandle,
    stream_id: String,
) -> Result<(), String> {
    let stream_id = stream_id.trim().to_string();
    if stream_id.is_empty() {
        return Ok(());
    }

    let prev = mobile_streams().lock().await.remove(&stream_id);
    if let Some(prev) = prev {
        prev.handle.abort();
        emit_mobile_stream_event(
            &app,
            MobileChatStreamPayload {
                stream_id,
                conversation_id: prev.conversation_id,
                assistant_message_id: prev.assistant_message_id,
                kind: "canceled".to_string(),
                delta: None,
                content: None,
                thinking: None,
                error: None,
            },
        );
    }

    Ok(())
}
