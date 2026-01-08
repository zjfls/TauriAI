use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub icon: Option<String>, // Lucide icon name
    pub action_type: String,  // "copy", "retry", "navigate", "link", "event"
    pub payload: Option<String>,
    pub style: Option<String>, // "default", "primary", "danger"
}

impl Action {
    pub fn new(id: &str, label: &str, action_type: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            icon: None,
            action_type: action_type.to_string(),
            payload: None,
            style: None,
        }
    }

    pub fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.to_string());
        self
    }

    pub fn payload(mut self, payload: &str) -> Self {
        self.payload = Some(payload.to_string());
        self
    }

    pub fn style(mut self, style: &str) -> Self {
        self.style = Some(style.to_string());
        self
    }

    // Common Action Factories
    pub fn navigate(id: &str, label: &str, path: &str) -> Self {
        Self::new(id, label, "navigate").payload(path)
    }

    pub fn link(id: &str, label: &str, url: &str) -> Self {
        Self::new(id, label, "link").payload(url)
    }

    pub fn retry(id: &str, label: &str) -> Self {
        Self::new(id, label, "retry").icon("RefreshCw")
    }
}

#[derive(Debug, Serialize)]
pub struct SerializableError {
    pub code: String,
    pub message: String,
    pub actions: Vec<Action>,
}

#[derive(Debug)]
pub enum AppErrorCode {
    ModelConfigMissing,
    AiServiceError(String),
    NetworkTimeout,
    UnknownError(String),
}

impl AppErrorCode {
    pub fn details(&self) -> (String, String, Vec<Action>) {
        match self {
            Self::ModelConfigMissing => (
                "MODEL_MISSING".to_string(),
                "**未找到有效的模型配置**\n\n请在设置页面选择一个模型，或者添加新的模型配置。"
                    .to_string(),
                vec![Action::navigate("fix_config", "去设置", "/settings")
                    .style("primary")
                    .icon("Settings")],
            ),
            Self::AiServiceError(msg) => (
                "AI_SERVICE_ERROR".to_string(),
                format!("**AI 服务调用失败**\n\n{}", msg),
                vec![
                    Action::retry("retry_btn", "重试").style("danger"),
                    Action::new("copy_log", "复制错误日志", "copy")
                        .payload(msg)
                        .icon("Copy"),
                ],
            ),
            Self::NetworkTimeout => (
                "NETWORK_TIMEOUT".to_string(),
                "**网络请求超时**\n\nAI 服务没有在规定时间内响应。".to_string(),
                vec![Action::retry("retry_btn", "重试").style("primary")],
            ),
            Self::UnknownError(msg) => (
                "UNKNOWN_ERROR".to_string(),
                format!("**未知错误**\n\n{}", msg),
                vec![],
            ),
        }
    }
}

impl From<AppErrorCode> for SerializableError {
    fn from(error: AppErrorCode) -> Self {
        let (code, message, actions) = error.details();
        SerializableError {
            code,
            message,
            actions,
        }
    }
}

// Convert from ConfigError (assuming ConfigError is defined elsewhere, but for now we map manually in calls or here if we have visibility)
// Since ConfigError is in crate::config, we might strictly map it at the call site or impl From here if we import it.
// For simplicity in this step, we'll let the command layer map to AppErrorCode.
