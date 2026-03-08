// Module declarations
pub mod agents;
pub mod ai_client;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod bundled_tools;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod cli;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod code_intel;
pub mod commands;
pub mod config;
pub mod errors;
pub mod external_agents;
pub mod git_tools;
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{Emitter, Manager};

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

    fn configured_shortcut<'a>(
        config: &'a crate::models::AppConfig,
        action_id: &str,
        default_mac: &'a str,
        default_windows: &'a str,
    ) -> Option<String> {
        let platform_map = if cfg!(target_os = "macos") {
            &config.general.keyboard_shortcuts.mac
        } else {
            &config.general.keyboard_shortcuts.windows
        };
        let raw = platform_map
            .get(action_id)
            .map(String::as_str)
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    default_mac
                } else {
                    default_windows
                }
            })
            .trim();

        if raw.is_empty() {
            return None;
        }

        normalize_menu_accelerator(raw)
    }

    fn normalize_menu_accelerator(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut mods: Vec<&'static str> = Vec::new();
        let mut key = String::new();
        for part in trimmed.split('+').map(str::trim).filter(|p| !p.is_empty()) {
            match part.to_ascii_lowercase().as_str() {
                "cmd" | "command" | "meta" | "super" | "⌘" => mods.push("Cmd"),
                "ctrl" | "control" | "⌃" => mods.push("Ctrl"),
                "cmdorctrl" | "cmdorcontrol" | "commandorcontrol" | "commandorctrl" => {
                    mods.push("CmdOrCtrl")
                }
                "alt" | "option" | "opt" | "⌥" => mods.push("Alt"),
                "shift" | "⇧" => mods.push("Shift"),
                "esc" | "escape" => key = "Escape".to_string(),
                "return" | "enter" => key = "Enter".to_string(),
                "space" | "spacebar" => key = "Space".to_string(),
                "backspace" => key = "Backspace".to_string(),
                "delete" | "del" => key = "Delete".to_string(),
                "left" => key = "Left".to_string(),
                "right" => key = "Right".to_string(),
                "up" => key = "Up".to_string(),
                "down" => key = "Down".to_string(),
                "comma" => key = ",".to_string(),
                "period" => key = ".".to_string(),
                "minus" | "_" | "–" | "－" => key = "-".to_string(),
                "equal" => key = "=".to_string(),
                _ => key = part.to_string().replace("Option", "Alt"),
            }
        }

        if key.is_empty() {
            return None;
        }

        let mut normalized_parts: Vec<String> = Vec::new();
        let has_cmd_or_ctrl = mods.iter().any(|m| *m == "CmdOrCtrl");
        let has_cmd = mods.iter().any(|m| *m == "Cmd");
        let has_ctrl = mods.iter().any(|m| *m == "Ctrl");
        if has_cmd_or_ctrl {
            normalized_parts.push("CmdOrCtrl".to_string());
        } else {
            if has_cmd {
                normalized_parts.push("Cmd".to_string());
            }
            if has_ctrl {
                normalized_parts.push("Ctrl".to_string());
            }
        }
        if mods.iter().any(|m| *m == "Alt") {
            normalized_parts.push("Alt".to_string());
        }
        if mods.iter().any(|m| *m == "Shift") {
            normalized_parts.push("Shift".to_string());
        }
        normalized_parts.push(key);

        let candidate = normalized_parts.join("+");
        if muda::accelerator::Accelerator::from_str(&candidate).is_ok() {
            Some(candidate)
        } else {
            None
        }
    }

    // Start from Tauri's default menu (macOS has one by default).
    // Then inject our entries into File/View/Session submenus.
    let menu = Menu::default(app)?;

    // Prepare agent list for "新建会话（按 Agent）"
    // Exclude Workstudio/Workspace AI agents from main window "new conversation" menu.
    let mut enabled_agents: Vec<_> = config
        .agents
        .iter()
        .filter(|a| a.enabled && !a.is_practice() && a.workstudio_enabled != Some(true))
        .collect();
    // If configured default agent is missing/disabled, fall back to the first enabled agent.
    // Otherwise Ctrl/Cmd+T may not be bound to any menu item, making it look "not working".
    let configured_default = config.default_agent.trim();
    let default_exists = !configured_default.is_empty()
        && enabled_agents.iter().any(|a| a.name == configured_default);
    let effective_default_agent = if default_exists {
        if let Some(pos) = enabled_agents
            .iter()
            .position(|a| a.name == configured_default)
        {
            let default_agent = enabled_agents.remove(pos);
            enabled_agents.insert(0, default_agent);
        }
        configured_default
    } else {
        enabled_agents
            .first()
            .map(|a| a.name.as_str())
            .unwrap_or_default()
    };
    let has_agents = !enabled_agents.is_empty();

    let open_file = MenuItem::with_id(app, "open_file", "打开文件…", true, Some("CmdOrCtrl+O"))?;

    let new_richtxt = MenuItem::with_id(
        app,
        "new_richtxt",
        "新建 .tauri.richtxt",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_text = MenuItem::with_id(app, "new_text", "新建文本文件", true, None::<&str>)?;

    let new_json_analyzer = MenuItem::with_id(
        app,
        "new_json_analyzer",
        "新建 JSON 分析窗口",
        true,
        None::<&str>,
    )?;

    // Session/app actions (moved from top-right toolbar to system menu bar)
    // 只保留“按 Agent 新建会话”，并把快捷键绑定到默认 Agent 的菜单项。
    let new_session_shortcut = configured_shortcut(config, "session.new", "Cmd+T", "Ctrl+T");
    let open_agent_workspace_shortcut = configured_shortcut(
        config,
        "app.openAgentWorkspace",
        "Cmd+Shift+J",
        "Ctrl+Shift+J",
    );
    let open_settings_shortcut = configured_shortcut(config, "app.openSettings", "Cmd+,", "Ctrl+,");
    let open_history_shortcut =
        configured_shortcut(config, "app.openHistory", "Cmd+Y", "Ctrl+Shift+H");
    let open_devtools_shortcut =
        configured_shortcut(config, "app.openDevtools", "Cmd+Option+I", "Ctrl+Shift+I");

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
                new_session_shortcut.as_deref()
            } else {
                None::<&str>
            };
            items.push(MenuItem::with_id(app, id, label, true, accelerator)?);
        }
        let item_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            items.iter().map(|i| i as _).collect();
        Submenu::with_items(app, "新建会话（按 Agent）", true, &item_refs)?
    } else {
        let empty = MenuItem::with_id(
            app,
            "new_session_agent_empty",
            "（未配置 Agent）",
            false,
            None::<&str>,
        )?;
        Submenu::with_items(app, "新建会话（按 Agent）", false, &[&empty])?
    };

    let open_settings = MenuItem::with_id(
        app,
        "open_settings",
        "设置…",
        true,
        open_settings_shortcut.as_deref(),
    )?;
    let open_agent_workspace = MenuItem::with_id(
        app,
        "open_agent_workspace",
        "子 Agent 工作台",
        true,
        open_agent_workspace_shortcut.as_deref(),
    )?;
    let open_practice = MenuItem::with_id(app, "open_practice", "练习", true, None::<&str>)?;
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
    let open_history = MenuItem::with_id(
        app,
        "open_history",
        "历史",
        true,
        open_history_shortcut.as_deref(),
    )?;
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
    let open_devtools = MenuItem::with_id(
        app,
        "open_devtools",
        "打开开发者工具",
        true,
        open_devtools_shortcut.as_deref(),
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
        file.insert_items(
            &[
                &new_richtxt,
                &new_text,
                &new_json_analyzer,
                &open_file,
                &test_window,
                &separator,
            ],
            0,
        )?;
    } else {
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &new_richtxt,
                &new_text,
                &new_json_analyzer,
                &open_file,
                &test_window,
            ],
        )?;
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
        view.insert_items(&[&open_devtools], 0)?;
        view.insert_items(
            &[
                &open_agent_workspace,
                &open_practice,
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
                &open_agent_workspace,
                &open_practice,
                &open_settings,
                &view_settings_separator,
                &open_web_tab,
                &open_terminal_tab,
                &view_separator,
                &open_devtools,
            ],
        )?;
        #[cfg(not(debug_assertions))]
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &open_agent_workspace,
                &open_practice,
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
        session.insert_items(
            &[
                &open_history,
                &session_history_separator,
                &new_session_by_agent,
            ],
            0,
        )?;
    } else {
        let session = Submenu::with_items(
            app,
            "会话",
            true,
            &[
                &open_history,
                &session_history_separator,
                &new_session_by_agent,
            ],
        )?;
        // Insert after View submenu. On macOS index 0 is the app menu.
        let pos = if cfg!(target_os = "macos") { 3 } else { 2 };
        menu.insert(&session, pos)?;
    }

    Ok(menu)
}

