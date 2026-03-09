//! Workstudio (workspace) management commands.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::fs;
use tokio::sync::Mutex;

use crate::models::Workstudio;
use crate::storage::async_db;
use crate::storage::Database;

fn normalize_fs_path(input: &str) -> String {
    input.trim().replace('\\', "/")
}

fn is_absolute_fs_path(input: &str) -> bool {
    let normalized = normalize_fs_path(input);
    if normalized.starts_with("//") || normalized.starts_with('/') {
        return true;
    }
    let bytes = normalized.as_bytes();
    bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/'
}

fn normalize_root_path(input: &str) -> String {
    let normalized = normalize_fs_path(input);
    if normalized.len() <= 3 {
        return normalized;
    }
    normalized.trim_end_matches('/').to_string()
}

fn join_fs_path(base_dir: &str, relative: &str) -> String {
    let base = normalize_root_path(base_dir);
    let rel = normalize_fs_path(relative)
        .trim_start_matches('/')
        .to_string();
    match (base.is_empty(), rel.is_empty()) {
        (true, true) => String::new(),
        (true, false) => rel,
        (false, true) => base,
        (false, false) => format!("{base}/{rel}"),
    }
}

fn basename_str(input: &str) -> String {
    let normalized = normalize_fs_path(input);
    normalized
        .split('/')
        .filter(|s| !s.is_empty())
        .next_back()
        .unwrap_or_default()
        .to_string()
}

fn trim_target_path(input: &str) -> String {
    let mut out = normalize_fs_path(input);
    loop {
        if out.starts_with("./") {
            out = out[2..].to_string();
            continue;
        }
        if out.starts_with('/') {
            out = out[1..].to_string();
            continue;
        }
        if out.starts_with("a/") || out.starts_with("b/") {
            out = out[2..].to_string();
            continue;
        }
        break;
    }
    out
}

fn canonicalize_best_effort(path: &str) -> String {
    dunce::canonicalize(path)
        .map(|p| normalize_fs_path(&p.to_string_lossy()))
        .unwrap_or_else(|_| normalize_fs_path(path))
}

fn is_within_root(path: &str, root: &str) -> bool {
    let normalized_path = normalize_root_path(path).to_ascii_lowercase();
    let normalized_root = normalize_root_path(root).to_ascii_lowercase();
    if normalized_root.is_empty() {
        return false;
    }
    normalized_path == normalized_root || normalized_path.starts_with(&(normalized_root + "/"))
}

fn is_within_any_root(path: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| is_within_root(path, root))
}

fn canonicalized_roots(roots: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let normalized = canonicalize_best_effort(root);
        let key = normalized.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(normalized);
        }
    }
    out
}

fn workstudio_roots(ws: &Workstudio) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in std::iter::once(ws.main_folder.as_str()).chain(ws.folders.iter().map(String::as_str))
    {
        let normalized = normalize_root_path(raw);
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(normalized);
        }
    }
    out
}

fn relative_path_from_root(candidate: &str, root: &str) -> Option<String> {
    let candidate_norm = normalize_fs_path(candidate);
    let root_norm = normalize_root_path(root);
    if candidate_norm.eq_ignore_ascii_case(&root_norm) {
        return Some(String::new());
    }
    let candidate_lower = candidate_norm.to_ascii_lowercase();
    let root_lower = root_norm.to_ascii_lowercase();
    let prefix = format!("{root_lower}/");
    if candidate_lower.starts_with(&prefix) {
        return Some(candidate_norm[root_norm.len() + 1..].to_string());
    }
    None
}

fn build_relative_variants(target_path: &str, roots: &[String]) -> Vec<String> {
    let normalized = trim_target_path(target_path);
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push_variant = |value: String| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(trimmed);
        }
    };

    push_variant(normalized.clone());
    for root in roots {
        let base = basename_str(root);
        if base.is_empty() {
            continue;
        }
        let prefix = format!("{}/", base.to_ascii_lowercase());
        let lower = normalized.to_ascii_lowercase();
        if lower.starts_with(&prefix) && normalized.len() > prefix.len() {
            push_variant(normalized[prefix.len()..].to_string());
        }
    }

    out
}

