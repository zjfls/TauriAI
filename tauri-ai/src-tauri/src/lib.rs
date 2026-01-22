// Module declarations
pub mod ai_client;
pub mod agents;
pub mod commands;
pub mod config;
pub mod errors;
pub mod models;
pub mod prompts;
pub mod runtime;
pub mod storage;
pub mod tray;
pub mod bundled_tools;

use std::sync::Arc;
use tokio::sync::Mutex;

use commands::{
    abort_run, create_conversation, delete_conversation, delete_messages_from,
    fetch_provider_models, generate_title, get_app_config, get_conversations, get_messages,
    read_local_file_base64, run_task, save_app_config, test_connection, update_conversation_metadata,
    update_conversation_title,
};
use runtime::RunState;
use config::ConfigManager;
use storage::Database;
use tauri::Manager;

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
        .plugin(tauri_plugin_opener::init())
        .manage(database)
        .manage(config_manager)
        .manage(run_state)
        .invoke_handler(tauri::generate_handler![
            // Runtime commands
            run_task,
            abort_run,
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
            // File commands (drag & drop paths -> data)
            read_local_file_base64,
        ])
        .setup(|app| {
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
