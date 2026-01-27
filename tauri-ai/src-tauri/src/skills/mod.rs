pub mod loader;
pub mod installer;
pub mod watcher;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillRootKind {
    /// ~/.tauri-ai/skills
    App,
    /// <workstudio_main_folder>/skills
    Workstudio,
    /// repo/app bundled skills (tauri-ai/skills)
    Repo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    /// Category = first-level directory under `skills/` (e.g. learn/system/code)
    pub category: String,
    /// Root kind (app/workstudio/repo)
    pub root_kind: SkillRootKind,
    /// Absolute path to SKILL.md
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub meta: SkillMetadata,
    /// Full SKILL.md contents (including frontmatter).
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillLoadOutcome {
    #[serde(default)]
    pub skills: Vec<SkillEntry>,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillRootsSnapshot {
    #[serde(default)]
    pub app_skills_dir: Option<String>,
    #[serde(default)]
    pub repo_skills_dir: Option<String>,
    #[serde(default)]
    pub workstudio_skills_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillsArgs {
    /// Optional workstudio main folder path to include `<main>/skills`.
    #[serde(default)]
    pub workstudio_main_folder: Option<String>,
    /// Include full contents (default true).
    #[serde(default = "default_true")]
    pub include_contents: bool,
}

fn default_true() -> bool {
    true
}
