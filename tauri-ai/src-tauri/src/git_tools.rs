use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

fn to_git_path(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in path.components() {
        let s = c.as_os_str().to_string_lossy();
        if s.is_empty() {
            continue;
        }
        parts.push(s.to_string());
    }
    parts.join("/")
}

fn normalize_git_pathspec(s: &str) -> String {
    // Git accepts forward slashes on all platforms; normalize to keep UI stable.
    s.replace('\\', "/")
}

fn git_dir_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".git")
}

async fn run_git_for_stdout(
    repo_root: &Path,
    args: Vec<OsString>,
    env: Option<&[(OsString, OsString)]>,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_root);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let out = cmd.output().await.map_err(|e| format!("启动 git 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git 退出码: {:?}", out.status.code())
        };
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn run_git_for_status(
    repo_root: &Path,
    args: Vec<OsString>,
    env: Option<&[(OsString, OsString)]>,
) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_root);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let out = cmd.output().await.map_err(|e| format!("启动 git 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git 退出码: {:?}", out.status.code())
        };
        return Err(msg);
    }
    Ok(())
}

async fn run_git_for_stdout_in_repo(
    repo_root: &Path,
    work_tree: &Path,
    args: Vec<OsString>,
    extra_env: Option<&[(OsString, OsString)]>,
) -> Result<String, String> {
    if work_tree == repo_root {
        return run_git_for_stdout(repo_root, args, extra_env).await;
    }

    let git_dir = git_dir_path(repo_root);
    let mut env: Vec<(OsString, OsString)> = vec![
        (OsString::from("GIT_DIR"), OsString::from(git_dir.as_os_str())),
        (
            OsString::from("GIT_WORK_TREE"),
            OsString::from(work_tree.as_os_str()),
        ),
    ];
    if let Some(extra) = extra_env {
        env.extend_from_slice(extra);
    }
    run_git_for_stdout(work_tree, args, Some(env.as_slice())).await
}

async fn run_git_for_status_in_repo(
    repo_root: &Path,
    work_tree: &Path,
    args: Vec<OsString>,
    extra_env: Option<&[(OsString, OsString)]>,
) -> Result<(), String> {
    if work_tree == repo_root {
        return run_git_for_status(repo_root, args, extra_env).await;
    }

    let git_dir = git_dir_path(repo_root);
    let mut env: Vec<(OsString, OsString)> = vec![
        (OsString::from("GIT_DIR"), OsString::from(git_dir.as_os_str())),
        (
            OsString::from("GIT_WORK_TREE"),
            OsString::from(work_tree.as_os_str()),
        ),
    ];
    if let Some(extra) = extra_env {
        env.extend_from_slice(extra);
    }
    run_git_for_status(work_tree, args, Some(env.as_slice())).await
}

fn default_commit_identity_env() -> Vec<(OsString, OsString)> {
    vec![
        (OsString::from("GIT_AUTHOR_NAME"), OsString::from("TauriAI")),
        (OsString::from("GIT_AUTHOR_EMAIL"), OsString::from("tauri-ai@local")),
        (OsString::from("GIT_COMMITTER_NAME"), OsString::from("TauriAI")),
        (OsString::from("GIT_COMMITTER_EMAIL"), OsString::from("tauri-ai@local")),
    ]
}

pub(crate) async fn resolve_repo_root(workdir: &Path) -> Result<PathBuf, String> {
    let out = run_git_for_stdout(
        workdir,
        vec![OsString::from("rev-parse"), OsString::from("--show-toplevel")],
        None,
    )
    .await?;
    let p = PathBuf::from(out.trim());
    if p.as_os_str().is_empty() {
        return Err("git rev-parse 返回空 repo_root".to_string());
    }
    Ok(p)
}

pub(crate) async fn git_current_branch(workdir: &Path) -> Result<Option<String>, String> {
    if !workdir.is_dir() {
        return Ok(None);
    }

    // Keep behavior consistent with other git helpers: rely on git itself to decide whether
    // this is a work tree (handles worktrees/submodules/.git files etc.).
    let inside = match run_git_for_stdout(
        workdir,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--is-inside-work-tree"),
        ],
        None,
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if inside.trim() != "true" {
        return Ok(None);
    }

    let branch = match run_git_for_stdout(
        workdir,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--abbrev-ref"),
            OsString::from("HEAD"),
        ],
        None,
    )
    .await
    {
        Ok(v) => v.trim().to_string(),
        Err(_) => return Ok(None),
    };

    if branch.is_empty() {
        return Ok(None);
    }

    // Detached HEAD: rev-parse returns literal "HEAD". Show a friendly label with short sha.
    if branch == "HEAD" {
        let sha = run_git_for_stdout(
            workdir,
            vec![
                OsString::from("rev-parse"),
                OsString::from("--short"),
                OsString::from("HEAD"),
            ],
            None,
        )
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

        return Ok(Some(match sha {
            Some(s) => format!("detached@{s}"),
            None => "detached".to_string(),
        }));
    }

    Ok(Some(branch))
}

