//! 运行时抽象：Plan / Task / Turn
//!
//! 约定：
//! - **Task**：一次“用户请求/子任务”的执行单元。
//! - **Turn**：Task 内部一次典型的 ReAct 循环（Think → Act → Observe）。
//! - **Plan**：复杂任务的分解结果，是一系列 Task（可带依赖/顺序，后续再扩展）。
//!
//! 当前阶段先落地“统一事件流”（`run:event`）承载上述概念，Chat 只是最简单的 `TaskKind::Chat`。

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod approvals;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod context_manager;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod emitter;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod events;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod external_agent_session_runtime;
pub mod mcp;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod run_state;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod task_runner;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod text;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod tools;
pub mod types;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use run_state::RunState;
