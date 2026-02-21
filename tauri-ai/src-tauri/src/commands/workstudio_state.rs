//! Workstudio UI state persistence (open files, split, etc.).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::fs;
use tokio::sync::Mutex;

use crate::models::WorkstudioUiState;
use crate::storage::async_db;
use crate::storage::Database;

fn state_io_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn state_file_path(main_folder: &str) -> PathBuf {
    PathBuf::from(main_folder)
        .join(".tauriai")
        .join("workstudio_state.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkstudioStateFile {
    version: u32,
    /// key: workstudio kind (e.g. "code", "doc")
    states: BTreeMap<String, WorkstudioUiState>,
}

impl Default for WorkstudioStateFile {
    fn default() -> Self {
        Self {
            version: 1,
            states: BTreeMap::new(),
        }
    }
}

async fn read_state_file(path: &PathBuf) -> Result<WorkstudioStateFile, String> {
    match fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse workstudio_state.json failed: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WorkstudioStateFile::default()),
        Err(e) => Err(format!("read workstudio_state.json failed: {e}")),
    }
}

async fn write_state_file(path: &PathBuf, data: &WorkstudioStateFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create .tauriai failed: {e}"))?;
    }
    let json =
        serde_json::to_vec_pretty(data).map_err(|e| format!("serialize state failed: {e}"))?;
    fs::write(path, json)
        .await
        .map_err(|e| format!("write workstudio_state.json failed: {e}"))
}

#[tauri::command]
pub async fn get_workstudio_ui_state(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioUiState>, String> {
    let (main_folder, kind, legacy_state) = {
        let db = async_db::lock_db(db.inner(), "get_workstudio_ui_state")
            .await
            .map_err(|e| e.to_string())?;
        let ws = db
            .get_workstudio(&workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;

        // Migration fallback: read legacy DB state once, then write into folder.
        let legacy_state = db
            .get_workstudio_ui_state(&ws.main_folder, &ws.kind)
            .ok()
            .flatten();

        (ws.main_folder, ws.kind, legacy_state)
    };

    // Preferred: store state inside the main folder (.tauriai/workstudio_state.json).
    //
    // Important: do NOT hold the DB mutex while doing filesystem I/O.
    // Otherwise a slow/hanging FS operation can block unrelated DB calls (e.g. get_workstudio),
    // making Workstudio appear “stuck loading” after certain UI actions.
    let _io_guard = state_io_lock().lock().await;
    let path = state_file_path(&main_folder);
    let mut file = read_state_file(&path).await?;
    if let Some(state) = file.states.get(&kind).cloned() {
        return Ok(Some(state));
    }

    if let Some(legacy) = legacy_state {
        file.states.insert(kind, legacy.clone());
        let _ = write_state_file(&path, &file).await;
        return Ok(Some(legacy));
    }

    Ok(None)
}

#[tauri::command]
pub async fn set_workstudio_ui_state(
    workstudio_id: String,
    state: WorkstudioUiState,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let (main_folder, kind) = {
        let db = async_db::lock_db(db.inner(), "set_workstudio_ui_state")
            .await
            .map_err(|e| e.to_string())?;
        let ws = db
            .get_workstudio(&workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;
        (ws.main_folder, ws.kind)
    };

    let _io_guard = state_io_lock().lock().await;
    let path = state_file_path(&main_folder);
    let mut file = read_state_file(&path).await?;
    file.states.insert(kind, state);
    write_state_file(&path, &file).await?;
    Ok(())
}
