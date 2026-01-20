//! 内置工具（ToolAgent 的最小可运行集合）
//!
//! 设计目标：
//! - Tool 定义（给模型）：`ToolDefinition`
//! - Tool 执行（给运行时）：输入 arguments(JSON string) → 输出 string
//! - 后续可扩展：权限/沙盒/超时/日志/多工具集/可配置工具等
use crate::ai_client::ToolDefinition;

pub fn default_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "echo".to_string(),
            description: Some("原样返回传入的文本，用于测试工具调用链路".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "要回显的文本" }
                },
                "required": ["text"]
            }),
        },
        ToolDefinition {
            name: "get_time".to_string(),
            description: Some("返回当前 UTC 时间（ISO8601）".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
    ]
}

pub fn execute_tool(name: &str, arguments_json: &str) -> Result<String, String> {
    match name {
        "echo" => {
            let v: serde_json::Value =
                serde_json::from_str(arguments_json).map_err(|e| format!("参数不是合法 JSON: {e}"))?;
            let text = v
                .get("text")
                .and_then(|t| t.as_str())
                .ok_or_else(|| "缺少参数 text".to_string())?;
            Ok(text.to_string())
        }
        "get_time" => Ok(chrono::Utc::now().to_rfc3339()),
        _ => Err(format!("未知工具: {}", name)),
    }
}

