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
    CodeIndexSearchWorkspaceSymbolsArgs, CodeIndexStartWorkspaceScanArgs, CodeIndexStatus,
    CodeIndexSummary,
};
use crate::code_intel::index_types::CodeIndexWorkspaceSymbolSearchResult;
use crate::code_intel::lsp::{resolve_lsp_spawn_program, LspManager};
use crate::code_intel::types::{LspLaunchConfig, LspServerStatus};
use crate::config::ConfigManager;
use crate::models::{
    AppConfig, CodeSnippetRange, ContentPart, Message, MessageRole, MessageStatus, Workstudio,
    WorkstudioChatWithFileSummary, WorkstudioChatWithIndexEntry, WorkstudioChatWithRecord,
    WorkstudioChatWithScope, WorkstudioChatWithThread, WorkstudioChatWithThreadLookup,
    WorkstudioFolderAnalysis, WorkstudioFolderAnalysisSummary, WorkstudioSymbolAnalysis,
    WorkstudioSymbolAnalysisSummary,
};
use crate::storage::async_db;
use crate::storage::Database;

fn canonical_lsp_language_id(language_id: &str) -> String {
    match language_id.trim().to_ascii_lowercase().as_str() {
        "c++" | "cplusplus" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp".to_string(),
        "py" => "python".to_string(),
        other => other.to_string(),
    }
}

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

    let language_id = canonical_lsp_language_id(&args.language_id);
    let launch = resolve_launch_config(&*config_manager, &language_id)?;
    lsp.ensure(&ws, &language_id, launch).await?;
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

    let language_id = canonical_lsp_language_id(&args.language_id);
    let launch = resolve_launch_config(&*config_manager, &language_id)?;
    let server = lsp.ensure(&ws, &language_id, launch).await?;
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

    let language_id = canonical_lsp_language_id(&args.language_id);
    let launch = resolve_launch_config(&*config_manager, &language_id)?;
    let server = lsp.ensure(&ws, &language_id, launch).await?;

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
    let canonical_language_id = canonical_lsp_language_id(&language_id);
    let lang = canonical_language_id.trim();
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
pub async fn code_index_search_workspace_symbols(
    args: CodeIndexSearchWorkspaceSymbolsArgs,
    index: tauri::State<'_, Arc<CodeIndexManager>>,
) -> Result<Vec<CodeIndexWorkspaceSymbolSearchResult>, String> {
    index.search_workspace_symbols(args).await
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
    let canonical_language = canonical_lsp_language_id(&args.language_id);
    let lang = canonical_language.trim();
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }

    match lang {
        "rust" => detect_lsp_by_candidates(lang, &[("rust-analyzer", &[])]),
        // pylsp 不需要显式 --stdio；pyright/basedpyright 需要 --stdio。
        "python" => detect_lsp_by_candidates(
            lang,
            &[
                ("pyright-langserver", &["--stdio"]),
                ("basedpyright-langserver", &["--stdio"]),
                ("pylsp", &[]),
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

    let canonical_language = canonical_lsp_language_id(language_id);
    let lang = canonical_language.trim();
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }

    let server = config
        .code_intelligence
        .lsp_servers
        .iter()
        .find(|s| s.enabled && canonical_lsp_language_id(&s.language_id) == lang)
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
    model_config.thinking_level = None;
    model_config.parameters.temperature = Some(settings.temperature.max(0.0).min(2.0) as f32);
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
pub struct ListWorkstudioSymbolAnalysisSummariesForFileArgs {
    pub workstudio_id: String,
    pub file_path: String,
}

/// List analysis summaries (health level / verdict / counters) for a file.
///
/// Used by Workstudio Outline for color rendering and tooltips without loading full markdown.
#[tauri::command]
pub async fn list_workstudio_symbol_analysis_summaries_for_file(
    args: ListWorkstudioSymbolAnalysisSummariesForFileArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<WorkstudioSymbolAnalysisSummary>, String> {
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
        "list_workstudio_symbol_analysis_summaries_for_file",
        |db| db.list_workstudio_symbol_analysis_summaries_for_file(ws_id, file_path),
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
    /// Symbol origin for the analysis: "lsp" | "ast_cst" (optional).
    pub symbol_source: Option<String>,
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SymbolDiagnosisCountsV1 {
    pub errors: Option<u32>,
    pub defects: Option<u32>,
    pub improvements: Option<u32>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SymbolDiagnosisV1 {
    pub schema: Option<String>,
    pub health_level: Option<u8>,
    pub verdict: Option<String>,
    pub confidence: Option<f32>,
    pub summary: Option<String>,
    pub counts: Option<SymbolDiagnosisCountsV1>,
}

fn try_extract_symbol_diagnosis_v1(
    answer_md: &str,
) -> (Option<SymbolDiagnosisV1>, Option<String>, String) {
    // Expected format:
    // ```json
    // { ... }
    // ```
    // <markdown...>

    let text = answer_md.trim();
    if text.is_empty() {
        return (None, None, String::new());
    }

    // Only extract the first json code block; ignore others.
    let open_idx = match text.find("```json") {
        Some(v) => v,
        None => return (None, None, text.to_string()),
    };

    // Find end of the opening fence line.
    let open_line_end = match text[open_idx..].find('\n') {
        Some(v) => open_idx + v + 1,
        None => return (None, None, text.to_string()),
    };

    let rest = &text[open_line_end..];
    let close_rel = match rest.find("```") {
        Some(v) => v,
        None => return (None, None, text.to_string()),
    };

    let json_raw = rest[..close_rel].trim();
    if json_raw.is_empty() {
        return (None, None, text.to_string());
    }

    let diag: SymbolDiagnosisV1 = match serde_json::from_str(json_raw) {
        Ok(v) => v,
        Err(_) => return (None, None, text.to_string()),
    };

    let schema_ok = diag
        .schema
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s == "tauriai.symbol_diagnosis.v1" || s.starts_with("tauriai.symbol_diagnosis."))
        .unwrap_or(false);
    if !schema_ok {
        return (None, None, text.to_string());
    }

    let markdown = rest[close_rel + 3..].trim_start().to_string();
    let kept = if markdown.trim().is_empty() {
        // Don't drop content if model forgot to output markdown.
        text.to_string()
    } else {
        markdown
    };

    (Some(diag), Some(json_raw.to_string()), kept)
}

fn try_extract_folder_diagnosis_v1(
    answer_md: &str,
) -> (Option<SymbolDiagnosisV1>, Option<String>, String) {
    // Same extraction protocol as symbol diagnosis, but schema differs:
    // - tauriai.folder_diagnosis.v1
    let text = answer_md.trim();
    if text.is_empty() {
        return (None, None, String::new());
    }

    // Only extract the first json code block; ignore others.
    let open_idx = match text.find("```json") {
        Some(v) => v,
        None => return (None, None, text.to_string()),
    };

    // Find end of the opening fence line.
    let open_line_end = match text[open_idx..].find('\n') {
        Some(v) => open_idx + v + 1,
        None => return (None, None, text.to_string()),
    };

    let rest = &text[open_line_end..];
    let close_rel = match rest.find("```") {
        Some(v) => v,
        None => return (None, None, text.to_string()),
    };

    let json_raw = rest[..close_rel].trim();
    if json_raw.is_empty() {
        return (None, None, text.to_string());
    }

    let diag: SymbolDiagnosisV1 = match serde_json::from_str(json_raw) {
        Ok(v) => v,
        Err(_) => return (None, None, text.to_string()),
    };

    let schema_ok = diag
        .schema
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s == "tauriai.folder_diagnosis.v1" || s.starts_with("tauriai.folder_diagnosis."))
        .unwrap_or(false);
    if !schema_ok {
        return (None, None, text.to_string());
    }

    let markdown = rest[close_rel + 3..].trim_start().to_string();
    let kept = if markdown.trim().is_empty() {
        // Don't drop content if model forgot to output markdown.
        text.to_string()
    } else {
        markdown
    };

    (Some(diag), Some(json_raw.to_string()), kept)
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
    let symbol_source = args
        .symbol_source
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .filter(|s| s == "lsp" || s == "ast_cst");
    let model_ref = args
        .model_ref
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let (diagnosis, diagnosis_json, answer_md_cleaned) = try_extract_symbol_diagnosis_v1(answer_md);
    let health_level = diagnosis
        .as_ref()
        .and_then(|d| d.health_level)
        .filter(|v| (1..=10).contains(v));
    let diagnosis_verdict = diagnosis
        .as_ref()
        .and_then(|d| d.verdict.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let diagnosis_confidence = diagnosis
        .as_ref()
        .and_then(|d| d.confidence)
        .map(|v| v.max(0.0).min(1.0));
    let diagnosis_summary = diagnosis
        .as_ref()
        .and_then(|d| d.summary.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let diagnosis_errors = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.errors);
    let diagnosis_defects = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.defects);
    let diagnosis_improvements = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.improvements);

    async_db::with_db(db.inner(), "save_workstudio_symbol_analysis", |db| {
        db.upsert_workstudio_symbol_analysis(
            ws_id,
            file_path,
            lang,
            symbol_source.as_deref(),
            symbol_key,
            symbol_name,
            &symbol_kind,
            args.selection_line,
            args.selection_column,
            &args.range,
            answer_md_cleaned.trim(),
            model_ref,
            args.latency_ms,
            health_level,
            diagnosis_verdict,
            diagnosis_confidence,
            diagnosis_summary,
            diagnosis_errors,
            diagnosis_defects,
            diagnosis_improvements,
            diagnosis_json.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

// ============================================================================
// Workstudio Folder Analysis (Explorer)
// ============================================================================

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetWorkstudioFolderAnalysisArgs {
    pub workstudio_id: String,
    pub folder_path: String,
}

#[tauri::command]
pub async fn get_workstudio_folder_analysis(
    args: GetWorkstudioFolderAnalysisArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioFolderAnalysis>, String> {
    let ws_id = args.workstudio_id.trim();
    let folder_path = args.folder_path.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if folder_path.is_empty() {
        return Err("folderPath 为空".to_string());
    }

    async_db::with_db(db.inner(), "get_workstudio_folder_analysis", |db| {
        db.get_workstudio_folder_analysis(ws_id, folder_path)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkstudioFolderAnalysisSummariesArgs {
    pub workstudio_id: String,
}

/// List lightweight folder analysis summaries for a workstudio.
///
/// Used by Workstudio Explorer to colorize folders without loading full markdown.
#[tauri::command]
pub async fn list_workstudio_folder_analysis_summaries(
    args: ListWorkstudioFolderAnalysisSummariesArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<WorkstudioFolderAnalysisSummary>, String> {
    let ws_id = args.workstudio_id.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "list_workstudio_folder_analysis_summaries",
        |db| db.list_workstudio_folder_analysis_summaries(ws_id),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkstudioFolderAnalysisArgs {
    pub workstudio_id: String,
    pub folder_path: String,
}

#[tauri::command]
pub async fn delete_workstudio_folder_analysis(
    args: DeleteWorkstudioFolderAnalysisArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let ws_id = args.workstudio_id.trim();
    let folder_path = args.folder_path.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if folder_path.is_empty() {
        return Err("folderPath 为空".to_string());
    }

    async_db::with_db(db.inner(), "delete_workstudio_folder_analysis", |db| {
        db.delete_workstudio_folder_analysis(ws_id, folder_path)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkstudioFolderAnalysisArgs {
    pub workstudio_id: String,
    pub folder_path: String,
    pub answer_md: String,
    pub model_ref: Option<String>,
    pub latency_ms: Option<u64>,
}

#[tauri::command]
pub async fn save_workstudio_folder_analysis(
    args: SaveWorkstudioFolderAnalysisArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<WorkstudioFolderAnalysis, String> {
    let ws_id = args.workstudio_id.trim();
    let folder_path = args.folder_path.trim();
    let answer_md = args.answer_md.trim();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if folder_path.is_empty() {
        return Err("folderPath 为空".to_string());
    }
    if answer_md.is_empty() {
        return Err("answerMd 为空".to_string());
    }

    let model_ref = args
        .model_ref
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let (diagnosis, diagnosis_json, answer_md_cleaned) = try_extract_folder_diagnosis_v1(answer_md);
    let health_level = diagnosis
        .as_ref()
        .and_then(|d| d.health_level)
        .filter(|v| (1..=10).contains(v));
    let diagnosis_verdict = diagnosis
        .as_ref()
        .and_then(|d| d.verdict.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let diagnosis_confidence = diagnosis
        .as_ref()
        .and_then(|d| d.confidence)
        .map(|v| v.max(0.0).min(1.0));
    let diagnosis_summary = diagnosis
        .as_ref()
        .and_then(|d| d.summary.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let diagnosis_errors = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.errors);
    let diagnosis_defects = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.defects);
    let diagnosis_improvements = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.improvements);

    async_db::with_db(db.inner(), "save_workstudio_folder_analysis", |db| {
        db.upsert_workstudio_folder_analysis(
            ws_id,
            folder_path,
            answer_md_cleaned.trim(),
            model_ref,
            args.latency_ms,
            health_level,
            diagnosis_verdict,
            diagnosis_confidence,
            diagnosis_summary,
            diagnosis_errors,
            diagnosis_defects,
            diagnosis_improvements,
            diagnosis_json.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

// ============================================================================
// Workstudio Chat With（index-backed history）
// ============================================================================

pub const WORKSTUDIO_CHAT_WITH_INDEX_CHANGED_EVENT: &str = "workstudio:chat_with_index_changed";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkstudioChatWithIndexChangedEvent {
    workstudio_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

fn emit_workstudio_chat_with_index_changed(
    app_handle: &tauri::AppHandle,
    workstudio_id: &str,
    file_path: Option<&str>,
    conversation_id: Option<&str>,
) {
    use tauri::Emitter;

    let _ = app_handle.emit(
        WORKSTUDIO_CHAT_WITH_INDEX_CHANGED_EVENT,
        WorkstudioChatWithIndexChangedEvent {
            workstudio_id: workstudio_id.to_string(),
            file_path: file_path.map(|value| value.to_string()),
            conversation_id: conversation_id.map(|value| value.to_string()),
        },
    );
}

fn build_chat_with_scope_label(
    file_path: &str,
    range: Option<&CodeSnippetRange>,
    preferred: Option<&str>,
) -> String {
    let preferred = preferred.unwrap_or("").trim();
    if !preferred.is_empty() {
        return preferred.to_string();
    }

    let base = std::path::Path::new(file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or("选中代码");

    match range {
        Some(range) if range.start_line > 0 && range.end_line > 0 => {
            if range.start_line == range.end_line {
                format!("{} · L{}", base, range.start_line)
            } else {
                format!("{} · L{}-{}", base, range.start_line, range.end_line)
            }
        }
        _ => base.to_string(),
    }
}

fn derive_chat_with_scope_from_message(message: &Message) -> Option<WorkstudioChatWithScope> {
    for part in &message.content_parts {
        if let ContentPart::CodeSnippet {
            label,
            language_id,
            file_path,
            range,
            ..
        } = part
        {
            let file_path = file_path.as_deref().unwrap_or("").trim().to_string();
            if file_path.is_empty() {
                continue;
            }
            let range = range.clone();
            return Some(WorkstudioChatWithScope {
                file_path: file_path.clone(),
                language_id: language_id.as_deref().unwrap_or("").trim().to_string(),
                label: build_chat_with_scope_label(&file_path, range.as_ref(), Some(label)),
                range,
            });
        }
    }
    None
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertWorkstudioChatWithIndexArgs {
    pub workstudio_id: String,
    pub conversation_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    pub agent_name: String,
    pub model_ref: Option<String>,
    pub file_path: String,
    pub language_id: String,
    pub label: Option<String>,
    pub range: Option<CodeSnippetRange>,
}

#[tauri::command]
pub async fn upsert_workstudio_chat_with_index(
    args: UpsertWorkstudioChatWithIndexArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let workstudio_id = args.workstudio_id.trim().to_string();
    let conversation_id = args.conversation_id.trim().to_string();
    let user_message_id = args.user_message_id.trim().to_string();
    let assistant_message_id = args.assistant_message_id.trim().to_string();
    let agent_name = args.agent_name.trim().to_string();

    if workstudio_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if conversation_id.is_empty() {
        return Err("conversationId 为空".to_string());
    }
    if user_message_id.is_empty() {
        return Err("userMessageId 为空".to_string());
    }
    if assistant_message_id.is_empty() {
        return Err("assistantMessageId 为空".to_string());
    }
    if agent_name.is_empty() {
        return Err("agentName 为空".to_string());
    }

    let conversation_id_for_event = conversation_id.clone();
    let file_path_for_event =
        async_db::with_db(db.inner(), "upsert_workstudio_chat_with_index", |db| {
            let user_message = db.get_message(&conversation_id, &user_message_id)?;
            let assistant_message = db.get_message(&conversation_id, &assistant_message_id)?;
            let derived_scope = derive_chat_with_scope_from_message(&user_message);

            let range = args
                .range
                .clone()
                .or_else(|| derived_scope.as_ref().and_then(|scope| scope.range.clone()));
            let file_path = {
                let value = args.file_path.trim();
                if !value.is_empty() {
                    value.to_string()
                } else {
                    derived_scope
                        .as_ref()
                        .map(|scope| scope.file_path.clone())
                        .unwrap_or_default()
                }
            };
            if file_path.trim().is_empty() {
                return Err(crate::storage::StorageError::Database(
                    "filePath 为空".to_string(),
                ));
            }

            let language_id = {
                let value = args.language_id.trim();
                if !value.is_empty() {
                    value.to_string()
                } else {
                    derived_scope
                        .as_ref()
                        .map(|scope| scope.language_id.clone())
                        .unwrap_or_default()
                }
            };
            let label = build_chat_with_scope_label(
                &file_path,
                range.as_ref(),
                args.label
                    .as_deref()
                    .or_else(|| derived_scope.as_ref().map(|scope| scope.label.as_str())),
            );
            let model_ref = args
                .model_ref
                .clone()
                .and_then(|value| {
                    let trimmed = value.trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                })
                .or_else(|| {
                    assistant_message
                        .meta
                        .as_ref()
                        .and_then(|meta| meta.model.clone())
                });
            let latency_ms = assistant_message
                .meta
                .as_ref()
                .and_then(|meta| meta.duration);

            let entry = WorkstudioChatWithIndexEntry {
                id: assistant_message_id.clone(),
                workstudio_id: workstudio_id.clone(),
                conversation_id: conversation_id.clone(),
                user_message_id: user_message_id.clone(),
                assistant_message_id: assistant_message_id.clone(),
                agent_name: agent_name.clone(),
                model_ref,
                file_path: file_path.clone(),
                language_id,
                label,
                range,
                latency_ms,
                created_at: user_message.created_at,
                updated_at: assistant_message.created_at,
            };

            db.upsert_workstudio_chat_with_index(&entry)?;
            Ok(file_path)
        })
        .await
        .map_err(|e| e.to_string())?;

    emit_workstudio_chat_with_index_changed(
        &app_handle,
        &workstudio_id,
        Some(&file_path_for_event),
        Some(&conversation_id_for_event),
    );
    Ok(())
}

#[tauri::command]
pub async fn get_workstudio_chat_with_scope_for_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioChatWithScope>, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err("conversationId 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "get_workstudio_chat_with_scope_for_conversation",
        |db| db.get_workstudio_chat_with_scope_for_conversation(conversation_id),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindWorkstudioChatWithThreadArgs {
    pub workstudio_id: String,
    pub agent_name: String,
    pub file_path: String,
    #[serde(default)]
    pub language_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub range: Option<CodeSnippetRange>,
}

#[tauri::command]
pub async fn find_workstudio_chat_with_thread(
    args: FindWorkstudioChatWithThreadArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioChatWithThread>, String> {
    let lookup = WorkstudioChatWithThreadLookup {
        workstudio_id: args.workstudio_id.trim().to_string(),
        agent_name: args.agent_name.trim().to_string(),
        file_path: args.file_path.trim().to_string(),
        language_id: args.language_id.trim().to_string(),
        label: args.label.trim().to_string(),
        range: args.range,
    };

    if lookup.workstudio_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if lookup.agent_name.is_empty() {
        return Err("agentName 为空".to_string());
    }
    if lookup.file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }

    async_db::with_db(db.inner(), "find_workstudio_chat_with_thread", |db| {
        db.find_workstudio_chat_with_thread(&lookup)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkstudioChatWithThreadArgs {
    pub thread: WorkstudioChatWithThread,
}

#[tauri::command]
pub async fn save_workstudio_chat_with_thread(
    args: SaveWorkstudioChatWithThreadArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<WorkstudioChatWithThread, String> {
    if args.thread.workstudio_id.trim().is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if args.thread.conversation_id.trim().is_empty() {
        return Err("conversationId 为空".to_string());
    }
    if args.thread.file_path.trim().is_empty() {
        return Err("filePath 为空".to_string());
    }

    let saved = async_db::with_db(db.inner(), "save_workstudio_chat_with_thread", |db| {
        db.save_workstudio_chat_with_thread(&args.thread)
    })
    .await
    .map_err(|e| e.to_string())?;

    emit_workstudio_chat_with_index_changed(
        &app_handle,
        &saved.workstudio_id,
        Some(&saved.file_path),
        Some(&saved.conversation_id),
    );
    Ok(saved)
}

#[tauri::command]
pub async fn get_workstudio_chat_with_thread_by_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioChatWithThread>, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err("conversationId 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "get_workstudio_chat_with_thread_by_conversation",
        |db| db.get_workstudio_chat_with_thread_by_conversation(conversation_id),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkstudioChatWithThreadsForFileArgs {
    pub workstudio_id: String,
    pub file_path: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[tauri::command]
pub async fn list_workstudio_chat_with_threads_for_file(
    args: ListWorkstudioChatWithThreadsForFileArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<WorkstudioChatWithThread>, String> {
    let ws_id = args.workstudio_id.trim();
    let file_path = args.file_path.trim();
    let limit = args.limit.unwrap_or(200) as usize;

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "list_workstudio_chat_with_threads_for_file",
        |db| db.list_workstudio_chat_with_threads_for_file(ws_id, file_path, limit),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchWorkstudioChatWithThreadForConversationArgs {
    pub conversation_id: String,
    #[serde(default)]
    pub model_ref: Option<String>,
}

#[tauri::command]
pub async fn touch_workstudio_chat_with_thread_for_conversation(
    args: TouchWorkstudioChatWithThreadForConversationArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioChatWithThread>, String> {
    let conversation_id = args.conversation_id.trim().to_string();
    if conversation_id.is_empty() {
        return Err("conversationId 为空".to_string());
    }

    let touched = async_db::with_db(
        db.inner(),
        "touch_workstudio_chat_with_thread_for_conversation",
        |db| {
            db.touch_workstudio_chat_with_thread_for_conversation(
                &conversation_id,
                args.model_ref.as_deref(),
            )
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    if let Some(thread) = touched.as_ref() {
        emit_workstudio_chat_with_index_changed(
            &app_handle,
            &thread.workstudio_id,
            Some(&thread.file_path),
            Some(&thread.conversation_id),
        );
    }

    Ok(touched)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkstudioChatWithThreadArgs {
    pub thread_id: String,
    #[serde(default)]
    pub workstudio_id: Option<String>,
}

#[tauri::command]
pub async fn delete_workstudio_chat_with_thread(
    args: DeleteWorkstudioChatWithThreadArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let thread_id = args.thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Err("threadId 为空".to_string());
    }

    async_db::with_db(db.inner(), "delete_workstudio_chat_with_thread", |db| {
        db.delete_workstudio_chat_with_thread(&thread_id)
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(workstudio_id) = args
        .workstudio_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        emit_workstudio_chat_with_index_changed(&app_handle, workstudio_id, None, None);
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkstudioChatWithRecordsForFileArgs {
    pub workstudio_id: String,
    pub file_path: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[tauri::command]
pub async fn list_workstudio_chat_with_records_for_file(
    args: ListWorkstudioChatWithRecordsForFileArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<WorkstudioChatWithRecord>, String> {
    let ws_id = args.workstudio_id.trim();
    let file_path = args.file_path.trim();
    let limit = args.limit.unwrap_or(200) as usize;

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "list_workstudio_chat_with_records_for_file",
        |db| db.list_workstudio_chat_with_records_for_file(ws_id, file_path, limit),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkstudioChatWithRecordsForFileArgs {
    pub workstudio_id: String,
    pub file_path: String,
}

#[tauri::command]
pub async fn delete_workstudio_chat_with_records_for_file(
    args: DeleteWorkstudioChatWithRecordsForFileArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let ws_id = args.workstudio_id.trim().to_string();
    let file_path = args.file_path.trim().to_string();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if file_path.is_empty() {
        return Err("filePath 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "delete_workstudio_chat_with_records_for_file",
        |db| db.delete_workstudio_chat_with_records_for_file(&ws_id, &file_path),
    )
    .await
    .map_err(|e| e.to_string())?;

    emit_workstudio_chat_with_index_changed(&app_handle, &ws_id, Some(&file_path), None);
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkstudioChatWithFileSummariesArgs {
    pub workstudio_id: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[tauri::command]
pub async fn list_workstudio_chat_with_file_summaries(
    args: ListWorkstudioChatWithFileSummariesArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<WorkstudioChatWithFileSummary>, String> {
    let ws_id = args.workstudio_id.trim();
    let limit = args.limit.unwrap_or(5000) as usize;

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }

    async_db::with_db(
        db.inner(),
        "list_workstudio_chat_with_file_summaries",
        |db| db.list_workstudio_chat_with_file_summaries(ws_id, limit),
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkstudioChatWithRecordArgs {
    pub workstudio_id: String,
    pub id: String,
}

#[tauri::command]
pub async fn delete_workstudio_chat_with_record(
    args: DeleteWorkstudioChatWithRecordArgs,
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let ws_id = args.workstudio_id.trim().to_string();
    let id = args.id.trim().to_string();

    if ws_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }
    if id.is_empty() {
        return Err("id 为空".to_string());
    }

    async_db::with_db(db.inner(), "delete_workstudio_chat_with_record", |db| {
        db.delete_workstudio_chat_with_record(&ws_id, &id)
    })
    .await
    .map_err(|e| e.to_string())?;

    emit_workstudio_chat_with_index_changed(&app_handle, &ws_id, None, None);
    Ok(())
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

    let (diagnosis, diagnosis_json, answer_md_cleaned) =
        try_extract_symbol_diagnosis_v1(&answer_md);
    let health_level = diagnosis
        .as_ref()
        .and_then(|d| d.health_level)
        .filter(|v| (1..=10).contains(v));
    let diagnosis_verdict = diagnosis
        .as_ref()
        .and_then(|d| d.verdict.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let diagnosis_confidence = diagnosis
        .as_ref()
        .and_then(|d| d.confidence)
        .map(|v| v.max(0.0).min(1.0));
    let diagnosis_summary = diagnosis
        .as_ref()
        .and_then(|d| d.summary.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let diagnosis_errors = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.errors);
    let diagnosis_defects = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.defects);
    let diagnosis_improvements = diagnosis
        .as_ref()
        .and_then(|d| d.counts.as_ref())
        .and_then(|c| c.improvements);

    let analysis = async_db::with_db(db.inner(), "ai_analyze_workstudio_symbol:upsert", |db| {
        db.upsert_workstudio_symbol_analysis(
            ws_id,
            file_path,
            lang,
            None,
            symbol_key,
            symbol_name,
            &symbol_kind,
            args.selection_line,
            args.selection_column,
            &args.range,
            answer_md_cleaned.trim(),
            Some(model_ref),
            Some(latency_ms),
            health_level,
            diagnosis_verdict,
            diagnosis_confidence,
            diagnosis_summary,
            diagnosis_errors,
            diagnosis_defects,
            diagnosis_improvements,
            diagnosis_json.as_deref(),
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

### 文件引用（必须严格遵守｜可点击跳转）
- 这是“代码问题域”的强约束：当你在讨论代码/报错/定位/调用链/实现细节/引用关系时，所有文件引用都必须使用**行内代码**的“路径格式”，系统会据此解析为可点击跳转；若用其它写法通常会不可点击。
- 普通网页 URL 可以使用 `[文本](url)`；但**文件引用禁止使用** Markdown 链接语法（例如 `[label](path)`），也不要输出 `file://` / `vscode://` 之类的 URI。
- 唯一允许/推荐的写法（请严格遵守）：`相对路径:行`、`相对路径:行:列`、`相对路径#L行`、`相对路径#L行C列`
  - ✅ 示例：`tauri-ai/src-tauri/src/prompts.rs:123`、`tauri-ai/apps/desktop/src/components/Chat/ChatView.tsx#L771`
  - ❌ 禁止：`(line 59)`、单独写 `:59`、或只写 `prompts.rs:123`（缺目录）
- 优先使用“相对主工作区根目录的相对路径（包含子目录）”；只有在必要时才使用绝对路径（Windows 示例：`C:\repo\project\main.rs:12:5`）。
- 若仓库中存在嵌套子项目，路径仍必须相对 `projectRoot` 输出，不要缩成相对子项目根目录；例如应写 `tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`，不要写 `apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`。
- 拿不到行号时不要猜：先用工具或上下文定位到行号，再输出引用。
- 如需引用一段范围（可选）：`path#L10-L20` 或 `path:10-20`。

### Mermaid 图中的文件引用（必须可点击）
当你输出 Mermaid 图并希望用户能“点击节点跳到代码位置”时：
- 节点文本里写 `path:line` 只是展示，不会自动变成可点击跳转。
- 必须使用 Mermaid 的 `click` 指令绑定可点击的 href（建议同时把 token 作为 tooltip）：
```mermaid
flowchart TD
  R["Request Handler"]
  click R href "tauri-ai/src-tauri/src/prompts.rs:123" "tauri-ai/src-tauri/src/prompts.rs:123"
```
- 美观建议：节点标签只写简短职责名；把完整 `path:line` 放到 `click` 的 tooltip（第三个参数）里；正文也应列出关键节点对应的文件引用。

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
        out.push_str(
            "fileReferenceRule: 所有文件引用都必须相对 projectRoot；如果仓库内存在嵌套子项目，请保留最外层子目录前缀，不要擅自改成相对子项目根目录的写法。\n",
        );
        out.push_str(
            "fileReferenceExample: 正确 `tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`；错误 `apps/desktop/src/hooks/useKeyboardShortcuts.ts:46`。\n",
        );
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
