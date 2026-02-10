use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use rmcp::model::{
    ListResourceTemplatesResult, ListResourcesResult, ReadResourceResult, Resource,
    ResourceTemplate,
};
use serde::{Deserialize, Serialize};

use crate::ai_client::ToolCall;
use crate::models::McpServerConfig;
use crate::runtime::events::RunEvent;
use crate::runtime::mcp::global_mcp_runtime;
use crate::runtime::tools::permissions::ToolPermission;
use crate::runtime::tools::registry::{
    ToolCallResult, ToolError, ToolExecutionContext, ToolHandler,
};
use crate::runtime::tools::spec::ToolSpec;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListResourcesArgs {
    /// Optional MCP server name. When omitted, lists resources from every configured server.
    #[serde(default)]
    server: Option<String>,
    /// Opaque cursor returned by a previous list_mcp_resources call for the same server.
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListResourceTemplatesArgs {
    /// Optional MCP server name. When omitted, lists resource templates from all configured servers.
    #[serde(default)]
    server: Option<String>,
    /// Opaque cursor returned by a previous list_mcp_resource_templates call for the same server.
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResourceArgs {
    /// MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.
    server: String,
    /// Resource URI to read. Must be one of the URIs returned by list_mcp_resources.
    uri: String,
}

#[derive(Debug, Serialize)]
struct ResourceWithServer {
    server: String,
    #[serde(flatten)]
    resource: Resource,
}

impl ResourceWithServer {
    fn new(server: String, resource: Resource) -> Self {
        Self { server, resource }
    }
}

#[derive(Debug, Serialize)]
struct ResourceTemplateWithServer {
    server: String,
    #[serde(flatten)]
    template: ResourceTemplate,
}

impl ResourceTemplateWithServer {
    fn new(server: String, template: ResourceTemplate) -> Self {
        Self { server, template }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResourcesPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    resources: Vec<ResourceWithServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

impl ListResourcesPayload {
    fn from_single_server(server: String, result: ListResourcesResult) -> Self {
        let resources = result
            .resources
            .into_iter()
            .map(|resource| ResourceWithServer::new(server.clone(), resource))
            .collect();
        Self {
            server: Some(server),
            resources,
            next_cursor: result.next_cursor,
        }
    }

    fn from_all_servers(resources_by_server: HashMap<String, Vec<Resource>>) -> Self {
        let mut entries: Vec<(String, Vec<Resource>)> = resources_by_server.into_iter().collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        let mut resources = Vec::new();
        for (server, server_resources) in entries {
            for resource in server_resources {
                resources.push(ResourceWithServer::new(server.clone(), resource));
            }
        }

        Self {
            server: None,
            resources,
            next_cursor: None,
        }
    }
}

fn is_resource_allowed(uri: &str, cfg: &McpServerConfig) -> bool {
    if !cfg.enabled_resources.is_empty() && !cfg.enabled_resources.iter().any(|x| x == uri) {
        return false;
    }
    if cfg.disabled_resources.iter().any(|x| x == uri) {
        return false;
    }
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResourceTemplatesPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    resource_templates: Vec<ResourceTemplateWithServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

impl ListResourceTemplatesPayload {
    fn from_single_server(server: String, result: ListResourceTemplatesResult) -> Self {
        let resource_templates = result
            .resource_templates
            .into_iter()
            .map(|template| ResourceTemplateWithServer::new(server.clone(), template))
            .collect();
        Self {
            server: Some(server),
            resource_templates,
            next_cursor: result.next_cursor,
        }
    }

    fn from_all_servers(templates_by_server: HashMap<String, Vec<ResourceTemplate>>) -> Self {
        let mut entries: Vec<(String, Vec<ResourceTemplate>)> =
            templates_by_server.into_iter().collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        let mut resource_templates = Vec::new();
        for (server, server_templates) in entries {
            for template in server_templates {
                resource_templates.push(ResourceTemplateWithServer::new(server.clone(), template));
            }
        }

        Self {
            server: None,
            resource_templates,
            next_cursor: None,
        }
    }
}

#[derive(Debug, Serialize)]
struct ReadResourcePayload {
    server: String,
    uri: String,
    #[serde(flatten)]
    result: ReadResourceResult,
}

fn normalize_optional_string(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
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

fn parse_json<T: for<'de> Deserialize<'de>>(args: &str) -> Result<T, ToolError> {
    let raw = args.trim();
    let raw = if raw.is_empty() { "{}" } else { raw };
    serde_json::from_str(raw).map_err(|e| ToolError::invalid(format!("瑙ｆ瀽鍙傛暟澶辫触: {e}")))
}

pub struct ListMcpResourcesTool {
    pub servers: Arc<HashMap<String, McpServerConfig>>,
}

#[async_trait]
impl ToolHandler for ListMcpResourcesTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_mcp_resources".to_string(),
            description: Some("Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "server": { "type": "string", "description": "Optional MCP server name. When omitted, lists resources from every configured server." },
                    "cursor": { "type": "string", "description": "Opaque cursor returned by a previous list_mcp_resources call for the same server." }
                },
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::McpExec],
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
        let args: ListResourcesArgs = parse_json(&call.arguments)?;
        let server = normalize_optional_string(args.server);
        let cursor = normalize_optional_string(args.cursor);

        let runtime = global_mcp_runtime();

        let payload = if let Some(server_name) = server {
            let cfg = self.servers.get(&server_name).ok_or_else(|| {
                ToolError::denied(format!(
                    "MCP server '{server_name}' 未配置或不在当前可用范围内"
                ))
            })?;
            let mut result = runtime
                .list_resources(&server_name, cfg, cursor)
                .await
                .map_err(|e| ToolError::new(format!("MCP resources/list 失败: {e}")))?;
            result.resources = result
                .resources
                .into_iter()
                .filter(|r| is_resource_allowed(r.uri.as_str(), cfg))
                .collect();
            ListResourcesPayload::from_single_server(server_name, result)
        } else {
            if cursor.is_some() {
                return Err(ToolError::invalid(
                    "cursor 只能在指定 server 时使用（请传入 server 字段）",
                ));
            }

            let mut all: HashMap<String, Vec<Resource>> = HashMap::new();
            for (server_name, cfg) in self.servers.iter() {
                let resources =
                    runtime
                        .list_all_resources(server_name, cfg)
                        .await
                        .map_err(|e| {
                            ToolError::new(format!(
                                "MCP resources/list_all 失败: server={server_name} err={e}"
                            ))
                        })?;
                let filtered = resources
                    .into_iter()
                    .filter(|r| is_resource_allowed(r.uri.as_str(), cfg))
                    .collect();
                all.insert(server_name.clone(), filtered);
            }
            ListResourcesPayload::from_all_servers(all)
        };

        let output = serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| serde_json::json!(payload).to_string());
        emit_tool_result(ctx, call.id.as_str(), &output);
        Ok(ToolCallResult { content: output })
    }
}

pub struct ListMcpResourceTemplatesTool {
    pub servers: Arc<HashMap<String, McpServerConfig>>,
}

#[async_trait]
impl ToolHandler for ListMcpResourceTemplatesTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_mcp_resource_templates".to_string(),
            description: Some("Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "server": { "type": "string", "description": "Optional MCP server name. When omitted, lists resource templates from all configured servers." },
                    "cursor": { "type": "string", "description": "Opaque cursor returned by a previous list_mcp_resource_templates call for the same server." }
                },
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::McpExec],
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
        let args: ListResourceTemplatesArgs = parse_json(&call.arguments)?;
        let server = normalize_optional_string(args.server);
        let cursor = normalize_optional_string(args.cursor);

        let runtime = global_mcp_runtime();

        let payload = if let Some(server_name) = server {
            let cfg = self.servers.get(&server_name).ok_or_else(|| {
                ToolError::denied(format!(
                    "MCP server '{server_name}' 未配置或不在当前可用范围内"
                ))
            })?;
            let result = runtime
                .list_resource_templates(&server_name, cfg, cursor)
                .await
                .map_err(|e| ToolError::new(format!("MCP resources/templates/list 失败: {e}")))?;
            ListResourceTemplatesPayload::from_single_server(server_name, result)
        } else {
            if cursor.is_some() {
                return Err(ToolError::invalid(
                    "cursor 只能在指定 server 时使用（请传入 server 字段）",
                ));
            }

            let mut all: HashMap<String, Vec<ResourceTemplate>> = HashMap::new();
            for (server_name, cfg) in self.servers.iter() {
                let templates = runtime
                    .list_all_resource_templates(server_name, cfg)
                    .await
                    .map_err(|e| {
                        ToolError::new(format!(
                            "MCP resources/templates/list_all 失败: server={server_name} err={e}"
                        ))
                    })?;
                all.insert(server_name.clone(), templates);
            }
            ListResourceTemplatesPayload::from_all_servers(all)
        };

        let output = serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| serde_json::json!(payload).to_string());
        emit_tool_result(ctx, call.id.as_str(), &output);
        Ok(ToolCallResult { content: output })
    }
}

