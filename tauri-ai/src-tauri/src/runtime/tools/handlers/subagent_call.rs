use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use crate::ai_client::ToolCall;
use crate::models::InternalAgentImplementation;
use crate::runtime::tools::handlers::agent_task::{
    run_internal_agent_once, InternalAgentRunRequest,
};
use crate::runtime::tools::handlers::external_agent::{
    run_external_agent_once, ExternalAgentOnceRequest,
};
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::spec::ToolSpec;

pub const SUBAGENT_CALL_TOOL_NAME: &str = "subagent_call";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentCallArgs {
    target: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    model_ref: Option<String>,
    #[serde(default)]
    run_mode: Option<String>,
    #[serde(default)]
    thinking: Option<serde_json::Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
}

enum SubagentTarget {
    Internal(String),
    External(String),
}

pub struct SubagentCallTool {
    implementation: InternalAgentImplementation,
}

impl SubagentCallTool {
    pub fn new(implementation: InternalAgentImplementation) -> Self {
        Self { implementation }
    }
}

fn build_spec(implementation: InternalAgentImplementation) -> ToolSpec {
    let internal_impl = match implementation {
        InternalAgentImplementation::InProcess => "in_process",
        InternalAgentImplementation::Subprocess => "subprocess",
    };

    ToolSpec {
        name: SUBAGENT_CALL_TOOL_NAME.to_string(),
        description: Some(format!(
            "统一的一次性子 Agent 调用。`target` 必须写成 `internal:<task_agent>` 或 `external:<adapter>`；内部目标当前默认执行方式为 {internal_impl}。"
        )),
        parameters: json!({
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "目标标识：`internal:<task_agent_name>` 或 `external:<adapter_name>`" },
                "prompt": { "type": "string", "description": "子任务提示词（推荐）" },
                "content": { "type": "string", "description": "兼容字段，与 prompt 等价" },
                "model_ref": { "type": "string", "description": "可选：覆盖目标默认 model_ref" },
                "run_mode": { "type": "string", "description": "可选：覆盖目标默认 run_mode" },
                "thinking": { "description": "可选：覆盖目标默认 thinking 参数（boolean/string/object）" },
                "timeout_ms": { "type": "integer", "description": "可选：超时（毫秒）" },
                "cwd": { "type": "string", "description": "可选：仅 external 目标使用，指定外部 agent 进程工作目录" }
            },
            "required": ["target"],
            "additionalProperties": false
        }),
        required_permissions: vec![ToolPermission::ShellExec],
    }
}

fn parse_args(call: &ToolCall) -> Result<SubagentCallArgs, ToolError> {
    serde_json::from_str::<SubagentCallArgs>(&call.arguments)
        .map_err(|e| ToolError::invalid(format!("subagent_call 参数不是合法 JSON: {e}")))
}

fn resolve_prompt(args: &SubagentCallArgs) -> Result<String, ToolError> {
    args.prompt
        .as_deref()
        .or(args.content.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ToolError::invalid("subagent_call 缺少 prompt（或 content）参数"))
}

fn parse_target(raw: &str) -> Result<SubagentTarget, ToolError> {
    let trimmed = raw.trim();
    if let Some(name) = trimmed.strip_prefix("internal:") {
        let name = name.trim();
        if name.is_empty() {
            return Err(ToolError::invalid(
                "subagent_call 的 internal 目标不能为空，请写成 internal:<task_agent_name>",
            ));
        }
        return Ok(SubagentTarget::Internal(name.to_string()));
    }
    if let Some(name) = trimmed.strip_prefix("external:") {
        let name = name.trim();
        if name.is_empty() {
            return Err(ToolError::invalid(
                "subagent_call 的 external 目标不能为空，请写成 external:<adapter_name>",
            ));
        }
        return Ok(SubagentTarget::External(name.to_string()));
    }
    Err(ToolError::invalid(
        "subagent_call 的 target 必须写成 `internal:<task_agent_name>` 或 `external:<adapter_name>`",
    ))
}

#[async_trait]
impl ToolHandler for SubagentCallTool {
    fn spec(&self) -> ToolSpec {
        build_spec(self.implementation.clone())
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args = parse_args(call)?;
        let prompt = resolve_prompt(&args)?;
        match parse_target(&args.target)? {
            SubagentTarget::Internal(agent_name) => {
                if args
                    .cwd
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    return Err(ToolError::invalid(
                        "subagent_call 指向 internal 目标时不支持 cwd；内部 TaskAgent 会直接复用当前 TauriAI 上下文。",
                    ));
                }
                let result = run_internal_agent_once(
                    self.implementation.clone(),
                    &InternalAgentRunRequest {
                        prompt,
                        agent_name: Some(agent_name.clone()),
                        model_ref: args.model_ref,
                        run_mode: args.run_mode,
                        thinking: args.thinking,
                        timeout_ms: args.timeout_ms,
                    },
                    ctx,
                    &call.id,
                )
                .await?;
                let internal_meta = result
                    .meta
                    .as_ref()
                    .and_then(|value| value.get("internalAgent"))
                    .cloned();
                Ok(ToolCallResult {
                    content: serde_json::to_string_pretty(&json!({
                        "source": "internal",
                        "target": format!("internal:{agent_name}"),
                        "content": result.content,
                        "details": internal_meta,
                    }))
                    .unwrap_or_else(|_| result.content.clone()),
                    meta: Some(json!({
                        "subagentCall": {
                            "source": "internal",
                            "target": format!("internal:{agent_name}"),
                            "details": result.meta,
                        }
                    })),
                })
            }
            SubagentTarget::External(agent_name) => {
                let proxy_call = ToolCall {
                    id: call.id.clone(),
                    name: SUBAGENT_CALL_TOOL_NAME.to_string(),
                    arguments: serde_json::to_string(&ExternalAgentOnceRequest {
                        prompt: Some(prompt),
                        content: None,
                        target: Some(format!("external:{agent_name}")),
                        agent_name: None,
                        model_ref: args.model_ref,
                        run_mode: args.run_mode,
                        thinking: args.thinking,
                        timeout_ms: args.timeout_ms,
                        cwd: args.cwd,
                    })
                    .map_err(|e| {
                        ToolError::internal(format!("subagent_call 构造 external 请求失败: {e}"))
                    })?,
                    thought_signature: call.thought_signature.clone(),
                };
                run_external_agent_once(ctx, &proxy_call).await
            }
        }
    }
}
