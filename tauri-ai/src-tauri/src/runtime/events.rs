use serde::Serialize;

use crate::ai_client::{DebugInfoData, TokenUsage};

use super::types::{PlannedTask, TaskKind, TurnContextTrimInfo, TurnPhase, TurnStatus};

/// 前后端统一的运行时事件通道名（替代旧的多 event name 方案）
pub const RUN_EVENT_NAME: &str = "run:event";

/// 统一事件流 envelope：每条事件都有这些元信息，便于排序/去重/诊断。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventPayload {
    pub conversation_id: String,
    pub run_id: String,
    /// 单次 run 内严格递增序号（前端可用于去重/排序；未来也可用于事件落盘重放）
    pub seq: u64,
    /// 事件产生时间（ms）
    pub timestamp_ms: i64,
    #[serde(flatten)]
    pub event: RunEvent,
}

/// 统一事件类型：
/// - lifecycle：plan/task/turn 边界
/// - output：text/thinking/tool/websearch/多模态等都可以作为 block 扩展
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    // --------------------
    // lifecycle
    // --------------------
    #[serde(rename_all = "camelCase")]
    PlanCreated {
        plan_id: String,
        tasks: Vec<PlannedTask>,
    },
    #[serde(rename_all = "camelCase")]
    TaskStarted {
        task_id: String,
        task_kind: TaskKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        task_id: String,
        turn_id: String,
        turn_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    TurnPhaseStarted {
        task_id: String,
        turn_id: String,
        phase: TurnPhase,
    },
    #[serde(rename_all = "camelCase")]
    TurnPhaseFinished {
        task_id: String,
        turn_id: String,
        phase: TurnPhase,
    },
    #[serde(rename_all = "camelCase")]
    TurnFinished {
        task_id: String,
        turn_id: String,
        status: TurnStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_message_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "debugInfo")]
        debug_info: Option<DebugInfoData>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_trim: Option<TurnContextTrimInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },

    // --------------------
    // context (history mutations)
    // --------------------
    /// Backend mutated persisted history (e.g. normal compact). Frontend should reload messages.
    #[serde(rename_all = "camelCase")]
    HistorySyncNeeded {
        /// Reason identifier (e.g. "normal_compact").
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed_messages: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dropped_for_fit: Option<u32>,
    },

    // --------------------
    // output
    // --------------------
    #[serde(rename_all = "camelCase")]
    BlockDelta {
        task_id: String,
        turn_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_message_id: Option<String>,
        block_id: String,
        block_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        task_id: String,
        turn_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_message_id: Option<String>,
        #[serde(rename = "fullContent")]
        full_content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "debugInfo")]
        debug_info: Option<DebugInfoData>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_message_id: Option<String>,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "debugInfo")]
        debug_info: Option<DebugInfoData>,
    },
}
