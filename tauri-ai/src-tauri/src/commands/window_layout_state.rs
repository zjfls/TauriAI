use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use tokio::fs;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLayoutBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLayoutRecord {
    pub label: String,
    pub title: String,
    pub params: serde_json::Value,
    pub bounds: Option<WindowLayoutBounds>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLayoutState {
    pub version: u32,
    pub windows: Vec<WindowLayoutRecord>,
}

impl Default for WindowLayoutState {
    fn default() -> Self {
        Self {
            version: 1,
            windows: Vec::new(),
        }
    }
}

fn io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn persist_revisions() -> &'static Mutex<HashMap<String, u64>> {
    static STATE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remove_revisions() -> &'static Mutex<HashMap<String, u64>> {
    static STATE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_revision() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn tracked_window_label(label: &str) -> bool {
    let key = label.trim();
    key == "main" || key.starts_with("view-") || key.starts_with("workspace-")
}

fn layout_file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("window_layout.json"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn read_layout_file(path: &PathBuf) -> Result<WindowLayoutState, String> {
    match fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse window_layout.json failed: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WindowLayoutState::default()),
        Err(e) => Err(format!("read window_layout.json failed: {e}")),
    }
}

async fn write_layout_file(path: &PathBuf, state: &WindowLayoutState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create app config dir failed: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("serialize window layout failed: {e}"))?;
    fs::write(path, json)
        .await
        .map_err(|e| format!("write window_layout.json failed: {e}"))
}

fn params_override_existing(params: &serde_json::Value) -> bool {
    match params {
        serde_json::Value::Null => false,
        serde_json::Value::Object(map) => !map.is_empty(),
        _ => true,
    }
}

fn merge_window_layout_record(
    existing: Option<&WindowLayoutRecord>,
    mut incoming: WindowLayoutRecord,
) -> WindowLayoutRecord {
    let label = incoming.label.trim().to_string();
    incoming.label = label;

    if let Some(current) = existing {
        if incoming.title.trim().is_empty() {
            incoming.title = current.title.clone();
        }
        if incoming.bounds.is_none() {
            incoming.bounds = current.bounds.clone();
        }
        if !params_override_existing(&incoming.params) {
            incoming.params = current.params.clone();
        }
        if incoming.updated_at < current.updated_at {
            incoming.updated_at = current.updated_at;
        }
    }

    incoming
}

async fn upsert_record_internal<R: Runtime>(
    app: &AppHandle<R>,
    record: WindowLayoutRecord,
) -> Result<(), String> {
    let label = record.label.trim().to_string();
    if label.is_empty() {
        return Ok(());
    }

    let _guard = io_lock().lock().await;
    let path = layout_file_path(app)?;
    let mut state = read_layout_file(&path).await?;
    let existing = state
        .windows
        .iter()
        .find(|item| item.label == label)
        .cloned();
    state.windows.retain(|item| item.label != label);

    let mut next = merge_window_layout_record(existing.as_ref(), record);
    next.label = label;
    state.windows.push(next);
    write_layout_file(&path, &state).await
}

async fn remove_record_internal<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let key = label.trim().to_string();
    if key.is_empty() {
        return Ok(());
    }

    let _guard = io_lock().lock().await;
    let path = layout_file_path(app)?;
    let mut state = read_layout_file(&path).await?;
    state.windows.retain(|item| item.label != key);
    write_layout_file(&path, &state).await
}

fn snapshot_bounds<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<Option<WindowLayoutBounds>, String> {
    let Some(window) = app.get_webview_window(label) else {
        return Ok(None);
    };

    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(Some(WindowLayoutBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    }))
}

pub async fn persist_window_layout_snapshot_now<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if !tracked_window_label(&label) {
        return Ok(());
    }

    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };

    let Some(bounds) = snapshot_bounds(app, &label)? else {
        return Ok(());
    };
    let title = window.title().unwrap_or_else(|_| label.clone());
    let updated_at = now_millis();

    let _guard = io_lock().lock().await;
    let path = layout_file_path(app)?;
    let mut state = read_layout_file(&path).await?;
    if let Some(record) = state.windows.iter_mut().find(|item| item.label == label) {
        record.title = title;
        record.bounds = Some(bounds);
        record.updated_at = updated_at;
        return write_layout_file(&path, &state).await;
    }

    Ok(())
}

