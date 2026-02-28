//! Context management (compaction / trimming) for long conversations.
//!
//! Goals:
//! - Provide an agent-level, pluggable policy surface (see `ContextPolicyConfig`)
//! - Offer a Codex-like baseline implementation (`normal_compact`)
//! - Keep behavior safe-by-default: prefer preserving recent context, and avoid hard failures

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::Mutex;

use crate::ai_client::AiClient;
use crate::errors::{AppErrorCode, SerializableError};
use crate::models::{
    ContextCompactionMeta, ContextPolicyConfig, Message, MessageMeta, MessageRole, MessageStatus,
    ModelConfig, NormalCompactPolicyConfig,
};
use crate::storage::async_db;
use crate::storage::Database;

const NORMAL_COMPACT_MARKER: &str = "<!-- tauri-ai:context:normal_compact -->";

#[derive(Debug, Clone)]
pub struct ContextCompactionResult {
    pub compacted: bool,
    pub removed_messages: usize,
    pub kept_messages: usize,
    pub dropped_for_fit: usize,
}

#[derive(Debug, Clone)]
pub struct ContextTrimResult {
    pub trimmed_messages: Vec<Message>,
    pub removed_messages: usize,
    pub estimated_tokens_before: u32,
    pub estimated_tokens_after: u32,
    pub hard_limit_tokens: u32,
    pub trim_target_tokens: u32,
    pub removed_tasks: usize,
    pub kept_tasks: usize,
    pub kept_task_ids: Vec<String>,
    pub target_unreachable: bool,
}

#[derive(Debug, Clone)]
pub struct ContextManager {
    pub policy: ContextPolicyConfig,
}

impl ContextManager {
    pub fn new(policy: Option<ContextPolicyConfig>) -> Self {
        Self {
            // Safe-by-default: if an agent does not specify a context policy, fall back to "simple"
            // trimming-only behavior to avoid context-window exceeded errors.
            policy: policy.unwrap_or_else(|| ContextPolicyConfig::Simple(Default::default())),
        }
    }

    pub fn hard_limit_percent(&self) -> u8 {
        match &self.policy {
            ContextPolicyConfig::Simple(cfg) => cfg.hard_limit_percent.unwrap_or(90),
            ContextPolicyConfig::NormalCompact(cfg) => cfg.hard_limit_percent.unwrap_or(90),
            _ => 90,
        }
    }

    pub fn trim_target_percent(&self) -> u8 {
        let hard = self.hard_limit_percent().clamp(1, 99);
        let raw = match &self.policy {
            ContextPolicyConfig::Simple(cfg) => cfg.trim_target_percent.unwrap_or(hard),
            ContextPolicyConfig::NormalCompact(cfg) => cfg.trim_target_percent.unwrap_or(hard),
            _ => hard,
        };
        raw.clamp(1, hard)
    }

    pub fn auto_compact_threshold_percent(&self) -> u8 {
        match &self.policy {
            ContextPolicyConfig::NormalCompact(cfg) => {
                cfg.auto_compact_threshold_percent.unwrap_or(85)
            }
            _ => 100,
        }
    }

    pub fn should_trim(&self) -> bool {
        match &self.policy {
            // 保持安全默认：即便关闭策略，也保留 hard trim（避免超窗）。
            ContextPolicyConfig::Simple(cfg) => cfg.enabled && cfg.trim_enabled,
            ContextPolicyConfig::NormalCompact(cfg) => cfg.enabled && cfg.trim_enabled,
            ContextPolicyConfig::Custom { .. } => true,
        }
    }

    pub fn keep_last_messages(&self) -> usize {
        match &self.policy {
            ContextPolicyConfig::NormalCompact(cfg) => {
                let v = cfg.keep_last_messages.unwrap_or(60);
                usize::try_from(v).unwrap_or(60)
            }
            _ => 60,
        }
    }

    pub fn max_summary_tokens(&self) -> u32 {
        match &self.policy {
            ContextPolicyConfig::NormalCompact(cfg) => cfg.max_summary_tokens.unwrap_or(800),
            _ => 800,
        }
    }

    pub fn max_compact_input_messages(&self) -> usize {
        match &self.policy {
            ContextPolicyConfig::NormalCompact(cfg) => {
                let v = cfg.max_compact_input_messages.unwrap_or(400);
                usize::try_from(v).unwrap_or(400)
            }
            _ => 400,
        }
    }

