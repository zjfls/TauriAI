//! Storage module for TauriAI
//!
//! This module provides SQLite-based storage for conversations and messages.

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use thiserror::Error;

use crate::models::{ContentPart, Conversation, Message, MessageRole};

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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Migration: Add agent_name and model_ref columns if they don't exist
        // We ignore errors as they will fail if columns already exist
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN agent_name TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN model_ref TEXT", []);

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
            "INSERT INTO conversations (id, title, model_id, agent_name, model_ref, created_at, updated_at)
             VALUES (?1, ?2, NULL, NULL, NULL, ?3, ?4)",
            params![id, title, now_str, now_str],
        )?;

        Ok(Conversation {
            id,
            title: title.to_string(),
            agent_name: None,
            model_ref: None,
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
            "SELECT id, title, agent_name, model_ref, created_at, updated_at 
             FROM conversations 
             ORDER BY updated_at DESC",
        )?;

        let conversations = stmt
            .query_map([], |row| {
                let created_at_str: String = row.get(4)?;
                let updated_at_str: String = row.get(5)?;

                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    agent_name: row.get(2)?,
                    model_ref: row.get(3)?,
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
            "SELECT id, title, agent_name, model_ref, created_at, updated_at 
             FROM conversations 
             WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;

        if let Some(row) = rows.next()? {
            let created_at_str: String = row.get(4)?;
            let updated_at_str: String = row.get(5)?;

            Ok(Some(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                agent_name: row.get(2)?,
                model_ref: row.get(3)?,
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

    /// Update conversation metadata (agent and model)
    pub fn update_conversation_metadata(
        &self,
        id: &str,
        agent_name: Option<&str>,
        model_ref: Option<&str>,
    ) -> Result<(), StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StorageError::Lock(e.to_string()))?;

        // Update updated_at as well
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE conversations 
             SET agent_name = ?1, model_ref = ?2, updated_at = ?3 
             WHERE id = ?4",
            params![agent_name, model_ref, now, id],
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
