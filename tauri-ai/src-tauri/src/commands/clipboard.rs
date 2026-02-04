//! Clipboard-related commands.
//!
//! 目标：让前端可以把“真实图片”写入系统剪贴板，粘贴行为与系统截图一致。

use base64::Engine as _;
use std::borrow::Cow;

const MAX_PNG_BYTES: usize = 30 * 1024 * 1024; // 30MB

fn strip_data_url_prefix(input: &str) -> &str {
    // Accept both raw base64 and data URL like: data:image/png;base64,....
    if let Some(rest) = input.strip_prefix("data:") {
        if let Some((_meta, data)) = rest.split_once(',') {
            return data;
        }
    }
    input
}

/// Write a PNG image (base64-encoded bytes) into the system clipboard.
///
/// Why: WebView clipboard APIs are inconsistent (especially on macOS WKWebView).
/// This uses OS-native clipboard so paste behaves like a screenshot in other apps and in our input box.
#[tauri::command]
pub async fn clipboard_write_png_base64(png_base64: String) -> Result<(), String> {
    let trimmed = png_base64.trim();
    if trimmed.is_empty() {
        return Err("图片数据为空".to_string());
    }

    let base64_data = strip_data_url_prefix(trimmed).trim();

    // Decode base64 -> PNG bytes.
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("解码 base64 失败: {e}"))?;

    if png_bytes.is_empty() {
        return Err("PNG 数据为空".to_string());
    }
    if png_bytes.len() > MAX_PNG_BYTES {
        return Err(format!(
            "PNG 过大（{} bytes），请复制小于 {}MB 的图片",
            png_bytes.len(),
            MAX_PNG_BYTES / 1024 / 1024
        ));
    }

    // Decode PNG -> RGBA (required by arboard).
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let img = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
            .map_err(|e| format!("解析 PNG 失败: {e}"))?;
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();

        if w == 0 || h == 0 {
            return Err("PNG 尺寸无效".to_string());
        }

        let bytes = rgba.into_raw();
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("初始化剪贴板失败: {e}"))?;
        clipboard
            .set_image(arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: Cow::Owned(bytes),
            })
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("写入剪贴板任务失败: {e}"))??;

    Ok(())
}

