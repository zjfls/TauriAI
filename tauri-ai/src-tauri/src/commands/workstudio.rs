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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstudioFindFilesArgs {
    pub workstudio_id: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[tauri::command]
pub async fn workstudio_find_files(
    args: WorkstudioFindFilesArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<String>, String> {
    let query = args.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = args.limit.unwrap_or(100).max(1).min(2000) as usize;

    let ws = {
        let db = db.lock().await;
        db.get_workstudio(&args.workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let mut roots = Vec::new();
    if !ws.main_folder.trim().is_empty() {
        roots.push(ws.main_folder);
    }
    roots.extend(ws.folders.into_iter().filter(|p| !p.trim().is_empty()));

    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for root in roots {
        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if out.len() >= limit {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if file_name.is_empty() {
                continue;
            }
            // Cheap ignores
            let pstr = path.to_string_lossy();
            if pstr.contains("/.git/")
                || pstr.contains("/node_modules/")
                || pstr.contains("/target/")
            {
                continue;
            }
            if !file_name.to_lowercase().contains(&query) && !pstr.to_lowercase().contains(&query) {
                continue;
            }
            let p = pstr.into_owned();
            if seen.insert(p.clone()) {
                out.push(p);
            }
        }
    }

    out.sort();
    Ok(out)
}