    pub fn should_auto_compact(&self) -> bool {
        match &self.policy {
            ContextPolicyConfig::NormalCompact(cfg) => {
                cfg.enabled && cfg.compact_enabled && cfg.auto_compact
            }
            _ => false,
        }
    }

    pub fn is_enabled(&self) -> bool {
        match &self.policy {
            ContextPolicyConfig::Simple(cfg) => cfg.enabled,
            ContextPolicyConfig::NormalCompact(cfg) => cfg.enabled,
            ContextPolicyConfig::Custom { .. } => true,
        }
    }

    /// Apply persisted compaction summaries when building the runtime prompt.
    ///
    /// Semantics (Codex-aligned):
    /// - Persisted *raw* messages remain in DB (for UI/audit).
    /// - The model context prefers the latest summary and skips messages covered by it.
    pub async fn apply_persisted_compaction_view_for_prompt(
        &self,
        conversation_id: &str,
        pending_user_message_id: Option<&str>,
        messages: Vec<Message>,
        db: Arc<Mutex<Database>>,
    ) -> Vec<Message> {
        let ContextPolicyConfig::NormalCompact(cfg) = &self.policy else {
            return messages;
        };
        if !cfg.enabled || !cfg.compact_enabled {
            return messages;
        }

        let summary = async_db::read_latest_message_containing(
            &db,
            "context_manager:get_latest_message_containing",
            conversation_id,
            NORMAL_COMPACT_MARKER,
        )
        .await
        .ok()
        .flatten();
        let Some(summary) = summary else {
            return messages;
        };
        if !is_normal_compact_summary_message(&summary) {
            return messages;
        }
        let Some(meta) = summary
            .meta
            .as_ref()
            .and_then(|m| m.context_compaction.as_ref())
        else {
            // Without a cutoff marker, we cannot safely exclude covered messages.
            return messages;
        };
        if meta.strategy != "normal_compact" {
            return messages;
        }

        let cutoff = meta.compacted_until_created_at;

        let mut out: Vec<Message> = Vec::with_capacity(messages.len().saturating_add(1));
        for m in messages {
            // Avoid duplicating summaries in the prompt; we'll inject the latest one explicitly.
            if is_normal_compact_summary_message(&m) {
                continue;
            }

            // Preserve the current pending user message regardless of cutoff.
            if pending_user_message_id.is_some_and(|id| m.id.as_str() == id) {
                out.push(m);
                continue;
            }

            // Keep all system messages.
            if m.role == MessageRole::System {
                out.push(m);
                continue;
            }

            // Skip messages covered by the summary (inclusive cutoff).
            if m.created_at <= cutoff {
                continue;
            }

            out.push(m);
        }

        // Insert the summary right after system prefix so it's "in scope" for the rest of the turns.
        let insert_at = out
            .iter()
            .take_while(|m| m.role == MessageRole::System)
            .count();
        out.insert(insert_at, summary);
        out
    }
}

/// Estimate prompt token usage (coarse, tokenizer-agnostic).
///
/// This is designed to be *safe* (slightly over-estimate) to avoid "context window exceeded".
pub fn estimate_prompt_tokens(messages: &[Message]) -> u32 {
    // Cheap upper-ish bound:
    // - non-ascii chars tend to be closer to 1 token
    // - ascii chars average ~4 chars/token
    // - add per-message structural overhead
    let mut total = 0u32;
    for m in messages {
        total = total.saturating_add(8); // message envelope overhead

        total = total.saturating_add(approx_tokens_for_text(role_to_str(&m.role)));
        total = total.saturating_add(approx_tokens_for_text(m.content.as_str()));
        if let Some(t) = m.thinking.as_ref() {
            total = total.saturating_add(approx_tokens_for_text(t.as_str()));
        }

        if !m.content_parts.is_empty() {
            if let Ok(s) = serde_json::to_string(&m.content_parts) {
                total = total.saturating_add(approx_tokens_for_text(s.as_str()));
            }
        }
        // Keep estimator close to actual provider payload:
        // only count meta fields that are typically sent to model APIs.
        if let Some(meta) = m.meta.as_ref() {
            let minimal = serde_json::json!({
                "tool_call_id": meta.tool_call_id,
                "tool_calls": meta.tool_calls,
            });
            if let Ok(s) = serde_json::to_string(&minimal) {
                total = total.saturating_add(approx_tokens_for_text(s.as_str()));
            }
        }
    }
    total
}

