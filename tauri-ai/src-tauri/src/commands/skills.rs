use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::Manager;

use crate::config::ConfigManager;
use crate::skills::loader::{load_skills, make_skill_markdown};
use crate::skills::watcher::SkillsWatcherState;
use crate::skills::{ListSkillsArgs, SkillLoadOutcome, SkillRootsSnapshot};

fn skills_dir_from_config_manager(config_manager: &ConfigManager) -> Option<PathBuf> {
    config_manager
        .config_path()
        .parent()
        .map(|p| p.join("skills"))
}

fn repo_skills_dir_from_app(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Prefer bundled resources: `resources/skills/` -> `<resource_dir>/skills`
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("skills");
        if p.is_dir() {
            return Some(p);
        }
    }
    // Dev fallback: prefer build-time manifest dir (stable even if runtime cwd changes).
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        let manifest = PathBuf::from(manifest_dir);
        if let Some(parent) = manifest.parent() {
            let p = parent.join("skills");
            if p.is_dir() {
                return Some(p);
            }
        }
        if let Some(grand) = manifest.parent().and_then(|p| p.parent()) {
            let p = grand.join("tauri-ai").join("skills");
            if p.is_dir() {
                return Some(p);
            }
            let p2 = grand.join("skills");
            if p2.is_dir() {
                return Some(p2);
            }
        }
    }

    // Fallbacks: search from executable directory and current working directory (and their ancestors).
    let try_from_ancestors = |base: &Path| -> Option<PathBuf> {
        for dir in base.ancestors().take(8) {
            let p = dir.join("tauri-ai").join("skills");
            if p.is_dir() {
                return Some(p);
            }
            let p2 = dir.join("skills");
            if p2.is_dir() {
                return Some(p2);
            }
        }
        None
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(found) = try_from_ancestors(parent) {
                return Some(found);
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = try_from_ancestors(&cwd) {
            return Some(found);
        }
    }
    None
}

fn workstudio_skills_dir(workstudio_main_folder: Option<&str>) -> Option<PathBuf> {
    let main = workstudio_main_folder.map(|s| s.trim()).filter(|s| !s.is_empty())?;
    let p = PathBuf::from(main).join("skills");
    p.is_dir().then_some(p)
}

#[tauri::command]
pub async fn list_skills(
    args: Option<ListSkillsArgs>,
    app: tauri::AppHandle,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    watcher: tauri::State<'_, SkillsWatcherState>,
) -> Result<(SkillRootsSnapshot, SkillLoadOutcome), String> {
    let args = args.unwrap_or_default();

    let app_dir = skills_dir_from_config_manager(&config_manager);
    let repo_dir = repo_skills_dir_from_app(&app);
    let ws_dir = workstudio_skills_dir(args.workstudio_main_folder.as_deref());

    // Hot reload: watch roots (best-effort)
    if let Some(p) = app_dir.as_deref() {
        watcher.0.ensure_watch_dir(p);
    }
    if let Some(p) = repo_dir.as_deref() {
        watcher.0.ensure_watch_dir(p);
    }
    if let Some(p) = ws_dir.as_deref() {
        watcher.0.ensure_watch_dir(p);
    }

    let outcome = load_skills(
        app_dir.as_deref(),
        repo_dir.as_deref(),
        ws_dir.as_deref(),
        args.include_contents,
    );

    let snapshot = SkillRootsSnapshot {
        app_skills_dir: app_dir.map(|p| p.to_string_lossy().into_owned()),
        repo_skills_dir: repo_dir.map(|p| p.to_string_lossy().into_owned()),
        workstudio_skills_dir: ws_dir.map(|p| p.to_string_lossy().into_owned()),
    };

    Ok((snapshot, outcome))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillArgs {
    /// "app" | "workstudio"
    #[serde(default)]
    pub target: String,
    /// Only required when target=workstudio.
    #[serde(default)]
    pub workstudio_main_folder: Option<String>,
    pub category: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub body: String,
    /// Optional directory name (under category). If empty, derived from `name`.
    #[serde(default)]
    pub dir_name: Option<String>,
    /// If true, overwrite existing SKILL.md.
    #[serde(default)]
    pub overwrite: bool,
}

fn sanitize_dir_segment(value: &str) -> String {
    let mut out = String::new();
    for ch in value.trim().chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.';
        if ok {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "skill".to_string()
    } else {
        out
    }
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("创建目录失败 {}: {e}", path.display()))
}

#[tauri::command]
pub async fn create_skill(
    args: CreateSkillArgs,
    config_manager: tauri::State<'_, Arc<ConfigManager>>,
    watcher: tauri::State<'_, SkillsWatcherState>,
) -> Result<String, String> {
    let target = args.target.trim().to_ascii_lowercase();
    let category = sanitize_dir_segment(&args.category);
    if category.is_empty() {
        return Err("category 不能为空".to_string());
    }

    let base_dir = if target == "workstudio" {
        let main = args
            .workstudio_main_folder
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "workstudio_main_folder 不能为空".to_string())?;
        PathBuf::from(main).join("skills")
    } else {
        skills_dir_from_config_manager(&config_manager).ok_or_else(|| "无法定位应用 skills 目录".to_string())?
    };

    ensure_dir(&base_dir)?;
    watcher.0.ensure_watch_dir(&base_dir);

    let dir_name = args
        .dir_name
        .as_deref()
        .map(sanitize_dir_segment)
        .unwrap_or_else(|| sanitize_dir_segment(&args.name));

    let skill_dir = base_dir.join(&category).join(&dir_name);
    ensure_dir(&skill_dir)?;

    let skill_path = skill_dir.join("SKILL.md");
    if skill_path.exists() && !args.overwrite {
        return Err(format!(
            "SKILL.md 已存在：{}（如需覆盖请设置 overwrite=true）",
            skill_path.display()
        ));
    }

    let md = make_skill_markdown(
        &args.name,
        &args.description,
        args.short_description.as_deref(),
        &args.body,
    );
    tokio::fs::write(&skill_path, md)
        .await
        .map_err(|e| format!("写入 SKILL.md 失败 {}: {e}", skill_path.display()))?;

    Ok(skill_path.to_string_lossy().into_owned())
}