fn resolve_existing_candidate(candidate: &str, root_checks: &[String]) -> Option<String> {
    let meta = std::fs::metadata(candidate).ok()?;
    if !meta.is_file() {
        return None;
    }
    let canonical = canonicalize_best_effort(candidate);
    if root_checks.is_empty() || is_within_any_root(&canonical, root_checks) {
        return Some(canonical);
    }
    None
}

fn resolve_abs_existing_file(candidate: &str) -> Option<String> {
    let meta = std::fs::metadata(candidate).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(canonicalize_best_effort(candidate))
}

fn display_path_from_main_root(resolved_path: &str, main_root: &str) -> String {
    let resolved = normalize_fs_path(resolved_path);
    let main = normalize_root_path(main_root);
    if main.is_empty() {
        return resolved;
    }
    if resolved.eq_ignore_ascii_case(&main) {
        return basename_str(&resolved);
    }
    let resolved_lower = resolved.to_ascii_lowercase();
    let main_lower = main.to_ascii_lowercase();
    let prefix = format!("{main_lower}/");
    if resolved_lower.starts_with(&prefix) {
        return resolved[main.len() + 1..].to_string();
    }
    resolved
}

fn pick_best_search_candidate(
    candidates: &[String],
    relative_variants: &[String],
    roots: &[String],
) -> Option<(String, &'static str)> {
    let variant_bases: Vec<String> = relative_variants.iter().map(|v| basename_str(v)).collect();

    candidates
        .iter()
        .filter_map(|candidate| {
            let candidate_norm = normalize_fs_path(candidate);
            let candidate_lower = candidate_norm.to_ascii_lowercase();
            let rels: Vec<String> = roots
                .iter()
                .filter_map(|root| relative_path_from_root(&candidate_norm, root))
                .collect();
            let rels_lower: Vec<String> = rels.iter().map(|v| v.to_ascii_lowercase()).collect();
            let candidate_base = basename_str(&candidate_norm).to_ascii_lowercase();

            let mut score = 0i32;
            let mut strategy = "basename_search";

            for (idx, variant) in relative_variants.iter().enumerate() {
                let variant_lower = variant.to_ascii_lowercase();
                if rels_lower.iter().any(|rel| rel == &variant_lower) {
                    score = score.max(120);
                    strategy = "suffix_search";
                    continue;
                }
                let tail = format!("/{variant_lower}");
                if rels_lower.iter().any(|rel| rel.ends_with(&tail))
                    || candidate_lower.ends_with(&tail)
                {
                    score = score.max(100);
                    strategy = "suffix_search";
                    continue;
                }
                if rels_lower.iter().any(|rel| rel.contains(&variant_lower)) {
                    score = score.max(80);
                    strategy = "suffix_search";
                    continue;
                }
                if variant_bases.get(idx).is_some_and(|base| {
                    !base.is_empty() && candidate_base == base.to_ascii_lowercase()
                }) {
                    score = score.max(60);
                }
            }

            if score <= 0 {
                return None;
            }

            let shortest_rel = rels.iter().map(|v| v.len()).min().unwrap_or(usize::MAX);
            Some((
                candidate_norm,
                strategy,
                score,
                shortest_rel,
                candidate_lower.len(),
            ))
        })
        .max_by(|a, b| {
            a.2.cmp(&b.2)
                .then_with(|| b.3.cmp(&a.3))
                .then_with(|| b.4.cmp(&a.4))
        })
        .map(|(path, strategy, _, _, _)| (path, strategy))
}

async fn get_workstudio_by_id(
    db: &tauri::State<'_, Arc<Mutex<Database>>>,
    workstudio_id: &str,
    op_name: &str,
) -> Result<Workstudio, String> {
    async_db::with_db(db.inner(), op_name, |db| db.get_workstudio(workstudio_id))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Workstudio not found".to_string())
}

