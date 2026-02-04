//! DevTools helpers (frontend-invokable)

/// Open DevTools for the current window (best-effort).
///
/// Note: DevTools availability depends on build/config. In release builds it may be disabled.
#[tauri::command]
pub fn open_devtools_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.open_devtools();
    Ok(())
}
