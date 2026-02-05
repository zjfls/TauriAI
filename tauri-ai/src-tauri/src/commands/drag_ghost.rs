use tauri::{Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl};

fn safe_label_part(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | ':' | '/' | '-' => c,
            _ => '_',
        })
        .collect()
}

fn ghost_label_for_source(source_label: &str) -> String {
    format!("__tauriai_ghost__{}", safe_label_part(source_label))
}

fn build_ghost_url(handle: &tauri::AppHandle, title: &str) -> Url {
    // 注意：不要引入额外依赖。这里做最小 URL encoding（空格 -> %20）。
    // 其它字符若有问题，后续再按需增强。
    let encoded_title = title.replace(' ', "%20");

    if cfg!(debug_assertions) {
        handle
            .config()
            .build
            .dev_url
            .clone()
            .and_then(|base| {
                let base = base.as_str().trim_end_matches('/').to_string();
                Url::parse(&format!(
                    "{base}/?view=drag-ghost&standalone=1&ghostTitle={encoded_title}"
                ))
                .ok()
            })
            .unwrap_or_else(|| {
                Url::parse(&format!(
                    "tauri://localhost/?view=drag-ghost&standalone=1&ghostTitle={encoded_title}"
                ))
                .expect("valid tauri url")
            })
    } else {
        Url::parse(&format!(
            "tauri://localhost/?view=drag-ghost&standalone=1&ghostTitle={encoded_title}"
        ))
        .expect("valid tauri url")
    }
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

    let (source_pos, source_size) = (
        source.outer_position().ok(),
        source.outer_size().ok(),
    );

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
        let _ = ghost.set_size(PhysicalSize::new(ghost_w as u32, ghost_h as u32));
        let _ = ghost.set_position(PhysicalPosition::new(x, y));
        let _ = ghost.set_title(&format!("[GHOST] {}", title));
        let _ = ghost.set_ignore_cursor_events(true);
        let _ = ghost.show();
        #[cfg(debug_assertions)]
        println!(
            "[debug_drag_ghost_create] reused label={} centered=({}, {}) size=({}, {})",
            ghost_label, x, y, ghost_w, ghost_h
        );
        return Ok(());
    }

    let url = build_ghost_url(&app, &title);
    let webview_url = match url.scheme() {
        "http" | "https" => WebviewUrl::External(url),
        _ => WebviewUrl::CustomProtocol(url),
    };

    let builder = tauri::WebviewWindowBuilder::new(&app, ghost_label.clone(), webview_url)
        .title(&format!("[GHOST] {}", title))
        .decorations(cfg!(debug_assertions))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // 先用逻辑尺寸创建，随后再用 physical 尺寸修正（避免 DPI 不一致）。
        .inner_size(ghost_w as f64, ghost_h as f64);

    let ghost = builder.build().map_err(|e| e.to_string())?;
    let _ = ghost.set_size(PhysicalSize::new(ghost_w as u32, ghost_h as u32));
    let _ = ghost.set_position(PhysicalPosition::new(x, y));
    let _ = ghost.set_ignore_cursor_events(true);
    let _ = ghost.show();

    #[cfg(debug_assertions)]
    println!(
        "[debug_drag_ghost_create] created label={} centered=({}, {}) size=({}, {})",
        ghost_label, x, y, ghost_w, ghost_h
    );

    Ok(())
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

    // 轻微偏移，避免挡住鼠标指针
    const OFFSET_X: i32 = 14;
    const OFFSET_Y: i32 = 18;

    let _ = ghost.set_position(PhysicalPosition::new(x + OFFSET_X, y + OFFSET_Y));
    Ok(())
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
        let _ = ghost.close();
        #[cfg(debug_assertions)]
        println!("[debug_drag_ghost_destroy] closed label={}", ghost_label);
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
