//! Clipboard-related commands.
//!
//! 目标：让前端可以把“真实图片”写入系统剪贴板，粘贴行为与系统截图一致。

use base64::Engine as _;
#[cfg(not(target_os = "macos"))]
use std::borrow::Cow;

const MAX_PNG_BYTES: usize = 30 * 1024 * 1024; // 30MB
const MAX_INLINE_DATA_URL_PNG_BYTES: usize = 2 * 1024 * 1024; // 2MB: avoid massive HTML/text payloads

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
pub async fn clipboard_write_png_base64(app: tauri::AppHandle, png_base64: String) -> Result<(), String> {
    let trimmed = png_base64.trim();
    if trimmed.is_empty() {
        return Err("图片数据为空".to_string());
    }

    let base64_data = strip_data_url_prefix(trimmed).trim();
    // Keep an owned copy for optional HTML/text representations (avoid capturing a borrowed ref).
    let base64_data_owned = base64_data.to_string();

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

    // Extra compatibility on macOS: write multiple pasteboard representations (PNG/TIFF/HTML/text/file-url).
    //
    // Motivation:
    // - 纯文本输入框通常只接受 NSPasteboardTypeString；如果只有 image/*，用户会误以为“没复制成功”。
    // - 部分富文本输入框会优先读取 HTML；提供 <img src="data:..."> 可以提升“可粘贴为图片”的概率。
    // - 提供 file:// URL 作为兜底，有些应用会把它当作可粘贴附件来源。
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::autoreleasepool;
        use objc2::AnyThread;
        use objc2::MainThreadMarker;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeHTML, NSPasteboardTypePNG,
            NSPasteboardTypeString, NSPasteboardTypeTIFF, NSPasteboardTypeURL, NSImage,
        };
        use objc2_foundation::{NSMutableArray, NSData, NSString, NSURL};
        use uuid::Uuid;

        // Write a temp png file to provide a file-url representation.
        let tmp_path = std::env::temp_dir()
            .join(format!("tauri-ai-clipboard-{}.png", Uuid::new_v4()));
        std::fs::write(&tmp_path, &png_bytes)
            .map_err(|e| format!("写入临时图片失败: {e}"))?;
        let tmp_path_str = tmp_path
            .to_str()
            .ok_or_else(|| "临时图片路径包含非法字符，无法写入剪贴板".to_string())?
            .to_string();

        // Inline HTML (data URL) only for reasonably small PNGs.
        let html = if png_bytes.len() <= MAX_INLINE_DATA_URL_PNG_BYTES {
            format!(
                "<img src=\"data:image/png;base64,{}\" alt=\"image\" />",
                base64_data_owned
            )
        } else {
            // Keep HTML small; let apps fall back to PNG/TIFF/file-url.
            "<span>[image]</span>".to_string()
        };

        let plain = if png_bytes.len() <= MAX_INLINE_DATA_URL_PNG_BYTES {
            "（已复制图片：可粘贴到支持图片的应用；纯文本输入框可能只显示此提示）".to_string()
        } else {
            "（已复制图片；图片较大，已提供 file:// 兜底）".to_string()
        };

        let png_bytes_for_main = png_bytes.clone();
        let tmp_path_str_for_main = tmp_path_str.clone();
        let html_for_main = html.clone();
        let plain_for_main = plain.clone();

        app.run_on_main_thread(move || {
            autoreleasepool(|_pool| {
                // 与 Tauri 内部实现对齐：不做主线程检查（避免某些情况下误判）。
                let _mtm = unsafe { MainThreadMarker::new_unchecked() };
                let pb = NSPasteboard::generalPasteboard();

                let ty_png = unsafe { NSPasteboardTypePNG };
                let ty_tiff = unsafe { NSPasteboardTypeTIFF };
                let ty_html = unsafe { NSPasteboardTypeHTML };
                let ty_string = unsafe { NSPasteboardTypeString };
                let ty_file_url = unsafe { NSPasteboardTypeFileURL };
                let ty_url = unsafe { NSPasteboardTypeURL };

                // Clear and declare types to ensure multiple representations are available.
                pb.clearContents();
                let types = NSMutableArray::array();
                types.addObject(ty_png);
                types.addObject(ty_tiff);
                types.addObject(ty_html);
                types.addObject(ty_string);
                types.addObject(ty_file_url);
                types.addObject(ty_url);
                unsafe {
                    pb.declareTypes_owner(types.as_ref(), None);
                }

                let png_data = NSData::with_bytes(&png_bytes_for_main);
                let _ = pb.setData_forType(Some(&png_data), ty_png);

                // Also provide TIFF; some apps prioritize it.
                if let Some(img) = NSImage::initWithData(NSImage::alloc(), &png_data) {
                    if let Some(tiff) = img.TIFFRepresentation() {
                        let _ = pb.setData_forType(Some(&tiff), ty_tiff);
                    }
                }

                let html_ns = NSString::from_str(&html_for_main);
                let _ = pb.setString_forType(&html_ns, ty_html);

                let plain_ns = NSString::from_str(&plain_for_main);
                let _ = pb.setString_forType(&plain_ns, ty_string);

                // file:// URL representation (best-effort)
                let path_ns = NSString::from_str(&tmp_path_str_for_main);
                let url = NSURL::fileURLWithPath(&path_ns);
                if let Some(url_str) = url.absoluteString() {
                    let _ = pb.setString_forType(&url_str, ty_file_url);
                    let _ = pb.setString_forType(&url_str, ty_url);
                }
            });
        })
        .map_err(|e| format!("写入剪贴板失败: {e}"))?;

        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
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
            let mut clipboard =
                arboard::Clipboard::new().map_err(|e| format!("初始化剪贴板失败: {e}"))?;
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
}
