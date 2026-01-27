use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// User decision for a tool approval prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    ApprovedForSession,
    Denied,
    Abort,
}

/// In-memory (per conversation) approval cache.
///
/// This is intentionally ephemeral (not persisted to DB). It exists to support
/// "approve for session" UX similar to Codex.
#[derive(Debug, Default)]
pub struct ApprovalStore {
    map: HashMap<String, ApprovalDecision>,
}

impl ApprovalStore {
    pub fn get(&self, key: &str) -> Option<ApprovalDecision> {
        self.map.get(key).copied()
    }

    pub fn put(&mut self, key: impl Into<String>, decision: ApprovalDecision) {
        self.map.insert(key.into(), decision);
    }

    pub fn is_approved_for_session(&self, key: &str) -> bool {
        matches!(self.get(key), Some(ApprovalDecision::ApprovedForSession))
    }
}

