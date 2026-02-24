use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Url};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::models::Workstudio;

use super::types::{LspEvent, LspEventPayload, LspLaunchConfig, LspServerStatus, LSP_EVENT_NAME};

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSpawnProgram {
    pub(crate) program: String,
    pub(crate) prefix_args: Vec<String>,
    pub(crate) target: String,
    pub(crate) via: String,
    pub(crate) warnings: Vec<String>,
}

pub(crate) fn resolve_lsp_spawn_program(
    raw_command: &str,
    ws_main_folder: &str,
    launch_env: &[(String, String)],
) -> Result<ResolvedSpawnProgram, String> {
    let mut warnings: Vec<String> = Vec::new();

    let command = normalize_command_token(raw_command);
    if command.is_empty() {
        return Err("LSP command 为空".to_string());
    }

    let command = if cfg!(target_os = "windows") {
        expand_windows_env_vars(command, launch_env)
    } else {
        command.to_string()
    };

    let ws_main_folder = ws_main_folder.trim();

    let (target_path, via) = if is_path_like_command(&command) {
        let raw_path = PathBuf::from(&command);
        let via = if raw_path.is_absolute() {
            "absolute_path".to_string()
        } else {
            "workspace_relative".to_string()
        };
        let base = if raw_path.is_absolute() || ws_main_folder.is_empty() {
            raw_path
        } else {
            Path::new(ws_main_folder).join(raw_path)
        };
        let found = find_executable_with_pathext(&base, launch_env)?;
        (found, via)
    } else {
        let mut search_dirs: Vec<PathBuf> = Vec::new();
        if !ws_main_folder.is_empty() {
            search_dirs.push(PathBuf::from(ws_main_folder));
        }

        if let Some(path_var) =
            get_env_var_from_launch_env(launch_env, "PATH").or_else(|| std::env::var("PATH").ok())
        {
            let separator = if cfg!(target_os = "windows") {
                ';'
            } else {
                ':'
            };
            for part in path_var.split(separator) {
                let mut dir = normalize_path_list_item(part).to_string();
                if cfg!(target_os = "windows") {
                    dir = expand_windows_env_vars(&dir, launch_env);
                }
                if dir.is_empty() {
                    continue;
                }
                search_dirs.push(PathBuf::from(dir));
            }
        } else {
            warnings.push(
                "[lsp] 启动诊断：PATH 环境变量为空，可能无法自动找到语言服务器可执行文件。"
                    .to_string(),
            );
        }

        let pathext = if cfg!(target_os = "windows") {
            get_env_var_from_launch_env(launch_env, "PATHEXT")
                .or_else(|| std::env::var("PATHEXT").ok())
        } else {
            None
        };
        let exts = pathext_extensions(pathext.as_deref());

        let (found, found_dir_idx, skipped_448, other_errors) =
            find_executable_in_dirs(&command, &search_dirs, &exts);
        if !skipped_448.is_empty() {
            warnings.push(format!(
                "[lsp] 启动诊断：PATH 中有 {} 个目录触发 Windows 448（不受信任的挂载点），已自动跳过。",
                skipped_448.len()
            ));
        }
        if !other_errors.is_empty() {
            warnings.push(format!(
                "[lsp] 启动诊断：PATH 扫描时遇到 {} 个目录异常（已忽略）。",
                other_errors.len()
            ));
        }

        let (found, via) = if let Some(p) = found {
            let via = if found_dir_idx == Some(0) && !ws_main_folder.is_empty() {
                "workspace".to_string()
            } else {
                "PATH".to_string()
            };
            (p, via)
        } else if cfg!(target_os = "windows") {
            // 兜底（产品级）：开始菜单启动时，Explorer 进程的 PATH 可能没刷新（安装 Rust 后需重启 Explorer/注销）。
            // 因此不只依赖 PATH：额外探测 CARGO_HOME/bin、RUSTUP_HOME/toolchains/*/bin，以及 VS Code rust-analyzer 扩展（若存在）。

            if let Some(dir) = cargo_bin_dir(launch_env) {
                let (p, _idx, _s1, _s2) = find_executable_in_dirs(&command, &[dir.clone()], &exts);
                if let Some(p) = p {
                    warnings.push(format!(
                        "[lsp] 启动诊断：未在 PATH 中找到可执行文件，已从 cargo bin 目录兜底解析：{}",
                        dir.to_string_lossy()
                    ));
                    (p, "cargo_bin".to_string())
                } else {
                    let bins = rustup_toolchain_bin_dirs(launch_env);
                    if !bins.is_empty() {
                        let (p2, _idx2, _s3, _s4) = find_executable_in_dirs(&command, &bins, &exts);
                        if let Some(p2) = p2 {
                            warnings.push("[lsp] 启动诊断：未在 PATH 中找到可执行文件，已从 rustup toolchains 目录兜底解析。".to_string());
                            (p2, "rustup_toolchains".to_string())
                        } else if command.eq_ignore_ascii_case("rust-analyzer") {
                            if let Some(vscode_ra) = find_vscode_rust_analyzer() {
                                warnings.push("[lsp] 启动诊断：未在 PATH 中找到 rust-analyzer，已从 VS Code 扩展目录兜底解析。".to_string());
                                (vscode_ra, "vscode_extension".to_string())
                            } else {
                                (PathBuf::from(&command), "unresolved".to_string())
                            }
                        } else {
                            (PathBuf::from(&command), "unresolved".to_string())
                        }
                    } else if command.eq_ignore_ascii_case("rust-analyzer") {
                        if let Some(vscode_ra) = find_vscode_rust_analyzer() {
                            warnings.push("[lsp] 启动诊断：未在 PATH 中找到 rust-analyzer，已从 VS Code 扩展目录兜底解析。".to_string());
                            (vscode_ra, "vscode_extension".to_string())
                        } else {
                            (PathBuf::from(&command), "unresolved".to_string())
                        }
                    } else {
                        (PathBuf::from(&command), "unresolved".to_string())
                    }
                }
            } else {
                let bins = rustup_toolchain_bin_dirs(launch_env);
                if !bins.is_empty() {
                    let (p2, _idx2, _s3, _s4) = find_executable_in_dirs(&command, &bins, &exts);
                    if let Some(p2) = p2 {
                        warnings.push("[lsp] 启动诊断：未在 PATH 中找到可执行文件，已从 rustup toolchains 目录兜底解析。".to_string());
                        (p2, "rustup_toolchains".to_string())
                    } else if command.eq_ignore_ascii_case("rust-analyzer") {
                        if let Some(vscode_ra) = find_vscode_rust_analyzer() {
                            warnings.push("[lsp] 启动诊断：未在 PATH 中找到 rust-analyzer，已从 VS Code 扩展目录兜底解析。".to_string());
                            (vscode_ra, "vscode_extension".to_string())
                        } else {
                            (PathBuf::from(&command), "unresolved".to_string())
                        }
                    } else {
                        (PathBuf::from(&command), "unresolved".to_string())
                    }
                } else if command.eq_ignore_ascii_case("rust-analyzer") {
                    if let Some(vscode_ra) = find_vscode_rust_analyzer() {
                        warnings.push("[lsp] 启动诊断：未在 PATH 中找到 rust-analyzer，已从 VS Code 扩展目录兜底解析。".to_string());
                        (vscode_ra, "vscode_extension".to_string())
                    } else {
                        (PathBuf::from(&command), "unresolved".to_string())
                    }
                } else {
                    (PathBuf::from(&command), "unresolved".to_string())
                }
            }
        } else {
            (PathBuf::from(&command), "unresolved".to_string())
        };

        if !found.is_absolute() {
            let mut err = if cfg!(target_os = "windows")
                && command.eq_ignore_ascii_case("rust-analyzer")
            {
                format!(
                    "未找到可执行文件：{command}。请在 设置 → Code Intelligence 中把 command 填成绝对路径，或安装 rust-analyzer（例如 rustup component add rust-analyzer）。另外：从开始菜单启动时 Explorer 的 PATH 可能未刷新，可尝试重启资源管理器或注销/重启系统。"
                )
            } else {
                format!(
                    "未找到可执行文件：{}。请在 设置 → Code Intelligence 中把 command 填成绝对路径，或确认该命令在 PATH 中可用。",
                    command
                )
            };

            if cfg!(target_os = "windows") {
                let mut diag: Vec<String> = Vec::new();
                if let Some(dir) = cargo_bin_dir(launch_env) {
                    diag.push(format!("cargo_bin={}", dir.to_string_lossy()));
                }
                let bins = rustup_toolchain_bin_dirs(launch_env);
                if !bins.is_empty() {
                    diag.push(format!("rustup_toolchains_bins={}", bins.len()));
                }
                if command.eq_ignore_ascii_case("rust-analyzer") {
                    let home = dirs::home_dir()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "<unknown>".to_string());
                    diag.push(format!("home={home}"));
                }
                if !diag.is_empty() {
                    err.push_str(&format!("（诊断：{}）", diag.join("; ")));
                }
            }
            return Err(err);
        }

        (found, via)
    };

    let target = target_path.to_string_lossy().to_string();
    let ext = target_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if cfg!(target_os = "windows") && (ext == "cmd" || ext == "bat") {
        let comspec = std::env::var("COMSPEC")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| r"C:\Windows\System32\cmd.exe".to_string());
        Ok(ResolvedSpawnProgram {
            program: comspec,
            prefix_args: vec!["/C".to_string(), target.clone()],
            target,
            via,
            warnings,
        })
    } else {
        Ok(ResolvedSpawnProgram {
            program: target.clone(),
            prefix_args: Vec::new(),
            target,
            via,
            warnings,
        })
    }
}

