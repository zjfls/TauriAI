//! Conversation commands for TauriAI

use crate::models::{
    Conversation, Message, MessageRole, MessageStatus, ModelConfig, ModelParameters,
};
use crate::runtime::RunState;
use crate::storage::Database;
use std::sync::Arc;
use tokio::sync::Mutex;

async fn collect_streamed_chat(
    client: Arc<dyn crate::ai_client::AiClient>,
    messages: Vec<Message>,
    config: ModelConfig,
) -> Result<(String, Option<String>), String> {
    use crate::ai_client::StreamEvent;
    use tokio::sync::mpsc;

    // Some providers (notably OpenAI Responses-compatible gateways) may return SSE even when
    // `stream=false`, so title generation must use the streaming interface.
    let (tx, mut rx) = mpsc::channel::<StreamEvent>(256);

    let handle = tokio::spawn({
        let client = client.clone();
        let config = config.clone();
        async move { client.chat_stream(messages, &config, None, tx).await }
    });

    let mut content_buf = String::new();
    let mut thinking_buf = String::new();
    let mut final_content: Option<String> = None;
    let mut final_thinking: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            StreamEvent::Token(t) => content_buf.push_str(&t),
            StreamEvent::Thinking(t) => thinking_buf.push_str(&t),
            StreamEvent::Done(content) => {
                final_content = Some(content);
                break;
            }
            StreamEvent::DoneWithThinking { content, thinking } => {
                final_content = Some(content);
                final_thinking = Some(thinking);
                break;
            }
            StreamEvent::DoneWithDebug {
                content,
                thinking,
                ..
            } => {
                final_content = Some(content);
                final_thinking = thinking;
                break;
            }
            StreamEvent::Error(err) => return Err(err),
            // Title generation should not involve tools.
            StreamEvent::ToolCalls(_) | StreamEvent::WebSearch { .. } => {
                return Err("Title generation received unexpected tool output".to_string());
            }
        }
    }

    // Ensure we don't miss errors that happen before any event is emitted.
    if let Ok(joined) = handle.await {
        if let Err(err) = joined {
            return Err(err.to_string());
        }
    }

    let mut content = final_content.unwrap_or(content_buf);
    let mut thinking = final_thinking.or_else(|| {
        let t = thinking_buf.trim();
        if t.is_empty() {
            None
        } else {
            Some(thinking_buf)
        }
    });

    // Fallback: some providers incorrectly put visible text in the thinking channel.
    if content.trim().is_empty() {
        if let Some(t) = thinking.take() {
            content = t;
        }
    }

    Ok((content, thinking))
}

