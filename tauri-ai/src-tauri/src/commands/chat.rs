//! Chat commands for TauriAI

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::ai_client::{get_client, StreamEvent};
use crate::config::ConfigManager;
use crate::errors::{AppErrorCode, SerializableError};
use crate::models::{Message, MessageRole, MessageStatus, ModelConfig, ModelParameters};
use crate::prompts::compose_system_prompt;
use crate::storage::Database;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTokenPayload {
    pub conversation_id: String,
    pub token: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamThinkingPayload {
    pub conversation_id: String,
    pub token: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDonePayload {
    pub conversation_id: String,
    pub full_content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_info: Option<DebugInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Token usage statistics
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
}

/// Debug information for HTTP request/response
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    pub request: Option<DebugRequest>,
    pub response: Option<DebugResponse>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: serde_json::Value,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: serde_json::Value,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamErrorPayload {
    pub conversation_id: String,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_info: Option<DebugInfo>,
}

pub struct ChatState {
    abort_senders: RwLock<HashMap<String, mpsc::Sender<()>>>,
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            abort_senders: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for ChatState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    conversation_id: String,
    content: String,
    agent_name: Option<String>,
    model_ref: Option<String>,
    enable_thinking: Option<bool>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    chat_state: tauri::State<'_, Arc<ChatState>>,
) -> Result<(), SerializableError> {
    let config = config_manager
        .ensure_default()
        .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    // Resolve model: prefer model_ref over agent's default model
    let (provider, model, agent) = if let Some(ref model_ref_str) = model_ref {
        // Parse model_ref "provider/model" and find the model directly
        let (provider_name, model_name) = crate::models::AppConfig::parse_model_ref(model_ref_str)
            .ok_or_else(|| AppErrorCode::ModelConfigMissing)?;

        let provider = config
            .get_provider(provider_name)
            .ok_or_else(|| AppErrorCode::ModelConfigMissing)?;
        let model = provider
            .models
            .iter()
            .find(|m| m.name == model_name)
            .ok_or_else(|| AppErrorCode::ModelConfigMissing)?;

        // Get agent for system prompt (use specified agent or default)
        let agent_name_str = agent_name.unwrap_or_else(|| config.default_agent.clone());
        let agent = config
            .get_agent(&agent_name_str)
            .or_else(|| config.get_default_agent())
            .ok_or_else(|| AppErrorCode::ModelConfigMissing)?;

        (provider, model, agent)
    } else {
        // Fallback to agent-based resolution
        let agent_name_str = agent_name.unwrap_or_else(|| config.default_agent.clone());
        config
            .resolve_agent(&agent_name_str)
            .ok_or_else(|| AppErrorCode::ModelConfigMissing)?
    };

    if !provider.enabled {
        return Err(AppErrorCode::AiServiceError(format!(
            "Provider '{}' is disabled",
            provider.display_name
        ))
        .into());
    }

    let model_config = ModelConfig {
        id: format!("{}/{}", provider.name, model.name),
        name: model.name.clone(),
        provider: provider.provider_type.to_client_str().to_string(),
        api_base: Some(provider.api_base.clone()),
        api_key: provider.api_key.clone(),
        model: model.name.clone(),
        parameters: ModelParameters {
            temperature: model.temperature,
            max_tokens: model.max_tokens,
            top_p: model.top_p,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        },
        // Thinking mode control:
        // - If model supports thinking: Some(user_choice) to enable/disable
        // - If model doesn't support thinking: None (don't send parameter)
        thinking_enabled: if model.capabilities.thinking {
            Some(enable_thinking.unwrap_or(true))
        } else {
            None
        },
    };

    let client = get_client(&model_config.provider)
        .map_err(|e| AppErrorCode::AiServiceError(e.to_string()))?;

    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: content.clone(),
        meta: None,
        created_at: chrono::Utc::now(),
        status: crate::models::MessageStatus::Pending,
        error_message: None,
    };

    {
        let db = db.lock().await;
        db.add_message(&conversation_id, &user_message)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    }

    let mut messages = {
        let db = db.lock().await;
        db.get_messages(&conversation_id, 100, None)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?
            .into_iter()
            .filter(|m| m.status == MessageStatus::Success || m.id == user_message.id)
            .collect::<Vec<_>>()
    };

    let base_prompt = if agent.system_prompt.is_empty() {
        None
    } else {
        Some(agent.system_prompt.as_str())
    };
    if let Some(system_content) = compose_system_prompt(base_prompt, agent.format_type) {
        let system_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: MessageRole::System,
            content: system_content,
            meta: None,
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };
        messages.insert(0, system_message);
    }

    let (abort_tx, mut abort_rx) = mpsc::channel::<()>(1);
    {
        let mut senders = chat_state.abort_senders.write().await;
        senders.insert(conversation_id.clone(), abort_tx);
    }

    let (token_tx, mut token_rx) = mpsc::channel::<StreamEvent>(100);
    let conv_id = conversation_id.clone();
    let app_handle = app.clone();
    let db_clone = db.inner().clone();
    let model_name = model_config.model.clone();

    let stream_handle =
        tokio::spawn(async move { client.chat_stream(messages, &model_config, token_tx).await });

    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut debug_info: Option<DebugInfo> = None;
    let mut usage: Option<TokenUsage> = None;
    let mut last_error: Option<String> = None;
    loop {
        tokio::select! {
            _ = abort_rx.recv() => { stream_handle.abort(); break; }
            event = token_rx.recv() => {
                match event {
                    Some(StreamEvent::Token(token)) => {
                        full_content.push_str(&token);
                        let _ = app_handle.emit("chat:token", StreamTokenPayload { conversation_id: conv_id.clone(), token });
                    }
                    Some(StreamEvent::Thinking(token)) => {
                        full_thinking.push_str(&token);
                        let _ = app_handle.emit("chat:thinking", StreamThinkingPayload { conversation_id: conv_id.clone(), token });
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
                        // Convert debug info from traits types to chat types
                        debug_info = di.map(|d| DebugInfo {
                            request: d.request.map(|r| DebugRequest {
                                url: r.url,
                                method: r.method,
                                headers: r.headers,
                                body: r.body,
                            }),
                            response: d.response.map(|r| DebugResponse {
                                status: r.status,
                                headers: r.headers,
                                body: r.body,
                            }),
                        });
                        // Convert usage from traits types to chat types
                        usage = u.map(|u| TokenUsage {
                            prompt_tokens: u.prompt_tokens,
                            completion_tokens: u.completion_tokens,
                            total_tokens: u.total_tokens,
                            cached_tokens: u.cached_tokens,
                            reasoning_tokens: u.reasoning_tokens,
                            cache_creation_input_tokens: u.cache_creation_input_tokens,
                            cache_read_input_tokens: u.cache_read_input_tokens,
                        });
                        break;
                    }
                    Some(StreamEvent::Error(error)) => {
                        last_error = Some(error);
                        // Don't break yet - wait for potential DoneWithDebug that may have debug info
                    }
                    None => break,
                }
            }
        }
    }

    {
        let mut senders = chat_state.abort_senders.write().await;
        senders.remove(&conv_id);
    }

    // If there was an error, emit error event with debug info
    if let Some(ref error) = last_error {
        println!(
            "[DEBUG] Emitting chat:error event: conv_id={}, error={}",
            conv_id, error
        );

        // Update user message status to Failed
        let db = db_clone.lock().await;
        let _ =
            db.update_message_status(&user_message.id, MessageStatus::Failed, Some(error.clone()));

        let _ = app.emit(
            "chat:error",
            StreamErrorPayload {
                conversation_id: conv_id.clone(),
                error: error.clone(),
                debug_info: debug_info.clone(),
            },
        );
        return Ok(());
    }

    // Update user message status to Success
    {
        let db = db_clone.lock().await;
        let _ = db.update_message_status(&user_message.id, MessageStatus::Success, None);
    }

    if !full_content.is_empty() {
        let assistant_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv_id.clone(),
            role: MessageRole::Assistant,
            content: full_content.clone(),
            meta: Some(crate::models::MessageMeta {
                model: Some(model_name.clone()),
                tokens: None,
                duration: None,
            }),
            created_at: chrono::Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };
        let db = db_clone.lock().await;
        db.add_message(&conv_id, &assistant_message)
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;
    }

    let _ = app.emit(
        "chat:done",
        StreamDonePayload {
            conversation_id: conv_id,
            full_content,
            thinking: if full_thinking.is_empty() {
                None
            } else {
                Some(full_thinking)
            },
            debug_info,
            usage,
            model: Some(model_name),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn abort_chat(
    conversation_id: String,
    chat_state: tauri::State<'_, Arc<ChatState>>,
) -> Result<(), String> {
    let senders = chat_state.abort_senders.read().await;
    if let Some(sender) = senders.get(&conversation_id) {
        sender.send(()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
