//! Workstudio (workspace) management commands.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::models::Workstudio;
use crate::storage::Database;

#[tauri::command]
pub async fn ensure_workstudio_for_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    let db = db.lock().await;
    db.ensure_workstudio_for_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workstudio(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<Workstudio>, String> {
    let db = db.lock().await;
    db.get_workstudio(&workstudio_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_workstudio_folder(
    workstudio_id: String,
    folder: String,
    set_as_main: Option<bool>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    let db = db.lock().await;
    db.add_workstudio_folder(&workstudio_id, &folder, set_as_main.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_workstudio(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    let db = db.lock().await;
    db.create_workstudio().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_workstudio_main_folder(
    workstudio_id: String,
    folder: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    let db = db.lock().await;
    db.set_workstudio_main_folder(&workstudio_id, &folder)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_workstudio_folder(
    workstudio_id: String,
    folder: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    let db = db.lock().await;
    db.remove_workstudio_folder(&workstudio_id, &folder)
        .map_err(|e| e.to_string())
}