#[tauri::command]
pub async fn get_conversations(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Conversation>, String> {
    let db = db.lock().await;
    db.get_conversations().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_messages(
    conversation_id: String,
    limit: Option<usize>,
    before_id: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Message>, String> {
    let db = db.lock().await;
    db.get_messages(&conversation_id, limit.unwrap_or(50), before_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    title: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Conversation, String> {
    let db = db.lock().await;
    db.create_conversation(&title.unwrap_or_else(|| "New Conversation".to_string()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.delete_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_messages_from(
    conversation_id: String,
    message_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    // 撤回/删除可能发生在流式生成中：先终止并等待退出，避免“删完又被写回”导致重启后消息错乱。
    run_state.abort_and_wait(&conversation_id, 5_000).await;

    let db = db.lock().await;
    db.delete_messages_after(&conversation_id, &message_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation_title(
    conversation_id: String,
    title: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.update_conversation_title(&conversation_id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation_metadata(
    conversation_id: String,
    agent_name: Option<String>,
    model_ref: Option<String>,
    thinking_mode: Option<serde_json::Value>,
    workstudio_id: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.update_conversation_metadata(
        &conversation_id,
        agent_name.as_deref(),
        model_ref.as_deref(),
        thinking_mode.as_ref(),
        workstudio_id.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_title(
    conversation_id: String,
    messages: Vec<Message>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<crate::config::ConfigManager>>,
) -> Result<String, String> {
    use crate::ai_client::get_client;

    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let (provider, model, _) = config
        .get_default_agent()
        .and_then(|a| config.resolve_agent(&a.name))
        .ok_or("No agent configured")?;

    let model_config = ModelConfig {
        id: format!("{}/{}", provider.name, model.name),
        name: model.name.clone(),
        provider: provider.provider_type.to_client_str().to_string(),
        api_base: Some(provider.api_base.clone()),
        api_key: provider.api_key.clone(),
        model: model.name.clone(),
        parameters: ModelParameters {
            temperature: Some(model.temperature),
            max_tokens: model.max_tokens,
            top_p: model.top_p,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        },
        thinking_level: None, // Don't use thinking for title generation
        thinking_budget_tokens: None,
        vision_enabled: false, // Don't need vision for title generation
        web_search_enabled: false, // Don't enable web search for title generation
	        max_images: None, // Not needed for title generation
	        use_reasoning_effort: None, // Not needed for title generation
	        retry_attempts: None,
	        debug_sse: false,
	        reinject_reasoning_content: false,
	    };

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;
    let content = messages
        .iter()
        .take(6)
        .map(|m| {
            format!(
                "{}: {}",
                match m.role {
                    MessageRole::User => "用户",
                    MessageRole::Assistant => "助手",
                    _ => "系统",
                },
                m.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: format!("根据对话生成简洁标题（不超20字）：\n{}", content),
        content_parts: Vec::new(),
        thinking: None,
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };
    let (raw_title, _thinking) =
        collect_streamed_chat(client, vec![prompt_message], model_config).await?;
    let title = raw_title.trim().trim_matches('"').to_string();
    {
        let db = db.lock().await;
        db.update_conversation_title(&conversation_id, &title)
            .map_err(|e| e.to_string())?;
    }
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use tokio::sync::mpsc;

    #[derive(Clone)]
    struct MockClient {
        events: Vec<crate::ai_client::StreamEvent>,
    }

    #[async_trait]
    impl crate::ai_client::AiClient for MockClient {
        async fn chat(
            &self,
            _messages: Vec<Message>,
            _config: &ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Err(crate::ai_client::AiError::InvalidResponse(
                "mock chat not implemented".to_string(),
            ))
        }

        async fn chat_stream(
            &self,
            _messages: Vec<Message>,
            _config: &ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
        ) -> Result<(), crate::ai_client::AiError> {
            for ev in self.events.clone() {
                token_sender
                    .send(ev)
                    .await
                    .map_err(|e| crate::ai_client::AiError::StreamError(e.to_string()))?;
            }
            Ok(())
        }
    }

	    fn dummy_model_config() -> ModelConfig {
	        ModelConfig {
            id: "test/test".to_string(),
            name: "test".to_string(),
            provider: "openai_compatible".to_string(),
            api_base: None,
            api_key: Some("test".to_string()),
            model: "test".to_string(),
            parameters: ModelParameters {
                temperature: Some(0.0),
                max_tokens: Some(32),
                top_p: Some(1.0),
                frequency_penalty: None,
                presence_penalty: None,
                system_prompt: None,
            },
            thinking_level: None,
            thinking_budget_tokens: None,
            vision_enabled: false,
            web_search_enabled: false,
	            max_images: None,
	            use_reasoning_effort: None,
	            retry_attempts: None,
	            debug_sse: false,
	            reinject_reasoning_content: false,
	        }
	    }

    #[tokio::test]
    async fn collect_streamed_chat_prefers_final_content() {
        let client = Arc::new(MockClient {
            events: vec![
                crate::ai_client::StreamEvent::Token("a".to_string()),
                crate::ai_client::StreamEvent::Token("b".to_string()),
                crate::ai_client::StreamEvent::DoneWithDebug {
                    content: "ab".to_string(),
                    thinking: None,
                    debug_info: None,
                    usage: None,
                },
            ],
        });

        let (content, thinking) =
            collect_streamed_chat(client, vec![], dummy_model_config()).await.unwrap();
        assert_eq!(content, "ab");
        assert!(thinking.is_none());
    }

    #[tokio::test]
    async fn collect_streamed_chat_falls_back_to_thinking_when_content_empty() {
        let client = Arc::new(MockClient {
            events: vec![crate::ai_client::StreamEvent::DoneWithDebug {
                content: "".to_string(),
                thinking: Some("标题".to_string()),
                debug_info: None,
                usage: None,
            }],
        });

        let (content, thinking) =
            collect_streamed_chat(client, vec![], dummy_model_config()).await.unwrap();
        assert_eq!(content, "标题");
        assert!(thinking.is_none());
    }
}
