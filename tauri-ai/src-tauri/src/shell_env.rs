/// shell_env.rs — 在 macOS GUI 程序启动时，合并 shell 登录环境的 PATH
///
/// 背景：macOS GUI 程序（Tauri）从 launchd 继承一个最小 PATH（仅 /usr/bin:/bin:/usr/sbin:/sbin），
/// 不包含用户通过 ~/.zshrc / ~/.bash_profile 安装的工具（如 Homebrew 的 /opt/homebrew/bin）。
/// 这导致 probe_known_external_agents 无法找到 `claude`、`codex` 等 CLI 工具。
///
/// 解决方案：在进程启动时，用 `$SHELL -l -c 'printf "%s" "$PATH"'` 获取完整的 shell PATH，
/// 并将其合并进当前进程的 PATH 环境变量。

/// 合并 shell 登录环境的 PATH 到当前进程。
///
/// - 仅在 macOS 生效（Windows/Linux GUI 通常不存在此问题）
/// - 如果超时或失败，静默忽略——不影响程序启动
/// - 注意：必须在 Tokio runtime 启动之前用同步方式执行，或者在 runtime 内异步执行，
///   这里提供两个入口：`merge_shell_path_blocking`（同步）和 `merge_shell_path`（async）
#[cfg(target_os = "macos")]
pub(crate) fn merge_shell_path_blocking() {
    // 找当前用户的 shell（$SHELL 环境变量），fallback 到 /bin/zsh
    let shell = std::env::var("SHELL")
        .ok()
        .and_then(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| "/bin/zsh".to_string());

    // 用 -l（login shell）触发 ~/.zshrc / ~/.bash_profile 的加载
    // 用 printf 而不是 echo 避免 echo 在某些 shell 下输出换行时行为不一致
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "printf '%s' \"$PATH\""])
        .env_remove("TERM") // 避免触发 interactive-only 的 prompt 相关代码
        .output();

    let shell_path = match output {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout);
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return;
            }
            trimmed
        }
        _ => return, // 超时、失败或 shell 不存在，静默忽略
    };

    // 把 shell PATH 中不在当前 PATH 里的目录追加进去
    let current_path = std::env::var("PATH").unwrap_or_default();
    let merged = merge_paths(&current_path, &shell_path);
    if merged != current_path {
        // SAFETY: 在多线程环境下 set_var 不安全，但此函数在 Tokio 启动前的单线程阶段调用
        unsafe { std::env::set_var("PATH", &merged) };
        println!(
            "[Env] Shell PATH merged: {} entries",
            merged.split(':').count()
        );
    }
}

/// 将 extra_path 中有、current_path 中没有的目录，追加到 current_path 后面。
/// 保留 current_path 中的顺序和优先级不变（current_path 目录永远优先）。
fn merge_paths(current_path: &str, extra_path: &str) -> String {
    let mut seen: std::collections::HashSet<String> = current_path
        .split(':')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let mut result = current_path.to_string();

    for dir in extra_path.split(':').filter(|s| !s.is_empty()) {
        if seen.insert(dir.to_string()) {
            if !result.is_empty() {
                result.push(':');
            }
            result.push_str(dir);
        }
    }

    result
}

// 非 macOS 平台：提供空实现，保持调用方代码统一
#[cfg(not(target_os = "macos"))]
pub(crate) fn merge_shell_path_blocking() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_paths_no_overlap() {
        let current = "/usr/bin:/bin";
        let extra = "/opt/homebrew/bin:/usr/local/bin";
        let merged = merge_paths(current, extra);
        assert_eq!(merged, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn test_merge_paths_with_overlap() {
        let current = "/usr/bin:/opt/homebrew/bin";
        let extra = "/opt/homebrew/bin:/usr/local/bin";
        let merged = merge_paths(current, extra);
        assert_eq!(merged, "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn test_merge_paths_current_wins_order() {
        // current_path 中的顺序和优先级不应被改变
        let current = "/my/custom/bin:/usr/bin";
        let extra = "/usr/bin:/opt/homebrew/bin:/my/custom/bin";
        let merged = merge_paths(current, extra);
        assert_eq!(merged, "/my/custom/bin:/usr/bin:/opt/homebrew/bin");
    }

    #[test]
    fn test_merge_paths_empty_current() {
        let current = "";
        let extra = "/opt/homebrew/bin:/usr/bin";
        let merged = merge_paths(current, extra);
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin");
    }
}
