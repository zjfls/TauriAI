//! Workstudio (workspace) management commands.

use std::io::ErrorKind;
use std::sync::Arc;

use tokio::fs;
use tokio::sync::Mutex;

use crate::models::Workstudio;
use crate::storage::Database;

fn is_extension_query(query: &str) -> bool {
    let q = query.trim();
    if !q.starts_with('.') {
        return false;
    }
    if q.len() < 2 || q.len() > 32 {
        return false;
    }
    q[1..]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.')
}

fn should_skip_walk_entry(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return false;
    }
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    matches!(
        name.as_str(),
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
    )
}

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

/// Returns whether the workstudio main folder contains any "real" content (excluding `.tauriai/`).
///
/// Used by the history "folder view" to hide auto-created default workstudios that only have config.
#[tauri::command]
pub async fn workstudio_main_folder_has_real_content(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<bool, String> {
    let ws = {
        let db = db.lock().await;
        db.get_workstudio(&workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let main_folder = ws.main_folder.trim().to_string();
    if main_folder.is_empty() {
        return Ok(false);
    }

    let mut rd = match fs::read_dir(&main_folder).await {
        Ok(v) => v,
        Err(e) => {
            return Ok(match e.kind() {
                // Be conservative: if we can't read the directory (macOS privacy / permissions),
                // keep it visible rather than filtering it out.
                ErrorKind::PermissionDenied => true,
                // If the folder does not exist anymore, treat it as empty.
                ErrorKind::NotFound => false,
                _ => true,
            });
        }
    };

    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".tauriai" || name == ".DS_Store" {
            continue;
        }
        return Ok(true);
    }

    Ok(false)
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
    let match_by_extension = is_extension_query(&query);

    let ws = {
        let db = db.lock().await;
        db.get_workstudio(&args.workstudio_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Workstudio not found".to_string())?
    };

    let mut roots: Vec<String> = Vec::new();
    if !ws.main_folder.trim().is_empty() {
        roots.push(ws.main_folder);
    }
    roots.extend(ws.folders.into_iter().filter(|p| !p.trim().is_empty()));
    roots.sort();
    roots.dedup();

    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut readable_roots = 0usize;
    let mut unreadable_root_errors: Vec<String> = Vec::new();

    for root in roots {
        if out.len() >= limit {
            break;
        }
        match fs::read_dir(&root).await {
            Ok(_) => {
                readable_roots += 1;
            }
            Err(e) => {
                unreadable_root_errors.push(format!("{root}: {e}"));
                continue;
            }
        }

        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !should_skip_walk_entry(e))
        {
            if out.len() >= limit {
                break;
            }
            let entry = match entry {
                Ok(v) => v,
                Err(err) => {
                    // 提示：这里不返回 Err，是为了让“部分可读的工作区”仍能返回匹配结果。
                    // 但如果整个 workstudio 根目录不可读，下面会返回一个更明确的错误信息。
                    if let Some(path) = err.path() {
                        eprintln!("[workstudio_find_files] walk error: {}: {}", path.display(), err);
                    } else {
                        eprintln!("[workstudio_find_files] walk error: {err}");
                    }
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if file_name.is_empty() {
                continue;
            }

            let file_name_lower = file_name.to_ascii_lowercase();
            if match_by_extension {
                if !file_name_lower.ends_with(&query) {
                    continue;
                }
            } else {
                if !file_name_lower.contains(&query) {
                    let pstr = path.to_string_lossy();
                    let p_lower = pstr.to_ascii_lowercase();
                    if !p_lower.contains(&query) {
                        continue;
                    }
                }
            }

            let p = path.to_string_lossy().into_owned();
            if seen.insert(p.clone()) {
                out.push(p);
            }
        }
    }

    if out.is_empty() && readable_roots == 0 && !unreadable_root_errors.is_empty() {
        // 典型场景：macOS 隐私权限 / 沙盒导致无法读取 Documents/Desktop 等路径。
        // 返回 Err 让前端把错误展示出来（而不是“看起来像没匹配到文件”）。
        let msg = unreadable_root_errors
            .into_iter()
            .take(6)
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("无法读取工作区目录（可能缺少系统权限）：\n{msg}"));
    }

    out.sort();
    Ok(out)
}
