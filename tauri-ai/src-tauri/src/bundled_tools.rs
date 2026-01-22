use std::env;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri::Manager;

pub fn init(app: &AppHandle) {
    if let Err(err) = try_init(app) {
        eprintln!("[Backend] 初始化内置工具失败: {err}");
    }
}

fn try_init(app: &AppHandle) -> Result<(), String> {
    let platform_dir = platform_dir();
    let exe_name = if cfg!(windows) { "rg.exe" } else { "rg" };

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;

    let rg_dir = resource_dir.join("rg").join(platform_dir);
    let rg_path = rg_dir.join(exe_name);

    if rg_path.exists() {
        prepend_to_path(&rg_dir)?;
        println!("[Backend] 已将 rg 目录加入 PATH: {}", rg_dir.display());
        return Ok(());
    }

    // 开发模式兜底：资源可能尚未复制到 target 目录，尝试从源码目录读取。
    #[cfg(debug_assertions)]
    {
        let fallback_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("rg")
            .join(platform_dir);
        let fallback_rg = fallback_dir.join(exe_name);

        if fallback_rg.exists() {
            prepend_to_path(&fallback_dir)?;
            println!(
                "[Backend] 已将 rg(源码兜底)目录加入 PATH: {}",
                fallback_dir.display()
            );
            return Ok(());
        }
    }

    println!(
        "[Backend] 未找到 rg 资源，跳过 PATH 注入。期望路径: {}",
        rg_path.display()
    );
    Ok(())
}

fn platform_dir() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("windows", "x86_64") => "windows-x64",
        ("windows", "aarch64") => "windows-arm64",
        // 其他平台暂不内置
        _ => "unknown",
    }
}

fn prepend_to_path(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!("PATH 注入目录必须是绝对路径: {}", dir.display()));
    }

    let current = env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<PathBuf> = env::split_paths(&current).collect();

    if paths.iter().any(|p| p == dir) {
        return Ok(());
    }

    paths.insert(0, dir.to_path_buf());
    let joined = env::join_paths(paths).map_err(|e| format!("拼接 PATH 失败: {e}"))?;
    env::set_var("PATH", &joined);
    Ok(())
}