pub(crate) fn repo_prefix(repo_root: &Path, workdir: &Path) -> Option<PathBuf> {
    let rel = workdir.strip_prefix(repo_root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(rel.to_path_buf())
}

async fn resolve_head(repo_root: &Path, work_tree: &Path) -> Option<String> {
    run_git_for_stdout_in_repo(
        repo_root,
        work_tree,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("HEAD"),
        ],
        None,
    )
    .await
    .ok()
    .filter(|s| !s.trim().is_empty())
}

async fn list_tracked_paths(
    repo_root: &Path,
    work_tree: &Path,
    pathspecs: &[String],
) -> Result<HashSet<String>, String> {
    if pathspecs.is_empty() {
        return Ok(HashSet::new());
    }
    let mut args: Vec<OsString> = Vec::new();
    args.push(OsString::from("ls-files"));
    args.push(OsString::from("--"));
    for p in pathspecs {
        args.push(OsString::from(p));
    }
    let out = run_git_for_stdout_in_repo(repo_root, work_tree, args, None)
        .await
        .unwrap_or_default();
    let mut set = HashSet::new();
    for line in out.lines() {
        let s = line.trim();
        if s.is_empty() {
            continue;
        }
        set.insert(normalize_git_pathspec(s));
    }
    Ok(set)
}

fn list_existing_paths(work_tree: &Path, pathspecs: &[String]) -> HashSet<String> {
    let mut set = HashSet::new();
    for p in pathspecs {
        let norm = normalize_git_pathspec(p);
        let abs = work_tree.join(PathBuf::from(&norm));
        if abs.exists() {
            set.insert(norm);
        }
    }
    set
}

pub(crate) struct GhostCommit {
    pub id: String,
    pub parent: Option<String>,
}

pub(crate) async fn ensure_git_repo(repo_root: &Path) -> Result<(), String> {
    if repo_root.join(".git").is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(repo_root).map_err(|e| format!("创建 git 目录失败: {e}"))?;
    run_git_for_status(
        repo_root,
        vec![OsString::from("init"), OsString::from("--quiet")],
        None,
    )
    .await?;
    Ok(())
}

pub(crate) async fn create_ghost_commit_for_paths(
    repo_root: &Path,
    candidate_pathspecs: &[String],
    message: &str,
) -> Result<GhostCommit, String> {
    create_ghost_commit_for_paths_with_worktree(repo_root, repo_root, candidate_pathspecs, message)
        .await
}

