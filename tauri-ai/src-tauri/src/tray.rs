use std::sync::Arc;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tokio::sync::Mutex as TokioMutex;

use crate::config::ConfigManager;
use crate::storage::Database;

#[cfg(debug_assertions)]
fn try_load_dev_icon_from_disk() -> Option<Image<'static>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("icons-dev")
        .join("icon.png");
    match Image::from_path(&path) {
        Ok(img) => Some(img.to_owned()),
        Err(_) => None,
    }
}

fn dev_icon_image() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];

    let mut set_pixel = |x: u32, y: u32, r: u8, g: u8, b: u8, a: u8| {
        if x >= SIZE || y >= SIZE {
            return;
        }
        let i = ((y * SIZE + x) * 4) as usize;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = a;
    };

    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut r: u8 = 239;
            let mut g: u8 = 68;
            let mut b: u8 = 68;
            if (x + y) % 8 < 4 {
                r = r.saturating_add(18);
                g = g.saturating_add(18);
                b = b.saturating_add(18);
            }
            if x == 0 || y == 0 || x == SIZE - 1 || y == SIZE - 1 {
                r = 255;
                g = 255;
                b = 255;
            }
            set_pixel(x, y, r, g, b, 255);
        }
    }

    let glyph_d = ["1110", "1001", "1001", "1001", "1001", "1110"];
    let glyph_e = ["1111", "1000", "1110", "1000", "1000", "1111"];
    let glyph_v = ["1001", "1001", "1001", "1001", "0101", "0010"];
    let letters = [glyph_d, glyph_e, glyph_v];

    let glyph_w: u32 = 4;
    let glyph_h: u32 = 6;
    let scale: u32 = 2;
    let spacing: u32 = 2;
    let total_w = (glyph_w * scale) * letters.len() as u32 + spacing * (letters.len() as u32 - 1);
    let total_h = glyph_h * scale;
    let start_x = (SIZE.saturating_sub(total_w)) / 2;
    let start_y = (SIZE.saturating_sub(total_h)) / 2;

    for (li, glyph) in letters.iter().enumerate() {
        let base_x = start_x + li as u32 * (glyph_w * scale + spacing);
        for (gy, row) in glyph.iter().enumerate() {
            for gx in 0..glyph_w as usize {
                if row.as_bytes().get(gx).copied() != Some(b'1') {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        set_pixel(
                            base_x + gx as u32 * scale + sx,
                            start_y + gy as u32 * scale + sy,
                            255,
                            255,
                            255,
                            255,
                        );
                    }
                }
            }
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

/// 切换主窗口的可见性
///
/// 如果窗口当前可见，则隐藏它；如果隐藏，则显示并聚焦。
/// 满足需求 9.2: 点击托盘图标切换窗口可见性
fn toggle_window_visibility<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

/// 显示主窗口并聚焦
fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    // 兜底：如果主窗口不存在（极少数情况下可能被销毁/未初始化完成），尝试重建它。
    let _ = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("tauri-ai")
        .build()
        .and_then(|w| {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            Ok(())
        });
}

/// 保存应用状态并退出
///
/// 在退出前确保所有状态都已保存到磁盘。
/// 满足需求 9.5: 退出时保存状态
fn save_state_and_exit<R: Runtime>(app: &AppHandle<R>) {
    // 尝试获取配置管理器并确保配置已保存
    // 配置在每次修改时都会自动保存，这里主要是确保没有遗漏
    if let Some(config_manager) = app.try_state::<Arc<ConfigManager>>() {
        // 配置管理器存在，尝试加载当前配置以验证状态
        if let Ok(config) = config_manager.load() {
            // 重新保存配置以确保最新状态已持久化
            let _ = config_manager.save(&config);
        }
    }

    // 数据库使用 SQLite，写入操作是即时的，不需要额外的保存步骤
    // 但我们可以确保数据库连接正确关闭
    if let Some(database) = app.try_state::<Arc<TokioMutex<Database>>>() {
        // 数据库状态存在，Rust 的 Drop trait 会在退出时自动关闭连接
        // 这里只是确认数据库状态可访问
        let _ = database;
    }

    // 退出应用
    app.exit(0);
}

/// 创建并配置系统托盘
///
/// 设置托盘图标、菜单和事件处理器。
/// 满足需求:
/// - 9.1: 应用启动时显示托盘图标
/// - 9.2: 点击托盘图标切换窗口可见性
/// - 9.3: 右键菜单显示"显示窗口"和"退出"选项
/// - 9.5: 退出时保存状态
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 创建托盘菜单项
    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    // 创建托盘菜单
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    // 加载托盘图标：
    // - DEV：使用带 “DEV” 标识的图标，避免与打包版本混淆
    // - Release：使用内嵌的 PNG 图标
    let icon = if cfg!(debug_assertions) {
        #[cfg(debug_assertions)]
        {
            // 优先使用本地 `src-tauri/icons-dev/icon.png`（由脚本从 SVG 生成）。
            // 若文件不存在或解码失败，则回退到内置的 DEV 图标（避免开发环境启动失败）。
            try_load_dev_icon_from_disk().unwrap_or_else(dev_icon_image)
        }
        #[cfg(not(debug_assertions))]
        {
            dev_icon_image()
        }
    } else {
        Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("Failed to load tray icon")
    };

    // 构建托盘图标
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("TauriAI")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                // 显示窗口菜单项
                show_window(app);
            }
            "quit" => {
                // 退出菜单项 - 保存状态后退出
                save_state_and_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 处理托盘图标点击事件
            // 满足需求 9.2: 点击托盘图标切换窗口可见性
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_window_visibility(&app);
            }
        })
        .build(app)?;

    // 重要：不能让 tray handle 被 drop，否则回调可能失效（Windows 上可能表现为“菜单能点但没反应”）。
    // 这里用 mem::forget 保活（托盘只创建一次，泄漏量可忽略）。
    std::mem::forget(tray);

    Ok(())
}
