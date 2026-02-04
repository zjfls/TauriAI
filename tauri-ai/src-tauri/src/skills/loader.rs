use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use dunce::canonicalize as normalize_path;
use serde::Deserialize;

use super::{SkillEntry, SkillLoadOutcome, SkillMetadata, SkillRootKind};

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: String,
    description: String,
    #[serde(default)]
    metadata: SkillFrontmatterMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct SkillFrontmatterMetadata {
    #[serde(default, rename = "short-description")]
    short_description: Option<String>,
}

const SKILLS_FILENAME: &str = "SKILL.md";
const MAX_NAME_LEN: usize = 64;
const MAX_DESCRIPTION_LEN: usize = 2048;
const MAX_SHORT_DESCRIPTION_LEN: usize = 2048;

#[derive(Debug)]
enum SkillParseError {
    Read(std::io::Error),
    MissingFrontmatter,
    InvalidYaml(serde_yaml::Error),
    MissingField(&'static str),
    InvalidField { field: &'static str, reason: String },
}

impl std::fmt::Display for SkillParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkillParseError::Read(e) => write!(f, "读取文件失败: {e}"),
            SkillParseError::MissingFrontmatter => {
                write!(f, "缺少 YAML frontmatter（用 --- 分隔）")
            }
            SkillParseError::InvalidYaml(e) => write!(f, "frontmatter YAML 解析失败: {e}"),
            SkillParseError::MissingField(field) => write!(f, "缺少字段 `{field}`"),
            SkillParseError::InvalidField { field, reason } => {
                write!(f, "字段 `{field}` 无效: {reason}")
            }
        }
    }
}

pub fn load_skills(
    app_skills_dir: Option<&Path>,
    repo_skills_dir: Option<&Path>,
    workstudio_skills_dir: Option<&Path>,
    include_contents: bool,
) -> SkillLoadOutcome {
    let mut outcome = SkillLoadOutcome::default();

    let mut roots: Vec<(SkillRootKind, PathBuf)> = Vec::new();
    if let Some(p) = repo_skills_dir {
        roots.push((SkillRootKind::Repo, p.to_path_buf()));
    }
    if let Some(p) = app_skills_dir {
        roots.push((SkillRootKind::App, p.to_path_buf()));
    }
    if let Some(p) = workstudio_skills_dir {
        roots.push((SkillRootKind::Workstudio, p.to_path_buf()));
    }

    // 去重：同名 skill 只保留第一个（优先级：repo > app > workstudio）
    let mut seen: HashSet<String> = HashSet::new();

    for (kind, root) in roots {
        discover_skills_under_root(&root, kind, include_contents, &mut outcome, &mut seen);
    }

    // 稳定排序，方便 UI 展示
    outcome.skills.sort_by(|a, b| {
        a.meta
            .category
            .cmp(&b.meta.category)
            .then_with(|| a.meta.name.cmp(&b.meta.name))
            .then_with(|| a.meta.path.cmp(&b.meta.path))
    });

    outcome
}

fn discover_skills_under_root(
    root: &Path,
    root_kind: SkillRootKind,
    include_contents: bool,
    outcome: &mut SkillLoadOutcome,
    seen: &mut HashSet<String>,
) {
    let root = normalize_path(root).unwrap_or_else(|_| root.to_path_buf());
    if !root.is_dir() {
        return;
    }

    // category = root/<category>/.../SKILL.md 里的第一个目录名
    let mut queue: VecDeque<PathBuf> = VecDeque::from([root.clone()]);
    while let Some(dir) = queue.pop_front() {
        let entries = match fs::read_dir(&dir) {
            Ok(v) => v,
            Err(e) => {
                outcome
                    .errors
                    .push(format!("读取 skills 目录失败 {}: {e}", dir.display()));
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = match path.file_name().and_then(|f| f.to_str()) {
                Some(name) => name,
                None => continue,
            };

            if file_name.starts_with('.') {
                continue;
            }

            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                queue.push_back(path);
                continue;
            }
            if file_type.is_file() && file_name == SKILLS_FILENAME {
                match parse_skill_file(&root, &path, root_kind.clone(), include_contents) {
                    Ok(skill) => {
                        if seen.insert(skill.meta.name.clone()) {
                            outcome.skills.push(skill);
                        }
                    }
                    Err(err) => {
                        outcome.errors.push(format!("{}: {err}", path.display()));
                    }
                }
            }
        }
    }
}

