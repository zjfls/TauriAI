use async_trait::async_trait;
use rmcp::model::Tool as McpTool;

use crate::ai_client::ToolCall;
use crate::models::McpServerConfig;
use crate::runtime::events::RunEvent;
use crate::runtime::mcp::global_mcp_runtime;
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::spec::ToolSpec;

pub struct McpToolHandler {
    pub qualified_name: String,
    pub server_name: String,
    pub tool_name: String,
    pub tool: McpTool,
    pub server_config: McpServerConfig,
}

impl McpToolHandler {
    fn is_read_only_hint(&self) -> bool {
        self.tool
            .annotations
            .as_ref()
            .and_then(|a| a.read_only_hint)
            .unwrap_or(false)
    }
}

#[async_trait]
impl ToolHandler for McpToolHandler {
    fn spec(&self) -> ToolSpec {
        let parameters = serde_json::Value::Object((*self.tool.input_schema).clone());
        ToolSpec {
            name: self.qualified_name.clone(),
            description: self
                .tool
                .description
                .as_ref()
                .map(|s| s.as_ref().to_string())
                .or_else(|| self.tool.title.clone())
                .or_else(|| Some(format!("MCP: {}/{}", self.server_name, self.tool_name))),
            parameters,
            required_permissions: vec![ToolPermission::McpExec],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        // 以 read_only_hint 作为 best-effort；否则默认按“可能有副作用”处理。
        !self.is_read_only_hint()
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        let args_value: serde_json::Value = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 MCP tool 参数失败: {e}")))?;

        let runtime = global_mcp_runtime();
        let result = runtime
            .call_tool(
                &self.server_name,
                &self.server_config,
                &self.tool_name,
                Some(args_value),
            )
            .await
            .map_err(|e| ToolError::new(format!("MCP tools/call 失败: {e}")))?;

        let output = serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());

        emit_tool_result(ctx, call.id.as_str(), &output);
        Ok(ToolCallResult { content: output })
    }
}

fn emit_tool_result(ctx: &mut ToolExecutionContext<'_>, call_id: &str, content: &str) {
    ctx.emitter.emit(RunEvent::BlockDelta {
        task_id: ctx.task_id.to_string(),
        turn_id: ctx.turn_id.to_string(),
        assistant_message_id: Some(ctx.assistant_message_id.to_string()),
        block_id: format!("tool_result:{call_id}"),
        block_type: "tool_result".to_string(),
        format: Some("plain".to_string()),
        delta: content.to_string(),
    });
}
