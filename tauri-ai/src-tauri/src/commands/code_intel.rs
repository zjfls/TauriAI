//! Code intelligence commands (LSP / AST)
//!
//! 说明：
//! - 这些命令面向前端 Monaco Bridge：后端负责 LSP 进程管理与 JSON-RPC 通信。
//! - 目前优先覆盖 Workstudio 的核心能力：定义/引用/类型定义/悬停/补全/诊断。

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::code_intel::lsp::LspManager;
use crate::code_intel::lsp::resolve_lsp_spawn_program;
use crate::code_intel::ast::{AstDocumentSymbolsArgs, AstSymbol};
use crate::code_intel::types::{LspLaunchConfig, LspServerStatus};
use crate::config::ConfigManager;
use crate::models::Workstudio;
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
