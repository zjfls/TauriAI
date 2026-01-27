//! 运行时抽象：Plan / Task / Turn
//!
//! 约定：
//! - **Task**：一次“用户请求/子任务”的执行单元。
//! - **Turn**：Task 内部一次典型的 ReAct 循环（Think → Act → Observe）。
//! - **Plan**：复杂任务的分解结果，是一系列 Task（可带依赖/顺序，后续再扩展）。
//!
//! 当前阶段先落地“统一事件流”（`run:event`）承载上述概念，Chat 只是最简单的 `TaskKind::Chat`。

pub mod events;
pub mod emitter;
pub mod approvals;
pub mod mcp;
pub mod run_state;
pub mod task_runner;
pub mod tools;
pub mod types;

pub use run_state::RunState;
