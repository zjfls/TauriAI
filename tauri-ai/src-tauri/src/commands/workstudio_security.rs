use std::sync::Arc;

use tokio::sync::Mutex;

use crate::storage::Database;
use crate::workstudio_security::{
    read_workstudio_security_config, write_workstudio_security_config, WorkstudioSecurityConfig,
};

#[tauri::command]
pub async fn get_workstudio_security_config(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<WorkstudioSecurityConfig, String> {
    let db = db.lock().await;
    let ws = db
        .get_workstudio(&workstudio_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;

    read_workstudio_security_config(&ws.main_folder)
}

#[tauri::command]
pub async fn set_workstudio_security_config(
    workstudio_id: String,
    config: WorkstudioSecurityConfig,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().await;
    let ws = db
        .get_workstudio(&workstudio_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workstudio {workstudio_id} not found"))?;

    write_workstudio_security_config(&ws.main_folder, &config)
}
