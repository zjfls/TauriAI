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
使用 mermaid 作为语言标记的代码块，支持 flowchart、sequence、gantt、classDiagram 等图表类型。
注意事项：
- **禁止使用中文引号**：节点文本必须用英文双引号 `"` 包裹
- **禁止在方括号节点内使用圆括号**：`A[...]` 格式的节点文本中不要包含 `()`，否则会导致解析失败
  - ❌ 错误：`A[时域信号 f(t)]`、`B[频域 F(ω)]`
  - ✅ 正确：`A["时域信号 f(t)"]`、`B["频域 F(ω)"]`（用双引号包裹）
  - ✅ 正确：`A[时域信号 f[t]]`、`B[频域 Fω]`（改用方括号或省略括号）
- **不支持数学公式**：Mermaid 内部不支持 LaTeX 公式渲染，如需数学符号请使用 Unicode（如 ∫、∑、√、∞、≤、≥、α、β、π）
- **禁止使用 `*` 作乘号**：类图中 `*` 是保留符号，请用 `×` 或 `·` 代替
- **Class Diagram**：必须先定义类名再使用 `<<interface>>` 注解
- **Sequence Diagram**：参与者 ID 不要使用 Mermaid 保留关键字（如 `loop/alt/else/end/opt/par/and/break/critical/note/rect/activate/deactivate`），也不要包含 `-` `/` `.` 等符号；需要展示长名称时用 `participant "展示名" as SAFE_ID`，消息线用 `SAFE_ID` 引用
错误示范：
```mermaid
classDiagram
  <<interface>> A %% Error: A undefined
```

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

### 文件引用（可点击跳转｜代码问题域）
- 这是“代码问题域”的强约束：当你在讨论代码/报错/定位/修改时，所有文件引用都必须使用**行内代码**的“路径格式”，系统会据此解析为可点击跳转；如果你用其他 Markdown 写法，通常会**无法识别/不可点击**。
- 普通网页 URL 可以使用 `[文本](url)`；但**文件引用禁止使用** Markdown 链接语法（如 `[label](path)`），也不要把它包进反引号（例如 `` `[label](path)` ``）。
- 唯一推荐写法（请严格遵守）：`相对路径:行`、`相对路径:行:列`、`相对路径#L行`、`相对路径#L行C列`
  - ✅ 正确：`tauri-ai/src-tauri/src/runtime/events.rs:96`、`tauri-ai/src/components/Chat/ChatView.tsx#L771`
  - ❌ 不要混用：`(line 59)`、单独的 `:59`、或省略目录只写 `events.rs:96`
- 允许相对路径或绝对路径（Windows 示例：`C:\repo\project\main.rs:12:5`）
- **优先使用相对主工作区根目录的相对路径（包含子目录）**，不要只写文件名（例如避免 `events.rs:96`）
- 如果你只知道文件名：先用工具在工作区内搜索定位到唯一文件，再输出完整相对路径后引用
- 不要使用 `file://` / `vscode://` 等 URI；不要对路径做 URL 编码；请直接输出可解析的文件路径
- 支持“范围行号”用于选中（例如 `:10-20` / `#L10-L20`）；只需定位时优先给出起始行即可
"#;

/// Tool usage prompt when "持久进程" enhancement is enabled for a toolset.
///
/// This prompt is intentionally short and strategy-focused to avoid impacting the default mode
/// when the feature is disabled.
pub const PERSISTENT_PROCESS_PROMPT: &str = r#"

## 工具使用策略（持久进程）

当启用“持久进程”增强时，请按场景选择工具（以你当前可用的 tools 列表为准）。

## 关键概念：阻塞式任务 vs 持久进程（必须区分）

- 阻塞式任务（blocking）：你需要“确认操作完成”后才继续下一步。
  - 选择 `shell_command`，并且不要提供 `timeout_ms`。
  - 不要用 `&/nohup/disown` 把进程放后台；要让命令以前台方式运行，直到进程退出（例如用户关闭 GUI 窗口）。
  - 适用：需要等待最终结果（build/test/安装/一次性脚本/打开 GUI 并等待关闭）。

