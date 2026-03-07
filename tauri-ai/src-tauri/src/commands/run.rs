//! Tauri commands: run_task / abort_run
//!
//! 说明：
//! - Command 层只做参数接入与依赖注入
//! - 运行时（Task/Turn/ReAct/事件流）封装在 `crate::runtime::task_runner`
use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use crate::agents::chat::resolve_chat_model;
use crate::config::ConfigManager;
use crate::errors::SerializableError;
use crate::models::{AskForApproval, ContentPart};
use crate::runtime::approvals::ApprovalDecision;
use crate::runtime::events::RUN_EVENT_NAME;
use crate::runtime::task_runner::{
    retry_turn as retry_turn_impl, run_task as run_task_impl, RunTaskInput,
};
use crate::runtime::RunState;
use crate::storage::Database;

const HEADLESS_STDERR_TAIL_LIMIT: usize = 64;
const HEADLESS_STDOUT_TAIL_LIMIT: usize = 64;
const HEADLESS_PARSE_ERROR_TAIL_LIMIT: usize = 16;
const REQUEST_DEDUP_TTL_SECS: u64 = 120;
const RUN_ABORT_POLL_INTERVAL_MS: u64 = 30;
const RUN_ABORT_MAX_WAIT_SECS: u64 = 5;

#[derive(Default)]
struct RunRequestDedupState {
    in_flight: HashMap<String, String>,
    recently_completed: HashMap<(String, String), Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunReserveOutcome {
    Reserved,
    DuplicateInFlight,
    DuplicateCompleted,
}

static RUN_REQUEST_DEDUP: OnceLock<Mutex<RunRequestDedupState>> = OnceLock::new();

fn run_request_dedup() -> &'static Mutex<RunRequestDedupState> {
    RUN_REQUEST_DEDUP.get_or_init(|| Mutex::new(RunRequestDedupState::default()))
}

fn build_serializable_error(code: &str, message: impl Into<String>) -> SerializableError {
    SerializableError {
        code: code.to_string(),
        message: message.into(),
        actions: Vec::new(),
    }
}

#[derive(Debug)]
struct HeadlessRunError {
    error: SerializableError,
    allow_in_process_fallback: bool,
}

impl HeadlessRunError {
    fn new(code: &str, message: impl Into<String>, allow_in_process_fallback: bool) -> Self {
        Self {
            error: build_serializable_error(code, message),
            allow_in_process_fallback,
        }
    }
}

async fn reserve_run_request(
    conversation_id: &str,
    request_id: &str,
) -> Result<RunReserveOutcome, SerializableError> {
    let mut state = run_request_dedup().lock().await;
    let now = Instant::now();
    let ttl = Duration::from_secs(REQUEST_DEDUP_TTL_SECS);
    state
        .recently_completed
        .retain(|_, finished_at| now.duration_since(*finished_at) <= ttl);

    if let Some(active_request_id) = state.in_flight.get(conversation_id) {
        if active_request_id == request_id {
            return Ok(RunReserveOutcome::DuplicateInFlight);
        }
        return Err(build_serializable_error(
            "RUN_CONFLICT",
            format!(
                "会话 {conversation_id} 已有运行中的任务（request_id={active_request_id}），请等待完成或先中止。"
            ),
        ));
    }

    if state
        .recently_completed
        .contains_key(&(conversation_id.to_string(), request_id.to_string()))
    {
        return Ok(RunReserveOutcome::DuplicateCompleted);
    }

    state
        .in_flight
        .insert(conversation_id.to_string(), request_id.to_string());
    Ok(RunReserveOutcome::Reserved)
}

async fn release_run_request(conversation_id: &str, request_id: &str, mark_completed: bool) {
    let mut state = run_request_dedup().lock().await;
    if state
        .in_flight
        .get(conversation_id)
        .is_some_and(|active| active == request_id)
    {
        state.in_flight.remove(conversation_id);
    }
    if mark_completed {
        state.recently_completed.insert(
            (conversation_id.to_string(), request_id.to_string()),
            Instant::now(),
        );
    }
}

fn push_tail(tail: &mut VecDeque<String>, line: String, limit: usize) {
    if limit == 0 {
        return;
    }
    if tail.len() >= limit {
        tail.pop_front();
    }
    tail.push_back(line);
}

