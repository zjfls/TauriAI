use std::ops::{Deref, DerefMut};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use rusqlite::params;
use tokio::sync::Mutex;

use crate::models::Message;
use crate::models::Workstudio;

use super::{Database, RawMessageRow, StorageError};

pub const DB_LOCK_TIMEOUT: Duration = Duration::from_millis(5_000);
pub const FS_OP_TIMEOUT: Duration = Duration::from_millis(5_000);

#[derive(Debug, Clone)]
struct DbLockHolder {
    op: String,
    acquired_at_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbLockSnapshot {
    pub op: String,
    pub acquired_at_ms: u64,
    pub held_for_ms: u64,
}

fn db_lock_holder_state() -> &'static std::sync::Mutex<Option<DbLockHolder>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<Option<DbLockHolder>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(None))
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn get_db_lock_snapshot() -> Option<DbLockSnapshot> {
    let holder = db_lock_holder_state()
        .lock()
        .ok()
        .and_then(|v| (*v).clone())?;
    let held_for_ms = now_ms().saturating_sub(holder.acquired_at_ms);
    Some(DbLockSnapshot {
        op: holder.op,
        acquired_at_ms: holder.acquired_at_ms,
        held_for_ms,
    })
}

pub struct TrackedDbGuard<'a> {
    guard: tokio::sync::MutexGuard<'a, Database>,
}

impl<'a> Drop for TrackedDbGuard<'a> {
    fn drop(&mut self) {
        if let Ok(mut holder) = db_lock_holder_state().lock() {
            *holder = None;
        }
    }
}

impl<'a> Deref for TrackedDbGuard<'a> {
    type Target = Database;

    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl<'a> DerefMut for TrackedDbGuard<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

pub async fn lock_db<'a>(
    db: &'a Arc<Mutex<Database>>,
    op: &str,
) -> Result<TrackedDbGuard<'a>, StorageError> {
    let op_trimmed = op.trim();
    let op = if op_trimmed.is_empty() {
        "unknown"
    } else {
        op_trimmed
    };

    match tokio::time::timeout(DB_LOCK_TIMEOUT, db.lock()).await {
        Ok(guard) => {
            let acquired_at_ms = now_ms();
            if let Ok(mut holder) = db_lock_holder_state().lock() {
                *holder = Some(DbLockHolder {
                    op: op.to_string(),
                    acquired_at_ms,
                });
            }
            Ok(TrackedDbGuard { guard })
        }
        Err(_) => {
            let holder = db_lock_holder_state()
                .lock()
                .ok()
                .and_then(|v| (*v).clone());
            let mut msg = format!(
                "DB lock 超时（{}ms），操作={op}",
                DB_LOCK_TIMEOUT.as_millis()
            );
            if let Some(holder) = holder {
                let held_for_ms = now_ms().saturating_sub(holder.acquired_at_ms);
                msg.push_str(&format!(
                    "；当前持锁操作={}；已持锁={}ms",
                    holder.op, held_for_ms
                ));
            } else {
                msg.push_str("；当前无持锁者（可能刚释放）");
            }
            Err(StorageError::Lock(msg))
        }
    }
}

pub async fn with_db<T, F>(db: &Arc<Mutex<Database>>, op: &str, f: F) -> Result<T, StorageError>
where
    F: FnOnce(&Database) -> Result<T, StorageError>,
{
    let guard = lock_db(db, op).await?;
    f(&*guard)
}

fn estimate_json_bytes(rows: &[RawMessageRow]) -> usize {
    let mut total = 0usize;
    for r in rows {
        if let Some(v) = r.meta_json.as_ref() {
            total = total.saturating_add(v.len());
        }
        if let Some(v) = r.content_parts_json.as_ref() {
            total = total.saturating_add(v.len());
        }
    }
    total
}

async fn parse_raw_messages(rows: Vec<RawMessageRow>) -> Result<Vec<Message>, StorageError> {
    const SPAWN_THRESHOLD_BYTES: usize = 512 * 1024; // 512KB
    let bytes = estimate_json_bytes(&rows);
    if bytes >= SPAWN_THRESHOLD_BYTES {
        tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .map(Database::raw_message_row_to_message)
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| StorageError::Database(format!("parse messages join failed: {e}")))
    } else {
        Ok(rows
            .into_iter()
            .map(Database::raw_message_row_to_message)
            .collect())
    }
}

/// Read conversation messages without holding the async DB lock during JSON parse.
///
/// Why:
/// - `meta` / `content_parts` can be very large (tool traces, blocks). JSON parse is CPU-heavy.
/// - Holding the DB mutex during parse can cause other commands to hit `DB lock 超时`.
pub async fn read_messages(
    db: &Arc<Mutex<Database>>,
    op: &str,
    conversation_id: &str,
    limit: usize,
    before_id: Option<&str>,
) -> Result<Vec<Message>, StorageError> {
    let rows = {
        let guard = lock_db(db, op).await?;
        guard.get_messages_raw(conversation_id, limit, before_id)?
    };
    parse_raw_messages(rows).await
}

