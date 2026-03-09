use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_ai_lib::ai_client::{DebugInfoData, ErrorLayer, TokenUsage};
use tauri_ai_lib::config::ConfigManager;
use tauri_ai_lib::errors::SerializableError;
use tauri_ai_lib::models::{
    ContentPart, Conversation, Message, MessageMeta, MessageRole, MessageStatus,
};
use tauri_ai_lib::runtime::events::{RunEvent, RunEventPayload};
use tauri_ai_lib::runtime::task_runner::{run_task_with_event_callback, RunTaskInput};
use tauri_ai_lib::runtime::RunState;
use tauri_ai_lib::storage::async_db;
use tauri_ai_lib::storage::Database;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Default)]
struct CliArgs {
    json: bool,
    output_mode: Option<String>,
    timeout_ms: Option<u64>,
    max_events: Option<usize>,
    max_snapshot_messages: Option<usize>,
    prompt: Option<String>,
    request_file: Option<PathBuf>,
    conversation_id: Option<String>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<Value>,
    web_search_provider: Option<String>,
    debug_mode: Option<bool>,
    session_backend: Option<String>,
    session_mode: Option<String>,
    db_path: Option<PathBuf>,
    title: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRequest {
    request_id: Option<String>,
    message_id: Option<String>,
    prompt: Option<String>,
    content: Option<String>,
    #[serde(default)]
    content_parts: Vec<ContentPart>,
    conversation_id: Option<String>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<Value>,
    web_search_provider: Option<String>,
    debug_mode: Option<bool>,
    task: Option<JsonTaskRequest>,
    session: Option<JsonSessionRequest>,
    output: Option<JsonOutputRequest>,
    runtime: Option<JsonRuntimeRequest>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonTaskRequest {
    message_id: Option<String>,
    prompt: Option<String>,
    content: Option<String>,
    #[serde(default)]
    content_parts: Vec<ContentPart>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<Value>,
    web_search_provider: Option<String>,
    debug_mode: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonSessionRequest {
    backend: Option<String>,
    mode: Option<String>,
    conversation_id: Option<String>,
    title: Option<String>,
    db_path: Option<String>,
    #[serde(default)]
    messages: Vec<SeedMessageInput>,
    #[serde(default)]
    history: Vec<SeedMessageInput>,
    snapshot: Option<SessionSnapshotInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshotInput {
    conversation_id: Option<String>,
    title: Option<String>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking_mode: Option<Value>,
    #[serde(default)]
    messages: Vec<SeedMessageInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedMessageInput {
    id: Option<String>,
    role: MessageRole,
    content: String,
    #[serde(default)]
    content_parts: Vec<ContentPart>,
    thinking: Option<String>,
    meta: Option<MessageMeta>,
    status: Option<MessageStatus>,
    error_message: Option<String>,
    created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonOutputRequest {
    mode: Option<String>,
    include_events: Option<bool>,
    include_messages: Option<bool>,
    expected_result_schema: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRuntimeRequest {
    timeout_ms: Option<u64>,
    max_events: Option<usize>,
    max_snapshot_messages: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionBackend {
    Db,
    Memory,
}

impl SessionBackend {
    fn from_raw(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "db" | "sqlite" => Some(Self::Db),
            "memory" | "in_memory" | "in-memory" => Some(Self::Memory),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Db => "db",
            Self::Memory => "memory",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionMode {
    New,
    Resume,
}

impl SessionMode {
    fn from_raw(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "new" => Some(Self::New),
            "resume" | "continue" => Some(Self::Resume),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    Plain,
    FinalJson,
    Jsonl,
}

impl OutputMode {
    fn from_raw(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "plain" | "text" => Some(Self::Plain),
            "json" | "final_json" | "final-json" => Some(Self::FinalJson),
            "jsonl" | "json_lines" | "json-lines" | "events" => Some(Self::Jsonl),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct EffectiveRequest {
    request_id: String,
    task: EffectiveTask,
    session: EffectiveSession,
    output: EffectiveOutput,
    runtime: EffectiveRuntime,
}

#[derive(Debug)]
struct EffectiveTask {
    message_id: Option<String>,
    content: String,
    content_parts: Vec<ContentPart>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<Value>,
    web_search_provider: Option<String>,
    debug_mode: Option<bool>,
}

#[derive(Debug)]
struct EffectiveSession {
    backend: SessionBackend,
    mode: SessionMode,
    conversation_id: Option<String>,
    title: String,
    db_path: Option<PathBuf>,
    seed_messages: Vec<SeedMessageInput>,
}

#[derive(Debug)]
struct EffectiveOutput {
    mode: OutputMode,
    include_events: bool,
    include_messages: bool,
    expected_result_schema: Option<Value>,
}

#[derive(Debug)]
struct EffectiveRuntime {
    timeout_ms: u64,
    max_events: usize,
    max_snapshot_messages: usize,
}

struct PreparedSession {
    db: Arc<Mutex<Database>>,
    conversation_id: String,
    conversation: Conversation,
    backend: SessionBackend,
    db_path: Option<PathBuf>,
}

#[derive(Debug, Default)]
struct DerivedRunSummary {
    run_id: Option<String>,
    done: Option<DoneSummary>,
    error: Option<ErrorSummary>,
}

#[derive(Debug, Clone)]
struct DoneSummary {
    task_id: String,
    turn_id: String,
    assistant_message_id: Option<String>,
    content: String,
    thinking: Option<String>,
    debug_info: Option<DebugInfoData>,
    usage: Option<TokenUsage>,
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorSummary {
    code: String,
    message: String,
    task_id: Option<String>,
    turn_id: Option<String>,
    assistant_message_id: Option<String>,
    debug_info: Option<DebugInfoData>,
    details: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessResponse {
    ok: bool,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    session_ref: SessionRefOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<ResultOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema_validation: Option<SchemaValidationOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    events: Option<Vec<RunEventPayload>>,
    event_stats: EventStatsOutput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRefOutput {
    backend: String,
    conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    db_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<SessionSnapshotOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshotOutput {
    conversation_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_mode: Option<Value>,
    messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultOutput {
    task_id: String,
    turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    assistant_message_id: Option<String>,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "debugInfo")]
    debug_info: Option<DebugInfoData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaValidationOutput {
    valid: bool,
    errors: Vec<String>,
}

struct EventCollector {
    inner: StdMutex<EventCollectorInner>,
}

impl EventCollector {
    fn with_max_events(max_events: usize) -> Self {
        Self {
            inner: StdMutex::new(EventCollectorInner {
                max_events: max_events.max(1),
                events: std::collections::VecDeque::new(),
                total_received: 0,
                dropped: 0,
            }),
        }
    }

    fn push(&self, payload: RunEventPayload) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.total_received = guard.total_received.saturating_add(1);
            if guard.events.len() >= guard.max_events {
                let _ = guard.events.pop_front();
                guard.dropped = guard.dropped.saturating_add(1);
            }
            guard.events.push_back(payload);
        }
    }

    fn snapshot(&self) -> EventCollectorSnapshot {
        self.inner
            .lock()
            .map(|inner| EventCollectorSnapshot {
                events: inner.events.iter().cloned().collect(),
                total_received: inner.total_received,
                dropped: inner.dropped,
            })
            .unwrap_or_default()
    }
}

struct EventCollectorInner {
    max_events: usize,
    events: std::collections::VecDeque<RunEventPayload>,
    total_received: usize,
    dropped: usize,
}

#[derive(Default)]
struct EventCollectorSnapshot {
    events: Vec<RunEventPayload>,
    total_received: usize,
    dropped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventStatsOutput {
    total_received: usize,
    kept: usize,
    dropped: usize,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cli = parse_cli_args()?;
    let stdin_payload = read_input_payload(cli.request_file.as_ref(), cli.prompt.as_ref())?;

    let mut json_request = JsonRequest::default();
    let mut plain_payload_prompt: Option<String> = None;

    if let Some(raw) = stdin_payload {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if looks_like_json(trimmed) {
                json_request = serde_json::from_str(trimmed)
                    .map_err(|e| format!("解析 stdin JSON 失败: {e}"))?;
            } else {
                plain_payload_prompt = Some(trimmed.to_string());
            }
        }
    }

    let request = merge_request(cli, json_request, plain_payload_prompt)?;
    let mut prepared = prepare_session(&request).await?;

    let effective_agent = request
        .task
        .agent_name
        .clone()
        .or(prepared.conversation.agent_name.clone());
    let effective_model_ref = request
        .task
        .model_ref
        .clone()
        .or(prepared.conversation.model_ref.clone());
    let effective_run_mode = request
        .task
        .run_mode
        .clone()
        .or(prepared.conversation.run_mode.clone());
    let effective_thinking = request
        .task
        .thinking
        .clone()
        .or(prepared.conversation.thinking_mode.clone());

    persist_conversation_metadata(
        &prepared.db,
        &prepared.conversation_id,
        effective_agent.as_deref(),
        effective_model_ref.as_deref(),
        effective_thinking.as_ref(),
        effective_run_mode.as_deref(),
    )
    .await?;

    let collector = Arc::new(EventCollector::with_max_events(request.runtime.max_events));
    let stream_jsonl = request.output.mode == OutputMode::Jsonl;
    let collector_for_callback = collector.clone();
    let callback = Arc::new(move |payload: RunEventPayload| {
        if stream_jsonl {
            emit_json_line_lossy(&json!({
                "type": "run_event",
                "event": payload.clone(),
            }));
        }
        collector_for_callback.push(payload);
    });

    let run_state = Arc::new(RunState::new());
    let run_state_for_timeout = run_state.clone();
    let config_manager =
        Arc::new(ConfigManager::new().map_err(|e| format!("初始化配置失败: {e}"))?);
    let run_started_at = Instant::now();
    let run_future = run_task_with_event_callback(
        RunTaskInput {
            conversation_id: prepared.conversation_id.clone(),
            message_id: request.task.message_id.clone(),
            content: request.task.content.clone(),
            content_parts: Some(request.task.content_parts.clone()),
            agent_name: effective_agent,
            model_ref: effective_model_ref,
            run_mode: effective_run_mode,
            thinking: effective_thinking,
            web_search_provider: request.task.web_search_provider.clone(),
            debug_mode: request.task.debug_mode,
            base_messages_override: None,
            start_turn_index: None,
            assistant_message_id_override: None,
        },
        prepared.db.clone(),
        config_manager,
        run_state,
        callback,
    );
    let (run_result, timeout_error): (Option<Result<(), SerializableError>>, Option<ErrorSummary>) =
        match tokio::time::timeout(
            std::time::Duration::from_millis(request.runtime.timeout_ms),
            run_future,
        )
        .await
        {
            Ok(result) => (Some(result), None),
            Err(_) => {
                run_state_for_timeout
                    .abort_and_wait(&prepared.conversation_id, 1_500)
                    .await;
                let elapsed = run_started_at.elapsed().as_millis() as u64;
                (
                    None,
                    Some(ErrorSummary {
                        code: "runtime_timeout".to_string(),
                        message: format!(
                            "任务超时：超过 {}ms（实际 {}ms），已触发 abort",
                            request.runtime.timeout_ms, elapsed
                        ),
                        task_id: None,
                        turn_id: None,
                        assistant_message_id: None,
                        debug_info: None,
                        details: Some(json!({
                            "layer": "runtime",
                            "module": "runtime/task_runner",
                            "operation": "run_task_with_event_callback",
                            "timeoutMs": request.runtime.timeout_ms,
                            "elapsedMs": elapsed,
                        })),
                    }),
                )
            }
        };

    prepared.conversation = load_conversation(&prepared.db, &prepared.conversation_id).await?;

    let events_snapshot = collector.snapshot();
    let events = events_snapshot.events;
    let derived = derive_run_summary(&events);

    let mut result_output = derived.done.as_ref().map(|done| ResultOutput {
        task_id: done.task_id.clone(),
        turn_id: done.turn_id.clone(),
        assistant_message_id: done.assistant_message_id.clone(),
        content: done.content.clone(),
        thinking: done.thinking.clone(),
        debug_info: done.debug_info.clone(),
        usage: done.usage.clone(),
        model: done.model.clone(),
    });

    if result_output.is_none() {
        if let Some(fallback) =
            load_latest_assistant_message(&prepared.db, &prepared.conversation_id).await?
        {
            let fallback_meta = fallback.meta.clone();
            let fallback_debug_info = fallback_meta.as_ref().and_then(|m| {
                m.turns
                    .as_ref()
                    .and_then(|turns| turns.last().and_then(|t| t.debug_info.clone()))
            });
            let fallback_usage = fallback_meta
                .as_ref()
                .and_then(|m| m.usage.clone())
                .or_else(|| {
                    fallback_meta.as_ref().and_then(|m| {
                        m.turns
                            .as_ref()
                            .and_then(|turns| turns.last().and_then(|t| t.usage.clone()))
                    })
                });
            let fallback_model = fallback_meta.and_then(|m| m.model);

            result_output = Some(ResultOutput {
                task_id: "unknown".to_string(),
                turn_id: "unknown".to_string(),
                assistant_message_id: Some(fallback.id),
                content: fallback.content,
                thinking: fallback.thinking,
                debug_info: fallback_debug_info,
                usage: fallback_usage,
                model: fallback_model,
            });
        }
    }

    let mut error_output = timeout_error.or_else(|| {
        run_result
            .as_ref()
            .and_then(|v| v.as_ref().err())
            .map(serializable_error_ref_to_summary)
    });
    if let Some(event_error) = derived.error {
        error_output = Some(event_error);
    }
    if let Some(current) = error_output.take() {
        error_output = Some(enrich_error_summary(current));
    }

    let mut schema_validation: Option<SchemaValidationOutput> = None;
    if let Some(schema) = request.output.expected_result_schema.as_ref() {
        let validation = if let Some(result) = result_output.as_ref() {
            validate_expected_schema(&result.content, schema)
        } else {
            SchemaValidationOutput {
                valid: false,
                errors: vec!["缺少可校验的 assistant JSON 输出".to_string()],
            }
        };
        schema_validation = Some(validation);
    }

    let schema_invalid = schema_validation
        .as_ref()
        .is_some_and(|validation| !validation.valid);
    if schema_invalid && error_output.is_none() {
        error_output = Some(ErrorSummary {
            code: "schema_validation_failed".to_string(),
            message: "返回结果未通过 expectedResultSchema 校验".to_string(),
            task_id: result_output.as_ref().map(|r| r.task_id.clone()),
            turn_id: result_output.as_ref().map(|r| r.turn_id.clone()),
            assistant_message_id: result_output
                .as_ref()
                .and_then(|r| r.assistant_message_id.clone()),
            debug_info: None,
            details: schema_validation
                .as_ref()
                .map(|v| json!({ "errors": v.errors.clone() })),
        });
    }

    let ok = error_output.is_none() && !schema_invalid;
    let usage = result_output.as_ref().and_then(|r| r.usage.clone());

    let snapshot = if prepared.backend == SessionBackend::Memory || request.output.include_messages
    {
        Some(
            build_snapshot(
                &prepared.db,
                &prepared.conversation_id,
                request.runtime.max_snapshot_messages,
            )
            .await?,
        )
    } else {
        None
    };

    let response = HeadlessResponse {
        ok,
        request_id: request.request_id,
        run_id: derived.run_id,
        session_ref: SessionRefOutput {
            backend: prepared.backend.as_str().to_string(),
            conversation_id: prepared.conversation_id.clone(),
            db_path: prepared
                .db_path
                .as_ref()
                .map(|v| v.to_string_lossy().to_string()),
            snapshot,
        },
        result: result_output,
        usage,
        schema_validation,
        error: error_output.clone(),
        event_stats: EventStatsOutput {
            total_received: events_snapshot.total_received,
            kept: events.len(),
            dropped: events_snapshot.dropped,
        },
        events: if request.output.include_events {
            Some(events)
        } else {
            None
        },
    };

    match request.output.mode {
        OutputMode::Plain => {
            if response.ok {
                if let Some(result) = response.result.as_ref() {
                    println!("{}", result.content.trim_end_matches('\n'));
                }
                Ok(())
            } else {
                let msg = response
                    .error
                    .as_ref()
                    .map(|e| e.message.clone())
                    .unwrap_or_else(|| "headless 执行失败".to_string());
                Err(msg)
            }
        }
        OutputMode::FinalJson => {
            emit_json_line(&serde_json::to_value(&response).map_err(|e| e.to_string())?)?;
            if response.ok {
                Ok(())
            } else {
                Err(response
                    .error
                    .as_ref()
                    .map(|e| e.message.clone())
                    .unwrap_or_else(|| "headless 执行失败".to_string()))
            }
        }
        OutputMode::Jsonl => {
            emit_json_line(&json!({
                "type": "final",
                "data": response,
            }))?;
            if response.ok {
                Ok(())
            } else {
                Err(error_output
                    .as_ref()
                    .map(|e| e.message.clone())
                    .unwrap_or_else(|| "headless 执行失败".to_string()))
            }
        }
    }
}

fn merge_request(
    cli: CliArgs,
    json_request: JsonRequest,
    plain_payload_prompt: Option<String>,
) -> Result<EffectiveRequest, String> {
    let task = json_request.task.unwrap_or_default();
    let session = json_request.session.unwrap_or_default();
    let output = json_request.output.unwrap_or_default();
    let runtime = json_request.runtime.unwrap_or_default();

    let content = cli
        .prompt
        .or(task.content)
        .or(task.prompt)
        .or(json_request.content)
        .or(json_request.prompt)
        .or(plain_payload_prompt)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "缺少请求内容：请提供 content/prompt".to_string())?;

    let content_parts = if !task.content_parts.is_empty() {
        task.content_parts
    } else {
        json_request.content_parts
    };

    let snapshot = session.snapshot.clone();
    let mut seed_messages = if !session.messages.is_empty() {
        session.messages
    } else if !session.history.is_empty() {
        session.history
    } else {
        snapshot
            .as_ref()
            .map(|v| v.messages.clone())
            .unwrap_or_default()
    };
    if seed_messages.is_empty() {
        seed_messages = Vec::new();
    }

    let backend_raw = cli
        .session_backend
        .as_deref()
        .or(session.backend.as_deref())
        .unwrap_or("db");
    let backend = SessionBackend::from_raw(backend_raw)
        .ok_or_else(|| format!("非法 session.backend: {backend_raw}"))?;

    let mode_raw = cli
        .session_mode
        .as_deref()
        .or(session.mode.as_deref())
        .unwrap_or("new");
    let mode =
        SessionMode::from_raw(mode_raw).ok_or_else(|| format!("非法 session.mode: {mode_raw}"))?;

    let conversation_id = cli
        .conversation_id
        .or(session.conversation_id)
        .or(json_request.conversation_id)
        .or_else(|| snapshot.as_ref().and_then(|v| v.conversation_id.clone()))
        .and_then(normalize_optional_string);

    let title = cli
        .title
        .or(session.title)
        .or_else(|| snapshot.as_ref().and_then(|v| v.title.clone()))
        .unwrap_or_else(|| "Headless Session".to_string());

    let db_path = cli
        .db_path
        .or_else(|| session.db_path.as_deref().map(PathBuf::from));

    let cli_mode = parse_output_mode_optional(cli.output_mode.as_deref())?;
    let request_mode = parse_output_mode_optional(output.mode.as_deref())?;
    let output_mode = cli_mode
        .or(request_mode)
        .or(if cli.json {
            Some(OutputMode::Jsonl)
        } else {
            None
        })
        .unwrap_or(OutputMode::Plain);

    let include_events = output
        .include_events
        .unwrap_or(output_mode == OutputMode::Jsonl);
    let include_messages = output
        .include_messages
        .unwrap_or(backend == SessionBackend::Memory);

    Ok(EffectiveRequest {
        request_id: json_request
            .request_id
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| format!("req_{}", Uuid::new_v4())),
        task: EffectiveTask {
            message_id: task
                .message_id
                .or(json_request.message_id)
                .and_then(normalize_optional_string),
            content,
            content_parts,
            agent_name: cli
                .agent_name
                .or(task.agent_name)
                .or(json_request.agent_name)
                .or_else(|| snapshot.as_ref().and_then(|v| v.agent_name.clone()))
                .and_then(normalize_optional_string),
            model_ref: cli
                .model_ref
                .or(task.model_ref)
                .or(json_request.model_ref)
                .or_else(|| snapshot.as_ref().and_then(|v| v.model_ref.clone()))
                .and_then(normalize_optional_string),
            run_mode: cli
                .run_mode
                .or(task.run_mode)
                .or(json_request.run_mode)
                .or_else(|| snapshot.as_ref().and_then(|v| v.run_mode.clone()))
                .and_then(normalize_optional_string),
            thinking: cli
                .thinking
                .or(task.thinking)
                .or(json_request.thinking)
                .or_else(|| snapshot.as_ref().and_then(|v| v.thinking_mode.clone())),
            web_search_provider: cli
                .web_search_provider
                .or(task.web_search_provider)
                .or(json_request.web_search_provider)
                .and_then(normalize_optional_string),
            debug_mode: cli
                .debug_mode
                .or(task.debug_mode)
                .or(json_request.debug_mode),
        },
        session: EffectiveSession {
            backend,
            mode,
            conversation_id,
            title,
            db_path,
            seed_messages,
        },
        output: EffectiveOutput {
            mode: output_mode,
            include_events,
            include_messages,
            expected_result_schema: output.expected_result_schema,
        },
        runtime: EffectiveRuntime {
            timeout_ms: cli
                .timeout_ms
                .or(runtime.timeout_ms)
                .unwrap_or(600_000)
                .clamp(1_000, 3_600_000),
            max_events: cli
                .max_events
                .or(runtime.max_events)
                .unwrap_or(5_000)
                .clamp(100, 50_000),
            max_snapshot_messages: cli
                .max_snapshot_messages
                .or(runtime.max_snapshot_messages)
                .unwrap_or(1_000)
                .clamp(10, 50_000),
        },
    })
}

async fn prepare_session(request: &EffectiveRequest) -> Result<PreparedSession, String> {
    let (db_obj, db_path) = match request.session.backend {
        SessionBackend::Db => {
            let path = request
                .session
                .db_path
                .clone()
                .unwrap_or_else(default_db_path);
            let db = Database::new(path.clone())
                .map_err(|e| format!("初始化 DB 失败（{}）: {e}", path.display()))?;
            (db, Some(path))
        }
        SessionBackend::Memory => {
            let db = Database::new_in_memory().map_err(|e| format!("初始化内存 DB 失败: {e}"))?;
            (db, None)
        }
    };

    let db = Arc::new(Mutex::new(db_obj));
    let requested_id = request.session.conversation_id.clone();
    let has_seed_messages = !request.session.seed_messages.is_empty();

    let mut conversation_id: Option<String> = None;
    let mut conversation_existed = false;

    if let Some(id) = requested_id.as_deref() {
        let existing = async_db::with_db(&db, "headless:prepare:get_conversation", |db| {
            db.get_conversation(id)
        })
        .await
        .map_err(|e| e.to_string())?;
        if existing.is_some() {
            conversation_id = Some(id.to_string());
            conversation_existed = true;
        }
    }

    match request.session.mode {
        SessionMode::New => {
            if conversation_existed {
                return Err(format!(
                    "session.mode=new 但 conversation 已存在：{}",
                    requested_id.unwrap_or_default()
                ));
            }
            let created = create_conversation(
                &db,
                &request.session.title,
                requested_id.as_deref(),
                "headless:prepare:create_conversation_new",
            )
            .await?;
            conversation_id = Some(created);
            if has_seed_messages {
                import_seed_messages(
                    &db,
                    conversation_id.as_deref().unwrap_or_default(),
                    &request.session.seed_messages,
                )
                .await?;
            }
        }
        SessionMode::Resume => {
            if conversation_existed {
                // 已存在时不重复导入 seed，避免消息重复。
            } else {
                if requested_id.is_none() {
                    return Err("session.mode=resume 需要 conversationId".to_string());
                }
                if !has_seed_messages {
                    return Err("session.mode=resume 且 conversation 不存在时，必须提供 session.messages 或 snapshot.messages".to_string());
                }
                let created = create_conversation(
                    &db,
                    &request.session.title,
                    requested_id.as_deref(),
                    "headless:prepare:create_conversation_resume",
                )
                .await?;
                conversation_id = Some(created);
                import_seed_messages(
                    &db,
                    conversation_id.as_deref().unwrap_or_default(),
                    &request.session.seed_messages,
                )
                .await?;
            }
        }
    }

    let conversation_id =
        conversation_id.ok_or_else(|| "未能确定会话 conversationId".to_string())?;
    let conversation = load_conversation(&db, &conversation_id).await?;

    Ok(PreparedSession {
        db,
        conversation_id,
        conversation,
        backend: request.session.backend,
        db_path,
    })
}

async fn create_conversation(
    db: &Arc<Mutex<Database>>,
    title: &str,
    forced_id: Option<&str>,
    op: &str,
) -> Result<String, String> {
    let conv = async_db::with_db(db, op, |db| {
        if let Some(id) = forced_id {
            db.create_conversation_with_id(id, title)
        } else {
            db.create_conversation(title)
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(conv.id)
}

async fn import_seed_messages(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
    messages: &[SeedMessageInput],
) -> Result<(), String> {
    let mut created_at = Utc::now();
    async_db::with_db(db, "headless:prepare:import_seed_messages", |db| {
        for item in messages {
            let ts = item.created_at.unwrap_or_else(|| {
                created_at = created_at + Duration::milliseconds(1);
                created_at
            });

            let message = Message {
                id: item
                    .id
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                conversation_id: conversation_id.to_string(),
                role: item.role.clone(),
                content: item.content.clone(),
                content_parts: item.content_parts.clone(),
                thinking: item.thinking.clone(),
                meta: item.meta.clone(),
                created_at: ts,
                status: item.status.clone().unwrap_or(MessageStatus::Success),
                error_message: item.error_message.clone(),
            };
            db.add_message(conversation_id, &message)?;
        }
        Ok::<(), tauri_ai_lib::storage::StorageError>(())
    })
    .await
    .map_err(|e| e.to_string())
}

async fn load_conversation(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
) -> Result<Conversation, String> {
    async_db::with_db(db, "headless:load_conversation", |db| {
        db.get_conversation(conversation_id)?
            .ok_or_else(|| tauri_ai_lib::storage::StorageError::NotFound("会话不存在".to_string()))
    })
    .await
    .map_err(|e| e.to_string())
}

async fn persist_conversation_metadata(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
    agent_name: Option<&str>,
    model_ref: Option<&str>,
    thinking_mode: Option<&Value>,
    run_mode: Option<&str>,
) -> Result<(), String> {
    async_db::with_db(db, "headless:persist_conversation_metadata", |db| {
        db.update_conversation_metadata(
            conversation_id,
            agent_name,
            model_ref,
            thinking_mode,
            run_mode,
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())
}

async fn build_snapshot(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
    max_messages: usize,
) -> Result<SessionSnapshotOutput, String> {
    let conversation = load_conversation(db, conversation_id).await?;
    let mut messages =
        async_db::read_all_messages(db, "headless:build_snapshot:get_messages", conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let keep = max_messages.max(1);
    if messages.len() > keep {
        let start = messages.len() - keep;
        messages = messages.split_off(start);
    }

    Ok(SessionSnapshotOutput {
        conversation_id: conversation.id,
        title: conversation.title,
        agent_name: conversation.agent_name,
        model_ref: conversation.model_ref,
        run_mode: conversation.run_mode,
        thinking_mode: conversation.thinking_mode,
        messages,
    })
}

async fn load_latest_assistant_message(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
) -> Result<Option<Message>, String> {
    let messages = async_db::read_messages(
        db,
        "headless:load_latest_assistant_message",
        conversation_id,
        20,
        None,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(messages
        .into_iter()
        .rev()
        .find(|m| m.role == MessageRole::Assistant))
}

fn derive_run_summary(events: &[RunEventPayload]) -> DerivedRunSummary {
    let mut out = DerivedRunSummary::default();
    for payload in events {
        if out.run_id.is_none() {
            out.run_id = Some(payload.run_id.clone());
        }
        match &payload.event {
            RunEvent::Done {
                task_id,
                turn_id,
                assistant_message_id,
                full_content,
                thinking,
                debug_info,
                usage,
                model,
                ..
            } => {
                out.done = Some(DoneSummary {
                    task_id: task_id.clone(),
                    turn_id: turn_id.clone(),
                    assistant_message_id: assistant_message_id.clone(),
                    content: full_content.clone(),
                    thinking: thinking.clone(),
                    debug_info: debug_info.clone(),
                    usage: usage.clone(),
                    model: model.clone(),
                });
            }
            RunEvent::Error {
                task_id,
                turn_id,
                assistant_message_id,
                error,
                debug_info,
            } => {
                out.error = Some(ErrorSummary {
                    code: "runtime_error".to_string(),
                    message: error.clone(),
                    task_id: task_id.clone(),
                    turn_id: turn_id.clone(),
                    assistant_message_id: assistant_message_id.clone(),
                    debug_info: debug_info.clone(),
                    details: None,
                });
            }
            _ => {}
        }
    }
    out
}

fn serializable_error_ref_to_summary(err: &SerializableError) -> ErrorSummary {
    ErrorSummary {
        code: err.code.clone(),
        message: err.message.clone(),
        task_id: None,
        turn_id: None,
        assistant_message_id: None,
        debug_info: None,
        details: Some(json!({
            "actions": err.actions.clone(),
        })),
    }
}

fn enrich_error_summary(mut error: ErrorSummary) -> ErrorSummary {
    let mut details = error.details.take().unwrap_or_else(|| json!({}));
    let obj = details
        .as_object_mut()
        .map(|v| v as &mut serde_json::Map<String, Value>);
    if let Some(obj) = obj {
        if let Some(debug) = error.debug_info.as_ref() {
            if let Some(origin) = debug.error_origin.as_ref() {
                obj.insert(
                    "origin".to_string(),
                    json!({
                        "layer": error_layer_to_str(&origin.layer),
                        "module": origin.module,
                        "operation": origin.operation,
                    }),
                );
            }
            if let Some(term) = debug.stream_termination.as_ref() {
                obj.insert(
                    "streamTermination".to_string(),
                    json!({
                        "protocolComplete": term.protocol_complete,
                        "terminationSource": term.termination_source,
                        "protocolKind": term.protocol_kind,
                        "expectedSignal": term.expected_signal,
                        "observedSignal": term.observed_signal,
                        "lastEventType": term.last_event_type,
                        "chunkCount": term.chunk_count,
                        "eventCount": term.event_count,
                        "rawEventTailCount": term.raw_event_tail.as_ref().map(|v| v.len()),
                    }),
                );
            }
        }
        if !obj.contains_key("source") {
            obj.insert(
                "source".to_string(),
                json!({
                    "layer": "runtime",
                    "module": "headless",
                    "operation": "finalize_error",
                }),
            );
        }
    }
    error.details = Some(details);
    error
}

fn error_layer_to_str(layer: &ErrorLayer) -> &'static str {
    match layer {
        ErrorLayer::Config => "config",
        ErrorLayer::Transport => "transport",
        ErrorLayer::Http => "http",
        ErrorLayer::Protocol => "protocol",
        ErrorLayer::Content => "content",
        ErrorLayer::Runtime => "runtime",
        ErrorLayer::Tool => "tool",
        ErrorLayer::Db => "db",
        ErrorLayer::Unknown => "unknown",
    }
}

fn validate_expected_schema(content: &str, schema: &Value) -> SchemaValidationOutput {
    let value = match serde_json::from_str::<Value>(content) {
        Ok(v) => v,
        Err(e) => {
            return SchemaValidationOutput {
                valid: false,
                errors: vec![format!("assistant 输出不是合法 JSON: {e}")],
            };
        }
    };

    let validator = match jsonschema::JSONSchema::compile(schema) {
        Ok(v) => v,
        Err(e) => {
            return SchemaValidationOutput {
                valid: false,
                errors: vec![format!("expectedResultSchema 非法: {e}")],
            };
        }
    };

    let validation = validator.validate(&value);
    let output = match validation {
        Ok(_) => SchemaValidationOutput {
            valid: true,
            errors: Vec::new(),
        },
        Err(iter) => {
            let errors = iter.map(|e| e.to_string()).collect::<Vec<_>>();
            SchemaValidationOutput {
                valid: false,
                errors,
            }
        }
    };
    output
}

fn parse_output_mode_optional(raw: Option<&str>) -> Result<Option<OutputMode>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    OutputMode::from_raw(raw)
        .map(Some)
        .ok_or_else(|| format!("非法 output.mode: {raw}"))
}

fn normalize_optional_string(raw: String) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn default_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tauri-ai")
        .join("data.db")
}

fn parse_cli_args() -> Result<CliArgs, String> {
    let mut args = std::env::args().skip(1).peekable();
    let mut cli = CliArgs::default();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            "--json" | "--json-events" => {
                cli.json = true;
            }
            "--output-mode" => {
                cli.output_mode = Some(
                    args.next()
                        .ok_or_else(|| "--output-mode 缺少参数".to_string())?,
                );
            }
            "--timeout-ms" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--timeout-ms 缺少参数".to_string())?;
                let parsed = value
                    .parse::<u64>()
                    .map_err(|_| format!("--timeout-ms 不是合法整数: {value}"))?;
                cli.timeout_ms = Some(parsed);
            }
            "--max-events" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--max-events 缺少参数".to_string())?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| format!("--max-events 不是合法整数: {value}"))?;
                cli.max_events = Some(parsed);
            }
            "--max-snapshot-messages" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--max-snapshot-messages 缺少参数".to_string())?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| format!("--max-snapshot-messages 不是合法整数: {value}"))?;
                cli.max_snapshot_messages = Some(parsed);
            }
            "--prompt" => {
                cli.prompt = Some(args.next().ok_or_else(|| "--prompt 缺少参数".to_string())?);
            }
            "--request-file" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--request-file 缺少参数".to_string())?;
                cli.request_file = Some(PathBuf::from(value));
            }
            "--conversation-id" => {
                cli.conversation_id = Some(
                    args.next()
                        .ok_or_else(|| "--conversation-id 缺少参数".to_string())?,
                );
            }
            "--agent" | "--agent-name" => {
                cli.agent_name = Some(args.next().ok_or_else(|| "--agent 缺少参数".to_string())?);
            }
            "--model-ref" => {
                cli.model_ref = Some(
                    args.next()
                        .ok_or_else(|| "--model-ref 缺少参数".to_string())?,
                );
            }
            "--run-mode" => {
                cli.run_mode = Some(
                    args.next()
                        .ok_or_else(|| "--run-mode 缺少参数".to_string())?,
                );
            }
            "--thinking" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--thinking 缺少参数".to_string())?;
                cli.thinking = Some(parse_thinking(&value));
            }
            "--web-search-provider" => {
                cli.web_search_provider = Some(
                    args.next()
                        .ok_or_else(|| "--web-search-provider 缺少参数".to_string())?,
                );
            }
            "--debug-mode" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--debug-mode 缺少参数（true/false）".to_string())?;
                cli.debug_mode = Some(parse_bool(&value)?);
            }
            "--session-backend" => {
                cli.session_backend = Some(
                    args.next()
                        .ok_or_else(|| "--session-backend 缺少参数".to_string())?,
                );
            }
            "--session-mode" => {
                cli.session_mode = Some(
                    args.next()
                        .ok_or_else(|| "--session-mode 缺少参数".to_string())?,
                );
            }
            "--db-path" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--db-path 缺少参数".to_string())?;
                cli.db_path = Some(PathBuf::from(value));
            }
            "--title" => {
                cli.title = Some(args.next().ok_or_else(|| "--title 缺少参数".to_string())?);
            }
            v if v.starts_with('-') => {
                return Err(format!("未知参数: {v}"));
            }
            v => {
                if cli.prompt.is_some() {
                    return Err(format!("多余参数: {v}"));
                }
                cli.prompt = Some(v.to_string());
            }
        }
    }

    Ok(cli)
}

fn parse_thinking(raw: &str) -> Value {
    let normalized = raw.trim().to_lowercase();
    match normalized.as_str() {
        "null" | "disabled" | "off" | "none" => Value::Null,
        "true" | "on" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => Value::String(raw.to_string()),
    }
}

fn parse_bool(raw: &str) -> Result<bool, String> {
    match raw.trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!("非法布尔值: {raw}")),
    }
}

fn read_input_payload(
    request_file: Option<&PathBuf>,
    prompt: Option<&String>,
) -> Result<Option<String>, String> {
    if let Some(path) = request_file {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("读取 request file 失败（{}）: {e}", path.display()))?;
        return Ok(Some(content));
    }

    if prompt.is_some() {
        return Ok(None);
    }

    if std::io::stdin().is_terminal() {
        return Ok(None);
    }

    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取 stdin 失败: {e}"))?;

    if bytes.is_empty() {
        return Ok(None);
    }

    String::from_utf8(bytes)
        .map(Some)
        .map_err(|e| format!("stdin 不是合法 UTF-8: {e}"))
}

fn looks_like_json(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.starts_with('{') && trimmed.ends_with('}')
}

fn emit_json_line(value: &Value) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    println!("{line}");
    std::io::stdout()
        .flush()
        .map_err(|e| format!("刷新 stdout 失败: {e}"))
}

fn emit_json_line_lossy(value: &Value) {
    if let Ok(line) = serde_json::to_string(value) {
        println!("{line}");
        let _ = std::io::stdout().flush();
    }
}

fn print_help() {
    println!(
        "tauri-ai-headless\n\n\
         用法：\n\
           tauri-ai-headless --prompt \"解释这个函数\"\n\
           echo '{{\"task\":{{\"content\":\"解释这个函数\"}},\"output\":{{\"mode\":\"jsonl\"}}}}' | tauri-ai-headless\n\
           tauri-ai-headless --request-file request.json --output-mode final_json\n\n\
         常用参数：\n\
           --prompt <TEXT>             请求内容（未提供时会尝试从 stdin 读取）\n\
           --request-file <FILE>       从 JSON 文件读取请求\n\
           --output-mode <MODE>        plain | final_json | jsonl\n\
           --json                      等价于 --output-mode jsonl（兼容旧参数）\n\
           --timeout-ms <N>            单次任务超时（ms，默认 600000）\n\
           --max-events <N>            事件缓存上限（默认 5000，超出后丢弃最旧事件）\n\
           --max-snapshot-messages <N> snapshot 最大消息数（默认 1000）\n\
           --conversation-id <ID>      会话 ID（常与 --session-mode resume 搭配）\n\
           --session-backend <B>       db | memory\n\
           --session-mode <M>          new | resume\n\
           --db-path <FILE>            DB backend 的 SQLite 路径\n\
           --agent <NAME>              覆盖任务 agent\n\
           --model-ref <REF>           覆盖任务 model_ref\n\
           --run-mode <MODE>           chat | agent | agent-custom | agent-full-access\n\
           --thinking <LEVEL>          thinking 设置（如 low/medium/high/disabled）\n\
           --web-search-provider <P>   native/tavily/google/brave\n\
           --debug-mode <BOOL>         true/false\n\
           -h, --help                  显示帮助\n\n\
         JSON 请求（camelCase）核心字段：\n\
           requestId, task, session, output, runtime\n\
           task: content/prompt, contentParts, agentName, modelRef, runMode, thinking...\n\
           session: backend, mode, conversationId, dbPath, messages, snapshot\n\
           output: mode, includeEvents, includeMessages, expectedResultSchema\n\
           runtime: timeoutMs, maxEvents, maxSnapshotMessages"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_validation_should_pass_on_valid_json() {
        let schema = json!({
            "type": "object",
            "required": ["ok", "score"],
            "properties": {
                "ok": {"type": "boolean"},
                "score": {"type": "number"}
            }
        });
        let content = r#"{"ok":true,"score":0.98}"#;
        let result = validate_expected_schema(content, &schema);
        assert!(result.valid, "errors={:?}", result.errors);
    }

    #[test]
    fn schema_validation_should_fail_on_missing_required() {
        let schema = json!({
            "type": "object",
            "required": ["ok", "score"],
            "properties": {
                "ok": {"type": "boolean"},
                "score": {"type": "number"}
            }
        });
        let content = r#"{"ok":true}"#;
        let result = validate_expected_schema(content, &schema);
        assert!(!result.valid);
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn merge_request_should_apply_runtime_clamp() {
        let cli = CliArgs {
            timeout_ms: Some(9_999_999),
            max_events: Some(1),
            max_snapshot_messages: Some(1),
            prompt: Some("hello".to_string()),
            ..Default::default()
        };
        let json_request = JsonRequest {
            runtime: Some(JsonRuntimeRequest {
                timeout_ms: Some(10),
                max_events: Some(10),
                max_snapshot_messages: Some(10),
            }),
            ..Default::default()
        };
        let merged = merge_request(cli, json_request, None).expect("merge_request failed");
        assert_eq!(merged.runtime.timeout_ms, 3_600_000);
        assert_eq!(merged.runtime.max_events, 100);
        assert_eq!(merged.runtime.max_snapshot_messages, 10);
    }
}