fn tail_lines_to_text(tail: &VecDeque<String>) -> String {
    if tail.is_empty() {
        return "(空)".to_string();
    }
    tail.iter().cloned().collect::<Vec<_>>().join("\n")
}

#[derive(Default)]
struct HeadlessStdoutCollector {
    final_data: Option<Value>,
    stdout_tail: VecDeque<String>,
    parse_errors: VecDeque<String>,
    run_event_count: usize,
}

fn headless_binary_stem() -> &'static str {
    "tauri-ai-headless"
}

fn headless_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "tauri-ai-headless.exe"
    } else {
        "tauri-ai-headless"
    }
}

fn headless_binary_names() -> Vec<String> {
    let mut names = vec![headless_binary_name().to_string()];
    if let Some(target) = option_env!("TARGET")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let suffixed = if cfg!(target_os = "windows") {
            format!("{}-{target}.exe", headless_binary_stem())
        } else {
            format!("{}-{target}", headless_binary_stem())
        };
        if !names.iter().any(|existing| existing == &suffixed) {
            names.push(suffixed);
        }
    }
    names
}

fn headless_command_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(raw) = std::env::var("TAURIAI_HEADLESS_BIN") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed));
        }
    }

    let binary_names = headless_binary_names();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            for name in &binary_names {
                candidates.push(dir.join(name));
            }
            if let Some(parent) = dir.parent() {
                for name in &binary_names {
                    candidates.push(parent.join("MacOS").join(name));
                    candidates.push(parent.join("Resources").join(name));
                }
            }
        }
    }

    for name in binary_names {
        candidates.push(PathBuf::from(name));
    }

    let mut seen = std::collections::HashSet::<String>::new();
    let mut deduped = Vec::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_string();
        if seen.insert(key) {
            deduped.push(candidate);
        }
    }
    deduped
}

fn spawn_headless_process() -> Result<(Child, String), HeadlessRunError> {
    let mut last_error: Option<(String, String)> = None;

    for candidate in headless_command_candidates() {
        let display = candidate.to_string_lossy().to_string();
        let mut command = Command::new(&candidate);
        command
            .arg("--output-mode")
            .arg("jsonl")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match command.spawn() {
            Ok(child) => return Ok((child, display)),
            Err(err) => {
                last_error = Some((display, err.to_string()));
                if err.kind() == ErrorKind::NotFound {
                    continue;
                }
            }
        }
    }

    let detail = last_error
        .map(|(bin, err)| format!("{bin}: {err}"))
        .unwrap_or_else(|| "没有可用的 headless 可执行文件".to_string());
    Err(HeadlessRunError::new(
        "HEADLESS_UNAVAILABLE",
        format!("无法启动 headless 运行器（tauri-ai-headless）：{detail}"),
        true,
    ))
}

async fn cleanup_abort_sender(run_state: &RunState, conversation_id: &str) {
    let mut senders = run_state.abort_senders.write().await;
    senders.remove(conversation_id);
}

fn format_error_origin_from_details(details: &Value) -> Option<String> {
    let origin = details.get("origin")?;
    let layer = origin
        .get("layer")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let module = origin
        .get("module")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let operation = origin
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("<none>");
    Some(format!(
        "错误来源：layer={layer}, module={module}, operation={operation}"
    ))
}

fn format_stream_termination_from_details(details: &Value) -> Option<String> {
    let term = details.get("streamTermination")?;
    let protocol_complete = term
        .get("protocolComplete")
        .and_then(Value::as_bool)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".to_string());
    let termination_source = term
        .get("terminationSource")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let protocol_kind = term
        .get("protocolKind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let expected_signal = term
        .get("expectedSignal")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let observed_signal = term
        .get("observedSignal")
        .and_then(Value::as_str)
        .unwrap_or("<none>");
    let last_event_type = term
        .get("lastEventType")
        .and_then(Value::as_str)
        .unwrap_or("<none>");
    let chunk_count = term
        .get("chunkCount")
        .and_then(Value::as_u64)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".to_string());
    let event_count = term
        .get("eventCount")
        .and_then(Value::as_u64)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".to_string());
    Some(format!(
        "流终止：protocol_complete={protocol_complete}, source={termination_source}, protocol={protocol_kind}, expected={expected_signal}, observed={observed_signal}, last_event_type={last_event_type}, chunk_count={chunk_count}, event_count={event_count}"
    ))
}

fn serialize_json_compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<json serialize failed>".to_string())
}