pub struct ReadMcpResourceTool {
    pub servers: Arc<HashMap<String, McpServerConfig>>,
}

#[async_trait]
impl ToolHandler for ReadMcpResourceTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read_mcp_resource".to_string(),
            description: Some("Read a specific resource from an MCP server given the server name and resource URI.".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "server": { "type": "string", "description": "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources." },
                    "uri": { "type": "string", "description": "Resource URI to read. Must be one of the URIs returned by list_mcp_resources." }
                },
                "required": ["server", "uri"],
                "additionalProperties": false
            }),
            required_permissions: vec![ToolPermission::McpExec],
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
        let args: ReadResourceArgs = parse_json(&call.arguments)?;
        let server_name = args.server.trim().to_string();
        let uri = args.uri.trim().to_string();
        if server_name.is_empty() {
            return Err(ToolError::invalid("server 不能为空"));
        }
        if uri.is_empty() {
            return Err(ToolError::invalid("uri 不能为空"));
        }

        let cfg = self.servers.get(&server_name).ok_or_else(|| {
            ToolError::denied(format!(
                "MCP server '{server_name}' 未配置或不在当前可用范围内"
            ))
        })?;

        let runtime = global_mcp_runtime();
        if !is_resource_allowed(uri.as_str(), cfg) {
            return Err(ToolError::denied(format!(
                "MCP resource 已被禁用或不在允许列表内: server={server_name} uri={uri}"
            )));
        }

        let result = runtime
            .read_resource(&server_name, cfg, &uri)
            .await
            .map_err(|e| ToolError::new(format!("MCP resources/read 失败: {e}")))?;

        let payload = ReadResourcePayload {
            server: server_name,
            uri,
            result,
        };

        let output = serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| serde_json::json!(payload).to_string());
        emit_tool_result(ctx, call.id.as_str(), &output);
        Ok(ToolCallResult { content: output })
    }
}
