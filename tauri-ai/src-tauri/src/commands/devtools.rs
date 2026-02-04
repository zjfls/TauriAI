//! DevTools helpers (frontend-invokable)

/// Open DevTools for the current window (best-effort).
///
/// Note: DevTools availability depends on build/config. In release builds it may be disabled.
#[tauri::command]
pub fn open_devtools_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    // `open_devtools` 在 tauri v2 中通常只在 debug 构建可用；release 构建里该 API 可能被裁剪，
    // 直接调用会导致编译错误（no method named `open_devtools`）。
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("DevTools 仅在开发版可用".to_string())
    }
}
