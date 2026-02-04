//! Tool 子系统（参考 Codex tools 架构，但面向 TauriAI 的多平台/多 Agent 场景做扩展）。
//!
//! 关键点：
//! - **Task/Turn** 是更高层抽象；模型返回的 tool call 只是 Turn 的一种输出/动作。
//! - 工具系统需要独立分层：**spec / registry / router / orchestrator / runtimes / permissions**。
//! - run_task/task_runner 只做“驱动器”：TurnLoop + 事件编排；工具执行细节下沉到这里。
//!
//! 说明：
//! - 当前阶段工具可以只实现 shell/pty，但架构要完整，方便未来扩展到：
//!   - 不同 Agent 绑定不同工具集（toolset）
//!   - 更细粒度权限系统（本地能力/网络/文件/终端/打开器…）
//!   - 沙箱/审批/并发 gate/重试/审计日志/事件重放

pub mod handlers;
pub mod orchestrator;
pub mod permissions;
pub mod registry;
pub mod sandbox;
pub mod services;
pub mod spec;

pub use orchestrator::{ToolOrchestrator, ToolOrchestratorConfig};
pub use permissions::{ToolPermission, ToolPermissionDecision, ToolPermissionPolicy};
pub use registry::{ToolCallResult, ToolHandler, ToolRegistry};
pub use services::ToolServices;
pub use spec::{ToolSet, ToolSpec};

use crate::ai_client::ToolDefinition;

/// 将内部 ToolSpec 投影成给模型用的 ToolDefinition（function calling schema）。
pub fn tool_specs_to_definitions(specs: &[ToolSpec]) -> Vec<ToolDefinition> {
    specs
        .iter()
        .map(|s| ToolDefinition {
            name: s.name.clone(),
            description: s.description.clone(),
            parameters: s.parameters.clone(),
        })
        .collect()
}
