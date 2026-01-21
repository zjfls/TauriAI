use super::permissions::ToolPermission;

/// 工具的“对模型描述 + 运行时约束”的统一规格。
///
/// - `name/description/parameters`：用于 function calling（传给模型）
/// - `required_permissions`：用于运行时权限决策（不参与传模）
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: Option<String>,
    pub parameters: serde_json::Value,
    pub required_permissions: Vec<ToolPermission>,
}

/// ToolSet：不同 Agent/任务可以绑定不同工具集合。
///
/// 这里先用最小表达（工具名列表）；后续可扩展为：
/// - 版本/别名
/// - tool level config（例如 shell 的允许目录、超时、环境变量白名单…）
/// - tool group（read-only / mutating / network 等分组）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSetMode {
    /// 不限制工具（等价于“允许 registry 中所有工具”）
    AllowAll,
    /// 只允许白名单里的工具名
    AllowList,
}

impl Default for ToolSetMode {
    fn default() -> Self {
        Self::AllowAll
    }
}

#[derive(Debug, Clone)]
pub struct ToolSet {
    pub name: String,
    pub mode: ToolSetMode,
    pub tools: Vec<String>,
}

impl ToolSet {
    pub fn allow_all() -> Self {
        Self {
            name: String::new(),
            mode: ToolSetMode::AllowAll,
            tools: Vec::new(),
        }
    }

    pub fn allow_list(name: impl Into<String>, tools: Vec<String>) -> Self {
        Self {
            name: name.into(),
            mode: ToolSetMode::AllowList,
            tools,
        }
    }

    pub fn deny_all(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            mode: ToolSetMode::AllowList,
            tools: Vec::new(),
        }
    }

    pub fn contains(&self, tool_name: &str) -> bool {
        match self.mode {
            ToolSetMode::AllowAll => true,
            ToolSetMode::AllowList => self.tools.iter().any(|t| t == tool_name),
        }
    }
}

impl Default for ToolSet {
    fn default() -> Self {
        Self::allow_all()
    }
}
