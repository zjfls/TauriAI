//! Clipboard-related commands.
//!
//! 目标：让前端可以把“真实图片”写入系统剪贴板，粘贴行为与系统截图一致。

use base64::Engine as _;
#[cfg(target_os = "android")]
use jni::objects::{JObject, JValue};
#[cfg(all(
    not(target_os = "macos"),
    not(any(target_os = "android", target_os = "ios"))
))]
use std::borrow::Cow;
#[cfg(target_os = "android")]
use std::sync::mpsc;
#[cfg(target_os = "windows")]
use std::sync::Arc;
#[cfg(target_os = "android")]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "android")]
use tauri::Manager;
#[cfg(not(target_os = "android"))]
use tokio::fs;

const MAX_PNG_BYTES: usize = 30 * 1024 * 1024; // 30MB
#[cfg(all(
    target_os = "macos",
    not(any(target_os = "android", target_os = "ios"))
))]
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

fn decode_png_base64(png_base64: &str) -> Result<(String, Vec<u8>), String> {
    let trimmed = png_base64.trim();
    if trimmed.is_empty() {
        return Err("图片数据为空".to_string());
    }

    let base64_data = strip_data_url_prefix(trimmed).trim().to_string();
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
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

    Ok((base64_data, png_bytes))
}

fn sanitize_png_filename(suggested_name: Option<&str>) -> String {
    let raw = suggested_name.unwrap_or("practice-question").trim();
    let raw = raw
        .strip_suffix(".png")
        .or_else(|| raw.strip_suffix(".PNG"))
        .unwrap_or(raw);

    let mut sanitized = String::with_capacity(raw.len());
    let mut prev_sep = false;
    for ch in raw.chars() {
        if ch.is_alphanumeric() {
            sanitized.push(ch);
            prev_sep = false;
            continue;
        }
        if matches!(ch, '-' | '_' | ' ') && !prev_sep {
            sanitized.push('_');
            prev_sep = true;
        }
    }

    let stem = sanitized.trim_matches('_');
    let stem = if stem.is_empty() {
        "practice-question"
    } else {
        stem
    };
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{stem}-{ts}.png")
}

#[cfg(target_os = "android")]
fn put_content_value_string(
    env: &mut jni::JNIEnv,
    values: &JObject,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let key = env
        .new_string(key)
        .map_err(|e| format!("创建 Android ContentValues 键失败: {e}"))?;
    let key = JObject::from(key);
    let value = env
        .new_string(value)
        .map_err(|e| format!("创建 Android ContentValues 值失败: {e}"))?;
    let value = JObject::from(value);
    env.call_method(
        values,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&key), JValue::Object(&value)],
    )
    .map_err(|e| format!("写入 Android ContentValues 失败: {e}"))?;
    Ok(())
}

#[cfg(target_os = "android")]
fn save_png_bytes_to_android_gallery_inner(
    env: &mut jni::JNIEnv,
    activity: &JObject,
    png_bytes: &[u8],
    file_name: &str,
) -> Result<(), String> {
    let resolver = env
        .call_method(
            activity,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .map_err(|e| format!("获取 Android ContentResolver 失败: {e}"))?
        .l()
        .map_err(|e| format!("读取 Android ContentResolver 失败: {e}"))?;

    let values = env
        .new_object("android/content/ContentValues", "()V", &[])
        .map_err(|e| format!("创建 Android ContentValues 失败: {e}"))?;
    put_content_value_string(env, &values, "_display_name", file_name)?;
    put_content_value_string(env, &values, "mime_type", "image/png")?;
    put_content_value_string(env, &values, "relative_path", "Pictures/TauriAI")?;

    let collection = env
        .get_static_field(
            "android/provider/MediaStore$Images$Media",
            "EXTERNAL_CONTENT_URI",
            "Landroid/net/Uri;",
        )
        .map_err(|e| format!("获取 Android 相册 Uri 失败: {e}"))?
        .l()
        .map_err(|e| format!("读取 Android 相册 Uri 失败: {e}"))?;

    let inserted_uri = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[JValue::Object(&collection), JValue::Object(&values)],
        )
        .map_err(|e| format!("创建相册条目失败: {e}"))?
        .l()
        .map_err(|e| format!("读取相册条目失败: {e}"))?;
    if inserted_uri.is_null() {
        return Err("创建相册条目失败：系统未返回图片 Uri".to_string());
    }

    let stream = env
        .call_method(
            &resolver,
            "openOutputStream",
            "(Landroid/net/Uri;)Ljava/io/OutputStream;",
            &[JValue::Object(&inserted_uri)],
        )
        .map_err(|e| format!("打开相册输出流失败: {e}"))?
        .l()
        .map_err(|e| format!("读取相册输出流失败: {e}"))?;
    if stream.is_null() {
        return Err("打开相册输出流失败：系统返回了空对象".to_string());
    }

    let byte_array = env
        .byte_array_from_slice(png_bytes)
        .map_err(|e| format!("创建 Android PNG 字节数组失败: {e}"))?;
    let byte_array = JObject::from(byte_array);
    env.call_method(&stream, "write", "([B)V", &[JValue::Object(&byte_array)])
        .map_err(|e| format!("写入相册图片失败: {e}"))?;
    env.call_method(&stream, "flush", "()V", &[])
        .map_err(|e| format!("刷新相册图片失败: {e}"))?;
    env.call_method(&stream, "close", "()V", &[])
        .map_err(|e| format!("关闭相册输出流失败: {e}"))?;
    Ok(())
}

