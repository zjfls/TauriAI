//! Storage module for TauriAI
//!
//! This module provides SQLite-based storage for conversations and messages.

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;
use serde::Serialize;

use crate::models::{ContentPart, Conversation, Message, MessageRole, Workstudio};
use crate::models::WorkstudioUiState;

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
        let conn = self
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
                workstudio_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Migration: Add agent_name and model_ref columns if they don't exist
        // We ignore errors as they will fail if columns already exist
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN agent_name TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN model_ref TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN system_prompt TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN system_prompt_cache_key TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN thinking_mode TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN workstudio_id TEXT", []);

        // Create workstudios table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS workstudios (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'code',
                main_folder TEXT NOT NULL,
                folders_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        // Migration: Add kind column if it doesn't exist
        let _ = conn.execute("ALTER TABLE workstudios ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'", []);

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
            "INSERT INTO conversations (id, title, model_id, agent_name, model_ref, system_prompt, system_prompt_cache_key, thinking_mode, workstudio_id, created_at, updated_at)
             VALUES (?1, ?2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?3, ?4)",
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
            workstudio_id: None,
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
            "SELECT id, title, agent_name, model_ref, system_prompt, system_prompt_cache_key, thinking_mode, workstudio_id, created_at, updated_at 
             FROM conversations 
             ORDER BY updated_at DESC",
        )?;

        let conversations = stmt
            .query_map([], |row| {
                let system_prompt: Option<String> = row.get(4)?;
                let system_prompt_cache_key: Option<String> = row.get(5)?;
                let thinking_mode_str: Option<String> = row.get(6)?;
                let workstudio_id: Option<String> = row.get(7)?;
                let created_at_str: String = row.get(8)?;
                let updated_at_str: String = row.get(9)?;

                let thinking_mode: Option<serde_json::Value> = thinking_mode_str
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());

                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    agent_name: row.get(2)?,
                    model_ref: row.get(3)?,
                    system_prompt,
                    system_prompt_cache_key,
                    thinking_mode,
                    workstudio_id,
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
            "SELECT id, title, agent_name, model_ref, system_prompt, system_prompt_cache_key, thinking_mode, workstudio_id, created_at, updated_at 
             FROM conversations 
             WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;

        if let Some(row) = rows.next()? {
            let system_prompt: Option<String> = row.get(4)?;
            let system_prompt_cache_key: Option<String> = row.get(5)?;
            let thinking_mode_str: Option<String> = row.get(6)?;
            let workstudio_id: Option<String> = row.get(7)?;
            let created_at_str: String = row.get(8)?;
            let updated_at_str: String = row.get(9)?;

            let thinking_mode: Option<serde_json::Value> = thinking_mode_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok());

            Ok(Some(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_name: row.get(2)?,
                model_ref: row.get(3)?,
                system_prompt,
                system_prompt_cache_key,
                thinking_mode,
                workstudio_id,
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
                 workstudio_id = COALESCE(?4, workstudio_id),
                 updated_at = ?5 
             WHERE id = ?6",
            params![
                agent_name,
                model_ref,
                thinking_mode_json,
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

    // ==================== Workstudio Operations ====================

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
        let folders = vec![main_folder.clone()];
        let folders_json =
            serde_json::to_string(&folders).map_err(|e| StorageError::Serialization(e.to_string()))?;

        let now = Utc::now();
        let now_str = now.to_rfc3339();

        {
            let conn = self
                .conn
                .lock()
                .map_err(|e| StorageError::Lock(e.to_string()))?;

            conn.execute(
                "INSERT INTO workstudios (id, kind, main_folder, folders_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, "code", main_folder, folders_json, now_str, now_str],
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
        let folders = vec![main_folder.clone()];
        let folders_json =
            serde_json::to_string(&folders).map_err(|e| StorageError::Serialization(e.to_string()))?;

        let now = Utc::now();
        let now_str = now.to_rfc3339();

        {
            let conn = self
                .conn
                .lock()
                .map_err(|e| StorageError::Lock(e.to_string()))?;

            conn.execute(
                "INSERT INTO workstudios (id, kind, main_folder, folders_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, "code", main_folder, folders_json, now_str, now_str],
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

        let mut ws = self
            .get_workstudio(workstudio_id)?
            .ok_or_else(|| StorageError::NotFound(format!("Workstudio {workstudio_id} not found")))?;

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

        let folders_json =
            serde_json::to_string(&ws.folders).map_err(|e| StorageError::Serialization(e.to_string()))?;

        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        conn.execute(
            "UPDATE workstudios
             SET main_folder = ?1,
                 folders_json = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![ws.main_folder, folders_json, now_str, workstudio_id],
        )?;

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

        let mut ws = self
            .get_workstudio(workstudio_id)?
            .ok_or_else(|| StorageError::NotFound(format!("Workstudio {workstudio_id} not found")))?;

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

        let folders_json =
            serde_json::to_string(&ws.folders).map_err(|e| StorageError::Serialization(e.to_string()))?;

        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        conn.execute(
            "UPDATE workstudios
             SET main_folder = ?1,
                 folders_json = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![ws.main_folder, folders_json, now_str, workstudio_id],
        )?;

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

        let mut ws = self
            .get_workstudio(workstudio_id)?
            .ok_or_else(|| StorageError::NotFound(format!("Workstudio {workstudio_id} not found")))?;

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
            ws.main_folder = ws
                .folders
                .first()
                .cloned()
                .ok_or_else(|| StorageError::Serialization("workstudio has no folders".to_string()))?;
        }

        // Keep main folder as the first entry.
        let main = ws.main_folder.clone();
        ws.folders.retain(|f| f != &main);
        ws.folders.insert(0, main.clone());

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        ws.updated_at = now;

        let folders_json =
            serde_json::to_string(&ws.folders).map_err(|e| StorageError::Serialization(e.to_string()))?;

        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        conn.execute(
            "UPDATE workstudios
             SET main_folder = ?1,
                 folders_json = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![ws.main_folder, folders_json, now_str, workstudio_id],
        )?;

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
}
