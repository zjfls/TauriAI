use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::external_agents::{
    build_replay_prompt, invoke_cli_transport, ExternalAgentInvocationOutput,
    ExternalAgentReplayMessage, ExternalAgentSessionMode,
};
use crate::models::{ExternalAgentConfig, ExternalAgentTransportType};
use crate::runtime::tools::registry::ToolError;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentProviderSessionRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

impl ExternalAgentProviderSessionRef {
    pub fn from_value(value: Option<&serde_json::Value>) -> Self {
        let Some(value) = value else {
            return Self::default();
        };
        Self {
            conversation_id: value
                .get("conversationId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
            message_id: value
                .get("messageId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
        }
    }

    pub fn conversation_id(&self) -> Option<&str> {
        self.conversation_id.as_deref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalAgentSessionRuntimeKind {
    Once,
    SessionStart,
    SessionSend,
}

#[derive(Debug, Clone)]
pub struct ExternalAgentSessionRuntimeRequest<'a> {
    pub tool_name: &'a str,
    pub external_agent: &'a ExternalAgentConfig,
    pub prompt: &'a str,
    pub title: &'a str,
    pub replay_history: &'a [ExternalAgentReplayMessage],
    pub model_ref: Option<&'a str>,
    pub timeout_ms: u64,
    pub workdir: Option<&'a Path>,
    pub parent_conversation_id: &'a str,
    pub runtime_session_id: Option<&'a str>,
    pub action: Option<&'a str>,
    pub kind: ExternalAgentSessionRuntimeKind,
    pub provider_session: Option<&'a ExternalAgentProviderSessionRef>,
}

#[derive(Debug, Clone)]
pub struct ExternalAgentSessionRuntimeOutput {
    pub invocation: ExternalAgentInvocationOutput,
    pub session_mode: ExternalAgentSessionMode,
    pub provider_session: ExternalAgentProviderSessionRef,
    pub degraded_to_replay: bool,
}

pub async fn run_external_agent_session_runtime(
    request: ExternalAgentSessionRuntimeRequest<'_>,
) -> Result<ExternalAgentSessionRuntimeOutput, ToolError> {
    match request.external_agent.transport.transport_type {
        ExternalAgentTransportType::Headless => Err(ToolError::internal(format!(
            "{} 当前只支持 CLI external agent runtime；headless 应走本地 headless 路径",
            request.tool_name
        ))),
        ExternalAgentTransportType::CodexCli => {
            let prompt = if request.kind == ExternalAgentSessionRuntimeKind::SessionSend {
                build_replay_prompt(request.title, request.replay_history, request.prompt)
            } else {
                request.prompt.to_string()
            };
            let invocation = invoke_cli_transport(
                request.tool_name,
                request.external_agent,
                &prompt,
                request.model_ref,
                request.timeout_ms,
                request.workdir,
                request.parent_conversation_id,
                request.runtime_session_id,
                request.action,
                None,
            )
            .await?;
            Ok(ExternalAgentSessionRuntimeOutput {
                provider_session: ExternalAgentProviderSessionRef::from_value(
                    invocation.session_ref.as_ref(),
                ),
                invocation,
                session_mode: ExternalAgentSessionMode::Replay,
                degraded_to_replay: request.kind == ExternalAgentSessionRuntimeKind::SessionSend,
            })
        }
        ExternalAgentTransportType::ClaudeCode => {
            let existing_provider_session = request.provider_session.cloned().unwrap_or_default();
            let resume_session_id = existing_provider_session.conversation_id();
            let degraded_to_replay = request.kind == ExternalAgentSessionRuntimeKind::SessionSend
                && resume_session_id.is_none()
                && !request.replay_history.is_empty();
            let prompt = if degraded_to_replay {
                build_replay_prompt(request.title, request.replay_history, request.prompt)
            } else {
                request.prompt.to_string()
            };
            let invocation = invoke_cli_transport(
                request.tool_name,
                request.external_agent,
                &prompt,
                request.model_ref,
                request.timeout_ms,
                request.workdir,
                request.parent_conversation_id,
                request.runtime_session_id,
                request.action,
                resume_session_id,
            )
            .await?;
            let mut provider_session =
                ExternalAgentProviderSessionRef::from_value(invocation.session_ref.as_ref());
            if provider_session.conversation_id.is_none() {
                provider_session.conversation_id = existing_provider_session.conversation_id;
            }
            if provider_session.message_id.is_none() {
                provider_session.message_id = existing_provider_session.message_id;
            }
            let session_mode = if degraded_to_replay || provider_session.conversation_id.is_none() {
                ExternalAgentSessionMode::Replay
            } else {
                ExternalAgentSessionMode::Native
            };
            Ok(ExternalAgentSessionRuntimeOutput {
                invocation,
                session_mode,
                provider_session,
                degraded_to_replay,
            })
        }
    }
}
