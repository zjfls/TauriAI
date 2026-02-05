#[tauri::command]
pub fn close_invoking_window(window: tauri::WebviewWindow) -> Result<(), String> {
    // Use `destroy` so we don't emit CloseRequested again (which could cause loops
    // if the frontend is listening to close events).
    window.destroy().map_err(|e| e.to_string())
}
