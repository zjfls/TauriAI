use serde::{Deserialize, Serialize};

/// 前后端统一的 Code Index 通知事件名：
/// - 后端在索引写入/进度更新后向前端广播
/// - 前端可按 workstudioId 过滤（多窗口场景）
pub const CODE_INDEX_EVENT_NAME: &str = "code-index:event";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexEventPayload {
    pub workstudio_id: String,
    pub timestamp_ms: i64,
    #[serde(flatten)]
    pub event: CodeIndexEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodeIndexEvent {
    /// 某个文件的 document symbols 已更新（写入缓存 DB）。
    #[serde(rename_all = "camelCase")]
    DocumentSymbolsUpdated {
        file_path: String,
        language_id: String,
        source: String,
        symbols: serde_json::Value,
        updated_at_ms: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        file_mtime_ms: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        file_size_bytes: Option<i64>,
    },

    /// 后台索引/扫描进度（最佳努力；用于展示“索引中”）。
    #[serde(rename_all = "camelCase")]
    Progress {
        phase: String,
        done: u64,
        total: Option<u64>,
        message: String,
    },

    /// 索引失败（非致命；前端可选择静默或展示）。
    #[serde(rename_all = "camelCase")]
    Error {
        phase: String,
        file_path: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexDocumentSymbolsSnapshot {
    pub file_path: String,
    pub language_id: String,
    pub source: String,
    pub symbols: serde_json::Value,
    pub updated_at_ms: i64,
    pub is_stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_mtime_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<i64>,
}
