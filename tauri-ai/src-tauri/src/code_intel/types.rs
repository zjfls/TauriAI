use serde::{Deserialize, Serialize};

/// 前后端统一的 LSP 通知事件名：后端把 server -> client 的通知转发给前端。
pub const LSP_EVENT_NAME: &str = "lsp:event";

/// LSP 启动配置（运行时）。
///
/// 注意：这不是最终的持久化配置结构（持久化配置放在 AppConfig 里），
/// 这里用于后端把“解析后的配置”传给 LSP 管理器。
#[derive(Debug, Clone)]
pub struct LspLaunchConfig {
    pub language_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub initialization_options: serde_json::Value,
    /// 用于响应 `workspace/configuration` 的设置对象（通常是一个 JSON object）。
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspEventPayload {
    pub workstudio_id: String,
    pub language_id: String,
    pub timestamp_ms: i64,
    #[serde(flatten)]
    pub event: LspEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LspEvent {
    /// LSP notification from server to client.
    #[serde(rename_all = "camelCase")]
    Notification {
        method: String,
        params: serde_json::Value,
    },
    /// Best-effort log line captured from server stderr.
    #[serde(rename_all = "camelCase")]
    Stderr { line: String },
    /// Server lifecycle: exited / crashed.
    #[serde(rename_all = "camelCase")]
    Exited {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub workstudio_id: String,
    pub language_id: String,
    pub started: bool,
    pub initialized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
