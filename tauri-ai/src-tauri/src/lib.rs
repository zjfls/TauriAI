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
pub mod shell_env;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod skills;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod storage;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod tray;
pub mod workstudio_security;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;
use tauri::Emitter;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;
#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2Controller,
    COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
use webview2_com::AcceleratorKeyPressedEventHandler;

use config::ConfigManager;

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
unsafe extern "system" {
    fn GetKeyState(nvirtkey: i32) -> i16;
}

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
fn collect_enabled_internal_session_agents(
    config: &crate::models::AppConfig,
) -> Vec<&crate::models::Agent> {
    config
        .agents
        .iter()
        .filter(|agent| {
            agent.enabled && !agent.is_practice() && agent.workstudio_enabled != Some(true)
        })
        .collect()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn collect_enabled_external_session_agents(
    config: &crate::models::AppConfig,
) -> Vec<&crate::models::ExternalAgentConfig> {
    let mut agents: Vec<_> = config
        .external_agents
        .agents
        .iter()
        .filter(|agent| agent.enabled)
        .collect();
    agents.sort_by(|left, right| left.name.cmp(&right.name));
    agents
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_default_internal_session_agent<'a>(
    config: &'a crate::models::AppConfig,
) -> Option<&'a crate::models::Agent> {
    let enabled_agents = collect_enabled_internal_session_agents(config);
    let configured_default = config.default_agent.trim();
    if !configured_default.is_empty() {
        if let Some(agent) = enabled_agents
            .iter()
            .copied()
            .find(|agent| agent.name == configured_default)
        {
            return Some(agent);
        }
    }
    enabled_agents.into_iter().next()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_default_external_session_agent<'a>(
    config: &'a crate::models::AppConfig,
) -> Option<&'a crate::models::ExternalAgentConfig> {
    collect_enabled_external_session_agents(config)
        .into_iter()
        .next()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn should_bind_new_session_to_external(config: &crate::models::AppConfig) -> bool {
    collect_enabled_internal_session_agents(config).is_empty()
        && resolve_default_external_session_agent(config).is_some()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum DefaultSessionMenuTarget {
    Internal(String),
    External(String),
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const DESKTOP_MENU_SHORTCUT_SPECS: [(&str, &str, &str); 4] = [
    ("session.new", "Cmd+T", "Ctrl+T"),
    ("app.openSettings", "Cmd+,", "Ctrl+,"),
    ("app.openHistory", "Cmd+Y", "Ctrl+Shift+H"),
    ("app.openDevtools", "Cmd+Option+I", "Ctrl+Shift+I"),
];

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn desktop_menu_shortcuts_enabled(config: &crate::models::AppConfig) -> bool {
    config.general.keyboard_shortcuts.enabled
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn desktop_menu_shortcut_override<'a>(
    config: &'a crate::models::AppConfig,
    action_id: &str,
) -> Option<&'a str> {
    let platform_map = if cfg!(target_os = "macos") {
        &config.general.keyboard_shortcuts.mac
    } else {
        &config.general.keyboard_shortcuts.windows
    };
    platform_map.get(action_id).map(String::as_str)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn normalize_menu_accelerator(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut mods: Vec<&'static str> = Vec::new();
    let mut key = String::new();
    for part in trimmed.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" => mods.push("Cmd"),
            "ctrl" | "control" => mods.push("Ctrl"),
            "cmdorctrl" | "cmdorcontrol" | "commandorcontrol" | "commandorctrl" => {
                mods.push("CmdOrCtrl")
            }
            "alt" | "option" | "opt" => mods.push("Alt"),
            "shift" => mods.push("Shift"),
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
            "minus" | "_" => key = "-".to_string(),
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn configured_menu_shortcut(
    config: &crate::models::AppConfig,
    action_id: &str,
    default_mac: &str,
    default_windows: &str,
) -> Option<String> {
    if !desktop_menu_shortcuts_enabled(config) {
        return None;
    }

    let raw = desktop_menu_shortcut_override(config, action_id)
        .unwrap_or(if cfg!(target_os = "macos") {
            default_mac
        } else {
            default_windows
        })
        .trim();

    if raw.is_empty() {
        return None;
    }

    normalize_menu_accelerator(raw)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_default_session_menu_target(
    config: &crate::models::AppConfig,
) -> Option<DefaultSessionMenuTarget> {
    if let Some(agent) = resolve_default_internal_session_agent(config) {
        return Some(DefaultSessionMenuTarget::Internal(agent.name.clone()));
    }
    resolve_default_external_session_agent(config)
        .map(|agent| DefaultSessionMenuTarget::External(agent.name.clone()))
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
        configured_menu_shortcut(config, action_id, default_mac, default_windows)
    }

    #[allow(dead_code)]
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

    // Prepare internal/external agent lists for "新建会话" 子菜单。
    // Exclude Workstudio/Workspace AI agents from the main window's internal session menu.
    let mut enabled_agents = collect_enabled_internal_session_agents(config);
    let enabled_external_agents = collect_enabled_external_session_agents(config);
    let default_internal_agent = resolve_default_internal_session_agent(config);
    let default_external_agent = resolve_default_external_session_agent(config);
    let effective_default_agent = default_internal_agent
        .map(|agent| agent.name.as_str())
        .unwrap_or_default();
    if let Some(default_agent_name) = default_internal_agent.map(|agent| agent.name.as_str()) {
        if let Some(pos) = enabled_agents
            .iter()
            .position(|agent| agent.name == default_agent_name)
        {
            let default_agent = enabled_agents.remove(pos);
            enabled_agents.insert(0, default_agent);
        }
    }
    let effective_default_external_agent = default_external_agent
        .map(|agent| agent.name.as_str())
        .unwrap_or_default();
    let has_agents = !enabled_agents.is_empty();
    let has_external_agents = !enabled_external_agents.is_empty();
    let bind_new_session_shortcut_to_external = should_bind_new_session_to_external(config);

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
    let open_settings_shortcut = configured_shortcut(config, "app.openSettings", "Cmd+,", "Ctrl+,");
    let open_history_shortcut =
        configured_shortcut(config, "app.openHistory", "Cmd+Y", "Ctrl+Shift+H");
    let open_devtools_shortcut =
        configured_shortcut(config, "app.openDevtools", "Cmd+Option+I", "Ctrl+Shift+I");
    let default_session_target = resolve_default_session_menu_target(config)
        .map(|target| match target {
            DefaultSessionMenuTarget::Internal(agent_name) => format!("internal:{agent_name}"),
            DefaultSessionMenuTarget::External(agent_name) => format!("external:{agent_name}"),
        })
        .unwrap_or_else(|| "<none>".to_string());
    log_shortcut_menu_backend(
        "build_desktop_menu",
        format!(
            "shortcuts_enabled={} session.new={} app.openSettings={} app.openHistory={} app.openDevtools={} default_session_target={} has_internal_agents={} has_external_agents={} bind_new_session_to_external={}",
            desktop_menu_shortcuts_enabled(config),
            new_session_shortcut.as_deref().unwrap_or("<disabled>"),
            open_settings_shortcut.as_deref().unwrap_or("<disabled>"),
            open_history_shortcut.as_deref().unwrap_or("<disabled>"),
            open_devtools_shortcut.as_deref().unwrap_or("<disabled>"),
            default_session_target,
            has_agents,
            has_external_agents,
            bind_new_session_shortcut_to_external
        ),
    );
    let new_session_default = MenuItem::with_id(
        app,
        "new_session_default",
        "新建会话",
        has_agents || has_external_agents,
        if has_agents || has_external_agents {
            new_session_shortcut.as_deref()
        } else {
            None::<&str>
        },
    )?;

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
            items.push(MenuItem::with_id(app, id, label, true, None::<&str>)?);
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

    let new_external_session_by_agent: Submenu<R> = if has_external_agents {
        let mut items: Vec<MenuItem<R>> = Vec::new();
        for agent in &enabled_external_agents {
            let mut label = agent.display_name.clone();
            let is_default = bind_new_session_shortcut_to_external
                && agent.name == effective_default_external_agent;
            if is_default {
                label = format!("{label}（默认）");
            }
            let encoded = urlencoding::encode(&agent.name);
            let id = format!("new_external_session_agent:{encoded}");
            items.push(MenuItem::with_id(app, id, label, true, None::<&str>)?);
        }
        let item_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            items.iter().map(|i| i as _).collect();
        Submenu::with_items(app, "新建外部会话", true, &item_refs)?
    } else {
        let empty = MenuItem::with_id(
            app,
            "new_external_session_agent_empty",
            "（未配置 External Agent）",
            false,
            None::<&str>,
        )?;
        Submenu::with_items(app, "新建外部会话", false, &[&empty])?
    };

    let open_settings = MenuItem::with_id(
        app,
        "open_settings",
        "设置…",
        true,
        open_settings_shortcut.as_deref(),
    )?;
    let open_practice = MenuItem::with_id(app, "open_practice", "练习", true, None::<&str>)?;
    let reset_main_window =
        MenuItem::with_id(app, "reset_main_window", "重置主窗口", true, None::<&str>)?;
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
                &open_practice,
                &open_settings,
                &reset_main_window,
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
                &open_practice,
                &open_settings,
                &reset_main_window,
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
                &new_session_default,
                &open_history,
                &session_history_separator,
                &new_session_by_agent,
                &new_external_session_by_agent,
            ],
            0,
        )?;
    } else {
        let session = Submenu::with_items(
            app,
            "会话",
            true,
            &[
                &new_session_default,
                &open_history,
                &session_history_separator,
                &new_session_by_agent,
                &new_external_session_by_agent,
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
#[derive(Clone, Debug, Default)]
struct WindowContextEntry {
    _label: String,
    role: String,
    host_window_label: Option<String>,
    route_domain: String,
    capabilities: HashSet<String>,
    runtime_ready: bool,
    visibility_state: String,
    os_focused: bool,
    last_interaction_at_ms: u128,
    _active_view: Option<String>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Default)]
pub(crate) struct WindowContextRegistryState(
    pub(crate) std::sync::Mutex<HashMap<String, WindowContextEntry>>,
);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) struct NativeSystemShortcutHookState(
    pub(crate) Arc<std::sync::Mutex<HashSet<String>>>,
);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl Default for NativeSystemShortcutHookState {
    fn default() -> Self {
        Self(Arc::new(std::sync::Mutex::new(HashSet::new())))
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SystemShortcutRoutePolicy {
    CurrentHostSurface,
    CurrentSessionSurface,
    FocusedWindow,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Copy, Debug)]
struct SystemShortcutActionDefinition {
    route_policy: SystemShortcutRoutePolicy,
    target_capability: &'static str,
    ensure_visible: bool,
}

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
fn normalize_window_context_role(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "main_host" => "main_host".to_string(),
        "workspace_host" => "workspace_host".to_string(),
        "chat_view" => "chat_view".to_string(),
        "workstudio_view" => "workstudio_view".to_string(),
        "json_analyzer" => "json_analyzer".to_string(),
        "ghost" => "ghost".to_string(),
        _ => "utility".to_string(),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn normalize_window_context_domain(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "chat" => "chat".to_string(),
        "workstudio" => "workstudio".to_string(),
        _ => "utility".to_string(),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn normalize_window_visibility_state(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "visible" => "visible".to_string(),
        "hidden" => "hidden".to_string(),
        "minimized" => "minimized".to_string(),
        "destroyed" => "destroyed".to_string(),
        _ => "hidden".to_string(),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn normalize_window_capabilities(values: Vec<String>) -> HashSet<String> {
    values
        .into_iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
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
fn is_window_host_role(role: &str) -> bool {
    matches!(role, "main_host" | "workspace_host")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn window_context_can_handle(entry: &WindowContextEntry, capability: &str) -> bool {
    entry.runtime_ready
        && entry.visibility_state != "destroyed"
        && entry.capabilities.contains(capability)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn latest_context_label_matching<F>(
    contexts: &HashMap<String, WindowContextEntry>,
    mut predicate: F,
) -> Option<String>
where
    F: FnMut(&str, &WindowContextEntry) -> bool,
{
    contexts
        .iter()
        .filter(|(label, entry)| predicate(label, entry))
        .max_by_key(|(_, entry)| entry.last_interaction_at_ms)
        .map(|(label, _)| label.clone())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_host_label_for_context(label: &str, entry: &WindowContextEntry) -> Option<String> {
    if is_window_host_role(&entry.role) {
        return Some(label.to_string());
    }
    normalize_window_interaction_value(entry.host_window_label.clone())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn system_shortcut_action_definition(action_id: &str) -> Option<SystemShortcutActionDefinition> {
    if action_id.starts_with("new_session_agent:") {
        return Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::CurrentSessionSurface,
            target_capability: "session.create",
            ensure_visible: true,
        });
    }
    if action_id.starts_with("new_external_session_agent:") {
        return Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::CurrentSessionSurface,
            target_capability: "session.create_external",
            ensure_visible: true,
        });
    }

    match action_id {
        "new_session_default" => Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::CurrentSessionSurface,
            target_capability: "session.create",
            ensure_visible: true,
        }),
        "open_settings" => Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::CurrentHostSurface,
            target_capability: "surface.settings",
            ensure_visible: true,
        }),
        "open_history" => Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::CurrentHostSurface,
            target_capability: "surface.history",
            ensure_visible: true,
        }),
        "open_practice" => Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::CurrentHostSurface,
            target_capability: "surface.practice",
            ensure_visible: true,
        }),
        "open_devtools" => Some(SystemShortcutActionDefinition {
            route_policy: SystemShortcutRoutePolicy::FocusedWindow,
            target_capability: "debug.devtools",
            ensure_visible: false,
        }),
        _ => None,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn log_shortcut_menu_backend(_stage: &str, _detail: String) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn log_shortcut_native_backend(_stage: &str, _detail: String) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn log_shortcut_route_backend(_stage: &str, _detail: String) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn menu_action_id_from_shortcut_config_action(action_id: &str) -> Option<&'static str> {
    match action_id {
        "session.new" => Some("new_session_default"),
        "app.openSettings" => Some("open_settings"),
        "app.openHistory" => Some("open_history"),
        "app.openDevtools" => Some("open_devtools"),
        _ => None,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn configured_system_shortcut_binding(
    config: &crate::models::AppConfig,
    config_action_id: &str,
) -> Option<String> {
    DESKTOP_MENU_SHORTCUT_SPECS
        .iter()
        .find(|(action_id, _, _)| *action_id == config_action_id)
        .and_then(|(_, default_mac, default_windows)| {
            configured_menu_shortcut(config, config_action_id, default_mac, default_windows)
        })
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
#[derive(Clone, Copy, Debug, Default)]
struct NativeShortcutModifiers {
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NativeShortcutBindingPattern {
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    virtual_key: u32,
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
impl NativeShortcutBindingPattern {
    fn matches(self, modifiers: NativeShortcutModifiers, virtual_key: u32) -> bool {
        self.virtual_key == virtual_key
            && self.ctrl == modifiers.ctrl
            && self.alt == modifiers.alt
            && self.shift == modifiers.shift
            && self.meta == modifiers.meta
    }
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn native_shortcut_virtual_key_from_token(token: &str) -> Option<u32> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() == 1 {
        return match trimmed.chars().next()?.to_ascii_uppercase() {
            'A'..='Z' | '0'..='9' => Some(trimmed.chars().next()?.to_ascii_uppercase() as u32),
            ',' => Some(0xBC),
            '.' => Some(0xBE),
            '-' => Some(0xBD),
            '=' => Some(0xBB),
            ';' => Some(0xBA),
            '\'' => Some(0xDE),
            '[' => Some(0xDB),
            ']' => Some(0xDD),
            '\\' => Some(0xDC),
            '/' => Some(0xBF),
            '`' => Some(0xC0),
            _ => None,
        };
    }

    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "space" | "spacebar" => Some(0x20),
        "tab" => Some(0x09),
        "enter" | "return" => Some(0x0D),
        "escape" | "esc" => Some(0x1B),
        "left" => Some(0x25),
        "up" => Some(0x26),
        "right" => Some(0x27),
        "down" => Some(0x28),
        "comma" => Some(0xBC),
        "period" => Some(0xBE),
        "minus" => Some(0xBD),
        "equal" | "equals" => Some(0xBB),
        "semicolon" => Some(0xBA),
        "quote" | "apostrophe" => Some(0xDE),
        "bracketleft" => Some(0xDB),
        "bracketright" => Some(0xDD),
        "backslash" => Some(0xDC),
        "slash" => Some(0xBF),
        "backquote" | "grave" => Some(0xC0),
        _ => {
            if let Some(index) = lower.strip_prefix('f') {
                let number = index.parse::<u32>().ok()?;
                if (1..=24).contains(&number) {
                    return Some(0x70 + number - 1);
                }
            }
            None
        }
    }
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn parse_native_shortcut_binding(binding: &str) -> Option<NativeShortcutBindingPattern> {
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut virtual_key = None;

    for part in binding.split('+').map(str::trim).filter(|part| !part.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" | "opt" => alt = true,
            "shift" => shift = true,
            "cmdorctrl" | "cmdorcontrol" | "commandorcontrol" | "commandorctrl" => ctrl = true,
            "cmd" | "command" | "meta" | "super" => meta = true,
            _ => virtual_key = native_shortcut_virtual_key_from_token(part),
        }
    }

    Some(NativeShortcutBindingPattern {
        ctrl,
        alt,
        shift,
        meta,
        virtual_key: virtual_key?,
    })
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn get_key_state_pressed(virtual_key: i32) -> bool {
    unsafe { (GetKeyState(virtual_key) as u16 & 0x8000) != 0 }
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn current_native_shortcut_modifiers() -> NativeShortcutModifiers {
    NativeShortcutModifiers {
        ctrl: get_key_state_pressed(0x11),
        alt: get_key_state_pressed(0x12),
        shift: get_key_state_pressed(0x10),
        meta: get_key_state_pressed(0x5B) || get_key_state_pressed(0x5C),
    }
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn is_modifier_virtual_key(virtual_key: u32) -> bool {
    matches!(virtual_key, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C)
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn resolve_windows_native_system_shortcut_action(
    config: &crate::models::AppConfig,
    modifiers: NativeShortcutModifiers,
    virtual_key: u32,
) -> Option<(&'static str, String)> {
    if !desktop_menu_shortcuts_enabled(config) || is_modifier_virtual_key(virtual_key) {
        return None;
    }

    for (config_action_id, _, _) in DESKTOP_MENU_SHORTCUT_SPECS {
        let Some(binding) = configured_system_shortcut_binding(config, config_action_id) else {
            continue;
        };
        let Some(pattern) = parse_native_shortcut_binding(&binding) else {
            continue;
        };
        if pattern.matches(modifiers, virtual_key) {
            return menu_action_id_from_shortcut_config_action(config_action_id)
                .map(|menu_action_id| (menu_action_id, binding));
        }
    }

    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn format_window_context_entry(entry: &WindowContextEntry) -> String {
    let mut capabilities: Vec<&str> = entry.capabilities.iter().map(String::as_str).collect();
    capabilities.sort_unstable();

    format!(
        "role={},host={},domain={},caps=[{}],ready={},visibility={},focused={},last_ms={}",
        entry.role,
        entry.host_window_label.as_deref().unwrap_or("<none>"),
        entry.route_domain,
        capabilities.join(","),
        entry.runtime_ready,
        entry.visibility_state,
        entry.os_focused,
        entry.last_interaction_at_ms
    )
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn format_window_context_registry(contexts: &HashMap<String, WindowContextEntry>) -> String {
    let mut entries: Vec<String> = contexts
        .iter()
        .map(|(label, entry)| format!("{label}{{{}}}", format_window_context_entry(entry)))
        .collect();
    entries.sort_unstable();
    entries.join("; ")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn push_candidate_label(
    out: &mut Vec<String>,
    contexts: &HashMap<String, WindowContextEntry>,
    label: Option<String>,
    capability: &str,
) {
    let Some(candidate) = label else {
        return;
    };

    let can_handle = contexts
        .get(&candidate)
        .map(|entry| window_context_can_handle(entry, capability))
        .unwrap_or(candidate == "main");
    if !can_handle {
        return;
    }
    if !out.iter().any(|existing| existing == &candidate) {
        out.push(candidate);
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_system_shortcut_target_label(
    action_id: &str,
    contexts: &HashMap<String, WindowContextEntry>,
) -> Option<String> {
    let definition = system_shortcut_action_definition(action_id)?;
    let focused_label =
        latest_context_label_matching(contexts, |_, entry| entry.os_focused && entry.visibility_state != "destroyed");
    let latest_active_label =
        latest_context_label_matching(contexts, |_, entry| entry.visibility_state != "destroyed");
    let source_label = focused_label.as_ref().or(latest_active_label.as_ref());
    let focused_label_text = focused_label.as_deref().unwrap_or("<none>").to_string();
    let latest_active_label_text = latest_active_label.as_deref().unwrap_or("<none>").to_string();
    let source_label_text = source_label
        .map(|label| label.as_str())
        .unwrap_or("<none>")
        .to_string();

    let mut candidates: Vec<String> = Vec::new();
    match definition.route_policy {
        SystemShortcutRoutePolicy::CurrentHostSurface
        | SystemShortcutRoutePolicy::CurrentSessionSurface => {
            if let Some(source_label) = source_label {
                if let Some(source_entry) = contexts.get(source_label.as_str()) {
                    push_candidate_label(
                        &mut candidates,
                        contexts,
                        resolve_host_label_for_context(source_label, source_entry),
                        definition.target_capability,
                    );
                    push_candidate_label(
                        &mut candidates,
                        contexts,
                        latest_context_label_matching(contexts, |_, entry| {
                            entry.route_domain == source_entry.route_domain
                                && is_window_host_role(&entry.role)
                                && window_context_can_handle(entry, definition.target_capability)
                        }),
                        definition.target_capability,
                    );
                }
            }

            push_candidate_label(
                &mut candidates,
                contexts,
                latest_context_label_matching(contexts, |_, entry| {
                    is_window_host_role(&entry.role)
                        && window_context_can_handle(entry, definition.target_capability)
                }),
                definition.target_capability,
            );
            push_candidate_label(
                &mut candidates,
                contexts,
                Some("main".to_string()),
                definition.target_capability,
            );
        }
        SystemShortcutRoutePolicy::FocusedWindow => {
            push_candidate_label(
                &mut candidates,
                contexts,
                focused_label,
                definition.target_capability,
            );
            push_candidate_label(
                &mut candidates,
                contexts,
                latest_context_label_matching(contexts, |_, entry| {
                    window_context_can_handle(entry, definition.target_capability)
                }),
                definition.target_capability,
            );
            push_candidate_label(
                &mut candidates,
                contexts,
                Some("main".to_string()),
                definition.target_capability,
            );
        }
    }

    let chosen = candidates.first().cloned();
    let candidate_chain = if candidates.is_empty() {
        "<none>".to_string()
    } else {
        candidates.join(" -> ")
    };
    log_shortcut_route_backend(
        "resolve_target",
        format!(
            "action_id={} policy={:?} capability={} focused_label={} latest_active_label={} source_label={} candidates=[{}] chosen={} contexts=[{}]",
            action_id,
            definition.route_policy,
            definition.target_capability,
            focused_label_text,
            latest_active_label_text,
            source_label_text,
            candidate_chain,
            chosen.as_deref().unwrap_or("<none>"),
            format_window_context_registry(contexts)
        ),
    );

    chosen
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn ensure_window_visible_and_focused<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn pick_system_shortcut_target<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action_id: &str,
) -> Option<tauri::WebviewWindow<R>> {
    let definition = system_shortcut_action_definition(action_id)?;

    if let Some(state) = app.try_state::<WindowContextRegistryState>() {
        if let Ok(contexts) = state.0.lock() {
            if let Some(label) = resolve_system_shortcut_target_label(action_id, &contexts) {
                if let Some(window) = app.get_webview_window(&label) {
                    log_shortcut_route_backend(
                        "pick_target:registry_hit",
                        format!(
                            "action_id={} target_label={} policy={:?} capability={} ensure_visible={}",
                            action_id,
                            label,
                            definition.route_policy,
                            definition.target_capability,
                            definition.ensure_visible
                        ),
                    );
                    if definition.ensure_visible {
                        ensure_window_visible_and_focused(&window);
                    }
                    return Some(window);
                }

                log_shortcut_route_backend(
                    "pick_target:registry_window_missing",
                    format!(
                        "action_id={} resolved_label={} policy={:?} capability={} windows_present={}",
                        action_id,
                        label,
                        definition.route_policy,
                        definition.target_capability,
                        app.webview_windows()
                            .into_keys()
                            .collect::<Vec<String>>()
                            .join(",")
                    ),
                );
            } else {
                log_shortcut_route_backend(
                    "pick_target:registry_miss",
                    format!(
                        "action_id={} policy={:?} capability={} contexts=[{}]",
                        action_id,
                        definition.route_policy,
                        definition.target_capability,
                        format_window_context_registry(&contexts)
                    ),
                );
            }
        } else {
            log_shortcut_route_backend(
                "pick_target:registry_lock_error",
                format!(
                    "action_id={} policy={:?} capability={}",
                    action_id, definition.route_policy, definition.target_capability
                ),
            );
        }
    } else {
        log_shortcut_route_backend(
            "pick_target:registry_state_missing",
            format!(
                "action_id={} policy={:?} capability={}",
                action_id, definition.route_policy, definition.target_capability
            ),
        );
    }

    let fallback = match definition.route_policy {
        SystemShortcutRoutePolicy::FocusedWindow => app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
            .or_else(|| app.get_webview_window("main")),
        SystemShortcutRoutePolicy::CurrentHostSurface
        | SystemShortcutRoutePolicy::CurrentSessionSurface => app.get_webview_window("main"),
    };

    if let Some(window) = fallback {
        log_shortcut_route_backend(
            "pick_target:fallback_hit",
            format!(
                "action_id={} target_label={} policy={:?} capability={} ensure_visible={}",
                action_id,
                window.label(),
                definition.route_policy,
                definition.target_capability,
                definition.ensure_visible
            ),
        );
        if definition.ensure_visible {
            ensure_window_visible_and_focused(&window);
        }
        return Some(window);
    }

    log_shortcut_route_backend(
        "pick_target:none",
        format!(
            "action_id={} policy={:?} capability={} windows_present={}",
            action_id,
            definition.route_policy,
            definition.target_capability,
            app.webview_windows()
                .into_keys()
                .collect::<Vec<String>>()
                .join(",")
        ),
    );

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
    let payload_json = serde_json::to_string(&payload)
        .unwrap_or_else(|error| format!("<serialize_error:{}>", error));
    log_shortcut_route_backend(
        "emit_window_event:dispatch",
        format!("target_label={} event={} payload={}", label, event, payload_json),
    );
    if let Err(error) = app.emit_to(tauri::EventTarget::webview_window(label), event, payload) {
        log_shortcut_route_backend(
            "emit_window_event:error",
            format!("target_label={} event={} error={}", label, event, error),
        );
    } else {
        log_shortcut_route_backend(
            "emit_window_event:ok",
            format!("target_label={} event={}", label, event),
        );
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn dispatch_system_shortcut_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action_id: &str,
    source: &str,
) -> bool {
    log_shortcut_route_backend(
        "dispatch_system_action",
        format!("source={} action_id={}", source, action_id),
    );

    match action_id {
        "open_settings" => {
            if let Some(window) = pick_system_shortcut_target(app, "open_settings") {
                emit_webview_window_event(app, window.label(), "menu:open_settings", ());
            } else {
                log_shortcut_menu_backend(
                    "dispatch_skipped",
                    format!(
                        "source={} action_id=open_settings reason=no_target_window",
                        source
                    ),
                );
            }
            true
        }
        "open_practice" => {
            if let Some(window) = pick_system_shortcut_target(app, "open_practice") {
                emit_webview_window_event(app, window.label(), "menu:open_practice", ());
            } else {
                log_shortcut_menu_backend(
                    "dispatch_skipped",
                    format!(
                        "source={} action_id=open_practice reason=no_target_window",
                        source
                    ),
                );
            }
            true
        }
        "open_history" => {
            if let Some(window) = pick_system_shortcut_target(app, "open_history") {
                emit_webview_window_event(app, window.label(), "menu:open_history", ());
            } else {
                log_shortcut_menu_backend(
                    "dispatch_skipped",
                    format!(
                        "source={} action_id=open_history reason=no_target_window",
                        source
                    ),
                );
            }
            true
        }
        "new_session_default" => {
            let config = app
                .state::<Arc<ConfigManager>>()
                .ensure_default()
                .unwrap_or_default();
            let target = resolve_default_session_menu_target(&config);
            if let Some(window) = pick_system_shortcut_target(app, "new_session_default") {
                match target {
                    Some(DefaultSessionMenuTarget::Internal(agent_name)) => {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:new_session_agent",
                            agent_name,
                        );
                    }
                    Some(DefaultSessionMenuTarget::External(agent_name)) => {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:new_external_session_agent",
                            agent_name,
                        );
                    }
                    None => {
                        log_shortcut_menu_backend(
                            "dispatch_skipped",
                            format!(
                                "source={} action_id=new_session_default reason=no_default_session_target",
                                source
                            ),
                        );
                    }
                }
            } else {
                log_shortcut_menu_backend(
                    "dispatch_skipped",
                    format!(
                        "source={} action_id=new_session_default reason=no_target_window",
                        source
                    ),
                );
            }
            true
        }
        "open_devtools" => {
            #[cfg(debug_assertions)]
            {
                if let Some(window) = pick_system_shortcut_target(app, "open_devtools") {
                    window.open_devtools();
                } else {
                    log_shortcut_menu_backend(
                        "dispatch_skipped",
                        format!(
                            "source={} action_id=open_devtools reason=no_target_window",
                            source
                        ),
                    );
                }
            }
            #[cfg(not(debug_assertions))]
            {
                log_shortcut_menu_backend(
                    "dispatch_skipped",
                    format!(
                        "source={} action_id=open_devtools reason=devtools_disabled",
                        source
                    ),
                );
            }
            true
        }
        _ => false,
    }
}

#[cfg(all(target_os = "windows", not(any(target_os = "android", target_os = "ios"))))]
fn ensure_native_system_shortcut_source_installed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &NativeSystemShortcutHookState,
    label: &str,
) {
    let label = label.trim();
    if label.is_empty() || is_ignored_window_label(label) {
        return;
    }

    let state_arc = state.0.clone();
    {
        let mut guard = match state_arc.lock() {
            Ok(guard) => guard,
            Err(_) => {
                log_shortcut_native_backend(
                    "install_hook_error",
                    format!("label={} reason=state_lock_failed", label),
                );
                return;
            }
        };
        if !guard.insert(label.to_string()) {
            return;
        }
    }

    let Some(window) = app.get_webview_window(label) else {
        if let Ok(mut guard) = state_arc.lock() {
            guard.remove(label);
        }
        log_shortcut_native_backend(
            "install_hook_skipped",
            format!("label={} reason=webview_window_missing", label),
        );
        return;
    };

    let state_for_destroy = state_arc.clone();
    let destroyed_label = label.to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut guard) = state_for_destroy.lock() {
                if guard.remove(&destroyed_label) {
                    log_shortcut_native_backend(
                        "remove_hook_state",
                        format!("label={} reason=window_destroyed", destroyed_label),
                    );
                }
            }
        }
    });

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let install_label = label.to_string();
    let app_handle = app.clone();
    let with_webview_result = window.with_webview(move |platform_webview: tauri::webview::PlatformWebview| {
        let callback_app = app_handle.clone();
        let callback_label = install_label.clone();
        let install_result: Result<(), String> = (|| unsafe {
            let controller = platform_webview.controller();
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
                move |_: Option<ICoreWebView2Controller>,
                      args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                    let Some(args) = args else {
                        return Ok(());
                    };

                    let mut key_event_kind = COREWEBVIEW2_KEY_EVENT_KIND(0);
                    args.KeyEventKind(&mut key_event_kind)?;
                    if key_event_kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                        && key_event_kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                    {
                        return Ok(());
                    }

                    let mut virtual_key = 0u32;
                    args.VirtualKey(&mut virtual_key)?;

                    let modifiers = current_native_shortcut_modifiers();
                    if modifiers.ctrl || modifiers.alt || modifiers.meta {
                        log_shortcut_native_backend(
                            "accelerator_key",
                            format!(
                                "label={} kind={} vk={} ctrl={} alt={} shift={} meta={}",
                                callback_label,
                                key_event_kind.0,
                                virtual_key,
                                modifiers.ctrl,
                                modifiers.alt,
                                modifiers.shift,
                                modifiers.meta
                            ),
                        );
                    }

                    let config = callback_app
                        .state::<Arc<ConfigManager>>()
                        .ensure_default()
                        .unwrap_or_default();
                    if let Some((action_id, binding)) =
                        resolve_windows_native_system_shortcut_action(
                            &config,
                            modifiers,
                            virtual_key,
                        )
                    {
                        log_shortcut_native_backend(
                            "match_action",
                            format!(
                                "label={} action_id={} binding={} vk={}",
                                callback_label, action_id, binding, virtual_key
                            ),
                        );
                        let source = format!("windows.webview_accelerator:{}", callback_label);
                        let _ = dispatch_system_shortcut_action(&callback_app, action_id, &source);
                        args.SetHandled(true.into())?;
                        log_shortcut_native_backend(
                            "handled_action",
                            format!(
                                "label={} action_id={} handled=true",
                                callback_label, action_id
                            ),
                        );
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            controller
                .add_AcceleratorKeyPressed(&handler, &mut token)
                .map_err(|error| error.to_string())?;
            log_shortcut_native_backend(
                "install_webview_hook",
                format!("label={} token={}", install_label, token),
            );
            Ok(())
        })();
        let _ = tx.send(install_result);
    });

    if let Err(error) = with_webview_result {
        if let Ok(mut guard) = state_arc.lock() {
            guard.remove(label);
        }
        log_shortcut_native_backend(
            "install_hook_error",
            format!("label={} reason=with_webview_failed error={}", label, error),
        );
        return;
    }

    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            if let Ok(mut guard) = state_arc.lock() {
                guard.remove(label);
            }
            log_shortcut_native_backend(
                "install_hook_error",
                format!("label={} reason=controller_register_failed error={}", label, error),
            );
        }
        Err(error) => {
            if let Ok(mut guard) = state_arc.lock() {
                guard.remove(label);
            }
            log_shortcut_native_backend(
                "install_hook_error",
                format!("label={} reason=controller_register_timeout error={}", label, error),
            );
        }
    }
}

#[cfg(not(all(target_os = "windows", not(any(target_os = "android", target_os = "ios")))))]
fn ensure_native_system_shortcut_source_installed<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _state: &NativeSystemShortcutHookState,
    _label: &str,
) {
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn sync_window_context(
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowContextRegistryState>,
    native_shortcut_state: tauri::State<'_, NativeSystemShortcutHookState>,
    label: String,
    role: String,
    host_window_label: Option<String>,
    route_domain: String,
    capabilities: Vec<String>,
    runtime_ready: bool,
    visibility_state: String,
    os_focused: bool,
    active_view: Option<String>,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() || is_ignored_window_label(&label) {
        return Ok(());
    }

    let now_ms = window_interaction_now_ms();
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "window context registry poisoned".to_string())?;

    if os_focused {
        for (other_label, other_entry) in guard.iter_mut() {
            if other_label != &label {
                other_entry.os_focused = false;
            }
        }
    }

    let next_entry = WindowContextEntry {
        _label: label.clone(),
        role: normalize_window_context_role(&role),
        host_window_label: normalize_window_interaction_value(host_window_label),
        route_domain: normalize_window_context_domain(&route_domain),
        capabilities: normalize_window_capabilities(capabilities),
        runtime_ready,
        visibility_state: normalize_window_visibility_state(&visibility_state),
        os_focused,
        last_interaction_at_ms: now_ms,
        _active_view: normalize_window_interaction_value(active_view),
    };
    let entry_snapshot = format_window_context_entry(&next_entry);
    guard.insert(label.clone(), next_entry);
    log_shortcut_route_backend(
        "sync_window_context",
        format!(
            "label={} entry={} registry=[{}]",
            label,
            entry_snapshot,
            format_window_context_registry(&guard)
        ),
    );
    drop(guard);
    ensure_native_system_shortcut_source_installed(&app, native_shortcut_state.inner(), &label);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn clear_window_context(
    state: tauri::State<'_, WindowContextRegistryState>,
    label: String,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Ok(());
    }

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "window context registry poisoned".to_string())?;
    let removed_entry = guard.remove(&label);
    log_shortcut_route_backend(
        "clear_window_context",
        format!(
            "label={} removed={} registry=[{}]",
            label,
            removed_entry
                .as_ref()
                .map(format_window_context_entry)
                .unwrap_or_else(|| "<none>".to_string()),
            format_window_context_registry(&guard)
        ),
    );
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn record_window_interaction(
    state: tauri::State<'_, WindowInteractionRouteState>,
    window_context_state: tauri::State<'_, WindowContextRegistryState>,
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
        guard.last_workstudio_window_label = Some(label.clone());
    }

    if let Ok(mut context_guard) = window_context_state.0.lock() {
        if let Some(entry) = context_guard.get_mut(&label) {
            entry.last_interaction_at_ms = window_interaction_now_ms();
        }
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

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod window_routing_tests {
    use super::*;

    fn make_context(
        label: &str,
        role: &str,
        host_window_label: Option<&str>,
        route_domain: &str,
        capabilities: &[&str],
        last_interaction_at_ms: u128,
        os_focused: bool,
    ) -> WindowContextEntry {
        WindowContextEntry {
            _label: label.to_string(),
            role: role.to_string(),
            host_window_label: host_window_label.map(str::to_string),
            route_domain: route_domain.to_string(),
            capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
            runtime_ready: true,
            visibility_state: "visible".to_string(),
            os_focused,
            last_interaction_at_ms,
            _active_view: Some("chat".to_string()),
        }
    }

    #[test]
    fn open_settings_routes_focused_chat_view_back_to_main_host() {
        let mut contexts = HashMap::new();
        contexts.insert(
            "main".to_string(),
            make_context(
                "main",
                "main_host",
                Some("main"),
                "chat",
                &["surface.settings", "surface.history", "session.create"],
                10,
                false,
            ),
        );
        contexts.insert(
            "view-chat-conv-1".to_string(),
            make_context(
                "view-chat-conv-1",
                "chat_view",
                Some("main"),
                "chat",
                &["debug.devtools"],
                20,
                true,
            ),
        );

        assert_eq!(
            resolve_system_shortcut_target_label("open_settings", &contexts),
            Some("main".to_string())
        );
    }

    #[test]
    fn open_history_prefers_workspace_host_for_focused_workspace_child() {
        let mut contexts = HashMap::new();
        contexts.insert(
            "workspace-1".to_string(),
            make_context(
                "workspace-1",
                "workspace_host",
                Some("workspace-1"),
                "chat",
                &["surface.settings", "surface.history", "session.create"],
                10,
                false,
            ),
        );
        contexts.insert(
            "view-chat-conv-2".to_string(),
            make_context(
                "view-chat-conv-2",
                "chat_view",
                Some("workspace-1"),
                "chat",
                &["debug.devtools"],
                20,
                true,
            ),
        );

        assert_eq!(
            resolve_system_shortcut_target_label("open_history", &contexts),
            Some("workspace-1".to_string())
        );
    }

    #[test]
    fn new_session_falls_back_to_main_when_host_context_is_missing() {
        let mut contexts = HashMap::new();
        contexts.insert(
            "main".to_string(),
            make_context(
                "main",
                "main_host",
                Some("main"),
                "chat",
                &["surface.settings", "surface.history", "session.create"],
                10,
                false,
            ),
        );
        contexts.insert(
            "view-chat-conv-3".to_string(),
            make_context(
                "view-chat-conv-3",
                "chat_view",
                Some("workspace-missing"),
                "chat",
                &["debug.devtools"],
                20,
                true,
            ),
        );

        assert_eq!(
            resolve_system_shortcut_target_label("new_session_agent:test", &contexts),
            Some("main".to_string())
        );
    }

    #[test]
    fn new_session_default_prefers_workspace_host_for_focused_workspace_child() {
        let mut contexts = HashMap::new();
        contexts.insert(
            "workspace-1".to_string(),
            make_context(
                "workspace-1",
                "workspace_host",
                Some("workspace-1"),
                "chat",
                &["surface.settings", "surface.history", "session.create"],
                10,
                false,
            ),
        );
        contexts.insert(
            "view-chat-conv-5".to_string(),
            make_context(
                "view-chat-conv-5",
                "chat_view",
                Some("workspace-1"),
                "chat",
                &["debug.devtools"],
                20,
                true,
            ),
        );

        assert_eq!(
            resolve_system_shortcut_target_label("new_session_default", &contexts),
            Some("workspace-1".to_string())
        );
    }

    #[test]
    fn open_devtools_targets_focused_window_directly() {
        let mut contexts = HashMap::new();
        contexts.insert(
            "main".to_string(),
            make_context(
                "main",
                "main_host",
                Some("main"),
                "chat",
                &[
                    "surface.settings",
                    "surface.history",
                    "session.create",
                    "debug.devtools",
                ],
                10,
                false,
            ),
        );
        contexts.insert(
            "view-chat-conv-4".to_string(),
            make_context(
                "view-chat-conv-4",
                "chat_view",
                Some("main"),
                "chat",
                &["debug.devtools"],
                20,
                true,
            ),
        );

        assert_eq!(
            resolve_system_shortcut_target_label("open_devtools", &contexts),
            Some("view-chat-conv-4".to_string())
        );
    }
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod desktop_menu_tests {
    use super::*;

    #[test]
    fn normalize_menu_accelerator_supports_period_and_comma_shortcuts() {
        assert_eq!(normalize_menu_accelerator("Ctrl+."), Some("Ctrl+.".to_string()));
        assert_eq!(
            normalize_menu_accelerator("Ctrl+Period"),
            Some("Ctrl+.".to_string())
        );
        assert_eq!(normalize_menu_accelerator("Ctrl+,"), Some("Ctrl+,".to_string()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_native_shortcut_matcher_tracks_current_binding() {
        let mut config = crate::models::AppConfig::default();
        config
            .general
            .keyboard_shortcuts
            .windows
            .insert("app.openSettings".to_string(), "Ctrl+.".to_string());

        assert_eq!(
            resolve_windows_native_system_shortcut_action(
                &config,
                NativeShortcutModifiers {
                    ctrl: true,
                    ..Default::default()
                },
                0xBE,
            ),
            Some(("open_settings", "Ctrl+.".to_string()))
        );
        assert_eq!(
            resolve_windows_native_system_shortcut_action(
                &config,
                NativeShortcutModifiers {
                    ctrl: true,
                    ..Default::default()
                },
                0xBC,
            ),
            None
        );
    }

    #[test]
    fn configured_menu_shortcut_respects_global_enabled_switch() {
        let mut config = crate::models::AppConfig::default();
        config
            .general
            .keyboard_shortcuts
            .mac
            .insert("app.openSettings".to_string(), "Cmd+Shift+,".to_string());
        config
            .general
            .keyboard_shortcuts
            .windows
            .insert("app.openSettings".to_string(), "Ctrl+.".to_string());

        let expected_enabled = if cfg!(target_os = "macos") {
            Some("Cmd+Shift+,".to_string())
        } else {
            Some("Ctrl+.".to_string())
        };
        assert_eq!(
            configured_menu_shortcut(&config, "app.openSettings", "Cmd+,", "Ctrl+,"),
            expected_enabled
        );

        config.general.keyboard_shortcuts.enabled = false;
        assert_eq!(
            configured_menu_shortcut(&config, "app.openSettings", "Cmd+,", "Ctrl+,"),
            None
        );
    }

    #[test]
    fn desktop_menu_signature_tracks_effective_system_shortcut_state() {
        let mut config = crate::models::AppConfig::default();
        let initial_sig = desktop_menu_signature(&config);

        config
            .general
            .keyboard_shortcuts
            .mac
            .insert("app.openSettings".to_string(), "Cmd+Shift+,".to_string());
        config
            .general
            .keyboard_shortcuts
            .windows
            .insert("app.openSettings".to_string(), "Ctrl+.".to_string());
        let rebound_sig = desktop_menu_signature(&config);
        assert_ne!(initial_sig, rebound_sig);

        config.general.keyboard_shortcuts.enabled = false;
        let disabled_sig = desktop_menu_signature(&config);
        assert_ne!(rebound_sig, disabled_sig);
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn desktop_menu_signature(config: &crate::models::AppConfig) -> String {
    // Keep in sync with the behavior of `build_desktop_menu`:
    // - enabled internal agents (excluding workstudio-only)
    // - enabled external agents
    // - default internal agent (or first enabled fallback)
    let mut enabled_agents: Vec<_> = config
        .agents
        .iter()
        .filter(|a| a.enabled && !a.is_practice() && a.workstudio_enabled != Some(true))
        .collect();
    let mut enabled_external_agents: Vec<_> = config
        .external_agents
        .agents
        .iter()
        .filter(|a| a.enabled)
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

    enabled_external_agents.sort_by(|left, right| left.name.cmp(&right.name));
    let effective_default_external_agent = enabled_external_agents
        .first()
        .map(|a| a.name.as_str())
        .unwrap_or_default();

    let mut sig = String::from("v5|default=");
    sig.push_str(effective_default_agent);
    sig.push('|');
    sig.push_str("externalDefault=");
    sig.push_str(effective_default_external_agent);
    sig.push('|');
    sig.push_str("shortcutToExternal=");
    sig.push_str(
        if enabled_agents.is_empty() && !enabled_external_agents.is_empty() {
            "1"
        } else {
            "0"
        },
    );
    sig.push('|');
    sig.push_str("shortcutsEnabled=");
    sig.push_str(if desktop_menu_shortcuts_enabled(config) {
        "1"
    } else {
        "0"
    });
    sig.push('|');
    for (action_id, default_mac, default_windows) in DESKTOP_MENU_SHORTCUT_SPECS {
        sig.push_str(action_id);
        sig.push('=');
        if let Some(value) =
            configured_menu_shortcut(config, action_id, default_mac, default_windows)
        {
            sig.push_str(&value);
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
    sig.push('|');
    for a in enabled_external_agents {
        sig.push_str(&a.name);
        sig.push('=');
        sig.push_str(&a.display_name);
        sig.push(';');
    }
    sig
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn run_desktop() {
    // 在 Tokio runtime 启动之前（单线程阶段），合并 shell 登录环境的 PATH。
    // 解决 macOS GUI 程序无法找到 Homebrew、npm global 等 CLI 工具的问题。
    crate::shell_env::merge_shell_path_blocking();

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
            let pick_system_menu_target =
                |action_id: &str| pick_system_shortcut_target(app, action_id);
            let event_id = event.id().as_ref();

            if system_shortcut_action_definition(event_id).is_some() {
                log_shortcut_menu_backend(
                    "on_menu_event",
                    format!("id={} system_action=true", event_id),
                );
            }

            match event_id {
                "open_settings" => {
                    let _ = dispatch_system_shortcut_action(app, "open_settings", "menu");
                }
                "open_practice" => {
                    let _ = dispatch_system_shortcut_action(app, "open_practice", "menu");
                }
                "reset_main_window" => {
                    if app.get_webview_window("main").is_some() {
                        emit_webview_window_event(
                            app,
                            "main",
                            "app:reset_main_window",
                            (),
                        );
                    } else {
                        log_shortcut_menu_backend(
                            "dispatch_skipped",
                            "action_id=reset_main_window reason=main_window_missing".to_string(),
                        );
                    }
                }
                "open_history" => {
                    let _ = dispatch_system_shortcut_action(app, "open_history", "menu");
                }
                "new_session_default" => {
                    let _ = dispatch_system_shortcut_action(app, "new_session_default", "menu");
                }
                id if id.starts_with("new_session_agent:") => {
                    let raw = id.trim_start_matches("new_session_agent:");
                    let agent_name = urlencoding::decode(raw)
                        .map(|s| s.into_owned())
                        .unwrap_or_else(|_| raw.to_string());
                    if let Some(window) = pick_system_menu_target(id) {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:new_session_agent",
                            agent_name,
                        );
                    } else {
                        log_shortcut_menu_backend(
                            "dispatch_skipped",
                            format!("action_id={} reason=no_target_window", id),
                        );
                    }
                }
                id if id.starts_with("new_external_session_agent:") => {
                    let raw = id.trim_start_matches("new_external_session_agent:");
                    let agent_name = urlencoding::decode(raw)
                        .map(|s| s.into_owned())
                        .unwrap_or_else(|_| raw.to_string());
                    if let Some(window) = pick_system_menu_target(id) {
                        emit_webview_window_event(
                            app,
                            window.label(),
                            "menu:new_external_session_agent",
                            agent_name,
                        );
                    } else {
                        log_shortcut_menu_backend(
                            "dispatch_skipped",
                            format!("action_id={} reason=no_target_window", id),
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
                    let _ = dispatch_system_shortcut_action(app, "open_devtools", "menu");
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
        .manage(WindowContextRegistryState::default())
        .manage(NativeSystemShortcutHookState::default())
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
            start_external_agent_session,
            send_external_agent_session,
            close_external_agent_session,
            // Lightweight LLM calls (used by practice module)
            mobile_chat,
            mobile_generate_title,
            practice_chat,
            practice_generate_title,
            // Clipboard
            clipboard_write_png_base64,
            save_png_base64_to_local,
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
            sync_window_context,
            clear_window_context,
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
        clipboard_write_png_base64,
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
        save_png_base64_to_local,
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
            clipboard_write_png_base64,
            save_png_base64_to_local,
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
