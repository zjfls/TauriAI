use std::collections::HashSet;

/// A parsed view of `$name` and `[$name](path)` mentions inside a single text input.
///
/// This is modeled after Codex's mention parsing so the same conventions can be used:
/// - `$skill-name` for skills
/// - `[$app](app://id)` / `[$server](mcp://server)` for apps/MCP
/// - `[$skill](skill://<path>)` or `[$skill](/abs/path/to/SKILL.md)` for explicit skill paths
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolMentions {
    /// Mentioned `$name` tokens (and linked mentions when applicable).
    pub names: HashSet<String>,
    /// Mentioned linked resource paths from `[$name](path)`.
    pub paths: HashSet<String>,
    /// Names that came from plain `$name` mentions (not linked mentions).
    pub plain_names: HashSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolMentionKind {
    App,
    Mcp,
    Skill,
    Other,
}

const APP_PATH_PREFIX: &str = "app://";
const MCP_PATH_PREFIX: &str = "mcp://";
const SKILL_PATH_PREFIX: &str = "skill://";
const SKILL_FILENAME: &str = "SKILL.md";

pub fn tool_kind_for_path(path: &str) -> ToolMentionKind {
    if path.starts_with(APP_PATH_PREFIX) {
        ToolMentionKind::App
    } else if path.starts_with(MCP_PATH_PREFIX) {
        ToolMentionKind::Mcp
    } else if path.starts_with(SKILL_PATH_PREFIX) || is_skill_filename(path) {
        ToolMentionKind::Skill
    } else {
        ToolMentionKind::Other
    }
}

fn is_skill_filename(path: &str) -> bool {
    let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path).trim();
    file_name.eq_ignore_ascii_case(SKILL_FILENAME)
}

pub fn normalize_skill_path(path: &str) -> &str {
    path.strip_prefix(SKILL_PATH_PREFIX).unwrap_or(path)
}

pub fn app_id_from_path(path: &str) -> Option<&str> {
    path.strip_prefix(APP_PATH_PREFIX)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

pub fn mcp_id_from_path(path: &str) -> Option<&str> {
    path.strip_prefix(MCP_PATH_PREFIX)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Extract `$tool-name` mentions from a single text input.
///
/// Supports explicit resource links in the form `[$tool-name](resource path)`.
/// When a resource path is present, it is captured for exact path matching while
/// also tracking the name for fallback matching.
pub fn extract_tool_mentions(text: &str) -> ToolMentions {
    let text_bytes = text.as_bytes();
    let mut mentioned_names: HashSet<String> = HashSet::new();
    let mut mentioned_paths: HashSet<String> = HashSet::new();
    let mut plain_names: HashSet<String> = HashSet::new();

    let mut index = 0usize;
    while index < text_bytes.len() {
        let byte = text_bytes[index];

        if byte == b'[' {
            if let Some((name, path, end_index)) =
                parse_linked_tool_mention(text, text_bytes, index)
            {
                if !is_common_env_var(name) {
                    let kind = tool_kind_for_path(path);
                    if !matches!(kind, ToolMentionKind::App | ToolMentionKind::Mcp) {
                        mentioned_names.insert(name.to_string());
                    }
                    mentioned_paths.insert(path.to_string());
                }
                index = end_index;
                continue;
            }
        }

        if byte != b'$' {
            index += 1;
            continue;
        }

        let name_start = index + 1;
        let Some(first_name_byte) = text_bytes.get(name_start).copied() else {
            index += 1;
            continue;
        };
        if !is_mention_name_char(first_name_byte) {
            index += 1;
            continue;
        }

        let mut name_end = name_start + 1;
        while let Some(next_byte) = text_bytes.get(name_end).copied() {
            if !is_mention_name_char(next_byte) {
                break;
            }
            name_end += 1;
        }

        let name = &text[name_start..name_end];
        if !is_common_env_var(name) {
            mentioned_names.insert(name.to_string());
            plain_names.insert(name.to_string());
        }

        index = name_end;
    }

    ToolMentions {
        names: mentioned_names,
        paths: mentioned_paths,
        plain_names,
    }
}

fn parse_linked_tool_mention<'a>(
    text: &'a str,
    text_bytes: &[u8],
    start: usize,
) -> Option<(&'a str, &'a str, usize)> {
    let dollar_index = start + 1;
    if text_bytes.get(dollar_index) != Some(&b'$') {
        return None;
    }

    let name_start = dollar_index + 1;
    let first_name_byte = text_bytes.get(name_start).copied()?;
    if !is_mention_name_char(first_name_byte) {
        return None;
    }

    let mut name_end = name_start + 1;
    while let Some(next_byte) = text_bytes.get(name_end).copied() {
        if !is_mention_name_char(next_byte) {
            break;
        }
        name_end += 1;
    }

    if text_bytes.get(name_end) != Some(&b']') {
        return None;
    }

    let mut path_start = name_end + 1;
    while let Some(next_byte) = text_bytes.get(path_start).copied() {
        if !next_byte.is_ascii_whitespace() {
            break;
        }
        path_start += 1;
    }

    if text_bytes.get(path_start) != Some(&b'(') {
        return None;
    }

    let mut path_end = path_start + 1;
    while let Some(next_byte) = text_bytes.get(path_end).copied() {
        if next_byte == b')' {
            break;
        }
        path_end += 1;
    }
    if text_bytes.get(path_end) != Some(&b')') {
        return None;
    }

    let path = text[path_start + 1..path_end].trim();
    if path.is_empty() {
        return None;
    }

    let name = &text[name_start..name_end];
    Some((name, path, path_end + 1))
}

fn is_common_env_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "PATH"
            | "HOME"
            | "USER"
            | "SHELL"
            | "PWD"
            | "TMPDIR"
            | "TEMP"
            | "TMP"
            | "LANG"
            | "TERM"
            | "XDG_CONFIG_HOME"
    )
}

fn is_mention_name_char(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn extract_plain_name_mentions() {
        let mentions = extract_tool_mentions("use $deep-learning and $news-summary please");
        assert_eq!(mentions.names, set(&["deep-learning", "news-summary"]));
        assert_eq!(mentions.paths, HashSet::new());
        assert_eq!(
            mentions.plain_names,
            set(&["deep-learning", "news-summary"])
        );
    }

    #[test]
    fn ignores_common_env_vars() {
        let mentions = extract_tool_mentions("echo $PATH then use $deep-learning");
        assert_eq!(mentions.names, set(&["deep-learning"]));
        assert_eq!(mentions.plain_names, set(&["deep-learning"]));
    }

    #[test]
    fn linked_mentions_capture_paths() {
        let mentions = extract_tool_mentions("see [$demo](skill:///abs/path/SKILL.md) now");
        assert_eq!(mentions.paths, set(&["skill:///abs/path/SKILL.md"]));
        // skill:// links still keep the name for fallback
        assert_eq!(mentions.names, set(&["demo"]));
        assert_eq!(mentions.plain_names, HashSet::new());
    }

    #[test]
    fn linked_app_and_mcp_mentions_do_not_add_names() {
        let mentions = extract_tool_mentions("use [$github](app://github) and [$fs](mcp://fs)");
        assert_eq!(mentions.paths, set(&["app://github", "mcp://fs"]));
        assert!(mentions.names.is_empty());
    }
}