fn normalize_command_token(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return &s[1..s.len() - 1];
    }
    s
}

fn is_path_like_command(command: &str) -> bool {
    if command.contains('/') || command.contains('\\') {
        return true;
    }
    // Windows drive letter form: C:...
    if cfg!(target_os = "windows") {
        let bytes = command.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' {
            return true;
        }
    }
    false
}

fn normalize_path_list_item(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return &s[1..s.len() - 1];
    }
    s
}

fn get_env_var_from_launch_env(launch_env: &[(String, String)], key: &str) -> Option<String> {
    let key_trim = key.trim();
    if key_trim.is_empty() {
        return None;
    }
    for (k, v) in launch_env {
        if cfg!(target_os = "windows") {
            if k.eq_ignore_ascii_case(key_trim) {
                return Some(v.clone());
            }
        } else if k == key_trim {
            return Some(v.clone());
        }
    }
    None
}

fn expand_windows_env_vars(input: &str, launch_env: &[(String, String)]) -> String {
    // Minimal %VAR% expansion to make config friendlier on Windows.
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        rest = &rest[start + 1..];

        let Some(end) = rest.find('%') else {
            out.push('%');
            out.push_str(rest);
            return out;
        };

        let var = &rest[..end];
        if var.is_empty() {
            out.push('%');
            rest = &rest[end + 1..];
            continue;
        }

        let val = get_env_var_from_launch_env(launch_env, var)
            .or_else(|| std::env::var(var).ok())
            .unwrap_or_else(|| format!("%{var}%"));
        out.push_str(&val);
        rest = &rest[end + 1..];
    }

    out.push_str(rest);
    out
}