#[cfg(target_os = "android")]
fn save_png_bytes_to_android_gallery(
    app: &tauri::AppHandle,
    png_bytes: &[u8],
    suggested_name: Option<&str>,
) -> Result<String, String> {
    let file_name = sanitize_png_filename(suggested_name);
    let display_path = format!("Pictures/TauriAI/{file_name}");
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| "无法获取主窗口，不能保存题图到系统相册".to_string())?;

    let png_bytes = png_bytes.to_vec();
    let dispatch_file_name = file_name.clone();
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = save_png_bytes_to_android_gallery_inner(
                    env,
                    activity,
                    &png_bytes,
                    &dispatch_file_name,
                );
                let _ = tx.send(result);
            });
        })
        .map_err(|e| format!("调度 Android 相册写入失败: {e}"))?;

    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(display_path),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("写入系统相册超时，请稍后重试".to_string()),
    }
}

#[tauri::command]
pub async fn save_png_base64_to_local(
    app: tauri::AppHandle,
    png_base64: String,
    suggested_name: Option<String>,
) -> Result<String, String> {
    let (_, png_bytes) = decode_png_base64(&png_base64)?;

    #[cfg(target_os = "android")]
    {
        return save_png_bytes_to_android_gallery(&app, &png_bytes, suggested_name.as_deref());
    }

    #[cfg(not(target_os = "android"))]
    {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法获取应用数据目录: {e}"))?
            .join("practice")
            .join("question-images");
        fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("创建题图目录失败: {e}"))?;

        let file_path = dir.join(sanitize_png_filename(suggested_name.as_deref()));
        fs::write(&file_path, png_bytes)
            .await
            .map_err(|e| format!("保存题图失败: {e}"))?;

        Ok(file_path.to_string_lossy().to_string())
    }
}

#[cfg(target_os = "windows")]
fn write_png_bytes_to_windows_clipboard(png_bytes: &[u8]) -> Result<(), String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if png_bytes.len() < PNG_SIGNATURE.len() || &png_bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("invalid PNG signature".to_string());
    }

    let _clip = clipboard_win::Clipboard::new_attempts(12)
        .map_err(|e| format!("open clipboard failed: {e}"))?;

    clipboard_win::raw::empty().map_err(|e| format!("empty clipboard failed: {e}"))?;

    let format_id = clipboard_win::register_format("PNG")
        .ok_or_else(|| "Cannot register PNG clipboard format".to_string())?;

    clipboard_win::raw::set_without_clear(format_id.get(), png_bytes)
        .map_err(|e| format!("set clipboard PNG failed: {e}"))?;

    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn clipboard_write_png_base64(
    _app: tauri::AppHandle,
    _png_base64: String,
) -> Result<(), String> {
    Err("当前移动端暂不支持复制 PNG 到系统剪贴板".to_string())
}

