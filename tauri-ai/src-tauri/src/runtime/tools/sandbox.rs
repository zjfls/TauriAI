use std::path::{Path, PathBuf};

/// Returns the effective workspace roots for the current run.
///
/// - If `workspace_roots` is non-empty, it is returned as-is.
/// - Otherwise falls back to `default_workdir` (if present).
pub fn effective_workspace_roots(
    default_workdir: Option<&PathBuf>,
    workspace_roots: &[PathBuf],
) -> Vec<PathBuf> {
    if !workspace_roots.is_empty() {
        return workspace_roots.to_vec();
    }
    default_workdir.cloned().into_iter().collect()
}

pub fn normalize_root_for_join(base_dir: &Path, root: &str) -> Option<PathBuf> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = PathBuf::from(trimmed);
    if p.is_absolute() {
        Some(p)
    } else {
        Some(base_dir.join(p))
    }
}

pub fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    use std::collections::HashSet;
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::new();
    for p in paths {
        let key = path_key(&p);
        if seen.insert(key) {
            out.push(p);
        }
    }
    out
}

pub fn is_path_under_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path_is_within(path, root))
}

fn path_key(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        return s.to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    {
        s
    }
}

#[cfg(windows)]
fn path_is_within(path: &Path, root: &Path) -> bool {
    let mut p_it = path.components();
    let mut r_it = root.components();
    loop {
        match r_it.next() {
            None => return true,
            Some(r) => match p_it.next() {
                None => return false,
                Some(p) => {
                    let rs = r.as_os_str().to_string_lossy().to_ascii_lowercase();
                    let ps = p.as_os_str().to_string_lossy().to_ascii_lowercase();
                    if rs != ps {
                        return false;
                    }
                }
            },
        }
    }
}

#[cfg(not(windows))]
fn path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

