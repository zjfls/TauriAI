use std::sync::Arc;

use serde_json::Value;

use crate::ai_client::ToolCall;
use crate::runtime::events::RunEvent;

use super::handlers::apply_patch;
use super::permissions::{ToolPermissionDecision, ToolPermissionPolicy};
use super::registry::{register_builtin_handlers, ToolCallResult, ToolError, ToolExecutionContext, ToolHandler, ToolRegistry};
use super::spec::{ToolSet, ToolSpec};

/// ToolOrchestrator 的运行时配置（每个 run/task 可以不同）。
#[derive(Clone)]
pub struct ToolOrchestratorConfig {
    /// 当前任务允许的工具集合（AgentA/AgentB 可不同）。
    pub toolset: ToolSet,
    /// 权限策略（可由 AppConfig + UI 审批 + 缓存组合实现）。
    pub permission_policy: Arc<dyn ToolPermissionPolicy>,
}

impl ToolOrchestratorConfig {
    pub fn builtin_defaults(permission_policy: Arc<dyn ToolPermissionPolicy>) -> Self {
        Self {
            toolset: ToolSet::default(),
            permission_policy,
        }
    }
}

/// ToolOrchestrator：负责把“模型的 tool call”安全地变成“工具执行结果”。
///
/// 职责边界：
/// - task_runner：TurnLoop + 事件编排（Think/Act/Observe）
/// - orchestrator：路由 + 权限 + gate + 调用 handler
/// - handler/runtime：解析参数 + 具体执行（shell/pty/文件/网络…）
pub struct ToolOrchestrator {
    registry: Arc<ToolRegistry>,
    toolset: ToolSet,
    permission_policy: Arc<dyn ToolPermissionPolicy>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApplyPatchInterceptMode {
    PlainText,
    ExecCommandJson,
}

fn is_persistent_tool(name: &str) -> bool {
    name.ends_with("_persistent")
}

impl ToolOrchestrator {
    /// 创建一个带内置工具（echo/get_time）的 orchestrator。
    pub fn new_builtin(config: ToolOrchestratorConfig) -> Self {
        let mut registry = ToolRegistry::new();
        register_builtin_handlers(&mut registry);
        Self::new(Arc::new(registry), config)
    }

    pub fn new(registry: Arc<ToolRegistry>, config: ToolOrchestratorConfig) -> Self {
        Self {
            registry,
            toolset: config.toolset,
            permission_policy: config.permission_policy,
        }
    }

    /// 产出“传给模型”的工具定义（基于 toolset + 权限做过滤）。
    pub fn tool_specs_for_model(&self) -> Vec<ToolSpec> {
        let specs = self.registry.list_specs();
        specs
            .into_iter()
            .filter(|spec| self.is_tool_enabled_for_model(spec))
            .collect()
    }

    fn is_tool_enabled_for_model(&self, spec: &ToolSpec) -> bool {
        if is_persistent_tool(&spec.name) && !self.toolset.persistance_shell_enhance {
            return false;
        }
        if !is_persistent_tool(&spec.name) && !self.toolset.contains(&spec.name) {
            return false;
        }
        matches!(
            self.permission_policy
                .decide(&spec.name, &spec.required_permissions),
            ToolPermissionDecision::Allow
        )
    }

    fn resolve_handler(&self, tool_name: &str) -> Result<Arc<dyn ToolHandler>, ToolError> {
        if is_persistent_tool(tool_name) && !self.toolset.persistance_shell_enhance {
            return Err(ToolError::denied(
                "持久工具需要在 toolset 中开启“持久进程”",
            ));
        }
        if !is_persistent_tool(tool_name) && !self.toolset.contains(tool_name) {
            return Err(ToolError::denied(format!(
                "工具 '{tool_name}' 不在当前 toolset"
            )));
        }

        self.registry
            .get(tool_name)
            .ok_or_else(|| {
                ToolError::invalid(format!("未知工具: {tool_name}"))
            })
    }

    fn maybe_extract_apply_patch_from_call(
        call: &ToolCall,
    ) -> Option<(String, ApplyPatchInterceptMode)> {
        let (field, mode) = match call.name.as_str() {
            "shell_command" => ("command", ApplyPatchInterceptMode::PlainText),
            "exec_command" | "exec_command_persistent" => ("cmd", ApplyPatchInterceptMode::ExecCommandJson),
            _ => return None,
        };

        let v: Value = serde_json::from_str(&call.arguments).ok()?;
        let cmd = v.get(field)?.as_str()?;
        let patch = apply_patch::extract_verified_apply_patch_from_text(cmd)?;
        Some((patch, mode))
    }

