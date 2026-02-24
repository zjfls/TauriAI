//! Code intelligence commands (LSP / AST)
//!
//! 说明：
//! - 这些命令面向前端 Monaco Bridge：后端负责 LSP 进程管理与 JSON-RPC 通信。
//! - 目前优先覆盖 Workstudio 的核心能力：定义/引用/类型定义/悬停/补全/诊断。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::agents::chat::build_model_config;
use crate::ai_client::get_client;
use crate::code_intel::ast::{AstDocumentSymbolsArgs, AstSymbol};
use crate::code_intel::index_manager::{
    CodeIndexManager, CodeIndexRequestDocumentSymbolsArgs, CodeIndexRequestDocumentSymbolsResult,
    CodeIndexStartWorkspaceScanArgs, CodeIndexStatus, CodeIndexSummary,
};
use crate::code_intel::lsp::{resolve_lsp_spawn_program, LspManager};
use crate::code_intel::types::{LspLaunchConfig, LspServerStatus};
use crate::config::ConfigManager;
use crate::models::{
    AppConfig, CodeSnippetRange, Message, MessageRole, MessageStatus, Workstudio,
    WorkstudioSymbolAnalysis,
};
use crate::storage::async_db;
use crate::storage::Database;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspEnsureServerArgs {
    pub workstudio_id: String,
    pub language_id: String,
}