fn pathext_extensions(pathext: Option<&str>) -> Vec<String> {
    if !cfg!(target_os = "windows") {
        return vec![String::new()];
    }
    let raw = pathext.unwrap_or(".COM;.EXE;.BAT;.CMD");
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(';') {
        let ext = part.trim();
        if ext.is_empty() {
            continue;
        }
        let ext = ext.trim_start_matches('.').to_ascii_lowercase();
        if ext.is_empty() {
            continue;
        }
        out.push(ext);
    }
    if out.is_empty() {
        out.push("exe".to_string());
    }
    out
}

fn cargo_bin_dir(launch_env: &[(String, String)]) -> Option<PathBuf> {
    let raw = get_env_var_from_launch_env(launch_env, "CARGO_HOME")
        .or_else(|| std::env::var("CARGO_HOME").ok());
    let base = if let Some(raw) = raw {
        let mut s = normalize_path_list_item(raw.trim()).to_string();
        if cfg!(target_os = "windows") {
            s = expand_windows_env_vars(&s, launch_env);
        }
        let p = PathBuf::from(s);
        if !p.as_os_str().is_empty() {
            Some(p)
        } else {
            None
        }
    } else {
        dirs::home_dir().map(|home| home.join(".cargo"))
    }?;

    let file_name = base
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name == "bin" {
        Some(base)
    } else {
        Some(base.join("bin"))
    }
}

fn rustup_toolchain_bin_dirs(launch_env: &[(String, String)]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if !cfg!(target_os = "windows") {
        return out;
    }

    let raw = get_env_var_from_launch_env(launch_env, "RUSTUP_HOME")
        .or_else(|| std::env::var("RUSTUP_HOME").ok());
    let base = if let Some(raw) = raw {
        let mut s = normalize_path_list_item(raw.trim()).to_string();
        s = expand_windows_env_vars(&s, launch_env);
        PathBuf::from(s)
    } else if let Some(home) = dirs::home_dir() {
        home.join(".rustup")
    } else {
        return out;
    };

    let toolchains_dir = base.join("toolchains");
    let rd = match std::fs::read_dir(&toolchains_dir) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if let Ok(ft) = entry.file_type() {
            if !ft.is_dir() {
                continue;
            }
        }
        out.push(path.join("bin"));
    }

    out.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    out
}

fn find_vscode_rust_analyzer() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }

    let home = dirs::home_dir()?;
    let roots = [
        home.join(".vscode").join("extensions"),
        home.join(".vscode-insiders").join("extensions"),
        home.join(".cursor").join("extensions"),
    ];

    for root in roots {
        let rd = match std::fs::read_dir(&root) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for entry in rd.flatten() {
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !ft.is_dir() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if !(name == "rust-lang.rust-analyzer" || name.starts_with("rust-lang.rust-analyzer-"))
            {
                continue;
            }

            let ext_dir = entry.path();
            let candidates = [
                ext_dir.join("server").join("rust-analyzer.exe"),
                ext_dir.join("server").join("rust-analyzer"),
                ext_dir
                    .join("server")
                    .join("rust-analyzer-x86_64-pc-windows-msvc.exe"),
                ext_dir.join("server").join("rust-analyzer-win32-x64.exe"),
            ];
            for c in candidates {
                if let Ok(m) = std::fs::metadata(&c) {
                    if m.is_file() {
                        return Some(c);
                    }
                }
            }

            // Fallback: scan server/ directory for rust-analyzer*.exe
            let server_dir = ext_dir.join("server");
            let srd = match std::fs::read_dir(&server_dir) {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            for e2 in srd.flatten() {
                let p = e2.path();
                let Ok(m) = std::fs::metadata(&p) else {
                    continue;
                };
                if !m.is_file() {
                    continue;
                }
                let fname = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if fname.starts_with("rust-analyzer") && fname.ends_with(".exe") {
                    return Some(p);
                }
            }
        }
    }

    None
}

