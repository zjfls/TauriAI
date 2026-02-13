use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread::JoinHandle;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSEvent, NSWindow};
#[cfg(target_os = "macos")]
use objc2_foundation::NSPoint;

#[derive(Debug, Clone, Serialize)]
struct DragGhostUpdatePayload {
    title: String,
}

#[derive(Default)]
struct DragGhostFollowState {
    stop: Option<Arc<AtomicBool>>,
    join: Option<JoinHandle<()>>,
    offset_x: i32,
    offset_y: i32,
    w: u32,
    h: u32,
}

fn follow_state() -> &'static Mutex<DragGhostFollowState> {
    static STATE: OnceLock<Mutex<DragGhostFollowState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(DragGhostFollowState::default()))
}

fn ghost_label_for_source(source_label: &str) -> String {
    // 关键策略：Windows 上在拖拽/菜单回调期间动态创建 WebviewWindow 可能卡死在 `builder.build()`。
    // 因此 ghost 窗口改为“启动时预创建一个单例”，运行期只做 show/move/update。
    // 这里始终返回同一个 label，避免多窗口创建带来的不稳定性。
    let _ = source_label;
    "__tauriai_ghost__global".to_string()
}

#[tauri::command]
pub fn drag_ghost_create(
    app: tauri::AppHandle,
    title: String,
    source_label: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
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

    let source_pos = source.outer_position().ok();
    let source_size = source.outer_size().ok();
    let scale = source.scale_factor().unwrap_or(1.0);

    let (ghost_w, ghost_h) = if let (Some(w), Some(h)) = (width, height) {
        let wp = (w.max(80.0).min(1600.0) * scale).round() as i32;
        let hp = (h.max(20.0).min(500.0) * scale).round() as i32;
        (wp.max(40), hp.max(20))
    } else if let Some(size) = source_size {
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

    // Store offsets/sizing into follow state so both "client move" and "follow" use the same anchor.
    {
        let ox_css = offset_x.unwrap_or(14.0).max(-4096.0).min(4096.0);
        let oy_css = offset_y.unwrap_or(18.0).max(-4096.0).min(4096.0);
        let oxp = (ox_css * scale).round() as i32;
        let oyp = (oy_css * scale).round() as i32;
        if let Ok(mut st) = follow_state().lock() {
            st.offset_x = oxp;
            st.offset_y = oyp;
            st.w = ghost_w.max(1) as u32;
            st.h = ghost_h.max(1) as u32;
        }
    }

    if let Some(ghost) = app.get_webview_window(&ghost_label) {
        println!(
            "[drag_ghost_create] reuse label={} title={} pos=({}, {}) size=({}, {})",
            ghost_label, title, x, y, ghost_w, ghost_h
        );
        ghost
            .set_size(PhysicalSize::new(ghost_w as u32, ghost_h as u32))
            .map_err(|e| e.to_string())?;
        ghost
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        let _ = ghost.set_title(&format!("[GHOST] {}", title));
        ghost
            .set_focusable(false)
            .map_err(|e| e.to_string())?;
        ghost
            // 关键：ghost 必须“鼠标穿透”，否则会抢占拖拽事件，导致拖拽中断或 move 不再触发。
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        ghost.show().map_err(|e| e.to_string())?;
        let _ = source.set_focus();
        let _ = ghost.emit(
            "drag-ghost:update",
            DragGhostUpdatePayload {
                title: title.clone(),
            },
        );

        return Ok(());
    }

    Err(format!(
        "ghost window not initialized (label={}); please restart app",
        ghost_label
    ))
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

    let (oxp, oyp) = follow_state()
        .lock()
        .map(|st| (st.offset_x, st.offset_y))
        .unwrap_or((14, 18));

    ghost
        .set_position(PhysicalPosition::new(x - oxp, y - oyp))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move ghost window using a client-space cursor position (CSS pixels).
///
/// This avoids relying on `cursorPosition()` JS polling, which may stop updating
/// in some drag scenarios. We convert to physical screen coordinates using the
/// source window's `inner_position` + `scale_factor`.
#[tauri::command]
pub fn drag_ghost_move_client(
    app: tauri::AppHandle,
    source_label: Option<String>,
    client_x: f64,
    client_y: f64,
) -> Result<(), String> {
    if !client_x.is_finite() || !client_y.is_finite() {
        return Ok(());
    }

    let source_label = source_label.unwrap_or_else(|| "main".to_string());
    let source = app
        .get_webview_window(&source_label)
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "main window not found".to_string())?;

    let scale = source.scale_factor().map_err(|e| e.to_string())?;
    let inner = source.inner_position().map_err(|e| e.to_string())?;

    let x = inner.x + (client_x * scale).round() as i32;
    let y = inner.y + (client_y * scale).round() as i32;

    drag_ghost_move(app, Some(source.label().to_string()), x, y)
}

// ---------------------------------------------------------------------------
// Scheme A: backend-follow mode (Windows-first)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(lp_point: *mut POINT) -> i32;
}

