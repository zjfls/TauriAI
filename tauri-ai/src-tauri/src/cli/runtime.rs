use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::agents::chat::resolve_chat_model;
use crate::config::ConfigManager;
use crate::errors::SerializableError;
use crate::models::{AgentType, AppConfig, Conversation, Message, MessageRole};
use crate::runtime::approvals::ApprovalDecision;
use crate::runtime::emitter::RunEventCallback;
use crate::runtime::events::RunEventPayload;
use crate::runtime::task_runner::{run_task_with_event_callback, RunTaskInput};
use crate::runtime::RunState;
use crate::storage::async_db;
use crate::storage::Database;

#[derive(Debug, Clone, Default)]
pub struct SessionPreferences {
    pub agent_name: Option<String>,
    pub model_ref: Option<String>,
    pub run_mode: Option<String>,
    pub thinking: Option<Value>,
    pub web_search_provider: Option<String>,
    pub debug_mode: Option<bool>,
}

impl SessionPreferences {
    pub fn from_chat_args(args: &super::args::ChatArgs) -> Self {
        Self {
            agent_name: args.agent.clone(),
            model_ref: args.model_ref.clone(),
            run_mode: args.run_mode.clone(),
            thinking: normalize_thinking(args.thinking.as_deref()),
            web_search_provider: normalize_web_search_provider(args.web_search_provider.as_deref()),
            debug_mode: Some(args.debug_mode),
        }
    }