/// Write a PNG image (base64-encoded bytes) into the system clipboard.
///
/// Why: WebView clipboard APIs are inconsistent (especially on macOS WKWebView).
/// This uses OS-native clipboard so paste behaves like a screenshot in other apps and in our input box.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn clipboard_write_png_base64(
    app: tauri::AppHandle,
    png_base64: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let _ = &app;

    let (base64_data, png_bytes) = decode_png_base64(&png_base64)?;
    let base64_data = base64_data.as_str();

    // Extra compatibility on macOS: write multiple pasteboard representations (PNG/TIFF/HTML/text/file-url).
    //
    // Motivation:
    // - 纯文本输入框通常只接受 NSPasteboardTypeString；如果只有 image/*，用户会误以为“没复制成功”。
    // - 部分富文本输入框会优先读取 HTML；提供 <img src="data:..."> 可以提升“可粘贴为图片”的概率。
    // - 提供 file:// URL 作为兜底，有些应用会把它当作可粘贴附件来源。
    #[cfg(target_os = "macos")]
    {
        use uuid::Uuid;

        let tmp_path =
            std::env::temp_dir().join(format!("tauri-ai-clipboard-{}.png", Uuid::new_v4()));
        let html = if png_bytes.len() <= MAX_INLINE_DATA_URL_PNG_BYTES {
            format!(
                "<img src=\"data:image/png;base64,{}\" alt=\"image\" />",
                base64_data
            )
        } else {
            "<span>[image]</span>".to_string()
        };

        // Do the pasteboard write synchronously (no run_on_main_thread).
        // Reason: In some cases, scheduling to the main thread returns Ok but the clipboard never changes.
        // NSPasteboard can be written from a background thread, and this path is simpler to debug.
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            use objc2::rc::autoreleasepool;
            use objc2::AnyThread;
            use objc2_app_kit::{
                NSImage, NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeHTML,
                NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
                NSPasteboardTypeURL,
            };
            use objc2_foundation::{NSData, NSMutableArray, NSString, NSURL};

            std::fs::write(&tmp_path, &png_bytes).map_err(|e| format!("写入临时图片失败: {e}"))?;
            let tmp_path_str = tmp_path
                .to_str()
                .ok_or_else(|| "临时图片路径包含非法字符，无法写入剪贴板".to_string())?
                .to_string();

            autoreleasepool(|_pool| -> Result<(), String> {
                let pb = NSPasteboard::generalPasteboard();

                let ty_png = unsafe { NSPasteboardTypePNG };
                let ty_tiff = unsafe { NSPasteboardTypeTIFF };
                let ty_html = unsafe { NSPasteboardTypeHTML };
                let ty_string = unsafe { NSPasteboardTypeString };
                let ty_file_url = unsafe { NSPasteboardTypeFileURL };
                let ty_url = unsafe { NSPasteboardTypeURL };

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

                let png_data = NSData::with_bytes(&png_bytes);
                let ok_png = pb.setData_forType(Some(&png_data), ty_png);
                if !ok_png {
                    return Err("写入剪贴板失败（PNG）".to_string());
                }

                if let Some(img) = NSImage::initWithData(NSImage::alloc(), &png_data) {
                    if let Some(tiff) = img.TIFFRepresentation() {
                        let _ = pb.setData_forType(Some(&tiff), ty_tiff);
                    }
                }

                let html_ns = NSString::from_str(&html);
                let _ = pb.setString_forType(&html_ns, ty_html);

                // Plain text: use file:// URL if possible so pasting into text inputs yields something useful.
                let path_ns = NSString::from_str(&tmp_path_str);
                let url = NSURL::fileURLWithPath(&path_ns);
                if let Some(url_str) = url.absoluteString() {
                    let _ = pb.setString_forType(&url_str, ty_file_url);
                    let _ = pb.setString_forType(&url_str, ty_url);
                    let _ = pb.setString_forType(&url_str, ty_string);
                } else {
                    let plain_ns = NSString::from_str(&tmp_path_str);
                    let _ = pb.setString_forType(&plain_ns, ty_string);
                }

                Ok(())
            })
        })
        .await
        .map_err(|e| format!("写入剪贴板任务失败: {e}"))??;

        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        {
            // Keep a copy of the original PNG bytes for a raw "PNG" clipboard fallback.
            let png_bytes = Arc::new(png_bytes);

            // Try decode PNG -> RGBA (required by `arboard::Clipboard::set_image`).
            // If decoding fails (some WebViews generate PNGs that `image` rejects), fall back to putting raw PNG bytes
            // on the clipboard (registered "PNG" format) so paste still works in most apps.
            let decoded: Result<(usize, usize, Vec<u8>), String> = tokio::task::spawn_blocking({
                let png_bytes = png_bytes.clone();
                move || -> Result<(usize, usize, Vec<u8>), String> {
                    let img =
                        image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
                            .map_err(|e| format!("parse PNG failed: {e}"))?;
                    let rgba = img.to_rgba8();
                    let (w, h) = rgba.dimensions();

                    if w == 0 || h == 0 {
                        return Err("invalid PNG dimensions".to_string());
                    }

                    Ok((w as usize, h as usize, rgba.into_raw()))
                }
            })
            .await
            .map_err(|e| format!("clipboard decode task failed: {e}"))?;

            let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
            app.run_on_main_thread(move || {
                let res = (|| -> Result<(), String> {
                    let primary_error: Option<String> = match decoded {
                        Ok((w, h, bytes)) => match arboard::Clipboard::new()
                            .map_err(|e| format!("init clipboard failed: {e}"))
                        {
                            Ok(mut clipboard) => match clipboard.set_image(arboard::ImageData {
                                width: w,
                                height: h,
                                bytes: Cow::Owned(bytes),
                            }) {
                                Ok(()) => return Ok(()),
                                Err(e) => Some(format!("set clipboard image failed: {e}")),
                            },
                            Err(e) => Some(e),
                        },
                        Err(e) => Some(e),
                    };

                    match write_png_bytes_to_windows_clipboard(png_bytes.as_ref().as_slice()) {
                        Ok(()) => Ok(()),
                        Err(fallback_err) => {
                            if let Some(primary) = primary_error {
                                Err(format!("{primary}; fallback failed: {fallback_err}"))
                            } else {
                                Err(fallback_err)
                            }
                        }
                    }
                })();

                let _ = tx.send(res);
            })
            .map_err(|e| format!("schedule clipboard write failed: {e}"))?;

            rx.await
                .map_err(|_| "clipboard write task failed: channel closed".to_string())??;
        }

        // Decode PNG -> RGBA (required by arboard).
        #[cfg(not(target_os = "windows"))]
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
