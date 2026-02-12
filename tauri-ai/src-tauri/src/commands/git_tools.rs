//! Git helper commands for UI diffs/undo (ghost commits).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git_tools::{
    git_diff_between_commits, git_diff_name_status_between_commits,
    git_diff_numstat_between_commits, git_restore_worktree_from_commit_with_worktree, GitDiffOptions,
    create_ghost_commit_for_paths_with_worktree,
    git_current_branch,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffCommitsArgs {
    pub repo_root: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub options: GitDiffCommitsOptions,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffCommitsOptions {
    #[serde(default)]
    pub context_lines: Option<u32>,
    #[serde(default)]
    pub ignore_whitespace: bool,
    #[serde(default)]
    pub detect_renames: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFileStat {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_binary: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSummary {
    pub files_changed: u32,
    pub insertions: i64,
    pub deletions: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffCommitsResponse {
    pub repo_root: String,
    pub from: String,
    pub to: String,
    pub summary: GitDiffSummary,
    pub files: Vec<GitDiffFileStat>,
    pub diff: String,
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    if !p.is_dir() {
        return Err(format!("repo_root 不是目录: {}", p.display()));
    }
    Ok(())
}

fn normalize_git_pathspec(s: &str) -> String {
    s.trim().replace('\\', "/")
}

fn parse_name_status(raw: &str) -> Vec<(String, Option<String>, String)> {
    // Returns: (status, old_path, path)
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.is_empty() {
            continue;
        }
        let status_raw = parts[0].trim();
        if status_raw.starts_with('R') || status_raw.starts_with('C') {
            if parts.len() >= 3 {
                out.push((
                    status_raw.to_string(),
                    Some(normalize_git_pathspec(parts[1])),
                    normalize_git_pathspec(parts[2]),
                ));
            }
            continue;
        }
        if parts.len() >= 2 {
            out.push((
                status_raw.to_string(),
                None,
                normalize_git_pathspec(parts[1]),
            ));
        }
    }
    out
}

fn parse_numstat(raw: &str) -> Vec<(String, Option<i64>, Option<i64>, Option<bool>)> {
    // Returns: (path, added, deleted, is_binary)
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let added_raw = parts[0].trim();
        let deleted_raw = parts[1].trim();
        let (added, deleted, is_binary) = if added_raw == "-" || deleted_raw == "-" {
            (None, None, Some(true))
        } else {
            (
                added_raw.parse::<i64>().ok(),
                deleted_raw.parse::<i64>().ok(),
                Some(false),
            )
        };
        // `--numstat` may include rename paths; best-effort: use last column as the "current" path.
        let path = normalize_git_pathspec(parts[parts.len() - 1]);
        out.push((path, added, deleted, is_binary));
    }
    out
}

fn build_summary(files: &[GitDiffFileStat]) -> GitDiffSummary {
    let mut files_changed = 0u32;
    let mut insertions = 0i64;
    let mut deletions = 0i64;
    for f in files {
        files_changed = files_changed.saturating_add(1);
        insertions = insertions.saturating_add(f.added.unwrap_or(0));
        deletions = deletions.saturating_add(f.deleted.unwrap_or(0));
    }
    GitDiffSummary {
        files_changed,
        insertions,
        deletions,
    }
}

#[tauri::command]
pub async fn git_diff_commits(args: GitDiffCommitsArgs) -> Result<GitDiffCommitsResponse, String> {
    let repo_root = PathBuf::from(args.repo_root.trim());
    ensure_dir(&repo_root)?;

    let pathspecs = args
        .paths
        .into_iter()
        .map(|s| normalize_git_pathspec(&s))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    let opts = GitDiffOptions {
        context_lines: args.options.context_lines,
        ignore_whitespace: args.options.ignore_whitespace,
        detect_renames: args.options.detect_renames,
    };

    let diff = git_diff_between_commits(&repo_root, &args.from, &args.to, &pathspecs, &opts).await?;
    let name_status = git_diff_name_status_between_commits(
        &repo_root,
        &args.from,
        &args.to,
        &pathspecs,
        args.options.detect_renames,
    )
    .await
    .unwrap_or_default();
    let numstat = git_diff_numstat_between_commits(
        &repo_root,
        &args.from,
        &args.to,
        &pathspecs,
        args.options.detect_renames,
    )
    .await
    .unwrap_or_default();

    let mut files: Vec<GitDiffFileStat> = parse_name_status(&name_status)
        .into_iter()
        .map(|(status, old_path, path)| GitDiffFileStat {
            path,
            old_path,
            status,
            added: None,
            deleted: None,
            is_binary: None,
        })
        .collect();

    // Attach numstat counts (best-effort).
    let mut numstat_map = std::collections::HashMap::<String, (Option<i64>, Option<i64>, Option<bool>)>::new();
    for (path, added, deleted, is_binary) in parse_numstat(&numstat) {
        numstat_map.insert(path, (added, deleted, is_binary));
    }
    for f in &mut files {
        if let Some((a, d, bin)) = numstat_map.get(&f.path) {
            f.added = *a;
            f.deleted = *d;
            f.is_binary = *bin;
        }
    }

    // If name-status is empty (e.g. weird config), fall back to numstat-only listing.
    if files.is_empty() {
        for (path, added, deleted, is_binary) in parse_numstat(&numstat) {
            files.push(GitDiffFileStat {
                path,
                old_path: None,
                status: "M".to_string(),
                added,
                deleted,
                is_binary,
            });
        }
    }

    // Stable ordering for UI.
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let summary = build_summary(&files);

    Ok(GitDiffCommitsResponse {
        repo_root: repo_root.display().to_string(),
        from: args.from,
        to: args.to,
        summary,
        files,
        diff,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffGhostWorktreeArgs {
    pub repo_root: String,
    #[serde(default)]
    pub work_tree: Option<String>,
    pub ghost_before: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub options: GitDiffCommitsOptions,
}

/// Diff `ghost_before` against the current working tree (captured into a temporary ghost commit).
///
/// 说明：
/// - 直接 `git diff <commit>` 不包含 untracked 文件；
/// - 这里通过“临时 ghost commit”把 working tree（包含 affected scope 下的 untracked）也纳入 diff。
#[tauri::command]
pub async fn git_diff_ghost_worktree(
    args: GitDiffGhostWorktreeArgs,
) -> Result<GitDiffCommitsResponse, String> {
    let repo_root = PathBuf::from(args.repo_root.trim());
    ensure_dir(&repo_root)?;
    let work_tree = args
        .work_tree
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.clone());

    let pathspecs = args
        .paths
        .into_iter()
        .map(|s| normalize_git_pathspec(&s))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    let ghost_current = create_ghost_commit_for_paths_with_worktree(
        &repo_root,
        &work_tree,
        &pathspecs,
        "tauri-ai snapshot (worktree for diff)",
    )
    .await?;

    git_diff_commits(GitDiffCommitsArgs {
        repo_root: repo_root.display().to_string(),
        from: args.ghost_before,
        to: ghost_current.id,
        paths: pathspecs,
        options: args.options,
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoApplyPatchArgs {
    pub repo_root: String,
    #[serde(default)]
    pub work_tree: Option<String>,
    pub ghost_before: String,
    #[serde(default)]
    pub affected_paths: Vec<String>,
    #[serde(default)]
    pub created_paths: Vec<String>,
}

#[tauri::command]
pub async fn undo_apply_patch(args: UndoApplyPatchArgs) -> Result<bool, String> {
    let repo_root = PathBuf::from(args.repo_root.trim());
    ensure_dir(&repo_root)?;
    let work_tree = args
        .work_tree
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.clone());

    let affected = args
        .affected_paths
        .into_iter()
        .map(|s| normalize_git_pathspec(&s))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if affected.is_empty() {
        return Err("affected_paths 不能为空".to_string());
    }

    git_restore_worktree_from_commit_with_worktree(
        &repo_root,
        &work_tree,
        &args.ghost_before,
        &affected,
    )
    .await?;

    // Remove files/directories created by apply_patch (best-effort).
    for rel in args
        .created_paths
        .into_iter()
        .map(|s| normalize_git_pathspec(&s))
        .filter(|s| !s.is_empty())
    {
        let abs = work_tree.join(PathBuf::from(&rel));
        if !abs.exists() {
            continue;
        }
        if abs.is_dir() {
            let _ = std::fs::remove_dir_all(&abs);
        } else {
            let _ = std::fs::remove_file(&abs);
        }
    }

    Ok(true)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGetCurrentBranchArgs {
    pub workdir: String,
}

/// Get current git branch name for a given workdir.
/// - Returns `None` when the workdir is not a git work tree (or git is unavailable).
/// - For detached HEAD, returns `detached@<shortsha>`.
#[tauri::command]
pub async fn git_get_current_branch(args: GitGetCurrentBranchArgs) -> Result<Option<String>, String> {
    let workdir = args.workdir.trim();
    if workdir.is_empty() {
        return Ok(None);
    }
    git_current_branch(&PathBuf::from(workdir)).await
}
