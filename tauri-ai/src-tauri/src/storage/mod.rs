//! Storage module for TauriAI
//!
//! This module provides SQLite-based storage for conversations and messages.

use std::path::PathBuf;
use std::sync::Mutex;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use thiserror::Error;

use crate::models::WorkstudioUiState;
use crate::models::{CodeSnippetRange, ContentPart, Conversation, Message, MessageRole, Workstudio, WorkstudioSymbolAnalysis};

/// Errors that can occur during storage operations
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("IO error: {0}")]
    Io(String),

    #[error("Lock error: {0}")]
    Lock(String),
}

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        StorageError::Database(err.to_string())
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(err: serde_json::Error) -> Self {
        StorageError::Serialization(err.to_string())
    }
}

impl From<std::io::Error> for StorageError {
    fn from(err: std::io::Error) -> Self {
        StorageError::Io(err.to_string())
    }
}

/// Database wrapper providing thread-safe access to SQLite
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Create a new database connection at the specified path
    pub fn new(db_path: PathBuf) -> Result<Self, StorageError> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&db_path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.initialize()?;
        Ok(db)
    }

    /// Create an in-memory database (useful for testing)
    pub fn new_in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.initialize()?;
        Ok(db)
    }

    /// Initialize database schema
    fn initialize(&self) -> Result<(), StorageError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        // Create conversations table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                model_id TEXT,
                agent_name TEXT,
                model_ref TEXT,
                system_prompt TEXT,
                system_prompt_cache_key TEXT,
                thinking_mode TEXT,
                run_mode TEXT,
                workstudio_id TEXT,
                primary_path TEXT,
                primary_path_kind TEXT,
                primary_path_pref TEXT,
                active_files TEXT,
                active_files_updated_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Migration: Add agent_name and model_ref columns if they don't exist
        // We ignore errors as they will fail if columns already exist
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN agent_name TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN model_ref TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN system_prompt TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN system_prompt_cache_key TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN thinking_mode TEXT",
            [],
        );
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN run_mode TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN workstudio_id TEXT",
            [],
        );
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN primary_path TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN primary_path_kind TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN primary_path_pref TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN active_files TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN active_files_updated_at TEXT", []);

        // Create workstudios table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS workstudios (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'code',
                main_folder TEXT NOT NULL,
                main_folder_key TEXT NOT NULL,
                folders_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        // Migration: Add kind column if it doesn't exist
        let _ = conn.execute(
            "ALTER TABLE workstudios ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'",
            [],
        );
        // Migration: Add main_folder_key column if it doesn't exist
        let _ = conn.execute("ALTER TABLE workstudios ADD COLUMN main_folder_key TEXT", []);

        // Keep a single workstudio per main_folder_key (matches frontend window identity).
        // Backfill keys first, then merge duplicates, then enforce a unique index.
        Self::backfill_workstudio_main_folder_keys(&mut conn)?;
        Self::dedupe_workstudios_by_main_folder_key(&mut conn)?;
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_workstudios_main_folder_key
             ON workstudios(main_folder_key)",
            [],
        )?;

        // Create workstudio_states table (UI persisted state, keyed by main_folder + kind)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS workstudio_states (
                main_folder TEXT NOT NULL,
                kind TEXT NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (main_folder, kind)
            )",
            [],
        )?;

        // Create workstudio_symbol_analyses table (persisted AI analysis results for Outline symbols)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS workstudio_symbol_analyses (
                id TEXT PRIMARY KEY,
                workstudio_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                language_id TEXT NOT NULL,
                symbol_key TEXT NOT NULL,
                symbol_name TEXT NOT NULL,
                symbol_kind TEXT NOT NULL,
                selection_line INTEGER NOT NULL,
                selection_column INTEGER NOT NULL,
                range_start_line INTEGER NOT NULL,
                range_start_column INTEGER NOT NULL,
                range_end_line INTEGER NOT NULL,
                range_end_column INTEGER NOT NULL,
                answer_md TEXT NOT NULL,
                model_ref TEXT,
                latency_ms INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(workstudio_id, file_path, symbol_key)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_workstudio_symbol_analyses_ws
             ON workstudio_symbol_analyses(workstudio_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_workstudio_symbol_analyses_file
             ON workstudio_symbol_analyses(file_path)",
            [],
        )?;

        // Create messages table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                thinking TEXT,
                content_parts TEXT,
                meta TEXT,
                status TEXT NOT NULL DEFAULT 'success',
                error_message TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Migration: Add status and error_message columns if they don't exist
        let _ = conn.execute(
            "ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'success'",
            [],
        );
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN error_message TEXT", []);
        // Migration: Add content_parts column if it doesn't exist
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN content_parts TEXT", []);
        // Migration: Add thinking column if it doesn't exist
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN thinking TEXT", []);

        // Create indexes for performance
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id 
             ON messages(conversation_id)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_created_at 
             ON messages(created_at)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conversations_updated_at 
             ON conversations(updated_at DESC)",
            [],
        )?;

        // Enable foreign key support
        conn.execute("PRAGMA foreign_keys = ON", [])?;

        Ok(())
    }

    // ==================== Conversation Operations ====================

    /// Create a new conversation
    pub fn create_conversation(&self, title: &str) -> Result<Conversation, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO conversations (id, title, model_id, agent_name, model_ref, system_prompt, system_prompt_cache_key, thinking_mode, run_mode, workstudio_id, created_at, updated_at)
             VALUES (?1, ?2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?3, ?4)",
            params![id, title, now_str, now_str],
        )?;

        Ok(Conversation {
            id,
            title: title.to_string(),
            agent_name: None,
            model_ref: None,
            system_prompt: None,
            system_prompt_cache_key: None,
            thinking_mode: None,
            run_mode: None,
            workstudio_id: None,
            message_count: None,
            turn_count: None,
            last_message_at: None,
            primary_path: None,
            primary_path_kind: None,
            primary_path_pref: None,
            active_files: None,
            active_files_updated_at: None,
            created_at: now,
            updated_at: now,
        })
    }

    fn split_clone_suffix(title: &str) -> (String, String) {
        fn is_base62_char(c: char) -> bool {
            c.is_ascii_alphanumeric()
        }

        let trimmed = title.trim();
        let trimmed = if trimmed.is_empty() {
            "新对话"
        } else {
            trimmed
        };

        let Some(hash_pos) = trimmed.rfind('#') else {
            return (trimmed.to_string(), String::new());
        };

        if hash_pos + 1 >= trimmed.len() {
            return (trimmed.to_string(), String::new());
        }

        let suffix = &trimmed[(hash_pos + 1)..];
        if suffix.is_empty() || !suffix.chars().all(is_base62_char) {
            return (trimmed.to_string(), String::new());
        }

        let prefix = &trimmed[..hash_pos];
        if !prefix.chars().last().is_some_and(|c| c.is_whitespace()) {
            return (trimmed.to_string(), String::new());
        }

        let base = prefix.trim_end();
        let base = if base.is_empty() { "新对话" } else { base };
        (base.to_string(), suffix.to_string())
    }

    fn clone_conversation_title(&self, title: &str) -> Result<String, StorageError> {
        // 采用“树状后缀”命名：在标题末尾追加 ` #<path>`，每次克隆在 path 末尾追加 1 个字符。
        // 例如：
        // - 原始：Foo
        // - 克隆 1 次：Foo #1
        // - 再克隆：Foo #2
        // - 克隆 Foo #1：Foo #11 / Foo #12 ...
        const ALPHABET: &str = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

        let existing_titles: HashSet<String> = self
            .get_conversations()?
            .into_iter()
            .map(|c| c.title)
            .collect();

        let (base, parent_path) = Self::split_clone_suffix(title);

        let mut used_next: HashSet<char> = HashSet::new();
        for t in &existing_titles {
            let (t_base, t_path) = Self::split_clone_suffix(t);
            if t_base != base {
                continue;
            }
            if !t_path.starts_with(&parent_path) {
                continue;
            }
            if t_path.len() != parent_path.len() + 1 {
                continue;
            }
            let next_ch = t_path[parent_path.len()..].chars().next().unwrap_or('\0');
            if next_ch != '\0' {
                used_next.insert(next_ch);
            }
        }

        for ch in ALPHABET.chars() {
            if used_next.contains(&ch) {
                continue;
            }
            let path = format!("{parent_path}{ch}");
            let candidate = format!("{base} #{path}");
            if !existing_titles.contains(&candidate) {
                return Ok(candidate);
            }
        }

        // 极端情况：同一父节点克隆次数超过 62。这里退化为追加一个随机 token（仍保持只用 0-9a-zA-Z）。
        for _ in 0..32 {
            let frag = uuid::Uuid::new_v4().simple().to_string();
            let mut extra = String::with_capacity(4);
            for b in frag.bytes() {
                // map hex char into base62 roughly (deterministic).
                let idx = (b as usize) % ALPHABET.len();
                extra.push(ALPHABET.as_bytes()[idx] as char);
                if extra.len() >= 4 {
                    break;
                }
            }
            let candidate = format!("{base} #{}{}", parent_path, extra);
            if !existing_titles.contains(&candidate) {
                return Ok(candidate);
            }
        }

        // Fallback：允许重名（理论上极难触发）。
        Ok(format!("{base} #{}1", parent_path))
    }

    fn is_default_workstudio_main_folder(&self, ws: &Workstudio) -> bool {
        let Ok(default_main) = Self::default_workstudio_main_folder(&ws.id) else {
            return false;
        };
        ws.main_folder == default_main.to_string_lossy().to_string()
    }

    fn remap_workstudio_folder(folder: &str, old_root: &str, new_root: &str) -> String {
        fn normalize(p: &str) -> String {
            p.replace('\\', "/").trim_end_matches('/').to_string()
        }

        let folder_n = normalize(folder);
        let old_n = normalize(old_root);

        if folder_n == old_n {
            return new_root.to_string();
        }

        let prefix = format!("{old_n}/");
        if folder_n.starts_with(&prefix) {
            let rel = &folder_n[prefix.len()..];
            let mut out = PathBuf::from(new_root);
            for seg in rel.split('/') {
                if seg.is_empty() {
                    continue;
                }
                out.push(seg);
            }
            return out.to_string_lossy().to_string();
        }

        folder.to_string()
    }

    fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), StorageError> {
        if !dst.exists() {
            fs::create_dir_all(dst)?;
        }

        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let from = entry.path();
            let to = dst.join(entry.file_name());

            if file_type.is_dir() {
                Self::copy_dir_recursive(&from, &to)?;
                continue;
            }

            if file_type.is_file() {
                // Overwrite if exists.
                let _ = fs::copy(&from, &to)?;
                continue;
            }

            // Skip symlinks and other special files for safety.
        }

        Ok(())
    }

    /// Clone an existing conversation (including messages + workstudio binding).
    ///
    /// 语义：
    /// - 新建一个 conversation（新 id / 新 title / created_at/updated_at = now）
    /// - 复制原 conversation 的元数据（agent/model/thinking/system_prompt/workstudio 绑定）
    /// - 复制 messages（新 message id，但内容/顺序/元数据保持）
    /// - workstudio：默认工作区（~/.tauri-ai/workstudios/<id>）会“复制目录”到新的默认工作区；非默认则只复制绑定（不改写文件系统）
    pub fn clone_conversation(
        &self,
        source_conversation_id: &str,
    ) -> Result<Conversation, StorageError> {
        let source = self
            .get_conversation(source_conversation_id)?
            .ok_or_else(|| {
                StorageError::NotFound(format!("Conversation {source_conversation_id} not found"))
            })?;

        let new_title = self.clone_conversation_title(&source.title)?;
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        let source_messages = self.get_all_messages(source_conversation_id)?;

        // Clone workstudio if present.
        //
        // 语义：
        // - 默认 workstudio（~/.tauri-ai/workstudios/<id>）：复制目录到新的默认位置（新 id）
        // - 非默认 workstudio：只复制绑定（共享同一个 workstudio id），避免出现“同 main_folder 多个 id”
        let mut workstudio_insert: Option<(Workstudio, String /* folders_json */)> = None;
        let mut cloned_workstudio_id: Option<String> = source.workstudio_id.clone();

        if let Some(source_ws_id) = source.workstudio_id.as_deref() {
            if let Some(ws) = self.get_workstudio(source_ws_id)? {
                if self.is_default_workstudio_main_folder(&ws) {
                    let new_ws_id = uuid::Uuid::new_v4().to_string();

                    // Default workstudio: deep copy folder to a new default location.
                    let new_main_path = Self::default_workstudio_main_folder(&new_ws_id)?;
                    let old_main_path = PathBuf::from(&ws.main_folder);

                    fs::create_dir_all(&new_main_path)?;
                    if old_main_path.exists() {
                        // Best-effort: clone contents to keep the workspace self-contained.
                        let _ = Self::copy_dir_recursive(&old_main_path, &new_main_path);
                    }

                    let new_main = new_main_path.to_string_lossy().to_string();
                    let mut folders: Vec<String> = ws
                        .folders
                        .iter()
                        .map(|f| Self::remap_workstudio_folder(f, &ws.main_folder, &new_main))
                        .collect();

                    // Ensure main folder is present and is the first entry.
                    if !folders.iter().any(|f| f == &new_main) {
                        folders.insert(0, new_main.clone());
                    }
                    folders.retain(|f| f != &new_main);
                    folders.insert(0, new_main.clone());

                    let folders_json = serde_json::to_string(&folders)?;
                    let new_ws = Workstudio {
                        id: new_ws_id.clone(),
                        kind: ws.kind,
                        main_folder: new_main.clone(),
                        folders,
                        created_at: now,
                        updated_at: now,
                    };

                    let _ = Self::write_workstudio_marker(&PathBuf::from(&new_ws.main_folder), &new_ws);

                    cloned_workstudio_id = Some(new_ws_id);
                    workstudio_insert = Some((new_ws, folders_json));
                } else {
                    // Non-default: share workstudio id.
                    cloned_workstudio_id = Some(source_ws_id.to_string());
                }
            } else {
                cloned_workstudio_id = None;
            }
        }

        let new_conversation_id = uuid::Uuid::new_v4().to_string();
        let thinking_mode_json = source
            .thinking_mode
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let run_mode = source.run_mode.clone();

        let workstudio_id = cloned_workstudio_id;

        {
            let mut conn = self
                .conn
                .lock()
                .map_err(|e| StorageError::Lock(e.to_string()))?;

            let tx = conn.transaction()?;

            if let Some((ws, folders_json)) = workstudio_insert.as_ref() {
                let main_folder_key_raw = Self::workstudio_main_folder_key(&ws.main_folder);
                let main_folder_key = if main_folder_key_raw.trim().is_empty() {
                    format!("id:{}", ws.id)
                } else {
                    main_folder_key_raw
                };
                tx.execute(
                    "INSERT INTO workstudios (id, kind, main_folder, main_folder_key, folders_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        ws.id,
                        ws.kind,
                        ws.main_folder,
                        main_folder_key,
                        folders_json,
                        now_str,
                        now_str
                    ],
                )?;
            }

            tx.execute(
                "INSERT INTO conversations (id, title, model_id, agent_name, model_ref, system_prompt, system_prompt_cache_key, thinking_mode, run_mode, workstudio_id, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    new_conversation_id,
                    new_title,
                    source.agent_name,
                    source.model_ref,
                    source.system_prompt,
                    source.system_prompt_cache_key,
                    thinking_mode_json,
                    run_mode,
                    workstudio_id,
                    now_str,
                    now_str
                ],
            )?;

            for m in source_messages {
                let new_message_id = uuid::Uuid::new_v4().to_string();
                let role_str = match m.role {
                    MessageRole::User => "user",
                    MessageRole::Assistant => "assistant",
                    MessageRole::System => "system",
                    MessageRole::Tool => "tool",
                };

                let meta_json = m
                    .meta
                    .as_ref()
                    .map(|meta| serde_json::to_string(meta))
                    .transpose()?;
                let content_parts_json = if m.content_parts.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&m.content_parts)?)
                };

                let status_str = match m.status {
                    crate::models::MessageStatus::Pending => "pending",
                    crate::models::MessageStatus::Success => "success",
                    crate::models::MessageStatus::Failed => "failed",
                };

                tx.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, thinking, content_parts, meta, status, error_message, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        new_message_id,
                        new_conversation_id,
                        role_str,
                        m.content,
                        m.thinking,
                        content_parts_json,
                        meta_json,
                        status_str,
                        m.error_message,
                        m.created_at.to_rfc3339(),
                    ],
                )?;
            }

            tx.commit()?;
        }

        Ok(Conversation {
            id: new_conversation_id,
            title: new_title,
            agent_name: source.agent_name,
            model_ref: source.model_ref,
            system_prompt: source.system_prompt,
            system_prompt_cache_key: source.system_prompt_cache_key,
            thinking_mode: source.thinking_mode,
            run_mode: source.run_mode,
            workstudio_id,
            message_count: None,
            turn_count: None,
            last_message_at: None,
            primary_path: None,
            primary_path_kind: None,
            primary_path_pref: None,
            active_files: None,
            active_files_updated_at: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Get all conversations sorted by update time descending
    pub fn get_conversations(&self) -> Result<Vec<Conversation>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT
               c.id,
               c.title,
               c.agent_name,
               c.model_ref,
               c.system_prompt,
               c.system_prompt_cache_key,
               c.thinking_mode,
               c.run_mode,
               c.workstudio_id,
               c.primary_path,
               c.primary_path_kind,
               c.primary_path_pref,
               c.active_files,
               c.active_files_updated_at,
               c.created_at,
               c.updated_at,
               (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at,
               (SELECT COUNT(1) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
               (
                 SELECT COALESCE(
                   SUM(
                     CASE
                       WHEN m.meta IS NULL OR m.meta = '' THEN 0
                       WHEN json_valid(m.meta) = 0 THEN 0
                       ELSE COALESCE(json_array_length(json_extract(m.meta, '$.turns')), 0)
                     END
                   ),
                   0
                 )
                 FROM messages m
                 WHERE m.conversation_id = c.id
               ) AS turn_count
             FROM conversations c
             ORDER BY c.updated_at DESC",
        )?;

        let conversations = stmt
            .query_map([], |row| {
                let system_prompt: Option<String> = row.get(4)?;
                let system_prompt_cache_key: Option<String> = row.get(5)?;
                let thinking_mode_str: Option<String> = row.get(6)?;
                let run_mode: Option<String> = row.get(7)?;
                let workstudio_id: Option<String> = row.get(8)?;
                let primary_path: Option<String> = row.get(9)?;
                let primary_path_kind: Option<String> = row.get(10)?;
                let primary_path_pref: Option<String> = row.get(11)?;
                let active_files_str: Option<String> = row.get(12)?;
                let active_files_updated_at_str: Option<String> = row.get(13)?;
                let created_at_str: String = row.get(14)?;
                let updated_at_str: String = row.get(15)?;
                let last_message_at_str: Option<String> = row.get(16)?;
                let message_count_i64: i64 = row.get(17)?;
                let turn_count_i64: i64 = row.get(18)?;

                let thinking_mode: Option<serde_json::Value> = thinking_mode_str
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());

                let active_files = active_files_str
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());

                let active_files_updated_at = active_files_updated_at_str
                    .as_deref()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc));

                let last_message_at = last_message_at_str
                    .as_deref()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc));

                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    agent_name: row.get(2)?,
                    model_ref: row.get(3)?,
                    system_prompt,
                    system_prompt_cache_key,
                    thinking_mode,
                    run_mode,
                    workstudio_id,
                    message_count: u32::try_from(message_count_i64).ok(),
                    turn_count: u32::try_from(turn_count_i64).ok(),
                    last_message_at,
                    primary_path,
                    primary_path_kind,
                    primary_path_pref,
                    active_files,
                    active_files_updated_at,
                    created_at: DateTime::parse_from_rfc3339(&created_at_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                    updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(conversations)
    }

    /// Get a single conversation by ID
    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, title, agent_name, model_ref, system_prompt, system_prompt_cache_key, thinking_mode, run_mode, workstudio_id, primary_path, primary_path_kind, primary_path_pref, active_files, active_files_updated_at, created_at, updated_at 
             FROM conversations 
             WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;

        if let Some(row) = rows.next()? {
            let system_prompt: Option<String> = row.get(4)?;
            let system_prompt_cache_key: Option<String> = row.get(5)?;
            let thinking_mode_str: Option<String> = row.get(6)?;
            let run_mode: Option<String> = row.get(7)?;
            let workstudio_id: Option<String> = row.get(8)?;
            let primary_path: Option<String> = row.get(9)?;
            let primary_path_kind: Option<String> = row.get(10)?;
            let primary_path_pref: Option<String> = row.get(11)?;
            let active_files_str: Option<String> = row.get(12)?;
            let active_files_updated_at_str: Option<String> = row.get(13)?;
            let created_at_str: String = row.get(14)?;
            let updated_at_str: String = row.get(15)?;

            let thinking_mode: Option<serde_json::Value> = thinking_mode_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok());

            let active_files = active_files_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok());

            let active_files_updated_at = active_files_updated_at_str
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc));

            Ok(Some(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_name: row.get(2)?,
                model_ref: row.get(3)?,
                system_prompt,
                system_prompt_cache_key,
                thinking_mode,
                run_mode,
                workstudio_id,
                message_count: None,
                turn_count: None,
                last_message_at: None,
                primary_path,
                primary_path_kind,
                primary_path_pref,
                active_files,
                active_files_updated_at,
                created_at: DateTime::parse_from_rfc3339(&created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            }))
        } else {
            Ok(None)
        }
    }

    /// Update frozen system prompt for a conversation.
    pub fn update_conversation_system_prompt(
        &self,
        id: &str,
        system_prompt: &str,
        cache_key: Option<&str>,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE conversations SET system_prompt = ?1, system_prompt_cache_key = ?2, updated_at = ?3 WHERE id = ?4",
            params![system_prompt, cache_key, now, id],
        )?;
        Ok(())
    }

    /// Update conversation metadata (agent and model)
    pub fn update_conversation_metadata(
        &self,
        id: &str,
        agent_name: Option<&str>,
        model_ref: Option<&str>,
        thinking_mode: Option<&serde_json::Value>,
        run_mode: Option<&str>,
        workstudio_id: Option<&str>,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        // Update updated_at as well
        let now = Utc::now().to_rfc3339();

        let thinking_mode_json = thinking_mode
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| StorageError::Serialization(e.to_string()))?;

        conn.execute(
            "UPDATE conversations 
             SET agent_name = COALESCE(?1, agent_name),
                 model_ref = COALESCE(?2, model_ref),
                 thinking_mode = COALESCE(?3, thinking_mode),
                 run_mode = COALESCE(?4, run_mode),
                 workstudio_id = COALESCE(?5, workstudio_id),
                 updated_at = ?6 
             WHERE id = ?7",
            params![
                agent_name,
                model_ref,
                thinking_mode_json,
                run_mode,
                workstudio_id,
                now,
                id
            ],
        )?;

        Ok(())
    }

    /// Delete a conversation and all its messages
    pub fn delete_conversation(&self, id: &str) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        // Delete messages first (foreign key constraint)
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;

        // Delete conversation
        let rows_affected = conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;

        if rows_affected == 0 {
            return Err(StorageError::NotFound(format!(
                "Conversation {id} not found"
            )));
        }

        Ok(())
    }

    /// Update a conversation's title
    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let now = Utc::now().to_rfc3339();

        let rows_affected = conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;

        if rows_affected == 0 {
            return Err(StorageError::NotFound(format!(
                "Conversation {id} not found"
            )));
        }

        Ok(())
    }

    /// Get the latest message timestamp (created_at) for a conversation.
    pub fn get_conversation_latest_message_at(
        &self,
        conversation_id: &str,
    ) -> Result<Option<DateTime<Utc>>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT created_at
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC
             LIMIT 1",
        )?;

        let out: Option<String> = stmt
            .query_row(params![conversation_id], |row| row.get(0))
            .optional()?;

        Ok(out
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc)))
    }

    /// Persist conversation file index fields without touching `updated_at`.
    pub fn update_conversation_file_index(
        &self,
        conversation_id: &str,
        primary_path: Option<&str>,
        primary_path_kind: Option<&str>,
        primary_path_pref: Option<&str>,
        active_files_json: Option<&str>,
        active_files_updated_at: Option<DateTime<Utc>>,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let updated_at_str = active_files_updated_at.map(|dt| dt.to_rfc3339());

        conn.execute(
            "UPDATE conversations
             SET primary_path = ?1,
                 primary_path_kind = ?2,
                 primary_path_pref = ?3,
                 active_files = ?4,
                 active_files_updated_at = ?5
             WHERE id = ?6",
            params![
                primary_path,
                primary_path_kind,
                primary_path_pref,
                active_files_json,
                updated_at_str,
                conversation_id
            ],
        )?;

        Ok(())
    }

    // ==================== Workstudio Operations ====================

    fn workstudio_main_folder_key(input: &str) -> String {
        let raw = input.trim();
        if raw.is_empty() {
            return String::new();
        }

        let mut out = raw.replace('\\', "/");
        while out.contains("//") {
            out = out.replace("//", "/");
        }

        // Strip trailing slashes, except for drive roots like "C:/", and POSIX root "/".
        let is_drive_root = out.len() == 3
            && out.as_bytes()[0].is_ascii_alphabetic()
            && out.as_bytes()[1] == b':'
            && out.as_bytes()[2] == b'/';
        if !is_drive_root {
            while out.ends_with('/') && out.len() > 1 {
                out.pop();
            }
        }

        // Windows drive paths are case-insensitive; normalize to lowercase for stable identity.
        let is_drive_path = out.len() >= 3
            && out.as_bytes()[0].is_ascii_alphabetic()
            && out.as_bytes()[1] == b':'
            && out.as_bytes()[2] == b'/';
        if is_drive_path {
            out = out.to_lowercase();
        }

        out
    }

    fn backfill_workstudio_main_folder_keys(conn: &mut Connection) -> Result<(), StorageError> {
        let mut updates: Vec<(String, String)> = Vec::new();

        {
            let mut stmt = conn.prepare("SELECT id, main_folder, main_folder_key FROM workstudios")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;

            for row in rows {
                let (id, main_folder, existing_key) = row?;
                let computed_raw = Self::workstudio_main_folder_key(&main_folder);
                let computed = if computed_raw.is_empty() {
                    format!("id:{id}")
                } else {
                    computed_raw
                };
                let needs_update = match existing_key {
                    Some(k) => k.trim() != computed,
                    None => true,
                };
                if needs_update {
                    updates.push((id, computed));
                }
            }
        }

        if updates.is_empty() {
            return Ok(());
        }

        let tx = conn.transaction()?;
        for (id, key) in updates {
            tx.execute(
                "UPDATE workstudios SET main_folder_key = ?1 WHERE id = ?2",
                params![key, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn dedupe_workstudios_by_main_folder_key(conn: &mut Connection) -> Result<(), StorageError> {
        #[derive(Debug, Clone)]
        struct WsRow {
            id: String,
            main_folder: String,
            folders_json: String,
            created_at: String,
            key: String,
        }

        let rows: Vec<WsRow> = {
            let mut stmt = conn.prepare(
                "SELECT id, main_folder, folders_json, created_at, main_folder_key
                 FROM workstudios",
            )?;
            let iter = stmt.query_map([], |row| {
                Ok(WsRow {
                    id: row.get(0)?,
                    main_folder: row.get(1)?,
                    folders_json: row.get(2)?,
                    created_at: row.get(3)?,
                    key: row.get::<_, String>(4)?,
                })
            })?;

            let mut out: Vec<WsRow> = Vec::new();
            for r in iter {
                out.push(r?);
            }
            out
        };

        let mut groups: BTreeMap<String, Vec<WsRow>> = BTreeMap::new();
        for r in rows {
            let key = r.key.trim().to_string();
            if key.is_empty() {
                continue;
            }
            groups.entry(key).or_default().push(r);
        }

        let now_str = Utc::now().to_rfc3339();

        let tx = conn.transaction()?;

        for (key, mut list) in groups {
            if list.len() <= 1 {
                continue;
            }

            // Prefer the workstudio that is referenced by more conversations.
            // Tie-breaker: older created_at, then lexicographically smallest id (stable).
            let mut best_idx: usize = 0;
            let mut best_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM conversations WHERE workstudio_id = ?1",
                params![&list[0].id],
                |r| r.get(0),
            )?;

            for (idx, cand) in list.iter().enumerate().skip(1) {
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM conversations WHERE workstudio_id = ?1",
                    params![&cand.id],
                    |r| r.get(0),
                )?;
                let better = count > best_count
                    || (count == best_count && cand.created_at < list[best_idx].created_at)
                    || (count == best_count
                        && cand.created_at == list[best_idx].created_at
                        && cand.id < list[best_idx].id);
                if better {
                    best_idx = idx;
                    best_count = count;
                }
            }

            let best = list[best_idx].clone();
            let best_id = best.id.clone();
            let best_main_folder = best.main_folder.clone();

            // Merge folders (best-effort, stable order).
            list.sort_by(|a, b| a.id.cmp(&b.id));
            let mut merged: Vec<String> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            let mut push_unique = |p: &str| {
                let p = p.trim();
                if p.is_empty() {
                    return;
                }
                if seen.insert(p.to_string()) {
                    merged.push(p.to_string());
                }
            };

            // Ensure main folder is the first entry.
            push_unique(&best_main_folder);

            for r in list.iter() {
                let folders: Vec<String> = serde_json::from_str(&r.folders_json).unwrap_or_default();
                for f in folders {
                    push_unique(&f);
                }
            }

            // Keep main folder as first entry even if it appeared later.
            merged.retain(|f| f != &best_main_folder);
            merged.insert(0, best_main_folder.clone());

            let merged_json = serde_json::to_string(&merged)?;

            tx.execute(
                "UPDATE workstudios
                 SET main_folder = ?1,
                     main_folder_key = ?2,
                     folders_json = ?3,
                     updated_at = ?4
                 WHERE id = ?5",
                params![&best_main_folder, &key, &merged_json, &now_str, &best_id],
            )?;

            for r in list {
                if r.id == best_id {
                    continue;
                }
                let rid = r.id;
                tx.execute(
                    "UPDATE conversations SET workstudio_id = ?1 WHERE workstudio_id = ?2",
                    params![&best_id, &rid],
                )?;
                tx.execute("DELETE FROM workstudios WHERE id = ?1", params![&rid])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    fn default_workstudio_main_folder(id: &str) -> Result<PathBuf, StorageError> {
        let home_dir = dirs::home_dir()
            .ok_or_else(|| StorageError::Io("Home directory not found".to_string()))?;
        Ok(home_dir.join(".tauri-ai").join("workstudios").join(id))
    }

    fn write_workstudio_marker(main_folder: &PathBuf, ws: &Workstudio) -> Result<(), StorageError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Marker<'a> {
            id: &'a str,
            kind: &'a str,
            main_folder: &'a str,
            folders: &'a [String],
        }

        let meta_dir = main_folder.join(".tauriai");
        std::fs::create_dir_all(&meta_dir)
            .map_err(|e| StorageError::Io(format!("create .tauriai failed: {e}")))?;

        let marker = Marker {
            id: &ws.id,
            kind: &ws.kind,
            main_folder: &ws.main_folder,
            folders: &ws.folders,
        };
        let json = serde_json::to_string_pretty(&marker)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        std::fs::write(meta_dir.join("workstudio.json"), json)
            .map_err(|e| StorageError::Io(format!("write workstudio.json failed: {e}")))?;
        Ok(())
    }

    pub fn get_workstudio(&self, id: &str) -> Result<Option<Workstudio>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, kind, main_folder, folders_json, created_at, updated_at
             FROM workstudios
             WHERE id = ?1",
        )?;

        let row = stmt
            .query_row(params![id], |row| {
                let folders_json: String = row.get(3)?;
                let folders: Vec<String> =
                    serde_json::from_str(&folders_json).unwrap_or_else(|_| Vec::new());
                Ok(Workstudio {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    main_folder: row.get(2)?,
                    folders,
                    created_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                    updated_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                })
            })
            .optional()?;

        Ok(row)
    }

    /// Ensure a workstudio exists for a conversation.
    ///
    /// - If the conversation already binds to a workstudio, returns it.
    /// - Otherwise creates a new workstudio with a default main folder under `~/.tauri-ai/workstudios/<id>`,
    ///   binds the conversation to it, and writes `.tauriai/workstudio.json` in the main folder.
    pub fn ensure_workstudio_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Workstudio, StorageError> {
        // 1) Check conversation existence + current binding (lock scope kept small to avoid re-entrant locks).
        let existing_id_opt: Option<String> = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| StorageError::Lock(e.to_string()))?;

            let row: Option<Option<String>> = conn
                .query_row(
                    "SELECT workstudio_id FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |r| r.get(0),
                )
                .optional()?;

            let Some(existing_id_opt) = row else {
                return Err(StorageError::NotFound(format!(
                    "Conversation {conversation_id} not found"
                )));
            };

            existing_id_opt
        };

        if let Some(existing_id) = existing_id_opt {
            if let Some(ws) = self.get_workstudio(&existing_id)? {
                return Ok(ws);
            }
            // Broken binding (workstudio row missing): fall through and recreate.
        }

        // 2) Create new workstudio + default folder
        let id = uuid::Uuid::new_v4().to_string();
        let main_folder_path = Self::default_workstudio_main_folder(&id)?;
        std::fs::create_dir_all(&main_folder_path)
            .map_err(|e| StorageError::Io(format!("create workstudio folder failed: {e}")))?;

        let main_folder = main_folder_path.to_string_lossy().to_string();
        let main_folder_key_raw = Self::workstudio_main_folder_key(&main_folder);
        let main_folder_key = if main_folder_key_raw.trim().is_empty() {
            format!("id:{id}")
        } else {
            main_folder_key_raw
        };
        let folders = vec![main_folder.clone()];
        let folders_json = serde_json::to_string(&folders)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;

        let now = Utc::now();
        let now_str = now.to_rfc3339();

        {
            let conn = self
                .conn
                .lock()
                .map_err(|e| StorageError::Lock(e.to_string()))?;

            conn.execute(
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

            conn.execute(
                "UPDATE conversations
                 SET workstudio_id = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![id, now_str, conversation_id],
            )?;
        }

        let ws = Workstudio {
            id,
            kind: "code".to_string(),
            main_folder: main_folder_path.to_string_lossy().to_string(),
            folders,
            created_at: now,
            updated_at: now,
        };

        // Best-effort: marker file lives in the main folder, for quick bootstrap.
        let _ = Self::write_workstudio_marker(&main_folder_path, &ws);

        Ok(ws)
    }

    /// Create a standalone workstudio (not bound to any conversation).
    ///
    /// Useful for testing multi-window routing and as a building block for
    /// future "open workstudio" flows that don't start from a chat session.
    pub fn create_workstudio(&self) -> Result<Workstudio, StorageError> {
        let id = uuid::Uuid::new_v4().to_string();
        let main_folder_path = Self::default_workstudio_main_folder(&id)?;
        std::fs::create_dir_all(&main_folder_path)
            .map_err(|e| StorageError::Io(format!("create workstudio folder failed: {e}")))?;

        let main_folder = main_folder_path.to_string_lossy().to_string();
        let main_folder_key_raw = Self::workstudio_main_folder_key(&main_folder);
        let main_folder_key = if main_folder_key_raw.trim().is_empty() {
            format!("id:{id}")
        } else {
            main_folder_key_raw
        };
        let folders = vec![main_folder.clone()];
        let folders_json = serde_json::to_string(&folders)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;

        let now = Utc::now();
        let now_str = now.to_rfc3339();

        {
            let conn = self
                .conn
                .lock()
                .map_err(|e| StorageError::Lock(e.to_string()))?;

            conn.execute(
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
        }

        let ws = Workstudio {
            id,
            kind: "code".to_string(),
            main_folder: main_folder_path.to_string_lossy().to_string(),
            folders,
            created_at: now,
            updated_at: now,
        };

        let _ = Self::write_workstudio_marker(&main_folder_path, &ws);
        Ok(ws)
    }

    pub fn add_workstudio_folder(
        &self,
        workstudio_id: &str,
        folder: &str,
        set_as_main: bool,
    ) -> Result<Workstudio, StorageError> {
        let folder = folder.trim();
        if folder.is_empty() {
            return Err(StorageError::Serialization("folder is empty".to_string()));
        }

        let folder_path = PathBuf::from(folder);
        if !folder_path.exists() {
            std::fs::create_dir_all(&folder_path)
                .map_err(|e| StorageError::Io(format!("create folder failed: {e}")))?;
        }

        let mut ws = self.get_workstudio(workstudio_id)?.ok_or_else(|| {
            StorageError::NotFound(format!("Workstudio {workstudio_id} not found"))
        })?;

        let folder_str = folder_path.to_string_lossy().to_string();

        // If the workstudio only has the system default folder (auto-created under ~/.tauri-ai)
        // and the user adds another folder, promote the user folder to main and drop the default.
        // This matches the "user workspace overrides system workspace" UX.
        let mut effective_set_as_main = set_as_main;
        let default_main = Self::default_workstudio_main_folder(workstudio_id)?
            .to_string_lossy()
            .to_string();
        if ws.main_folder == default_main && folder_str != default_main {
            effective_set_as_main = true;
            ws.folders.retain(|f| f != &default_main);
        }
        if !ws.folders.iter().any(|f| f == &folder_str) {
            ws.folders.push(folder_str.clone());
        }

        if effective_set_as_main {
            ws.main_folder = folder_str.clone();
            // Keep main folder as the first entry.
            ws.folders.retain(|f| f != &folder_str);
            ws.folders.insert(0, folder_str.clone());
        }

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        ws.updated_at = now;

        let folders_json = serde_json::to_string(&ws.folders)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        let main_folder_key_raw = Self::workstudio_main_folder_key(&ws.main_folder);
        let main_folder_key = if main_folder_key_raw.trim().is_empty() {
            format!("id:{workstudio_id}")
        } else {
            main_folder_key_raw
        };

        let mut conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let tx = conn.transaction()?;

        // If another workstudio already owns this main folder key, merge into it and
        // rebind all conversations from the current workstudio id.
        if !main_folder_key.trim().is_empty() {
            let existing_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM workstudios WHERE main_folder_key = ?1 AND id != ?2 LIMIT 1",
                    params![&main_folder_key, workstudio_id],
                    |r| r.get(0),
                )
                .optional()?;

            if let Some(target_id) = existing_id {
                let (target_kind, target_main_folder, target_folders_json, target_created_at_str): (
                    String,
                    String,
                    String,
                    String,
                ) = tx.query_row(
                    "SELECT kind, main_folder, folders_json, created_at FROM workstudios WHERE id = ?1",
                    params![&target_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;

                let mut merged: Vec<String> = Vec::new();
                let mut seen: HashSet<String> = HashSet::new();
                let mut push_unique = |p: &str| {
                    let p = p.trim();
                    if p.is_empty() {
                        return;
                    }
                    if seen.insert(p.to_string()) {
                        merged.push(p.to_string());
                    }
                };

                push_unique(&target_main_folder);
                for f in serde_json::from_str::<Vec<String>>(&target_folders_json).unwrap_or_default() {
                    push_unique(&f);
                }
                for f in ws.folders.iter() {
                    push_unique(f);
                }
                merged.retain(|f| f != &target_main_folder);
                merged.insert(0, target_main_folder.clone());

                let merged_json = serde_json::to_string(&merged)?;

                tx.execute(
                    "UPDATE workstudios SET folders_json = ?1, updated_at = ?2 WHERE id = ?3",
                    params![&merged_json, &now_str, &target_id],
                )?;
                tx.execute(
                    "UPDATE conversations SET workstudio_id = ?1 WHERE workstudio_id = ?2",
                    params![&target_id, workstudio_id],
                )?;
                tx.execute("DELETE FROM workstudios WHERE id = ?1", params![workstudio_id])?;

                tx.commit()?;

                let created_at = DateTime::parse_from_rfc3339(&target_created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| now);

                let out = Workstudio {
                    id: target_id,
                    kind: target_kind,
                    main_folder: target_main_folder,
                    folders: merged,
                    created_at,
                    updated_at: now,
                };

                let _ = Self::write_workstudio_marker(&PathBuf::from(&out.main_folder), &out);
                return Ok(out);
            }
        }

        tx.execute(
            "UPDATE workstudios
             SET main_folder = ?1,
                 main_folder_key = ?2,
                 folders_json = ?3,
                 updated_at = ?4
             WHERE id = ?5",
            params![&ws.main_folder, &main_folder_key, &folders_json, &now_str, workstudio_id],
        )?;

        tx.commit()?;

        // Best-effort: marker file in (new) main folder.
        let _ = Self::write_workstudio_marker(&PathBuf::from(&ws.main_folder), &ws);

        Ok(ws)
    }

    pub fn set_workstudio_main_folder(
        &self,
        workstudio_id: &str,
        folder: &str,
    ) -> Result<Workstudio, StorageError> {
        let folder = folder.trim();
        if folder.is_empty() {
            return Err(StorageError::Serialization("folder is empty".to_string()));
        }

        let mut ws = self.get_workstudio(workstudio_id)?.ok_or_else(|| {
            StorageError::NotFound(format!("Workstudio {workstudio_id} not found"))
        })?;

        if !ws.folders.iter().any(|f| f == folder) {
            return Err(StorageError::NotFound(format!(
                "Folder not found in workstudio: {folder}"
            )));
        }

        ws.main_folder = folder.to_string();
        ws.folders.retain(|f| f != folder);
        ws.folders.insert(0, folder.to_string());

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        ws.updated_at = now;

        let folders_json = serde_json::to_string(&ws.folders)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        let main_folder_key_raw = Self::workstudio_main_folder_key(&ws.main_folder);
        let main_folder_key = if main_folder_key_raw.trim().is_empty() {
            format!("id:{workstudio_id}")
        } else {
            main_folder_key_raw
        };

        let mut conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let tx = conn.transaction()?;

        if !main_folder_key.trim().is_empty() {
            let existing_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM workstudios WHERE main_folder_key = ?1 AND id != ?2 LIMIT 1",
                    params![&main_folder_key, workstudio_id],
                    |r| r.get(0),
                )
                .optional()?;

            if let Some(target_id) = existing_id {
                let (target_kind, target_main_folder, target_folders_json, target_created_at_str): (
                    String,
                    String,
                    String,
                    String,
                ) = tx.query_row(
                    "SELECT kind, main_folder, folders_json, created_at FROM workstudios WHERE id = ?1",
                    params![&target_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;

                let mut merged: Vec<String> = Vec::new();
                let mut seen: HashSet<String> = HashSet::new();
                let mut push_unique = |p: &str| {
                    let p = p.trim();
                    if p.is_empty() {
                        return;
                    }
                    if seen.insert(p.to_string()) {
                        merged.push(p.to_string());
                    }
                };

                push_unique(&target_main_folder);
                for f in serde_json::from_str::<Vec<String>>(&target_folders_json).unwrap_or_default() {
                    push_unique(&f);
                }
                for f in ws.folders.iter() {
                    push_unique(f);
                }
                merged.retain(|f| f != &target_main_folder);
                merged.insert(0, target_main_folder.clone());

                let merged_json = serde_json::to_string(&merged)?;

                tx.execute(
                    "UPDATE workstudios SET folders_json = ?1, updated_at = ?2 WHERE id = ?3",
                    params![&merged_json, &now_str, &target_id],
                )?;
                tx.execute(
                    "UPDATE conversations SET workstudio_id = ?1 WHERE workstudio_id = ?2",
                    params![&target_id, workstudio_id],
                )?;
                tx.execute("DELETE FROM workstudios WHERE id = ?1", params![workstudio_id])?;

                tx.commit()?;

                let created_at = DateTime::parse_from_rfc3339(&target_created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| now);

                let out = Workstudio {
                    id: target_id,
                    kind: target_kind,
                    main_folder: target_main_folder,
                    folders: merged,
                    created_at,
                    updated_at: now,
                };
                let _ = Self::write_workstudio_marker(&PathBuf::from(&out.main_folder), &out);
                return Ok(out);
            }
        }

        tx.execute(
            "UPDATE workstudios
             SET main_folder = ?1,
                 main_folder_key = ?2,
                 folders_json = ?3,
                 updated_at = ?4
             WHERE id = ?5",
            params![&ws.main_folder, &main_folder_key, &folders_json, &now_str, workstudio_id],
        )?;

        tx.commit()?;

        let _ = Self::write_workstudio_marker(&PathBuf::from(&ws.main_folder), &ws);
        Ok(ws)
    }

    pub fn remove_workstudio_folder(
        &self,
        workstudio_id: &str,
        folder: &str,
    ) -> Result<Workstudio, StorageError> {
        let folder = folder.trim();
        if folder.is_empty() {
            return Err(StorageError::Serialization("folder is empty".to_string()));
        }

        let mut ws = self.get_workstudio(workstudio_id)?.ok_or_else(|| {
            StorageError::NotFound(format!("Workstudio {workstudio_id} not found"))
        })?;

        if ws.folders.len() <= 1 {
            return Err(StorageError::Serialization(
                "cannot remove the last folder".to_string(),
            ));
        }

        if !ws.folders.iter().any(|f| f == folder) {
            return Err(StorageError::NotFound(format!(
                "Folder not found in workstudio: {folder}"
            )));
        }

        ws.folders.retain(|f| f != folder);
        if ws.main_folder == folder {
            ws.main_folder = ws.folders.first().cloned().ok_or_else(|| {
                StorageError::Serialization("workstudio has no folders".to_string())
            })?;
        }

        // Keep main folder as the first entry.
        let main = ws.main_folder.clone();
        ws.folders.retain(|f| f != &main);
        ws.folders.insert(0, main.clone());

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        ws.updated_at = now;

        let folders_json = serde_json::to_string(&ws.folders)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        let main_folder_key_raw = Self::workstudio_main_folder_key(&ws.main_folder);
        let main_folder_key = if main_folder_key_raw.trim().is_empty() {
            format!("id:{workstudio_id}")
        } else {
            main_folder_key_raw
        };

        let mut conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let tx = conn.transaction()?;

        if !main_folder_key.trim().is_empty() {
            let existing_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM workstudios WHERE main_folder_key = ?1 AND id != ?2 LIMIT 1",
                    params![&main_folder_key, workstudio_id],
                    |r| r.get(0),
                )
                .optional()?;

            if let Some(target_id) = existing_id {
                let (target_kind, target_main_folder, target_folders_json, target_created_at_str): (
                    String,
                    String,
                    String,
                    String,
                ) = tx.query_row(
                    "SELECT kind, main_folder, folders_json, created_at FROM workstudios WHERE id = ?1",
                    params![&target_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;

                let mut merged: Vec<String> = Vec::new();
                let mut seen: HashSet<String> = HashSet::new();
                let mut push_unique = |p: &str| {
                    let p = p.trim();
                    if p.is_empty() {
                        return;
                    }
                    if seen.insert(p.to_string()) {
                        merged.push(p.to_string());
                    }
                };

                push_unique(&target_main_folder);
                for f in serde_json::from_str::<Vec<String>>(&target_folders_json).unwrap_or_default() {
                    push_unique(&f);
                }
                for f in ws.folders.iter() {
                    push_unique(f);
                }
                merged.retain(|f| f != &target_main_folder);
                merged.insert(0, target_main_folder.clone());

                let merged_json = serde_json::to_string(&merged)?;

                tx.execute(
                    "UPDATE workstudios SET folders_json = ?1, updated_at = ?2 WHERE id = ?3",
                    params![&merged_json, &now_str, &target_id],
                )?;
                tx.execute(
                    "UPDATE conversations SET workstudio_id = ?1 WHERE workstudio_id = ?2",
                    params![&target_id, workstudio_id],
                )?;
                tx.execute("DELETE FROM workstudios WHERE id = ?1", params![workstudio_id])?;

                tx.commit()?;

                let created_at = DateTime::parse_from_rfc3339(&target_created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| now);

                let out = Workstudio {
                    id: target_id,
                    kind: target_kind,
                    main_folder: target_main_folder,
                    folders: merged,
                    created_at,
                    updated_at: now,
                };
                let _ = Self::write_workstudio_marker(&PathBuf::from(&out.main_folder), &out);
                return Ok(out);
            }
        }

        tx.execute(
            "UPDATE workstudios
             SET main_folder = ?1,
                 main_folder_key = ?2,
                 folders_json = ?3,
                 updated_at = ?4
             WHERE id = ?5",
            params![&ws.main_folder, &main_folder_key, &folders_json, &now_str, workstudio_id],
        )?;

        tx.commit()?;

        let _ = Self::write_workstudio_marker(&PathBuf::from(&ws.main_folder), &ws);
        Ok(ws)
    }

    // ==================== Workstudio State (UI) ====================

    pub fn get_workstudio_ui_state(
        &self,
        main_folder: &str,
        kind: &str,
    ) -> Result<Option<WorkstudioUiState>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT state_json
             FROM workstudio_states
             WHERE main_folder = ?1 AND kind = ?2",
        )?;

        let row: Option<String> = stmt
            .query_row(params![main_folder, kind], |r| r.get(0))
            .optional()?;

        let Some(json) = row else {
            return Ok(None);
        };

        let parsed: WorkstudioUiState =
            serde_json::from_str(&json).map_err(|e| StorageError::Serialization(e.to_string()))?;
        Ok(Some(parsed))
    }

    pub fn set_workstudio_ui_state(
        &self,
        main_folder: &str,
        kind: &str,
        state: &WorkstudioUiState,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let now_str = Utc::now().to_rfc3339();
        let json =
            serde_json::to_string(state).map_err(|e| StorageError::Serialization(e.to_string()))?;

        conn.execute(
            "INSERT INTO workstudio_states (main_folder, kind, state_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(main_folder, kind) DO UPDATE
               SET state_json = excluded.state_json,
                   updated_at = excluded.updated_at",
            params![main_folder, kind, json, now_str],
        )?;

        Ok(())
    }

    // ==================== Workstudio Symbol Analysis (AI) ====================

    pub fn get_workstudio_symbol_analysis(
        &self,
        workstudio_id: &str,
        file_path: &str,
        symbol_key: &str,
    ) -> Result<Option<WorkstudioSymbolAnalysis>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT
                id,
                workstudio_id,
                file_path,
                language_id,
                symbol_key,
                symbol_name,
                symbol_kind,
                selection_line,
                selection_column,
                range_start_line,
                range_start_column,
                range_end_line,
                range_end_column,
                answer_md,
                model_ref,
                latency_ms,
                created_at,
                updated_at
             FROM workstudio_symbol_analyses
             WHERE workstudio_id = ?1 AND file_path = ?2 AND symbol_key = ?3",
        )?;

        let row = stmt
            .query_row(params![workstudio_id, file_path, symbol_key], |r| {
                let created_at_str: String = r.get(16)?;
                let updated_at_str: String = r.get(17)?;

                let selection_line: i64 = r.get(7)?;
                let selection_column: i64 = r.get(8)?;
                let start_line: i64 = r.get(9)?;
                let start_column: i64 = r.get(10)?;
                let end_line: i64 = r.get(11)?;
                let end_column: i64 = r.get(12)?;

                Ok(WorkstudioSymbolAnalysis {
                    id: r.get(0)?,
                    workstudio_id: r.get(1)?,
                    file_path: r.get(2)?,
                    language_id: r.get(3)?,
                    symbol_key: r.get(4)?,
                    symbol_name: r.get(5)?,
                    symbol_kind: r.get(6)?,
                    selection_line: selection_line.max(0) as u32,
                    selection_column: selection_column.max(0) as u32,
                    range: CodeSnippetRange {
                        start_line: start_line.max(0) as u32,
                        start_column: start_column.max(0) as u32,
                        end_line: end_line.max(0) as u32,
                        end_column: end_column.max(0) as u32,
                    },
                    answer_md: r.get(13)?,
                    model_ref: r.get(14)?,
                    latency_ms: r.get::<_, Option<i64>>(15)?.map(|v| v.max(0) as u64),
                    created_at: DateTime::parse_from_rfc3339(&created_at_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                    updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                })
            })
            .optional()?;

        Ok(row)
    }

    pub fn upsert_workstudio_symbol_analysis(
        &self,
        workstudio_id: &str,
        file_path: &str,
        language_id: &str,
        symbol_key: &str,
        symbol_name: &str,
        symbol_kind: &str,
        selection_line: u32,
        selection_column: u32,
        range: &CodeSnippetRange,
        answer_md: &str,
        model_ref: Option<&str>,
        latency_ms: Option<u64>,
    ) -> Result<WorkstudioSymbolAnalysis, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO workstudio_symbol_analyses (
                id,
                workstudio_id,
                file_path,
                language_id,
                symbol_key,
                symbol_name,
                symbol_kind,
                selection_line,
                selection_column,
                range_start_line,
                range_start_column,
                range_end_line,
                range_end_column,
                answer_md,
                model_ref,
                latency_ms,
                created_at,
                updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
            )
            ON CONFLICT(workstudio_id, file_path, symbol_key) DO UPDATE
              SET language_id = excluded.language_id,
                  symbol_name = excluded.symbol_name,
                  symbol_kind = excluded.symbol_kind,
                  selection_line = excluded.selection_line,
                  selection_column = excluded.selection_column,
                  range_start_line = excluded.range_start_line,
                  range_start_column = excluded.range_start_column,
                  range_end_line = excluded.range_end_line,
                  range_end_column = excluded.range_end_column,
                  answer_md = excluded.answer_md,
                  model_ref = excluded.model_ref,
                  latency_ms = excluded.latency_ms,
                  updated_at = excluded.updated_at",
            params![
                id,
                workstudio_id,
                file_path,
                language_id,
                symbol_key,
                symbol_name,
                symbol_kind,
                selection_line as i64,
                selection_column as i64,
                range.start_line as i64,
                range.start_column as i64,
                range.end_line as i64,
                range.end_column as i64,
                answer_md,
                model_ref,
                latency_ms.map(|v| v as i64),
                now_str,
                now_str,
            ],
        )?;

        self.get_workstudio_symbol_analysis(workstudio_id, file_path, symbol_key)?
            .ok_or_else(|| StorageError::NotFound("workstudio_symbol_analysis missing after upsert".to_string()))
    }

    pub fn delete_workstudio_symbol_analysis(
        &self,
        workstudio_id: &str,
        file_path: &str,
        symbol_key: &str,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        conn.execute(
            "DELETE FROM workstudio_symbol_analyses
             WHERE workstudio_id = ?1 AND file_path = ?2 AND symbol_key = ?3",
            params![workstudio_id, file_path, symbol_key],
        )?;
        Ok(())
    }

    // ==================== Message Operations ====================

    /// Add a message to a conversation
    pub fn add_message(
        &self,
        conversation_id: &str,
        message: &Message,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let role_str = match message.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
            MessageRole::Tool => "tool",
        };

        let meta_json = message
            .meta
            .as_ref()
            .map(|m| serde_json::to_string(m))
            .transpose()?;

        // Serialize content_parts if not empty
        let content_parts_json = if message.content_parts.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&message.content_parts)?)
        };

        let created_at_str = message.created_at.to_rfc3339();

        let status_str = match message.status {
            crate::models::MessageStatus::Pending => "pending",
            crate::models::MessageStatus::Success => "success",
            crate::models::MessageStatus::Failed => "failed",
        };

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, thinking, content_parts, meta, status, error_message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                message.id,
                conversation_id,
                role_str,
                message.content,
                message.thinking,
                content_parts_json,
                meta_json,
                status_str,
                message.error_message,
                created_at_str
            ],
        )?;

        // Update conversation's updated_at timestamp
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;

        Ok(())
    }

    pub fn update_message(&self, message: &Message) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let status_str = match message.status {
            crate::models::MessageStatus::Pending => "pending",
            crate::models::MessageStatus::Success => "success",
            crate::models::MessageStatus::Failed => "failed",
        };

        let meta_json = message
            .meta
            .as_ref()
            .map(|m| serde_json::to_string(m))
            .transpose()?;

        conn.execute(
            "UPDATE messages SET content = ?1, thinking = ?2, meta = ?3, status = ?4, error_message = ?5 WHERE id = ?6",
            params![
                message.content,
                message.thinking,
                meta_json,
                status_str,
                message.error_message,
                message.id
            ],
        )?;

        // Touch conversation updated_at for any message edits (e.g. manual retry overwriting a bubble).
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, message.conversation_id],
        )?;

        Ok(())
    }

    pub fn update_message_status(
        &self,
        id: &str,
        status: crate::models::MessageStatus,
        error_message: Option<String>,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let status_str = match status {
            crate::models::MessageStatus::Pending => "pending",
            crate::models::MessageStatus::Success => "success",
            crate::models::MessageStatus::Failed => "failed",
        };

        conn.execute(
            "UPDATE messages SET status = ?1, error_message = ?2 WHERE id = ?3",
            params![status_str, error_message, id],
        )?;

        Ok(())
    }

    pub fn update_message_content(&self, id: &str, content: &str) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        conn.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2",
            params![content, id],
        )?;

        Ok(())
    }

    /// Delete a message and all subsequent messages in a conversation
    /// Used for "undo" functionality
    pub fn delete_messages_after(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        // First find the created_at of the target message
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM messages WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |row| row.get(0),
            )
            .map_err(|_| {
                StorageError::NotFound(format!(
                    "Message {} not found in conversation {}",
                    message_id, conversation_id
                ))
            })?;

        // Delete the target message and all messages created after it in this conversation
        // Using created_at comparison is safer than assuming order
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND created_at >= ?2",
            params![conversation_id, created_at],
        )?;

        Ok(())
    }

    /// Delete messages by id list (conversation-scoped).
    ///
    /// Used by context compaction to replace old history with a summary message.
    pub fn delete_messages_by_ids(
        &self,
        conversation_id: &str,
        ids: &[String],
    ) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        // SQLite has a limit on bound parameters (commonly 999). Chunk to be safe.
        const CHUNK: usize = 400;
        for chunk in ids.chunks(CHUNK) {
            let mut sql =
                String::from("DELETE FROM messages WHERE conversation_id = ?1 AND id IN (");
            for i in 0..chunk.len() {
                if i > 0 {
                    sql.push(',');
                }
                // bind placeholders start at ?2 because ?1 is conversation_id
                sql.push_str(&format!("?{}", i + 2));
            }
            sql.push(')');

            let params_iter =
                std::iter::once(conversation_id.to_string()).chain(chunk.iter().cloned());
            conn.execute(&sql, rusqlite::params_from_iter(params_iter))?;
        }

        // Update conversation's updated_at timestamp
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;

        Ok(())
    }

    /// Get messages for a conversation with pagination
    ///
    /// # Arguments
    /// * `conversation_id` - The conversation to get messages from
    /// * `limit` - Maximum number of messages to return
    /// * `before_id` - If provided, only return messages created before this message ID
    pub fn get_messages(
        &self,
        conversation_id: &str,
        limit: usize,
        before_id: Option<&str>,
    ) -> Result<Vec<Message>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let messages = if let Some(before) = before_id {
            // Get the created_at of the before_id message
            let mut before_stmt = conn.prepare("SELECT created_at FROM messages WHERE id = ?1")?;
            let before_created_at: Option<String> = before_stmt
                .query_row(params![before], |row| row.get(0))
                .ok();

            if let Some(before_time) = before_created_at {
                let mut stmt = conn.prepare(
                    "SELECT id, conversation_id, role, content, thinking, content_parts, meta, created_at, status, error_message 
                     FROM messages 
                     WHERE conversation_id = ?1 AND created_at < ?2
                     ORDER BY created_at DESC
                     LIMIT ?3",
                )?;

                let msgs: Vec<Message> = stmt
                    .query_map(params![conversation_id, before_time, limit as i64], |row| {
                        self.row_to_message(row)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;

                // Reverse to get chronological order
                msgs.into_iter().rev().collect()
            } else {
                Vec::new()
            }
        } else {
            // Get the most recent messages
            let mut stmt = conn.prepare(
                "SELECT id, conversation_id, role, content, thinking, content_parts, meta, created_at, status, error_message 
                 FROM messages 
                 WHERE conversation_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;

            let msgs: Vec<Message> = stmt
                .query_map(params![conversation_id, limit as i64], |row| {
                    self.row_to_message(row)
                })?
                .collect::<Result<Vec<_>, _>>()?;

            // Reverse to get chronological order
            msgs.into_iter().rev().collect()
        };

        Ok(messages)
    }

    /// Get all messages for a conversation in chronological order.
    ///
    /// NOTE: This can be large. Prefer `get_messages` for normal UI pagination.
    pub fn get_all_messages(&self, conversation_id: &str) -> Result<Vec<Message>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, thinking, content_parts, meta, created_at, status, error_message
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC",
        )?;

        let msgs: Vec<Message> = stmt
            .query_map(params![conversation_id], |row| self.row_to_message(row))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(msgs)
    }

    /// Get the latest message in a conversation whose `content` contains the given marker.
    ///
    /// This is used for locating persisted context compaction summaries without scanning the whole table.
    pub fn get_latest_message_containing(
        &self,
        conversation_id: &str,
        marker: &str,
    ) -> Result<Option<Message>, StorageError> {
        if marker.trim().is_empty() {
            return Ok(None);
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let like = format!("%{}%", marker);
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, thinking, content_parts, meta, created_at, status, error_message
             FROM messages
             WHERE conversation_id = ?1 AND content LIKE ?2
             ORDER BY created_at DESC
             LIMIT 1",
        )?;

        let row = stmt
            .query_row(params![conversation_id, like], |row| {
                self.row_to_message(row)
            })
            .optional()?;

        Ok(row)
    }

    /// Get a single message by id within a conversation.
    pub fn get_message(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Message, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, thinking, content_parts, meta, created_at, status, error_message
             FROM messages
             WHERE conversation_id = ?1 AND id = ?2
             LIMIT 1",
        )?;

        let msg = stmt
            .query_row(params![conversation_id, message_id], |row| {
                self.row_to_message(row)
            })
            .optional()?;

        msg.ok_or_else(|| {
            StorageError::NotFound(format!(
                "Message {} not found in conversation {}",
                message_id, conversation_id
            ))
        })
    }

    /// Helper function to convert a database row to a Message
    fn row_to_message(&self, row: &rusqlite::Row) -> Result<Message, rusqlite::Error> {
        let role_str: String = row.get(2)?;
        let thinking: Option<String> = row.get(4)?;
        let content_parts_json: Option<String> = row.get(5)?;
        let meta_json: Option<String> = row.get(6)?;
        let created_at_str: String = row.get(7)?;
        let status_str: String = row.get(8).unwrap_or_else(|_| "success".to_string());
        let error_message: Option<String> = row.get(9).ok();

        let role = match role_str.as_str() {
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            "system" => MessageRole::System,
            "tool" => MessageRole::Tool,
            _ => MessageRole::User,
        };

        let status = match status_str.as_str() {
            "pending" => crate::models::MessageStatus::Pending,
            "failed" => crate::models::MessageStatus::Failed,
            _ => crate::models::MessageStatus::Success,
        };

        let meta = meta_json.and_then(|json| serde_json::from_str(&json).ok());

        // Parse content_parts if present
        let content_parts: Vec<ContentPart> = content_parts_json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        let created_at = DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());

        Ok(Message {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            role,
            content: row.get(3)?,
            content_parts,
            thinking,
            meta,
            created_at,
            status,
            error_message,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MessageMeta;
    use serde_json::json;

    #[test]
    fn test_database_initialization() {
        let db = Database::new_in_memory().expect("Failed to create database");

        // Verify tables exist by trying to query them
        let conversations = db.get_conversations().expect("Failed to get conversations");
        assert!(conversations.is_empty());
    }

    #[test]
    fn test_create_and_get_conversation() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("Test Conversation")
            .expect("Failed to create conversation");
        assert_eq!(conv.title, "Test Conversation");
        assert!(!conv.id.is_empty());

        let retrieved = db
            .get_conversation(&conv.id)
            .expect("Failed to get conversation");
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id, conv.id);
        assert_eq!(retrieved.title, "Test Conversation");
    }

    #[test]
    fn test_get_conversations_sorted() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv1 = db
            .create_conversation("First")
            .expect("Failed to create conversation");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let conv2 = db
            .create_conversation("Second")
            .expect("Failed to create conversation");

        let conversations = db.get_conversations().expect("Failed to get conversations");
        assert_eq!(conversations.len(), 2);
        // Most recently updated should be first
        assert_eq!(conversations[0].id, conv2.id);
        assert_eq!(conversations[1].id, conv1.id);
    }

    #[test]
    fn test_delete_conversation() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("To Delete")
            .expect("Failed to create conversation");
        db.delete_conversation(&conv.id)
            .expect("Failed to delete conversation");

        let retrieved = db
            .get_conversation(&conv.id)
            .expect("Failed to get conversation");
        assert!(retrieved.is_none());
    }

    #[test]
    fn test_update_conversation_title() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("Original Title")
            .expect("Failed to create conversation");
        db.update_conversation_title(&conv.id, "Updated Title")
            .expect("Failed to update title");

        let retrieved = db
            .get_conversation(&conv.id)
            .expect("Failed to get conversation")
            .unwrap();
        assert_eq!(retrieved.title, "Updated Title");
    }

    #[test]
    fn test_add_and_get_messages() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("Test")
            .expect("Failed to create conversation");

        let msg = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv.id.clone(),
            role: MessageRole::User,
            content: "Hello, world!".to_string(),
            content_parts: Vec::new(),
            thinking: Some("test thinking".to_string()),
            meta: None,
            created_at: Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        db.add_message(&conv.id, &msg)
            .expect("Failed to add message");

        let messages = db
            .get_messages(&conv.id, 10, None)
            .expect("Failed to get messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Hello, world!");
        assert_eq!(messages[0].role, MessageRole::User);
        assert_eq!(messages[0].thinking, Some("test thinking".to_string()));
    }

    #[test]
    fn test_message_pagination() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("Test")
            .expect("Failed to create conversation");

        // Add multiple messages
        let mut message_ids = Vec::new();
        for i in 0..5 {
            let msg = Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conv.id.clone(),
                role: MessageRole::User,
                content: format!("Message {i}"),
                content_parts: Vec::new(),
                thinking: None,
                meta: None,
                created_at: Utc::now(),
                status: crate::models::MessageStatus::Success,
                error_message: None,
            };
            message_ids.push(msg.id.clone());
            db.add_message(&conv.id, &msg)
                .expect("Failed to add message");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Get with limit
        let messages = db
            .get_messages(&conv.id, 3, None)
            .expect("Failed to get messages");
        assert_eq!(messages.len(), 3);

        // Get all
        let all_messages = db
            .get_messages(&conv.id, 10, None)
            .expect("Failed to get messages");
        assert_eq!(all_messages.len(), 5);
    }

    #[test]
    fn test_message_with_meta() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("Test")
            .expect("Failed to create conversation");

        let msg = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv.id.clone(),
            role: MessageRole::Assistant,
            content: "Response".to_string(),
            content_parts: Vec::new(),
            thinking: None,
            meta: Some(MessageMeta {
                model: Some("gpt-4".to_string()),
                tokens: Some(100),
                duration: Some(500),
                ..Default::default()
            }),
            created_at: Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        db.add_message(&conv.id, &msg)
            .expect("Failed to add message");

        let messages = db
            .get_messages(&conv.id, 10, None)
            .expect("Failed to get messages");
        assert_eq!(messages.len(), 1);

        let meta = messages[0].meta.as_ref().expect("Meta should exist");
        assert_eq!(meta.model, Some("gpt-4".to_string()));
        assert_eq!(meta.tokens, Some(100));
        assert_eq!(meta.duration, Some(500));
    }

    #[test]
    fn test_delete_conversation_cascades_messages() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("Test")
            .expect("Failed to create conversation");

        let msg = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv.id.clone(),
            role: MessageRole::User,
            content: "Hello".to_string(),
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };

        db.add_message(&conv.id, &msg)
            .expect("Failed to add message");
        db.delete_conversation(&conv.id)
            .expect("Failed to delete conversation");

        // Messages should be deleted too
        let messages = db
            .get_messages(&conv.id, 10, None)
            .expect("Failed to get messages");
        assert!(messages.is_empty());
    }

    #[test]
    fn test_clone_conversation_copies_metadata_messages_and_workstudio_binding() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("原始对话")
            .expect("Failed to create conversation");

        // Insert a fake workstudio row without touching filesystem.
        let ws_id = uuid::Uuid::new_v4().to_string();
        let folders = vec!["test_ws_main".to_string()];
        let folders_json = serde_json::to_string(&folders).unwrap();
        let now = Utc::now().to_rfc3339();
        {
            let conn = db.conn.lock().unwrap();
            let main_folder_key = Database::workstudio_main_folder_key("test_ws_main");
            conn.execute(
                "INSERT INTO workstudios (id, kind, main_folder, main_folder_key, folders_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    ws_id,
                    "code",
                    "test_ws_main",
                    main_folder_key,
                    folders_json,
                    now,
                    now
                ],
            )
            .unwrap();
        }

        let thinking_mode = json!({ "enabled": true, "level": "high" });
        db.update_conversation_metadata(
            &conv.id,
            Some("test-agent"),
            Some("test-provider/test-model"),
            Some(&thinking_mode),
            None,
            Some(&ws_id),
        )
        .unwrap();

        // Add some messages.
        let msg1 = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv.id.clone(),
            role: MessageRole::User,
            content: "hello".to_string(),
            content_parts: Vec::new(),
            thinking: None,
            meta: None,
            created_at: Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };
        let msg2 = Message {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conv.id.clone(),
            role: MessageRole::Assistant,
            content: "world".to_string(),
            content_parts: Vec::new(),
            thinking: Some("t".to_string()),
            meta: Some(MessageMeta {
                model: Some("test".to_string()),
                tokens: Some(10),
                ..Default::default()
            }),
            created_at: Utc::now(),
            status: crate::models::MessageStatus::Success,
            error_message: None,
        };
        db.add_message(&conv.id, &msg1).unwrap();
        db.add_message(&conv.id, &msg2).unwrap();

        let cloned = db.clone_conversation(&conv.id).unwrap();
        assert_ne!(cloned.id, conv.id);
        assert_ne!(cloned.title, conv.title);
        assert_eq!(cloned.agent_name.as_deref(), Some("test-agent"));
        assert_eq!(
            cloned.model_ref.as_deref(),
            Some("test-provider/test-model")
        );
        assert_eq!(cloned.workstudio_id.as_deref(), Some(ws_id.as_str()));

        let cloned_messages = db.get_all_messages(&cloned.id).unwrap();
        assert_eq!(cloned_messages.len(), 2);
        assert_eq!(cloned_messages[0].content, "hello");
        assert_eq!(cloned_messages[1].content, "world");
        assert_ne!(cloned_messages[0].id, msg1.id);
        assert_ne!(cloned_messages[1].id, msg2.id);
    }

    #[test]
    fn test_clone_conversation_title_uses_tree_suffix() {
        let db = Database::new_in_memory().expect("Failed to create database");

        let conv = db
            .create_conversation("原始对话")
            .expect("Failed to create conversation");

        let clone1 = db.clone_conversation(&conv.id).unwrap();
        assert_eq!(clone1.title, "原始对话 #1");

        let clone2 = db.clone_conversation(&conv.id).unwrap();
        assert_eq!(clone2.title, "原始对话 #2");

        let clone11 = db.clone_conversation(&clone1.id).unwrap();
        assert_eq!(clone11.title, "原始对话 #11");

        let clone12 = db.clone_conversation(&clone1.id).unwrap();
        assert_eq!(clone12.title, "原始对话 #12");
    }
}