- 持久进程（persistent）：把我当作一个长期的进程控制台，跨多个 turn 与同一进程/服务反复交互。
  - 选择 `exec_command_persistent` / `write_stdin_persistent`。
  - 注意：持久 PTY 按 `yield_time_ms` “时间片读输出后就返回”，不会因为进程还在跑就阻塞对话；需要继续读输出就轮询 `write_stdin_persistent(chars="")`。
  - 适用：REPL、长驻服务、需要多次输入/多轮交互的命令行程序。

## 强制选择规则（优先级很高）

- 用户明确说“阻塞/等我确认/直到我关闭窗口/不要后台运行” => 用阻塞式 `shell_command`（无 `timeout_ms`）。
- 用户明确说“后台持续运行/跨多轮交互/长期保持/持续读日志” => 用持久 PTY（`*_persistent`）。
- 默认短任务（一次性输出）仍优先用 `exec_command` / `write_stdin`（task 级，任务结束自动清理）。

## Few-shot（严格照抄思路）

用户：打开一个阻塞式 Python GUI，我关闭窗口后再继续。
助手：使用阻塞式 `shell_command`（不设置 timeout），前台运行 GUI（如本机只有 python3 就用 python3；若只有 python 就用 python）：
{ "command": "python3 -c \"import tkinter as tk; r=tk.Tk(); r.title('Blocking'); tk.Label(r,text='Close window to continue').pack(); r.mainloop()\"" }

用户：启动一个 Python 交互式会话，我接下来会多次输入代码。
助手：使用持久 PTY：
1) { "cmd": "python3 -q", "yield_time_ms": 1000 }
2) { "session_id": <上一步返回>, "chars": "print('hi')\\n", "yield_time_ms": 250 }

用户：运行一个耗时命令（比如 build/test），我要等它跑完再看最终结果。
助手：用阻塞式 `shell_command`，不设置 timeout：
{ "command": "cd /path/to/project && npm test" }

用户：启动一个长期服务并持续观察日志，我会在之后多次输入/停止它。
助手：用持久 PTY：先启动，再用 `write_stdin_persistent(chars=\"\")` 按需轮询输出；结束后提醒用户关闭会话。

## 额外提醒

- 持久 PTY 任务完成后，请提醒用户在“持久进程”面板里关闭/终止不再需要的会话，避免残留后台进程。

### 1) 交互式/长驻进程：优先使用持久 PTY
- 当你需要跨多个 turn 持续运行、持续输出或需要多次交互输入（例如 REPL、服务、需要分步输入的 CLI），并且 tools 中提供 `exec_command_persistent` / `write_stdin_persistent` 时，使用 `exec_command_persistent` 创建对话级 PTY 会话。
- 后续使用 `write_stdin_persistent` 继续交互；当只想“继续读取输出”时，可以令 `chars` 为空字符串来轮询输出。

### 2) 一次性执行：使用普通 PTY 或阻塞式 shell
- 短命令或一次性输出：优先使用 `exec_command` / `write_stdin`（task 级，会在任务结束时自动清理）。
- 需要“等命令跑完再继续”的场景：使用 `shell_command`。不设置 `timeout_ms` 时会一直阻塞等待进程退出；仅当你明确需要等待完整结果时才这样做。
- `shell_command` 不支持交互式 stdin；需要交互时请改用 PTY（尤其是持久 PTY）。
"#;

/// Prompt guide for the hidden local web search tool (`web_search`).
pub const WEB_SEARCH_TOOL_PROMPT: &str = r#"

## 网络搜索（工具）

当你需要最新信息、事实核验或引用来源时，并且 tools 列表里提供了 `web_search` 工具，请优先调用它进行网络搜索。

重要：
- 当用户在输入框启用了 Tavily/Google/Brave 搜索时，优先使用 `web_search` 获取外部信息；不要用 `shell_command`/`curl` 直接抓取网页或 RSS 来“代替搜索”。

