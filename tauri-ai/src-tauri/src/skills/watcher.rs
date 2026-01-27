use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

#[derive(Clone)]
pub struct SkillsWatcher {
    app: AppHandle,
    inner: Arc<StdMutex<SkillsWatcherInner>>,
}

struct SkillsWatcherInner {
    watchers: HashMap<PathBuf, RecommendedWatcher>,
}

impl SkillsWatcher {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Arc::new(StdMutex::new(SkillsWatcherInner {
                watchers: HashMap::new(),
            })),
        }
    }

    /// Best-effort: watch a directory recursively and emit `skills:changed` when anything changes.
    /// This is used to make skills "实时刷新" without restarting the app.
    pub fn ensure_watch_dir(&self, dir: &Path) {
        let Ok(dir) = dunce::canonicalize(dir) else {
            return;
        };
        if !dir.is_dir() {
            return;
        }

        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if guard.watchers.contains_key(&dir) {
            return;
        }

        let app = self.app.clone();
        let mut watcher = match notify::recommended_watcher(move |_res: Result<notify::Event, notify::Error>| {
            // Debounce is handled by notify's internal coalescing. We also throttle on UI side if needed.
            let _ = app.emit("skills:changed", ());
        }) {
            Ok(w) => w,
            Err(_) => return,
        };

        // Some platforms require an explicit poll interval to be stable.
        let _ = watcher.configure(notify::Config::default().with_poll_interval(Duration::from_secs(2)));
        if watcher.watch(&dir, RecursiveMode::Recursive).is_ok() {
            guard.watchers.insert(dir, watcher);
        }
    }
}

/// Managed state wrapper (so we can `.manage()` it).
#[derive(Clone)]
pub struct SkillsWatcherState(pub SkillsWatcher);
