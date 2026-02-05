//! Conversation commands for TauriAI

use crate::models::{
    Conversation, ConversationActivePath, Message, MessageRole, MessageStatus, ModelConfig,
    ModelParameters,
};
use crate::runtime::RunState;
use crate::storage::Database;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationFileIndexUpdate {
    pub conversation_id: String,
    pub primary_path: Option<String>,
    pub primary_path_kind: Option<String>,
    pub primary_path_pref: Option<String>,
    pub active_files: Option<Vec<ConversationActivePath>>,
    pub active_files_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindPreference {
    FileFirst,
    FolderFirst,
}

impl BindPreference {
    fn from_raw(raw: Option<&str>) -> Self {
        match raw.unwrap_or("file").trim().to_lowercase().as_str() {
            "folder" | "dir" | "directory" | "folder_first" | "folder-first" => Self::FolderFirst,
            _ => Self::FileFirst,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::FileFirst => "file",
            Self::FolderFirst => "folder",
        }
    }
}

fn looks_like_url(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return false;
    }
    if s.starts_with("about:") {
        return true;
    }
    if s.starts_with("//") {
        return true;
    }
    // scheme://...
    if let Some(pos) = s.find("://") {
        if pos > 0 {
            let scheme = &s[..pos];
            return scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        }
    }
    false
}

fn is_absolute_like(path: &str) -> bool {
    let s = path.trim();
    if s.starts_with("//") || s.starts_with('/') {
        return true;
    }
    let b = s.as_bytes();
    b.len() >= 3 && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

fn normalize_path_like(raw: &str) -> String {
    let s = raw.trim().replace('\\', "/");
    if s.is_empty() {
        return String::new();
    }

    let mut prefix = String::new();
    let mut rest = s.as_str();

    if rest.starts_with("//") {
        prefix = "//".to_string();
        rest = &rest[2..];
    } else if rest.starts_with('/') {
        prefix = "/".to_string();
        rest = &rest[1..];
    } else if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
        prefix = rest[..2].to_string(); // "C:"
        rest = &rest[2..];
        if rest.starts_with('/') {
            rest = &rest[1..];
        }
    }

    let mut segs: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if !segs.is_empty() {
                segs.pop();
            }
            continue;
        }
        segs.push(seg);
    }

    if prefix == "/" || prefix == "//" {
        if segs.is_empty() {
            return prefix;
        }
        return format!("{prefix}{}", segs.join("/"));
    }
    if prefix.ends_with(':') {
        if segs.is_empty() {
            return prefix;
        }
        return format!("{prefix}/{}", segs.join("/"));
    }

    segs.join("/")
}

fn join_normalized(root_norm: &str, rel_norm: &str) -> String {
    if root_norm.is_empty() {
        return rel_norm.to_string();
    }
    if rel_norm.is_empty() {
        return root_norm.to_string();
    }
    format!("{root_norm}/{rel_norm}")
}

fn is_windows_like_root(root_norm: &str) -> bool {
    let s = root_norm.trim();
    (s.len() >= 2 && s.as_bytes()[1] == b':') || s.starts_with("//")
}

fn under_root(abs_norm: &str, root_norm: &str) -> bool {
    if root_norm.is_empty() {
        return false;
    }
    let win = is_windows_like_root(root_norm);
    let a = if win {
        abs_norm.to_lowercase()
    } else {
        abs_norm.to_string()
    };
    let r = if win {
        root_norm.to_lowercase()
    } else {
        root_norm.to_string()
    };

    if a == r {
        return true;
    }
    a.starts_with(&(r + "/"))
}

