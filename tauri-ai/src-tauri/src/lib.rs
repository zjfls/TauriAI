// Module declarations
pub mod agents;
pub mod ai_client;
pub mod bundled_tools;
pub mod commands;
pub mod config;
pub mod errors;
pub mod models;
pub mod prompts;
pub mod runtime;
pub mod skills;
pub mod storage;
pub mod tray;
pub mod workstudio_security;

use std::sync::Arc;
use tokio::sync::Mutex;

	use commands::{
	    abort_run, add_workstudio_folder, clipboard_write_png_base64, clone_conversation,
	    close_pty_session, create_conversation, create_skill, create_workstudio, delete_conversation,
	    delete_mcp_server, delete_mcp_set, delete_messages_from, ensure_workstudio_for_conversation,
	    ensure_conversation_file_indexes, fetch_provider_models, generate_title, get_app_config,
	    get_conversations, get_format_prompt, get_mermaid_svg_cache, get_messages, get_turn_debug_info,
	    close_invoking_window,
	    debug_drag_ghost_create, debug_drag_ghost_destroy, debug_drag_ghost_move, drag_ghost_create,
	    drag_ghost_destroy, drag_ghost_move,
	    get_workstudio,
	    get_workstudio_security_config, get_workstudio_ui_state, list_local_directory,
	    list_mcp_server_tools, list_mcp_servers, list_mcp_sets, list_pty_sessions, list_skills,
	    open_devtools_current_window, read_local_file_base64, remove_workstudio_folder,
    respond_approval, retry_turn, run_task, save_app_config, set_agent_mcp_set,
    set_mermaid_svg_cache, set_workstudio_main_folder, set_workstudio_security_config,
    set_workstudio_ui_state, terminal_close, terminal_create, terminal_read, terminal_read_base64,
    terminal_write, test_connection, test_mcp_server, update_conversation_metadata,
    update_conversation_title, upsert_mcp_server, upsert_mcp_set, workstudio_find_files,
    workstudio_terminal_close, workstudio_terminal_create, workstudio_terminal_read,
    workstudio_terminal_read_base64, workstudio_terminal_write, write_local_text_file,
};
use config::ConfigManager;
use runtime::RunState;
use skills::installer::install_bundled_skills;
use skills::watcher::{SkillsWatcher, SkillsWatcherState};
use storage::Database;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{PhysicalPosition, PhysicalSize};
use tauri::WebviewUrl;
use tauri::{Emitter, Manager, Url};

#[cfg(all(debug_assertions, target_os = "macos"))]
fn schedule_set_dev_dock_icon(app: &tauri::AppHandle) {
    use std::sync::Arc;
    use std::time::Duration;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("icons-dev")
        .join("icon.png");
    let bytes = match std::fs::read(&path) {
        Ok(b) => Arc::new(b),
        Err(_) => return,
    };

    // 关键点：
    // - Tauri 在 dev 模式下会在 `RunEvent::Ready` 再设置一次 Dock 图标（来自 app_icon），
    //   所以这里必须“延后一点点”再设置，确保不会被覆盖。
    // - 用 run_on_main_thread 保证在主线程执行（并使用 new_unchecked 与 Tauri 内部保持一致）。
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let bytes = bytes.clone();
        let _ = handle.run_on_main_thread(move || {
            use objc2::AllocAnyThread;
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSApplication, NSImage};
            use objc2_foundation::NSData;

            // 与 Tauri 内部实现对齐：不做主线程检查（否则在某些情况下会被误判）。
            let mtm = unsafe { MainThreadMarker::new_unchecked() };
            let app_ns = NSApplication::sharedApplication(mtm);
            let data = NSData::with_bytes(&bytes);
            if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
                unsafe { app_ns.setApplicationIconImage(Some(&icon)) };
            }
        });
    });
}

