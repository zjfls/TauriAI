use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use super::index_types::CodeIndexDocumentSymbolsSnapshot;

const SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub mtime_ms: Option<i64>,
    pub size_bytes: Option<i64>,
}

#[derive(Debug)]
pub struct CodeIndexDb {
    path: PathBuf,
    conn: Connection,
}

impl CodeIndexDb {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建索引目录失败: {}: {e}", parent.display()))?;
        }

        let conn = Connection::open(&path).map_err(|e| format!("打开索引 DB 失败: {e}"))?;

        // Best-effort pragmas for better write concurrency and performance.
        // 注意：这是缓存 DB，优先可用性与速度，数据可重建。
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");

        let db = Self { path, conn };
        db.init_schema()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn init_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS meta (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS file_symbols (
                  file_path TEXT PRIMARY KEY,
                  language_id TEXT NOT NULL,
                  source TEXT NOT NULL,
                  symbols_json TEXT NOT NULL,
                  updated_at_ms INTEGER NOT NULL,
                  file_mtime_ms INTEGER,
                  file_size_bytes INTEGER
                );

                CREATE INDEX IF NOT EXISTS idx_file_symbols_language ON file_symbols(language_id);
                CREATE INDEX IF NOT EXISTS idx_file_symbols_updated_at ON file_symbols(updated_at_ms);
                "#,
            )
            .map_err(|e| format!("初始化索引 DB schema 失败: {e}"))?;

        let stored: Option<i32> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("读取 schema_version 失败: {e}"))?
            .and_then(|v| v.parse::<i32>().ok());

        if stored.unwrap_or(0) != SCHEMA_VERSION {
            self.conn
                .execute(
                    "INSERT INTO meta(key, value) VALUES('schema_version', ?1)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![SCHEMA_VERSION.to_string()],
                )
                .map_err(|e| format!("写入 schema_version 失败: {e}"))?;
        }

        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>, String> {
        let key = key.trim();
        if key.is_empty() {
            return Ok(None);
        }
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("读取 meta 失败: {e}"))
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("meta.key 为空".to_string());
        }
        let value = value.trim();
        self.conn
            .execute(
                "INSERT INTO meta(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| format!("写入 meta 失败: {e}"))?;
        Ok(())
    }

    pub fn get_document_symbols(
        &self,
        file_path: &str,
        current_meta: Option<&FileMeta>,
    ) -> Result<Option<CodeIndexDocumentSymbolsSnapshot>, String> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Ok(None);
        }

        let mut stmt = self
            .conn
            .prepare(
                "SELECT language_id, source, symbols_json, updated_at_ms, file_mtime_ms, file_size_bytes
                 FROM file_symbols WHERE file_path = ?1",
            )
            .map_err(|e| format!("查询索引 DB 失败: {e}"))?;

        let row_opt: Option<(String, String, String, i64, Option<i64>, Option<i64>)> = stmt
            .query_row(params![file_path], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .optional()
            .map_err(|e| format!("读取索引 DB 失败: {e}"))?;

        let Some((
            language_id,
            source,
            symbols_json,
            updated_at_ms,
            file_mtime_ms,
            file_size_bytes,
        )) = row_opt
        else {
            return Ok(None);
        };

        let symbols: serde_json::Value = serde_json::from_str(&symbols_json)
            .map_err(|e| format!("解析 symbols_json 失败: {e}"))?;

        let is_stale = match current_meta {
            None => false,
            Some(meta) => meta.mtime_ms != file_mtime_ms || meta.size_bytes != file_size_bytes,
        };

        Ok(Some(CodeIndexDocumentSymbolsSnapshot {
            file_path: file_path.to_string(),
            language_id,
            source,
            symbols,
            updated_at_ms,
            is_stale,
            file_mtime_ms,
            file_size_bytes,
        }))
    }

    pub fn upsert_document_symbols(
        &self,
        file_path: &str,
        language_id: &str,
        source: &str,
        symbols: &serde_json::Value,
        updated_at_ms: i64,
        meta: Option<&FileMeta>,
    ) -> Result<(), String> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Err("filePath 为空".to_string());
        }
        let language_id = language_id.trim();
        if language_id.is_empty() {
            return Err("languageId 为空".to_string());
        }
        let source = source.trim();
        if source.is_empty() {
            return Err("source 为空".to_string());
        }

        let symbols_json =
            serde_json::to_string(symbols).map_err(|e| format!("序列化 symbols 失败: {e}"))?;

        let (mtime_ms, size_bytes) = meta
            .map(|m| (m.mtime_ms, m.size_bytes))
            .unwrap_or((None, None));

        self.conn
            .execute(
                r#"
                INSERT INTO file_symbols(
                  file_path, language_id, source, symbols_json, updated_at_ms, file_mtime_ms, file_size_bytes
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(file_path) DO UPDATE SET
                  language_id=excluded.language_id,
                  source=excluded.source,
                  symbols_json=excluded.symbols_json,
                  updated_at_ms=excluded.updated_at_ms,
                  file_mtime_ms=excluded.file_mtime_ms,
                  file_size_bytes=excluded.file_size_bytes
                "#,
                params![
                    file_path,
                    language_id,
                    source,
                    symbols_json,
                    updated_at_ms,
                    mtime_ms,
                    size_bytes
                ],
            )
            .map_err(|e| format!("写入索引 DB 失败: {e}"))?;

        Ok(())
    }

    pub fn delete_file(&self, file_path: &str) -> Result<(), String> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Ok(());
        }
        self.conn
            .execute(
                "DELETE FROM file_symbols WHERE file_path = ?1",
                params![file_path],
            )
            .map_err(|e| format!("删除索引记录失败: {e}"))?;
        Ok(())
    }

    pub fn count_file_symbols(&self) -> Result<u64, String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(1) FROM file_symbols", [], |row| row.get(0))
            .map_err(|e| format!("统计索引记录失败: {e}"))?;
        Ok(count.max(0) as u64)
    }
}