fn strip_root_prefix(abs_norm: &str, root_norm: &str) -> String {
    let win = is_windows_like_root(root_norm);
    if win {
        let a = abs_norm.to_lowercase();
        let r = root_norm.to_lowercase();
        if a == r {
            return String::new();
        }
        if a.starts_with(&(r + "/")) {
            // NOTE: ASCII case fold keeps string length identical for Windows drive/UNC paths.
            let mut out = abs_norm[root_norm.len()..].to_string();
            if out.starts_with('/') {
                out = out[1..].to_string();
            }
            return out;
        }
        return abs_norm.to_string();
    }

    if abs_norm == root_norm {
        return String::new();
    }
    if abs_norm.starts_with(&(root_norm.to_string() + "/")) {
        let mut out = abs_norm[root_norm.len()..].to_string();
        if out.starts_with('/') {
            out = out[1..].to_string();
        }
        return out;
    }
    abs_norm.to_string()
}

fn to_workspace_relative(raw_path: &str, root: &str) -> Option<String> {
    let raw = raw_path.trim();
    if raw.is_empty() {
        return None;
    }
    if looks_like_url(raw) {
        return None;
    }

    let root_norm = normalize_path_like(root);
    if root_norm.is_empty() {
        return None;
    }

    let path_norm = normalize_path_like(raw);
    if path_norm.is_empty() {
        return None;
    }

    let abs_norm = if is_absolute_like(&path_norm) {
        path_norm
    } else {
        normalize_path_like(&join_normalized(&root_norm, &path_norm))
    };

    if !under_root(&abs_norm, &root_norm) {
        return None;
    }

    let rel = strip_root_prefix(&abs_norm, &root_norm);
    let rel = rel.trim().trim_matches('/').to_string();
    if rel.is_empty() {
        None
    } else {
        Some(rel)
    }
}

fn parent_dir(path: &str) -> String {
    let p = path.trim().trim_matches('/');
    if p.is_empty() {
        return String::new();
    }
    if let Some(pos) = p.rfind('/') {
        return p[..pos].to_string();
    }
    String::new()
}

fn compute_lca_dir(file_paths: &[String]) -> String {
    let mut dirs: Vec<Vec<String>> = Vec::new();
    for fp in file_paths {
        let d = parent_dir(fp);
        if d.is_empty() {
            dirs.push(Vec::new());
        } else {
            dirs.push(
                d.split('/')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect(),
            );
        }
    }
    if dirs.is_empty() {
        return String::new();
    }

    let min_len = dirs.iter().map(|v| v.len()).min().unwrap_or(0);
    let mut common: Vec<String> = Vec::new();
    for i in 0..min_len {
        let seg = &dirs[0][i];
        if dirs.iter().all(|v| v.get(i) == Some(seg)) {
            common.push(seg.clone());
        } else {
            break;
        }
    }
    common.join("/")
}

fn extract_paths_from_apply_patch(patch_text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in patch_text.lines() {
        let l = line.trim();
        let prefixes = [
            "*** Add File: ",
            "*** Update File: ",
            "*** Delete File: ",
            "*** Move to: ",
        ];
        for p in prefixes {
            if let Some(rest) = l.strip_prefix(p) {
                let path = rest.trim();
                if !path.is_empty() {
                    out.push(path.to_string());
                }
                break;
            }
        }
    }
    out
}

fn extract_paths_from_tool_call(name: &str, arguments: &str) -> Vec<(String, String, u32)> {
    // Returns (path, kind, weight)
    let mut out: Vec<(String, String, u32)> = Vec::new();
    let args: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(v) => v,
        Err(_) => return out,
    };

    match name {
        "read_file" => {
            if let Some(p) = args.get("file_path").and_then(|v| v.as_str()) {
                out.push((p.to_string(), "file".to_string(), 3));
            }
        }
        "list_dir" => {
            if let Some(p) = args.get("dir_path").and_then(|v| v.as_str()) {
                out.push((p.to_string(), "dir".to_string(), 1));
            }
        }
        "rg" => {
            if let Some(p) = args.get("path").and_then(|v| v.as_str()) {
                out.push((p.to_string(), "dir".to_string(), 1));
            }
        }
        "apply_patch" => {
            if let Some(input) = args.get("input").and_then(|v| v.as_str()) {
                for p in extract_paths_from_apply_patch(input) {
                    out.push((p, "file".to_string(), 5));
                }
            }
        }
        _ => {}
    }

    out
}

