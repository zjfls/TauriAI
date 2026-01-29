// Module declarations
pub mod ai_client;
pub mod agents;
pub mod commands;
pub mod config;
pub mod errors;
pub mod models;
pub mod prompts;
pub mod runtime;
pub mod skills;
pub mod storage;
pub mod tray;
pub mod bundled_tools;

use std::sync::Arc;
use tokio::sync::Mutex;

use commands::{
    abort_run, create_conversation, delete_conversation, delete_messages_from,
    fetch_provider_models, generate_title, get_app_config, get_conversations, get_messages,
    list_local_directory, read_local_file_base64, respond_approval, run_task, save_app_config, test_connection,
    delete_mcp_server, delete_mcp_set, list_mcp_server_tools, list_mcp_servers, list_mcp_sets,
    set_agent_mcp_set, test_mcp_server, upsert_mcp_server, upsert_mcp_set,
    list_skills, create_skill,
    get_format_prompt,
    update_conversation_metadata, write_local_text_file,
    update_conversation_title, list_pty_sessions, close_pty_session,
    ensure_workstudio_for_conversation, get_workstudio, add_workstudio_folder, create_workstudio,
    set_workstudio_main_folder, remove_workstudio_folder, workstudio_find_files,
    get_workstudio_ui_state, set_workstudio_ui_state,
    workstudio_terminal_close, workstudio_terminal_create, workstudio_terminal_read,
    workstudio_terminal_read_base64,
    workstudio_terminal_write,
};
use runtime::RunState;
use config::ConfigManager;
use storage::Database;
use tauri::{Emitter, Manager, Url};
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::WebviewUrl;
use skills::watcher::{SkillsWatcher, SkillsWatcherState};
use skills::installer::install_bundled_skills;

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

            let open_file = MenuItem::with_id(
                app,
                "open_file",
                "打开文件…",
                true,
                Some("CmdOrCtrl+O"),
            )?;

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
                let file = Submenu::with_items(app, "File", true, &[&new_richtxt, &open_file, &test_window])?;
                // On macOS, index 0 is the app menu. Insert after it.
                let pos = if cfg!(target_os = "macos") { 1 } else { 0 };
                menu.insert(&file, pos)?;
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
                "test_window" => {
                    // Create a standalone window for testing multi-window behavior.
                    // On Windows, window creation can deadlock inside event handlers; use a new thread.
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let label = format!(
                            "view-window-test-{}",
                            chrono::Utc::now().timestamp_millis()
                        );

                        let url = if cfg!(debug_assertions) {
                            handle
                                .config()
                                .build
                                .dev_url
                                .clone()
                                .and_then(|base| {
                                    let base = base.as_str().trim_end_matches('/').to_string();
                                    Url::parse(&format!(
                                        "{base}/?view=window_test&standalone=1"
                                    ))
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

                        let _ = tauri::WebviewWindowBuilder::new(
                            &handle,
                            label,
                            webview_url,
                        )
                        .title("Window Test")
                        .inner_size(1170.0, 910.0)
                        .build();
                    });
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
            // Workstudio state (UI persisted)
            get_workstudio_ui_state,
            set_workstudio_ui_state,
            // Conversation commands
            get_conversations,
            get_messages,
            create_conversation,
            delete_conversation,
            delete_messages_from,
            update_conversation_metadata,
            update_conversation_title,
            generate_title,
            // Config commands
            get_app_config,
            save_app_config,
            test_connection,
            fetch_provider_models,
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

            // 设置窗口关闭事件处理
            // 满足需求 9.4: 点击关闭按钮时隐藏窗口而非退出
            if let Some(window) = app.get_webview_window("main") {
                // 在开发模式下可通过通用设置 / 环境变量打开 DevTools（默认关闭）
                #[cfg(debug_assertions)]
                {
                    let env_override = std::env::var("TAURIAI_OPEN_DEVTOOLS")
                        .ok()
                        .and_then(|v| match v.trim().to_ascii_lowercase().as_str() {
                            "1" | "true" | "yes" | "on" => Some(true),
                            "0" | "false" | "no" | "off" => Some(false),
                            _ => None,
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
