//! File-related commands
//!
//! Used by the frontend to convert OS-level drag & drop paths into data it can
//! process with the existing attachment pipeline (images/text/PDF).

use base64::Engine as _;
use serde::Serialize;
use std::path::Path;
use tokio::fs;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024; // 20MB
const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024; // 20MB
const MAX_TEXT_BYTES: u64 = 1 * 1024 * 1024; // 1MB

// Keep in sync with `tauri-ai/src/types/index.ts` and `InputArea.tsx`
const SUPPORTED_TEXT_EXTENSIONS: &[&str] = &[
    ".tauri.richtxt",
    ".txt",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".csv",
    ".log",
    ".ini",
    ".toml",
    ".html",
    ".css",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".py",
    ".pyi",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cc",
    ".cxx",
    ".cpp",
    ".h",
    ".hh",
    ".hpp",
    ".hxx",
    ".inl",
    ".ipp",
    ".ixx",
    ".cppm",
    ".lua",
    ".sh",
    ".bat",
    ".sql",
    ".scss",
    ".sass",
    ".less",
    ".lock",
];

// Keep in sync with `IMAGE_MIME_BY_EXTENSION` in `InputArea.tsx`
fn infer_mime_from_filename(filename: &str) -> Option<&'static str> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".png") {
        return Some("image/png");
    }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        return Some("image/jpeg");
    }
    if lower.ends_with(".gif") {
        return Some("image/gif");
    }
    if lower.ends_with(".webp") {
        return Some("image/webp");
    }
    if lower.ends_with(".bmp") {
        return Some("image/bmp");
    }
    if lower.ends_with(".svg") {
        return Some("image/svg+xml");
    }
    if lower.ends_with(".heic") {
        return Some("image/heic");
    }
    if lower.ends_with(".heif") {
        return Some("image/heif");
    }
    if lower.ends_with(".pdf") {
        return Some("application/pdf");
    }
    if SUPPORTED_TEXT_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return Some("text/plain");
    }
    None
}

fn looks_like_utf8_text(bytes: &[u8]) -> bool {
    if bytes.iter().any(|b| *b == 0) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{
        infer_mime_from_filename, looks_like_utf8_text, read_local_file_base64,
        write_local_text_file,
    };
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("tauri_ai_file_cmd_tests_{unique}"))
    }

    #[test]
    fn infer_mime_for_dotfile_without_extension_returns_none() {
        assert_eq!(infer_mime_from_filename(".gitignore"), None);
    }

    #[test]
    fn utf8_text_detection_works_for_text_and_binary() {
        assert!(looks_like_utf8_text("hello\nworld".as_bytes()));
        assert!(!looks_like_utf8_text(&[0x00, 0x41, 0x42]));
        assert!(!looks_like_utf8_text(&[0xFF, 0xFE, 0xFD]));
    }

    #[tokio::test]
    async fn read_unknown_extension_text_file_as_text_plain() {
        let dir = unique_temp_dir();
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("should create temp directory");
        let file_path = dir.join(".gitignore");
        tokio::fs::write(&file_path, "target/\n")
            .await
            .expect("should write temp file");

        let result = read_local_file_base64(file_path.to_string_lossy().to_string()).await;
        tokio::fs::remove_dir_all(&dir).await.ok();

        let file = result.expect("should read unknown extension text file");
        assert_eq!(file.mime, "text/plain");
        assert_eq!(file.filename, ".gitignore");
    }

    #[tokio::test]
    async fn write_unknown_extension_text_file() {
        let dir = unique_temp_dir();
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("should create temp directory");
        let file_path = dir.join(".envrc");

        write_local_text_file(
            file_path.to_string_lossy().to_string(),
            "echo ok\n".to_string(),
        )
        .await
        .expect("should write unknown extension text file");

        let content = tokio::fs::read_to_string(&file_path)
            .await
            .expect("should read written file");
        tokio::fs::remove_dir_all(&dir).await.ok();

        assert_eq!(content, "echo ok\n");
    }
}

