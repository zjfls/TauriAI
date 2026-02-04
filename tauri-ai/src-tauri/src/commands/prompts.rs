//! Prompt-related Tauri commands.

use crate::prompts::FormatPromptType;

#[tauri::command]
pub fn get_format_prompt(format_type: FormatPromptType) -> Option<String> {
    format_type.get_prompt().map(|s| s.to_string())
}