使用建议：
- 先明确查询词（query），尽量包含关键实体/时间范围。
- 结果返回后，优先引用结果里的链接与标题；不要凭空编造引用。
- 注意：该工具可能有速率限制（会自动按最小间隔节流），不要在短时间内重复发起大量搜索。
"#;

/// Prompt guide for MCP resource tools (Codex-like).
pub const MCP_RESOURCE_TOOL_PROMPT: &str = r#"

## MCP (Model Context Protocol)

If MCP tools are available in the current tool list, you can use them to fetch additional context:

- `list_mcp_resources`: Lists resources provided by MCP servers.
- `list_mcp_resource_templates`: Lists parameterized resource templates.
- `read_mcp_resource`: Reads a specific resource from an MCP server.

Guidelines:
- Prefer MCP resources over web search when the information is available via MCP.
- Use `list_mcp_resources` / `list_mcp_resource_templates` to discover what's available before reading.
"#;

/// Optional hint for Python command selection when `python` is not available but `python3` is.
pub const PYTHON3_FALLBACK_PROMPT: &str = r#"

### Python 命令提示

本机环境检测到 `python` 命令不可用，但 `python3` 可用。涉及 Python 时请优先使用 `python3`（例如 `python3 -c ...`）。
"#;

/// Workspace/workstudio prompt when WorkSpaceSupport is enabled for the selected agent.
///
/// This is appended as a system message (not merged into the user's system prompt) to avoid
/// polluting unrelated agents/tasks when the feature is disabled.
pub const WORKSTUDIO_PROMPT_GUIDE: &str = r#"

## 工作区（Workstudio）约定

你当前处于“工作区增强”模式：本次任务有一个默认工作目录（主文件夹），并可能包含额外的工作文件夹。请优先在该范围内完成内容生成、文件创建与编辑。

### 核心规则（优先级很高）

- 默认工作目录是“主文件夹”（见上方“当前工作区”）。当调用 `shell_command` / `exec_command` / `exec_command_persistent` 时：
  - 若未显式提供 `workdir`，则默认在主文件夹中执行。
  - 尽量使用相对路径（相对主文件夹），除非用户明确要求访问其它路径。
- 需要访问工作区外路径时先向用户确认；不要随意 `cd` 到系统目录或用户主目录的随机位置。需要切换目录时，请在工具参数中明确 `workdir`。
- 工作区内的配置可以放在主文件夹的 `.tauriai/` 目录中（例如 workstudio 布局/缓存/索引等）。

### 内容生成与编辑（建议）

- 需要产出代码/配置/文档时，优先通过工具把内容落到工作区内的文件里（而不是只在聊天里粘贴长文本）。
- 修改已有内容时，尽量基于现有文件做增量修改，保持工程结构一致。

### 文件夹与工程识别

- 你可以假设主文件夹是本次任务的“工程根目录/工作根目录”。
- 如果用户提供了额外文件夹，优先在主文件夹中进行构建/运行/搜索；需要跨文件夹操作时再扩展。
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

const TIME_TOOL_GUIDE: &str = "\n\n## 时间与日期\n\n- 如果涉及到“现在/今天/明天/本周/截止时间/几分钟前”等时间相关的问题或需要基于当前时间执行动作，并且工具可用，请先调用 `shell_command` 获取当前时间，再进行回答或计算；不要凭空猜测当前时间。\n- 优先输出 ISO8601：\n  - macOS/Linux: `date -u +\"%Y-%m-%dT%H:%M:%SZ\"`\n  - Windows PowerShell: `Get-Date -AsUTC -Format o`\n";

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

    // Always include a small, tool-aware time guideline to reduce "time blindness".
    let mut out = String::new();
    if !base.is_empty() {
        out.push_str(base);
    }
    out.push_str(TIME_TOOL_GUIDE);
    out.push_str(format);

    Some(out)
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
        let s = result.unwrap();
        assert!(s.contains("你是一个助手"));
        assert!(s.contains("shell_command"));
    }

    #[test]
    fn test_compose_empty() {
        let result = compose_system_prompt(None, FormatPromptType::None);
        assert!(result.is_none());
    }
}
