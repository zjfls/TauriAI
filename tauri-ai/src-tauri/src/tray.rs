use std::sync::Arc;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tokio::sync::Mutex;

use crate::config::ConfigManager;
use crate::storage::Database;

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
            let _ = window.set_focus();
        }
    }
}

/// 显示主窗口并聚焦
fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
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
    if let Some(database) = app.try_state::<Arc<Mutex<Database>>>() {
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

    // 加载托盘图标 - 使用内嵌的 PNG 图标
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .expect("Failed to load tray icon");

    // 构建托盘图标
    let _tray = TrayIconBuilder::new()
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

    Ok(())
}
