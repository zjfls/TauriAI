use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{
    event::{CreateKind, ModifyKind, RemoveKind},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const WORKSTUDIO_FILE_DISK_CHANGED_EVENT: &str = "workstudio:file_disk_changed";

#[derive(Clone)]
pub struct WorkstudioFsWatcher {
    app: AppHandle,
    inner: Arc<StdMutex<WorkstudioFsWatcherInner>>,
}

struct WorkstudioFsWatcherInner {
    watchers: HashMap<String, RootWatcherRecord>,
    subscriptions: HashMap<String, WindowSubscription>,
}

struct RootWatcherRecord {
    _watch_path: PathBuf,
    _watcher: RecommendedWatcher,
    windows: HashSet<String>,
}

#[derive(Clone)]
struct WindowSubscription {
    workstudio_id: String,
    roots: HashSet<String>,
    open_paths: HashSet<String>,
}

#[derive(Clone)]
pub struct WorkstudioFsWatcherState(pub WorkstudioFsWatcher);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkstudioFileDiskChangedPayload {
    workstudio_id: String,
    path: String,
    kind: &'static str,
    old_path: Option<String>,
    is_dir: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileSnapshot {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
}

impl WorkstudioFsWatcher {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Arc::new(StdMutex::new(WorkstudioFsWatcherInner {
                watchers: HashMap::new(),
                subscriptions: HashMap::new(),
            })),
        }
    }

    pub fn sync_window_watch(
        &self,
        window_label: &str,
        workstudio_id: &str,
        roots: &[String],
        open_paths: &[String],
    ) -> Result<(), String> {
        let window_label = window_label.trim();
        if window_label.is_empty() {
            return Err("windowLabel 不能为空".to_string());
        }

        let normalized_roots = normalize_watch_roots(roots);
        let normalized_open_paths = normalize_open_paths(open_paths);

        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };

        if let Some(prev) = guard.subscriptions.remove(window_label) {
            detach_window_from_roots(&mut guard, window_label, &prev.roots);
        }

        for (root_key, watch_path) in &normalized_roots {
            ensure_root_watcher(&self.clone(), &mut guard, root_key, watch_path)?;
            if let Some(rec) = guard.watchers.get_mut(root_key) {
                rec.windows.insert(window_label.to_string());
            }
        }

        guard.subscriptions.insert(
            window_label.to_string(),
            WindowSubscription {
                workstudio_id: workstudio_id.trim().to_string(),
                roots: normalized_roots.keys().cloned().collect(),
                open_paths: normalized_open_paths,
            },
        );

        Ok(())
    }

    pub fn unwatch_window(&self, window_label: &str) {
        let window_label = window_label.trim();
        if window_label.is_empty() {
            return;
        }

        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };

        if let Some(prev) = guard.subscriptions.remove(window_label) {
            detach_window_from_roots(&mut guard, window_label, &prev.roots);
        }
    }

    fn handle_notify(&self, event: Event) {
        let Some(kind) = classify_event_kind(&event.kind) else {
            return;
        };

        let normalized_paths = normalize_event_paths(&event.paths);
        if normalized_paths.is_empty() {
            return;
        }

        let mut deliveries: Vec<(String, WorkstudioFileDiskChangedPayload)> = Vec::new();
        {
            let guard = match self.inner.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };

            let mut sent = HashSet::<String>::new();
            for (window_label, sub) in &guard.subscriptions {
                if sub.open_paths.is_empty() {
                    continue;
                }

                for changed_path in &normalized_paths {
                    if !sub.open_paths.contains(changed_path) {
                        continue;
                    }

                    let dedupe_key = format!("{window_label}\n{changed_path}\n{kind}");
                    if !sent.insert(dedupe_key) {
                        continue;
                    }

                    let payload = WorkstudioFileDiskChangedPayload {
                        workstudio_id: sub.workstudio_id.clone(),
                        path: changed_path.clone(),
                        kind,
                        old_path: None,
                        is_dir: false,
                    };
                    deliveries.push((window_label.clone(), payload));
                }
            }
        }

        if deliveries.is_empty() {
            return;
        }

        let mut stale_windows = Vec::<String>::new();
        for (window_label, payload) in deliveries {
            if let Some(window) = self.app.get_webview_window(&window_label) {
                let _ = window.emit(WORKSTUDIO_FILE_DISK_CHANGED_EVENT, payload);
            } else {
                stale_windows.push(window_label);
            }
        }

        if !stale_windows.is_empty() {
            let mut unique = HashSet::new();
            for label in stale_windows {
                if unique.insert(label.clone()) {
                    self.unwatch_window(&label);
                }
            }
        }
    }
}

fn ensure_root_watcher(
    owner: &WorkstudioFsWatcher,
    inner: &mut WorkstudioFsWatcherInner,
    root_key: &str,
    watch_path: &PathBuf,
) -> Result<(), String> {
    if inner.watchers.contains_key(root_key) {
        return Ok(());
    }

    let owner = owner.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            owner.handle_notify(event);
        }
    })
    .map_err(|e| format!("create workstudio fs watcher failed: {e}"))?;

    let _ = watcher.configure(notify::Config::default().with_poll_interval(Duration::from_secs(2)));
    watcher
        .watch(watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("watch workstudio root failed ({}): {e}", watch_path.display()))?;

    inner.watchers.insert(
        root_key.to_string(),
        RootWatcherRecord {
            _watch_path: watch_path.clone(),
            _watcher: watcher,
            windows: HashSet::new(),
        },
    );

    Ok(())
}