fn parse_skill_file(
    root: &Path,
    path: &Path,
    root_kind: SkillRootKind,
    include_contents: bool,
) -> Result<SkillEntry, SkillParseError> {
    let contents = fs::read_to_string(path).map_err(SkillParseError::Read)?;
    let frontmatter = extract_frontmatter(&contents).ok_or(SkillParseError::MissingFrontmatter)?;
    let parsed: SkillFrontmatter =
        serde_yaml::from_str(&frontmatter).map_err(SkillParseError::InvalidYaml)?;

    let name = sanitize_single_line(&parsed.name);
    let description = sanitize_single_line(&parsed.description);
    let short_description = parsed
        .metadata
        .short_description
        .as_deref()
        .map(sanitize_single_line)
        .filter(|v| !v.is_empty());

    validate_field(&name, MAX_NAME_LEN, "name")?;
    validate_field(&description, MAX_DESCRIPTION_LEN, "description")?;
    if let Some(v) = short_description.as_deref() {
        validate_field(v, MAX_SHORT_DESCRIPTION_LEN, "metadata.short-description")?;
    }

    let category = infer_category(root, path).unwrap_or_else(|| "uncategorized".to_string());
    let meta = SkillMetadata {
        name,
        description,
        short_description,
        category,
        root_kind,
        path: path.to_string_lossy().into_owned(),
    };

    Ok(SkillEntry {
        meta,
        contents: if include_contents {
            contents
        } else {
            String::new()
        },
    })
}

fn infer_category(root: &Path, skill_md: &Path) -> Option<String> {
    let root = normalize_path(root).unwrap_or_else(|_| root.to_path_buf());
    let skill_md = normalize_path(skill_md).unwrap_or_else(|_| skill_md.to_path_buf());
    let rel = skill_md.strip_prefix(&root).ok()?;
    let mut comps = rel.components().filter_map(|c| c.as_os_str().to_str());
    let first = comps.next()?;
    if first.eq_ignore_ascii_case(SKILLS_FILENAME) {
        return None;
    }
    Some(first.to_string())
}

fn extract_frontmatter(contents: &str) -> Option<String> {
    let trimmed = contents.trim_start();
    let mut lines = trimmed.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut out = String::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(out);
        }
        out.push_str(line);
        out.push('\n');
    }
    None
}

fn sanitize_single_line(value: &str) -> String {
    value.lines().next().unwrap_or_default().trim().to_string()
}

fn validate_field(value: &str, max_len: usize, field: &'static str) -> Result<(), SkillParseError> {
    let v = value.trim();
    if v.is_empty() {
        return Err(SkillParseError::MissingField(field));
    }
    if v.len() > max_len {
        return Err(SkillParseError::InvalidField {
            field,
            reason: format!("长度超限（{} > {}）", v.len(), max_len),
        });
    }
    Ok(())
}

pub fn make_skill_markdown(
    name: &str,
    description: &str,
    short_description: Option<&str>,
    body: &str,
) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", name.trim()));
    out.push_str(&format!("description: {}\n", description.trim()));
    if let Some(sd) = short_description
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        out.push_str("metadata:\n");
        out.push_str(&format!("  short-description: {}\n", sd));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim());
    out.push('\n');
    out
}

pub fn index_by_name(outcome: &SkillLoadOutcome) -> HashMap<String, SkillEntry> {
    outcome
        .skills
        .iter()
        .cloned()
        .map(|s| (s.meta.name.clone(), s))
        .collect()
}