fn compute_primary_path(
    active: &[ConversationActivePath],
    preference: BindPreference,
) -> (Option<String>, String) {
    let mut files: Vec<&ConversationActivePath> =
        active.iter().filter(|p| p.kind == "file").collect();
    let mut dirs: Vec<&ConversationActivePath> =
        active.iter().filter(|p| p.kind == "dir").collect();

    files.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.last_used_at.cmp(&a.last_used_at))
            .then_with(|| a.path.cmp(&b.path))
    });
    dirs.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.last_used_at.cmp(&a.last_used_at))
            .then_with(|| a.path.cmp(&b.path))
    });

    let file_paths: Vec<String> = files.iter().map(|p| p.path.clone()).collect();
    let lca_dir = compute_lca_dir(&file_paths);

    let top_dir = dirs.first().map(|p| p.path.clone()).unwrap_or_default();

    match preference {
        BindPreference::FileFirst => {
            let total_file_score: u32 = files.iter().map(|p| p.score).sum();
            if let Some(top) = files.first() {
                if total_file_score > 0 {
                    let ratio = (top.score as f64) / (total_file_score as f64);
                    if ratio >= 0.7 {
                        return (Some(top.path.clone()), "file".to_string());
                    }
                }
            }

            if !lca_dir.is_empty() {
                return (Some(lca_dir), "folder".to_string());
            }
            if !top_dir.is_empty() {
                return (Some(top_dir), "folder".to_string());
            }
            (None, "workspace".to_string())
        }
        BindPreference::FolderFirst => {
            if !lca_dir.is_empty() {
                return (Some(lca_dir), "folder".to_string());
            }
            if !top_dir.is_empty() {
                return (Some(top_dir), "folder".to_string());
            }
            if let Some(top) = files.first() {
                let d = parent_dir(&top.path);
                if !d.is_empty() {
                    return (Some(d), "folder".to_string());
                }
            }
            (None, "workspace".to_string())
        }
    }
}

async fn collect_streamed_chat(
    client: Arc<dyn crate::ai_client::AiClient>,
    messages: Vec<Message>,
    config: ModelConfig,
) -> Result<(String, Option<String>), String> {
    use crate::ai_client::StreamEvent;
    use tokio::sync::mpsc;

    // Some providers (notably OpenAI Responses-compatible gateways) may return SSE even when
    // `stream=false`, so title generation must use the streaming interface.
    let (tx, mut rx) = mpsc::channel::<StreamEvent>(256);

    let handle = tokio::spawn({
        let client = client.clone();
        let config = config.clone();
        async move {
            client
                .chat_stream(
                    messages,
                    &config,
                    None,
                    tx,
                    crate::ai_client::StreamOptions::default(),
                )
                .await
        }
    });

    let mut content_buf = String::new();
    let mut thinking_buf = String::new();
    let mut final_content: Option<String> = None;
    let mut final_thinking: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            StreamEvent::Token(t) => content_buf.push_str(&t),
            StreamEvent::Thinking(t) => thinking_buf.push_str(&t),
            StreamEvent::Done(content) => {
                final_content = Some(content);
                break;
            }
            StreamEvent::DoneWithThinking { content, thinking } => {
                final_content = Some(content);
                final_thinking = Some(thinking);
                break;
            }
            StreamEvent::DoneWithDebug {
                content, thinking, ..
            } => {
                final_content = Some(content);
                final_thinking = thinking;
                break;
            }
            StreamEvent::Error(err) => return Err(err),
            StreamEvent::TurnState(_) => {}
            // Title generation should not involve tools.
            StreamEvent::ToolCalls(_) | StreamEvent::WebSearch { .. } => {
                return Err("Title generation received unexpected tool output".to_string());
            }
        }
    }

    // Ensure we don't miss errors that happen before any event is emitted.
    if let Ok(joined) = handle.await {
        if let Err(err) = joined {
            return Err(err.to_string());
        }
    }

    let mut content = final_content.unwrap_or(content_buf);
    let mut thinking = final_thinking.or_else(|| {
        let t = thinking_buf.trim();
        if t.is_empty() {
            None
        } else {
            Some(thinking_buf)
        }
    });

    // Fallback: some providers incorrectly put visible text in the thinking channel.
    if content.trim().is_empty() {
        if let Some(t) = thinking.take() {
            content = t;
        }
    }

    Ok((content, thinking))
}

