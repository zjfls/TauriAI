//! Mobile chat commands (mobile-first).
//!
//! - `mobile_chat`: 非流式（一次性返回，保留兼容）。
//! - `mobile_chat_stream_*`: 流式（推荐），通过 Tauri event 推送增量到前端。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::OnceLock;

use crate::ai_client::get_client;
use crate::ai_client::{StreamEvent, StreamOptions, ToolCall, ToolDefinition};
use crate::config::ConfigManager;
use crate::models::{
    AppConfig, McpServerConfig, Message, MessageMeta, MessageRole, MessageStatus, ModelConfig,
    ModelParameters,
};
use crate::runtime::mcp::global_mcp_runtime;
use sha1::{Digest, Sha1};
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
    kind: String, // delta | thinking | web_search | tool_calls | tool_result | done | error | canceled
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
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

fn to_messages(conversation_id: &str, messages: Vec<MobileChatMessage>) -> Vec<Message> {
    let now = chrono::Utc::now();
    messages
        .into_iter()
        .enumerate()
        .map(|(i, m)| Message {
            id: format!("mobile_{}", i),
            conversation_id: conversation_id.to_string(),
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

const MCP_TOOL_NAME_DELIMITER: &str = "__";
const MAX_TOOL_NAME_LENGTH: usize = 64;

#[derive(Debug, Clone)]
struct McpToolBinding {
    server_name: String,
    tool_name: String,
    server_config: McpServerConfig,
}

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

fn resolve_enabled_agent<'a>(cfg: &'a AppConfig, agent_name: Option<&str>) -> Option<&'a crate::models::Agent> {
    // Highest priority: explicit agentName from the current conversation (mobile UI)
    if let Some(agent_name) = agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(agent) = cfg.agents.iter().find(|a| a.enabled && a.name == agent_name) {
            return Some(agent);
        }
    }

    // Next: current agent
    if let Some(agent_name) = cfg
        .current_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(agent) = cfg.agents.iter().find(|a| a.enabled && a.name == agent_name) {
            return Some(agent);
        }
    }

    // Next: default agent
    if !cfg.default_agent.trim().is_empty() {
        if let Some(agent) = cfg
            .agents
            .iter()
            .find(|a| a.enabled && a.name == cfg.default_agent)
        {
            return Some(agent);
        }
    }

    // Fallback: first enabled agent
    cfg.agents.iter().find(|a| a.enabled)
}