fn find_executable_with_pathext(
    base: &Path,
    launch_env: &[(String, String)],
) -> Result<PathBuf, String> {
    match std::fs::metadata(base) {
        Ok(m) => {
            if m.is_file() {
                return Ok(base.to_path_buf());
            }
            return Err(format!("目标不是文件：{}", base.to_string_lossy()));
        }
        Err(e) => {
            if cfg!(target_os = "windows") && e.raw_os_error() == Some(448) {
                return Err(format!(
                    "路径不可遍历（Windows 448：不受信任的挂载点）：{}",
                    base.to_string_lossy()
                ));
            }
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("访问路径失败：{}: {}", base.to_string_lossy(), e));
            }
        }
    }

    if !cfg!(target_os = "windows") {
        return Err(format!("未找到可执行文件：{}", base.to_string_lossy()));
    }

    if base.extension().is_some() {
        return Err(format!("未找到可执行文件：{}", base.to_string_lossy()));
    }

    let pathext = get_env_var_from_launch_env(launch_env, "PATHEXT")
        .or_else(|| std::env::var("PATHEXT").ok());
    let exts = pathext_extensions(pathext.as_deref());
    for ext in exts {
        let candidate = base.with_extension(ext);
        match std::fs::metadata(&candidate) {
            Ok(m) => {
                if m.is_file() {
                    return Ok(candidate);
                }
            }
            Err(e) => {
                if cfg!(target_os = "windows") && e.raw_os_error() == Some(448) {
                    return Err(format!(
                        "路径不可遍历（Windows 448：不受信任的挂载点）：{}",
                        candidate.to_string_lossy()
                    ));
                }
                if e.kind() == std::io::ErrorKind::NotFound {
                    continue;
                }
                return Err(format!(
                    "访问路径失败：{}: {}",
                    candidate.to_string_lossy(),
                    e
                ));
            }
        }
    }

    Err(format!("未找到可执行文件：{}", base.to_string_lossy()))
}

fn find_executable_in_dirs(
    command: &str,
    dirs: &[PathBuf],
    exts: &[String],
) -> (Option<PathBuf>, Option<usize>, Vec<String>, Vec<String>) {
    let has_ext = Path::new(command).extension().is_some();
    let mut skipped_448: Vec<String> = Vec::new();
    let mut other_errors: Vec<String> = Vec::new();

    for (idx, dir) in dirs.iter().enumerate() {
        let base = dir.join(command);
        let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") && !has_ext {
            exts.iter().map(|e| base.with_extension(e)).collect()
        } else {
            vec![base]
        };

        for c in candidates {
            match std::fs::metadata(&c) {
                Ok(m) => {
                    if m.is_file() {
                        return (Some(c), Some(idx), skipped_448, other_errors);
                    }
                }
                Err(e) => {
                    if cfg!(target_os = "windows") && e.raw_os_error() == Some(448) {
                        skipped_448.push(dir.to_string_lossy().to_string());
                        break;
                    }
                    if e.kind() == std::io::ErrorKind::NotFound {
                        continue;
                    }
                    other_errors.push(format!("{}: {}", c.to_string_lossy(), e));
                }
            }
        }
    }

    (None, None, skipped_448, other_errors)
}

// NOTE:
// - 这里实现的是一个“够用且可扩展”的 LSP stdio JSON-RPC 传输层。
// - 目标：支撑 Workstudio 的定义/引用/悬停/补全/诊断（VS Code-like 体验）
// - 不追求 100% 覆盖 VS Code 的客户端实现；对 server->client 的 request 做了必要兜底。

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LspKey {
    workstudio_id: String,
    language_id: String,
}

#[derive(Debug, Default)]
struct LspServerState {
    child: Option<tokio::process::Child>,
    stdin: Option<tokio::process::ChildStdin>,
    started: bool,
    initialized: bool,
    last_error: Option<String>,
}

#[derive(Debug, Default)]
struct PendingRequests {
    by_id: HashMap<i64, oneshot::Sender<serde_json::Value>>,
}

pub struct LspManager {
    app: AppHandle,
    servers: Mutex<HashMap<LspKey, Arc<LspServer>>>,
}