fn max_size_for_mime(mime: &str) -> u64 {
    if mime == "application/pdf" {
        return MAX_PDF_BYTES;
    }
    if mime.starts_with("image/") {
        return MAX_IMAGE_BYTES;
    }
    if mime.starts_with("text/") {
        return MAX_TEXT_BYTES;
    }
    // Fallback (should not happen due to allow-list)
    MAX_TEXT_BYTES
}

#[derive(Debug, Serialize)]
pub struct LocalFileBase64 {
    pub filename: String,
    pub mime: String,
    pub base64: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Read a local file and return base64-encoded bytes for the frontend.
///
/// Security notes:
/// - The command is intentionally restricted to a small allow-list of extensions (images/text/PDF).
/// - File size is capped to prevent accidental huge IPC payloads.
#[tauri::command]
pub async fn read_local_file_base64(path: String) -> Result<LocalFileBase64, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }

    let file_path = Path::new(&path);
    let filename = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    if infer_mime_from_filename(&filename).is_none() {
        let metadata = tokio::fs::metadata(file_path)
            .await
            .map_err(|e| format!("failed to read file metadata: {e}"))?;

        if !metadata.is_file() {
            return Err("only regular files are supported".to_string());
        }

        let size = metadata.len();
        if size > MAX_TEXT_BYTES {
            let max_mb = MAX_TEXT_BYTES / 1024 / 1024;
            return Err(format!(
                "file too large ({size} bytes), max allowed for text is {max_mb}MB"
            ));
        }

        let bytes = tokio::fs::read(file_path)
            .await
            .map_err(|e| format!("failed to read file: {e}"))?;

        if !looks_like_utf8_text(&bytes) {
            return Err("unsupported file type (only images/text/PDF are supported)".to_string());
        }

        let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(LocalFileBase64 {
            filename,
            mime: "text/plain".to_string(),
            base64,
            size,
        });
    }

    let mime = infer_mime_from_filename(&filename)
        .ok_or_else(|| "不支持的文件类型（仅支持图片/文本/PDF）".to_string())?
        .to_string();

    let metadata = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("无法读取文件信息: {e}"))?;

    if !metadata.is_file() {
        return Err("仅支持拖拽文件，不支持文件夹".to_string());
    }

    let size = metadata.len();
    let max_size = max_size_for_mime(&mime);
    if size > max_size {
        let max_mb = max_size / 1024 / 1024;
        return Err(format!(
            "文件过大（{size} bytes），请拖拽小于 {max_mb}MB 的文件"
        ));
    }

    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?;

    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(LocalFileBase64 {
        filename,
        mime,
        base64,
        size,
    })
}

/// List a local directory (one level).
///
/// Notes:
/// - 仅用于 Workstudio 文件浏览器，返回目录 + “已知可读的文本文件”。
/// - 不递归；递归由前端按需展开触发。
#[tauri::command]
pub async fn list_local_directory(path: String) -> Result<Vec<LocalDirEntry>, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }

    let dir_path = Path::new(&path);
    let metadata = fs::metadata(dir_path)
        .await
        .map_err(|e| format!("无法读取目录信息: {e}"))?;

    if !metadata.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let mut rd = fs::read_dir(dir_path)
        .await
        .map_err(|e| format!("读取目录失败: {e}"))?;

    let mut out: Vec<LocalDirEntry> = Vec::new();

    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| format!("遍历目录失败: {e}"))?
    {
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| format!("读取文件类型失败: {e}"))?;

        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = file_type.is_dir();

        out.push(LocalDirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }

    // Sort: dirs first, then name (case-insensitive).
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a
            .name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase()),
    });

    Ok(out)
}