#[tauri::command]
pub async fn get_conversations(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Conversation>, String> {
    let db = db.lock().await;
    db.get_conversations().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_messages(
    conversation_id: String,
    limit: Option<usize>,
    before_id: Option<String>,
    include_debug_info: Option<bool>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<Message>, String> {
    let db = db.lock().await;
    let mut messages = db
        .get_messages(&conversation_id, limit.unwrap_or(50), before_id.as_deref())
        .map_err(|e| e.to_string())?;

    // Default: do NOT inline persisted DebugInfo in message list responses.
    // It can be large and slows down session initialization; fetch it lazily on demand.
    let include_debug_info = include_debug_info.unwrap_or(false);
    if !include_debug_info {
        for msg in &mut messages {
            if let Some(meta) = msg.meta.as_mut() {
                if let Some(turns) = meta.turns.as_mut() {
                    for t in turns {
                        if t.debug_info.is_some() {
                            t.has_debug_info = Some(true);
                            t.debug_info = None;
                        }
                    }
                }
            }
        }
    }

    Ok(messages)
}

/// Fetch persisted debug info for a specific turn (lazy-loading).
///
/// NOTE:
/// - `get_messages` strips debug info by default for performance.
/// - This command allows the frontend to load it on demand when the user clicks "Debug".
#[tauri::command]
pub async fn get_turn_debug_info(
    conversation_id: String,
    message_id: String,
    turn_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<crate::ai_client::DebugInfoData>, String> {
    let db = db.lock().await;
    let msg = db
        .get_message(&conversation_id, &message_id)
        .map_err(|e| e.to_string())?;

    let Some(meta) = msg.meta else {
        return Ok(None);
    };
    let Some(turns) = meta.turns else {
        return Ok(None);
    };

    Ok(turns
        .into_iter()
        .find(|t| t.turn_id == turn_id)
        .and_then(|t| t.debug_info))
}

#[tauri::command]
pub async fn create_conversation(
    title: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Conversation, String> {
    let db = db.lock().await;
    db.create_conversation(&title.unwrap_or_else(|| "New Conversation".to_string()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.delete_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_messages_from(
    conversation_id: String,
    message_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    run_state: tauri::State<'_, Arc<RunState>>,
) -> Result<(), String> {
    // 撤回/删除可能发生在流式生成中：先终止并等待退出，避免“删完又被写回”导致重启后消息错乱。
    run_state.abort_and_wait(&conversation_id, 5_000).await;

    let db = db.lock().await;
    db.delete_messages_after(&conversation_id, &message_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation_title(
    conversation_id: String,
    title: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.update_conversation_title(&conversation_id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clone_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Conversation, String> {
    let db = db.lock().await;
    db.clone_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation_metadata(
    conversation_id: String,
    agent_name: Option<String>,
    model_ref: Option<String>,
    thinking_mode: Option<serde_json::Value>,
    workstudio_id: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    db.update_conversation_metadata(
        &conversation_id,
        agent_name.as_deref(),
        model_ref.as_deref(),
        thinking_mode.as_ref(),
        workstudio_id.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ensure_conversation_file_indexes(
    conversation_ids: Vec<String>,
    preference: Option<String>,
    max_messages: Option<usize>,
    force: Option<bool>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<ConversationFileIndexUpdate>, String> {
    let preference = BindPreference::from_raw(preference.as_deref());
    let max_messages = max_messages.unwrap_or(200).clamp(20, 2000);
    let force = force.unwrap_or(false);

    let db = db.lock().await;
    let mut out: Vec<ConversationFileIndexUpdate> = Vec::new();

    for id in conversation_ids {
        let conv = match db.get_conversation(&id).map_err(|e| e.to_string())? {
            Some(c) => c,
            None => continue,
        };

        let latest_msg_at = db
            .get_conversation_latest_message_at(&conv.id)
            .map_err(|e| e.to_string())?;
        let fallback_index_at = latest_msg_at.unwrap_or(conv.updated_at);

        let workstudio_id = (conv.workstudio_id.clone().unwrap_or_default())
            .trim()
            .to_string();
        if workstudio_id.is_empty() {
            out.push(ConversationFileIndexUpdate {
                conversation_id: conv.id,
                primary_path: None,
                primary_path_kind: Some("workspace".to_string()),
                primary_path_pref: Some(preference.as_str().to_string()),
                active_files: None,
                active_files_updated_at: Some(fallback_index_at),
            });
            continue;
        }

        let ws = db
            .get_workstudio(&workstudio_id)
            .map_err(|e| e.to_string())?;
        let Some(ws) = ws else {
            let active_index_at = Some(fallback_index_at);

            let mut primary_kind = conv
                .primary_path_kind
                .clone()
                .unwrap_or_else(|| "workspace".to_string());
            let mut primary_path = conv.primary_path.clone();
            if matches!(primary_kind.as_str(), "file" | "folder")
                && primary_path.as_deref().unwrap_or("").trim().is_empty()
            {
                primary_kind = "workspace".to_string();
                primary_path = None;
            }

            let active_files_json = conv.active_files.as_ref().and_then(|v| {
                if v.is_empty() {
                    None
                } else {
                    serde_json::to_string(v).ok()
                }
            });

            // workstudio 缺失时无法重新计算相对路径；但为了避免前端自动索引循环，
            // 仍然记录 active_files_updated_at（用于“已索引”的判断）。
            db.update_conversation_file_index(
                &conv.id,
                primary_path.as_deref(),
                Some(primary_kind.as_str()),
                Some(preference.as_str()),
                active_files_json.as_deref(),
                active_index_at,
            )
            .map_err(|e| e.to_string())?;

            out.push(ConversationFileIndexUpdate {
                conversation_id: conv.id,
                primary_path,
                primary_path_kind: Some(primary_kind),
                primary_path_pref: Some(preference.as_str().to_string()),
                active_files: conv.active_files.clone(),
                active_files_updated_at: active_index_at,
            });
            continue;
        };
        let root = ws.main_folder.clone();

        let stored_index_at = conv.active_files_updated_at;
        let mut need_recompute_active = force
            || conv
                .active_files
                .as_ref()
                .map(|v| v.is_empty())
                .unwrap_or(true)
            || stored_index_at.is_none();
        if !need_recompute_active {
            if let (Some(latest), Some(stored)) = (latest_msg_at, stored_index_at) {
                if latest > stored {
                    need_recompute_active = true;
                }
            }
        }

        let mut active_paths: Vec<ConversationActivePath> = Vec::new();
        let mut active_index_at: Option<DateTime<Utc>> = latest_msg_at;

        if need_recompute_active {
            let messages = db
                .get_messages(&conv.id, max_messages, None)
                .map_err(|e| e.to_string())?;

            let mut map: HashMap<(String, String), (u32, Option<DateTime<Utc>>)> = HashMap::new();

            for msg in &messages {
                let ts = msg.created_at;
                let Some(meta) = msg.meta.as_ref() else {
                    continue;
                };
                let Some(tool_calls) = meta.tool_calls.as_ref() else {
                    continue;
                };

                for call in tool_calls {
                    let name = call.name.as_str();
                    for (raw_path, kind, weight) in
                        extract_paths_from_tool_call(name, call.arguments.as_str())
                    {
                        let Some(rel) = to_workspace_relative(&raw_path, &root) else {
                            continue;
                        };
                        let key = (kind.clone(), rel);
                        let entry = map.entry(key).or_insert((0, None));
                        entry.0 = entry.0.saturating_add(weight);
                        if entry.1.is_none() || entry.1 < Some(ts) {
                            entry.1 = Some(ts);
                        }
                    }
                }
            }

            active_paths = map
                .into_iter()
                .map(
                    |((kind, path), (score, last_used_at))| ConversationActivePath {
                        path,
                        score,
                        kind,
                        last_used_at,
                    },
                )
                .collect();

            active_paths.sort_by(|a, b| {
                b.score
                    .cmp(&a.score)
                    .then_with(|| b.last_used_at.cmp(&a.last_used_at))
                    .then_with(|| a.path.cmp(&b.path))
            });

            if active_paths.len() > 80 {
                active_paths.truncate(80);
            }

            // Index timestamp: latest message time we have observed (not "now").
            if active_index_at.is_none() && !messages.is_empty() {
                active_index_at = Some(messages.last().unwrap().created_at);
            }
        } else if let Some(stored) = conv.active_files.as_ref() {
            active_paths = stored.clone();
        }

        // 没有任何消息时，latest_msg_at 为 None；为了避免前端自动索引反复触发，
        // 这里使用对话的 updated_at 作为一个稳定的“索引时间戳”占位。
        if active_index_at.is_none() {
            active_index_at = Some(conv.updated_at);
        }

        let (primary_path, primary_kind) = compute_primary_path(&active_paths, preference);

        let needs_update = need_recompute_active
            || conv.primary_path.as_ref() != primary_path.as_ref()
            || conv.primary_path_kind.as_deref().unwrap_or("") != primary_kind
            || conv.primary_path_pref.as_deref().unwrap_or("") != preference.as_str();

        if needs_update {
            let active_files_json = if active_paths.is_empty() {
                None
            } else {
                serde_json::to_string(&active_paths).ok()
            };

            db.update_conversation_file_index(
                &conv.id,
                primary_path.as_deref(),
                Some(primary_kind.as_str()),
                Some(preference.as_str()),
                active_files_json.as_deref(),
                active_index_at,
            )
            .map_err(|e| e.to_string())?;
        }

        out.push(ConversationFileIndexUpdate {
            conversation_id: conv.id,
            primary_path,
            primary_path_kind: Some(primary_kind),
            primary_path_pref: Some(preference.as_str().to_string()),
            active_files: if active_paths.is_empty() {
                None
            } else {
                Some(active_paths)
            },
            active_files_updated_at: active_index_at,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn generate_title(
    conversation_id: String,
    messages: Vec<Message>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    config_manager: tauri::State<'_, Arc<crate::config::ConfigManager>>,
) -> Result<String, String> {
    use crate::ai_client::get_client;

    let config = config_manager.ensure_default().map_err(|e| e.to_string())?;
    let (provider, model, _) = config
        .get_default_agent()
        .and_then(|a| config.resolve_agent(&a.name))
        .ok_or("No agent configured")?;

    let model_config = ModelConfig {
        id: format!("{}/{}", provider.name, model.name),
        name: model.name.clone(),
        provider: provider.provider_type.to_client_str().to_string(),
        api_base: Some(provider.api_base.clone()),
        api_key: provider.api_key.clone(),
        model: model.name.clone(),
        parameters: ModelParameters {
            temperature: Some(model.temperature),
            max_tokens: model.max_tokens,
            top_p: model.top_p,
            frequency_penalty: None,
            presence_penalty: None,
            system_prompt: None,
        },
        thinking_level: None, // Don't use thinking for title generation
        thinking_budget_tokens: None,
        vision_enabled: false,      // Don't need vision for title generation
        web_search_enabled: false,  // Don't enable web search for title generation
        max_images: None,           // Not needed for title generation
        use_reasoning_effort: None, // Not needed for title generation
        retry_attempts: None,
        resume_partial_output: false,
        debug_sse: false,
        reinject_reasoning_content: false,
    };

    let client = get_client(&model_config.provider).map_err(|e| e.to_string())?;
    let content = messages
        .iter()
        .take(6)
        .map(|m| {
            format!(
                "{}: {}",
                match m.role {
                    MessageRole::User => "用户",
                    MessageRole::Assistant => "助手",
                    _ => "系统",
                },
                m.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.clone(),
        role: MessageRole::User,
        content: format!("根据对话生成简洁标题（不超20字）：\n{}", content),
        content_parts: Vec::new(),
        thinking: None,
        meta: None,
        created_at: chrono::Utc::now(),
        status: MessageStatus::Success,
        error_message: None,
    };
    let (raw_title, _thinking) =
        collect_streamed_chat(client, vec![prompt_message], model_config).await?;
    let title = raw_title.trim().trim_matches('"').to_string();
    {
        let db = db.lock().await;
        db.update_conversation_title(&conversation_id, &title)
            .map_err(|e| e.to_string())?;
    }
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use tokio::sync::mpsc;

    #[derive(Clone)]
    struct MockClient {
        events: Vec<crate::ai_client::StreamEvent>,
    }

    #[async_trait]
    impl crate::ai_client::AiClient for MockClient {
        async fn chat(
            &self,
            _messages: Vec<Message>,
            _config: &ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
        ) -> Result<String, crate::ai_client::AiError> {
            Err(crate::ai_client::AiError::InvalidResponse(
                "mock chat not implemented".to_string(),
            ))
        }

        async fn chat_stream(
            &self,
            _messages: Vec<Message>,
            _config: &ModelConfig,
            _tools: Option<Vec<crate::ai_client::ToolDefinition>>,
            token_sender: mpsc::Sender<crate::ai_client::StreamEvent>,
            _options: crate::ai_client::StreamOptions,
        ) -> Result<(), crate::ai_client::AiError> {
            for ev in self.events.clone() {
                token_sender
                    .send(ev)
                    .await
                    .map_err(|e| crate::ai_client::AiError::StreamError(e.to_string()))?;
            }
            Ok(())
        }
    }

    fn dummy_model_config() -> ModelConfig {
        ModelConfig {
            id: "test/test".to_string(),
            name: "test".to_string(),
            provider: "openai_compatible".to_string(),
            api_base: None,
            api_key: Some("test".to_string()),
            model: "test".to_string(),
            parameters: ModelParameters {
                temperature: Some(0.0),
                max_tokens: Some(32),
                top_p: Some(1.0),
                frequency_penalty: None,
                presence_penalty: None,
                system_prompt: None,
            },
            thinking_level: None,
            thinking_budget_tokens: None,
            vision_enabled: false,
            web_search_enabled: false,
            max_images: None,
            use_reasoning_effort: None,
            retry_attempts: None,
            resume_partial_output: false,
            debug_sse: false,
            reinject_reasoning_content: false,
        }
    }

    #[tokio::test]
    async fn collect_streamed_chat_prefers_final_content() {
        let client = Arc::new(MockClient {
            events: vec![
                crate::ai_client::StreamEvent::Token("a".to_string()),
                crate::ai_client::StreamEvent::Token("b".to_string()),
                crate::ai_client::StreamEvent::DoneWithDebug {
                    content: "ab".to_string(),
                    thinking: None,
                    debug_info: None,
                    usage: None,
                },
            ],
        });

        let (content, thinking) = collect_streamed_chat(client, vec![], dummy_model_config())
            .await
            .unwrap();
        assert_eq!(content, "ab");
        assert!(thinking.is_none());
    }

    #[tokio::test]
    async fn collect_streamed_chat_falls_back_to_thinking_when_content_empty() {
        let client = Arc::new(MockClient {
            events: vec![crate::ai_client::StreamEvent::DoneWithDebug {
                content: "".to_string(),
                thinking: Some("标题".to_string()),
                debug_info: None,
                usage: None,
            }],
        });

        let (content, thinking) = collect_streamed_chat(client, vec![], dummy_model_config())
            .await
            .unwrap();
        assert_eq!(content, "标题");
        assert!(thinking.is_none());
    }
}