/// Desktop native menu can "blink" on Windows when repeatedly calling `app.set_menu(...)`.
/// To avoid this, we keep a lightweight signature and only rebuild/apply when menu-relevant
/// config changes (currently: enabled agents + default agent).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Default)]
pub(crate) struct DesktopMenuSyncState(pub(crate) std::sync::Mutex<Option<String>>);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Debug, Default)]
struct WindowInteractionRouteEntry {
    kind: String,
    _last_pane_id: Option<String>,
    _last_chat_pane_id: Option<String>,
    updated_at_ms: u128,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Debug, Default)]
struct WindowInteractionRouteSnapshot {
    last_window_label: Option<String>,
    last_chat_window_label: Option<String>,
    last_main_host_window_label: Option<String>,
    last_workstudio_window_label: Option<String>,
    windows: HashMap<String, WindowInteractionRouteEntry>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl WindowInteractionRouteSnapshot {
    fn latest_window_label(&self) -> Option<String> {
        self.windows
            .iter()
            .max_by_key(|(_, entry)| entry.updated_at_ms)
            .map(|(label, _)| label.clone())
    }

    fn latest_window_label_for_kind(&self, kind: &str) -> Option<String> {
        self.windows
            .iter()
            .filter(|(_, entry)| entry.kind == kind)
            .max_by_key(|(_, entry)| entry.updated_at_ms)
            .map(|(label, _)| label.clone())
    }

    fn recompute(&mut self) {
        self.last_window_label = self.latest_window_label();
        self.last_chat_window_label = self.latest_window_label_for_kind("chat");
        self.last_main_host_window_label = self
            .windows
            .iter()
            .filter(|(label, _)| is_main_host_window_label(label))
            .max_by_key(|(_, entry)| entry.updated_at_ms)
            .map(|(label, _)| label.clone());
        self.last_workstudio_window_label = self.latest_window_label_for_kind("workstudio");
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Default)]
pub(crate) struct WindowInteractionRouteState(
    pub(crate) std::sync::Mutex<WindowInteractionRouteSnapshot>,
);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn window_interaction_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn normalize_window_interaction_value(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_ignored_window_label(label: &str) -> bool {
    label.starts_with("__tauriai_ghost__") || label.starts_with("view-json_analyzer")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_chat_window_label(label: &str) -> bool {
    (label == "main" || label.starts_with("view-chat-") || label.starts_with("workspace-"))
        && !is_ignored_window_label(label)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_main_host_window_label(label: &str) -> bool {
    !is_ignored_window_label(label) && (label == "main" || label.starts_with("workspace-"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_workstudio_window_label(label: &str) -> bool {
    (label.starts_with("view-workstudio-") || label.starts_with("view-workstudio-dir-"))
        && !is_ignored_window_label(label)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_chat_menu_target_label(label: &str) -> bool {
    !is_ignored_window_label(label) && !label.starts_with("view-workstudio")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_main_host_menu_action(action_id: &str) -> bool {
    action_id.starts_with("new_session_agent:")
        || matches!(
            action_id,
            "open_agent_workspace" | "open_settings" | "open_history" | "open_practice"
        )
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn preferred_menu_target_label(
    action_id: &str,
    snapshot: &WindowInteractionRouteSnapshot,
) -> Option<String> {
    if is_main_host_menu_action(action_id) {
        snapshot
            .last_main_host_window_label
            .clone()
            .or_else(|| snapshot.last_chat_window_label.clone())
            .or_else(|| snapshot.last_window_label.clone())
    } else {
        snapshot.last_window_label.clone()
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn menu_target_allowed(action_id: &str, label: &str) -> bool {
    if is_main_host_menu_action(action_id) {
        return is_main_host_window_label(label);
    }
    if is_chat_menu_target_label(label) {
        return true;
    }
    !is_ignored_window_label(label)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn pick_routed_menu_target<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action_id: &str,
) -> Option<tauri::WebviewWindow<R>> {
    if let Some(state) = app.try_state::<WindowInteractionRouteState>() {
        if let Ok(snapshot) = state.0.lock() {
            if let Some(label) = preferred_menu_target_label(action_id, &snapshot) {
                if menu_target_allowed(action_id, &label) {
                    if let Some(window) = app.get_webview_window(&label) {
                        return Some(window);
                    }
                }
            }
        }
    }

    if let Some(window) = app.webview_windows().into_values().find(|window| {
        window.is_focused().unwrap_or(false) && menu_target_allowed(action_id, window.label())
    }) {
        return Some(window);
    }

    if menu_target_allowed(action_id, "main") {
        return app.get_webview_window("main");
    }

    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn pick_focused_or_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn emit_webview_window_event<R, S>(app: &tauri::AppHandle<R>, label: &str, event: &str, payload: S)
where
    R: tauri::Runtime,
    S: serde::Serialize + Clone,
{
    let _ = app.emit_to(tauri::EventTarget::webview_window(label), event, payload);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn record_window_interaction(
    state: tauri::State<'_, WindowInteractionRouteState>,
    label: String,
    kind: String,
    pane_id: Option<String>,
    chat_pane_id: Option<String>,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() || is_ignored_window_label(&label) {
        return Ok(());
    }

    let normalized_kind = match kind.trim().to_ascii_lowercase().as_str() {
        "chat" | "workstudio" => kind.trim().to_ascii_lowercase(),
        _ if is_chat_window_label(&label) => "chat".to_string(),
        _ if is_workstudio_window_label(&label) => "workstudio".to_string(),
        _ => "other".to_string(),
    };

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "window interaction state poisoned".to_string())?;

    guard.windows.insert(
        label.clone(),
        WindowInteractionRouteEntry {
            kind: normalized_kind.clone(),
            _last_pane_id: normalize_window_interaction_value(pane_id),
            _last_chat_pane_id: normalize_window_interaction_value(chat_pane_id),
            updated_at_ms: window_interaction_now_ms(),
        },
    );
    guard.last_window_label = Some(label.clone());
    if normalized_kind == "chat" {
        guard.last_chat_window_label = Some(label.clone());
    }
    if is_main_host_window_label(&label) {
        guard.last_main_host_window_label = Some(label.clone());
    }
    if normalized_kind == "workstudio" {
        guard.last_workstudio_window_label = Some(label);
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn clear_window_interaction(
    state: tauri::State<'_, WindowInteractionRouteState>,
    label: String,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Ok(());
    }

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "window interaction state poisoned".to_string())?;
    guard.windows.remove(&label);
    guard.recompute();
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn desktop_menu_signature(config: &crate::models::AppConfig) -> String {
    // Keep in sync with the behavior of `build_desktop_menu`:
    // - enabled non-workstudio agents only
    // - default agent (or first enabled fallback)
    // - default agent moved to the top
    let mut enabled_agents: Vec<_> = config
        .agents
        .iter()
        .filter(|a| a.enabled && a.workstudio_enabled != Some(true))
        .collect();

    let configured_default = config.default_agent.trim();
    let default_exists = !configured_default.is_empty()
        && enabled_agents.iter().any(|a| a.name == configured_default);
    let effective_default_agent = if default_exists {
        configured_default
    } else {
        enabled_agents
            .first()
            .map(|a| a.name.as_str())
            .unwrap_or_default()
    };

    if !effective_default_agent.is_empty() {
        if let Some(pos) = enabled_agents
            .iter()
            .position(|a| a.name == effective_default_agent)
        {
            if pos != 0 {
                let default_agent = enabled_agents.remove(pos);
                enabled_agents.insert(0, default_agent);
            }
        }
    }

    let shortcut_platform_map = if cfg!(target_os = "macos") {
        &config.general.keyboard_shortcuts.mac
    } else {
        &config.general.keyboard_shortcuts.windows
    };

    let mut sig = String::from("v3|default=");
    sig.push_str(effective_default_agent);
    sig.push('|');
    for key in [
        "session.new",
        "app.openAgentWorkspace",
        "app.openSettings",
        "app.openHistory",
        "app.openDevtools",
    ] {
        sig.push_str(key);
        sig.push('=');
        if let Some(value) = shortcut_platform_map.get(key) {
            sig.push_str(value);
        }
        sig.push(';');
    }
    sig.push('|');
    for a in enabled_agents {
        sig.push_str(&a.name);
        sig.push('=');
        sig.push_str(&a.display_name);
        sig.push(';');
    }
    sig
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn run_desktop() {
    use crate::commands::*;
    use crate::runtime::RunState;
    use crate::skills::installer::install_bundled_skills;
    use crate::skills::watcher::{SkillsWatcher, SkillsWatcherState};
    use crate::storage::Database;
    use tauri::{Emitter, Manager, Url, WebviewUrl};
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
            let pick_menu_target = |action_id: &str| pick_routed_menu_target(app, action_id);

            match event.id().as_ref() {
                "open_settings" => {
                    if let Some(window) = pick_menu_target("open_settings") {
                        let label = window.label().to_string();
                        println!(
                            "[Shortcut][menu] open_settings triggered; target_window={}",
                            label
                        );
                        emit_webview_window_event(app, &label, "menu:open_settings", ());
                    } else {
                        println!("[Shortcut][menu] open_settings triggered; target_window=<none>");
                    }
                }
                "open_agent_workspace" => {
                    if let Some(window) = pick_menu_target("open_agent_workspace") {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:open_agent_workspace",
                            (),
                        );
                    }
                }
                "open_practice" => {
                    if let Some(window) = pick_menu_target("open_practice") {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:open_practice",
                            (),
                        );
                    }
                }
                "open_history" => {
                    if let Some(window) = pick_menu_target("open_history") {
                        emit_webview_window_event(app, window.label(), "menu:open_history", ());
                    }
                }
                id if id.starts_with("new_session_agent:") => {
                    let raw = id.trim_start_matches("new_session_agent:");
                    let agent_name = urlencoding::decode(raw)
                        .map(|s| s.into_owned())
                        .unwrap_or_else(|_| raw.to_string());
                    if let Some(window) = pick_menu_target(id) {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:new_session_agent",
                            agent_name,
                        );
                    }
                }
                "new_richtxt" => {
                    // Send event to create a new .tauri.richtxt file
                    if let Some(window) = pick_focused_or_main_window(app) {
                        emit_webview_window_event(app, window.label(), "menu:new_richtxt", ());
                    }
                }
                "new_text" => {
                    // Send event to create a new plain text file
                    if let Some(window) = pick_focused_or_main_window(app) {
                        emit_webview_window_event(app, window.label(), "menu:new_text", ());
                    }
                }
                "new_json_analyzer" => {
                    // Send event to create a new JSON analyzer window (handled by frontend).
                    // 只发送给聚焦窗口（fallback 到 main），避免 app.emit 广播导致多窗口同时打开。
                    if let Some(window) = pick_focused_or_main_window(app) {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:new_json_analyzer",
                            (),
                        );
                    }
                }
                "open_file" => {
                    // Send the event only to the focused window (fall back to main).
                    if let Some(window) = pick_focused_or_main_window(app) {
                        emit_webview_window_event(app, window.label(), "menu:open_file", ());
                    }
                }
                "open_web_tab" => {
                    if let Some(window) = pick_focused_or_main_window(app) {
                        emit_webview_window_event(app, window.label(), "menu:open_web_tab", ());
                    }
                }
                "open_terminal_tab" => {
                    if let Some(window) = pick_focused_or_main_window(app) {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:open_terminal_tab",
                            (),
                        );
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
                _ => {}
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(database)
        .manage(config_manager)
        .manage(run_state)
        .manage(DesktopMenuSyncState::default())
        .manage(WindowInteractionRouteState::default())
        .invoke_handler(tauri::generate_handler![
            // Runtime commands
            run_task,
            retry_turn,
            abort_run,
            respond_approval,
            list_pty_sessions,
            close_pty_session,
            list_agent_sessions,
            get_agent_session_detail,
            start_agent_session,
            send_agent_session_message,
            close_agent_session,
            // Workstudio commands
            ensure_workstudio_for_conversation,
            get_workstudio,
            add_workstudio_folder,
            create_workstudio,
            set_workstudio_main_folder,
            remove_workstudio_folder,
            resolve_workstudio_file_target,
            workstudio_find_files,
            workstudio_main_folder_has_real_content,
            workstudio_fs_sync_watch,
            workstudio_fs_unwatch,
            get_local_file_snapshots,
            // Code intelligence (LSP)
            lsp_ensure_server,
            lsp_notify,
            lsp_request,
            lsp_shutdown_workstudio,
            lsp_shutdown_language,
            lsp_status,
            lsp_detect_server,
            // Code intelligence (AST)
            ast_document_symbols,
            // Code index (workstudio-scoped persisted cache)
            code_index_request_document_symbols,
            code_index_search_workspace_symbols,
            code_index_start_workspace_scan,
            code_index_status,
            code_index_summary,
            // AI code completion / Chat with index
            ai_code_completion,
            upsert_workstudio_chat_with_index,
            find_workstudio_chat_with_thread,
            save_workstudio_chat_with_thread,
            get_workstudio_chat_with_scope_for_conversation,
            get_workstudio_chat_with_thread_by_conversation,
            touch_workstudio_chat_with_thread_for_conversation,
            ai_analyze_workstudio_symbol,
            get_workstudio_symbol_analysis,
            list_workstudio_symbol_analysis_keys_for_file,
            list_workstudio_symbol_analysis_summaries_for_file,
            delete_workstudio_symbol_analysis,
            save_workstudio_symbol_analysis,
            get_workstudio_folder_analysis,
            list_workstudio_folder_analysis_summaries,
            delete_workstudio_folder_analysis,
            save_workstudio_folder_analysis,
            list_workstudio_chat_with_records_for_file,
            list_workstudio_chat_with_threads_for_file,
            list_workstudio_chat_with_file_summaries,
            delete_workstudio_chat_with_record,
            delete_workstudio_chat_with_records_for_file,
            delete_workstudio_chat_with_thread,
            // Workstudio terminal (UI)
            workstudio_terminal_create,
            workstudio_terminal_write,
            workstudio_terminal_resize,
	            workstudio_terminal_read,
	            workstudio_terminal_read_base64,
	            workstudio_terminal_close,
            // Unified terminal (UI)
            terminal_create,
            terminal_write,
            terminal_resize,
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
            get_db_lock_snapshot,
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
            probe_external_agents,
            // Lightweight LLM calls (used by practice module)
            mobile_chat,
            mobile_generate_title,
            practice_chat,
            practice_generate_title,
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
            get_window_layout_state,
            upsert_window_layout_record,
            remove_window_layout_record,
            record_window_interaction,
            clear_window_interaction,
            // MCP commands
            list_mcp_servers,
            list_mcp_sets,
            list_mcp_server_tools,
            list_mcp_server_resources,
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
            get_system_prompt,
            render_skills_section,
            // Git tools (diff/undo for apply_patch)
            git_diff_commits,
            git_diff_ghost_worktree,
            git_get_current_branch,
            git_list_local_branches,
            git_checkout_branch,
            git_create_and_checkout_branch,
            undo_apply_patch,
            // Mermaid SVG cache (disk)
            get_mermaid_svg_cache,
            set_mermaid_svg_cache,
            // File commands (drag & drop paths -> data)
            read_local_file_base64,
            list_local_directory,
            write_local_text_file,
            delete_local_path,
        ])
        .setup(|app| {
            // Initialize desktop menu signature so that subsequent `save_app_config` calls
            // don't repeatedly rebuild native menus (notably causing flicker on Windows).
            if let Some(state) = app.try_state::<DesktopMenuSyncState>() {
                let config = app
                    .state::<Arc<ConfigManager>>()
                    .ensure_default()
                    .unwrap_or_default();
                let sig = desktop_menu_signature(&config);
                let mut guard = state.0.lock().unwrap();
                *guard = Some(sig);
            }

            // Skills watcher for realtime refresh
            app.manage(SkillsWatcherState(SkillsWatcher::new(app.handle().clone())));

            // Workstudio file watcher for external disk changes
            app.manage(WorkstudioFsWatcherState(WorkstudioFsWatcher::new(
                app.handle().clone(),
            )));

            // Code intelligence: LSP manager (stdio JSON-RPC)
            app.manage(Arc::new(crate::code_intel::lsp::LspManager::new(
                app.handle().clone(),
            )));

            // Code index: workstudio-scoped persisted cache (separate DB files; not the main data.db)
            // - 主要用于：符号/Outline 等“可重建的索引结果”落盘缓存
            // - 目标：重启后可快速恢复展示，后台再增量更新
            if let Some(home) = dirs::home_dir() {
                let index_root = home.join(".tauri-ai").join("code-index");
                if let Some(db) = app.try_state::<Arc<Mutex<Database>>>() {
                    app.manage(crate::code_intel::index_manager::CodeIndexManager::new(
                        app.handle().clone(),
                        index_root,
                        db.inner().clone(),
                    ));
                }
            }

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
            if let Some(_window) = app.get_webview_window("main") {
                // DEV: 让任务栏/Alt-Tab/窗口图标与托盘一致（使用 `src-tauri/icons-dev/icon.png`）。
                #[cfg(all(debug_assertions, target_os = "windows"))]
                {
                    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("icons-dev")
                        .join("icon.png");
                    if let Ok(icon) = tauri::image::Image::from_path(&path) {
                        let _ = _window.set_icon(icon.to_owned());
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
                        _window.open_devtools();
                    }
                }
            }

            Ok(())
        })
        // 窗口几何与关闭状态由 Rust 统一持久化，避免 macOS 上前端 close/exit 时序不稳定。
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                schedule_persist_window_layout_snapshot(window.app_handle().clone(), window.label().to_string(), 220);
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = tauri::async_runtime::block_on(persist_window_layout_snapshot_now(&window.app_handle(), window.label()));
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                schedule_remove_window_layout_record_if_still_closed(
                    window.app_handle().clone(),
                    window.label().to_string(),
                    2_000,
                );
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    let _ = tauri::async_runtime::block_on(persist_all_open_window_layouts_now(app));
                    let _ = app.emit("app:closing", ());
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
                _ => {}
            }
        });
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn run_mobile() {
    use crate::commands::{
        // MCP commands (mobile)
        delete_mcp_server,
        delete_mcp_set,
        fetch_provider_models,
        get_app_config,
        list_mcp_server_resources,
        list_mcp_server_tools,
        list_mcp_servers,
        list_mcp_sets,
        mobile_chat,
        mobile_chat_stream_cancel,
        mobile_chat_stream_start,
        mobile_generate_title,
        practice_chat,
        practice_generate_title,
        probe_external_agents,
        save_app_config,
        set_agent_mcp_set,
        test_connection,
        test_mcp_server,
        upsert_mcp_server,
        upsert_mcp_set,
        warmup_mcp_servers,
    };
    use tauri::Manager;

    println!("[Backend] TauriAI starting... (mobile)");

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            save_app_config,
            test_connection,
            fetch_provider_models,
            probe_external_agents,
            mobile_chat,
            mobile_generate_title,
            practice_chat,
            practice_generate_title,
            mobile_chat_stream_start,
            mobile_chat_stream_cancel,
            // MCP commands
            list_mcp_servers,
            list_mcp_sets,
            list_mcp_server_tools,
            list_mcp_server_resources,
            test_mcp_server,
            upsert_mcp_server,
            delete_mcp_server,
            upsert_mcp_set,
            delete_mcp_set,
            set_agent_mcp_set,
            warmup_mcp_servers,
        ])
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("config.json");
            app.manage(Arc::new(ConfigManager::with_path(config_path)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let _ = app.emit("app:closing", ());
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        });
}

#[cfg_attr(
    any(target_os = "android", target_os = "ios"),
    tauri::mobile_entry_point
)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    run_desktop();

    #[cfg(any(target_os = "android", target_os = "ios"))]
    run_mobile();
}
