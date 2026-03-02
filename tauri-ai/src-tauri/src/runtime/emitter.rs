use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use super::events::{RunEvent, RunEventPayload, RUN_EVENT_NAME};

/// `run:event` 的统一发射器：集中管理 seq/timestamp，避免散落在各处。
pub struct RunEmitter {
    target: RunEmitterTarget,
    conversation_id: String,
    run_id: String,
    seq: u64,
}

pub type RunEventCallback = Arc<dyn Fn(RunEventPayload) + Send + Sync>;

enum RunEmitterTarget {
    Tauri(AppHandle),
    Callback(RunEventCallback),
}

impl RunEmitter {
    pub fn new(
        app: AppHandle,
        conversation_id: impl Into<String>,
        run_id: impl Into<String>,
    ) -> Self {
        Self {
            target: RunEmitterTarget::Tauri(app),
            conversation_id: conversation_id.into(),
            run_id: run_id.into(),
            seq: 0,
        }
    }

    pub fn new_with_callback(
        conversation_id: impl Into<String>,
        run_id: impl Into<String>,
        callback: RunEventCallback,
    ) -> Self {
        Self {
            target: RunEmitterTarget::Callback(callback),
            conversation_id: conversation_id.into(),
            run_id: run_id.into(),
            seq: 0,
        }
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn emit(&mut self, event: RunEvent) {
        self.seq = self.seq.saturating_add(1);
        let payload = RunEventPayload {
            conversation_id: self.conversation_id.clone(),
            run_id: self.run_id.clone(),
            seq: self.seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event,
        };

        match &self.target {
            RunEmitterTarget::Tauri(app) => {
                let _ = app.emit(RUN_EVENT_NAME, payload);
            }
            RunEmitterTarget::Callback(callback) => {
                callback(payload);
            }
        }
    }
}
