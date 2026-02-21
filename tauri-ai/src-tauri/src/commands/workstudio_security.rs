use std::sync::Arc;

use tokio::sync::Mutex;

use crate::storage::async_db;
use crate::storage::Database;
use crate::workstudio_security::{
    read_workstudio_security_config, write_workstudio_security_config, WorkstudioSecurityConfig,
};

#[tauri::command]
pub async fn get_workstudio_security_config(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<WorkstudioSecurityConfig, String> {
    let main_folder = {
        let db = async_db::lock_db(db.inner(), "get_workstudio_security_config")
            .await
            .map_err(|e| e.to_string())?;
        let ws = db
            .get_workstudio(&workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;
        ws.main_folder
    };

    // Avoid blocking the async runtime on filesystem I/O.
    tokio::task::spawn_blocking(move || read_workstudio_security_config(&main_folder))
        .await
        .map_err(|e| format!("read security.json join failed: {e}"))?
}

#[tauri::command]
pub async fn set_workstudio_security_config(
    workstudio_id: String,
    config: WorkstudioSecurityConfig,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let main_folder = {
        let db = async_db::lock_db(db.inner(), "set_workstudio_security_config")
            .await
            .map_err(|e| e.to_string())?;
        let ws = db
            .get_workstudio(&workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;
        ws.main_folder
    };

    tokio::task::spawn_blocking(move || write_workstudio_security_config(&main_folder, &config))
        .await
        .map_err(|e| format!("write security.json join failed: {e}"))?
}
