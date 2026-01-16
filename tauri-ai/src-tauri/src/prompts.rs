//! Prompt templates for TauriAI
//!
//! Contains format prompts and utilities for prompt composition.

/// Format prompt for rich text rendering in chat view
/// Includes Markdown, LaTeX, Mermaid, and HTML tag guidelines
pub const CHAT_FORMAT_PROMPT: &str = r#"

## 输出格式规范

### 基础格式（Markdown）
- 标题：# ## ###
- 列表：- 或 1. 2. 3.
- 强调：**粗体** *斜体* ~~删除线~~
- 代码：`行内代码` 或用三个反引号包裹代码块
- 链接：[文本](url)
- 引用：> 引用内容

### 表格（GFM格式，前后空行，单|分隔）
| A | B |
|---|---|
| 1 | 2 |

### 数学公式（LaTeX）
- 行内公式用单个 $ 包裹，如 $E = mc^2$
- 块级公式用 $$ 包裹，前后需空行

### 图表（Mermaid）
使用 mermaid 作为语言标记的代码块，支持 flowchart、sequence、gantt 等图表类型。

### 数学函数可视化（Mafs）
使用 `plot` 或 `mafs` 作为语言标记的代码块，内容为 JSON 对象或纯文本函数表达式。
支持所有 JavaScript Math 函数（如 sin, cos, tan, sqrt, abs, exp, log, asin, acos, atan, sinh, cosh, floor, ceil, round 等），常量 pi 和 e，以及 ^ 表示幂运算。
示例（JSON 格式）：
```plot
{
  "functions": ["sin(x)", "cos(x)"],
  "xRange": [-6.28, 6.28]
}
```
示例（纯文本，每行一个函数）：
```plot
sin(x)
x^2
```

### 特殊元素（HTML 标签）
- 折叠内容：<details><summary>标题</summary>内容</details>
- 键盘按键：<kbd>Ctrl</kbd>
- 高亮文本：<mark>重点</mark>
- 上下标：H<sub>2</sub>O、x<sup>2</sup>
"#;

/// Format prompt types for different scenarios
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormatPromptType {
    /// Rich text format for chat view (Markdown + LaTeX + Mermaid + HTML)
    Chat,
    /// Plain text only, no formatting
    Plain,
    /// JSON output format
    Json,
    /// No format prompt appended
    None,
}

impl Default for FormatPromptType {
    fn default() -> Self {
        Self::Chat
    }
}

impl FormatPromptType {
    /// Get the format prompt string for this type
    pub fn get_prompt(&self) -> Option<&'static str> {
        match self {
            Self::Chat => Some(CHAT_FORMAT_PROMPT),
            Self::Plain => Some("\n\n请使用纯文本格式回复，不要使用 Markdown 或其他格式。"),
            Self::Json => Some("\n\n请以 JSON 格式返回结果。"),
            Self::None => None,
        }
    }
}

/// Compose final system prompt from base prompt and format type
pub fn compose_system_prompt(
    base_prompt: Option<&str>,
    format_type: FormatPromptType,
) -> Option<String> {
    let base = base_prompt.unwrap_or("").trim();
    let format = format_type.get_prompt().unwrap_or("");

    if base.is_empty() && format.is_empty() {
        return None;
    }

    Some(format!("{}{}", base, format))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compose_with_both() {
        let result = compose_system_prompt(Some("你是一个助手"), FormatPromptType::Chat);
        assert!(result.is_some());
        assert!(result.unwrap().contains("你是一个助手"));
    }

    #[test]
    fn test_compose_none_format() {
        let result = compose_system_prompt(Some("你是一个助手"), FormatPromptType::None);
        assert_eq!(result, Some("你是一个助手".to_string()));
    }

    #[test]
    fn test_compose_empty() {
        let result = compose_system_prompt(None, FormatPromptType::None);
        assert!(result.is_none());
    }
}
