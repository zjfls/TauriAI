use serde::Deserialize;
use serde_json::Value;

use crate::runtime::tools::handlers::external_agent::{
    close_external_agent_session_direct, conversation_session_scope,
    get_external_agent_session_detail, list_external_agent_sessions,
    send_external_agent_session_direct, standalone_session_scope,
    start_external_agent_session_direct, DirectAgentSessionSendRequest,
    DirectAgentSessionStartRequest, ExternalAgentSessionCommandResult, ExternalAgentSessionDetail,
    ExternalAgentSessionScope, ExternalAgentSessionScopeKind, ExternalAgentSessionSummary,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionScopeInput {
    kind: ExternalAgentSessionScopeKind,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentSessionInput {
    #[serde(default)]
    scope: Option<AgentSessionScopeInput>,
    agent_name: String,
    prompt: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    model_ref: Option<String>,
    #[serde(default)]
    run_mode: Option<String>,
    #[serde(default)]
    thinking: Option<Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAgentSessionInput {
    session_id: String,
    prompt: String,
    #[serde(default)]
    model_ref: Option<String>,
    #[serde(default)]
    run_mode: Option<String>,
    #[serde(default)]
    thinking: Option<Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
}

fn into_scope(input: AgentSessionScopeInput) -> ExternalAgentSessionScope {
    match input.kind {
        ExternalAgentSessionScopeKind::Conversation => conversation_session_scope(&input.id),
        kind => ExternalAgentSessionScope { kind, id: input.id },
    }
}

#[tauri::command]
pub async fn list_agent_sessions(
    scope: Option<AgentSessionScopeInput>,
) -> Result<Vec<ExternalAgentSessionSummary>, String> {
    let resolved_scope = scope.map(into_scope);
    list_external_agent_sessions(resolved_scope.as_ref()).map_err(|error| error.message)
}

#[tauri::command]
pub async fn get_agent_session_detail(
    session_id: String,
) -> Result<ExternalAgentSessionDetail, String> {
    get_external_agent_session_detail(&session_id)
        .await
        .map_err(|error| error.message)
}

#[tauri::command]
pub async fn start_agent_session(
    request: StartAgentSessionInput,
) -> Result<ExternalAgentSessionCommandResult, String> {
    start_external_agent_session_direct(DirectAgentSessionStartRequest {
        scope: request
            .scope
            .map(into_scope)
            .unwrap_or_else(standalone_session_scope),
        agent_name: request.agent_name,
        prompt: request.prompt,
        title: request.title,
        model_ref: request.model_ref,
        run_mode: request.run_mode,
        thinking: request.thinking,
        timeout_ms: request.timeout_ms,
        cwd: request.cwd,
    })
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn send_agent_session_message(
    request: SendAgentSessionInput,
) -> Result<ExternalAgentSessionCommandResult, String> {
    send_external_agent_session_direct(DirectAgentSessionSendRequest {
        session_id: request.session_id,
        prompt: request.prompt,
        model_ref: request.model_ref,
        run_mode: request.run_mode,
        thinking: request.thinking,
        timeout_ms: request.timeout_ms,
        cwd: request.cwd,
    })
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn close_agent_session(
    session_id: String,
    delete_session_db: Option<bool>,
) -> Result<ExternalAgentSessionDetail, String> {
    close_external_agent_session_direct(&session_id, delete_session_db.unwrap_or(false))
        .await
        .map_err(|error| error.message)
}