async fn find_matching_files_in_roots(
    roots: &[String],
    query: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let match_by_extension = is_extension_query(&query);
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut readable_roots = 0usize;
    let mut unreadable_root_errors: Vec<String> = Vec::new();

    for root in roots {
        if out.len() >= limit {
            break;
        }
        match fs::read_dir(root).await {
            Ok(_) => {
                readable_roots += 1;
            }
            Err(e) => {
                unreadable_root_errors.push(format!("{root}: {e}"));
                continue;
            }
        }

        for entry in walkdir::WalkDir::new(root)
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
                    if let Some(path) = err.path() {
                        eprintln!(
                            "[workstudio_find_files] walk error: {}: {}",
                            path.display(),
                            err
                        );
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
            } else if !file_name_lower.contains(&query) {
                let pstr = path.to_string_lossy();
                let p_lower = pstr.to_ascii_lowercase();
                if !p_lower.contains(&query) {
                    continue;
                }
            }

            let p = path.to_string_lossy().into_owned();
            let key = normalize_fs_path(&p).to_ascii_lowercase();
            if seen.insert(key) {
                out.push(p);
            }
        }
    }

    if out.is_empty() && readable_roots == 0 && !unreadable_root_errors.is_empty() {
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
    should_skip_walk_dir_name(name.as_str())
}

fn should_skip_walk_dir_name(name: &str) -> bool {
    matches!(
        name,
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
            | ".tmp"
            | "tmp"
    )
}

