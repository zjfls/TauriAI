use std::sync::Arc;

/// 工具权限（自研权限系统的最小骨架）。
///
/// 说明：
/// - 权限不是“工具名”，而是“能力”。
/// - 一个工具可以要求多个权限（例如未来：文件读写 + 网络 + 终端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolPermission {
    /// 允许执行一次性 shell 命令（非 PTY）。
    ShellExec,
    /// 允许创建/操作 PTY 会话（交互式终端）。
    PtyExec,
}

#[derive(Debug, Clone)]
pub enum ToolPermissionDecision {
    Allow,
    Deny { reason: String },
}

/// 权限策略：决定某次工具调用是否允许执行。
///
/// 注意：这里故意只暴露“最小接口”，避免把 AppConfig/前端审批耦合进 tools 核心层。
/// 后续会在更上层把“配置 + UI 审批 + 缓存”组合成一个实现。
pub trait ToolPermissionPolicy: Send + Sync {
    fn decide(
        &self,
        tool_name: &str,
        required: &[ToolPermission],
    ) -> ToolPermissionDecision;
}

/// 默认策略：只允许不需要权限的工具。
/// - 对 shell/pty 等高危能力，默认拒绝（必须显式开启）。
#[derive(Debug, Default)]
pub struct DenyByDefaultPolicy;

impl ToolPermissionPolicy for DenyByDefaultPolicy {
    fn decide(
        &self,
        tool_name: &str,
        required: &[ToolPermission],
    ) -> ToolPermissionDecision {
        if required.is_empty() {
            return ToolPermissionDecision::Allow;
        }
        ToolPermissionDecision::Deny {
            reason: format!("工具 '{tool_name}' 需要权限 {required:?}，当前策略默认拒绝"),
        }
    }
}

/// 全拒绝策略：关闭工具系统时使用。
#[derive(Debug, Default)]
pub struct DenyAllPolicy;

impl ToolPermissionPolicy for DenyAllPolicy {
    fn decide(
        &self,
        tool_name: &str,
        _required: &[ToolPermission],
    ) -> ToolPermissionDecision {
        ToolPermissionDecision::Deny {
            reason: format!("工具系统已关闭，拒绝调用 '{tool_name}'"),
        }
    }
}

/// 简单策略：用布尔开关允许/拒绝（后续会由 AppConfig 驱动）。
#[derive(Debug, Clone)]
pub struct BasicToolPermissionPolicy {
    pub allow_shell_exec: bool,
    pub allow_pty_exec: bool,
}

impl Default for BasicToolPermissionPolicy {
    fn default() -> Self {
        Self {
            allow_shell_exec: false,
            allow_pty_exec: false,
        }
    }
}

impl ToolPermissionPolicy for BasicToolPermissionPolicy {
    fn decide(
        &self,
        tool_name: &str,
        required: &[ToolPermission],
    ) -> ToolPermissionDecision {
        for p in required {
            match p {
                ToolPermission::ShellExec if !self.allow_shell_exec => {
                    return ToolPermissionDecision::Deny {
                        reason: format!("工具 '{tool_name}' 需要 ShellExec 权限，但未开启"),
                    };
                }
                ToolPermission::PtyExec if !self.allow_pty_exec => {
                    return ToolPermissionDecision::Deny {
                        reason: format!("工具 '{tool_name}' 需要 PtyExec 权限，但未开启"),
                    };
                }
                _ => {}
            }
        }
        ToolPermissionDecision::Allow
    }
}

/// 便捷：把策略包装成 Arc，便于在 orchestrator/registry 间共享。
pub fn policy_arc<P: ToolPermissionPolicy + 'static>(p: P) -> Arc<dyn ToolPermissionPolicy> {
    Arc::new(p)
}
