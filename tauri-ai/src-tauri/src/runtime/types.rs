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