pub async fn read_all_messages(
    db: &Arc<Mutex<Database>>,
    op: &str,
    conversation_id: &str,
) -> Result<Vec<Message>, StorageError> {
    let rows = {
        let guard = lock_db(db, op).await?;
        guard.get_all_messages_raw(conversation_id)?
    };
    parse_raw_messages(rows).await
}

pub async fn read_message(
    db: &Arc<Mutex<Database>>,
    op: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Message, StorageError> {
    let row = {
        let guard = lock_db(db, op).await?;
        guard.get_message_raw(conversation_id, message_id)?
    };
    let mut out = parse_raw_messages(vec![row]).await?;
    out.pop().ok_or_else(|| StorageError::NotFound("message missing".to_string()))
}

pub async fn read_latest_message_containing(
    db: &Arc<Mutex<Database>>,
    op: &str,
    conversation_id: &str,
    marker: &str,
) -> Result<Option<Message>, StorageError> {
    let row_opt = {
        let guard = lock_db(db, op).await?;
        guard.get_latest_message_containing_raw(conversation_id, marker)?
    };
    let Some(row) = row_opt else {
        return Ok(None);
    };
    let mut out = parse_raw_messages(vec![row]).await?;
    Ok(out.pop())
}

pub async fn ensure_workstudio_for_conversation(
    db: &Arc<Mutex<Database>>,
    conversation_id: &str,
) -> Result<Workstudio, StorageError> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err(StorageError::NotFound("conversation_id 为空".to_string()));
    }

    // 1) Fast path: existing binding
    let existing_ws_id_opt: Option<String> =
        with_db(db, "ensure_workstudio:read_conversation", |db| {
            let conv = db.get_conversation(conversation_id)?.ok_or_else(|| {
                StorageError::NotFound(format!("Conversation {conversation_id} not found"))
            })?;
            Ok(conv.workstudio_id)
        })
        .await?;

    if let Some(existing_ws_id) = existing_ws_id_opt.as_deref() {
        let existing_ws: Option<Workstudio> =
            with_db(db, "ensure_workstudio:read_workstudio", |db| {
                db.get_workstudio(existing_ws_id)
            })
            .await?;
        if let Some(ws) = existing_ws {
            return Ok(ws);
        }
        // Broken binding: fall through and recreate.
    }

    // 2) Create new workstudio folder (do NOT hold the DB lock during file IO)
    let id = uuid::Uuid::new_v4().to_string();
    let main_folder_path = Database::default_workstudio_main_folder(&id)?;

    tokio::time::timeout(FS_OP_TIMEOUT, tokio::fs::create_dir_all(&main_folder_path))
        .await
        .map_err(|_| {
            StorageError::Io(format!(
                "create workstudio folder 超时（{}ms）：{}",
                FS_OP_TIMEOUT.as_millis(),
                main_folder_path.to_string_lossy()
            ))
        })?
        .map_err(|e| StorageError::Io(format!("create workstudio folder failed: {e}")))?;

    let main_folder = main_folder_path.to_string_lossy().to_string();
    let main_folder_key_raw = Database::workstudio_main_folder_key(&main_folder);
    let main_folder_key = if main_folder_key_raw.trim().is_empty() {
        format!("id:{id}")
    } else {
        main_folder_key_raw
    };
    let folders = vec![main_folder.clone()];
    let folders_json = serde_json::to_string(&folders)?;

    let now = Utc::now();
    let now_str = now.to_rfc3339();

    // 3) Bind to conversation (re-check under lock to keep this idempotent)
    let ws: Workstudio = with_db(db, "ensure_workstudio:bind", |db| {
        let conv = db
            .get_conversation(conversation_id)?
            .ok_or_else(|| StorageError::NotFound(format!("Conversation {conversation_id} not found")))?;

        if let Some(existing_ws_id2) = conv.workstudio_id.as_deref() {
            if let Some(ws2) = db.get_workstudio(existing_ws_id2)? {
                return Ok(ws2);
            }
        }

        let mut conn = db
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO workstudios (id, kind, main_folder, main_folder_key, folders_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                "code",
                main_folder,
                main_folder_key,
                folders_json,
                now_str,
                now_str
            ],
        )?;

        tx.execute(
            "UPDATE conversations
             SET workstudio_id = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![id, now_str, conversation_id],
        )?;

        tx.commit()?;

        Ok(Workstudio {
            id: id.to_string(),
            kind: "code".to_string(),
            main_folder: main_folder_path.to_string_lossy().to_string(),
            folders: folders.clone(),
            created_at: now,
            updated_at: now,
        })
    })
    .await?;

    // 4) Best-effort marker file (outside DB lock)
    let ws2 = ws.clone();
    let path2 = main_folder_path.clone();
    tokio::task::spawn_blocking(move || {
        let _ = Database::write_workstudio_marker(&path2, &ws2);
    })
    .await
    .ok();

    Ok(ws)
}