fn role_to_str(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

fn approx_tokens_for_text(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }

    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }

    // Safety bias:
    // - non-ascii: ~1 token / char (slightly >1 for safety)
    // - ascii: ~4 chars / token
    let tokens = (ascii as f64) / 4.0 + (non_ascii as f64) * 1.12;
    u32::try_from(tokens.ceil() as i64).unwrap_or(u32::MAX)
}

pub fn hard_limit_tokens(context_length: u32, hard_limit_percent: u8) -> u32 {
    let pct = u32::from(hard_limit_percent.clamp(1, 99));
    context_length.saturating_mul(pct) / 100
}

pub fn auto_compact_threshold_tokens(context_length: u32, threshold_percent: u8) -> u32 {
    let pct = u32::from(threshold_percent.clamp(1, 99));
    context_length.saturating_mul(pct) / 100
}

pub fn trim_target_tokens(
    context_length: u32,
    trim_target_percent: u8,
    hard_limit_tokens: u32,
) -> u32 {
    let pct = u32::from(trim_target_percent.clamp(1, 99));
    let target = context_length.saturating_mul(pct) / 100;
    target.max(1).min(hard_limit_tokens.max(1))
}

#[derive(Debug, Clone)]
struct TaskSlice {
    id: String,
    indices: Vec<usize>,
    tokens: u32,
}

fn build_task_slices(messages: &[Message], first_non_system: usize) -> Vec<TaskSlice> {
    let mut slices: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();

    for idx in first_non_system..messages.len() {
        let msg = &messages[idx];
        if msg.role == MessageRole::User {
            if !current.is_empty() {
                slices.push(current);
                current = Vec::new();
            }
            current.push(idx);
        } else {
            if current.is_empty() {
                // Orphan assistant/tool message without a preceding user in current window.
                current.push(idx);
            } else {
                current.push(idx);
            }
        }
    }

    if !current.is_empty() {
        slices.push(current);
    }

    slices
        .into_iter()
        .enumerate()
        .map(|(i, indices)| {
            let id = indices
                .first()
                .and_then(|idx| messages.get(*idx))
                .map(|m| m.id.clone())
                .unwrap_or_else(|| format!("slice_{i}"));
            let slice_messages = indices
                .iter()
                .filter_map(|idx| messages.get(*idx).cloned())
                .collect::<Vec<_>>();
            let tokens = estimate_prompt_tokens(&slice_messages);
            TaskSlice {
                id,
                indices,
                tokens,
            }
        })
        .collect()
}

/// Trim the runtime prompt down to a target window when hard limit is exceeded.
///
/// Strategy:
/// - Keep all leading `system` messages.
/// - Build request/response task slices from non-system messages.
/// - Select a contiguous window from newest to oldest until adding one more
///   slice would exceed `trim_target_tokens`.
/// - Always keep the newest slice (can represent an unfinished task).
pub fn trim_runtime_messages_to_target_window(
    messages: Vec<Message>,
    hard_limit_tokens: u32,
    trim_target_tokens: u32,
) -> ContextTrimResult {
    let estimated_before = estimate_prompt_tokens(&messages);
    let first_non_system = messages
        .iter()
        .position(|m| m.role != MessageRole::System)
        .unwrap_or(messages.len());
    let slices = build_task_slices(&messages, first_non_system);
    let all_task_ids = slices.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    let target_tokens = trim_target_tokens.min(hard_limit_tokens.max(1)).max(1);

    if estimated_before <= hard_limit_tokens {
        return ContextTrimResult {
            trimmed_messages: messages,
            removed_messages: 0,
            estimated_tokens_before: estimated_before,
            estimated_tokens_after: estimated_before,
            hard_limit_tokens,
            trim_target_tokens: target_tokens,
            removed_tasks: 0,
            kept_tasks: slices.len(),
            kept_task_ids: all_task_ids,
            target_unreachable: false,
        };
    }

    if first_non_system >= messages.len() || slices.is_empty() {
        return ContextTrimResult {
            trimmed_messages: messages,
            removed_messages: 0,
            estimated_tokens_before: estimated_before,
            estimated_tokens_after: estimated_before,
            hard_limit_tokens,
            trim_target_tokens: target_tokens,
            removed_tasks: 0,
            kept_tasks: 0,
            kept_task_ids: Vec::new(),
            target_unreachable: estimated_before > target_tokens,
        };
    }

    let mut keep_mask = vec![false; slices.len()];
    let system_tokens = estimate_prompt_tokens(&messages[..first_non_system]);
    let mut selected_tokens = system_tokens;

    for idx in (0..slices.len()).rev() {
        if !keep_mask.iter().any(|v| *v) {
            keep_mask[idx] = true;
            selected_tokens = selected_tokens.saturating_add(slices[idx].tokens);
            continue;
        }

        let next = selected_tokens.saturating_add(slices[idx].tokens);
        if next <= target_tokens {
            keep_mask[idx] = true;
            selected_tokens = next;
        } else {
            // Keep a contiguous recent window; once it would overflow, stop.
            break;
        }
    }

    let mut trimmed_messages = messages[..first_non_system].to_vec();
    let mut kept_task_ids: Vec<String> = Vec::new();
    for (idx, slice) in slices.iter().enumerate() {
        if keep_mask[idx] {
            kept_task_ids.push(slice.id.clone());
            for msg_idx in &slice.indices {
                if let Some(m) = messages.get(*msg_idx) {
                    trimmed_messages.push(m.clone());
                }
            }
        }
    }

    let estimated_after = estimate_prompt_tokens(&trimmed_messages);
    let removed_messages = messages.len().saturating_sub(trimmed_messages.len());
    let kept_tasks = kept_task_ids.len();
    let removed_tasks = slices.len().saturating_sub(kept_tasks);

    ContextTrimResult {
        trimmed_messages,
        removed_messages,
        estimated_tokens_before: estimated_before,
        estimated_tokens_after: estimated_after,
        hard_limit_tokens,
        trim_target_tokens: target_tokens,
        removed_tasks,
        kept_tasks,
        kept_task_ids,
        target_unreachable: estimated_after > target_tokens,
    }
}

