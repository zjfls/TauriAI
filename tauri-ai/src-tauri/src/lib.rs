// Module declarations
pub mod ai_client;
pub mod commands;
pub mod config;
pub mod errors;
pub mod models;
pub mod storage;
pub mod tray;

use std::sync::Arc;
use tokio::sync::Mutex;

use commands::{
    abort_chat, chat_stream, create_conversation, delete_conversation, get_app_config,
    get_conversations, get_messages, save_app_config, test_connection, update_conversation_title,
    ChatState,
};
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
    // Initialize database
    let db_path = get_database_path();
    let database = Database::new(db_path).expect("Failed to initialize database");
    let database = Arc::new(Mutex::new(database));

    // Initialize config manager
    let config_manager = ConfigManager::new().expect("Failed to initialize config manager");
    let config_manager = Arc::new(config_manager);

    // Initialize chat state
    let chat_state = Arc::new(ChatState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(database)
        .manage(config_manager)
        .manage(chat_state)
        .invoke_handler(tauri::generate_handler![
            // Chat commands
            chat_stream,
            abort_chat,
            // Conversation commands
            get_conversations,
            get_messages,
            create_conversation,
            delete_conversation,
            update_conversation_title,
            // Config commands
            get_app_config,
            save_app_config,
            test_connection,
        ])
        .setup(|app| {
            // 初始化系统托盘
            tray::create_tray(app.handle())?;

            // 设置窗口关闭事件处理
            // 满足需求 9.4: 点击关闭按钮时隐藏窗口而非退出
            if let Some(window) = app.get_webview_window("main") {
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