impl LspManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            servers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn ensure(
        &self,
        ws: &Workstudio,
        language_id: &str,
        launch: LspLaunchConfig,
    ) -> Result<Arc<LspServer>, String> {
        let key = LspKey {
            workstudio_id: ws.id.clone(),
            language_id: language_id.to_string(),
        };

        let mut old_to_shutdown: Option<Arc<LspServer>> = None;
        let server = {
            let mut map = self.servers.lock().await;
            if let Some(existing) = map.get(&key).cloned() {
                if existing.same_launch(&launch) {
                    existing
                } else {
                    old_to_shutdown = map.remove(&key);
                    let next = Arc::new(LspServer::new(
                        self.app.clone(),
                        ws.id.clone(),
                        language_id.to_string(),
                        ws.main_folder.clone(),
                        ws.folders.clone(),
                        launch,
                    ));
                    map.insert(key, next.clone());
                    next
                }
            } else {
                let next = Arc::new(LspServer::new(
                    self.app.clone(),
                    ws.id.clone(),
                    language_id.to_string(),
                    ws.main_folder.clone(),
                    ws.folders.clone(),
                    launch,
                ));
                map.insert(key, next.clone());
                next
            }
        };

        if let Some(old) = old_to_shutdown {
            let _ = old.shutdown().await;
        }

        server.ensure_started_and_initialized(ws).await?;
        Ok(server)
    }

    pub async fn shutdown_workstudio(&self, workstudio_id: &str) {
        let mut servers = Vec::new();
        {
            let mut map = self.servers.lock().await;
            let keys: Vec<LspKey> = map
                .keys()
                .filter(|k| k.workstudio_id == workstudio_id)
                .cloned()
                .collect();
            for k in keys {
                if let Some(s) = map.remove(&k) {
                    servers.push(s);
                }
            }
        }

        for s in servers {
            let _ = s.shutdown().await;
        }
    }

    pub async fn shutdown_language(&self, workstudio_id: &str, language_id: &str) {
        let server = {
            let mut map = self.servers.lock().await;
            let key = LspKey {
                workstudio_id: workstudio_id.to_string(),
                language_id: language_id.to_string(),
            };
            map.remove(&key)
        };

        if let Some(s) = server {
            let _ = s.shutdown().await;
        }
    }

    pub async fn status(&self, workstudio_id: &str) -> Vec<LspServerStatus> {
        let map = self.servers.lock().await;
        let mut out = Vec::new();
        for (k, s) in map.iter() {
            if k.workstudio_id != workstudio_id {
                continue;
            }
            out.push(s.status().await);
        }
        out
    }
}

pub struct LspServer {
    app: AppHandle,
    workstudio_id: String,
    language_id: String,
    main_folder: String,
    folders: Vec<String>,
    launch: LspLaunchConfig,

    next_id: AtomicI64,
    pending: Mutex<PendingRequests>,
    state: Mutex<LspServerState>,
    start_gate: Mutex<()>,
    init_gate: Mutex<()>,
}

impl LspServer {
    fn new(
        app: AppHandle,
        workstudio_id: String,
        language_id: String,
        main_folder: String,
        folders: Vec<String>,
        launch: LspLaunchConfig,
    ) -> Self {
        Self {
            app,
            workstudio_id,
            language_id,
            main_folder,
            folders,
            launch,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(PendingRequests::default()),
            state: Mutex::new(LspServerState::default()),
            start_gate: Mutex::new(()),
            init_gate: Mutex::new(()),
        }
    }

    fn same_launch(&self, other: &LspLaunchConfig) -> bool {
        self.launch.language_id == other.language_id
            && self.launch.command == other.command
            && self.launch.args == other.args
            && self.launch.env == other.env
            && self.launch.initialization_options == other.initialization_options
            && self.launch.settings == other.settings
    }

    pub async fn status(&self) -> LspServerStatus {
        let st = self.state.lock().await;
        LspServerStatus {
            workstudio_id: self.workstudio_id.clone(),
            language_id: self.language_id.clone(),
            started: st.started,
            initialized: st.initialized,
            command: Some(self.launch.command.clone()),
            args: Some(self.launch.args.clone()),
            last_error: st.last_error.clone(),
        }
    }

    async fn ensure_started_and_initialized(
        self: &Arc<Self>,
        ws: &Workstudio,
    ) -> Result<(), String> {
        self.ensure_started(ws).await?;
        self.ensure_initialized(ws).await?;
        Ok(())
    }