    /// 执行单个 tool call（带权限检查与 mutating gate）。
    pub async fn execute_one(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        // Codex-like interception: when a model mistakenly sends an apply_patch body
        // via shell/pty exec tools, redirect to the real `apply_patch` tool.
        if let Some((patch_text, mode)) = Self::maybe_extract_apply_patch_from_call(call) {
            let rewritten = ToolCall {
                id: call.id.clone(),
                name: "apply_patch".to_string(),
                arguments: serde_json::json!({ "input": patch_text }).to_string(),
            };

            let applier = self.resolve_handler("apply_patch")?;
            let spec = applier.spec();
            match self
                .permission_policy
                .decide(&spec.name, &spec.required_permissions)
            {
                ToolPermissionDecision::Allow => {}
                ToolPermissionDecision::Deny { reason } => return Err(ToolError::denied(reason)),
            }

            let notice = format!(
                "[提示] 检测到 apply_patch 补丁文本被作为 `{}` 的命令提交，已自动按 apply_patch 处理。后续请直接调用 apply_patch 工具。\n\n",
                call.name
            );
            ctx.emitter.emit(RunEvent::BlockDelta {
                task_id: ctx.task_id.to_string(),
                turn_id: ctx.turn_id.to_string(),
                assistant_message_id: Some(ctx.assistant_message_id.to_string()),
                block_id: format!("tool_result:{}", call.id),
                block_type: "tool_result".to_string(),
                format: Some("plain".to_string()),
                delta: notice.clone(),
            });

            let out = if applier.is_mutating(&rewritten).await {
                let _guard = self.registry.acquire_mutating_gate().await;
                applier.call(ctx, &rewritten).await?
            } else {
                applier.call(ctx, &rewritten).await?
            };

            let combined = format!("{}{}", notice, out.content);
            return Ok(match mode {
                ApplyPatchInterceptMode::PlainText => ToolCallResult { content: combined },
                ApplyPatchInterceptMode::ExecCommandJson => ToolCallResult {
                    content: serde_json::json!({
                        "session_id": Value::Null,
                        "process_id": Value::Null,
                        "output": combined,
                        "done": true,
                        "exit_code": 0
                    })
                    .to_string(),
                },
            });
        }

        let handler = self.resolve_handler(&call.name)?;
        let spec = handler.spec();

        match self
            .permission_policy
            .decide(&spec.name, &spec.required_permissions)
        {
            ToolPermissionDecision::Allow => {}
            ToolPermissionDecision::Deny { reason } => return Err(ToolError::denied(reason)),
        }

        let is_mutating = handler.is_mutating(call).await;
        if is_mutating {
            // 重要：mutating gate 先锁住，再执行，避免未来并行 tool calls 产生竞态。
            let _guard = self.registry.acquire_mutating_gate().await;
            return handler.call(ctx, call).await;
        }

        handler.call(ctx, call).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::tools::permissions::{BasicToolPermissionPolicy, DenyAllPolicy, DenyByDefaultPolicy};

    fn tool_names(specs: &[ToolSpec]) -> Vec<String> {
        let mut names = specs.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn deny_by_default_allows_only_no_permission_tools() {
        let policy: Arc<dyn ToolPermissionPolicy> = Arc::new(DenyByDefaultPolicy::default());
        let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig::builtin_defaults(policy));
        let names = tool_names(&orchestrator.tool_specs_for_model());
        assert!(names.contains(&"echo".to_string()));
        assert!(names.contains(&"get_time".to_string()));
        assert!(!names.contains(&"shell_command".to_string()));
        assert!(!names.contains(&"exec_command".to_string()));
        assert!(!names.contains(&"write_stdin".to_string()));
    }

    #[test]
    fn deny_all_filters_everything() {
        let policy: Arc<dyn ToolPermissionPolicy> = Arc::new(DenyAllPolicy::default());
        let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig::builtin_defaults(policy));
        let names = tool_names(&orchestrator.tool_specs_for_model());
        assert!(names.is_empty());
    }

    #[test]
    fn basic_policy_can_enable_shell_and_disable_pty() {
        let policy: Arc<dyn ToolPermissionPolicy> = Arc::new(BasicToolPermissionPolicy {
            allow_shell_exec: true,
            allow_pty_exec: false,
            allow_file_write: false,
        });
        let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig {
            toolset: ToolSet::allow_all(),
            permission_policy: policy,
        });
        let names = tool_names(&orchestrator.tool_specs_for_model());
        assert!(names.contains(&"shell_command".to_string()));
        assert!(!names.contains(&"exec_command".to_string()));
        assert!(!names.contains(&"write_stdin".to_string()));
    }

    #[test]
    fn toolset_allow_list_filters_tools() {
        let policy: Arc<dyn ToolPermissionPolicy> = Arc::new(BasicToolPermissionPolicy {
            allow_shell_exec: true,
            allow_pty_exec: true,
            allow_file_write: false,
        });
        let orchestrator = ToolOrchestrator::new_builtin(ToolOrchestratorConfig {
            toolset: ToolSet::allow_list("only-shell", vec!["shell_command".to_string()]),
            permission_policy: policy,
        });
        let names = tool_names(&orchestrator.tool_specs_for_model());
        assert_eq!(names, vec!["shell_command".to_string()]);
    }

    #[test]
    fn intercept_detects_apply_patch_in_shell_command() {
        let patch = r#"*** Begin Patch
*** Add File: a.txt
+hello
*** End Patch"#;
        let call = ToolCall {
            id: "call_1".to_string(),
            name: "shell_command".to_string(),
            arguments: serde_json::json!({ "command": patch }).to_string(),
        };
        let (extracted, mode) =
            ToolOrchestrator::maybe_extract_apply_patch_from_call(&call).expect("detect patch");
        assert_eq!(extracted, patch);
        assert_eq!(mode, ApplyPatchInterceptMode::PlainText);
    }

    #[test]
    fn intercept_detects_apply_patch_in_exec_command() {
        let patch = r#"*** Begin Patch
*** Add File: a.txt
+hello
*** End Patch"#;
        let call = ToolCall {
            id: "call_2".to_string(),
            name: "exec_command".to_string(),
            arguments: serde_json::json!({ "cmd": patch }).to_string(),
        };
        let (extracted, mode) =
            ToolOrchestrator::maybe_extract_apply_patch_from_call(&call).expect("detect patch");
        assert_eq!(extracted, patch);
        assert_eq!(mode, ApplyPatchInterceptMode::ExecCommandJson);
    }
}