#[cfg(target_os = "windows")]
fn get_cursor_pos_windows() -> Option<(i32, i32)> {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        let ok = GetCursorPos(&mut p as *mut POINT);
        if ok != 0 {
            Some((p.x, p.y))
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn drag_ghost_follow_start(
    app: tauri::AppHandle,
    source_label: Option<String>,
    client_x: Option<f64>,
    client_y: Option<f64>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let ghost_label = ghost_label_for_source("main");
    let ghost = app
        .get_webview_window(&ghost_label)
        .ok_or_else(|| format!("ghost window not found: {}", ghost_label))?;
    let _ = (client_x, client_y);

    // already running?
    {
        let st = follow_state().lock().map_err(|_| "follow state poisoned".to_string())?;
        if st.stop.is_some() {
            return Ok(());
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();

    // Keep a clone for the worker; methods are Send on Windows builds.
    let ghost2 = ghost.clone();

    // Derive scale + physical sizes from main window (best-effort).
    let source_label = source_label.unwrap_or_else(|| "main".to_string());
    let source = app
        .get_webview_window(&source_label)
        .or_else(|| app.get_webview_window("main"));

    let main = source.clone().or_else(|| app.get_webview_window(&ghost_label));
    let scale = main
        .as_ref()
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);

    let ox = offset_x.unwrap_or(14.0).max(-4096.0).min(4096.0);
    let oy = offset_y.unwrap_or(18.0).max(-4096.0).min(4096.0);
    let (oxp, oyp) = ((ox * scale).round() as i32, (oy * scale).round() as i32);

    // Keep sane limits, but allow a bit larger for debugging/visibility.
    let ww = width.unwrap_or(260.0).max(120.0).min(1600.0);
    // tab bar 在部分主题下高度会小于 32px，不能用 32 作为下限，否则 ghost 会显著“偏高”
    let hh = height.unwrap_or(44.0).max(20.0).min(300.0);
    let (wp, hp) = ((ww * scale).round() as u32, (hh * scale).round() as u32);

    // Apply size immediately (best-effort)
    let _ = ghost.set_size(PhysicalSize::new(wp, hp));

    // -----------------------------------------------------------------------
    // macOS 校准：不同 API 可能返回不同坐标系（points vs pixels / 多屏幕原点）。
    // 这里用「前端 client 点 -> 后端物理坐标」作为 ground truth，推导一个线性校正：
    // corrected = observed * k + d
    // 目标：让后端 follow 的 cursor 坐标对齐到 tauri/winit 的物理屏幕坐标系。
    // -----------------------------------------------------------------------
    let join = std::thread::spawn(move || {
        // Target 120Hz-ish; adjust if needed.
        let tick = std::time::Duration::from_millis(8);

        while !stop2.load(Ordering::Relaxed) {
            #[cfg(windows)]
            let pos = get_cursor_pos_windows();
            #[cfg(not(windows))]
            let pos: Option<(i32, i32)> = None;

            if let Some((x, y)) = pos {
                // If this ever errors (e.g. window destroyed), just stop.
                if ghost2
                    .set_position(PhysicalPosition::new(x - oxp, y - oyp))
                    .is_err()
                {
                    break;
                }
            } else {
                // If we cannot read cursor pos, yield a bit longer.
                std::thread::sleep(std::time::Duration::from_millis(16));
                continue;
            }
            std::thread::sleep(tick);
        }
    });

    let mut st = follow_state().lock().map_err(|_| "follow state poisoned".to_string())?;
    st.stop = Some(stop);
    st.join = Some(join);
    st.offset_x = oxp;
    st.offset_y = oyp;
    st.w = wp;
    st.h = hp;
    println!("[drag_ghost_follow_start] ok label={}", ghost_label);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn drag_ghost_follow_start(
    app: tauri::AppHandle,
    source_label: Option<String>,
    client_x: Option<f64>,
    client_y: Option<f64>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let ghost_label = ghost_label_for_source("main");
    let ghost = app
        .get_webview_window(&ghost_label)
        .ok_or_else(|| format!("ghost window not found: {}", ghost_label))?;

    // already running?
    {
        let st = follow_state().lock().map_err(|_| "follow state poisoned".to_string())?;
        if st.stop.is_some() {
            return Ok(());
        }
    }

    // macOS：改用 AppKit 坐标系（points, origin bottom-left），避免 CoreGraphics/winit 坐标差导致跳变。
    // - cursor: NSEvent::mouseLocation()  (points, bottom-left)
    // - move:   NSWindow::setFrameTopLeftPoint (expects top-left point in same coordinate system)
    // 计算：
    //   topLeftX = cursor.x - offsetX
    //   topLeftY = cursor.y + offsetY   (因为 offsetY 是从 top 向下，屏幕坐标 y 向上)

    let ns_window_ptr = ghost.ns_window().map_err(|e| e.to_string())?;
    if ns_window_ptr.is_null() {
        return Err("ns_window is null".to_string());
    }
    // `run_on_main_thread` requires `Send` captures; raw pointers are not `Send`.
    // Store as integer and cast back inside the main-thread closure.
    let ns_window_ptr = ns_window_ptr as usize;

    let ox = offset_x.unwrap_or(14.0).max(-4096.0).min(4096.0);
    let oy = offset_y.unwrap_or(18.0).max(-4096.0).min(4096.0);

    // Save offsets in follow state (for debug / other paths)
    if let Ok(mut st) = follow_state().lock() {
        st.offset_x = ox.round() as i32;
        st.offset_y = oy.round() as i32;
        let _ = (width, height, source_label, client_x, client_y);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();

    // Prime: position once immediately on main thread.
    {
        let ns_window_ptr = ns_window_ptr;
        let ox = ox;
        let oy = oy;
        let _ = app.run_on_main_thread(move || {
            let mtm = unsafe { MainThreadMarker::new_unchecked() };
            let _ = mtm;
            let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *mut std::ffi::c_void).cast() };
            let cur = NSEvent::mouseLocation();
            let top_left = NSPoint::new(cur.x - ox, cur.y + oy);
            ns_window.setFrameTopLeftPoint(top_left);
        });
    }

    let handle = app.clone();
    let join = std::thread::spawn(move || {
        let tick = std::time::Duration::from_millis(16); // 60fps-ish; smooth enough, avoids main-thread queue pressure

        while !stop2.load(Ordering::Relaxed) {
            let ns_window_ptr = ns_window_ptr;
            let ox = ox;
            let oy = oy;
            let _ = handle.run_on_main_thread(move || {
                let mtm = unsafe { MainThreadMarker::new_unchecked() };
                let _ = mtm;
                let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *mut std::ffi::c_void).cast() };
                let cur = NSEvent::mouseLocation();
                let top_left = NSPoint::new(cur.x - ox, cur.y + oy);
                ns_window.setFrameTopLeftPoint(top_left);
            });
            std::thread::sleep(tick);
        }
    });

    let mut st = follow_state().lock().map_err(|_| "follow state poisoned".to_string())?;
    st.stop = Some(stop);
    st.join = Some(join);
    println!("[drag_ghost_follow_start][mac] ok label={}", ghost_label);
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
#[tauri::command]
pub fn drag_ghost_follow_start(
    _app: tauri::AppHandle,
    _source_label: Option<String>,
    _client_x: Option<f64>,
    _client_y: Option<f64>,
    _offset_x: Option<f64>,
    _offset_y: Option<f64>,
    _width: Option<f64>,
    _height: Option<f64>,
) -> Result<(), String> {
    Err("drag_ghost_follow_start is only supported on Windows/macOS".to_string())
}

#[tauri::command]
pub fn drag_ghost_follow_stop() -> Result<(), String> {
    let mut st = follow_state().lock().map_err(|_| "follow state poisoned".to_string())?;
    if let Some(stop) = st.stop.take() {
        stop.store(true, Ordering::Relaxed);
    }
    if let Some(join) = st.join.take() {
        // Avoid blocking caller thread; join in background.
        std::thread::spawn(move || {
            let _ = join.join();
        });
    }
    st.offset_x = 0;
    st.offset_y = 0;
    st.w = 0;
    st.h = 0;
    println!("[drag_ghost_follow_stop] ok");
    Ok(())
}

#[tauri::command]
pub fn drag_ghost_destroy(
    app: tauri::AppHandle,
    source_label: Option<String>,
) -> Result<(), String> {
    // best-effort stop follow loop first
    let _ = drag_ghost_follow_stop();

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
        let _ = ghost.hide();
        #[cfg(debug_assertions)]
        println!("[drag_ghost_destroy] hide label={}", ghost_label);
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
    width: Option<f64>,
    height: Option<f64>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
) -> Result<(), String> {
    drag_ghost_create(app, title, source_label, width, height, offset_x, offset_y)
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