pub(crate) async fn create_ghost_commit_for_paths_with_worktree(
    repo_root: &Path,
    work_tree: &Path,
    candidate_pathspecs: &[String],
    message: &str,
) -> Result<GhostCommit, String> {
    let parent = resolve_head(repo_root, work_tree).await;

    // Prepare a temporary index so we don't disturb user's staged changes.
    let tmp_dir = std::env::temp_dir().join(format!("tauriai-git-index-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let index_path = tmp_dir.join("index");
    let base_env = vec![(
        OsString::from("GIT_INDEX_FILE"),
        OsString::from(index_path.as_os_str()),
    )];

    let out = async {
        // Pre-populate index with HEAD so unchanged tracked files are in the tree.
        if let Some(parent_sha) = parent.as_ref() {
            run_git_for_status_in_repo(
                repo_root,
                work_tree,
                vec![OsString::from("read-tree"), OsString::from(parent_sha)],
                Some(base_env.as_slice()),
            )
            .await?;
        }

        let candidate_pathspecs = candidate_pathspecs
            .iter()
            .map(|s| normalize_git_pathspec(s))
            .collect::<Vec<_>>();
        let tracked = list_tracked_paths(repo_root, work_tree, &candidate_pathspecs).await?;
        let existing = list_existing_paths(work_tree, &candidate_pathspecs);

        let mut stage_paths: Vec<String> = Vec::new();
        stage_paths.extend(tracked.into_iter());
        stage_paths.extend(existing.into_iter());
        stage_paths.sort();
        stage_paths.dedup();

        if !stage_paths.is_empty() {
            let mut args: Vec<OsString> = Vec::new();
            args.push(OsString::from("add"));
            args.push(OsString::from("--all"));
            args.push(OsString::from("--force"));
            args.push(OsString::from("--"));
            for p in &stage_paths {
                args.push(OsString::from(p));
            }
            run_git_for_status_in_repo(repo_root, work_tree, args, Some(base_env.as_slice()))
                .await?;
        }

        let tree_id = run_git_for_stdout_in_repo(
            repo_root,
            work_tree,
            vec![OsString::from("write-tree")],
            Some(base_env.as_slice()),
        )
        .await?;

        let mut commit_env = base_env;
        commit_env.extend(default_commit_identity_env());
        let mut commit_args: Vec<OsString> =
            vec![OsString::from("commit-tree"), OsString::from(tree_id)];
        if let Some(parent_sha) = parent.as_ref() {
            commit_args.extend([OsString::from("-p"), OsString::from(parent_sha)]);
        }
        commit_args.extend([OsString::from("-m"), OsString::from(message)]);
        let commit_id =
            run_git_for_stdout_in_repo(repo_root, work_tree, commit_args, Some(commit_env.as_slice()))
                .await?;
        Ok::<String, String>(commit_id)
    }
    .await;

    // Cleanup (best-effort).
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let id = out?;
    Ok(GhostCommit { id, parent })
}

pub(crate) struct GitDiffOptions {
    pub context_lines: Option<u32>,
    pub ignore_whitespace: bool,
    pub detect_renames: bool,
}

pub(crate) async fn git_diff_between_commits(
    repo_root: &Path,
    from: &str,
    to: &str,
    pathspecs: &[String],
    opts: &GitDiffOptions,
) -> Result<String, String> {
    let mut args: Vec<OsString> = Vec::new();
    args.push(OsString::from("diff"));
    args.push(OsString::from("--no-color"));
    if opts.detect_renames {
        args.push(OsString::from("-M"));
    }
    if opts.ignore_whitespace {
        args.push(OsString::from("--ignore-space-change"));
    }
    if let Some(u) = opts.context_lines {
        args.push(OsString::from(format!("-U{u}")));
    }
    args.push(OsString::from(from));
    args.push(OsString::from(to));
    args.push(OsString::from("--"));
    for p in pathspecs {
        args.push(OsString::from(normalize_git_pathspec(p)));
    }
    run_git_for_stdout(repo_root, args, None).await
}

pub(crate) async fn git_diff_numstat_between_commits(
    repo_root: &Path,
    from: &str,
    to: &str,
    pathspecs: &[String],
    detect_renames: bool,
) -> Result<String, String> {
    let mut args: Vec<OsString> = Vec::new();
    args.push(OsString::from("diff"));
    args.push(OsString::from("--no-color"));
    args.push(OsString::from("--numstat"));
    if detect_renames {
        args.push(OsString::from("-M"));
    }
    args.push(OsString::from(from));
    args.push(OsString::from(to));
    args.push(OsString::from("--"));
    for p in pathspecs {
        args.push(OsString::from(normalize_git_pathspec(p)));
    }
    run_git_for_stdout(repo_root, args, None).await
}

pub(crate) async fn git_diff_name_status_between_commits(
    repo_root: &Path,
    from: &str,
    to: &str,
    pathspecs: &[String],
    detect_renames: bool,
) -> Result<String, String> {
    let mut args: Vec<OsString> = Vec::new();
    args.push(OsString::from("diff"));
    args.push(OsString::from("--no-color"));
    args.push(OsString::from("--name-status"));
    if detect_renames {
        args.push(OsString::from("-M"));
    }
    args.push(OsString::from(from));
    args.push(OsString::from(to));
    args.push(OsString::from("--"));
    for p in pathspecs {
        args.push(OsString::from(normalize_git_pathspec(p)));
    }
    run_git_for_stdout(repo_root, args, None).await
}

pub(crate) async fn git_restore_worktree_from_commit(
    repo_root: &Path,
    commit_id: &str,
    pathspecs: &[String],
) -> Result<(), String> {
    git_restore_worktree_from_commit_with_worktree(repo_root, repo_root, commit_id, pathspecs).await
}

pub(crate) async fn git_restore_worktree_from_commit_with_worktree(
    repo_root: &Path,
    work_tree: &Path,
    commit_id: &str,
    pathspecs: &[String],
) -> Result<(), String> {
    let mut args: Vec<OsString> = Vec::new();
    args.push(OsString::from("restore"));
    args.push(OsString::from("--source"));
    args.push(OsString::from(commit_id));
    args.push(OsString::from("--worktree"));
    args.push(OsString::from("--"));
    for p in pathspecs {
        args.push(OsString::from(normalize_git_pathspec(p)));
    }
    run_git_for_status_in_repo(repo_root, work_tree, args, None).await
}

pub(crate) fn abs_to_repo_rel(repo_root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(repo_root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(to_git_path(rel))
}
