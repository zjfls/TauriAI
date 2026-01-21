use async_trait::async_trait;

use crate::ai_client::ToolCall;

use crate::runtime::events::RunEvent;
use crate::runtime::tools::registry::{ToolCallResult, ToolError, ToolExecutionContext, ToolHandler};
use crate::runtime::tools::spec::ToolSpec;

pub struct EchoTool;

#[async_trait]
impl ToolHandler for EchoTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "echo".to_string(),
            description: Some("原样返回传入的文本（链路自测）".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "要回显的文本" }
                },
                "required": ["text"],
                "additionalProperties": false
            }),
            required_permissions: vec![],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let v: serde_json::Value = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("参数不是合法 JSON: {e}")))?;
        let text = v
            .get("text")
            .and_then(|t| t.as_str())
            .ok_or_else(|| ToolError::invalid("缺少参数 text"))?;
        ctx.emitter.emit(RunEvent::BlockDelta {
            task_id: ctx.task_id.to_string(),
            turn_id: ctx.turn_id.to_string(),
            assistant_message_id: Some(ctx.assistant_message_id.to_string()),
            block_id: format!("tool_result:{}", call.id),
            block_type: "tool_result".to_string(),
            format: Some("plain".to_string()),
            delta: text.to_string(),
        });
        Ok(ToolCallResult {
            content: text.to_string(),
        })
    }
}

pub struct GetTimeTool;

#[async_trait]
impl ToolHandler for GetTimeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "get_time".to_string(),
            description: Some("返回当前 UTC 时间（ISO8601）".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            }),
            required_permissions: vec![],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let content = chrono::Utc::now().to_rfc3339();
        ctx.emitter.emit(RunEvent::BlockDelta {
            task_id: ctx.task_id.to_string(),
            turn_id: ctx.turn_id.to_string(),
            assistant_message_id: Some(ctx.assistant_message_id.to_string()),
            block_id: format!("tool_result:{}", call.id),
            block_type: "tool_result".to_string(),
            format: Some("plain".to_string()),
            delta: content.clone(),
        });
        Ok(ToolCallResult { content })
    }
}
