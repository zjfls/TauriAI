use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};
use walkdir::WalkDir;

const MARKER_FILENAME: &str = ".tauri-system-skills.marker";

fn fingerprint_dir(root: &Path) -> io::Result<String> {
    let mut items: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();
    items.sort();

    let mut hasher = Sha1::new();
    for p in items {
        let rel = p.strip_prefix(root).unwrap_or(&p);
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update(&[0]);
        let bytes = fs::read(&p)?;
        hasher.update(bytes);
        hasher.update(&[0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_marker(dest_root: &Path) -> Option<String> {
    let p = dest_root.join(MARKER_FILENAME);
    fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn write_marker(dest_root: &Path, fp: &str) -> io::Result<()> {
    fs::write(dest_root.join(MARKER_FILENAME), format!("{fp}\n"))
}

fn copy_tree_no_overwrite(src_root: &Path, dest_root: &Path) -> io::Result<()> {
    for entry in WalkDir::new(src_root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = path.strip_prefix(src_root).unwrap_or(path);
        let dest = dest_root.join(rel);

        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest)?;
            continue;
        }
        if entry.file_type().is_file() {
            if dest.exists() {
                continue;
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(path, dest)?;
        }
    }
    Ok(())
}

/// 将 bundled `skills/` 目录（resources）同步到应用目录 `~/.tauri-ai/skills`。
///
/// 语义：
/// - 仅“补齐缺失文件”，不覆盖用户已有的 skills
/// - 用 marker 指纹避免每次启动重复遍历
pub fn install_bundled_skills(src_skills_dir: &Path, dest_skills_dir: &Path) -> io::Result<()> {
    if !src_skills_dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dest_skills_dir)?;

    let fp = fingerprint_dir(src_skills_dir)?;
    if read_marker(dest_skills_dir).is_some_and(|m| m == fp) {
        return Ok(());
    }

    copy_tree_no_overwrite(src_skills_dir, dest_skills_dir)?;
    write_marker(dest_skills_dir, &fp)?;
    Ok(())
}