fn detach_window_from_roots(
    inner: &mut WorkstudioFsWatcherInner,
    window_label: &str,
    roots: &HashSet<String>,
) {
    let mut to_remove = Vec::new();
    for root_key in roots {
        if let Some(rec) = inner.watchers.get_mut(root_key) {
            rec.windows.remove(window_label);
            if rec.windows.is_empty() {
                to_remove.push(root_key.clone());
            }
        }
    }

    for root_key in to_remove {
        inner.watchers.remove(&root_key);
    }
}

fn normalize_watch_roots(roots: &[String]) -> HashMap<String, PathBuf> {
    let mut out = HashMap::<String, PathBuf>::new();
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut watch_path = PathBuf::from(trimmed);
        if watch_path.is_file() {
            if let Some(parent) = watch_path.parent() {
                watch_path = parent.to_path_buf();
            }
        }

        let Ok(canonical) = dunce::canonicalize(&watch_path) else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }

        let key = normalize_fs_path(&canonical.to_string_lossy());
        if key.is_empty() {
            continue;
        }
        out.entry(key).or_insert(canonical);
    }
    out
}

fn normalize_open_paths(paths: &[String]) -> HashSet<String> {
    paths.iter()
        .map(|path| canonicalize_best_effort(path))
        .filter(|path| !path.is_empty() && !should_ignore_path(path))
        .collect()
}

fn normalize_event_paths(paths: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    for path in paths {
        let normalized = canonicalize_best_effort_path(path);
        if normalized.is_empty() || should_ignore_path(&normalized) {
            continue;
        }
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out
}

fn classify_event_kind(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(CreateKind::Any)
        | EventKind::Create(CreateKind::File)
        | EventKind::Create(CreateKind::Folder)
        | EventKind::Create(CreateKind::Other) => Some("create"),
        EventKind::Modify(ModifyKind::Any)
        | EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Modify(ModifyKind::Other) => Some("modify"),
        EventKind::Modify(ModifyKind::Name(_)) => Some("rename"),
        EventKind::Remove(RemoveKind::Any)
        | EventKind::Remove(RemoveKind::File)
        | EventKind::Remove(RemoveKind::Folder)
        | EventKind::Remove(RemoveKind::Other) => Some("remove"),
        _ => None,
    }
}

fn normalize_fs_path(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut path = trimmed.replace('\\', "/");
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        let mut chars = path.chars();
        let drive = chars.next().unwrap_or_default().to_ascii_uppercase();
        let rest: String = chars.collect();
        path = format!("{drive}{rest}");
    }

    if path.len() > 1 && path.ends_with('/') {
        let is_windows_drive_root = path.len() == 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/';
        let is_unc_root = path == "//";
        if !is_windows_drive_root && !is_unc_root {
            while path.len() > 1 && path.ends_with('/') {
                let is_root = path.len() == 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/';
                if is_root {
                    break;
                }
                path.pop();
            }
        }
    }

    path
}

fn canonicalize_best_effort(path: &str) -> String {
    let p = Path::new(path.trim());
    canonicalize_best_effort_path(p)
}

fn canonicalize_best_effort_path(path: &Path) -> String {
    dunce::canonicalize(path)
        .map(|p| normalize_fs_path(&p.to_string_lossy()))
        .unwrap_or_else(|_| normalize_fs_path(&path.to_string_lossy()))
}

fn should_ignore_path(path: &str) -> bool {
    let normalized = normalize_fs_path(path).to_ascii_lowercase();
    normalized.contains("/.git/")
        || normalized.ends_with("/.git")
        || normalized.ends_with("/.tauriai/workstudio_state.json")
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_millis().min(u128::from(u64::MAX)) as u64)
}

#[tauri::command]
pub async fn workstudio_fs_sync_watch(
    window_label: String,
    workstudio_id: String,
    roots: Vec<String>,
    open_paths: Vec<String>,
    watcher: tauri::State<'_, WorkstudioFsWatcherState>,
) -> Result<(), String> {
    watcher
        .0
        .sync_window_watch(&window_label, &workstudio_id, &roots, &open_paths)
}

#[tauri::command]
pub async fn workstudio_fs_unwatch(
    window_label: String,
    watcher: tauri::State<'_, WorkstudioFsWatcherState>,
) -> Result<(), String> {
    watcher.0.unwatch_window(&window_label);
    Ok(())
}

#[tauri::command]
pub async fn get_local_file_snapshots(paths: Vec<String>) -> Result<Vec<LocalFileSnapshot>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let normalized = canonicalize_best_effort(&raw);
        if normalized.is_empty() {
            continue;
        }

        let path_buf = PathBuf::from(&normalized);
        match tokio::fs::metadata(&path_buf).await {
            Ok(meta) => out.push(LocalFileSnapshot {
                path: normalized,
                exists: true,
                is_file: meta.is_file(),
                size: Some(meta.len()),
                modified_ms: modified_ms(&meta),
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => out.push(LocalFileSnapshot {
                path: normalized,
                exists: false,
                is_file: false,
                size: None,
                modified_ms: None,
            }),
            Err(e) => return Err(format!("read local file snapshot failed: {e}")),
        }
    }
    Ok(out)
}
