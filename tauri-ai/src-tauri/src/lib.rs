// Module declarations
pub mod agents;
pub mod ai_client;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod bundled_tools;
pub mod commands;
pub mod config;
pub mod errors;
pub mod mentions;
pub mod models;
pub mod prompts;
pub mod runtime;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod skills;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod storage;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod tray;
pub mod workstudio_security;

use std::sync::Arc;

use config::ConfigManager;

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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn get_database_path() -> std::path::PathBuf {
    let home_dir = dirs::home_dir().expect("Failed to get home directory");
    home_dir.join(".tauri-ai").join("data.db")
}

#[cfg(all(debug_assertions, target_os = "windows"))]
fn schedule_set_dev_window_icons(app: &tauri::AppHandle) {
    use std::time::Duration;
    use tauri::Manager;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("icons-dev")
        .join("icon.png");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // dev 模式下可能会在 ready 后再次设置窗口图标；这里延迟覆盖一次，确保任务栏/Alt-Tab 用 DEV 图标。
        tokio::time::sleep(Duration::from_millis(450)).await;
        let handle2 = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let icon = match tauri::image::Image::from_path(&path) {
                Ok(i) => i.to_owned(),
                Err(_) => return,
            };
            for (_label, w) in handle2.webview_windows() {
                let _ = w.set_icon(icon.clone());
            }
        });
    });
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn build_desktop_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    config: &crate::models::AppConfig,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};

    // Start from Tauri's default menu (macOS has one by default).
    // Then inject our entries into File/View/Session submenus.
    let menu = Menu::default(app)?;

    // Prepare agent list for "新建会话（按 Agent）"
    let mut enabled_agents: Vec<_> = config.agents.iter().filter(|a| a.enabled).collect();
    let effective_default_agent = if !config.default_agent.is_empty() {
        config.default_agent.as_str()
    } else {
        enabled_agents
            .first()
            .map(|a| a.name.as_str())
            .unwrap_or_default()
    };
    if !config.default_agent.is_empty() {
        if let Some(pos) = enabled_agents
            .iter()
            .position(|a| a.name == config.default_agent)
        {
            let default_agent = enabled_agents.remove(pos);
            enabled_agents.insert(0, default_agent);
        }
    }
    let has_agents = !enabled_agents.is_empty();

    let open_file = MenuItem::with_id(app, "open_file", "打开文件…", true, Some("CmdOrCtrl+O"))?;

    let new_richtxt = MenuItem::with_id(
        app,
        "new_richtxt",
        "新建 .tauri.richtxt",
        true,
        Some("CmdOrCtrl+N"),
    )?;

    // Session/app actions (moved from top-right toolbar to system menu bar)
    // 只保留“按 Agent 新建会话”，并把快捷键绑定到默认 Agent 的菜单项。
    let new_session_by_agent: Submenu<R> = if has_agents {
        let mut items: Vec<MenuItem<R>> = Vec::new();
        for agent in &enabled_agents {
            let mut label = agent.display_name.clone();
            let is_default = agent.name == effective_default_agent;
            if is_default {
                label = format!("{label}（默认）");
            }
            let encoded = urlencoding::encode(&agent.name);
            let id = format!("new_session_agent:{encoded}");
            let accelerator = if is_default {
                Some("CmdOrCtrl+T")
            } else {
                None::<&str>
            };
            items.push(MenuItem::with_id(app, id, label, true, accelerator)?);
        }
        let item_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = items.iter().map(|i| i as _).collect();
        Submenu::with_items(app, "新建会话（按 Agent）", true, &item_refs)?
    } else {
        let empty =
            MenuItem::with_id(app, "new_session_agent_empty", "（未配置 Agent）", false, None::<&str>)?;
        Submenu::with_items(app, "新建会话（按 Agent）", false, &[&empty])?
    };

    let open_settings =
        MenuItem::with_id(app, "open_settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let view_settings_separator = PredefinedMenuItem::separator(app)?;

    let separator = PredefinedMenuItem::separator(app)?;
    let test_window = MenuItem::with_id(
        app,
        "test_window",
        "测试多窗口",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;

    // View: switch main content view (history, chat, etc.)
    let open_history_accelerator: Option<&str> = if cfg!(target_os = "macos") {
        Some("Cmd+Y")
    } else {
        Some("Ctrl+Shift+H")
    };
    let open_history =
        MenuItem::with_id(app, "open_history", "历史", true, open_history_accelerator)?;
    let session_history_separator = PredefinedMenuItem::separator(app)?;

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
    let open_devtools_accelerator: Option<&str> = if cfg!(target_os = "macos") {
        Some("Cmd+Alt+I")
    } else {
        Some("Ctrl+Shift+I")
    };
    #[cfg(debug_assertions)]
    let open_devtools = MenuItem::with_id(
        app,
        "open_devtools",
        "打开开发者工具",
        true,
        open_devtools_accelerator,
    )?;
    #[cfg(debug_assertions)]
    let unit_test_ghost = MenuItem::with_id(
        app,
        "unit_test_ghost",
        "单元测试：显示 Ghost 窗口",
        true,
        Some("CmdOrCtrl+Shift+G"),
    )?;

    // Find existing "File" submenu and insert at the top. If not found (e.g. Linux), create one.
    let mut file_submenu: Option<Submenu<R>> = None;
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
        let file = Submenu::with_items(app, "File", true, &[&new_richtxt, &open_file, &test_window])?;
        // On macOS, index 0 is the app menu. Insert after it.
        let pos = if cfg!(target_os = "macos") { 1 } else { 0 };
        menu.insert(&file, pos)?;
    }

    // Find existing "View" submenu and insert our actions at the top. If not found, create one.
    let mut view_submenu: Option<Submenu<R>> = None;
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
        view.insert_items(
            &[
                &open_settings,
                &view_settings_separator,
                &open_web_tab,
                &open_terminal_tab,
                &view_separator,
            ],
            0,
        )?;
    } else {
        #[cfg(debug_assertions)]
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &open_settings,
                &view_settings_separator,
                &open_web_tab,
                &open_terminal_tab,
                &view_separator,
                &unit_test_ghost,
                &open_devtools,
            ],
        )?;
        #[cfg(not(debug_assertions))]
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &open_settings,
                &view_settings_separator,
                &open_web_tab,
                &open_terminal_tab,
            ],
        )?;
        // Insert after File submenu (best-effort). On macOS index 0 is app menu.
        let pos = if cfg!(target_os = "macos") { 2 } else { 1 };
        menu.insert(&view, pos)?;
    }

    // Find existing "Session" submenu (if any) and insert our actions; otherwise create one.
    let mut session_submenu: Option<Submenu<R>> = None;
    for item in menu.items().unwrap_or_default() {
        if let MenuItemKind::Submenu(submenu) = item {
            if let Ok(text) = submenu.text() {
                if text == "Session" || text == "会话" {
                    session_submenu = Some(submenu);
                    break;
                }
            }
        }
    }

    if let Some(session) = session_submenu {
        session.insert_items(&[&open_history, &session_history_separator, &new_session_by_agent], 0)?;
    } else {
        let session = Submenu::with_items(
            app,
            "会话",
            true,
            &[&open_history, &session_history_separator, &new_session_by_agent],
        )?;
        // Insert after View submenu. On macOS index 0 is the app menu.
        let pos = if cfg!(target_os = "macos") { 3 } else { 2 };
        menu.insert(&session, pos)?;
    }

    Ok(menu)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn run_desktop() {
    use crate::commands::*;
    use crate::runtime::RunState;
    use crate::skills::installer::install_bundled_skills;
    use crate::skills::watcher::{SkillsWatcher, SkillsWatcherState};
    use crate::storage::Database;
    use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl};
    use tokio::sync::Mutex;

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
	    let config_manager_for_menu = config_manager.clone();

	    tauri::Builder::default()
	        .menu(move |app| {
	            let config = config_manager_for_menu.ensure_default().unwrap_or_default();
	            build_desktop_menu(app, &config)
	        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open_settings" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("menu:open_settings", ());
                    } else {
	                        let _ = app.emit("menu:open_settings", ());
	                    }
	                }
	                "open_history" => {
	                    if let Some(window) = app.get_webview_window("main") {
	                        let _ = window.emit("menu:open_history", ());
	                    } else {
	                        let _ = app.emit("menu:open_history", ());
	                    }
	                }
	                id if id.starts_with("new_session_agent:") => {
	                    let raw = id.trim_start_matches("new_session_agent:");
	                    let agent_name = urlencoding::decode(raw)
	                        .map(|s| s.into_owned())
	                        .unwrap_or_else(|_| raw.to_string());
	                    if let Some(window) = app.get_webview_window("main") {
	                        let _ = window.emit("menu:new_session_agent", agent_name);
	                    } else {
	                        let _ = app.emit("menu:new_session_agent", agent_name);
	                    }
	                }
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
                        // 在 menu handler 外创建，再切回主线程真正 build（对齐 tao/wry 的线程模型）。
                        let handle2 = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            let label = format!(
                                "view-window-test-{}",
                                chrono::Utc::now().timestamp_millis()
                            );

                            // Build 下不要把 query 拼进 `WebviewUrl::App("index.html?...")`，否则会导致 asset 查找失败/白屏。
                            // 改为 App(index.html) + initialization_script 注入参数给前端读取。
                            let injected = r#"window.__TAURIAI_VIEW_PARAMS__={"view":"window_test","standalone":true};"#;

                            let (webview_url, init_script) = if cfg!(debug_assertions) {
                                match handle2
                                    .config()
                                    .build
                                    .dev_url
                                    .clone()
                                    .and_then(|base| {
                                        let base =
                                            base.as_str().trim_end_matches('/').to_string();
                                        Url::parse(&format!("{base}/?view=window_test&standalone=1"))
                                            .ok()
                                    })
                                    .map(WebviewUrl::External)
                                {
                                    Some(url) => (url, None::<String>),
                                    None => (WebviewUrl::App("index.html".into()), Some(injected.to_string())),
                                }
                            } else {
                                (WebviewUrl::App("index.html".into()), Some(injected.to_string()))
                            };

                            let mut builder =
                                tauri::WebviewWindowBuilder::new(&handle2, label, webview_url)
                                    .title("Window Test")
                                    .inner_size(1170.0, 910.0);
                            if let Some(init_script) = init_script {
                                builder = builder.initialization_script(&init_script);
                            }
                            let _ = builder.build();
                        });
                    });
                }
                "unit_test_ghost" => {
                    // Debug-only: create (or reuse) exactly one ghost window and center it in main window.
                    #[cfg(debug_assertions)]
                    {
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            let handle2 = handle.clone();
                            let _ = handle.run_on_main_thread(move || {
                            const GHOST_LABEL: &str = "__tauriai_ghost__main";

                            #[derive(Clone, serde::Serialize)]
                            struct DragGhostUpdatePayload {
                                title: String,
                            }

                            let main = match handle2.get_webview_window("main") {
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
                            if let Some(ghost) = handle2.get_webview_window(GHOST_LABEL) {
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

                            let webview_url = if cfg!(debug_assertions) {
                                handle2
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
                                    .map(WebviewUrl::External)
                                    .unwrap_or_else(|| {
                                        WebviewUrl::App("index.html".into())
                                    })
                            } else {
                                WebviewUrl::App("index.html".into())
                            };

                            let builder = tauri::WebviewWindowBuilder::new(
                                &handle2,
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
	            drag_ghost_follow_start,
	            drag_ghost_follow_stop,
	            drag_ghost_move,
	            drag_ghost_move_client,
	            // Backward compatibility (old command names)
	            debug_drag_ghost_create,
	            debug_drag_ghost_destroy,
	            debug_drag_ghost_move,
	            // Window control
	            close_invoking_window,
	            hide_invoking_window,
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
            warmup_mcp_servers,
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

            // 预创建单例 Ghost 窗口（避免运行期 `builder.build()` 偶发卡死导致“窗口创建了但没内容/卡住”）。
            // 运行期只做 show/move/update，不再动态创建。
            {
                let handle = app.handle().clone();
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    const GHOST_LABEL: &str = "__tauriai_ghost__global";
                    if handle2.get_webview_window(GHOST_LABEL).is_some() {
                        return;
                    }

                    // Build 下不要依赖 query；ghost 视图由 label 前缀识别。
                    let webview_url = if cfg!(debug_assertions) {
                        handle2
                            .config()
                            .build
                            .dev_url
                            .clone()
                            .and_then(|base| {
                                let base = base.as_str().trim_end_matches('/').to_string();
                                Url::parse(&format!("{base}/?view=drag-ghost&standalone=1")).ok()
                            })
                            .map(WebviewUrl::External)
                            .unwrap_or_else(|| WebviewUrl::App("index.html".into()))
                    } else {
                        WebviewUrl::App("index.html".into())
                    };

                    println!("[ghost][precreate] start label={}", GHOST_LABEL);
                    match tauri::WebviewWindowBuilder::new(&handle2, GHOST_LABEL, webview_url)
                        .title("[GHOST] precreated")
                        .decorations(false)
                        .always_on_top(true)
                        .skip_taskbar(true)
                        .resizable(false)
                        .visible(false)
                        .focused(false)
                        .focusable(false)
                        .build()
                    {
                        Ok(w) => {
                            let _ = w.set_ignore_cursor_events(true);
                            println!("[ghost][precreate] ok label={}", GHOST_LABEL);
                        }
                        Err(e) => {
                            println!("[ghost][precreate] err label={} err={}", GHOST_LABEL, e);
                        }
                    }
                });
            }

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

            // DEV: Windows 下确保窗口图标（任务栏/Alt-Tab）使用 DEV 图标，而不是默认绿图标。
            #[cfg(all(debug_assertions, target_os = "windows"))]
            schedule_set_dev_window_icons(app.handle());

            // Main 窗口初始化（图标 / DevTools 等）
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
            }

            Ok(())
        })
        // 点击主窗口 close(X) 时只隐藏到托盘，不真正退出/销毁资源；可快速恢复。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn run_mobile() {
    use crate::commands::{
        fetch_provider_models, get_app_config, mobile_chat, mobile_chat_stream_cancel,
        mobile_chat_stream_start, save_app_config, test_connection,
    };
    use tauri::Manager;

    println!("[Backend] TauriAI starting... (mobile)");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            save_app_config,
            test_connection,
            fetch_provider_models,
            mobile_chat,
            mobile_chat_stream_start,
            mobile_chat_stream_cancel,
        ])
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("config.json");
            app.manage(Arc::new(ConfigManager::with_path(config_path)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg_attr(any(target_os = "android", target_os = "ios"), tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    run_desktop();

    #[cfg(any(target_os = "android", target_os = "ios"))]
    run_mobile();
}
