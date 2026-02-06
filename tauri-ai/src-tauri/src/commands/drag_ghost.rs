use serde::Serialize;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl};

#[derive(Debug, Clone, Serialize)]
struct DragGhostUpdatePayload {
    title: String,
}

fn safe_label_part(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | ':' | '/' | '-' => c,
            _ => '_',
        })
        .collect()
}

fn ghost_label_for_source(source_label: &str) -> String {
    // 关键策略：Windows 上在拖拽/菜单回调期间动态创建 WebviewWindow 可能卡死在 `builder.build()`。
    // 因此 ghost 窗口改为“启动时预创建一个单例”，运行期只做 show/move/update。
    // 这里始终返回同一个 label，避免多窗口创建带来的不稳定性。
    let _ = source_label;
    "__tauriai_ghost__global".to_string()
}

fn build_ghost_webview_url(handle: &tauri::AppHandle, title: &str) -> WebviewUrl {
    // Dev: prefer the dev server so we can iterate quickly.
    if cfg!(debug_assertions) {
        let encoded_title = urlencoding::encode(title).to_string();
        if let Some(base) = handle.config().build.dev_url.clone() {
            let base = base.as_str().trim_end_matches('/').to_string();
            if let Ok(url) = Url::parse(&format!(
                "{base}/?view=drag-ghost&standalone=1&ghostTitle={encoded_title}"
            )) {
                return WebviewUrl::External(url);
            }
        }
    }

    // Build: do NOT rely on query params; some runtimes are picky about `App(path?query)` and may render blank.
    // We'll detect ghost windows by label prefix on the frontend side.
    WebviewUrl::App("index.html".into())
}

#[tauri::command]
pub fn drag_ghost_create(
    app: tauri::AppHandle,
    title: String,
    source_label: Option<String>,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Ok(());
    }

    let source_label = source_label.unwrap_or_else(|| "main".to_string());
    let source = app
        .get_webview_window(&source_label)
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "main window not found".to_string())?;

    let ghost_label = ghost_label_for_source(source.label().as_ref());

    let source_pos = source.outer_position().ok();
    let source_size = source.outer_size().ok();

    let (ghost_w, ghost_h) = if let Some(size) = source_size {
        let w = (size.width as i32 / 5).max(240);
        let h = (size.height as i32 / 5).max(160);
        (w, h)
    } else {
        (420, 240)
    };

    let (x, y) = if let (Some(pos), Some(size)) = (source_pos, source_size) {
        (
            pos.x + ((size.width as i32 - ghost_w) / 2),
            pos.y + ((size.height as i32 - ghost_h) / 2),
        )
    } else {
        (80, 80)
    };

    if let Some(ghost) = app.get_webview_window(&ghost_label) {
        println!(
            "[drag_ghost_create] reuse label={} title={} pos=({}, {}) size=({}, {})",
            ghost_label, title, x, y, ghost_w, ghost_h
        );
        ghost
            .set_size(PhysicalSize::new(ghost_w as u32, ghost_h as u32))
            .map_err(|e| e.to_string())?;
        ghost
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        ghost
            .set_title(&format!("[GHOST] {}", title))
            .map_err(|e| e.to_string())?;
        ghost
            .set_focusable(false)
            .map_err(|e| e.to_string())?;
        ghost
            // 关键：ghost 必须“鼠标穿透”，否则会抢占拖拽事件，导致拖拽中断或 move 不再触发。
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        ghost.show().map_err(|e| e.to_string())?;
        let _ = source.set_focus();
        let _ = ghost.emit(
            "drag-ghost:update",
            DragGhostUpdatePayload {
                title: title.clone(),
            },
        );

        return Ok(());
    }

    Err(format!(
        "ghost window not initialized (label={}); please restart app",
        ghost_label
    ))
}

#[tauri::command]
pub fn drag_ghost_move(
    app: tauri::AppHandle,
    source_label: Option<String>,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let source_label = source_label.unwrap_or_else(|| "main".to_string());
    let source = app
        .get_webview_window(&source_label)
        .or_else(|| app.get_webview_window("main"));

    let ghost_label = if let Some(source) = source {
        ghost_label_for_source(source.label().as_ref())
    } else {
        ghost_label_for_source("main")
    };

    let ghost = app
        .get_webview_window(&ghost_label)
        .ok_or_else(|| format!("ghost window not found: {}", ghost_label))?;

    const OFFSET_X: i32 = 14;
    const OFFSET_Y: i32 = 18;

    ghost
        .set_position(PhysicalPosition::new(x + OFFSET_X, y + OFFSET_Y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move ghost window using a client-space cursor position (CSS pixels).
///
/// This avoids relying on `cursorPosition()` JS polling, which may stop updating
/// in some drag scenarios. We convert to physical screen coordinates using the
/// source window's `inner_position` + `scale_factor`.
#[tauri::command]
pub fn drag_ghost_move_client(
    app: tauri::AppHandle,
    source_label: Option<String>,
    client_x: f64,
    client_y: f64,
) -> Result<(), String> {
    if !client_x.is_finite() || !client_y.is_finite() {
        return Ok(());
    }

    let source_label = source_label.unwrap_or_else(|| "main".to_string());
    let source = app
        .get_webview_window(&source_label)
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "main window not found".to_string())?;

    let scale = source.scale_factor().map_err(|e| e.to_string())?;
    let inner = source.inner_position().map_err(|e| e.to_string())?;

    let x = inner.x + (client_x * scale).round() as i32;
    let y = inner.y + (client_y * scale).round() as i32;

    drag_ghost_move(app, Some(source.label().to_string()), x, y)
}

#[tauri::command]
pub fn drag_ghost_destroy(
    app: tauri::AppHandle,
    source_label: Option<String>,
) -> Result<(), String> {
    let source_label = source_label.unwrap_or_else(|| "main".to_string());
    let source = app
        .get_webview_window(&source_label)
        .or_else(|| app.get_webview_window("main"));

    let ghost_label = if let Some(source) = source {
        ghost_label_for_source(source.label().as_ref())
    } else {
        ghost_label_for_source("main")
    };

    if let Some(ghost) = app.get_webview_window(&ghost_label) {
        let _ = ghost.hide();
        #[cfg(debug_assertions)]
        println!("[drag_ghost_destroy] hide label={}", ghost_label);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Backward compatibility (old command names)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn debug_drag_ghost_create(
    app: tauri::AppHandle,
    title: String,
    source_label: Option<String>,
) -> Result<(), String> {
    drag_ghost_create(app, title, source_label)
}

#[tauri::command]
pub fn debug_drag_ghost_move(
    app: tauri::AppHandle,
    source_label: Option<String>,
    x: i32,
    y: i32,
) -> Result<(), String> {
    drag_ghost_move(app, source_label, x, y)
}

#[tauri::command]
pub fn debug_drag_ghost_destroy(
    app: tauri::AppHandle,
    source_label: Option<String>,
) -> Result<(), String> {
    drag_ghost_destroy(app, source_label)
}