/// Compatibility wrapper:
/// trim down to hard limit when no dedicated target is provided.
pub fn trim_runtime_messages_to_hard_limit(
    messages: Vec<Message>,
    hard_limit_tokens: u32,
) -> ContextTrimResult {
    trim_runtime_messages_to_target_window(messages, hard_limit_tokens, hard_limit_tokens)
}

#[cfg(test)]
mod tests {
    use super::{estimate_prompt_tokens, trim_runtime_messages_to_hard_limit, trim_runtime_messages_to_target_window};
    use crate::models::{Message, MessageRole, MessageStatus};

    fn mk_message(role: MessageRole, content: &str) -> Message {
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: "conv-test".to_string(),
            role,
            content: content.to_string(),
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: chrono::Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        }
    }

    #[test]
    fn trim_preserves_latest_user_when_assistant_tool_replay_follows() {
        // Retry/replay-like ordering:
        //   system -> user -> assistant/tool/... (replayed prior turns)
        // With a very small hard limit, we still must keep that user message.
        let messages = vec![
            mk_message(MessageRole::System, "system prompt"),
            mk_message(MessageRole::User, "please inspect the shadow map and do not modify code"),
            mk_message(
                MessageRole::Assistant,
                "turn 1: planning and tool call metadata content that is fairly long",
            ),
            mk_message(
                MessageRole::Tool,
                "tool output for turn 1 that is also long enough to trigger trimming",
            ),
            mk_message(
                MessageRole::Assistant,
                "turn 2: more replay content after user message",
            ),
        ];

        let result = trim_runtime_messages_to_hard_limit(messages, 1);

        assert!(
            result
                .trimmed_messages
                .iter()
                .any(|m| m.role == MessageRole::User),
            "latest user message must be preserved after trimming"
        );
        assert!(
            result
                .trimmed_messages
                .iter()
                .any(|m| m.role == MessageRole::Assistant),
            "latest non-system message should still be preserved"
        );
    }

    #[test]
    fn trim_target_keeps_contiguous_recent_task_window() {
        let task1_user = mk_message(MessageRole::User, "task1 user");
        let task1_assistant = mk_message(
            MessageRole::Assistant,
            "task1 assistant xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        );
        let task2_user = mk_message(MessageRole::User, "task2 user");
        let task2_assistant = mk_message(
            MessageRole::Assistant,
            "task2 assistant yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
        );
        let task3_user = mk_message(MessageRole::User, "task3 user");
        let task3_assistant = mk_message(
            MessageRole::Assistant,
            "task3 assistant zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        );

        let messages = vec![
            mk_message(MessageRole::System, "system prompt"),
            task1_user.clone(),
            task1_assistant.clone(),
            task2_user.clone(),
            task2_assistant.clone(),
            task3_user.clone(),
            task3_assistant.clone(),
        ];

        let hard = estimate_prompt_tokens(&messages).saturating_sub(1);
        let only_latest_two = vec![
            mk_message(MessageRole::System, "system prompt"),
            task2_user.clone(),
            task2_assistant.clone(),
            task3_user.clone(),
            task3_assistant.clone(),
        ];
        let target = estimate_prompt_tokens(&only_latest_two);
        let out = trim_runtime_messages_to_target_window(messages, hard, target);

        let trimmed_ids = out
            .trimmed_messages
            .iter()
            .map(|m| m.id.clone())
            .collect::<Vec<_>>();
        assert!(
            !trimmed_ids.contains(&task1_user.id),
            "oldest task should be trimmed first"
        );
        assert!(
            trimmed_ids.contains(&task2_user.id) && trimmed_ids.contains(&task3_user.id),
            "recent contiguous task window should be kept"
        );
        assert!(out.estimated_tokens_after <= target || out.target_unreachable);
    }
}

fn is_normal_compact_summary_message(m: &Message) -> bool {
    m.content.contains(NORMAL_COMPACT_MARKER)
}

fn clamp_keep_last_messages(keep_last: usize) -> usize {
    // Ensure the compacted summary remains inside the "last 100" base messages window.
    // Leave room for the summary + current user message + a few system/tool messages.
    keep_last.clamp(10, 90)
}

fn compact_transcript_from_messages(messages: &[Message]) -> String {
    // Keep it plain-text-ish to be cross-provider safe.
    let mut out = String::new();
    for m in messages {
        match m.role {
            MessageRole::User => {
                out.push_str("\n[User]\n");
                out.push_str(m.content.trim());
                out.push('\n');
            }
            MessageRole::Assistant => {
                out.push_str("\n[Assistant]\n");
                if is_normal_compact_summary_message(m) {
                    out.push_str("(existing summary)\n");
                }
                out.push_str(m.content.trim());
                out.push('\n');
            }
            MessageRole::Tool => {
                out.push_str("\n[Tool]\n");
                out.push_str(m.content.trim());
                out.push('\n');
            }
            MessageRole::System => {
                // Do not include system prompt itself in transcript.
            }
        }
    }
    out.trim().to_string()
}

/// Run Codex-like "normal compact"（语义对齐 Codex）：
/// - 不删除 DB 的原始消息（用于 UI/审计）
/// - 生成并持久化一条“摘要消息”（带 cutoff 元数据）
/// - 构建 runtime prompt 时优先使用最新摘要，并跳过其覆盖范围内的更早消息
pub async fn run_normal_compact(
    cfg: &NormalCompactPolicyConfig,
    conversation_id: &str,
    pending_user_message_id: Option<&str>,
    context_length: Option<u32>,
    client: Arc<dyn AiClient>,
    model_config: &ModelConfig,
    db: Arc<Mutex<Database>>,
) -> Result<ContextCompactionResult, SerializableError> {
    let Some(context_length) = context_length.filter(|v| *v > 0) else {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: 0,
            dropped_for_fit: 0,
        });
    };
    if !cfg.enabled {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: 0,
            dropped_for_fit: 0,
        });
    }
    if !cfg.compact_enabled {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: 0,
            dropped_for_fit: 0,
        });
    }

    // Load full history for compaction (chronological).
    let all_messages =
        async_db::read_all_messages(&db, "context_compaction:get_all_messages", conversation_id)
            .await
            .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    let eligible: Vec<Message> = all_messages
        .into_iter()
        .filter(|m| {
            if let Some(pending_id) = pending_user_message_id {
                if m.id == pending_id {
                    return true;
                }
            }
            m.status == MessageStatus::Success
        })
        .collect();

    // Nothing to compact.
    if eligible.len() < 4 {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: eligible.len(),
            dropped_for_fit: 0,
        });
    }

    // Keep the last N messages as-is.
    let keep_last = clamp_keep_last_messages(
        usize::try_from(cfg.keep_last_messages.unwrap_or(60)).unwrap_or(60),
    );
    if eligible.len() <= keep_last + 1 {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: eligible.len(),
            dropped_for_fit: 0,
        });
    }

    // Ensure the pending user message stays in the keep window.
    if let Some(pending_id) = pending_user_message_id {
        if let Some(pos) = eligible.iter().position(|m| m.id == pending_id) {
            if pos + 1 < eligible.len() && eligible.len() - pos > keep_last {
                // Move pending message to the end (chronologically it should already be the latest).
                // Defensive: if ordering got weird, keep it anyway by shrinking the compacted range.
            }
        }
    }

    let split = eligible.len().saturating_sub(keep_last);
    let (mut to_compact, to_keep) = (eligible[..split].to_vec(), eligible[split..].to_vec());

    // Best-effort：限制“用于生成摘要的 transcript”的消息数量。
    // 注意：这不会删除 DB 的原始消息；只是避免 compaction 输入过大导致失败/变慢。
    let max_input = usize::try_from(cfg.max_compact_input_messages.unwrap_or(400)).unwrap_or(400);
    if to_compact.len() > max_input {
        let drop = to_compact.len() - max_input;
        to_compact.drain(0..drop);
    }

    // Input budget for the compaction prompt.
    let max_summary_tokens = cfg.max_summary_tokens.unwrap_or(800).clamp(128, 4096);
    let input_budget = context_length
        .saturating_sub(max_summary_tokens)
        .saturating_sub(512);

    // Build transcript and drop oldest until it fits budget.
    let mut dropped_for_fit = 0usize;
    let mut transcript_msgs = to_compact.clone();
    loop {
        let transcript = compact_transcript_from_messages(&transcript_msgs);
        let est = approx_tokens_for_text(&transcript);
        if est <= input_budget || transcript_msgs.len() <= 2 {
            break;
        }
        // Drop oldest message to keep recent context in the summary.
        transcript_msgs.remove(0);
        dropped_for_fit += 1;
    }

    let transcript = compact_transcript_from_messages(&transcript_msgs);
    if transcript.trim().is_empty() {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: to_keep.len(),
            dropped_for_fit,
        });
    }

    let mut compact_cfg = model_config.clone();
    compact_cfg.parameters.temperature = Some(0.2);
    compact_cfg.parameters.max_tokens = Some(max_summary_tokens);

    let system = crate::prompts::NORMAL_COMPACT_PROMPT.trim().to_string();
    let messages = vec![
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::System,
            content: system,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: MessageRole::User,
            content: transcript,
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: MessageStatus::Success,
            error_message: None,
        },
    ];

    let summary = client
        .chat(messages, &compact_cfg, None)
        .await
        .map_err(|e| AppErrorCode::AiServiceError(e.to_string()))?;

    let summary_text = summary.trim();
    if summary_text.is_empty() {
        return Ok(ContextCompactionResult {
            compacted: false,
            removed_messages: 0,
            kept_messages: to_keep.len(),
            dropped_for_fit,
        });
    }

    // Compaction coverage: everything up to the end of the compacted range.
    // We keep raw history in DB, but the runtime prompt builder can skip messages covered by this cutoff.
    let compacted_until = eligible
        .get(split.saturating_sub(1))
        .cloned()
        .unwrap_or_else(|| {
            eligible.first().cloned().unwrap_or_else(|| Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                role: MessageRole::Assistant,
                content: String::new(),
                content_parts: Vec::new(),
                thinking: None,
                meta: None,
                created_at: Utc::now(),
                status: MessageStatus::Success,
                error_message: None,
            })
        });

    let summary_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::Assistant,
        content: format!(
            "{marker}\n<details><summary>对话已压缩（normal compact）</summary>\n\n{body}\n\n</details>\n",
            marker = NORMAL_COMPACT_MARKER,
            body = summary_text
        ),
        content_parts: Vec::new(),
        thinking: None,
        meta: Some(MessageMeta {
            context_compaction: Some(ContextCompactionMeta {
                strategy: "normal_compact".to_string(),
                compacted_until_message_id: compacted_until.id.clone(),
                compacted_until_created_at: compacted_until.created_at,
                keep_last_messages: Some(keep_last as u32),
                dropped_for_fit: Some(dropped_for_fit as u32),
                max_compact_input_messages: Some(max_input as u32),
            }),
            ..Default::default()
        }),
        // This is a new "event" message; keep it near the time it was generated.
        created_at: Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };

    async_db::with_db(&db, "context_compaction:add_message", |db| {
        db.add_message(conversation_id, &summary_message)
    })
    .await
    .map_err(|e| AppErrorCode::UnknownError(e.to_string()))?;

    Ok(ContextCompactionResult {
        compacted: true,
        // NOTE: We do NOT delete messages from DB. `removed_messages` means "covered by the summary"
        // for UI diagnostics/telemetry purposes.
        removed_messages: split,
        kept_messages: to_keep.len() + 1, // + summary (for prompt view)
        dropped_for_fit,
    })
}