#[tauri::command]
pub async fn ensure_workstudio_for_conversation(
    conversation_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    async_db::ensure_workstudio_for_conversation(db.inner(), &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workstudio(
    workstudio_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<Workstudio>, String> {
    async_db::with_db(db.inner(), "get_workstudio", |db| {
        db.get_workstudio(&workstudio_id)
    })
    .await
    .map_err(|e| e.to_string())
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
        async_db::with_db(
            db.inner(),
            "workstudio_main_folder_has_real_content:get_workstudio",
            |db| db.get_workstudio(&workstudio_id),
        )
        .await
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
    let set_as_main = set_as_main.unwrap_or(false);
    async_db::with_db(db.inner(), "add_workstudio_folder", |db| {
        db.add_workstudio_folder(&workstudio_id, &folder, set_as_main)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_workstudio(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    async_db::with_db(db.inner(), "create_workstudio", |db| db.create_workstudio())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_workstudio_main_folder(
    workstudio_id: String,
    folder: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    async_db::with_db(db.inner(), "set_workstudio_main_folder", |db| {
        db.set_workstudio_main_folder(&workstudio_id, &folder)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_workstudio_folder(
    workstudio_id: String,
    folder: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Workstudio, String> {
    async_db::with_db(db.inner(), "remove_workstudio_folder", |db| {
        db.remove_workstudio_folder(&workstudio_id, &folder)
    })
    .await
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWorkstudioFileTargetArgs {
    pub workstudio_id: String,
    pub target_path: String,
    #[serde(default)]
    pub active_file_path: Option<String>,
    #[serde(default)]
    pub current_dir: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWorkstudioFileTargetResult {
    pub resolved_path: String,
    pub strategy: String,
    pub used_search: bool,
    pub display_path: String,
}

#[tauri::command]
pub async fn resolve_workstudio_file_target(
    args: ResolveWorkstudioFileTargetArgs,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<ResolveWorkstudioFileTargetResult, String> {
    let workstudio_id = args.workstudio_id.trim();
    if workstudio_id.is_empty() {
        return Err("workstudioId 为空".to_string());
    }

    let target_path = args.target_path.trim();
    if target_path.is_empty() {
        return Err("targetPath 为空".to_string());
    }

    let ws = get_workstudio_by_id(
        &db,
        workstudio_id,
        "resolve_workstudio_file_target:get_workstudio",
    )
    .await?;
    let roots = workstudio_roots(&ws);
    let root_checks = canonicalized_roots(&roots);
    let limit = args.limit.unwrap_or(50).max(1).min(200) as usize;
    let normalized_target = normalize_fs_path(target_path);

    if is_absolute_fs_path(&normalized_target) {
        let resolved = resolve_abs_existing_file(&normalized_target)
            .ok_or_else(|| format!("文件不存在或不可读：{target_path}"))?;
        return Ok(ResolveWorkstudioFileTargetResult {
            display_path: display_path_from_main_root(&resolved, &ws.main_folder),
            resolved_path: resolved,
            strategy: "absolute".to_string(),
            used_search: false,
        });
    }

    let relative_variants = build_relative_variants(&normalized_target, &roots);
    if relative_variants.is_empty() {
        return Err("无法解析相对路径".to_string());
    }

    let mut exact_candidates: Vec<(String, &'static str)> = Vec::new();
    let mut seen = HashSet::new();
    let mut push_candidate = |raw: String, strategy: &'static str| {
        let key = normalize_fs_path(&raw).to_ascii_lowercase();
        if seen.insert(key) {
            exact_candidates.push((raw, strategy));
        }
    };

    if let Some(active_file_path) = args.active_file_path.as_deref() {
        let active = normalize_fs_path(active_file_path);
        if is_absolute_fs_path(&active) {
            let active_parent = Path::new(&active)
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(&active));
            let active_parent = normalize_fs_path(&active_parent.to_string_lossy());
            for rel in &relative_variants {
                push_candidate(join_fs_path(&active_parent, rel), "active_file_dir");
            }
        }
    }

    if let Some(current_dir) = args.current_dir.as_deref() {
        let current_dir = normalize_fs_path(current_dir);
        if is_absolute_fs_path(&current_dir) {
            for rel in &relative_variants {
                push_candidate(join_fs_path(&current_dir, rel), "current_dir");
            }
        }
    }

    for (idx, root) in roots.iter().enumerate() {
        let strategy = if idx == 0 {
            "workspace_main_folder"
        } else {
            "workspace_folder"
        };
        for rel in &relative_variants {
            push_candidate(join_fs_path(root, rel), strategy);
        }
    }

    for (candidate, strategy) in exact_candidates {
        if let Some(resolved) = resolve_existing_candidate(&candidate, &root_checks) {
            return Ok(ResolveWorkstudioFileTargetResult {
                display_path: display_path_from_main_root(&resolved, &ws.main_folder),
                resolved_path: resolved,
                strategy: strategy.to_string(),
                used_search: false,
            });
        }
    }

    let basename = basename_str(&normalized_target);
    if basename.is_empty() {
        return Err(format!("无法解析文件名：{target_path}"));
    }

    let candidates = find_matching_files_in_roots(&roots, &basename, limit).await?;
    let (resolved, strategy) = pick_best_search_candidate(&candidates, &relative_variants, &roots)
        .ok_or_else(|| format!("未在工作区内找到匹配文件：{target_path}"))?;

    Ok(ResolveWorkstudioFileTargetResult {
        display_path: display_path_from_main_root(&resolved, &ws.main_folder),
        resolved_path: resolved,
        strategy: strategy.to_string(),
        used_search: true,
    })
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
    let ws = get_workstudio_by_id(
        &db,
        &args.workstudio_id,
        "workstudio_find_files:get_workstudio",
    )
    .await?;
    let roots = workstudio_roots(&ws);
    find_matching_files_in_roots(&roots, &query, limit).await
}

#[cfg(test)]
mod tests {
    use super::{build_relative_variants, pick_best_search_candidate};

    #[test]
    fn relative_variants_keep_workspace_prefix_and_strip_root_basename() {
        let roots = vec!["E:/work/TauriAI".to_string()];
        let variants = build_relative_variants(
            "TauriAI/tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts",
            &roots,
        );
        assert_eq!(
            variants,
            vec![
                "TauriAI/tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts".to_string(),
                "tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts".to_string()
            ]
        );
    }

    #[test]
    fn search_candidate_prefers_tail_match_over_basename_only() {
        let roots = vec!["E:/work/TauriAI".to_string()];
        let variants = vec!["tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts".to_string()];
        let candidates = vec![
            "E:/work/TauriAI/docs/useKeyboardShortcuts.ts".to_string(),
            "E:/work/TauriAI/tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts".to_string(),
        ];
        let best = pick_best_search_candidate(&candidates, &variants, &roots).unwrap();
        assert_eq!(
            best.0,
            "E:/work/TauriAI/tauri-ai/apps/desktop/src/hooks/useKeyboardShortcuts.ts"
        );
        assert_eq!(best.1, "suffix_search");
    }
}

#[cfg(test)]
mod walk_dir_tests {
    use super::should_skip_walk_dir_name;

    #[test]
    fn skips_tmp_directories_for_mentions_search() {
        assert!(should_skip_walk_dir_name("tmp"));
        assert!(should_skip_walk_dir_name(".tmp"));
    }

    #[test]
    fn keeps_normal_source_directories_searchable() {
        assert!(!should_skip_walk_dir_name("src"));
        assert!(!should_skip_walk_dir_name("components"));
    }
}