    async fn ensure_started(self: &Arc<Self>, ws: &Workstudio) -> Result<(), String> {
        let _gate = self.start_gate.lock().await;
        {
            let st = self.state.lock().await;
            if st.started {
                return Ok(());
            }
            // 产品级策略：启动失败后不反复重试（避免每次请求/点击都 spawn 一次）。
            // 需要用户手动修复配置后重启 LSP（或重启 Workstudio/应用）。
            if let Some(err) = st.last_error.clone() {
                return Err(err);
            }
        }

        let command = self.launch.command.trim();
        if command.is_empty() {
            let err = "LSP command 为空".to_string();
            self.set_last_error(err.clone()).await;
            return Err(err);
        }

        let cwd = ws.main_folder.trim();
        let resolved = match resolve_lsp_spawn_program(command, cwd, &self.launch.env) {
            Ok(r) => r,
            Err(e) => {
                let err = format!("解析 LSP 启动命令失败: {e}");
                self.set_last_error(err.clone()).await;
                self.emit(LspEvent::Stderr {
                    line: format!("[lsp] {err}"),
                });
                return Err(err);
            }
        };

        for w in &resolved.warnings {
            self.emit(LspEvent::Stderr { line: w.clone() });
        }

        let mut spawn_cwd: Option<&str> = if cwd.is_empty() { None } else { Some(cwd) };
        if cfg!(target_os = "windows") {
            if let Some(cwd) = spawn_cwd {
                match std::fs::metadata(cwd) {
                    Ok(_) => {}
                    Err(e) => {
                        if e.raw_os_error() == Some(448) {
                            self.emit(LspEvent::Stderr {
                                line: format!(
                                    "[lsp] 警告：工作区目录包含不受信任的挂载点（Windows 448），将不设置 current_dir 启动。cwd={}",
                                    cwd
                                ),
                            });
                        } else {
                            self.emit(LspEvent::Stderr {
                                line: format!(
                                    "[lsp] 警告：无法访问工作区目录，将不设置 current_dir 启动。cwd={} err={}",
                                    cwd, e
                                ),
                            });
                        }
                        spawn_cwd = None;
                    }
                }
            }
        }
        self.emit(LspEvent::Stderr {
            line: format!(
                "[lsp] 启动：languageId={} command={} resolvedTarget={} via={} program={} prefixArgs={:?} spawnCwd={} args={:?}",
                self.language_id,
                command,
                resolved.target,
                resolved.via,
                resolved.program,
                resolved.prefix_args,
                spawn_cwd.unwrap_or("<none>"),
                self.launch.args
            ),
        });

        let spawn_once = |cwd: Option<&str>| -> Result<tokio::process::Child, std::io::Error> {
            let mut cmd = Command::new(&resolved.program);
            cmd.args(&resolved.prefix_args);
            cmd.args(&self.launch.args);

            // 尽量在项目根目录下运行（对 rust-analyzer/cargo 等更友好）。
            // 但在 Windows 上，某些路径（包含“不受信任的挂载点”）会导致 CreateProcess 直接失败（os error 448）。
            // 此时退化为“不设置 current_dir”依然可用，因为我们会在 initialize 里传 rootUri/workspaceFolders。
            if let Some(cwd) = cwd {
                let cwd = cwd.trim();
                if !cwd.is_empty() {
                    cmd.current_dir(cwd);
                }
            }

            for (k, v) in &self.launch.env {
                cmd.env(k, v);
            }

            cmd.stdin(Stdio::piped());
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            cmd.spawn()
        };

        let mut spawn_errors: Vec<String> = Vec::new();
        let mut child = match spawn_once(spawn_cwd) {
            Ok(c) => c,
            Err(e) => {
                spawn_errors.push(format!("cwd={}: {e}", spawn_cwd.unwrap_or("<none>")));

                // Windows: ERROR_UNTRUSTED_MOUNT_POINT (448)
                let should_retry_without_cwd = cfg!(target_os = "windows")
                    && e.raw_os_error() == Some(448)
                    && spawn_cwd.is_some();
                if should_retry_without_cwd {
                    self.emit(LspEvent::Stderr {
                        line: format!(
                            "[lsp] 警告：无法使用工作区目录作为工作目录启动（Windows 448：不受信任的挂载点）。已退化为默认工作目录启动。cwd={}",
                                cwd
                            ),
                        });
                    match spawn_once(None) {
                        Ok(c) => c,
                        Err(e2) => {
                            spawn_errors.push(format!("cwd=<none>: {e2}"));
                            let err = format!(
                                "启动 LSP 失败: {e2}（已尝试回退启动；详情：{}；resolvedTarget={} program={}）",
                                spawn_errors.join(" | "),
                                resolved.target,
                                resolved.program
                            );
                            self.set_last_error(err.clone()).await;
                            return Err(err);
                        }
                    }
                } else {
                    let err = format!(
                        "启动 LSP 失败: {e}（resolvedTarget={} program={}）",
                        resolved.target, resolved.program
                    );
                    self.set_last_error(err.clone()).await;
                    return Err(err);
                }
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 LSP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 LSP stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法获取 LSP stderr".to_string())?;

        {
            let mut st = self.state.lock().await;
            st.child = Some(child);
            st.stdin = Some(stdin);
            st.started = true;
            st.last_error = None;
        }

        // Background tasks
        {
            let server = Arc::clone(self);
            tokio::spawn(async move {
                server.read_stdout_loop(stdout).await;
            });
        }
        {
            let server = Arc::clone(self);
            tokio::spawn(async move {
                server.read_stderr_loop(stderr).await;
            });
        }
        {
            let server = Arc::clone(self);
            tokio::spawn(async move {
                server.monitor_exit_loop().await;
            });
        }

        Ok(())
    }

    async fn ensure_initialized(self: &Arc<Self>, ws: &Workstudio) -> Result<(), String> {
        let _gate = self.init_gate.lock().await;
        {
            let st = self.state.lock().await;
            if st.initialized {
                return Ok(());
            }
            if !st.started {
                let err = "LSP 尚未启动".to_string();
                drop(st);
                self.set_last_error(err.clone()).await;
                return Err(err);
            }
        }

        let root_uri = file_uri(&ws.main_folder).ok();
        let workspace_folders = workspace_folders_value(&ws.main_folder, &ws.folders);

        let init_params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "workspaceFolders": workspace_folders,
            "capabilities": {
                "workspace": {
                    "workspaceFolders": true,
                    "configuration": true,
                    "applyEdit": false
                },
                "window": {
                    "workDoneProgress": true
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "willSave": false,
                        "didSave": true,
                        "willSaveWaitUntil": false
                    },
                    "definition": { "dynamicRegistration": false, "linkSupport": true },
                    "typeDefinition": { "dynamicRegistration": false, "linkSupport": true },
                    "references": { "dynamicRegistration": false },
                    "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
                    "completion": {
                        "dynamicRegistration": false,
                        "completionItem": {
                            "snippetSupport": false,
                            "documentationFormat": ["markdown", "plaintext"]
                        }
                    },
                    "documentSymbol": {
                        "dynamicRegistration": false,
                        "hierarchicalDocumentSymbolSupport": true
                    }
                }
            },
            "initializationOptions": self.launch.initialization_options,
            "clientInfo": { "name": "TauriAI", "version": env!("CARGO_PKG_VERSION") },
            "trace": "off"
        });

