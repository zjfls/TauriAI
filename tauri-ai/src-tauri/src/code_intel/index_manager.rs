use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{Mutex, Notify};

use tauri::Emitter;

use crate::code_intel::ast::{self, AstDocumentSymbolsArgs, AstSymbol};
use crate::models::Workstudio;
use crate::storage::async_db;
use crate::storage::Database;

use super::index_db::{CodeIndexDb, FileMeta, StoredDocumentSymbolsRow};
use super::index_types::{
    CodeIndexDocumentSymbolsSnapshot, CodeIndexEvent, CodeIndexEventPayload,
    CodeIndexWorkspaceSymbolSearchResult, CODE_INDEX_EVENT_NAME,
};

// -----------------------------------------------------------------------------
// Priority model
//
// 说明：
// - 数值越大，优先级越高。
// - 约定：
//   - 100+: 用户显式请求（例如点击“刷新索引”、跳转相关）
//   - 80 : 打开文件/切换 Tab（用户正在看）
//   - 60 : 保存文件（希望尽快落盘更新缓存）
//   - 10 : 后台扫描/低优先级预热
// -----------------------------------------------------------------------------
pub const PRIORITY_USER: i32 = 120;
pub const PRIORITY_OPEN_FILE: i32 = 80;
pub const PRIORITY_SAVE_FILE: i32 = 60;
pub const PRIORITY_BACKGROUND: i32 = 10;

