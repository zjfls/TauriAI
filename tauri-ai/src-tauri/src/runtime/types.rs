use serde::{Deserialize, Serialize};

/// 顶层任务类型（面向未来扩展）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// 最简单的对话任务：一次输入→一次模型生成
    Chat,
    /// 工具型任务：会产生 tool call / observation
    Tool,
    /// 编码型任务：Tool 的特化（如代码生成/修复/运行）
    Code,
    /// 规划任务：生成 Plan（Task 列表）
    Planner,
    /// Solution 级任务：可能编排多个 Agent/Task
    Solution,
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