fn find_last_user_text(messages: &[MobileChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role.trim().eq_ignore_ascii_case("user"))
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn collect_requested_mcp_servers_lower(text: &str) -> HashSet<String> {
    let tool_mentions = crate::mentions::extract_tool_mentions(text);

    let mut requested: HashSet<String> = HashSet::new();
    for name in tool_mentions.plain_names {
        requested.insert(name.to_ascii_lowercase());
    }
    for path in tool_mentions.paths {
        match crate::mentions::tool_kind_for_path(&path) {
            crate::mentions::ToolMentionKind::Mcp => {
                if let Some(id) = crate::mentions::mcp_id_from_path(&path) {
                    requested.insert(id.to_ascii_lowercase());
                }
            }
            crate::mentions::ToolMentionKind::App => {
                if let Some(id) = crate::mentions::app_id_from_path(&path) {
                    requested.insert(id.to_ascii_lowercase());
                }
            }
            _ => {}
        }
    }

    requested
}

async fn build_mcp_tooling_for_mobile(
    cfg: &AppConfig,
    agent_name: Option<&str>,
    user_text: &str,
) -> Result<(Vec<ToolDefinition>, HashMap<String, McpToolBinding>), String> {
    let requested_servers_lower = collect_requested_mcp_servers_lower(user_text);

    // server_name -> server_cfg (enabled only)
    let mut server_map: HashMap<String, McpServerConfig> = HashMap::new();
    for entry in &cfg.mcp.servers {
        if !entry.config.enabled {
            continue;
        }
        server_map.insert(entry.name.clone(), entry.config.clone());
    }
    if server_map.is_empty() {
        return Ok((Vec::new(), HashMap::new()));
    }

    let agent = resolve_enabled_agent(cfg, agent_name);
    let set_name = agent
        .and_then(|a| a.mcp_set.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut tools_out: Vec<ToolDefinition> = Vec::new();
    let mut bindings: HashMap<String, McpToolBinding> = HashMap::new();

    if let Some(set_name) = set_name {
        let Some(mcp_set) = cfg.mcp.sets.iter().find(|s| s.name == set_name) else {
            return Ok((Vec::new(), HashMap::new()));
        };

        // Mention filtering only activates when the user mentioned at least one *valid* server in this set.
        let available_in_set_lower: HashSet<String> = mcp_set
            .servers
            .iter()
            .filter(|s| s.enabled)
            .map(|s| s.server.to_ascii_lowercase())
            .collect();
        let requested_in_set_lower: HashSet<String> = requested_servers_lower
            .intersection(&available_in_set_lower)
            .cloned()
            .collect();
        let filter_by_mention = !requested_in_set_lower.is_empty();

        for set_server in &mcp_set.servers {
            if !set_server.enabled {
                continue;
            }
            if filter_by_mention
                && !requested_in_set_lower.contains(&set_server.server.to_ascii_lowercase())
            {
                continue;
            }
            let Some(server_cfg) = server_map.get(&set_server.server) else {
                continue;
            };

            let tools = match global_mcp_runtime()
                .list_tools_cached(&set_server.server, server_cfg)
                .await
            {
                Ok(t) => t,
                Err(err) => {
                    eprintln!("[mobile][mcp] 列工具失败: server={} err={}", set_server.server, err);
                    continue;
                }
            };

            let mut tools = tools;
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
                let parameters = serde_json::Value::Object((*tool.input_schema).clone());
                tools_out.push(ToolDefinition {
                    name: qualified.clone(),
                    description: tool
                        .description
                        .as_ref()
                        .map(|s| s.as_ref().to_string())
                        .or_else(|| tool.title.clone())
                        .or_else(|| Some(format!("MCP: {}/{}", set_server.server, tool_name))),
                    parameters,
                });
                bindings.insert(
                    qualified,
                    McpToolBinding {
                        server_name: set_server.server.clone(),
                        tool_name,
                        server_config: server_cfg.clone(),
                    },
                );
            }
        }

        return Ok((tools_out, bindings));
    }

    // Unbound: only inject MCP tools when the user explicitly mentions at least one enabled server.
    if requested_servers_lower.is_empty() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let enabled_server_names_lower: HashSet<String> =
        server_map.keys().map(|n| n.to_ascii_lowercase()).collect();
    let requested_enabled_lower: HashSet<String> = requested_servers_lower
        .intersection(&enabled_server_names_lower)
        .cloned()
        .collect();
    if requested_enabled_lower.is_empty() {
        return Ok((Vec::new(), HashMap::new()));
    }

    // Keep config order stable (same as desktop UX).
    for entry in &cfg.mcp.servers {
        let server_name = entry.name.as_str();
        if !entry.config.enabled {
            continue;
        }
        if !requested_enabled_lower.contains(&server_name.to_ascii_lowercase()) {
            continue;
        }
        let server_cfg = &entry.config;

        let tools = match global_mcp_runtime()
            .list_tools_cached(server_name, server_cfg)
            .await
        {
            Ok(t) => t,
            Err(err) => {
                eprintln!("[mobile][mcp] 列工具失败: server={} err={}", server_name, err);
                continue;
            }
        };

        for tool in tools {
            let tool_name = tool.name.as_ref().to_string();
            let qualified = qualify_mcp_tool_name(server_name, &tool_name);
            let parameters = serde_json::Value::Object((*tool.input_schema).clone());
            tools_out.push(ToolDefinition {
                name: qualified.clone(),
                description: tool
                    .description
                    .as_ref()
                    .map(|s| s.as_ref().to_string())
                    .or_else(|| tool.title.clone())
                    .or_else(|| Some(format!("MCP: {}/{}", server_name, tool_name))),
                parameters,
            });
            bindings.insert(
                qualified,
                McpToolBinding {
                    server_name: server_name.to_string(),
                    tool_name,
                    server_config: server_cfg.clone(),
                },
            );
        }
    }

    Ok((tools_out, bindings))
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
    let msgs = to_messages("mobile", messages);

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
    let user_text = find_last_user_text(&messages);
    let msgs = to_messages(&conversation_id, messages);

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
                    data: None,
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
        let (tool_defs, tool_bindings) =
            match build_mcp_tooling_for_mobile(&cfg, agent_name.as_deref(), &user_text).await {
                Ok(v) => v,
                Err(err) => {
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
                            data: None,
                            error: Some(format!("加载 MCP 工具失败: {err}")),
                        },
                    );
                    mobile_streams().lock().await.remove(&stream_id2);
                    return;
                }
            };

        let tools_opt = if tool_defs.is_empty() {
            None
        } else {
            Some(tool_defs)
        };

        let mut model_messages: Vec<Message> = msgs;
        let mut content_buf = String::new();
        let mut thinking_buf = String::new();
        let mut final_content: Option<String> = None;
        let mut final_thinking: Option<String> = None;

        // Tool-call loop (only MCP tools for mobile for now).
        let mut tool_rounds: u32 = 0;
        let max_tool_rounds: u32 = 8;

        // Some("done") | Some("error") | None
        let mut terminal: Option<&'static str> = None;

        while terminal != Some("done") && terminal != Some("error") {
            tool_rounds += 1;
            if tool_rounds > max_tool_rounds {
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
                        data: None,
                        error: Some("工具调用轮次过多（可能出现循环）。".to_string()),
                    },
                );
                terminal = Some("error");
                break;
            }

            let (tx, mut rx) = mpsc::channel::<StreamEvent>(128);

            // 重要：不要额外 `tokio::spawn` 一个 chat_stream 任务，否则取消（abort）外层任务时，
            // chat_stream 仍可能继续跑，导致请求无法可靠取消、占用带宽/额度。
            let mut stream_fut = Box::pin({
                let client = client.clone();
                let model_cfg = model_cfg.clone();
                let msgs = model_messages.clone();
                let tools = tools_opt.clone();
                async move {
                    client
                        .chat_stream(msgs, &model_cfg, tools, tx, StreamOptions::default())
                        .await
                }
            });

            let mut pending_tool_calls: Option<Vec<ToolCall>> = None;
            terminal = None;

            loop {
                tokio::select! {
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
                                        data: None,
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
                                        data: None,
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
                                        data: None,
                                        error: Some(err),
                                    },
                                );
                                terminal = Some("error");
                                break;
                            }
                            StreamEvent::TurnState(_) => {}
                            StreamEvent::ToolCalls(calls) => {
                                emit_mobile_stream_event(
                                    &app2,
                                    MobileChatStreamPayload {
                                        stream_id: stream_id2.clone(),
                                        conversation_id: conversation_id2.clone(),
                                        assistant_message_id: assistant_message_id2.clone(),
                                        kind: "tool_calls".to_string(),
                                        delta: None,
                                        content: None,
                                        thinking: None,
                                        data: Some(serde_json::json!({ "calls": &calls })),
                                        error: None,
                                    },
                                );
                                pending_tool_calls = Some(calls);
                                terminal = Some("tool_calls");
                                break;
                            }
                            StreamEvent::WebSearch { id, status, action } => {
                                emit_mobile_stream_event(
                                    &app2,
                                    MobileChatStreamPayload {
                                        stream_id: stream_id2.clone(),
                                        conversation_id: conversation_id2.clone(),
                                        assistant_message_id: assistant_message_id2.clone(),
                                        kind: "web_search".to_string(),
                                        delta: None,
                                        content: None,
                                        thinking: None,
                                        data: Some(serde_json::json!({
                                            "id": id,
                                            "status": status,
                                            "action": action,
                                        })),
                                        error: None,
                                    },
                                );
                                // web search 是 provider-native 事件流，不能中断本次对话；继续等待 token/done。
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
                                        data: None,
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
                Some("tool_calls") => {
                    let calls = pending_tool_calls.take().unwrap_or_default();
                    if calls.is_empty() {
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
                                data: None,
                                error: Some("模型请求了空的 tool_calls。".to_string()),
                            },
                        );
                        terminal = Some("error");
                        break;
                    }

                    // Append an assistant message that carries tool_calls (OpenAI-compatible).
                    model_messages.push(Message {
                        id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: conversation_id2.clone(),
                        role: MessageRole::Assistant,
                        content: String::new(),
                        content_parts: Vec::new(),
                        thinking: None,
                        meta: Some(MessageMeta {
                            tool_calls: Some(calls.clone()),
                            ..Default::default()
                        }),
                        created_at: chrono::Utc::now(),
                        status: MessageStatus::Success,
                        error_message: None,
                    });

                    for call in calls {
                        let call_id = call.id.clone();
                        let call_name = call.name.clone();

                        let binding = match tool_bindings.get(call.name.as_str()).cloned() {
                            Some(b) => b,
                            None => {
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
                                        data: None,
                                        error: Some(format!("未知工具：{}", call.name)),
                                    },
                                );
                                terminal = Some("error");
                                break;
                            }
                        };

                        let args_value: serde_json::Value = match serde_json::from_str(&call.arguments) {
                            Ok(v) => v,
                            Err(e) => {
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
                                        data: None,
                                        error: Some(format!("解析 tool 参数失败：{e}")),
                                    },
                                );
                                terminal = Some("error");
                                break;
                            }
                        };

                        let result = match global_mcp_runtime()
                            .call_tool(
                                &binding.server_name,
                                &binding.server_config,
                                &binding.tool_name,
                                Some(args_value),
                            )
                            .await
                        {
                            Ok(v) => v,
                            Err(e) => {
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
                                        data: None,
                                        error: Some(format!("MCP tool 调用失败：{e}")),
                                    },
                                );
                                terminal = Some("error");
                                break;
                            }
                        };

                        let output =
                            serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());

                        emit_mobile_stream_event(
                            &app2,
                            MobileChatStreamPayload {
                                stream_id: stream_id2.clone(),
                                conversation_id: conversation_id2.clone(),
                                assistant_message_id: assistant_message_id2.clone(),
                                kind: "tool_result".to_string(),
                                delta: None,
                                content: None,
                                thinking: None,
                                data: Some(serde_json::json!({
                                    "id": call_id,
                                    "name": call_name,
                                    "output": &output,
                                })),
                                error: None,
                            },
                        );

                        model_messages.push(Message {
                            id: uuid::Uuid::new_v4().to_string(),
                            conversation_id: conversation_id2.clone(),
                            role: MessageRole::Tool,
                            content: output,
                            content_parts: Vec::new(),
                            thinking: None,
                            meta: Some(MessageMeta {
                                tool_call_id: Some(call.id),
                                ..Default::default()
                            }),
                            created_at: chrono::Utc::now(),
                            status: MessageStatus::Success,
                            error_message: None,
                        });
                    }

                    if terminal == Some("error") {
                        break;
                    }
                    continue;
                }
                Some("done") => break,
                Some("error") => break,
                None => {
                    // 容错：如果流被关闭但已经拿到内容，按 done 处理；否则报错。
                    let content_trimmed = content_buf.trim();
                    let thinking_trimmed = thinking_buf.trim();
                    if !content_trimmed.is_empty() || !thinking_trimmed.is_empty() {
                        terminal = Some("done");
                        final_content = Some(content_buf.clone());
                        if !thinking_trimmed.is_empty() {
                            final_thinking = Some(thinking_buf.clone());
                        }
                        break;
                    }
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
                            data: None,
                            error: Some("流式响应提前结束（未收到 Done/Error）".to_string()),
                        },
                    );
                    terminal = Some("error");
                    break;
                }
                _ => {}
            }
        }

        if terminal == Some("done") {
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
                    data: None,
                    error: None,
                },
            );
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
                data: None,
                error: None,
            },
        );
    }

    Ok(())
}