        // initialize -> initialized
        if let Err(e) = self
            .request("initialize", init_params, Some(Duration::from_secs(30)))
            .await
        {
            self.set_last_error(e.clone()).await;
            return Err(e);
        }
        if let Err(e) = self.notify("initialized", json!({})).await {
            self.set_last_error(e.clone()).await;
            return Err(e);
        }

        // Best-effort configuration push（部分 server 会忽略，转而 pull workspace/configuration）
        let _ = self
            .notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": self.launch.settings }),
            )
            .await;

        {
            let mut st = self.state.lock().await;
            st.initialized = true;
            st.last_error = None;
        }

        Ok(())
    }

    pub async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Option<Duration>,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        {
            let mut pending = self.pending.lock().await;
            pending.by_id.insert(id, tx);
        }

        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;

        let msg = if let Some(t) = timeout {
            match tokio::time::timeout(t, rx).await {
                Ok(Ok(v)) => v,
                Ok(Err(_)) => return Err("LSP 请求被取消".to_string()),
                Err(_) => return Err(format!("LSP 请求超时: {method}")),
            }
        } else {
            rx.await.map_err(|_| "LSP 请求被取消".to_string())?
        };

        if let Some(err) = msg.get("error") {
            return Err(format!("LSP error: {err}"));
        }
        Ok(msg
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        // Graceful shutdown first
        let _ = self
            .request("shutdown", json!({}), Some(Duration::from_secs(5)))
            .await;
        let _ = self.notify("exit", json!({})).await;

        // Then force kill (best-effort)
        let mut st = self.state.lock().await;
        if let Some(mut child) = st.child.take() {
            let _ = child.kill().await;
        }
        st.stdin = None;
        st.started = false;
        st.initialized = false;
        st.last_error = None;
        Ok(())
    }

    async fn send(&self, msg: serde_json::Value) -> Result<(), String> {
        let bytes = encode_lsp_message(&msg)?;
        let mut st = self.state.lock().await;
        let stdin = st
            .stdin
            .as_mut()
            .ok_or_else(|| "LSP stdin 不可用".to_string())?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("写入 LSP stdin 失败: {e}"))?;
        let _ = stdin.flush().await;
        Ok(())
    }

    async fn read_stdout_loop(self: Arc<Self>, mut stdout: tokio::process::ChildStdout) {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match read_one_lsp_message(&mut stdout, &mut buf).await {
                Ok(Some(v)) => {
                    if let Err(e) = self.handle_incoming(v).await {
                        self.set_last_error(e).await;
                    }
                }
                Ok(None) => break, // EOF
                Err(e) => {
                    self.set_last_error(e).await;
                    break;
                }
            }
        }
    }

    async fn read_stderr_loop(self: Arc<Self>, stderr: tokio::process::ChildStderr) {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    self.emit(LspEvent::Stderr {
                        line: trimmed.to_string(),
                    });
                }
                Err(_) => break,
            }
        }
    }

    async fn monitor_exit_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let status = {
                let mut st = self.state.lock().await;
                let Some(child) = st.child.as_mut() else {
                    return;
                };
                match child.try_wait() {
                    Ok(Some(s)) => {
                        st.child = None;
                        st.stdin = None;
                        st.started = false;
                        st.initialized = false;
                        Some(s)
                    }
                    Ok(None) => None,
                    Err(_) => None,
                }
            };

            if let Some(s) = status {
                self.emit(LspEvent::Exited {
                    code: s.code(),
                    signal: exit_status_signal(&s),
                });
                return;
            }
        }
    }

    async fn handle_incoming(&self, msg: serde_json::Value) -> Result<(), String> {
        // response: has id, no method
        if msg.get("id").is_some() && msg.get("method").is_none() {
            return self.handle_response(msg).await;
        }

        let method = msg
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        if method.is_empty() {
            return Ok(());
        }

        // server request -> client must respond
        if let Some(id) = msg.get("id").cloned() {
            let params = msg
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            match self.handle_server_request(&method, params).await {
                Ok(result) => {
                    let _ = self
                        .send(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": result
                        }))
                        .await;
                }
                Err(err) => {
                    let _ = self
                        .send(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32603, "message": err }
                        }))
                        .await;
                }
            }
            return Ok(());
        }

        // notification
        let params = msg
            .get("params")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        self.emit(LspEvent::Notification { method, params });
        Ok(())
    }

    async fn handle_response(&self, msg: serde_json::Value) -> Result<(), String> {
        let id = msg
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "LSP response 缺少数值 id".to_string())?;
        let tx = {
            let mut pending = self.pending.lock().await;
            pending.by_id.remove(&id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(msg);
        }
        Ok(())
    }

    async fn handle_server_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        match method {
            "workspace/configuration" => {
                let items = params
                    .get("items")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut out: Vec<serde_json::Value> = Vec::with_capacity(items.len());
                for item in items {
                    let section = item
                        .get("section")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    if section.is_empty() {
                        out.push(self.launch.settings.clone());
                        continue;
                    }
                    if let Some(v) = self.launch.settings.get(section) {
                        out.push(v.clone());
                    } else {
                        out.push(serde_json::Value::Null);
                    }
                }
                Ok(serde_json::Value::Array(out))
            }
            "workspace/workspaceFolders" => {
                Ok(workspace_folders_value(&self.main_folder, &self.folders))
            }
            "client/registerCapability" => Ok(serde_json::Value::Null),
            "client/unregisterCapability" => Ok(serde_json::Value::Null),
            "window/workDoneProgress/create" => Ok(serde_json::Value::Null),
            "workspace/semanticTokens/refresh" => Ok(serde_json::Value::Null),
            "workspace/inlayHint/refresh" => Ok(serde_json::Value::Null),
            "workspace/applyEdit" => Ok(json!({
                "applied": false,
                "failureReason": "TauriAI 暂不支持 workspace/applyEdit"
            })),
            _ => Ok(serde_json::Value::Null),
        }
    }

    async fn set_last_error(&self, err: String) {
        let mut st = self.state.lock().await;
        st.last_error = Some(err);
    }

    fn emit(&self, event: LspEvent) {
        let payload = LspEventPayload {
            workstudio_id: self.workstudio_id.clone(),
            language_id: self.language_id.clone(),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event,
        };
        let _ = self.app.emit(LSP_EVENT_NAME, payload);
    }
}