/// Get the default database path (~/.tauri-ai/data.db)
fn get_database_path() -> std::path::PathBuf {
    let home_dir = dirs::home_dir().expect("Failed to get home directory");
    home_dir.join(".tauri-ai").join("data.db")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    println!("[Backend] TauriAI starting...");

    // Initialize database
    let db_path = get_database_path();
    println!("[Backend] Database path: {:?}", db_path);
    let database = Database::new(db_path).expect("Failed to initialize database");
    println!("[Backend] Database initialized");
    let database = Arc::new(Mutex::new(database));

    // Initialize config manager
    let config_manager = ConfigManager::new().expect("Failed to initialize config manager");
    let config_manager = Arc::new(config_manager);

    // Initialize run state (shared runtime controls: abort/wait)
    let run_state = Arc::new(RunState::new());

    tauri::Builder::default()
        .menu(|app| {
            // Start from Tauri's default menu (macOS has one by default).
            // Then inject our "Open File" entry into the File submenu.
            let menu = Menu::default(app)?;

            let open_file =
                MenuItem::with_id(app, "open_file", "打开文件…", true, Some("CmdOrCtrl+O"))?;

            let new_richtxt = MenuItem::with_id(
                app,
                "new_richtxt",
                "新建 .tauri.richtxt",
                true,
                Some("CmdOrCtrl+N"),
            )?;

            let separator = PredefinedMenuItem::separator(app)?;
            let test_window = MenuItem::with_id(
                app,
                "test_window",
                "测试多窗口",
                true,
                Some("CmdOrCtrl+Shift+N"),
            )?;

            // View: open web/terminal as tabs inside the workspace (not standalone windows).
            let open_web_tab = MenuItem::with_id(
                app,
                "open_web_tab",
                "打开网页标签",
                true,
                Some("CmdOrCtrl+Alt+W"),
            )?;
            let open_terminal_tab = MenuItem::with_id(
                app,
                "open_terminal_tab",
                "打开终端标签",
                true,
                Some("CmdOrCtrl+Alt+T"),
            )?;
            let view_separator = PredefinedMenuItem::separator(app)?;
            #[cfg(debug_assertions)]
            let open_devtools = MenuItem::with_id(
                app,
                "open_devtools",
                "打开开发者工具",
                true,
                Some("CmdOrCtrl+Alt+I"),
            )?;
            #[cfg(debug_assertions)]
            let unit_test_ghost = MenuItem::with_id(
                app,
                "unit_test_ghost",
                "单元测试：显示 Ghost 窗口",
                true,
                Some("CmdOrCtrl+Shift+G"),
            )?;

            // Find existing "File" submenu and insert at the top. If not found (e.g. Linux),
            // create one.
            let mut file_submenu: Option<Submenu<_>> = None;
            for item in menu.items().unwrap_or_default() {
                if let MenuItemKind::Submenu(submenu) = item {
                    if let Ok(text) = submenu.text() {
                        if text == "File" || text == "文件" {
                            file_submenu = Some(submenu);
                            break;
                        }
                    }
                }
            }

            if let Some(file) = file_submenu {
                file.insert_items(&[&new_richtxt, &open_file, &test_window, &separator], 0)?;
            } else {
                let file = Submenu::with_items(
                    app,
                    "File",
                    true,
                    &[&new_richtxt, &open_file, &test_window],
                )?;
                // On macOS, index 0 is the app menu. Insert after it.
                let pos = if cfg!(target_os = "macos") { 1 } else { 0 };
                menu.insert(&file, pos)?;
            }

            // Find existing "View" submenu and insert our actions at the top. If not found, create one.
            let mut view_submenu: Option<Submenu<_>> = None;
            for item in menu.items().unwrap_or_default() {
                if let MenuItemKind::Submenu(submenu) = item {
                    if let Ok(text) = submenu.text() {
                        if text == "View" || text == "视图" {
                            view_submenu = Some(submenu);
                            break;
                        }
                    }
                }
            }

            if let Some(view) = view_submenu {
                #[cfg(debug_assertions)]
                view.insert_items(&[&unit_test_ghost, &open_devtools], 0)?;
                view.insert_items(&[&open_web_tab, &open_terminal_tab, &view_separator], 0)?;
            } else {
                #[cfg(debug_assertions)]
                let view = Submenu::with_items(
                    app,
                    "View",
                    true,
                    &[&unit_test_ghost, &open_devtools, &open_web_tab, &open_terminal_tab],
                )?;
                #[cfg(not(debug_assertions))]
                let view =
                    Submenu::with_items(app, "View", true, &[&open_web_tab, &open_terminal_tab])?;
                // Insert after File submenu (best-effort). On macOS index 0 is app menu.
                let pos = if cfg!(target_os = "macos") { 2 } else { 1 };
                menu.insert(&view, pos)?;
            }

            Ok(menu)
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "new_richtxt" => {
                    // Send event to create a new .tauri.richtxt file
                    let focused = app
                        .webview_windows()
                        .into_values()
                        .find(|w| w.is_focused().unwrap_or(false));

                    if let Some(window) = focused.or_else(|| app.get_webview_window("main")) {
                        let _ = window.emit("menu:new_richtxt", ());
                    } else {
                        let _ = app.emit("menu:new_richtxt", ());
                    }
                }
                "open_file" => {
                    // Send the event only to the focused window (fall back to main).
                    let focused = app
                        .webview_windows()
                        .into_values()
                        .find(|w| w.is_focused().unwrap_or(false));

                    if let Some(window) = focused.or_else(|| app.get_webview_window("main")) {
                        let _ = window.emit("menu:open_file", ());
                    } else {
                        let _ = app.emit("menu:open_file", ());
                    }
                }
                "open_web_tab" => {
                    let focused = app
                        .webview_windows()
                        .into_values()
                        .find(|w| w.is_focused().unwrap_or(false));

                    if let Some(window) = focused.or_else(|| app.get_webview_window("main")) {
                        let _ = window.emit("menu:open_web_tab", ());
                    } else {
                        let _ = app.emit("menu:open_web_tab", ());
                    }
                }
                "open_terminal_tab" => {
                    let focused = app
                        .webview_windows()
                        .into_values()
                        .find(|w| w.is_focused().unwrap_or(false));

                    if let Some(window) = focused.or_else(|| app.get_webview_window("main")) {
                        let _ = window.emit("menu:open_terminal_tab", ());
                    } else {
                        let _ = app.emit("menu:open_terminal_tab", ());
                    }
                }
                "open_devtools" => {
                    #[cfg(debug_assertions)]
                    {
                        let focused = app
                            .webview_windows()
                            .into_values()
                            .find(|w| w.is_focused().unwrap_or(false));

                        if let Some(window) = focused.or_else(|| app.get_webview_window("main")) {
                            window.open_devtools();
                        }
                    }
                }
                "test_window" => {
                    // Create a standalone window for testing multi-window behavior.
                    // On Windows, window creation can deadlock inside event handlers; use a new thread.
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let label =
                            format!("view-window-test-{}", chrono::Utc::now().timestamp_millis());

                        let url = if cfg!(debug_assertions) {
                            handle
                                .config()
                                .build
                                .dev_url
                                .clone()
                                .and_then(|base| {
                                    let base = base.as_str().trim_end_matches('/').to_string();
                                    Url::parse(&format!("{base}/?view=window_test&standalone=1"))
                                        .ok()
                                })
                                .unwrap_or_else(|| {
                                    Url::parse("tauri://localhost/?view=window_test&standalone=1")
                                        .expect("valid tauri url")
                                })
                        } else {
                            Url::parse("tauri://localhost/?view=window_test&standalone=1")
                                .expect("valid tauri url")
                        };

                        let webview_url = match url.scheme() {
                            "http" | "https" => WebviewUrl::External(url),
                            _ => WebviewUrl::CustomProtocol(url),
                        };

                        let _ = tauri::WebviewWindowBuilder::new(&handle, label, webview_url)
                            .title("Window Test")
                            .inner_size(1170.0, 910.0)
                            .build();
                    });
                }
                "unit_test_ghost" => {
                    // Debug-only: create (or reuse) exactly one ghost window and center it in main window.
                    #[cfg(debug_assertions)]
                    {
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            const GHOST_LABEL: &str = "__tauriai_ghost__main";

                            #[derive(Clone, serde::Serialize)]
                            struct DragGhostUpdatePayload {
                                title: String,
                            }

                            let main = match handle.get_webview_window("main") {
                                Some(w) => w,
                                None => return,
                            };

                            let (main_pos, main_size) = (
                                main.outer_position().ok(),
                                main.outer_size().ok(),
                            );

                            let (ghost_w, ghost_h) = if let Some(size) = main_size {
                                let w = (size.width as i32 / 5).max(240);
                                let h = (size.height as i32 / 5).max(160);
                                (w, h)
                            } else {
                                (420, 240)
                            };

                            let (x, y) = if let (Some(pos), Some(size)) = (main_pos, main_size) {
                                (
                                    pos.x + ((size.width as i32 - ghost_w) / 2),
                                    pos.y + ((size.height as i32 - ghost_h) / 2),
                                )
                            } else {
                                (80, 80)
                            };

                            // Reuse existing ghost window if present.
                            if let Some(ghost) = handle.get_webview_window(GHOST_LABEL) {
                                let _ =
                                    ghost.set_size(PhysicalSize::new(ghost_w as u32, ghost_h as u32));
                                let _ = ghost.set_position(PhysicalPosition::new(x, y));
                                let _ = ghost.show();
                                let _ = ghost.set_focus();
                                let _ = ghost.emit(
                                    "drag-ghost:update",
                                    DragGhostUpdatePayload {
                                        title: "Unit Test Ghost (Menu)".to_string(),
                                    },
                                );
                                return;
                            }

                            let url = if cfg!(debug_assertions) {
                                handle
                                    .config()
                                    .build
                                    .dev_url
                                    .clone()
                                    .and_then(|base| {
                                        let base = base.as_str().trim_end_matches('/').to_string();
                                        Url::parse(&format!(
                                            "{base}/?view=drag-ghost&standalone=1&ghostTitle=Unit%20Test%20Ghost%20(Menu)"
                                        ))
                                        .ok()
                                    })
                                    .unwrap_or_else(|| {
                                        Url::parse(
                                            "tauri://localhost/?view=drag-ghost&standalone=1&ghostTitle=Unit%20Test%20Ghost%20(Menu)",
                                        )
                                        .expect("valid tauri url")
                                    })
                            } else {
                                Url::parse(
                                    "tauri://localhost/?view=drag-ghost&standalone=1&ghostTitle=Unit%20Test%20Ghost%20(Menu)",
                                )
                                .expect("valid tauri url")
                            };

                            let webview_url = match url.scheme() {
                                "http" | "https" => WebviewUrl::External(url),
                                _ => WebviewUrl::CustomProtocol(url),
                            };

                            let builder = tauri::WebviewWindowBuilder::new(
                                &handle,
                                GHOST_LABEL.to_string(),
                                webview_url,
                            )
                            .title("[GHOST] Unit Test")
                            .decorations(true)
                            .always_on_top(true)
                            .skip_taskbar(true)
                            .resizable(false)
                            .inner_size(ghost_w as f64, ghost_h as f64);

                            if let Ok(ghost) = builder.build() {
                                // Use physical coordinates/sizes to avoid DPI scale-factor mismatches.
                                let _ = ghost
                                    .set_size(PhysicalSize::new(ghost_w as u32, ghost_h as u32));
                                let _ = ghost.set_position(PhysicalPosition::new(x, y));
                                let _ = ghost.show();
                                let _ = ghost.set_focus();
                                let _ = ghost.emit(
                                    "drag-ghost:update",
                                    DragGhostUpdatePayload {
                                        title: "Unit Test Ghost (Menu)".to_string(),
                                    },
                                );
                                #[cfg(debug_assertions)]
                                println!(
                                    "[unit_test_ghost] created and centered at ({}, {}) size=({}, {})",
                                    x, y, ghost_w, ghost_h
                                );
                            }
                        });
                    }
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(database)
        .manage(config_manager)
        .manage(run_state)
        .invoke_handler(tauri::generate_handler![
            // Runtime commands
            run_task,
            retry_turn,
            abort_run,
            respond_approval,
            list_pty_sessions,
            close_pty_session,
            // Workstudio commands
            ensure_workstudio_for_conversation,
            get_workstudio,
            add_workstudio_folder,
            create_workstudio,
            set_workstudio_main_folder,
            remove_workstudio_folder,
            workstudio_find_files,
            // Workstudio terminal (UI)
            workstudio_terminal_create,
            workstudio_terminal_write,
            workstudio_terminal_read,
            workstudio_terminal_read_base64,
            workstudio_terminal_close,
            // Unified terminal (UI)
            terminal_create,
            terminal_write,
            terminal_read,
            terminal_read_base64,
            terminal_close,
            // Workstudio state (UI persisted)
            get_workstudio_ui_state,
            set_workstudio_ui_state,
            // Workstudio security (workspace-scoped)
            get_workstudio_security_config,
            set_workstudio_security_config,
            // Conversation commands
            get_conversations,
            get_messages,
            get_turn_debug_info,
            create_conversation,
            clone_conversation,
            delete_conversation,
            delete_messages_from,
            update_conversation_metadata,
            ensure_conversation_file_indexes,
            update_conversation_title,
            generate_title,
            // Config commands
            get_app_config,
            save_app_config,
            test_connection,
            fetch_provider_models,
            // Clipboard
            clipboard_write_png_base64,
	            // DevTools
	            open_devtools_current_window,
	            // Drag ghost
	            drag_ghost_create,
	            drag_ghost_destroy,
	            drag_ghost_move,
	            // Backward compatibility (old command names)
	            debug_drag_ghost_create,
	            debug_drag_ghost_destroy,
	            debug_drag_ghost_move,
	            // Window control
	            close_invoking_window,
            // MCP commands
            list_mcp_servers,
            list_mcp_sets,
            list_mcp_server_tools,
            test_mcp_server,
            upsert_mcp_server,
            delete_mcp_server,
            upsert_mcp_set,
            delete_mcp_set,
            set_agent_mcp_set,
            // Skills commands
            list_skills,
            create_skill,
            // Prompt commands
            get_format_prompt,
            // Mermaid SVG cache (disk)
            get_mermaid_svg_cache,
            set_mermaid_svg_cache,
            // File commands (drag & drop paths -> data)
            read_local_file_base64,
            list_local_directory,
            write_local_text_file,
        ])
        .setup(|app| {
            // Skills watcher for realtime refresh
            app.manage(SkillsWatcherState(SkillsWatcher::new(app.handle().clone())));

            // Install bundled (repo/system) skills into app skills dir (~/.tauri-ai/skills)
            if let Ok(resource_dir) = app.path().resource_dir() {
                let src_skills = resource_dir.join("skills");
                if let Some(cfg) = app.try_state::<Arc<ConfigManager>>() {
                    if let Some(dest_root) = cfg.config_path().parent().map(|p| p.join("skills")) {
                        let _ = install_bundled_skills(&src_skills, &dest_root);
                    }
                }
            }

            // 将内置工具目录加入 PATH（例如 rg）
            bundled_tools::init(app.handle());

            // 初始化系统托盘
            tray::create_tray(app.handle())?;

            // DEV: 动态设置 macOS Dock 图标（来自 `src-tauri/icons-dev/icon.png`）。
            // 说明：这不会影响 build 产物图标；仅在开发运行时生效。
            #[cfg(all(debug_assertions, target_os = "macos"))]
            schedule_set_dev_dock_icon(app.handle());

            // 设置窗口关闭事件处理
            // 满足需求 9.4: 点击关闭按钮时隐藏窗口而非退出
            if let Some(window) = app.get_webview_window("main") {
                // DEV: 让任务栏/Alt-Tab/窗口图标与托盘一致（使用 `src-tauri/icons-dev/icon.png`）。
                #[cfg(all(debug_assertions, target_os = "windows"))]
                {
                    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("icons-dev")
                        .join("icon.png");
                    if let Ok(icon) = tauri::image::Image::from_path(&path) {
                        let _ = window.set_icon(icon.to_owned());
                    }
                }

                // 在开发模式下可通过通用设置 / 环境变量打开 DevTools（默认关闭）
                #[cfg(debug_assertions)]
                {
                    let env_override = std::env::var("TAURIAI_OPEN_DEVTOOLS").ok().and_then(|v| {
                        match v.trim().to_ascii_lowercase().as_str() {
                            "1" | "true" | "yes" | "on" => Some(true),
                            "0" | "false" | "no" | "off" => Some(false),
                            _ => None,
                        }
                    });

                    let config_value = app
                        .try_state::<Arc<ConfigManager>>()
                        .and_then(|m| m.ensure_default().ok())
                        .map(|c| c.general.open_devtools_on_start)
                        .unwrap_or(false);

                    let open_devtools = env_override.unwrap_or(config_value);
                    if open_devtools {
                        window.open_devtools();
                    }
                }

                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 阻止默认的关闭行为
                        api.prevent_close();
                        // 隐藏窗口而非关闭
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