/// Write a local text file.
///
/// Security notes:
/// - Restricts file extensions to the same allow-list as `read_local_file_base64` (text only).
/// - Caps payload size to avoid huge IPC transfers.
#[tauri::command]
pub async fn write_local_text_file(path: String, content: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }

    let file_path = Path::new(&path);
    let filename = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    if infer_mime_from_filename(&filename).is_none() {
        let size = content.as_bytes().len() as u64;
        if size > MAX_TEXT_BYTES {
            let max_mb = MAX_TEXT_BYTES / 1024 / 1024;
            return Err(format!(
                "content too large ({size} bytes), keep it under {max_mb}MB"
            ));
        }

        if let Ok(meta) = fs::metadata(file_path).await {
            if meta.is_dir() {
                return Err("target is a directory and cannot be written as a file".to_string());
            }
        }

        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create parent directory: {e}"))?;
        }

        fs::write(file_path, content)
            .await
            .map_err(|e| format!("failed to write file: {e}"))?;

        return Ok(());
    }

    let mime = infer_mime_from_filename(&filename)
        .ok_or_else(|| "不支持的文件类型（仅支持文本文件）".to_string())?;
    if mime != "text/plain" {
        return Err("仅支持写入文本文件".to_string());
    }

    let size = content.as_bytes().len() as u64;
    if size > MAX_TEXT_BYTES {
        let max_mb = MAX_TEXT_BYTES / 1024 / 1024;
        return Err(format!("内容过大（{size} bytes），请保持小于 {max_mb}MB"));
    }

    if let Ok(meta) = fs::metadata(file_path).await {
        if meta.is_dir() {
            return Err("目标是文件夹，无法写入".to_string());
        }
    }

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建父目录失败: {e}"))?;
    }

    fs::write(file_path, content)
        .await
        .map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLocalPathArgs {
    pub path: String,
    /// Safety guard: only allow deleting paths under these roots.
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    /// When deleting directories, require explicit recursive=true.
    #[serde(default)]
    pub recursive: Option<bool>,
}

/// Delete a local path (file or directory).
///
/// Security notes:
/// - Requires an allow-list of workspace roots (`allowedRoots`) to prevent arbitrary file deletion.
/// - Resolves symlinks via canonicalize for non-symlink targets to avoid path traversal through symlink components.
#[tauri::command]
pub async fn delete_local_path(args: DeleteLocalPathArgs) -> Result<(), String> {
    let path_raw = args.path.trim();
    if path_raw.is_empty() {
        return Err("路径为空".to_string());
    }

    let target = std::path::PathBuf::from(path_raw);
    if !target.is_absolute() {
        return Err("仅支持绝对路径".to_string());
    }

    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for r in args.allowed_roots {
        let raw = r.trim();
        if raw.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(raw);
        if p.is_absolute() {
            roots.push(p);
        }
    }
    if roots.is_empty() {
        return Err("allowedRoots 为空：拒绝删除".to_string());
    }

    let roots_canon = {
        let mut out: Vec<std::path::PathBuf> = Vec::new();
        for r in roots {
            if let Ok(p) = fs::canonicalize(&r).await {
                out.push(p);
            }
        }
        out
    };
    if roots_canon.is_empty() {
        return Err("allowedRoots 无有效路径：拒绝删除".to_string());
    }

    // Use symlink_metadata to detect symlinks without following them.
    let meta = fs::symlink_metadata(&target)
        .await
        .map_err(|e| format!("无法读取文件信息: {e}"))?;

    let is_symlink = meta.file_type().is_symlink();

    let allowed = if is_symlink {
        // Deleting the symlink itself: guard by its parent directory, and do not follow the link.
        let parent = target
            .parent()
            .ok_or_else(|| "非法路径：缺少父目录".to_string())?;
        let parent_canon = fs::canonicalize(parent)
            .await
            .map_err(|e| format!("无法解析父目录: {e}"))?;
        roots_canon
            .iter()
            .any(|root| parent_canon == *root || parent_canon.starts_with(root))
    } else {
        // Non-symlink target: canonicalize full path to avoid traversal through symlink components.
        let canon = fs::canonicalize(&target)
            .await
            .map_err(|e| format!("无法解析路径: {e}"))?;
        roots_canon
            .iter()
            .any(|root| canon == *root || canon.starts_with(root))
    };

    if !allowed {
        return Err("拒绝删除：目标不在允许的工作区目录下".to_string());
    }

    if meta.is_dir() {
        if !args.recursive.unwrap_or(false) {
            return Err("目标是文件夹；如需删除请开启 recursive".to_string());
        }
        fs::remove_dir_all(&target)
            .await
            .map_err(|e| format!("删除文件夹失败: {e}"))?;
        return Ok(());
    }

    fs::remove_file(&target)
        .await
        .map_err(|e| format!("删除文件失败: {e}"))?;
    Ok(())
}