fn format_debug_stream_termination_from_debug_info(debug_info: &Value) -> Option<String> {
    let term = debug_info
        .get("streamTermination")
        .or_else(|| debug_info.get("stream_termination"))?;
    if !term.is_object() {
        return None;
    }
    let protocol_complete = term
        .get("protocolComplete")
        .or_else(|| term.get("protocol_complete"))
        .and_then(Value::as_bool)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".to_string());
    let source = term
        .get("terminationSource")
        .or_else(|| term.get("termination_source"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let expected = term
        .get("expectedSignal")
        .or_else(|| term.get("expected_signal"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let observed = term
        .get("observedSignal")
        .or_else(|| term.get("observed_signal"))
        .and_then(Value::as_str)
        .unwrap_or("<none>");
    Some(format!(
        "debugInfo.streamTermination：protocol_complete={protocol_complete}, source={source}, expected={expected}, observed={observed}"
    ))
}

fn format_debug_origin_from_debug_info(debug_info: &Value) -> Option<String> {
    let origin = debug_info
        .get("errorOrigin")
        .or_else(|| debug_info.get("error_origin"))?;
    if !origin.is_object() {
        return None;
    }
    let layer = origin
        .get("layer")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let module = origin
        .get("module")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let operation = origin
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("<none>");
    Some(format!(
        "debugInfo.errorOrigin：layer={layer}, module={module}, operation={operation}"
    ))
}

fn is_abort_like_error(final_data: &Value) -> bool {
    let error = final_data.get("error");
    let Some(error) = error else {
        return false;
    };
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    code.contains("abort")
        || code.contains("cancel")
        || message.contains("abort")
        || message.contains("cancel")
        || message.contains("中止")
}

fn should_try_headless_runner(config: &crate::models::AppConfig, input: &RunTaskInput) -> bool {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return false;
    }

    if std::env::var("TAURIAI_DISABLE_HEADLESS_RUNNER")
        .ok()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    {
        return false;
    }

    let requested_mode = input.run_mode.as_deref().unwrap_or("").trim();
    let use_custom_security = requested_mode == "agent-custom";
    let resolved = match resolve_chat_model(
        config,
        input.agent_name.as_deref(),
        input.model_ref.as_deref(),
    ) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let base_policy = config
        .security
        .resolve_policy(resolved.agent.security_policy.as_deref());
    let approval_policy = if use_custom_security {
        resolved
            .agent
            .approval_policy
            .unwrap_or(base_policy.approval_policy)
    } else {
        base_policy.approval_policy
    };

    // 子进程 runner 目前未接入审批回传通道（respond_approval）：
    // 仅在完全不需要审批时启用，避免任务卡死等待审批。
    matches!(approval_policy, AskForApproval::Never)
}

async fn run_task_via_headless(
    app: AppHandle,
    input: &RunTaskInput,
    request_id: &str,
    run_state: Arc<RunState>,
) -> Result<(), HeadlessRunError> {
    let conversation_id = input.conversation_id.clone();
    let result = run_task_via_headless_inner(app, input, request_id, run_state.clone()).await;
    run_state.finish_run(&conversation_id).await;
    cleanup_abort_sender(run_state.as_ref(), &conversation_id).await;
    result
}

async fn run_task_via_headless_inner(
    app: AppHandle,
    input: &RunTaskInput,
    request_id: &str,
    run_state: Arc<RunState>,
) -> Result<(), HeadlessRunError> {
    let payload = json!({
        "requestId": request_id,
        "task": {
            "messageId": input.message_id.clone(),
            "content": input.content.clone(),
            "contentParts": input.content_parts.clone().unwrap_or_default(),
            "agentName": input.agent_name.clone(),
            "modelRef": input.model_ref.clone(),
            "runMode": input.run_mode.clone(),
            "thinking": input.thinking.clone(),
            "webSearchProvider": input.web_search_provider.clone(),
            "debugMode": input.debug_mode,
        },
        "session": {
            "backend": "db",
            "mode": "resume",
            "conversationId": input.conversation_id.clone(),
        },
        "output": {
            "mode": "jsonl",
            "includeEvents": false,
            "includeMessages": false,
        }
    });
    let payload_text = serde_json::to_string(&payload).map_err(|err| {
        HeadlessRunError::new(
            "HEADLESS_PAYLOAD_ERROR",
            format!("构造 headless 请求失败：{err}"),
            true,
        )
    })?;

    let (mut child, used_command) = spawn_headless_process()?;
    let stdout = child.stdout.take().ok_or_else(|| {
        HeadlessRunError::new(
            "HEADLESS_IO_ERROR",
            "headless stdout 未就绪，无法读取事件",
            true,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        HeadlessRunError::new(
            "HEADLESS_IO_ERROR",
            "headless stderr 未就绪，无法读取错误信息",
            true,
        )
    })?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        HeadlessRunError::new(
            "HEADLESS_IO_ERROR",
            "headless stdin 未就绪，无法发送请求",
            true,
        )
    })?;

    stdin
        .write_all(payload_text.as_bytes())
        .await
        .map_err(|err| {
            HeadlessRunError::new(
                "HEADLESS_IO_ERROR",
                format!("写入 headless stdin 失败：{err}"),
                true,
            )
        })?;
    stdin.write_all(b"\n").await.map_err(|err| {
        HeadlessRunError::new(
            "HEADLESS_IO_ERROR",
            format!("写入 headless stdin 换行失败：{err}"),
            true,
        )
    })?;
    stdin.flush().await.map_err(|err| {
        HeadlessRunError::new(
            "HEADLESS_IO_ERROR",
            format!("flush headless stdin 失败：{err}"),
            true,
        )
    })?;
    drop(stdin);

    let collector = Arc::new(StdMutex::new(HeadlessStdoutCollector::default()));
    let stderr_tail = Arc::new(StdMutex::new(VecDeque::<String>::new()));

    let collector_for_stdout = collector.clone();
    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| format!("读取 headless stdout 失败：{e}"))?
        {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            {
                let mut state = collector_for_stdout
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                push_tail(
                    &mut state.stdout_tail,
                    trimmed.to_string(),
                    HEADLESS_STDOUT_TAIL_LIMIT,
                );
            }

            match serde_json::from_str::<Value>(trimmed) {
                Ok(parsed) => {
                    let line_type = parsed.get("type").and_then(Value::as_str).unwrap_or("");
                    match line_type {
                        "run_event" => {
                            if let Some(event) = parsed.get("event").cloned() {
                                let _ = app_for_stdout.emit(RUN_EVENT_NAME, event);
                                let mut state = collector_for_stdout
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                state.run_event_count += 1;
                            } else {
                                let mut state = collector_for_stdout
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                push_tail(
                                    &mut state.parse_errors,
                                    format!("run_event 缺少 event 字段：{trimmed}"),
                                    HEADLESS_PARSE_ERROR_TAIL_LIMIT,
                                );
                            }
                        }
                        "final" => {
                            if let Some(data) = parsed.get("data").cloned() {
                                let mut state = collector_for_stdout
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                state.final_data = Some(data);
                            } else {
                                let mut state = collector_for_stdout
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                push_tail(
                                    &mut state.parse_errors,
                                    format!("final 缺少 data 字段：{trimmed}"),
                                    HEADLESS_PARSE_ERROR_TAIL_LIMIT,
                                );
                            }
                        }
                        _ => {}
                    }
                }
                Err(err) => {
                    let mut state = collector_for_stdout
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    push_tail(
                        &mut state.parse_errors,
                        format!("stdout JSON 解析失败：{err}; line={trimmed}"),
                        HEADLESS_PARSE_ERROR_TAIL_LIMIT,
                    );
                }
            }
        }
        Ok::<(), String>(())
    });

    let stderr_tail_for_task = stderr_tail.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| format!("读取 headless stderr 失败：{e}"))?
        {
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                continue;
            }
            let mut tail = stderr_tail_for_task
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            push_tail(&mut tail, trimmed, HEADLESS_STDERR_TAIL_LIMIT);
        }
        Ok::<(), String>(())
    });

    let (abort_tx, mut abort_rx) = mpsc::channel::<()>(1);
    {
        let mut senders = run_state.abort_senders.write().await;
        senders.insert(input.conversation_id.clone(), abort_tx);
    }
    run_state.register_run(&input.conversation_id).await;

    let mut aborted = false;
    let mut abort_started_at: Option<Instant> = None;
    let exit_status = loop {
        tokio::select! {
            maybe_abort = abort_rx.recv(), if !aborted => {
                if maybe_abort.is_some() {
                    aborted = true;
                    abort_started_at = Some(Instant::now());
                    let _ = child.start_kill();
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(RUN_ABORT_POLL_INTERVAL_MS)) => {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) => {
                        if aborted
                            && abort_started_at
                                .is_some_and(|t| t.elapsed() > Duration::from_secs(RUN_ABORT_MAX_WAIT_SECS))
                        {
                            let _ = child.start_kill();
                            return Err(HeadlessRunError::new(
                                "HEADLESS_ABORT_TIMEOUT",
                                "中止任务后等待子进程退出超时，请重试。",
                                false,
                            ));
                        }
                    }
                    Err(err) => {
                        return Err(HeadlessRunError::new(
                            "HEADLESS_WAIT_ERROR",
                            format!("等待 headless 子进程失败：{err}"),
                            false,
                        ));
                    }
                }
            }
        }
    };

    let stdout_result = stdout_task.await.map_err(|err| {
        let allow_fallback = collector
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .run_event_count
            == 0;
        HeadlessRunError::new(
            "HEADLESS_STDOUT_TASK_ERROR",
            format!("等待 stdout 读取任务失败：{err}"),
            allow_fallback,
        )
    })?;
    if let Err(err_msg) = stdout_result {
        let allow_fallback = collector
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .run_event_count
            == 0;
        return Err(HeadlessRunError::new(
            "HEADLESS_STDOUT_ERROR",
            err_msg,
            allow_fallback,
        ));
    }

    let stderr_result = stderr_task.await.map_err(|err| {
        let allow_fallback = collector
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .run_event_count
            == 0;
        HeadlessRunError::new(
            "HEADLESS_STDERR_TASK_ERROR",
            format!("等待 stderr 读取任务失败：{err}"),
            allow_fallback,
        )
    })?;
    if let Err(err_msg) = stderr_result {
        let allow_fallback = collector
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .run_event_count
            == 0;
        return Err(HeadlessRunError::new(
            "HEADLESS_STDERR_ERROR",
            err_msg,
            allow_fallback,
        ));
    }

    let (final_data, stdout_tail, parse_errors, run_event_count) = {
        let state = collector
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            state.final_data.clone(),
            state.stdout_tail.clone(),
            state.parse_errors.clone(),
            state.run_event_count,
        )
    };
    let stderr_tail = {
        stderr_tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    };

    if aborted {
        // 用户主动中止：以幂等成功返回，避免“取消后仍报错”。
        return Ok(());
    }

    let Some(final_data) = final_data else {
        let mut details = vec![
            format!("headless 命令：{used_command}"),
            format!("子进程退出码：{:?}", exit_status.code()),
            format!("run_event 数量：{run_event_count}"),
            format!("stdout_tail:\n{}", tail_lines_to_text(&stdout_tail)),
        ];
        if !parse_errors.is_empty() {
            details.push(format!(
                "stdout 解析错误（tail）:\n{}",
                tail_lines_to_text(&parse_errors)
            ));
        }
        if !stderr_tail.is_empty() {
            details.push(format!(
                "stderr_tail:\n{}",
                tail_lines_to_text(&stderr_tail)
            ));
        }
        return Err(HeadlessRunError::new(
            "HEADLESS_PROTOCOL_ERROR",
            format!(
                "headless 未返回 final 结果（可能在协议层提前结束）。\n\n{}",
                details.join("\n\n")
            ),
            run_event_count == 0,
        ));
    };

    if final_data
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }

    if is_abort_like_error(&final_data) {
        return Ok(());
    }

    let error_obj = final_data.get("error").cloned().unwrap_or(Value::Null);
    let error_code = error_obj
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("HEADLESS_RUN_FAILED")
        .to_string();
    let base_message = error_obj
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("headless 任务失败")
        .to_string();

    let mut sections: Vec<String> = vec![
        format!("headless 命令：{used_command}"),
        format!("子进程退出码：{:?}", exit_status.code()),
        format!("run_event 数量：{run_event_count}"),
    ];

    if let Some(details) = error_obj.get("details") {
        if let Some(line) = format_error_origin_from_details(details) {
            sections.push(line);
        }
        if let Some(line) = format_stream_termination_from_details(details) {
            sections.push(line);
        }
        sections.push(format!("error.details={}", serialize_json_compact(details)));
    }

    if let Some(debug_info) = error_obj.get("debugInfo") {
        if let Some(line) = format_debug_origin_from_debug_info(debug_info) {
            sections.push(line);
        }
        if let Some(line) = format_debug_stream_termination_from_debug_info(debug_info) {
            sections.push(line);
        }
    }

    if !parse_errors.is_empty() {
        sections.push(format!(
            "stdout 解析错误（tail）:\n{}",
            tail_lines_to_text(&parse_errors)
        ));
    }
    if !stderr_tail.is_empty() {
        sections.push(format!(
            "stderr_tail:\n{}",
            tail_lines_to_text(&stderr_tail)
        ));
    }
    if !stdout_tail.is_empty() {
        sections.push(format!(
            "stdout_tail:\n{}",
            tail_lines_to_text(&stdout_tail)
        ));
    }

    Err(HeadlessRunError::new(
        &error_code,
        format!("{base_message}\n\n{}", sections.join("\n")),
        false,
    ))
}