pub fn schedule_persist_window_layout_snapshot<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    delay_ms: u64,
) {
    if !tracked_window_label(&label) {
        return;
    }

    let revision = next_revision();
    tauri::async_runtime::spawn(async move {
        {
            let mut revisions = persist_revisions().lock().await;
            revisions.insert(label.clone(), revision);
        }

        tokio::time::sleep(Duration::from_millis(delay_ms)).await;

        let should_run = {
            let revisions = persist_revisions().lock().await;
            revisions.get(&label).copied() == Some(revision)
        };
        if !should_run {
            return;
        }

        let _ = persist_window_layout_snapshot_now(&app, &label).await;

        let mut revisions = persist_revisions().lock().await;
        if revisions.get(&label).copied() == Some(revision) {
            revisions.remove(&label);
        }
    });
}

pub async fn persist_all_open_window_layouts_now<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    for (label, _window) in app.webview_windows() {
        let _ = persist_window_layout_snapshot_now(app, &label).await;
    }
    Ok(())
}

pub fn schedule_remove_window_layout_record_if_still_closed<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    delay_ms: u64,
) {
    if label.trim().is_empty() || label == "main" || !tracked_window_label(&label) {
        return;
    }

    let revision = next_revision();
    tauri::async_runtime::spawn(async move {
        {
            let mut revisions = remove_revisions().lock().await;
            revisions.insert(label.clone(), revision);
        }

        tokio::time::sleep(Duration::from_millis(delay_ms)).await;

        let should_run = {
            let revisions = remove_revisions().lock().await;
            revisions.get(&label).copied() == Some(revision)
        };
        if !should_run {
            return;
        }

        if app.get_webview_window(&label).is_none() {
            let _ = remove_record_internal(&app, &label).await;
        }

        let mut revisions = remove_revisions().lock().await;
        if revisions.get(&label).copied() == Some(revision) {
            revisions.remove(&label);
        }
    });
}

#[tauri::command]
pub async fn get_window_layout_state(app: AppHandle) -> Result<WindowLayoutState, String> {
    let _guard = io_lock().lock().await;
    let path = layout_file_path(&app)?;
    read_layout_file(&path).await
}

#[tauri::command]
pub async fn upsert_window_layout_record(
    app: AppHandle,
    record: WindowLayoutRecord,
) -> Result<(), String> {
    upsert_record_internal(&app, record).await
}

#[tauri::command]
pub async fn remove_window_layout_record(app: AppHandle, label: String) -> Result<(), String> {
    remove_record_internal(&app, &label).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(bounds: Option<WindowLayoutBounds>) -> WindowLayoutRecord {
        WindowLayoutRecord {
            label: "main".to_string(),
            title: "Main".to_string(),
            params: json!({"view": "chat", "standalone": false}),
            bounds,
            updated_at: 10,
        }
    }

    #[test]
    fn merge_keeps_existing_bounds_when_incoming_bounds_missing() {
        let existing = record(Some(WindowLayoutBounds {
            x: 120,
            y: 80,
            width: 1440,
            height: 900,
        }));
        let mut incoming = record(None);
        incoming.title = "Main Updated".to_string();
        incoming.updated_at = 20;

        let merged = merge_window_layout_record(Some(&existing), incoming);
        assert_eq!(merged.title, "Main Updated");
        assert_eq!(merged.updated_at, 20);
        assert_eq!(merged.bounds.unwrap().x, 120);
    }

    #[test]
    fn merge_keeps_existing_params_when_incoming_params_empty() {
        let existing = record(None);
        let mut incoming = record(None);
        incoming.params = json!({});
        incoming.updated_at = 5;

        let merged = merge_window_layout_record(Some(&existing), incoming);
        assert_eq!(merged.params, existing.params);
        assert_eq!(merged.updated_at, 10);
    }
}
