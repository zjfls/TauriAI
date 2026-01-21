//! Chat Agent 的“核心组装层”
//!
//! 这个模块专注于：配置解析、ModelConfig 构建、system prompt/format prompt 组装。
//! Tauri command 层（`commands/run.rs`）则专注于：参数接入、DB 读写、事件 emit、取消/错误处理（并把执行下沉到 `runtime/task_runner.rs`）。
//! 这样后续扩展 ToolAgent / CodeAgent / SolutionRunner 时，可以复用同样的分层方式，保持结构干净。

use crate::errors::AppErrorCode;
use crate::models::{
    Agent, AppConfig, Message, MessageRole, MessageStatus, Model, ModelConfig, ModelParameters,
    Provider, ProviderType,
};
use crate::prompts::{compose_system_prompt, FormatPromptType};

pub struct ResolvedChatModel<'a> {
    pub provider: &'a Provider,
    pub model: &'a Model,
    pub agent: &'a Agent,
}

pub fn resolve_chat_model<'a>(
    config: &'a AppConfig,
    agent_name: Option<&str>,
    model_ref: Option<&str>,
) -> Result<ResolvedChatModel<'a>, AppErrorCode> {
    // 解析优先级：显式 model_ref > agent 默认 model_ref（便于多会话/多 agent 场景按会话覆盖模型）
    if let Some(model_ref_str) = model_ref {
        let (provider_name, model_name) =
            AppConfig::parse_model_ref(model_ref_str).ok_or(AppErrorCode::ModelConfigMissing)?;

        let provider = config
            .get_provider(provider_name)
            .ok_or(AppErrorCode::ModelConfigMissing)?;
        let model = provider
            .models
            .iter()
            .find(|m| m.name == model_name)
            .ok_or(AppErrorCode::ModelConfigMissing)?;

        let agent_name_str = agent_name.unwrap_or(&config.default_agent);
        let agent = config
            .get_agent(agent_name_str)
            .or_else(|| config.get_default_agent())
            .ok_or(AppErrorCode::ModelConfigMissing)?;

        return Ok(ResolvedChatModel {
            provider,
            model,
            agent,
        });
    }

    let agent_name_str = agent_name.unwrap_or(&config.default_agent);
    let (provider, model, agent) = config
        .resolve_agent(agent_name_str)
        .ok_or(AppErrorCode::ModelConfigMissing)?;

    Ok(ResolvedChatModel {
        provider,
        model,
        agent,
    })
}

pub fn get_output_format(agent: &Agent) -> Option<String> {
    // 仅用于“渲染提示”/“输出块标注”，不参与模型参数；未来可升级为 outputProfile。
    match agent.format_type {
        FormatPromptType::Chat => Some("markdown".to_string()),
        FormatPromptType::Plain => Some("plain".to_string()),
        FormatPromptType::Json => Some("json".to_string()),
        FormatPromptType::None => None,
    }
}

pub fn build_model_config(
    provider: &Provider,
    model: &Model,
    thinking: Option<serde_json::Value>,
    web_search_enabled: Option<bool>,
) -> ModelConfig {
    // 这里把“前端 thinking 模式”的表达统一折算成后端 ModelConfig：
    // - model.capabilities.thinking=false => 不下发 thinking 参数
    // - 否则按字符串/布尔值折算为 level（当前阶段仍保留默认 medium）
    ModelConfig {
        id: format!("{}/{}", provider.name, model.name),
        name: model.name.clone(),
        provider: provider.provider_type.to_client_str().to_string(),
        api_base: Some(provider.api_base.clone()),
        api_key: provider.api_key.clone(),
        model: model.name.clone(),
        parameters: ModelParameters {
            temperature: model.temperature,
            max_tokens: model.max_tokens,
            top_p: model.top_p,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        },
        thinking_level: if model.capabilities.thinking {
            let level = match thinking {
                Some(serde_json::Value::Bool(true)) => Some("medium".to_string()),
                Some(serde_json::Value::Bool(false)) => Some("disabled".to_string()),
                Some(serde_json::Value::String(level)) => Some(level),
                Some(serde_json::Value::Null) => Some("disabled".to_string()),
                None => Some("medium".to_string()),
                _ => Some("medium".to_string()),
            };

            // Google Gemini 的 thinking 等级与 OpenAI Responses 不完全一致：
            // - Gemini 不支持“超高”，这里统一回退到“高”，避免下游出现无意义/不可用的等级。
            match provider.provider_type {
                ProviderType::Google => match level.as_deref() {
                    Some("xhigh") | Some("very_high") => Some("high".to_string()),
                    _ => level,
                },
                _ => level,
            }
        } else {
            None
        },
        thinking_budget_tokens: model.thinking_budget_tokens,
        vision_enabled: model.capabilities.vision,
        // web_search_enabled: 前端传入的 toggle 覆盖模型能力
        // - 如果 model 不支持 web_search，则始终为 false
        // - 如果 model 支持且用户未明确关闭，则默认启用
        web_search_enabled: model.capabilities.web_search && web_search_enabled.unwrap_or(true),
        max_images: model.max_images,
        use_reasoning_effort: model.use_reasoning_effort,
    }
}

pub fn build_request_messages(
    mut messages: Vec<Message>,
    conversation_id: &str,
    agent: &Agent,
) -> Vec<Message> {
    // system prompt 由「用户自定义提示词 + 输出格式提示词」拼接而成；
    // 这一步和具体 provider 无关，属于 agent 层能力。
    let base_prompt = if agent.system_prompt.is_empty() {
        None
    } else {
        Some(agent.system_prompt.as_str())
    };

    if let Some(system_content) = compose_system_prompt(base_prompt, agent.format_type) {
        let system_message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content: system_content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        };
        messages.insert(0, system_message);
    }

    messages
}
