use serde::Deserialize;
use serde_json::Value;

use crate::models::ContentPart;
use crate::runtime::tools::handlers::external_agent::{
    close_external_agent_session_direct, send_external_agent_session_direct,
    standalone_session_scope, start_external_agent_session_direct, DirectAgentSessionSendRequest,
    DirectAgentSessionStartRequest, ExternalAgentSessionCommandResult, ExternalAgentSessionScope,
    ExternalAgentSessionScopeKind, ExternalAgentSessionSummary,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentSessionScopeInput {
    kind: ExternalAgentSessionScopeKind,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartExternalAgentSessionInput {
    #[serde(default)]
    scope: Option<ExternalAgentSessionScopeInput>,
    agent_name: String,
    content: String,
    #[serde(default)]
    content_parts: Vec<ContentPart>,
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
pub struct SendExternalAgentSessionInput {
    session_id: String,
    content: String,
    #[serde(default)]
    content_parts: Vec<ContentPart>,
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

fn into_scope(input: ExternalAgentSessionScopeInput) -> ExternalAgentSessionScope {
    ExternalAgentSessionScope {
        kind: input.kind,
        id: input.id,
    }
}

#[tauri::command]
pub async fn start_external_agent_session(
    request: StartExternalAgentSessionInput,
) -> Result<ExternalAgentSessionCommandResult, String> {
    start_external_agent_session_direct(DirectAgentSessionStartRequest {
        scope: request
            .scope
            .map(into_scope)
            .unwrap_or_else(standalone_session_scope),
        agent_name: request.agent_name,
        content: request.content,
        content_parts: request.content_parts,
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
pub async fn send_external_agent_session(
    request: SendExternalAgentSessionInput,
) -> Result<ExternalAgentSessionCommandResult, String> {
    send_external_agent_session_direct(DirectAgentSessionSendRequest {
        session_id: request.session_id,
        content: request.content,
        content_parts: request.content_parts,
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
pub async fn close_external_agent_session(
    session_id: String,
    delete_session_db: Option<bool>,
) -> Result<ExternalAgentSessionSummary, String> {
    close_external_agent_session_direct(&session_id, delete_session_db.unwrap_or(false))
        .await
        .map_err(|error| error.message)
}