const MAX_PENDING_JOBS: usize = 1600;
const SCAN_DIR_BATCH: usize = 8;
const SCAN_FILE_BATCH: usize = 220;
const FULL_SCAN_SKIP_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexRequestDocumentSymbolsArgs {
    pub workstudio_id: String,
    pub file_path: String,
    #[serde(default)]
    pub language_id: String,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexRequestDocumentSymbolsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<CodeIndexDocumentSymbolsSnapshot>,
    pub queued: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexStartWorkspaceScanArgs {
    pub workstudio_id: String,
    #[serde(default)]
    pub priority: Option<i32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexSearchWorkspaceSymbolsArgs {
    pub workstudio_id: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexStatus {
    pub pending_jobs: u64,
    pub running_job: Option<String>,
    pub scan_pending_dirs: u64,
    pub scan_scanned_files: u64,
    pub scan_queued_files: u64,
}

pub struct CodeIndexManager {
    app: tauri::AppHandle,
    index_root_dir: PathBuf,
    db: Arc<Mutex<Database>>,

    dbs: Mutex<HashMap<String, Arc<std::sync::Mutex<CodeIndexDb>>>>,
    queue: Mutex<QueueState>,
    notify: Notify,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexSummary {
    pub workstudio_id: String,
    pub db_path: String,
    pub db_file_size_bytes: Option<u64>,
    pub db_file_mtime_ms: Option<i64>,
    pub file_symbols_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_scan_roots: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_scan_completed_at_ms: Option<i64>,
    pub current_roots: String,
    pub same_roots: bool,
    pub is_fresh: bool,
    pub should_skip_full_scan: bool,
}

#[derive(Debug, Default)]
struct QueueState {
    next_id: u64,
    next_seq: u64,
    heap: BinaryHeap<Job>,
    pending: HashMap<String, PendingEntry>,
    running_job: Option<String>,
    scans: HashMap<String, WorkspaceScanState>,
}

#[derive(Debug, Clone)]
struct PendingEntry {
    job_id: u64,
    priority: i32,
}

#[derive(Debug, Clone)]
struct WorkspaceScanState {
    pending_dirs: VecDeque<PathBuf>,
    seen_dirs: HashSet<String>,
    scanned_files: u64,
    queued_files: u64,
}

#[derive(Debug, Clone)]
struct Job {
    id: u64,
    seq: u64,
    priority: i32,
    kind: JobKind,
}

#[derive(Debug, Clone)]
enum JobKind {
    IndexDocumentSymbols {
        workstudio_id: String,
        file_path: String,
        language_id: String,
        force: bool,
    },
    ScanWorkspace {
        workstudio_id: String,
    },
}

impl PartialEq for Job {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for Job {}

impl PartialOrd for Job {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Job {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap 是 max-heap：希望 priority 大的先出队。
        // 同优先级：按 seq 小（更早入队）优先。
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.seq.cmp(&self.seq))
            .then_with(|| self.id.cmp(&other.id))
    }
}

impl CodeIndexManager {
    pub fn new(
        app: tauri::AppHandle,
        index_root_dir: PathBuf,
        db: Arc<Mutex<Database>>,
    ) -> Arc<Self> {
        let mgr = Arc::new(Self {
            app,
            index_root_dir,
            db,
            dbs: Mutex::new(HashMap::new()),
            queue: Mutex::new(QueueState::default()),
            notify: Notify::new(),
        });

        let mgr2 = Arc::clone(&mgr);
        tauri::async_runtime::spawn(async move {
            mgr2.run_loop().await;
        });

        mgr
    }

    pub async fn request_document_symbols(
        &self,
        args: CodeIndexRequestDocumentSymbolsArgs,
    ) -> Result<CodeIndexRequestDocumentSymbolsResult, String> {
        let ws_id = args.workstudio_id.trim();
        if ws_id.is_empty() {
            return Err("workstudioId 为空".to_string());
        }

        let file_path = normalize_fs_path(args.file_path.as_str());
        if file_path.is_empty() {
            return Err("filePath 为空".to_string());
        }

        let language_id = best_language_id_for_path(&file_path, args.language_id.as_str())
            .ok_or_else(|| "无法识别语言类型（不支持索引该文件）".to_string())?;

        let current_meta = read_file_meta(&file_path).await;
        let cached = self
            .get_cached_document_symbols(ws_id, &file_path, current_meta.as_ref())
            .await?;

        let force = args.force.unwrap_or(false);
        let priority = args.priority.unwrap_or(PRIORITY_OPEN_FILE);
        let cached_is_fresh = cached.as_ref().map(|c| !c.is_stale).unwrap_or(false);
        let has_workspace_symbols = if cached_is_fresh {
            self.has_workspace_symbols_for_file(ws_id, &file_path)
                .await?
        } else {
            false
        };
        let should_queue = force
            || cached.as_ref().map(|c| c.is_stale).unwrap_or(true)
            || (cached_is_fresh && !has_workspace_symbols);

        let queued = if should_queue {
            self.enqueue_index_document_symbols(ws_id, &file_path, language_id, priority, force)
                .await
        } else {
            false
        };

        Ok(CodeIndexRequestDocumentSymbolsResult { cached, queued })
    }

    pub async fn search_workspace_symbols(
        &self,
        args: CodeIndexSearchWorkspaceSymbolsArgs,
    ) -> Result<Vec<CodeIndexWorkspaceSymbolSearchResult>, String> {
        let ws_id = args.workstudio_id.trim();
        if ws_id.is_empty() {
            return Err("workstudioId 为空".to_string());
        }

        let query = args.query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        self.ensure_workspace_symbol_search_index(ws_id).await?;

        let limit = args.limit.unwrap_or(200).clamp(1, 1000) as usize;
        let dbh = self.get_db_handle(ws_id).await?;
        let query_owned = query.to_string();
        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            guard.search_workspace_symbols(&query_owned, limit)
        })
        .await
        .map_err(|e| format!("查询符号搜索索引线程失败: {e}"))?
    }

    pub async fn start_workspace_scan(
        &self,
        args: CodeIndexStartWorkspaceScanArgs,
    ) -> Result<(), String> {
        let ws_id = args.workstudio_id.trim();
        if ws_id.is_empty() {
            return Err("workstudioId 为空".to_string());
        }
        let priority = args.priority.unwrap_or(PRIORITY_BACKGROUND);

        // 背景扫描默认“可跳过”：
        // - 目的：避免每次重启都全量扫描（大项目会很慢）
        // - 仍会在打开文件/保存文件时按需触发单文件索引（高优先级）
        let force = priority >= PRIORITY_USER;

        let ws: Workstudio =
            async_db::with_db(&self.db, "code_index:start_scan:get_workstudio", |db| {
                db.get_workstudio(ws_id)
            })
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?;

        let roots = workstudio_roots(&ws);
        if roots.is_empty() {
            return Ok(());
        }
        let roots_key = roots
            .iter()
            .map(|r| normalize_fs_path(r))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        if !force {
            let now = now_ms();
            let dbh = self.get_db_handle(ws_id).await?;
            let roots_key2 = roots_key.clone();
            let should_skip = tokio::task::spawn_blocking(move || {
                let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
                let stored_roots = guard.get_meta("full_scan_roots")?;
                let stored_done = guard
                    .get_meta("full_scan_completed_at_ms")?
                    .and_then(|v| v.parse::<i64>().ok());

                let same_roots = stored_roots.as_deref() == Some(roots_key2.as_str());
                let is_fresh = stored_done
                    .map(|t| now.saturating_sub(t) <= FULL_SCAN_SKIP_WINDOW_MS)
                    .unwrap_or(false);

                Ok::<bool, String>(same_roots && is_fresh)
            })
            .await
            .map_err(|e| format!("读取索引 DB 线程失败: {e}"))??;

            if should_skip {
                return Ok(());
            }
        }

        self.enqueue_scan_workspace(ws_id, priority).await;
        Ok(())
    }

    pub async fn status(&self, workstudio_id: &str) -> CodeIndexStatus {
        let ws_id = workstudio_id.trim();
        let st = self.queue.lock().await;
        let pending_jobs = st.pending.len() as u64;
        let running_job = st.running_job.clone();
        let scan = st.scans.get(ws_id);
        CodeIndexStatus {
            pending_jobs,
            running_job,
            scan_pending_dirs: scan.map(|s| s.pending_dirs.len() as u64).unwrap_or(0),
            scan_scanned_files: scan.map(|s| s.scanned_files).unwrap_or(0),
            scan_queued_files: scan.map(|s| s.queued_files).unwrap_or(0),
        }
    }

    pub async fn summary(&self, workstudio_id: &str) -> Result<CodeIndexSummary, String> {
        let ws_id = workstudio_id.trim();
        if ws_id.is_empty() {
            return Err("workstudioId 为空".to_string());
        }
        let ws_id_owned = ws_id.to_string();

        let ws: Workstudio =
            async_db::with_db(&self.db, "code_index:summary:get_workstudio", |db| {
                db.get_workstudio(ws_id)
            })
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?;

        let roots = workstudio_roots(&ws);
        let roots_key = roots
            .iter()
            .map(|r| normalize_fs_path(r))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        let dbh = self.get_db_handle(ws_id).await?;
        let now = now_ms();
        let roots_key2 = roots_key.clone();

        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            let db_path = guard.path().to_string_lossy().to_string();

            let db_meta = std::fs::metadata(guard.path()).ok();
            let db_file_size_bytes = db_meta.as_ref().map(|m| m.len());
            let db_file_mtime_ms = db_meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);

            let full_scan_roots = guard.get_meta("full_scan_roots")?;
            let full_scan_completed_at_ms = guard
                .get_meta("full_scan_completed_at_ms")?
                .and_then(|v| v.parse::<i64>().ok());

            let same_roots = full_scan_roots.as_deref() == Some(roots_key2.as_str());
            let is_fresh = full_scan_completed_at_ms
                .map(|t| now.saturating_sub(t) <= FULL_SCAN_SKIP_WINDOW_MS)
                .unwrap_or(false);
            let should_skip_full_scan = same_roots && is_fresh;

            let file_symbols_count = guard.count_file_symbols()?;

            Ok::<CodeIndexSummary, String>(CodeIndexSummary {
                workstudio_id: ws_id_owned,
                db_path,
                db_file_size_bytes,
                db_file_mtime_ms,
                file_symbols_count,
                full_scan_roots,
                full_scan_completed_at_ms,
                current_roots: roots_key2,
                same_roots,
                is_fresh,
                should_skip_full_scan,
            })
        })
        .await
        .map_err(|e| format!("读取索引 DB 线程失败: {e}"))?
    }

    async fn run_loop(self: Arc<Self>) {
        loop {
            let next = self.pop_next_job().await;
            let Some(job) = next else {
                self.notify.notified().await;
                continue;
            };

            match job.kind.clone() {
                JobKind::IndexDocumentSymbols {
                    workstudio_id,
                    file_path,
                    language_id,
                    force,
                } => {
                    let label = format!("index_symbols:{language_id}:{file_path}");
                    {
                        let mut st = self.queue.lock().await;
                        st.running_job = Some(label.clone());
                    }
                    let _ = self
                        .process_index_document_symbols(
                            &workstudio_id,
                            &file_path,
                            &language_id,
                            force,
                        )
                        .await;
                    {
                        let mut st = self.queue.lock().await;
                        if st.running_job.as_deref() == Some(label.as_str()) {
                            st.running_job = None;
                        }
                    }
                }
                JobKind::ScanWorkspace { workstudio_id } => {
                    let label = format!("scan:{workstudio_id}");
                    {
                        let mut st = self.queue.lock().await;
                        st.running_job = Some(label.clone());
                    }
                    let _ = self.process_scan_workspace(&workstudio_id).await;
                    {
                        let mut st = self.queue.lock().await;
                        if st.running_job.as_deref() == Some(label.as_str()) {
                            st.running_job = None;
                        }
                    }
                }
            }
        }
    }

    async fn pop_next_job(&self) -> Option<Job> {
        let mut st = self.queue.lock().await;
        while let Some(job) = st.heap.pop() {
            // 验证：该 job 是否仍是 pending map 的“当前版本”
            let key = job_key(&job.kind);
            match st.pending.get(&key) {
                Some(p) if p.job_id == job.id => {
                    st.pending.remove(&key);
                    return Some(job);
                }
                _ => {
                    // stale job（被更高优先级覆盖）丢弃
                    continue;
                }
            }
        }
        None
    }

    async fn enqueue_index_document_symbols(
        &self,
        workstudio_id: &str,
        file_path: &str,
        language_id: &str,
        priority: i32,
        force: bool,
    ) -> bool {
        let key = job_key(&JobKind::IndexDocumentSymbols {
            workstudio_id: workstudio_id.to_string(),
            file_path: file_path.to_string(),
            language_id: language_id.to_string(),
            force,
        });

        let mut st = self.queue.lock().await;
        if st.pending.len() >= MAX_PENDING_JOBS {
            // 防爆：队列过大时，低优先级请求直接丢弃；高优先级仍可进入。
            if priority < PRIORITY_OPEN_FILE {
                return false;
            }
        }

        if let Some(existing) = st.pending.get(&key) {
            if existing.priority >= priority {
                return false;
            }
        }

        st.next_id = st.next_id.saturating_add(1);
        st.next_seq = st.next_seq.saturating_add(1);
        let id = st.next_id;
        let seq = st.next_seq;
        st.pending.insert(
            key,
            PendingEntry {
                job_id: id,
                priority,
            },
        );
        st.heap.push(Job {
            id,
            seq,
            priority,
            kind: JobKind::IndexDocumentSymbols {
                workstudio_id: workstudio_id.to_string(),
                file_path: file_path.to_string(),
                language_id: language_id.to_string(),
                force,
            },
        });
        drop(st);

        self.notify.notify_one();
        true
    }

    async fn enqueue_scan_workspace(&self, workstudio_id: &str, priority: i32) {
        let key = job_key(&JobKind::ScanWorkspace {
            workstudio_id: workstudio_id.to_string(),
        });

        let mut st = self.queue.lock().await;
        if let Some(existing) = st.pending.get(&key) {
            if existing.priority >= priority {
                return;
            }
        }

        st.next_id = st.next_id.saturating_add(1);
        st.next_seq = st.next_seq.saturating_add(1);
        let id = st.next_id;
        let seq = st.next_seq;
        st.pending.insert(
            key,
            PendingEntry {
                job_id: id,
                priority,
            },
        );
        st.heap.push(Job {
            id,
            seq,
            priority,
            kind: JobKind::ScanWorkspace {
                workstudio_id: workstudio_id.to_string(),
            },
        });
        drop(st);

        self.notify.notify_one();
    }

    async fn get_db_handle(
        &self,
        workstudio_id: &str,
    ) -> Result<Arc<std::sync::Mutex<CodeIndexDb>>, String> {
        {
            let map = self.dbs.lock().await;
            if let Some(db) = map.get(workstudio_id) {
                return Ok(Arc::clone(db));
            }
        }

        let root = self.index_root_dir.clone();
        let ws = workstudio_id.to_string();
        let path = code_index_db_path(&root, &ws);
        let opened = tokio::task::spawn_blocking(move || CodeIndexDb::open(path))
            .await
            .map_err(|e| format!("打开索引 DB 线程失败: {e}"))??;

        let handle = Arc::new(std::sync::Mutex::new(opened));
        let mut map = self.dbs.lock().await;
        map.insert(ws, Arc::clone(&handle));
        Ok(handle)
    }

    async fn get_cached_document_symbols(
        &self,
        workstudio_id: &str,
        file_path: &str,
        current_meta: Option<&FileMeta>,
    ) -> Result<Option<CodeIndexDocumentSymbolsSnapshot>, String> {
        let dbh = self.get_db_handle(workstudio_id).await?;
        let file_path = file_path.to_string();
        let meta = current_meta.cloned();
        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            guard.get_document_symbols(&file_path, meta.as_ref())
        })
        .await
        .map_err(|e| format!("读取索引 DB 线程失败: {e}"))?
    }

    async fn has_workspace_symbols_for_file(
        &self,
        workstudio_id: &str,
        file_path: &str,
    ) -> Result<bool, String> {
        let dbh = self.get_db_handle(workstudio_id).await?;
        let file_path = file_path.to_string();
        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            guard.has_workspace_symbols_for_file(&file_path)
        })
        .await
        .map_err(|e| format!("检查符号搜索索引线程失败: {e}"))?
    }

    async fn ensure_workspace_symbol_search_index(
        &self,
        workstudio_id: &str,
    ) -> Result<(), String> {
        const BACKFILL_META_KEY: &str = "workspace_symbols_backfill_v1";

        let dbh = self.get_db_handle(workstudio_id).await?;
        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            if guard.get_meta(BACKFILL_META_KEY)?.as_deref() == Some("1") {
                return Ok(());
            }

            let file_count = guard.count_file_symbols()?;
            if file_count == 0 {
                let _ = guard.set_meta(BACKFILL_META_KEY, "1");
                return Ok(());
            }

            let rows = guard.list_document_symbols_for_backfill()?;
            for StoredDocumentSymbolsRow {
                file_path,
                language_id,
                source: _,
                symbols_json,
                updated_at_ms,
            } in rows
            {
                let symbols = match serde_json::from_str::<Vec<AstSymbol>>(&symbols_json) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let workspace_symbols = ast_symbols_to_workspace_search_results(
                    &file_path,
                    &language_id,
                    updated_at_ms,
                    &symbols,
                );
                guard.replace_workspace_symbols_for_file(&file_path, &workspace_symbols)?;
            }

            guard.set_meta(BACKFILL_META_KEY, "1")?;
            Ok(())
        })
        .await
        .map_err(|e| format!("回填符号搜索索引线程失败: {e}"))?
    }

    async fn process_index_document_symbols(
        &self,
        workstudio_id: &str,
        file_path: &str,
        language_id: &str,
        force: bool,
    ) -> Result<(), String> {
        let current_meta = read_file_meta(file_path).await;
        let cached = self
            .get_cached_document_symbols(workstudio_id, file_path, current_meta.as_ref())
            .await?;
        let cached_is_fresh = cached.as_ref().map(|c| !c.is_stale).unwrap_or(false);
        let has_workspace_symbols = if !force && cached_is_fresh {
            self.has_workspace_symbols_for_file(workstudio_id, file_path)
                .await?
        } else {
            false
        };

        if !force {
            if let Some(c) = cached.as_ref() {
                if !c.is_stale && has_workspace_symbols {
                    return Ok(());
                }
            }
        }

        let bytes = match tokio::fs::read(file_path).await {
            Ok(v) => v,
            Err(e) => {
                // 文件被删除/权限变化：清理 DB 记录即可，属于常见情况。
                let _ = self.delete_cached_file(workstudio_id, file_path).await;
                self.emit_event(
                    workstudio_id,
                    CodeIndexEvent::Error {
                        phase: "read_file".to_string(),
                        file_path: Some(file_path.to_string()),
                        message: format!("读取文件失败: {e}"),
                    },
                );
                return Ok(());
            }
        };

        // 防御：后台索引避免吞掉过大的文件导致卡顿；但高优先级（用户打开/保存）会更宽松。
        let size_limit = 2 * 1024 * 1024usize;
        if bytes.len() > size_limit {
            self.emit_event(
                workstudio_id,
                CodeIndexEvent::Error {
                    phase: "parse".to_string(),
                    file_path: Some(file_path.to_string()),
                    message: format!("文件过大（{} bytes），跳过 AST 索引", bytes.len()),
                },
            );
            return Ok(());
        }

        let text = String::from_utf8_lossy(&bytes).to_string();
        let symbols = match ast::document_symbols(AstDocumentSymbolsArgs {
            language_id: language_id.to_string(),
            text,
        }) {
            Ok(v) => v,
            Err(e) => {
                self.emit_event(
                    workstudio_id,
                    CodeIndexEvent::Error {
                        phase: "parse".to_string(),
                        file_path: Some(file_path.to_string()),
                        message: e,
                    },
                );
                return Ok(());
            }
        };

        let symbols_json =
            serde_json::to_value(&symbols).map_err(|e| format!("symbols 序列化失败: {e}"))?;

        let updated_at_ms = now_ms();
        let workspace_symbols = ast_symbols_to_workspace_search_results(
            file_path,
            language_id,
            updated_at_ms,
            &symbols,
        );
        let dbh = self.get_db_handle(workstudio_id).await?;
        let fp = file_path.to_string();
        let lang = language_id.to_string();
        let meta = current_meta.clone();
        let symbols_clone = symbols_json.clone();

        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            guard.upsert_document_symbols(
                &fp,
                &lang,
                "ast",
                &symbols_clone,
                updated_at_ms,
                meta.as_ref(),
            )?;
            guard.replace_workspace_symbols_for_file(&fp, &workspace_symbols)
        })
        .await
        .map_err(|e| format!("写入索引 DB 线程失败: {e}"))??;

        self.emit_event(
            workstudio_id,
            CodeIndexEvent::DocumentSymbolsUpdated {
                file_path: file_path.to_string(),
                language_id: language_id.to_string(),
                source: "ast".to_string(),
                symbols: symbols_json,
                updated_at_ms,
                file_mtime_ms: current_meta.as_ref().and_then(|m| m.mtime_ms),
                file_size_bytes: current_meta.as_ref().and_then(|m| m.size_bytes),
            },
        );

        Ok(())
    }

    async fn delete_cached_file(&self, workstudio_id: &str, file_path: &str) -> Result<(), String> {
        let dbh = self.get_db_handle(workstudio_id).await?;
        let fp = file_path.to_string();
        tokio::task::spawn_blocking(move || {
            let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
            guard.delete_file(&fp)
        })
        .await
        .map_err(|e| format!("删除索引 DB 线程失败: {e}"))?
    }

    async fn process_scan_workspace(&self, workstudio_id: &str) -> Result<(), String> {
        let ws: Workstudio =
            async_db::with_db(&self.db, "code_index:process_scan:get_workstudio", |db| {
                db.get_workstudio(workstudio_id)
            })
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?;

        let roots = workstudio_roots(&ws);
        if roots.is_empty() {
            return Ok(());
        }
        let roots_key = roots
            .iter()
            .map(|r| normalize_fs_path(r))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        // Ensure scan state exists.
        {
            let mut st = self.queue.lock().await;
            if !st.scans.contains_key(workstudio_id) {
                let mut pending_dirs = VecDeque::new();
                let mut seen_dirs = HashSet::new();
                for r in &roots {
                    let p = PathBuf::from(r);
                    if p.as_os_str().is_empty() {
                        continue;
                    }
                    let key = normalize_fs_path(r);
                    if key.is_empty() {
                        continue;
                    }
                    if seen_dirs.insert(key) {
                        pending_dirs.push_back(p);
                    }
                }
                st.scans.insert(
                    workstudio_id.to_string(),
                    WorkspaceScanState {
                        pending_dirs,
                        seen_dirs,
                        scanned_files: 0,
                        queued_files: 0,
                    },
                );
            }
        }

        // Chunked scan loop: process a small batch, then re-enqueue if still pending.
        let mut popped: Vec<PathBuf> = Vec::new();
        let mut scanned_files_delta = 0u64;
        let mut queued_files_delta = 0u64;

        {
            let mut st = self.queue.lock().await;
            let Some(scan) = st.scans.get_mut(workstudio_id) else {
                return Ok(());
            };
            for _ in 0..SCAN_DIR_BATCH {
                if let Some(p) = scan.pending_dirs.pop_front() {
                    popped.push(p);
                } else {
                    break;
                }
            }
        }

        if popped.is_empty() {
            // Finished.
            self.finish_workspace_scan(workstudio_id, &roots_key).await;
            return Ok(());
        }

        // Collect new dirs and files.
        let mut new_dirs: Vec<PathBuf> = Vec::new();
        let mut new_files: Vec<(String, String)> = Vec::new(); // (file_path, language_id)

        for dir in popped {
            let mut rd = match tokio::fs::read_dir(&dir).await {
                Ok(v) => v,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = rd.next_entry().await {
                let file_type = match entry.file_type().await {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() {
                    let name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if should_skip_dir_name(&name) {
                        continue;
                    }
                    new_dirs.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }

                let pstr = path.to_string_lossy().replace('\\', "/");
                if pstr.is_empty() {
                    continue;
                }
                let Some(lang) = best_language_id_for_path(&pstr, "") else {
                    continue;
                };
                scanned_files_delta = scanned_files_delta.saturating_add(1);
                if new_files.len() < SCAN_FILE_BATCH {
                    new_files.push((pstr, lang.to_string()));
                }
            }
        }

        // Apply new dirs/files into scan state and enqueue file jobs.
        {
            let mut st = self.queue.lock().await;
            let Some(scan) = st.scans.get_mut(workstudio_id) else {
                return Ok(());
            };

            for d in new_dirs {
                let key = normalize_fs_path(d.to_string_lossy().as_ref());
                if key.is_empty() {
                    continue;
                }
                if scan.seen_dirs.insert(key) {
                    scan.pending_dirs.push_back(d);
                }
            }

            scan.scanned_files = scan.scanned_files.saturating_add(scanned_files_delta);
        }

        for (fp, lang) in new_files {
            let queued = self
                .enqueue_index_document_symbols(
                    workstudio_id,
                    fp.as_str(),
                    lang.as_str(),
                    PRIORITY_BACKGROUND,
                    false,
                )
                .await;
            if queued {
                queued_files_delta = queued_files_delta.saturating_add(1);
            }
        }

        {
            let mut st = self.queue.lock().await;
            if let Some(scan) = st.scans.get_mut(workstudio_id) {
                scan.queued_files = scan.queued_files.saturating_add(queued_files_delta);
            }
        }

        // Emit progress (best-effort, avoid too noisy).
        if scanned_files_delta > 0 || queued_files_delta > 0 {
            let st = self.queue.lock().await;
            let scan = st.scans.get(workstudio_id);
            if let Some(scan) = scan {
                self.emit_event(
                    workstudio_id,
                    CodeIndexEvent::Progress {
                        phase: "scan".to_string(),
                        done: scan.scanned_files,
                        total: None,
                        message: format!(
                            "扫描中：已发现 {}/? 文件，已入队 {}（pending_dirs={})",
                            scan.scanned_files,
                            scan.queued_files,
                            scan.pending_dirs.len()
                        ),
                    },
                );
            }
        }

        // If there are still pending dirs, re-enqueue the scan job (low priority).
        let still_pending = {
            let st = self.queue.lock().await;
            st.scans
                .get(workstudio_id)
                .map(|s| !s.pending_dirs.is_empty())
                .unwrap_or(false)
        };
        if still_pending {
            self.enqueue_scan_workspace(workstudio_id, PRIORITY_BACKGROUND)
                .await;
            return Ok(());
        }

        // 扫描结束：
        // 这里必须在“最后一批目录被处理完”的那个 job 里完成收尾，
        // 否则如果 pending_dirs 变空且没有再 re-enqueue，下次重启会认为从未完成，从而重复全量扫描。
        self.finish_workspace_scan(workstudio_id, &roots_key).await;

        Ok(())
    }

    async fn finish_workspace_scan(&self, workstudio_id: &str, roots_key: &str) {
        // Best-effort: 记录一次“全量扫描完成”，用于下次重启跳过重复扫描。
        if let Ok(dbh) = self.get_db_handle(workstudio_id).await {
            let roots_key2 = roots_key.to_string();
            let done = now_ms();
            let _ = tokio::task::spawn_blocking(move || {
                let guard = dbh.lock().map_err(|e| format!("索引 DB 锁失败: {e}"))?;
                let _ = guard.set_meta("full_scan_roots", roots_key2.as_str());
                let _ = guard.set_meta("full_scan_completed_at_ms", done.to_string().as_str());
                Ok::<(), String>(())
            })
            .await;
        }

        {
            let mut st = self.queue.lock().await;
            st.scans.remove(workstudio_id);
        }

        self.emit_event(
            workstudio_id,
            CodeIndexEvent::Progress {
                phase: "scan".to_string(),
                done: 1,
                total: Some(1),
                message: "索引扫描完成".to_string(),
            },
        );
    }

    fn emit_event(&self, workstudio_id: &str, event: CodeIndexEvent) {
        let payload = CodeIndexEventPayload {
            workstudio_id: workstudio_id.to_string(),
            timestamp_ms: now_ms(),
            event,
        };
        let _ = self.app.emit(CODE_INDEX_EVENT_NAME, payload);
    }
}

fn job_key(kind: &JobKind) -> String {
    match kind {
        JobKind::IndexDocumentSymbols {
            workstudio_id,
            file_path,
            language_id: _,
            force: _,
        } => format!("ds|{workstudio_id}|{file_path}"),
        JobKind::ScanWorkspace { workstudio_id } => format!("scan|{workstudio_id}"),
    }
}

fn normalize_fs_path(path: &str) -> String {
    let s = path.trim().replace('\\', "/");
    if s.is_empty() {
        return String::new();
    }
    // 保守：不做复杂的 realpath 规整（避免权限/不存在路径带来的失败），仅做基础清洗。
    s
}

fn code_index_db_path(root_dir: &Path, workstudio_id: &str) -> PathBuf {
    let safe: String = workstudio_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    root_dir.join(format!("{safe}.db"))
}

fn should_skip_dir_name(name_lower: &str) -> bool {
    matches!(
        name_lower,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".idea"
            | ".vscode"
            | ".turbo"
            | ".next"
            | ".tauri-ai"
            | ".tauriai"
    )
}

fn ast_symbols_to_workspace_search_results(
    file_path: &str,
    language_id: &str,
    updated_at_ms: i64,
    symbols: &[AstSymbol],
) -> Vec<CodeIndexWorkspaceSymbolSearchResult> {
    fn to_line(value: u32) -> u32 {
        value.saturating_add(1)
    }

    fn walk(
        out: &mut Vec<CodeIndexWorkspaceSymbolSearchResult>,
        seen: &mut HashMap<String, usize>,
        file_path: &str,
        language_id: &str,
        updated_at_ms: i64,
        ancestors: &mut Vec<String>,
        symbols: &[AstSymbol],
    ) {
        for symbol in symbols {
            let name = symbol.name.trim();
            if name.is_empty() {
                continue;
            }

            let base_id = format!(
                "{}::{}::{}::{}::{}",
                file_path,
                name,
                to_line(symbol.selection_range.start.line),
                to_line(symbol.selection_range.start.character),
                symbol.kind.trim()
            );
            let next_count = seen.entry(base_id.clone()).or_insert(0);
            *next_count += 1;
            let symbol_id = if *next_count <= 1 {
                base_id
            } else {
                format!("{}#{}", base_id, *next_count)
            };

            out.push(CodeIndexWorkspaceSymbolSearchResult {
                symbol_id,
                file_path: file_path.to_string(),
                symbol_name: name.to_string(),
                symbol_kind: symbol.kind.trim().to_string(),
                detail: None,
                container_name: if ancestors.is_empty() {
                    None
                } else {
                    Some(ancestors.join(" › "))
                },
                selection_line: to_line(symbol.selection_range.start.line),
                selection_column: to_line(symbol.selection_range.start.character),
                range_start_line: to_line(symbol.range.start.line),
                range_start_column: to_line(symbol.range.start.character),
                range_end_line: to_line(symbol.range.end.line),
                range_end_column: to_line(symbol.range.end.character),
                language_id: language_id.to_string(),
                updated_at_ms,
            });

            if !symbol.children.is_empty() {
                ancestors.push(name.to_string());
                walk(
                    out,
                    seen,
                    file_path,
                    language_id,
                    updated_at_ms,
                    ancestors,
                    &symbol.children,
                );
                ancestors.pop();
            }
        }
    }

    let mut out = Vec::new();
    let mut seen = HashMap::new();
    let mut ancestors = Vec::new();
    walk(
        &mut out,
        &mut seen,
        file_path,
        language_id,
        updated_at_ms,
        &mut ancestors,
        symbols,
    );
    out
}

fn best_language_id_for_path(path: &str, hint_language_id: &str) -> Option<&'static str> {
    let p = path.trim().to_ascii_lowercase();
    if p.is_empty() {
        return None;
    }

    // Strong override by file extension (important for TSX/JSX).
    if p.ends_with(".tsx") || p.ends_with(".jsx") {
        return Some("tsx");
    }

    // Prefer hint if it is supported by AST.
    let hint = hint_language_id.trim();
    if !hint.is_empty() {
        match hint {
            "rust" => return Some("rust"),
            "typescript" => return Some("typescript"),
            "javascript" => return Some("javascript"),
            "tsx" => return Some("tsx"),
            "python" => return Some("python"),
            "go" => return Some("go"),
            "c" => return Some("c"),
            "cpp" => return Some("cpp"),
            "lua" => return Some("lua"),
            _ => {}
        }
    }

    if p.ends_with(".rs") {
        return Some("rust");
    }
    if p.ends_with(".ts") {
        return Some("typescript");
    }
    if p.ends_with(".js") {
        return Some("javascript");
    }
    if p.ends_with(".py") {
        return Some("python");
    }
    if p.ends_with(".go") {
        return Some("go");
    }
    if p.ends_with(".lua") {
        return Some("lua");
    }
    if p.ends_with(".c") {
        return Some("c");
    }

    // C/C++ family
    if p.ends_with(".cc")
        || p.ends_with(".cpp")
        || p.ends_with(".cxx")
        || p.ends_with(".h")
        || p.ends_with(".hh")
        || p.ends_with(".hpp")
        || p.ends_with(".hxx")
        || p.ends_with(".inl")
        || p.ends_with(".ipp")
        || p.ends_with(".ixx")
        || p.ends_with(".cppm")
    {
        return Some("cpp");
    }

    None
}

fn workstudio_roots(ws: &Workstudio) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    let mf = ws.main_folder.trim();
    if !mf.is_empty() {
        roots.push(mf.to_string());
    }
    for f in &ws.folders {
        let f = f.trim();
        if f.is_empty() {
            continue;
        }
        roots.push(f.to_string());
    }
    roots.sort();
    roots.dedup();
    roots
}

async fn read_file_meta(path: &str) -> Option<FileMeta> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    let size_bytes = Some(meta.len() as i64);
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    Some(FileMeta {
        mtime_ms,
        size_bytes,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