    pub fn apply_missing_from_conversation(&mut self, conversation: &Conversation) {
        if self.agent_name.is_none() {
            self.agent_name = conversation.agent_name.clone();
        }
        if self.model_ref.is_none() {
            self.model_ref = conversation.model_ref.clone();
        }
        if self.run_mode.is_none() {
            self.run_mode = conversation.run_mode.clone();
        }
        if self.thinking.is_none() {
            self.thinking = conversation.thinking_mode.clone();
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionState {
    pub conversation: Conversation,
    pub preferences: SessionPreferences,
}

impl SessionState {
    pub fn conversation_id(&self) -> &str {
        &self.conversation.id
    }

    pub fn title(&self) -> &str {
        &self.conversation.title
    }
}

#[derive(Debug, Clone)]
pub struct AgentChoice {
    pub name: String,
    pub display_name: String,
    pub model_ref: String,
}

#[derive(Debug, Clone)]
pub struct ModelChoice {
    pub model_ref: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct RunFinished {
    pub result: Result<(), String>,
    pub conversation: Option<Conversation>,
}

#[derive(Clone)]
pub enum RuntimeEvent {
    Run(RunEventPayload),
    Finished(RunFinished),
}

#[derive(Clone)]
pub struct CliRuntime {
    db: Arc<Mutex<Database>>,
    config_manager: Arc<ConfigManager>,
    run_state: Arc<RunState>,
}

impl CliRuntime {
    pub async fn new() -> Result<Self, String> {
        let db_path = default_db_path();
        let db = Database::new(db_path.clone())
            .map_err(|e| format!("初始化 DB 失败（{}）: {e}", db_path.display()))?;
        let config_manager = Arc::new(ConfigManager::new().map_err(|e| e.to_string())?);
        let _ = config_manager.ensure_default().map_err(|e| e.to_string())?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            config_manager,
            run_state: Arc::new(RunState::new()),
        })
    }

    pub async fn config(&self) -> Result<AppConfig, String> {
        self.config_manager
            .ensure_default()
            .map_err(|e| e.to_string())
    }

    pub async fn list_conversations(&self, limit: usize) -> Result<Vec<Conversation>, String> {
        let mut conversations = async_db::with_db(&self.db, "cli:list_conversations", |db| {
            db.get_conversations()
        })
        .await
        .map_err(|e| e.to_string())?;
        let keep = limit.max(1);
        if conversations.len() > keep {
            conversations.truncate(keep);
        }
        Ok(conversations)
    }

    pub async fn list_agents(&self) -> Result<Vec<AgentChoice>, String> {
        let config = self.config().await?;
        let mut agents = config
            .agents
            .iter()
            .filter(|agent| agent.enabled && !agent.name.starts_with("__"))
            .filter(|agent| !matches!(agent.agent_type, AgentType::TaskAgent))
            .map(|agent| AgentChoice {
                name: agent.name.clone(),
                display_name: if agent.display_name.trim().is_empty() {
                    agent.name.clone()
                } else {
                    agent.display_name.clone()
                },
                model_ref: agent.model_ref.clone(),
            })
            .collect::<Vec<_>>();
        agents.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        Ok(agents)
    }

    pub async fn list_models(&self) -> Result<Vec<ModelChoice>, String> {
        let config = self.config().await?;
        let mut models = Vec::new();
        for provider in config.providers.iter().filter(|provider| provider.enabled) {
            for model in &provider.models {
                let model_ref = format!("{}/{}", provider.name, model.name);
                models.push(ModelChoice {
                    label: format!("{} / {}", provider.display_name, model.name),
                    model_ref,
                });
            }
        }
        models.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(models)
    }

    pub async fn open_session(
        &self,
        requested_id: Option<&str>,
        create_new: bool,
        title: Option<&str>,
        mut preferences: SessionPreferences,
    ) -> Result<SessionState, String> {
        let conversation = if create_new {
            self.create_conversation(title).await?
        } else if let Some(conversation_id) = requested_id {
            if let Some(existing) = self.try_load_conversation(conversation_id).await? {
                existing
            } else {
                return Err(format!("Conversation not found: {conversation_id}"));
            }
        } else {
            self.create_conversation(title).await?
        };

        preferences.apply_missing_from_conversation(&conversation);
        self.persist_preferences(&conversation.id, &preferences)
            .await?;
        let conversation = self.load_conversation(&conversation.id).await?;

        Ok(SessionState {
            conversation,
            preferences,
        })
    }

    pub async fn refresh_session(&self, session: &mut SessionState) -> Result<(), String> {
        session.conversation = self.load_conversation(&session.conversation.id).await?;
        session
            .preferences
            .apply_missing_from_conversation(&session.conversation);
        Ok(())
    }

    pub async fn load_messages(&self, conversation_id: &str) -> Result<Vec<Message>, String> {
        async_db::read_all_messages(&self.db, "cli:load_messages", conversation_id)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn rename_conversation(
        &self,
        conversation_id: &str,
        title: &str,
    ) -> Result<Conversation, String> {
        async_db::with_db(&self.db, "cli:rename_conversation", |db| {
            db.update_conversation_title(conversation_id, title)
        })
        .await
        .map_err(|e| e.to_string())?;
        self.load_conversation(conversation_id).await
    }

    pub async fn clone_conversation(&self, conversation_id: &str) -> Result<Conversation, String> {
        async_db::with_db(&self.db, "cli:clone_conversation", |db| {
            db.clone_conversation(conversation_id)
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn conversation_from_target(&self, target: &str) -> Result<Conversation, String> {
        if let Ok(index) = target.trim().parse::<usize>() {
            let conversations = self.list_conversations(200).await?;
            if index == 0 || index > conversations.len() {
                return Err(format!("Conversation index out of range: {index}"));
            }
            return Ok(conversations[index - 1].clone());
        }

        self.try_load_conversation(target)
            .await?
            .ok_or_else(|| format!("Conversation not found: {target}"))
    }

    pub async fn resolve_session_summary(&self, session: &SessionState) -> Result<String, String> {
        let config = self.config().await?;
        let mut prefs = session.preferences.clone();
        prefs.apply_missing_from_conversation(&session.conversation);
        let resolved = resolve_chat_model(
            &config,
            prefs.agent_name.as_deref(),
            prefs.model_ref.as_deref(),
        )
        .map_err(|e| format!("模型解析失败: {e:?}"))?;
        let thinking = prefs
            .thinking
            .as_ref()
            .map(display_thinking)
            .unwrap_or_else(|| "default".to_string());
        let run_mode = prefs.run_mode.clone().unwrap_or_else(|| {
            resolved
                .agent
                .default_run_mode
                .clone()
                .unwrap_or_else(|| "chat".to_string())
        });
        let web_search = prefs
            .web_search_provider
            .clone()
            .unwrap_or_else(|| "off".to_string());

        Ok(format!(
            "{} | agent={} | model={} | run_mode={} | thinking={} | search={}",
            session.conversation.title,
            resolved.agent.display_name,
            format!("{}/{}", resolved.provider.display_name, resolved.model.name),
            run_mode,
            thinking,
            web_search,
        ))
    }

    pub async fn submit(
        &self,
        session: &SessionState,
        prompt: String,
        event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    ) -> Result<(), String> {
        self.persist_preferences(session.conversation_id(), &session.preferences)
            .await?;

        let db = self.db.clone();
        let config_manager = self.config_manager.clone();
        let run_state = self.run_state.clone();
        let conversation_id = session.conversation.id.clone();
        let preferences = session.preferences.clone();

        tokio::spawn(async move {
            let tx_for_callback = event_tx.clone();
            let callback: RunEventCallback = Arc::new(move |payload| {
                let _ = tx_for_callback.send(RuntimeEvent::Run(payload));
            });
            let result = run_task_with_event_callback(
                RunTaskInput {
                    conversation_id: conversation_id.clone(),
                    message_id: Some(Uuid::new_v4().to_string()),
                    content: prompt,
                    content_parts: Some(Vec::new()),
                    agent_name: preferences.agent_name.clone(),
                    model_ref: preferences.model_ref.clone(),
                    run_mode: preferences.run_mode.clone(),
                    thinking: preferences.thinking.clone(),
                    web_search_provider: preferences.web_search_provider.clone(),
                    debug_mode: preferences.debug_mode,
                    base_messages_override: None,
                    start_turn_index: None,
                    assistant_message_id_override: None,
                },
                db.clone(),
                config_manager.clone(),
                run_state.clone(),
                callback,
            )
            .await;

            let conversation = async_db::with_db(&db, "cli:submit:load_conversation", |db| {
                db.get_conversation(&conversation_id)
            })
            .await
            .ok()
            .flatten();

            let _ = event_tx.send(RuntimeEvent::Finished(RunFinished {
                result: result.map_err(serializable_error_to_string),
                conversation,
            }));
        });

        Ok(())
    }

    pub async fn abort(&self, conversation_id: &str) {
        self.run_state.abort_and_wait(conversation_id, 1_500).await;
    }

    pub async fn respond_approval(
        &self,
        conversation_id: &str,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> bool {
        self.run_state
            .resolve_approval(conversation_id, request_id, decision)
            .await
    }

    async fn create_conversation(&self, title: Option<&str>) -> Result<Conversation, String> {
        let conversation_title = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("CLI Chat");
        async_db::with_db(&self.db, "cli:create_conversation", |db| {
            db.create_conversation(conversation_title)
        })
        .await
        .map_err(|e| e.to_string())
    }

    async fn try_load_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<Conversation>, String> {
        async_db::with_db(&self.db, "cli:try_load_conversation", |db| {
            db.get_conversation(conversation_id)
        })
        .await
        .map_err(|e| e.to_string())
    }

    async fn load_conversation(&self, conversation_id: &str) -> Result<Conversation, String> {
        self.try_load_conversation(conversation_id)
            .await?
            .ok_or_else(|| format!("Conversation not found: {conversation_id}"))
    }

    async fn persist_preferences(
        &self,
        conversation_id: &str,
        preferences: &SessionPreferences,
    ) -> Result<(), String> {
        async_db::with_db(&self.db, "cli:persist_preferences", |db| {
            db.update_conversation_metadata(
                conversation_id,
                preferences.agent_name.as_deref(),
                preferences.model_ref.as_deref(),
                preferences.thinking.as_ref(),
                preferences.run_mode.as_deref(),
                None,
            )
        })
        .await
        .map_err(|e| e.to_string())
    }
}

pub fn normalize_thinking(raw: Option<&str>) -> Option<Value> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }

    let normalized = value.to_ascii_lowercase();
    match normalized.as_str() {
        "off" | "none" | "disabled" | "false" | "0" => Some(Value::Null),
        "on" | "true" | "1" => Some(Value::Bool(true)),
        _ => Some(Value::String(normalized)),
    }
}

pub fn normalize_web_search_provider(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }

    let normalized = value.to_ascii_lowercase();
    if matches!(normalized.as_str(), "off" | "none" | "disabled" | "false") {
        None
    } else {
        Some(normalized)
    }
}

pub fn display_thinking(value: &Value) -> String {
    match value {
        Value::Null => "off".to_string(),
        Value::Bool(true) => "on".to_string(),
        Value::Bool(false) => "off".to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn serializable_error_to_string(error: SerializableError) -> String {
    if error.message.trim().is_empty() {
        error.code
    } else {
        format!("{}: {}", error.code, error.message)
    }
}

fn default_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tauri-ai")
        .join("data.db")
}

pub fn format_message_for_list(message: &Message) -> String {
    let role = match message.role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    };
    format!("[{role}] {}", message.content.replace('\n', " "))
}