#[tauri::command]
pub async fn run_task(
    app: AppHandle,
    conversation_id: String,
    message_id: Option<String>,
    content: String,
    content_parts: Option<Vec<ContentPart>>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    run_mode: Option<String>,
    thinking: Option<serde_json::Value>,
    web_search_provider: Option<String>,
    debug_mode: Option<bool>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), SerializableError> {
    let request_id = message_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    match reserve_run_request(&conversation_id, &request_id).await? {
        RunReserveOutcome::DuplicateInFlight | RunReserveOutcome::DuplicateCompleted => {
            return Ok(());
        }
        RunReserveOutcome::Reserved => {}
    }

    let run_input = RunTaskInput {
        conversation_id: conversation_id.clone(),
        message_id,
        content,
        content_parts,
        agent_name,
        model_ref,
        run_mode,
        thinking,
        web_search_provider,
        debug_mode,
        base_messages_override: None,
        start_turn_index: None,
        assistant_message_id_override: None,
    };

    let config = match config_manager.ensure_default() {
        Ok(cfg) => cfg,
        Err(err) => {
            release_run_request(&conversation_id, &request_id, false).await;
            return Err(build_serializable_error("CONFIG_ERROR", err.to_string()));
        }
    };
    let should_use_headless = should_try_headless_runner(&config, &run_input);

    let result = if should_use_headless {
        match run_task_via_headless(
            app.clone(),
            &run_input,
            &request_id,
            run_state.inner().clone(),
        )
        .await
        {
            Ok(()) => Ok(()),
            Err(headless_err) if headless_err.allow_in_process_fallback => {
                run_task_impl(
                    app,
                    run_input,
                    db.inner().clone(),
                    config_manager.inner().clone(),
                    run_state.inner().clone(),
                )
                .await
            }
            Err(headless_err) => Err(headless_err.error),
        }
    } else {
        run_task_impl(
            app,
            run_input,
            db.inner().clone(),
            config_manager.inner().clone(),
            run_state.inner().clone(),
        )
        .await
    };

    release_run_request(&conversation_id, &request_id, result.is_ok()).await;
    result
}

#[tauri::command]
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
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), SerializableError> {
    retry_turn_impl(
        app,
        conversation_id,
        assistant_message_id,
        turn_id,
        agent_name,
        model_ref,
        run_mode,
        thinking,
        web_search_provider,
        debug_mode,
        db.inner().clone(),
        config_manager.inner().clone(),
        run_state.inner().clone(),
    )
    .await
}

#[tauri::command]
pub async fn abort_run(
    conversation_id: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    // Best-effort：abort + wait，确保 run fully 退出（避免并发写入导致状态错乱）
    run_state.abort_and_wait(&conversation_id, 5_000).await;
    Ok(())
}

#[tauri::command]
pub async fn respond_approval(
    conversation_id: String,
    request_id: String,
    decision: ApprovalDecision,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    if run_state
        .resolve_approval(&conversation_id, &request_id, decision)
        .await
    {
        Ok(())
    } else {
        Err("没有找到待审批的请求（可能已超时/已处理/任务已结束）".to_string())
    }
}
