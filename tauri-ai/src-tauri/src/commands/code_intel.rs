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
use crate::code_intel::lsp::LspManager;
use crate::code_intel::lsp::resolve_lsp_spawn_program;
use crate::code_intel::ast::{AstDocumentSymbolsArgs, AstSymbol};
use crate::code_intel::types::{LspLaunchConfig, LspServerStatus};
use crate::config::ConfigManager;
use crate::models::{AppConfig, Message, MessageRole, MessageStatus, Workstudio};
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
        let db = db.lock().await;
        db.get_workstudio(&args.workstudio_id)
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
        let db = db.lock().await;
        db.get_workstudio(&args.workstudio_id)
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
        let db = db.lock().await;
        db.get_workstudio(&args.workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let launch = resolve_launch_config(&*config_manager, &args.language_id)?;
    let server = lsp.ensure(&ws, &args.language_id, launch).await?;

    let timeout = args
        .timeout_ms
        .and_then(|ms| if ms == 0 { None } else { Some(Duration::from_millis(ms)) })
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
/// - 当前支持 rust/python/cpp/c/lua。
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
    let config = config_manager
        .ensure_default()
        .map_err(|e| e.to_string())?;

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
        let db = db.lock().await;
        db.get_workstudio(ws_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let config = config_manager
        .ensure_default()
        .map_err(|e| e.to_string())?;
    let settings = &config.code_intelligence.ai_completion;
    if !settings.enabled {
        return Err("AI 补全已关闭（设置 -> Code Intelligence -> AI Completion）".to_string());
    }
    // modelRef 优先级：
    // 1) codeIntelligence.aiCompletion.modelRef（显式指定）
    // 2) AppConfig.currentModelRef（全局“当前模型”，符合“全局一个 modelRef”诉求）
    let effective_model_ref = settings
        .model_ref
        .trim()
        .to_string();
    let effective_model_ref = if effective_model_ref.is_empty() {
        config
            .current_model_ref
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        effective_model_ref
    };
    let model_ref = effective_model_ref.trim();
    if model_ref.is_empty() {
        return Err("未配置 AI Completion 的 modelRef（也未设置 currentModelRef）".to_string());
    }

    let count = args
        .count
        .unwrap_or(settings.list_suggestion_count)
        .clamp(1, 8);

    let (provider_name, model_name) =
        AppConfig::parse_model_ref(model_ref).ok_or_else(|| "无效 modelRef（应为 provider/model）".to_string())?;
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
    model_config
        .parameters
        .max_tokens = Some(settings.max_tokens.max(8_192));

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    let prefix = tail_chars(&args.prefix, settings.max_prefix_chars);
    let suffix = head_chars(&args.suffix, settings.max_suffix_chars);

    let system_prompt = ai_completion_system_prompt();
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
        let db = db.lock().await;
        db.get_workstudio(ws_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let config = config_manager
        .ensure_default()
        .map_err(|e| e.to_string())?;
    let settings = &config.code_intelligence.ai_completion;
    if !settings.enabled {
        return Err("AI 补全已关闭（设置 -> Code Intelligence -> AI Completion）".to_string());
    }
    // modelRef 优先级：
    // 1) codeIntelligence.aiCompletion.modelRef（显式指定）
    // 2) AppConfig.currentModelRef（全局“当前模型”）
    let effective_model_ref = settings.model_ref.trim().to_string();
    let effective_model_ref = if effective_model_ref.is_empty() {
        config
            .current_model_ref
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        effective_model_ref
    };
    let model_ref = effective_model_ref.trim();
    if model_ref.is_empty() {
        return Err("未配置 AI Completion 的 modelRef（也未设置 currentModelRef）".to_string());
    }

    let (provider_name, model_name) =
        AppConfig::parse_model_ref(model_ref).ok_or_else(|| "无效 modelRef（应为 provider/model）".to_string())?;
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
    model_config
        .parameters
        .max_tokens = Some(settings.max_tokens.max(8_192));

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;

    let rel_path = file_path
        .strip_prefix(ws.main_folder.as_str())
        .unwrap_or(file_path)
        .trim_start_matches(std::path::MAIN_SEPARATOR)
        .to_string();

    let system_prompt = inline_chat_system_prompt();
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
