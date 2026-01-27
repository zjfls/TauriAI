//! MCP (Model Context Protocol) commands for TauriAI

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::config::ConfigManager;
use crate::models::{McpServerEntry, McpSetConfig};
use crate::runtime::mcp::global_mcp_runtime;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub success: bool,
    pub message: String,
    #[serde(default)]
    pub tools: Vec<McpToolInfo>,
}

#[tauri::command]
pub async fn list_mcp_servers(
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<Vec<McpServerEntry>, String> {
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    Ok(config.mcp.servers)
}

#[tauri::command]
pub async fn list_mcp_sets(
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<Vec<McpSetConfig>, String> {
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    Ok(config.mcp.sets)
}

#[tauri::command]
pub async fn list_mcp_server_tools(
    server_name: String,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<Vec<McpToolInfo>, String> {
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let entry = config
        .mcp
        .servers
        .iter()
        .find(|s| s.name == server_name)
        .ok_or_else(|| format!("未找到 MCP server: {server_name}"))?;

    let tools = global_mcp_runtime()
        .list_tools(&server_name, &entry.config)
        .await?;

    Ok(tools
        .into_iter()
        .map(|t| McpToolInfo {
            name: t.name.as_ref().to_string(),
            description: t.description.as_ref().map(|s| s.as_ref().to_string()),
            input_schema: serde_json::Value::Object((*t.input_schema).clone()),
        })
        .collect())
}

#[tauri::command]
pub async fn test_mcp_server(
    server_name: String,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<McpTestResult, String> {
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let entry = config
        .mcp
        .servers
        .iter()
        .find(|s| s.name == server_name)
        .ok_or_else(|| format!("未找到 MCP server: {server_name}"))?;

    match global_mcp_runtime()
        .list_tools(&server_name, &entry.config)
        .await
    {
        Ok(tools) => Ok(McpTestResult {
            success: true,
            message: "连接成功".to_string(),
            tools: tools
                .into_iter()
                .map(|t| McpToolInfo {
                    name: t.name.as_ref().to_string(),
                    description: t.description.as_ref().map(|s| s.as_ref().to_string()),
                    input_schema: serde_json::Value::Object((*t.input_schema).clone()),
                })
                .collect(),
        }),
        Err(err) => Ok(McpTestResult {
            success: false,
            message: err,
            tools: Vec::new(),
        }),
    }
}

#[tauri::command]
pub async fn upsert_mcp_server(
    server: McpServerEntry,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let mut config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let name = server.name.trim().to_string();
    if name.is_empty() {
        return Err("server.name 不能为空".to_string());
    }

    if let Some(existing) = config.mcp.servers.iter_mut().find(|s| s.name == name) {
        *existing = McpServerEntry { name, ..server };
    } else {
        config.mcp.servers.push(McpServerEntry { name, ..server });
    }

    config_manager.save(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_mcp_server(
    server_name: String,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let mut config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    config.mcp.servers.retain(|s| s.name != server_name);
    // Also clean references from sets
    for set in &mut config.mcp.sets {
        set.servers.retain(|s| s.server != server_name);
    }
    config_manager.save(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_mcp_set(
    set: McpSetConfig,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let mut config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let name = set.name.trim().to_string();
    if name.is_empty() {
        return Err("set.name 不能为空".to_string());
    }

    if let Some(existing) = config.mcp.sets.iter_mut().find(|s| s.name == name) {
        *existing = McpSetConfig { name, ..set };
    } else {
        config.mcp.sets.push(McpSetConfig { name, ..set });
    }

    config_manager.save(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_mcp_set(
    set_name: String,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let mut config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    config.mcp.sets.retain(|s| s.name != set_name);
    // Also clean agent bindings
    for agent in &mut config.agents {
        if agent.mcp_set.as_deref() == Some(set_name.as_str()) {
            agent.mcp_set = None;
        }
    }
    config_manager.save(&config).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentMcpSetArgs {
    pub agent_name: String,
    #[serde(default)]
    pub mcp_set: Option<String>,
}

/// 程序化：把 MCP Set 绑定到某个 agent（未来可由 AI 生成/调用）。
#[tauri::command]
pub async fn set_agent_mcp_set(
    args: SetAgentMcpSetArgs,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let mut config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let agent = config
        .agents
        .iter_mut()
        .find(|a| a.name == args.agent_name)
        .ok_or_else(|| format!("未找到 agent: {}", args.agent_name))?;

    let mcp_set = args.mcp_set.and_then(|s| {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    agent.mcp_set = mcp_set;

    config_manager.save(&config).map_err(|e| e.to_string())
}

