use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::ai_client::ToolCall;
use crate::models::AgentTaskImplementation;
use crate::models::SandboxPolicy;
use crate::runtime::emitter::RunEmitter;

use super::handlers::agent_task::{AgentTaskInProcessTool, AgentTaskSubprocessTool};
use super::handlers::apply_patch::{ApplyPatchTool, ApplyPatchUnifiedDiffTool};
use super::handlers::builtin::{EchoTool, GetTimeTool};
use super::handlers::external_agent::{AgentRunTool, AgentSessionTool};
use super::handlers::file_tools::{ListDirTool, ReadFileTool, RgTool};
use super::handlers::pty::{
    ExecCommandPersistentTool, ExecCommandTool, WriteStdinPersistentTool, WriteStdinTool,
};
use super::handlers::shell::ShellCommandTool;
use super::handlers::text_edit::{ReplaceStringTool, WriteFileTool};
use super::services::ToolServices;
use super::spec::ToolSpec;

/// 单次工具调用的执行上下文（由 task_runner 构造）。
///
/// 这里刻意只放“执行所需”的最小信息，避免把更上层的 Task/Plan 概念耦合进工具核心层。
pub struct ToolExecutionContext<'a> {
    pub conversation_id: &'a str,
    pub task_id: &'a str,
    pub turn_id: &'a str,
    pub assistant_message_id: &'a str,
    /// Default working directory for tools when the model does not provide `workdir`.
    pub default_workdir: Option<std::path::PathBuf>,
    /// Workspace root folders bound to this run (main folder + additional mounts).
    pub workspace_roots: Vec<std::path::PathBuf>,
    /// Effective sandbox policy for this run (agent override > global config).
    pub sandbox_policy: SandboxPolicy,
    pub emitter: &'a mut RunEmitter,
    pub abort_rx: &'a mut tokio::sync::mpsc::Receiver<()>,
    pub services: &'a ToolServices,
}

/// 工具执行输出：给模型的 observation（role=tool 的 content）。
#[derive(Debug, Clone)]
pub struct ToolCallResult {
    pub content: String,
    /// 可选：补充的结构化 meta（用于 UI 展示/Undo 等能力，不进入模型上下文）。
    pub meta: Option<serde_json::Value>,
}

/// 工具执行错误（用于 runtime -> 模型的可读报错）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolErrorKind {
    /// 用户/系统中止（Stop/Abort）
    Aborted,
    /// 权限拒绝（安全策略）
    Denied,
    /// 参数不合法（模型输出不符合 schema）
    InvalidArguments,
    /// 超时
    Timeout,
    /// 执行失败（进程/IO/运行时错误）
    ExecutionFailed,
    /// 内部错误（不应发生）
    Internal,
}

#[derive(Debug, Clone)]
pub struct ToolError {
    pub kind: ToolErrorKind,
    pub message: String,
    /// 可选：补充的结构化 meta（用于 UI 展示/Undo 等能力）。
    pub meta: Option<serde_json::Value>,
}

impl ToolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::ExecutionFailed,
            message: message.into(),
            meta: None,
        }
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Denied,
            message: message.into(),
            meta: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::InvalidArguments,
            message: message.into(),
            meta: None,
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Timeout,
            message: message.into(),
            meta: None,
        }
    }

    pub fn aborted(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Aborted,
            message: message.into(),
            meta: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Internal,
            message: message.into(),
            meta: None,
        }
    }

    pub fn with_meta(mut self, meta: serde_json::Value) -> Self {
        self.meta = Some(meta);
        self
    }
}

#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn spec(&self) -> ToolSpec;

    /// 是否“可能产生副作用”（用于 gate/权限等策略）。
    ///
    /// 说明：这里允许做“动态判定”（例如 shell 根据命令是否安全来决定）。
    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        true
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError>;
}

/// ToolRegistry：存储“工具名 -> handler”，并提供 mutating gate。
///
/// - gate 的意义：避免多个可能写入/修改状态的工具并发执行导致竞态（尤其是未来并行 tool calls）。
pub struct ToolRegistry {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
    mutating_gate: Mutex<()>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self {
            handlers: HashMap::new(),
            mutating_gate: Mutex::new(()),
        }
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, handler: Arc<dyn ToolHandler>) {
        let spec = handler.spec();
        self.handlers.insert(spec.name.clone(), handler);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn ToolHandler>> {
        self.handlers.get(name).cloned()
    }

    pub fn list_specs(&self) -> Vec<ToolSpec> {
        self.handlers.values().map(|h| h.spec()).collect()
    }

    pub async fn acquire_mutating_gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.mutating_gate.lock().await
    }
}

#[derive(Debug, Clone)]
pub struct BuiltinHandlerOptions {
    pub agent_task_implementation: AgentTaskImplementation,
}

impl Default for BuiltinHandlerOptions {
    fn default() -> Self {
        Self {
            agent_task_implementation: AgentTaskImplementation::InProcess,
        }
    }
}

pub fn register_builtin_handlers(registry: &mut ToolRegistry) {
    register_builtin_handlers_with_options(registry, BuiltinHandlerOptions::default());
}

pub fn register_builtin_handlers_with_options(
    registry: &mut ToolRegistry,
    options: BuiltinHandlerOptions,
) {
    registry.register(Arc::new(EchoTool));
    registry.register(Arc::new(GetTimeTool));
    registry.register(Arc::new(ReadFileTool));
    registry.register(Arc::new(ListDirTool));
    registry.register(Arc::new(RgTool));
    match options.agent_task_implementation {
        AgentTaskImplementation::InProcess => registry.register(Arc::new(AgentTaskInProcessTool)),
        AgentTaskImplementation::Subprocess => registry.register(Arc::new(AgentTaskSubprocessTool)),
    }
    registry.register(Arc::new(AgentRunTool));
    registry.register(Arc::new(AgentSessionTool));
    registry.register(Arc::new(ApplyPatchTool));
    registry.register(Arc::new(ApplyPatchUnifiedDiffTool));
    registry.register(Arc::new(WriteFileTool));
    registry.register(Arc::new(ReplaceStringTool));
    // 终端能力（当前阶段先落地 shell/pty 两类工具；权限默认拒绝，需要显式开启）
    registry.register(Arc::new(ShellCommandTool));
    registry.register(Arc::new(ExecCommandTool));
    registry.register(Arc::new(WriteStdinTool));
    registry.register(Arc::new(ExecCommandPersistentTool));
    registry.register(Arc::new(WriteStdinPersistentTool));
}
