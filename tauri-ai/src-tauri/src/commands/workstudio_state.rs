//! Workstudio UI state persistence (open files, split, etc.).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::models::WorkstudioUiState;
use crate::storage::Database;

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

fn read_state_file(path: &PathBuf) -> Result<WorkstudioStateFile, String> {
    if !path.exists() {
        return Ok(WorkstudioStateFile::default());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read workstudio_state.json failed: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse workstudio_state.json failed: {e}"))
}

fn write_state_file(path: &PathBuf, data: &WorkstudioStateFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create .tauriai failed: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(data).map_err(|e| format!("serialize state failed: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("write workstudio_state.json failed: {e}"))
}

#[tauri::command]
pub async fn get_workstudio_ui_state(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<WorkstudioUiState>, String> {
    let db = db.lock().await;
    let ws = db
        .get_workstudio(&workstudio_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;

    // Preferred: store state inside the main folder (.tauriai/workstudio_state.json).
    let path = state_file_path(&ws.main_folder);
    let mut file = read_state_file(&path)?;
    if let Some(state) = file.states.get(&ws.kind).cloned() {
        return Ok(Some(state));
    }

    // Migration fallback: read legacy DB state once, then write into folder.
    if let Ok(Some(legacy)) = db.get_workstudio_ui_state(&ws.main_folder, &ws.kind) {
        file.states.insert(ws.kind.clone(), legacy.clone());
        let _ = write_state_file(&path, &file);
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
    let db = db.lock().await;
    let ws = db
        .get_workstudio(&workstudio_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;

    let path = state_file_path(&ws.main_folder);
    let mut file = read_state_file(&path)?;
    file.states.insert(ws.kind.clone(), state);
    write_state_file(&path, &file)?;
    Ok(())
}
