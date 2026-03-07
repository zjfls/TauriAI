use std::path::{Path, PathBuf};

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};

use super::index_types::{CodeIndexDocumentSymbolsSnapshot, CodeIndexWorkspaceSymbolSearchResult};

const SCHEMA_VERSION: i32 = 2;

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub mtime_ms: Option<i64>,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct StoredDocumentSymbolsRow {
    pub file_path: String,
    pub language_id: String,
    pub source: String,
    pub symbols_json: String,
    pub updated_at_ms: i64,
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

                CREATE TABLE IF NOT EXISTS workspace_symbols (
                  symbol_id TEXT PRIMARY KEY,
                  file_path TEXT NOT NULL,
                  symbol_name TEXT NOT NULL,
                  symbol_kind TEXT NOT NULL,
                  detail TEXT,
                  container_name TEXT,
                  selection_line INTEGER NOT NULL,
                  selection_column INTEGER NOT NULL,
                  range_start_line INTEGER NOT NULL,
                  range_start_column INTEGER NOT NULL,
                  range_end_line INTEGER NOT NULL,
                  range_end_column INTEGER NOT NULL,
                  language_id TEXT NOT NULL,
                  updated_at_ms INTEGER NOT NULL,
                  search_name TEXT NOT NULL,
                  search_text TEXT NOT NULL,
                  search_path TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_workspace_symbols_file_path ON workspace_symbols(file_path);
                CREATE INDEX IF NOT EXISTS idx_workspace_symbols_search_name ON workspace_symbols(search_name);
                CREATE INDEX IF NOT EXISTS idx_workspace_symbols_updated_at ON workspace_symbols(updated_at_ms);
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

    pub fn replace_workspace_symbols_for_file(
        &self,
        file_path: &str,
        symbols: &[CodeIndexWorkspaceSymbolSearchResult],
    ) -> Result<(), String> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Err("filePath 为空".to_string());
        }

        self.conn
            .execute(
                "DELETE FROM workspace_symbols WHERE file_path = ?1",
                params![file_path],
            )
            .map_err(|e| format!("清理文件符号搜索索引失败: {e}"))?;

        if symbols.is_empty() {
            return Ok(());
        }

        let mut stmt = self
            .conn
            .prepare(
                r#"
                INSERT INTO workspace_symbols(
                  symbol_id,
                  file_path,
                  symbol_name,
                  symbol_kind,
                  detail,
                  container_name,
                  selection_line,
                  selection_column,
                  range_start_line,
                  range_start_column,
                  range_end_line,
                  range_end_column,
                  language_id,
                  updated_at_ms,
                  search_name,
                  search_text,
                  search_path
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                "#,
            )
            .map_err(|e| format!("准备写入符号搜索索引失败: {e}"))?;

        for symbol in symbols {
            let search_name = normalize_search_text(&symbol.symbol_name);
            let search_kind = normalize_search_text(&symbol.symbol_kind);
            let search_container =
                normalize_search_text(symbol.container_name.as_deref().unwrap_or(""));
            let search_path = normalize_search_text(&symbol.file_path);
            let search_text = [
                search_name.as_str(),
                search_kind.as_str(),
                search_container.as_str(),
                search_path.as_str(),
            ]
            .iter()
            .filter(|segment| !segment.trim().is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");

            stmt.execute(params![
                &symbol.symbol_id,
                &symbol.file_path,
                &symbol.symbol_name,
                &symbol.symbol_kind,
                &symbol.detail,
                &symbol.container_name,
                i64::from(symbol.selection_line),
                i64::from(symbol.selection_column),
                i64::from(symbol.range_start_line),
                i64::from(symbol.range_start_column),
                i64::from(symbol.range_end_line),
                i64::from(symbol.range_end_column),
                &symbol.language_id,
                symbol.updated_at_ms,
                search_name,
                search_text,
                search_path,
            ])
            .map_err(|e| format!("写入符号搜索索引失败: {e}"))?;
        }

        Ok(())
    }

    pub fn search_workspace_symbols(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<CodeIndexWorkspaceSymbolSearchResult>, String> {
        let normalized = normalize_search_text(query);
        if normalized.is_empty() {
            return Ok(Vec::new());
        }

        let tokens = normalized
            .split_whitespace()
            .filter(|token| !token.is_empty())
            .take(8)
            .map(|token| token.to_string())
            .collect::<Vec<_>>();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }

        let exact = normalized.clone();
        let prefix = format!("{normalized}%");
        let contains = format!("%{normalized}%");

        let mut sql = String::from(
            "SELECT symbol_id, file_path, symbol_name, symbol_kind, detail, container_name, selection_line, selection_column, range_start_line, range_start_column, range_end_line, range_end_column, language_id, updated_at_ms FROM workspace_symbols WHERE ",
        );
        for (index, _token) in tokens.iter().enumerate() {
            if index > 0 {
                sql.push_str(" AND ");
            }
            sql.push_str(&format!("search_text LIKE ?{}", index + 1));
        }
        let order_start = tokens.len() + 1;
        sql.push_str(&format!(
            " ORDER BY CASE WHEN search_name = ?{0} THEN 0 WHEN search_name LIKE ?{1} THEN 1 WHEN search_text LIKE ?{2} THEN 2 ELSE 3 END, updated_at_ms DESC, file_path ASC, selection_line ASC, selection_column ASC LIMIT ?{3}",
            order_start,
            order_start + 1,
            order_start + 2,
            order_start + 3,
        ));

        let mut params: Vec<Value> = tokens
            .into_iter()
            .map(|token| Value::from(format!("%{token}%")))
            .collect();
        params.push(Value::from(exact));
        params.push(Value::from(prefix));
        params.push(Value::from(contains));
        params.push(Value::from(limit.max(1) as i64));

        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| format!("准备查询符号搜索索引失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(params), |row| {
                Ok(CodeIndexWorkspaceSymbolSearchResult {
                    symbol_id: row.get(0)?,
                    file_path: row.get(1)?,
                    symbol_name: row.get(2)?,
                    symbol_kind: row.get(3)?,
                    detail: row.get(4)?,
                    container_name: row.get(5)?,
                    selection_line: row.get::<_, i64>(6)?.max(0) as u32,
                    selection_column: row.get::<_, i64>(7)?.max(0) as u32,
                    range_start_line: row.get::<_, i64>(8)?.max(0) as u32,
                    range_start_column: row.get::<_, i64>(9)?.max(0) as u32,
                    range_end_line: row.get::<_, i64>(10)?.max(0) as u32,
                    range_end_column: row.get::<_, i64>(11)?.max(0) as u32,
                    language_id: row.get(12)?,
                    updated_at_ms: row.get(13)?,
                })
            })
            .map_err(|e| format!("查询符号搜索索引失败: {e}"))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("读取符号搜索索引失败: {e}"))?);
        }
        Ok(results)
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
        self.conn
            .execute(
                "DELETE FROM workspace_symbols WHERE file_path = ?1",
                params![file_path],
            )
            .map_err(|e| format!("删除符号搜索索引失败: {e}"))?;
        Ok(())
    }

    pub fn count_file_symbols(&self) -> Result<u64, String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(1) FROM file_symbols", [], |row| row.get(0))
            .map_err(|e| format!("统计索引记录失败: {e}"))?;
        Ok(count.max(0) as u64)
    }

    pub fn count_workspace_symbols(&self) -> Result<u64, String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(1) FROM workspace_symbols", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("统计符号搜索索引失败: {e}"))?;
        Ok(count.max(0) as u64)
    }

    pub fn has_workspace_symbols_for_file(&self, file_path: &str) -> Result<bool, String> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Ok(false);
        }

        let exists = self
            .conn
            .query_row(
                "SELECT 1 FROM workspace_symbols WHERE file_path = ?1 LIMIT 1",
                params![file_path],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| format!("检查文件符号搜索索引失败: {e}"))?;
        Ok(exists.is_some())
    }

    pub fn list_document_symbols_for_backfill(
        &self,
    ) -> Result<Vec<StoredDocumentSymbolsRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT file_path, language_id, source, symbols_json, updated_at_ms FROM file_symbols WHERE source = 'ast' ORDER BY updated_at_ms DESC, file_path ASC",
            )
            .map_err(|e| format!("准备读取缓存符号索引失败: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(StoredDocumentSymbolsRow {
                    file_path: row.get(0)?,
                    language_id: row.get(1)?,
                    source: row.get(2)?,
                    symbols_json: row.get(3)?,
                    updated_at_ms: row.get(4)?,
                })
            })
            .map_err(|e| format!("读取缓存符号索引失败: {e}"))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("读取缓存符号索引行失败: {e}"))?);
        }
        Ok(results)
    }
}

fn normalize_search_text(value: &str) -> String {
    let lower = value.trim().replace('\\', "/").to_lowercase();
    lower
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_alphabetic() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