fn encode_lsp_message(msg: &serde_json::Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(msg).map_err(|e| format!("序列化 LSP JSON 失败: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

async fn read_one_lsp_message<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> Result<Option<serde_json::Value>, String> {
    loop {
        if let Some((header_len, content_len)) = try_parse_header(buf)? {
            let total_len = header_len + content_len;
            while buf.len() < total_len {
                let mut tmp = [0u8; 8192];
                let n = reader.read(&mut tmp).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(None);
                }
                buf.extend_from_slice(&tmp[..n]);
            }

            let body = buf[header_len..total_len].to_vec();
            buf.drain(0..total_len);

            let v: serde_json::Value =
                serde_json::from_slice(&body).map_err(|e| format!("解析 LSP JSON 失败: {e}"))?;
            return Ok(Some(v));
        }

        // Need more bytes to parse header.
        let mut tmp = [0u8; 8192];
        let n = reader.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

fn try_parse_header(buf: &[u8]) -> Result<Option<(usize, usize)>, String> {
    let marker = b"\r\n\r\n";
    let Some(pos) = buf.windows(marker.len()).position(|w| w == marker) else {
        return Ok(None);
    };
    let header_bytes = &buf[..pos];
    let header_str = String::from_utf8_lossy(header_bytes);
    let mut content_len: Option<usize> = None;
    for line in header_str.split("\r\n") {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            let n = rest.trim().parse::<usize>().map_err(|e| e.to_string())?;
            content_len = Some(n);
        }
    }
    let Some(len) = content_len else {
        return Err("LSP header 缺少 Content-Length".to_string());
    };
    Ok(Some((pos + marker.len(), len)))
}

fn file_uri(path: &str) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("path 为空".to_string());
    }
    Url::from_file_path(p)
        .map(|u| u.to_string())
        .map_err(|_| format!("无法转换为 file:// URI: {p}"))
}

fn workspace_folders_value(main_folder: &str, folders: &[String]) -> serde_json::Value {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut push = |p: &str| {
        if let Ok(uri) = file_uri(p) {
            let name = std::path::Path::new(p)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("workspace")
                .to_string();
            out.push(json!({ "uri": uri, "name": name }));
        }
    };
    let mf = main_folder.trim();
    if !mf.is_empty() {
        push(mf);
    }
    for f in folders {
        let f = f.trim();
        if f.is_empty() {
            continue;
        }
        push(f);
    }
    serde_json::Value::Array(out)
}

fn exit_status_signal(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
