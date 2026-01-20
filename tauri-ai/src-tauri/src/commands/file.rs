//! File-related commands
//!
//! Used by the frontend to convert OS-level drag & drop paths into data it can
//! process with the existing attachment pipeline (images/text/PDF).

use serde::Serialize;
use std::path::Path;
use base64::Engine as _;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024; // 20MB
const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024; // 20MB
const MAX_TEXT_BYTES: u64 = 1 * 1024 * 1024; // 1MB

// Keep in sync with `tauri-ai/src/types/index.ts` and `InputArea.tsx`
const SUPPORTED_TEXT_EXTENSIONS: &[&str] = &[
    ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".csv", ".log", ".ini", ".toml", ".html",
    ".css", ".js", ".ts", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".sh", ".bat", ".sql",
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
    if SUPPORTED_TEXT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Some("text/plain");
    }
    None
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
        return Err(format!("文件过大（{size} bytes），请拖拽小于 {max_mb}MB 的文件"));
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