#[tauri::command]
pub async fn lsp_ensure_server(
    args: LspEnsureServerArgs,
    lsp: tauri::State<'_, Arc<LspManager>>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let ws: Workstudio = {
        async_db::with_db(db.inner(), "lsp_ensure_server:get_workstudio", |db| {
            db.get_workstudio(&args.workstudio_id)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let launch = resolve_launch_config(&*config_manager, &args.language_id)?;
    lsp.ensure(&ws, &args.language_id, launch).await?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspNotifyArgs {
    pub workstudio_id: String,
    pub language_id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[tauri::command]
pub async fn lsp_notify(
    args: LspNotifyArgs,
    lsp: tauri::State<'_, Arc<LspManager>>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<(), String> {
    let ws: Workstudio = {
        async_db::with_db(db.inner(), "lsp_notify:get_workstudio", |db| {
            db.get_workstudio(&args.workstudio_id)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let launch = resolve_launch_config(&*config_manager, &args.language_id)?;
    let server = lsp.ensure(&ws, &args.language_id, launch).await?;
    server.notify(&args.method, args.params).await
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRequestArgs {
    pub workstudio_id: String,
    pub language_id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn lsp_request(
    args: LspRequestArgs,
    lsp: tauri::State<'_, Arc<LspManager>>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<serde_json::Value, String> {
    let ws: Workstudio = {
        async_db::with_db(db.inner(), "lsp_request:get_workstudio", |db| {
            db.get_workstudio(&args.workstudio_id)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let launch = resolve_launch_config(&*config_manager, &args.language_id)?;
    let server = lsp.ensure(&ws, &args.language_id, launch).await?;

    let timeout = args
        .timeout_ms
        .and_then(|ms| {
            if ms == 0 {
                None
            } else {
                Some(Duration::from_millis(ms))
            }
        })
        .or(Some(Duration::from_secs(20)));

    server.request(&args.method, args.params, timeout).await
}

#[tauri::command]
pub async fn lsp_shutdown_workstudio(
    workstudio_id: String,
    lsp: tauri::State<'_, Arc<LspManager>>,
) -> Result<(), String> {
    lsp.shutdown_workstudio(&workstudio_id).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_shutdown_language(
    workstudio_id: String,
    language_id: String,
    lsp: tauri::State<'_, Arc<LspManager>>,
) -> Result<(), String> {
    let ws = workstudio_id.trim();
    let lang = language_id.trim();
    if ws.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }
    lsp.shutdown_language(ws, lang).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_status(
    workstudio_id: String,
    lsp: tauri::State<'_, Arc<LspManager>>,
) -> Result<Vec<LspServerStatus>, String> {
    Ok(lsp.status(&workstudio_id).await)
}

#[tauri::command]
pub async fn ast_document_symbols(args: AstDocumentSymbolsArgs) -> Result<Vec<AstSymbol>, String> {
    crate::code_intel::ast::document_symbols(args)
}

// ============================================================================
// Code Index (workstudio-scoped, persisted cache; not the main DB)
// ============================================================================

#[tauri::command]
pub async fn code_index_request_document_symbols(
    args: CodeIndexRequestDocumentSymbolsArgs,
    index: tauri::State<'_, Arc<CodeIndexManager>>,
) -> Result<CodeIndexRequestDocumentSymbolsResult, String> {
    index.request_document_symbols(args).await
}

#[tauri::command]
pub async fn code_index_start_workspace_scan(
    args: CodeIndexStartWorkspaceScanArgs,
    index: tauri::State<'_, Arc<CodeIndexManager>>,
) -> Result<(), String> {
    index.start_workspace_scan(args).await
}

#[tauri::command]
pub async fn code_index_status(
    workstudio_id: String,
    index: tauri::State<'_, Arc<CodeIndexManager>>,
) -> Result<CodeIndexStatus, String> {
    Ok(index.status(&workstudio_id).await)
}

#[tauri::command]
pub async fn code_index_summary(
    workstudio_id: String,
    index: tauri::State<'_, Arc<CodeIndexManager>>,
) -> Result<CodeIndexSummary, String> {
    index.summary(&workstudio_id).await
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDetectServerArgs {
    pub language_id: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDetectServerResult {
    pub language_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub via: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Detect LSP server executable and return an absolute command path.
///
/// 说明：
/// - 主要用于“一键配置”（自动把语言服务器的绝对路径写入配置）。
/// - 当前支持 rust/python/go/cpp/c/lua。
#[tauri::command]
pub async fn lsp_detect_server(args: LspDetectServerArgs) -> Result<LspDetectServerResult, String> {
    let lang = args.language_id.trim();
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }

    match lang {
        "rust" => detect_lsp_by_candidates(lang, &[("rust-analyzer", &[])]),
        // pylsp 不需要显式 --stdio；pyright/basedpyright 需要 --stdio。
        "python" => detect_lsp_by_candidates(
            lang,
            &[
                ("pylsp", &[]),
                ("pyright-langserver", &["--stdio"]),
                ("basedpyright-langserver", &["--stdio"]),
            ],
        ),
        // gopls 在新版本中无参会默认 serve，但这里显式传 serve 以兼容旧版本。
        "go" => detect_lsp_by_candidates(lang, &[("gopls", &["serve"])]),
        "cpp" | "c" => detect_lsp_by_candidates(lang, &[("clangd", &[])]),
        "lua" => detect_lsp_by_candidates(lang, &[("lua-language-server", &[])]),
        _ => Err(format!("暂不支持自动探测该语言的 LSP：{lang}")),
    }
}

fn detect_lsp_by_candidates(
    language_id: &str,
    candidates: &[(&str, &[&str])],
) -> Result<LspDetectServerResult, String> {
    let mut tried: Vec<String> = Vec::new();
    for (command, args) in candidates {
        tried.push(command.to_string());
        match resolve_lsp_spawn_program(command, "", &[]) {
            Ok(resolved) => {
                return Ok(LspDetectServerResult {
                    language_id: language_id.to_string(),
                    command: resolved.target,
                    args: args.iter().map(|x| x.to_string()).collect(),
                    via: resolved.via,
                    warnings: resolved.warnings,
                });
            }
            Err(_) => {
                continue;
            }
        }
    }
    Err(format!(
        "未找到可用的 LSP 可执行文件（languageId={language_id}，候选={})",
        tried.join(", ")
    ))
}

fn resolve_launch_config(
    config_manager: &Arc<ConfigManager>,
    language_id: &str,
) -> Result<LspLaunchConfig, String> {
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;

    if !config.code_intelligence.enabled {
        return Err("代码智能已关闭（设置 -> Code Intelligence）".to_string());
    }

    let lang = language_id.trim();
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }

    let server = config
        .code_intelligence
        .lsp_servers
        .iter()
        .find(|s| s.enabled && s.language_id == lang)
        .ok_or_else(|| format!("未找到已启用的 LSP 配置: {lang}"))?;

    let mut env = server
        .env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<Vec<_>>();
    env.sort_by(|(a, _), (b, _)| a.cmp(b));

    // 兼容性兜底：rust-analyzer 默认就是 stdio，无需 `--stdio`。
    // 某些版本会直接报 `unexpected flag: --stdio` 并退出（code=2）。
    let mut args = server.args.clone();
    if lang == "rust" {
        args.retain(|a| a.trim() != "--stdio");
    }

    Ok(LspLaunchConfig {
        language_id: server.language_id.clone(),
        command: server.command.clone(),
        args,
        env,
        initialization_options: server.initialization_options.clone(),
        settings: server.settings.clone(),
    })
}

// ============================================================================
// AI Code Completion (Inline ghost + Ctrl+Space list)
// ============================================================================

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeCompletionArgs {
    pub workstudio_id: String,
    pub language_id: String,
    pub file_path: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeCompletionItem {
    pub label: String,
    pub insert_text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCodeCompletionResult {
    pub items: Vec<AiCodeCompletionItem>,
    pub model_ref: String,
    pub latency_ms: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatWithSelectionArgs {
    pub workstudio_id: String,
    pub language_id: String,
    pub file_path: String,
    pub selection: String,
    pub question: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatWithSelectionResult {
    pub answer: String,
    pub model_ref: String,
    pub latency_ms: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedCompletionResponse {
    #[serde(default)]
    items: Vec<ParsedCompletionItem>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedCompletionItem {
    #[serde(default)]
    label: String,
    #[serde(default)]
    insert_text: String,
}

#[tauri::command]
pub async fn ai_code_completion(
    args: AiCodeCompletionArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<AiCodeCompletionResult, String> {
    let ws_id = args.workstudio_id.trim();
    let lang = args.language_id.trim();
    let file_path = args.file_path.trim();
    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }

    let ws: Workstudio = {
        async_db::with_db(db.inner(), "ai_code_completion:get_workstudio", |db| {
            db.get_workstudio(ws_id)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let settings = &config.code_intelligence.ai_completion;
    if !settings.enabled {
        return Err("AI 补全已关闭（设置 -> Code Intelligence -> AI Completion）".to_string());
    }
    // modelRef 优先级：
    // 1) agent config (name: "__system_code_completion")
    // 2) AppConfig.currentModelRef
    let assigned_agent = settings.agent_ref.trim();
    let assigned_agent = if assigned_agent.is_empty() {
        "__system_code_completion"
    } else {
        assigned_agent
    };

    let agent = config
        .agents
        .iter()
        .find(|a| a.name == assigned_agent)
        .or_else(|| {
            config
                .agents
                .iter()
                .find(|a| a.name == "__system_code_completion")
        });
    let effective_model_ref = agent.map(|a| a.model_ref.trim()).unwrap_or("");
    let effective_model_ref = if effective_model_ref.is_empty() {
        config
            .current_model_ref
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        effective_model_ref.to_string()
    };
    let model_ref = effective_model_ref.trim();
    if model_ref.is_empty() {
        return Err("未配置 AI Completion 的 modelRef（也未设置 currentModelRef）".to_string());
    }

    let count = args
        .count
        .unwrap_or(settings.list_suggestion_count)
        .clamp(1, 8);

    let (provider_name, model_name) = AppConfig::parse_model_ref(model_ref)
        .ok_or_else(|| "无效 modelRef（应为 provider/model）".to_string())?;
    let provider = config
        .get_provider(provider_name)
        .ok_or_else(|| format!("未找到 provider：{provider_name}"))?;
    if !provider.enabled {
        return Err(format!("Provider 未启用：{provider_name}"));
    }
    let model = provider
        .models
        .iter()
        .find(|m| m.name == model_name)
        .ok_or_else(|| format!("未找到 model：{model_name}"))?;

    let mut model_config = build_model_config(
        provider,
        model,
        Some(serde_json::Value::Bool(false)),
        Some(false),
    );
    // AI Completion 不需要“思考/推理”模式，并且部分 OpenAI-compatible 网关在请求体包含 `thinking`
    // 字段时会返回 `message.content = null`（即使 200 OK），导致前端拿不到补全内容。
    // 这里显式清空 thinking_level，避免下游 client 发送 `thinking` 字段。
    model_config.thinking_level = None;
    model_config.parameters.temperature = Some(settings.temperature.max(0.0).min(2.0) as f32);
    // 实测部分 OpenAI-compatible 网关/模型在 `max_tokens` 太小时会把输出“挤”到 reasoning_content，
    // 甚至出现 content=null，导致 AI Completion 解析失败（No content in response）。
    // 这里为补全请求设置一个更高的下限，保证有足够预算产出最终 content。
    //
    // 注意：AI Completion 是交互式能力，宁可浪费一点 token 也要保证稳定返回 content。
    model_config.parameters.max_tokens = Some(settings.max_tokens.max(8_192));

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    let prefix = tail_chars(&args.prefix, settings.max_prefix_chars);
    let suffix = head_chars(&args.suffix, settings.max_suffix_chars);

    let system_prompt = {
        let configured = config
            .agents
            .iter()
            .find(|a| a.name == "__system_code_completion");
        match configured {
            Some(a) if !a.system_prompt.trim().is_empty() => a.system_prompt.clone(),
            _ => ai_completion_system_prompt(),
        }
    };
    let user_prompt = ai_completion_user_prompt(
        lang,
        file_path,
        ws.main_folder.as_str(),
        &prefix,
        &suffix,
        count,
        settings.include_project_context,
    );

    let now = chrono::Utc::now();
    let conversation_id = format!("workstudio:{ws_id}:ai_completion");
    let messages = vec![
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: MessageRole::System,
            content: system_prompt,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id,
            role: MessageRole::User,
            content: user_prompt,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
    ];

    let started = Instant::now();
    let timeout_ms = settings.timeout_ms.max(200);
    let raw = match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        client.chat(messages, &model_config, None),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("AI 补全超时（{}ms）", timeout_ms)),
    };

    let items = parse_ai_completion_items(&raw, count);
    Ok(AiCodeCompletionResult {
        items,
        model_ref: model_ref.to_string(),
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn ai_chat_with_selection(
    args: AiChatWithSelectionArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<AiChatWithSelectionResult, String> {
    let ws_id = args.workstudio_id.trim();
    let lang = args.language_id.trim();
    let file_path = args.file_path.trim();
    let question = args.question.trim();
    let selection = args.selection.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }
    if question.is_empty() {
        return Err("question 为空".to_string());
    }
    if selection.is_empty() {
        return Err("selection 为空".to_string());
    }

    let ws: Workstudio = {
        async_db::with_db(db.inner(), "ai_chat_with_selection:get_workstudio", |db| {
            db.get_workstudio(ws_id)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let settings = &config.code_intelligence.ai_completion;
    if !settings.enabled {
        return Err("AI 补全已关闭（设置 -> Code Intelligence -> AI Completion）".to_string());
    }
    // modelRef 优先级：
    // 1) agent config (name: "__system_chat_with")
    // 2) AppConfig.currentModelRef
    let assigned_agent = settings.chat_with_agent_ref.trim();
    let assigned_agent = if assigned_agent.is_empty() {
        "__system_chat_with"
    } else {
        assigned_agent
    };

    let agent = config
        .agents
        .iter()
        .find(|a| a.name == assigned_agent)
        .or_else(|| {
            config
                .agents
                .iter()
                .find(|a| a.name == "__system_chat_with")
        });
    let effective_model_ref = agent.map(|a| a.model_ref.trim()).unwrap_or("");
    let effective_model_ref = if effective_model_ref.is_empty() {
        config
            .current_model_ref
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        effective_model_ref.to_string()
    };
    let model_ref = effective_model_ref.trim();
    if model_ref.is_empty() {
        return Err("未配置 AI Completion 的 modelRef（也未设置 currentModelRef）".to_string());
    }

    let (provider_name, model_name) = AppConfig::parse_model_ref(model_ref)
        .ok_or_else(|| "无效 modelRef（应为 provider/model）".to_string())?;
    let provider = config
        .get_provider(provider_name)
        .ok_or_else(|| format!("未找到 provider：{provider_name}"))?;
    if !provider.enabled {
        return Err(format!("Provider 未启用：{provider_name}"));
    }
    let model = provider
        .models
        .iter()
        .find(|m| m.name == model_name)
        .ok_or_else(|| format!("未找到 model：{model_name}"))?;

    let mut model_config = build_model_config(
        provider,
        model,
        Some(serde_json::Value::Bool(false)),
        Some(false),
    );
    // Inline chat 不需要“思考/推理”字段，避免部分网关返回 content=null
    model_config.thinking_level = None;
    model_config.parameters.temperature = Some(settings.temperature.max(0.0).min(2.0) as f32);
    model_config.parameters.max_tokens = Some(settings.max_tokens.max(8_192));

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    let rel_path = file_path
        .strip_prefix(ws.main_folder.as_str())
        .unwrap_or(file_path)
        .trim_start_matches(std::path::MAIN_SEPARATOR)
        .to_string();

    let system_prompt = {
        let configured = config
            .agents
            .iter()
            .find(|a| a.name == "__system_chat_with");
        match configured {
            Some(a) if !a.system_prompt.trim().is_empty() => a.system_prompt.clone(),
            _ => inline_chat_system_prompt(),
        }
    };
    let user_prompt = inline_chat_user_prompt(
        lang,
        &rel_path,
        ws.main_folder.as_str(),
        question,
        selection,
    );

    let now = chrono::Utc::now();
    let conversation_id = format!("workstudio:{ws_id}:inline_chat");
    let messages = vec![
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: MessageRole::System,
            content: system_prompt,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id,
            role: MessageRole::User,
            content: user_prompt,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
    ];

    let started = Instant::now();
    let timeout_ms = settings.timeout_ms.max(15_000);
    let answer = match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        client.chat(messages, &model_config, None),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("内联问答超时（{}ms）", timeout_ms)),
    };

    Ok(AiChatWithSelectionResult {
        answer,
        model_ref: model_ref.to_string(),
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetWorkstudioSymbolAnalysisArgs {
    pub workstudio_id: String,
    pub file_path: String,
    pub symbol_key: String,
}

#[tauri::command]
pub async fn get_workstudio_symbol_analysis(
    args: GetWorkstudioSymbolAnalysisArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioSymbolAnalysis>, String> {
    let ws_id = args.workstudio_id.trim();
    let file_path = args.file_path.trim();
    let symbol_key = args.symbol_key.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }
    if symbol_key.is_empty() {
        return Err("symbolKey 为空".to_string());
    }

    async_db::with_db(db.inner(), "get_workstudio_symbol_analysis", |db| {
        db.get_workstudio_symbol_analysis(ws_id, file_path, symbol_key)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkstudioSymbolAnalysisKeysForFileArgs {
    pub workstudio_id: String,
    pub file_path: String,
}

/// List analyzed symbol keys for a file (status prefetch).
///
/// NOTE:
/// - This only returns symbol keys (no markdown) to keep the payload small.
/// - Used by Workstudio Outline to proactively refresh "has analysis" indicators on page open.
#[tauri::command]
pub async fn list_workstudio_symbol_analysis_keys_for_file(
    args: ListWorkstudioSymbolAnalysisKeysForFileArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<String>, String> {
    let ws_id = args.workstudio_id.trim();
    let file_path = args.file_path.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "list_workstudio_symbol_analysis_keys_for_file",
        |db| db.list_workstudio_symbol_analysis_keys_for_file(ws_id, file_path),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkstudioSymbolAnalysisArgs {
    pub workstudio_id: String,
    pub file_path: String,
    pub symbol_key: String,
}

#[tauri::command]
pub async fn delete_workstudio_symbol_analysis(
    args: DeleteWorkstudioSymbolAnalysisArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let ws_id = args.workstudio_id.trim();
    let file_path = args.file_path.trim();
    let symbol_key = args.symbol_key.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }
    if symbol_key.is_empty() {
        return Err("symbolKey 为空".to_string());
    }

    async_db::with_db(db.inner(), "delete_workstudio_symbol_analysis", |db| {
        db.delete_workstudio_symbol_analysis(ws_id, file_path, symbol_key)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkstudioSymbolAnalysisArgs {
    pub workstudio_id: String,
    pub language_id: String,
    pub file_path: String,
    pub symbol_key: String,
    pub symbol_name: String,
    pub symbol_kind: String,
    pub selection_line: u32,
    pub selection_column: u32,
    pub range: CodeSnippetRange,
    pub answer_md: String,
    pub model_ref: Option<String>,
    pub latency_ms: Option<u64>,
}

#[tauri::command]
pub async fn save_workstudio_symbol_analysis(
    args: SaveWorkstudioSymbolAnalysisArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<WorkstudioSymbolAnalysis, String> {
    let ws_id = args.workstudio_id.trim();
    let lang = args.language_id.trim();
    let file_path = args.file_path.trim();
    let symbol_key = args.symbol_key.trim();
    let symbol_name = args.symbol_name.trim();
    let symbol_kind_raw = args.symbol_kind.trim();
    let answer_md = args.answer_md.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }
    if symbol_key.is_empty() {
        return Err("symbolKey 为空".to_string());
    }
    if symbol_name.is_empty() {
        return Err("symbolName 为空".to_string());
    }
    if symbol_kind_raw.is_empty() {
        return Err("symbolKind 为空".to_string());
    }
    if answer_md.is_empty() {
        return Err("answerMd 为空".to_string());
    }

    let symbol_kind = symbol_kind_raw.to_lowercase();
    let model_ref = args
        .model_ref
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    async_db::with_db(db.inner(), "save_workstudio_symbol_analysis", |db| {
        db.upsert_workstudio_symbol_analysis(
            ws_id,
            file_path,
            lang,
            symbol_key,
            symbol_name,
            &symbol_kind,
            args.selection_line,
            args.selection_column,
            &args.range,
            answer_md,
            model_ref,
            args.latency_ms,
        )
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalyzeWorkstudioSymbolArgs {
    pub workstudio_id: String,
    pub language_id: String,
    pub file_path: String,
    pub symbol_key: String,
    pub symbol_name: String,
    pub symbol_kind: String,
    pub selection_line: u32,
    pub selection_column: u32,
    pub range: CodeSnippetRange,
    pub code: String,
}

#[tauri::command]
pub async fn ai_analyze_workstudio_symbol(
    args: AiAnalyzeWorkstudioSymbolArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<WorkstudioSymbolAnalysis, String> {
    let ws_id = args.workstudio_id.trim();
    let lang = args.language_id.trim();
    let file_path = args.file_path.trim();
    let symbol_key = args.symbol_key.trim();
    let symbol_name = args.symbol_name.trim();
    let symbol_kind_raw = args.symbol_kind.trim();
    let code = args.code.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }
    if symbol_key.is_empty() {
        return Err("symbolKey 为空".to_string());
    }
    if symbol_name.is_empty() {
        return Err("symbolName 为空".to_string());
    }
    if symbol_kind_raw.is_empty() {
        return Err("symbolKind 为空".to_string());
    }
    if code.is_empty() {
        return Err("code 为空".to_string());
    }

    let ws: Workstudio = {
        async_db::with_db(
            db.inner(),
            "ai_analyze_workstudio_symbol:get_workstudio",
            |db| db.get_workstudio(ws_id),
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let settings = config
        .code_intelligence
        .symbol_analysis
        .clone()
        .unwrap_or_default();
    if !settings.enabled {
        return Err("符号分析已关闭（设置 -> 代码智能 -> 符号分析）".to_string());
    }

    // modelRef 优先级：
    // 1) agent config (name: "__system_symbol_analysis")
    // 2) AppConfig.currentModelRef
    let assigned_agent = settings.agent_ref.trim();
    let assigned_agent = if assigned_agent.is_empty() {
        "__system_symbol_analysis"
    } else {
        assigned_agent
    };

    let agent = config
        .agents
        .iter()
        .find(|a| a.name == assigned_agent)
        .or_else(|| {
            config
                .agents
                .iter()
                .find(|a| a.name == "__system_symbol_analysis")
        });
    let effective_model_ref = agent.map(|a| a.model_ref.trim()).unwrap_or("");
    let effective_model_ref = if effective_model_ref.is_empty() {
        config
            .current_model_ref
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        effective_model_ref.to_string()
    };
    let model_ref = effective_model_ref.trim();
    if model_ref.is_empty() {
        return Err("未配置符号分析的 modelRef（也未设置 currentModelRef）".to_string());
    }

    let (provider_name, model_name) = AppConfig::parse_model_ref(model_ref)
        .ok_or_else(|| "无效 modelRef（应为 provider/model）".to_string())?;
    let provider = config
        .get_provider(provider_name)
        .ok_or_else(|| format!("未找到 provider：{provider_name}"))?;
    if !provider.enabled {
        return Err(format!("Provider 未启用：{provider_name}"));
    }
    let model = provider
        .models
        .iter()
        .find(|m| m.name == model_name)
        .ok_or_else(|| format!("未找到 model：{model_name}"))?;

    let mut model_config = build_model_config(
        provider,
        model,
        Some(serde_json::Value::Bool(false)),
        Some(false),
    );
    // 分析不需要“思考/推理”字段，避免部分网关返回 content=null
    model_config.thinking_level = None;
    model_config.parameters.temperature = Some(settings.temperature.max(0.0).min(2.0) as f32);
    model_config.parameters.max_tokens = Some(settings.max_tokens.max(8_192));

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    let rel_path = file_path
        .strip_prefix(ws.main_folder.as_str())
        .unwrap_or(file_path)
        .trim_start_matches(std::path::MAIN_SEPARATOR)
        .to_string();

    let symbol_kind = symbol_kind_raw.to_lowercase();
    let system_prompt = {
        let configured = config
            .agents
            .iter()
            .find(|a| a.name == "__system_symbol_analysis");
        match configured {
            Some(a) if !a.system_prompt.trim().is_empty() => a.system_prompt.clone(),
            _ => symbol_analysis_system_prompt(),
        }
    };
    let user_prompt = symbol_analysis_user_prompt(
        lang,
        &rel_path,
        ws.main_folder.as_str(),
        symbol_name,
        &symbol_kind,
        args.selection_line,
        args.selection_column,
        &args.range,
        code,
        settings.include_project_context,
    );

    let now = chrono::Utc::now();
    let conversation_id = format!("workstudio:{ws_id}:symbol_analysis");
    let messages = vec![
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: MessageRole::System,
            content: system_prompt,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id,
            role: MessageRole::User,
            content: user_prompt,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
    ];

    let started = Instant::now();
    let timeout_ms = settings.timeout_ms.max(20_000);
    let answer_md = match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        client.chat(messages, &model_config, None),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("符号分析超时（{}ms）", timeout_ms)),
    };

    let latency_ms = started.elapsed().as_millis() as u64;

    let analysis = async_db::with_db(db.inner(), "ai_analyze_workstudio_symbol:upsert", |db| {
        db.upsert_workstudio_symbol_analysis(
            ws_id,
            file_path,
            lang,
            symbol_key,
            symbol_name,
            &symbol_kind,
            args.selection_line,
            args.selection_column,
            &args.range,
            &answer_md,
            Some(model_ref),
            Some(latency_ms),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(analysis)
}

fn ai_completion_system_prompt() -> String {
    // 说明：
    // - 这里用“严格 JSON 输出”来让前端稳定解析；
    // - 不要输出 Markdown/fence；只输出 JSON 字符串本体。
    r#"你是一个 IDE 里的代码补全引擎。

你必须只输出一个 JSON 对象，且只能包含这些字段：
{
  "items": [
    { "label": "短描述", "insertText": "要插入的文本" }
  ]
}

严格规则：
- 只输出 JSON，不要输出任何解释、注释、Markdown、代码块围栏（```）。
- insertText 只包含“需要在光标处插入的内容”，不要重复 prefix，也不要包含 suffix。
- 使用 \n 表示换行；不要输出 JSON 之外的任何字符。
"#
    .to_string()
}

fn ai_completion_user_prompt(
    language_id: &str,
    file_path: &str,
    project_root: &str,
    prefix: &str,
    suffix: &str,
    count: u32,
    include_project_context: bool,
) -> String {
    let mut out = String::new();
    out.push_str("请生成代码补全。\n");
    out.push_str(&format!("languageId: {language_id}\n"));
    out.push_str(&format!("count: {count}\n"));
    if include_project_context {
        out.push_str(&format!("projectRoot: {project_root}\n"));
        out.push_str(&format!("filePath: {file_path}\n"));
    }
    out.push_str("\n<prefix>\n");
    out.push_str(prefix);
    out.push_str("\n</prefix>\n\n<suffix>\n");
    out.push_str(suffix);
    out.push_str("\n</suffix>\n");
    out
}

fn inline_chat_system_prompt() -> String {
    r#"你是 IDE 中的“内联代码问答助手”。

你会收到：
- 用户的问题
- 一个“选中代码片段”（可能只是一部分，需要你自行推断上下文）
- 一些元信息（languageId、filePath、projectRoot）

请按用户问题直接作答，并遵循：
- 如缺少关键上下文，请明确指出需要哪些信息/文件。
- 可给出可执行的下一步（例如：要看的文件、要跑的命令、要加的日志点）。
- 输出使用 Markdown，必要时可包含代码块。
"#
    .to_string()
}

fn inline_chat_user_prompt(
    language_id: &str,
    file_path: &str,
    project_root: &str,
    question: &str,
    selection: &str,
) -> String {
    let mut out = String::new();
    out.push_str("请基于选中代码片段回答问题。\n\n");
    out.push_str(&format!("languageId: {language_id}\n"));
    out.push_str(&format!("filePath: {file_path}\n"));
    out.push_str(&format!("projectRoot: {project_root}\n"));
    out.push('\n');
    out.push_str("问题：\n");
    out.push_str(question);
    out.push_str("\n\n选中代码：\n");
    out.push_str(&format!("```{language_id}\n{selection}\n```\n"));
    out
}

#[derive(Debug, Clone, Copy)]
enum SymbolAnalysisKind {
    Class,
    Function,
    Variable,
    Symbol,
}

fn classify_symbol_analysis_kind(symbol_kind: &str) -> SymbolAnalysisKind {
    let k = symbol_kind.trim().to_lowercase();
    match k.as_str() {
        // “容器/类型”类：优先当作 class 来分析
        "class" | "struct" | "interface" | "enum" | "trait" | "impl" | "module" | "namespace"
        | "package" | "object" => SymbolAnalysisKind::Class,
        // 可调用
        "method" | "function" | "constructor" | "operator" => SymbolAnalysisKind::Function,
        // 值/成员
        "property" | "field" | "variable" | "constant" | "enum_member" => {
            SymbolAnalysisKind::Variable
        }
        _ => SymbolAnalysisKind::Symbol,
    }
}

fn symbol_analysis_system_prompt() -> String {
    r#"你是 IDE 中的“代码符号分析助手”（Symbol Analysis）。

你的目标：在不臆测的前提下，基于符号的代码片段 + 工程上下文，给出“可执行、可验证”的分析结论。

你会收到：
- 一个代码符号的元信息（symbolName、symbolKind、filePath、location 等）
- 该符号对应的代码片段（可能不完整）
- 一些工程元信息（languageId、projectRoot）

输出要求（必须）：
- 使用 Markdown。
- 先给结论摘要（1-3 句），再给结构化分析（分点/小标题均可），最后给风险点 + 可执行改进建议 + 验证清单。
- 当缺少关键上下文时：明确列出需要看的文件/需要搜索的关键字/需要补充的信息，不要猜。

### 文件引用（必须严格遵守）
当你在讨论代码定位、调用链、实现细节或引用关系时，所有关键结论必须附带**可点击文件引用**，格式只允许：
- `相对路径:行` 或 `相对路径:行:列`
- `相对路径#L行` 或 `相对路径#L行C列`
禁止使用 Markdown 链接语法引用文件（例如 `[label](path)`）；不要编造行号。

### 分析策略（按符号类型自适应）
1) 若符号是大型类型/容器（class/struct/trait/enum/module…）：优先宏观（职责边界、对外 API、关键成员分组、依赖/生命周期/并发/错误处理/扩展点），避免逐行复述。
2) 若符号是函数/方法：先解释业务意图，再给可能的业务调用路径（上游入口/调用者/下游依赖），并分析失败路径与可观测性。
3) 若符号是变量/字段/常量：做引用分析（写入/读取/传递路径）并解释其在系统中的作用与不变量。
"#
    .to_string()
}

fn symbol_analysis_user_prompt(
    language_id: &str,
    file_path: &str,
    project_root: &str,
    symbol_name: &str,
    symbol_kind: &str,
    selection_line: u32,
    selection_column: u32,
    range: &CodeSnippetRange,
    code: &str,
    include_project_context: bool,
) -> String {
    let kind = classify_symbol_analysis_kind(symbol_kind);
    let request = match kind {
        SymbolAnalysisKind::Class => {
            "请分析该类型/容器符号。若代码片段较大，请优先做偏宏观的分析（职责边界、对外 API、关键成员分组、依赖/生命周期/并发/错误处理/扩展点），避免逐行复述。"
        }
        SymbolAnalysisKind::Function => {
            "请分析该函数/方法，并尽可能调查其可能的业务调用路径：它可能被哪些入口/上游调用，又会调用哪些关键下游依赖；结合代码解释其业务意图、关键流程、依赖与副作用，并给出风险点与验证建议。"
        }
        SymbolAnalysisKind::Variable => {
            "请分析该变量/字段/常量，并尽可能做引用分析（写入点/读取点/传递路径），解释它在整个系统中的作用、约束/不变量与易错用法。"
        }
        SymbolAnalysisKind::Symbol => "请分析该符号的含义、用途与在模块中的角色，并指出可能的风险点。",
    };

    let mut out = String::new();
    out.push_str(request);
    out.push('\n');
    out.push_str(&format!("languageId: {language_id}\n"));
    if include_project_context {
        out.push_str(&format!("filePath: {file_path}\n"));
        out.push_str(&format!("projectRoot: {project_root}\n"));
    }
    out.push_str(&format!("symbolName: {symbol_name}\n"));
    out.push_str(&format!("symbolKind: {symbol_kind}\n"));
    out.push_str(&format!(
        "symbolSelection: {}:{}\n",
        selection_line, selection_column
    ));
    out.push_str(&format!(
        "symbolRange: {}:{}-{}:{}\n",
        range.start_line, range.start_column, range.end_line, range.end_column
    ));
    out.push('\n');
    out.push_str("代码片段：\n");
    out.push_str(&format!("```{language_id}\n{code}\n```\n"));
    out
}

fn strip_markdown_code_fence(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    // ```json\n{...}\n``` -> {...}
    let mut lines = trimmed.lines();
    let first = lines.next().unwrap_or_default();
    if !first.starts_with("```") {
        return trimmed.to_string();
    }
    let mut body: Vec<&str> = lines.collect();
    if let Some(last) = body.last() {
        if last.trim().starts_with("```") {
            body.pop();
        }
    }
    body.join("\n").trim().to_string()
}

fn extract_json_candidate(text: &str) -> Option<&str> {
    let s = text.trim();
    if s.starts_with('{') && s.ends_with('}') {
        return Some(s);
    }
    if s.starts_with('[') && s.ends_with(']') {
        return Some(s);
    }
    let first_obj = s.find('{');
    let last_obj = s.rfind('}');
    if let (Some(a), Some(b)) = (first_obj, last_obj) {
        if b > a {
            return Some(&s[a..=b]);
        }
    }
    let first_arr = s.find('[');
    let last_arr = s.rfind(']');
    if let (Some(a), Some(b)) = (first_arr, last_arr) {
        if b > a {
            return Some(&s[a..=b]);
        }
    }
    None
}

fn parse_ai_completion_items(raw: &str, limit: u32) -> Vec<AiCodeCompletionItem> {
    let cleaned = strip_markdown_code_fence(raw);
    let candidate = extract_json_candidate(&cleaned).unwrap_or(cleaned.as_str());

    let mut parsed: Vec<ParsedCompletionItem> = Vec::new();
    if let Ok(v) = serde_json::from_str::<ParsedCompletionResponse>(candidate) {
        parsed = v.items;
    } else if let Ok(v) = serde_json::from_str::<Vec<ParsedCompletionItem>>(candidate) {
        parsed = v;
    }

    let mut out: Vec<AiCodeCompletionItem> = Vec::new();
    for item in parsed {
        let insert_text = strip_markdown_code_fence(item.insert_text.trim_end()).to_string();
        if insert_text.is_empty() {
            continue;
        }
        let label = if !item.label.trim().is_empty() {
            item.label.trim().to_string()
        } else {
            first_line_label(&insert_text)
        };
        out.push(AiCodeCompletionItem { label, insert_text });
        if out.len() >= limit as usize {
            break;
        }
    }

    if out.is_empty() {
        // JSON 解析失败时：把原始文本当作单条 insertText（尽量剥离 fence）。
        let insert_text = strip_markdown_code_fence(cleaned.trim_end()).to_string();
        if !insert_text.is_empty() {
            out.push(AiCodeCompletionItem {
                label: first_line_label(&insert_text),
                insert_text,
            });
        }
    }

    out
}

fn first_line_label(insert_text: &str) -> String {
    let line = insert_text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        "AI".to_string()
    } else if line.chars().count() > 60 {
        line.chars().take(60).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    text.chars().skip(total - max_chars).collect()
}

fn head_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

// ============================================================================
// Workstudio Agent Stream
// ============================================================================

/// Abort sender registry: run_id → oneshot cancel sender
fn agent_abort_map() -> &'static dashmap::DashMap<String, tokio::sync::oneshot::Sender<()>> {
    static MAP: std::sync::OnceLock<dashmap::DashMap<String, tokio::sync::oneshot::Sender<()>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(dashmap::DashMap::new)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioRunAgentArgs {
    pub workstudio_id: String,
    pub agent_name: String,
    pub language_id: Option<String>,
    pub file_path: Option<String>,
    pub symbol_key: Option<String>,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<String>,
    pub code: Option<String>,
    pub user_input: String,
}

/// Agent stream event payload emitted to the frontend as `workstudio:agent:event`
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WorkstudioAgentEvent {
    /// A content text delta was received
    TextDelta { run_id: String, delta: String },
    /// A thinking/reasoning delta was received
    ThinkingDelta { run_id: String, delta: String },
    /// A tool call was requested by the model
    ToolCall {
        run_id: String,
        id: String,
        name: String,
        arguments: String,
    },
    /// Streaming completed successfully
    Done {
        run_id: String,
        answer_md: String,
        model_ref: String,
        latency_ms: u64,
    },
    /// An error occurred
    Error { run_id: String, message: String },
}

#[tauri::command]
pub async fn workstudio_run_agent_stream(
    args: WorkstudioRunAgentArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
) -> Result<String, String> {
    use crate::ai_client::{StreamEvent, StreamOptions};
    use tauri::Emitter;
    use tokio::sync::{mpsc, oneshot};

    let ws_id = args.workstudio_id.trim().to_string();
    let agent_name = args.agent_name.trim().to_string();
    let user_input = args.user_input.trim().to_string();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if agent_name.is_empty() {
        return Err("agentName 为空".to_string());
    }
    if user_input.is_empty() {
        return Err("userInput 为空".to_string());
    }

    // --- Fetch workstudio ---
    let ws: Workstudio = {
        async_db::with_db(
            db.inner(),
            "workstudio_run_agent_stream:get_workstudio",
            |db| db.get_workstudio(&ws_id),
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())?
    };

    // --- Fetch config & agent ---
    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let agent = config
        .agents
        .iter()
        .find(|a| a.name == agent_name)
        .cloned()
        .or_else(|| {
            // Fallback for default system agents that might not be explicitly stored yet
            if agent_name.starts_with("__system_") {
                Some(crate::models::Agent {
                    name: agent_name.clone(),
                    enabled: true,
                    agent_type: crate::models::AgentType::Chat,
                    display_name: String::new(),
                    description: None,
                    model_ref: config.current_model_ref.clone().unwrap_or_default(),
                    system_prompt: String::new(),
                    format_type: crate::prompts::FormatPromptType::default(),
                    default_run_mode: None,
                    toolset: None,
                    mcp_set: None,
                    skill_set: None,
                    security_policy: None,
                    sandbox_policy: None,
                    approval_policy: None,
                    workspace_support: None,
                    max_turns: None,
                    reinject_thinking: false,
                    context_policy: None,
                    workstudio_enabled: None,
                })
            } else {
                None
            }
        })
        .ok_or_else(|| format!("Agent not found: {agent_name}"))?;

    let model_ref = agent.model_ref.trim().to_string();
    if model_ref.is_empty() {
        return Err(format!("Agent '{agent_name}' has no modelRef configured"));
    }

    let (provider_name, model_name) = AppConfig::parse_model_ref(&model_ref)
        .ok_or_else(|| format!("Invalid modelRef: {model_ref}"))?;
    let provider = config
        .get_provider(provider_name)
        .ok_or_else(|| format!("Provider not found: {provider_name}"))?;
    if !provider.enabled {
        return Err(format!("Provider not enabled: {provider_name}"));
    }
    let model = provider
        .models
        .iter()
        .find(|m| m.name == model_name)
        .ok_or_else(|| format!("Model not found: {model_name}"))?;

    let mut model_config = build_model_config(
        provider,
        model,
        Some(serde_json::Value::Bool(false)),
        Some(false),
    );
    model_config.thinking_level = None;

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    // --- Build messages ---
    let run_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    let conversation_id = format!("workstudio:{ws_id}:agent:{agent_name}");

    let rel_path = args.file_path.as_deref().map(|fp| {
        fp.strip_prefix(ws.main_folder.as_str())
            .unwrap_or(fp)
            .trim_start_matches(std::path::MAIN_SEPARATOR)
            .to_string()
    });

    // Build system prompt from agent + context metadata
    let mut system_parts = vec![agent.system_prompt.clone()];
    if let Some(ref rp) = rel_path {
        system_parts.push(format!("当前文件: {rp}"));
    }
    if let Some(ref sym) = args.symbol_name {
        let kind = args.symbol_kind.as_deref().unwrap_or("symbol");
        system_parts.push(format!("当前符号: {sym}（{kind}）"));
    }
    if !ws.main_folder.is_empty() {
        system_parts.push(format!("项目根目录: {}", ws.main_folder));
    }
    let system_content = system_parts.join("\n");

    // Build user content: optional code snippet + user question
    let mut user_parts: Vec<String> = Vec::new();
    if let Some(ref code) = args.code {
        let lang = args.language_id.as_deref().unwrap_or("text");
        user_parts.push(format!("```{lang}\n{code}\n```"));
    }
    user_parts.push(user_input.clone());
    let user_content = user_parts.join("\n\n");

    let messages = vec![
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.clone(),
            role: MessageRole::System,
            content: system_content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id,
            role: MessageRole::User,
            content: user_content,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: now,
            status: MessageStatus::Success,
            error_message: None,
        },
    ];

    // --- Set up abort channel ---
    let (abort_tx, abort_rx) = oneshot::channel::<()>();
    agent_abort_map().insert(run_id.clone(), abort_tx);

    // --- Spawn streaming task ---
    let run_id_clone = run_id.clone();
    let app_handle_clone = app_handle.clone();
    let file_path = args.file_path.clone();
    let symbol_key = args.symbol_key.clone();
    let model_ref_clone = model_ref.clone();

    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<StreamEvent>(256);
        let started = Instant::now();

        let stream_handle = tokio::spawn({
            let model_config = model_config.clone();
            let client = client.clone();
            async move {
                client
                    .chat_stream(messages, &model_config, None, tx, StreamOptions::default())
                    .await
            }
        });

        let mut content_buf = String::new();
        let mut thinking_buf = String::new();
        let mut final_content: Option<String> = None;
        let mut stream_error: Option<String> = None;

        tokio::select! {
            _ = abort_rx => {
                stream_handle.abort();
                let _ = app_handle_clone.emit(
                    "workstudio:agent:event",
                    WorkstudioAgentEvent::Error {
                        run_id: run_id_clone.clone(),
                        message: "已中止".to_string(),
                    },
                );
                agent_abort_map().remove(&run_id_clone);
                return;
            }
            _ = async {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        StreamEvent::Token(delta) => {
                            content_buf.push_str(&delta);
                            let _ = app_handle_clone.emit(
                                "workstudio:agent:event",
                                WorkstudioAgentEvent::TextDelta {
                                    run_id: run_id_clone.clone(),
                                    delta,
                                },
                            );
                        }
                        StreamEvent::Thinking(delta) => {
                            thinking_buf.push_str(&delta);
                            let _ = app_handle_clone.emit(
                                "workstudio:agent:event",
                                WorkstudioAgentEvent::ThinkingDelta {
                                    run_id: run_id_clone.clone(),
                                    delta,
                                },
                            );
                        }
                        StreamEvent::ToolCalls(calls) => {
                            for call in calls {
                                let _ = app_handle_clone.emit(
                                    "workstudio:agent:event",
                                    WorkstudioAgentEvent::ToolCall {
                                        run_id: run_id_clone.clone(),
                                        id: call.id,
                                        name: call.name,
                                        arguments: call.arguments,
                                    },
                                );
                            }
                        }
                        StreamEvent::Done(content) => {
                            final_content = Some(content);
                            break;
                        }
                        StreamEvent::DoneWithThinking { content, .. } => {
                            final_content = Some(content);
                            break;
                        }
                        StreamEvent::DoneWithDebug { content, .. } => {
                            final_content = Some(content);
                            break;
                        }
                        StreamEvent::Error(e) => {
                            stream_error = Some(e);
                            break;
                        }
                        StreamEvent::TurnState(_) | StreamEvent::WebSearch { .. } => {}
                    }
                }
            } => {}
        }

        agent_abort_map().remove(&run_id_clone);

        if let Some(err) = stream_error {
            let _ = app_handle_clone.emit(
                "workstudio:agent:event",
                WorkstudioAgentEvent::Error {
                    run_id: run_id_clone,
                    message: err,
                },
            );
            return;
        }

        let answer_md = final_content.unwrap_or(content_buf);
        let latency_ms = started.elapsed().as_millis() as u64;

        // Persist to DB if we have a symbol key
        if let (Some(fp), Some(sk)) = (file_path.as_deref(), symbol_key.as_deref()) {
            // We have a db handle reference via the db State, but it was consumed during messages build.
            // We emit the done event with full content and let frontend cache.
            // For heavy persistence, a separate `workstudio_save_agent_result` command can be called by frontend.
            let _ = sk; // suppress warning — persistence done client-side via separate invoke
            let _ = fp;
        }

        let _ = app_handle_clone.emit(
            "workstudio:agent:event",
            WorkstudioAgentEvent::Done {
                run_id: run_id_clone,
                answer_md,
                model_ref: model_ref_clone,
                latency_ms,
            },
        );
    });

    Ok(run_id)
}

#[tauri::command]
pub async fn workstudio_abort_agent(run_id: String) -> Result<(), String> {
    if let Some((_, tx)) = agent_abort_map().remove(&run_id) {
        let _ = tx.send(());
    }
    Ok(())
}
