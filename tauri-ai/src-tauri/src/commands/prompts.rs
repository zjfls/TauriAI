//! Prompt-related Tauri commands.

use crate::prompts::{FormatPromptType, SystemPromptType};
use crate::skills::SkillMetadata;

#[tauri::command]
pub fn get_format_prompt(format_type: FormatPromptType) -> Option<String> {
    format_type.get_prompt().map(|s| s.to_string())
}

#[tauri::command]
pub fn get_system_prompt(prompt_type: SystemPromptType) -> String {
    prompt_type.get_prompt().to_string()
}

#[tauri::command]
pub fn render_skills_section(skills: Vec<SkillMetadata>) -> Option<String> {
    crate::prompts::render_skills_section_from_meta(&skills)
}
