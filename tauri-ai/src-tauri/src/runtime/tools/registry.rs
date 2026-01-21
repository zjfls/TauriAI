use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::ai_client::ToolCall;
use crate::runtime::emitter::RunEmitter;

use super::handlers::builtin::{EchoTool, GetTimeTool};
use super::handlers::pty::{ExecCommandTool, WriteStdinTool};
use super::handlers::shell::ShellCommandTool;
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
    pub emitter: &'a mut RunEmitter,
    pub abort_rx: &'a mut tokio::sync::mpsc::Receiver<()>,
    pub services: &'a ToolServices,
}

/// 工具执行输出：给模型的 observation（role=tool 的 content）。
#[derive(Debug, Clone)]
pub struct ToolCallResult {
    pub content: String,
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
}

impl ToolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::ExecutionFailed,
            message: message.into(),
        }
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Denied,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::InvalidArguments,
            message: message.into(),
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Timeout,
            message: message.into(),
        }
    }

    pub fn aborted(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Aborted,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            kind: ToolErrorKind::Internal,
            message: message.into(),
        }
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

pub fn register_builtin_handlers(registry: &mut ToolRegistry) {
    registry.register(Arc::new(EchoTool));
    registry.register(Arc::new(GetTimeTool));
    // 终端能力（当前阶段先落地 shell/pty 两类工具；权限默认拒绝，需要显式开启）
    registry.register(Arc::new(ShellCommandTool));
    registry.register(Arc::new(ExecCommandTool));
    registry.register(Arc::new(WriteStdinTool));
}
