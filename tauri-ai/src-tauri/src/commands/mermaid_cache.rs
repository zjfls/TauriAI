//! Mermaid SVG disk cache commands.
//!
//! 背景：
//! - Mermaid 渲染是纯前端计算，重复率高时会浪费 CPU/导致卡顿。
//! - 这里提供“落盘缓存”：前端以 cacheKey 读/写 SVG 字符串，后端落在 appCacheDir 下。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use filetime::{set_file_mtime, FileTime};
use sha1::{Digest, Sha1};
use tauri::Manager;
use tokio::fs;

const MERMAID_CACHE_DIRNAME: &str = "mermaid-svg-cache";
const CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60); // 30 天
const CACHE_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024; // 5 GiB

fn mermaid_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法获取 appCacheDir: {e}"))?;
    Ok(root.join(MERMAID_CACHE_DIRNAME))
}

fn cache_file_path(dir: &Path, key: &str) -> PathBuf {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    dir.join(format!("{hex}.svg"))
}

fn touch_mtime_best_effort(path: &Path) {
    let now = FileTime::from_system_time(SystemTime::now());
    let _ = set_file_mtime(path, now);
}

#[derive(Debug)]
struct CacheEntry {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

async fn cleanup_cache_dir(dir: &Path) -> Result<(), String> {
    let now = SystemTime::now();

    let mut rd = match fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取 Mermaid 缓存目录失败: {e}")),
    };

    let mut entries: Vec<CacheEntry> = Vec::new();

    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| format!("遍历 Mermaid 缓存目录失败: {e}"))?
    {
        let path = entry.path();

        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".svg") {
            // Best-effort 清理遗留的临时文件（避免长期堆积）
            if name.contains(".tmp") {
                let _ = fs::remove_file(&path).await;
            }
            continue;
        }

        let meta = entry
            .metadata()
            .await
            .map_err(|e| format!("读取 Mermaid 缓存文件信息失败: {e}"))?;
        if !meta.is_file() {
            continue;
        }

        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age > CACHE_TTL {
            let _ = fs::remove_file(&path).await;
            continue;
        }

        entries.push(CacheEntry {
            path,
            modified,
            size: meta.len(),
        });
    }

    let mut total: u64 = entries.iter().map(|e| e.size).sum();
    if total <= CACHE_MAX_BYTES {
        return Ok(());
    }

    // 超限：按“最久未修改”优先删除（mtime 同时承担 LRU/TTL 的近似语义）
    entries.sort_by_key(|e| e.modified);
    for e in entries {
        if total <= CACHE_MAX_BYTES {
            break;
        }
        let _ = fs::remove_file(&e.path).await;
        total = total.saturating_sub(e.size);
    }

    Ok(())
}

/// Get cached Mermaid SVG by key.
///
/// - 命中则返回 SVG 字符串（不做任何 sanitize；前端仍会二次清洗）
/// - 过期/不存在则返回 None（并 best-effort 删除过期文件）
#[tauri::command]
pub async fn get_mermaid_svg_cache(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }

    let dir = mermaid_cache_dir(&app)?;
    let path = cache_file_path(&dir, key);

    let meta = match fs::metadata(&path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 Mermaid 缓存文件信息失败: {e}")),
    };

    if !meta.is_file() {
        return Ok(None);
    }

    let modified = meta.modified().unwrap_or(UNIX_EPOCH);
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or(Duration::ZERO);
    if age > CACHE_TTL {
        let _ = fs::remove_file(&path).await;
        return Ok(None);
    }

    let svg = fs::read_to_string(&path)
        .await
        .map_err(|e| format!("读取 Mermaid 缓存失败: {e}"))?;

    // Sliding TTL: 命中读取时刷新 mtime（best-effort）
    touch_mtime_best_effort(&path);

    Ok(Some(svg))
}

/// Persist Mermaid SVG into disk cache.
///
/// Notes:
/// - 这是“缓存”，写入失败不应影响主流程；前端会 best-effort 调用。
#[tauri::command]
pub async fn set_mermaid_svg_cache(
    app: tauri::AppHandle,
    key: String,
    svg: String,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(());
    }
    if svg.trim().is_empty() {
        return Ok(());
    }

    let dir = mermaid_cache_dir(&app)?;
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建 Mermaid 缓存目录失败: {e}"))?;

    let path = cache_file_path(&dir, key);

    // 原子写：先写临时文件，再 rename 覆盖（Windows 需要先 remove）
    let uniq = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    let tmp = dir.join(format!(
        "{}.tmp.{uniq}.svg",
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));

    fs::write(&tmp, svg.as_bytes())
        .await
        .map_err(|e| format!("写入 Mermaid 缓存临时文件失败: {e}"))?;

    let _ = fs::remove_file(&path).await;
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("写入 Mermaid 缓存失败: {e}"))?;

    touch_mtime_best_effort(&path);

    // Best-effort 清理：TTL + 5GB 上限
    cleanup_cache_dir(&dir).await?;

    Ok(())
}

