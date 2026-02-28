use serde::{Deserialize, Serialize};

/// 顶层任务类型（面向未来扩展）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    /// 最简单的对话任务：一次输入→一次模型生成
    Chat,
    /// 工具型任务：会产生 tool call / observation
    Tool,
    /// 规划任务：生成 Plan（Task 列表）
    Planner,
}

impl Serialize for TaskKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let value = match self {
            Self::Chat => "chat",
            Self::Tool => "tool",
            Self::Planner => "planner",
        };
        serializer.serialize_str(value)
    }
}

impl<'de> Deserialize<'de> for TaskKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        let kind = match raw.as_str() {
            "chat" => Self::Chat,
            "tool" => Self::Tool,
            "planner" => Self::Planner,
            // 兼容旧值（之前计划中的扩展类型）
            "code" => Self::Tool,
            "solution" => Self::Chat,
            _ => Self::Chat,
        };
        Ok(kind)
    }
}

/// Turn 状态（单次 ReAct 循环）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Success,
    Failed,
    Aborted,
}

/// Turn 的阶段（ReAct）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    Think,
    Act,
    Observe,
}

/// 每个 Turn 的上下文裁剪（hard trim）统计信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContextTrimInfo {
    /// 本轮是否启用裁剪（由 agent 的 contextPolicy 决定）。
    pub enabled: bool,
    /// 为了 fit hard limit，删除了多少条最旧的非 system 消息。
    pub removed_messages: u32,
    /// 裁剪前估算的 prompt token 数（粗估，偏保守）。
    pub estimated_tokens_before: u32,
    /// 裁剪后估算的 prompt token 数（粗估，偏保守）。
    pub estimated_tokens_after: u32,
    /// 本轮 hard limit token 上限（由 `contextLength * hardLimitPercent` 得到）。
    pub hard_limit_tokens: u32,
    /// 本轮 trim target token 目标（由 `contextLength * trimTargetPercent` 得到）。
    pub trim_target_tokens: u32,
    /// 删除的 task 组数量（按 request/response 语义分组）。
    pub removed_tasks: u32,
    /// 保留的 task 组数量（按 request/response 语义分组）。
    pub kept_tasks: u32,
    /// 与上一轮请求相比，本轮被移出的 task 数量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trimmed_tasks_since_last: Option<u32>,
    /// 与上一轮请求相比，本轮新增纳入的 task 数量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_tasks_since_last: Option<u32>,
    /// 与上一轮请求相比，估算 token 差值（after_current - after_previous）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_tokens_since_last: Option<i64>,
    /// 是否由于粒度限制（必须保留最近 task/system）导致无法达到 trim target。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_unreachable: Option<bool>,
}

/// Plan 中对 Task 的最小描述（用于 UI 展示与编排）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTask {
    pub task_id: String,
    pub task_kind: TaskKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// 规划结果：一系列 Task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub plan_id: String,
    pub tasks: Vec<PlannedTask>,
}
