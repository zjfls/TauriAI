//! Tauri commands: run_task / abort_run
//!
//! 说明：
//! - Command 层只做参数接入与依赖注入
//! - 运行时（Task/Turn/ReAct/事件流）封装在 `crate::runtime::task_runner`
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::config::ConfigManager;
use crate::errors::SerializableError;
use crate::models::ContentPart;
use crate::runtime::approvals::ApprovalDecision;
use crate::runtime::task_runner::{run_task as run_task_impl, RunTaskInput};
use crate::runtime::RunState;
use crate::storage::Database;

#[tauri::command]
pub async fn run_task(
    app: AppHandle,
    conversation_id: String,
    message_id: Option<String>,
    content: String,
    content_parts: Option<Vec<ContentPart>>,
    agent_name: Option<String>,
    model_ref: Option<String>,
    thinking: Option<serde_json::Value>,
    web_search_enabled: Option<bool>,
    debug_mode: Option<bool>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), SerializableError> {
    run_task_impl(
        app,
        RunTaskInput {
            conversation_id,
            message_id,
            content,
            content_parts,
            agent_name,
            model_ref,
            thinking,
            web_search_enabled,
            debug_mode,
        },
        db.inner().clone(),
        config_manager.inner().clone(),
        run_state.inner().clone(),
    )
    .await
}

#[tauri::command]
pub async fn abort_run(
    conversation_id: String,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    // Best-effort：abort + wait，确保 run fully 退出（避免并发写入导致状态错乱）
    run_state.abort_and_wait(&conversation_id, 5_000).await;
    Ok(())
}

#[tauri::command]
pub async fn respond_approval(
    conversation_id: String,
    request_id: String,
    decision: ApprovalDecision,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    if run_state
        .resolve_approval(&conversation_id, &request_id, decision)
        .await
    {
        Ok(())
    } else {
        Err("没有找到待审批的请求（可能已超时/已处理/任务已结束）".to_string())
    }
}
