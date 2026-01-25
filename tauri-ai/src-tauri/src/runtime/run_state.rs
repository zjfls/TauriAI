//! Run runtime shared state
//!
//! 说明：
//! - `run_task` 属于长耗时命令（可能包含多次模型请求/多 Turn 循环）
//! - 前端可能会在中途触发：
//!   - Stop：仅停止生成（可能保留部分输出）
//!   - 撤回/删除：需要先终止正在进行的 run，再做 DB 删除，避免“删完又被写回”导致重启后消息错乱
//! - 因此这里提供：
//!   - abort sender：用于通知 `run_task` 终止
//!   - completion notify：用于等待 `run_task` 完整退出（包含收尾 DB 写入）
use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, Notify, RwLock};

use super::tools::services::PtySessionInfo;
use super::tools::ToolServices;

pub struct RunState {
    pub abort_senders: RwLock<HashMap<String, mpsc::Sender<()>>>,
    run_notifiers: RwLock<HashMap<String, Arc<Notify>>>,
    tool_services: RwLock<HashMap<String, Arc<ToolServices>>>,
}

impl RunState {
    pub fn new() -> Self {
        Self {
            abort_senders: RwLock::new(HashMap::new()),
            run_notifiers: RwLock::new(HashMap::new()),
            tool_services: RwLock::new(HashMap::new()),
        }
    }

    /// Register a running run for a conversation.
    /// Returns a notify handle that will be triggered when the run finishes.
    pub async fn register_run(&self, conversation_id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        let mut notifiers = self.run_notifiers.write().await;
        notifiers.insert(conversation_id.to_string(), notify.clone());
        notify
    }

    /// Mark a run finished and wake up any waiters.
    pub async fn finish_run(&self, conversation_id: &str) {
        let notify = {
            let mut notifiers = self.run_notifiers.write().await;
            notifiers.remove(conversation_id)
        };
        if let Some(n) = notify {
            n.notify_waiters();
        }
    }

    pub async fn get_tool_services(&self, conversation_id: &str) -> Arc<ToolServices> {
        let mut services = self.tool_services.write().await;
        if let Some(existing) = services.get(conversation_id) {
            return Arc::clone(existing);
        }
        let created = Arc::new(ToolServices::default());
        services.insert(conversation_id.to_string(), Arc::clone(&created));
        created
    }

    pub async fn list_pty_sessions(&self, conversation_id: &str) -> Vec<PtySessionInfo> {
        let services = self.tool_services.read().await;
        let Some(tool_services) = services.get(conversation_id) else {
            return Vec::new();
        };
        tool_services.pty.list_sessions(conversation_id).await
    }

    pub async fn close_pty_session(&self, conversation_id: &str, session_id: i32) -> bool {
        let services = self.tool_services.read().await;
        let Some(tool_services) = services.get(conversation_id) else {
            return false;
        };
        if let Some(meta) = tool_services.pty.get_session_meta(session_id).await {
            if meta.conversation_id != conversation_id {
                return false;
            }
        }
        tool_services.pty.close_session(session_id).await
    }

    pub async fn cleanup_task_sessions(
        &self,
        conversation_id: &str,
        task_id: &str,
        keep_conversation_sessions: bool,
    ) {
        let services = self.tool_services.read().await;
        let Some(tool_services) = services.get(conversation_id) else {
            return;
        };

        let _ = tool_services
            .pty
            .close_task_sessions(conversation_id, task_id)
            .await;

        if !keep_conversation_sessions {
            let _ = tool_services
                .pty
                .close_conversation_sessions(conversation_id)
                .await;
        }
    }

    /// Abort a running run and (best-effort) wait for it to fully exit.
    ///
    /// Notes:
    /// - If the conversation has no active run, this is a no-op.
    /// - Waiting is bounded by `timeout_ms` to avoid hanging the command.
    pub async fn abort_and_wait(&self, conversation_id: &str, timeout_ms: u64) {
        // 1) Send abort signal (if run exists)
        if let Some(sender) = self.abort_senders.read().await.get(conversation_id) {
            let _ = sender.send(()).await;
        }

        // 2) Wait for run completion (if notifier exists)
        if let Some(notify) = self.run_notifiers.read().await.get(conversation_id).cloned() {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                notify.notified(),
            )
            .await;
        }
    }
}

impl Default for RunState {
    fn default() -> Self {
        Self::new()
    }
}
