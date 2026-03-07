use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "tauri-ai-cli",
    version,
    about = "Interactive CLI/TUI for TauriAI"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Chat(ChatArgs),
    Sessions(SessionsArgs),
}

#[derive(Debug, Clone, Args, Default)]
pub struct ChatArgs {
    #[arg(long, help = "Force line-based REPL instead of full-screen TUI")]
    pub repl: bool,

    #[arg(long, help = "Force full-screen TUI mode")]
    pub tui: bool,

    #[arg(long, help = "Resume a specific conversation id")]
    pub conversation_id: Option<String>,

    #[arg(long, help = "Always create a new conversation")]
    pub new: bool,

    #[arg(long, help = "Optional title for a new conversation")]
    pub title: Option<String>,

    #[arg(long, help = "Override current agent")]
    pub agent: Option<String>,

    #[arg(long, help = "Override current model_ref (provider/model)")]
    pub model_ref: Option<String>,

    #[arg(long, help = "Override run mode")]
    pub run_mode: Option<String>,

    #[arg(long, help = "Override thinking level (off/low/medium/high)")]
    pub thinking: Option<String>,

    #[arg(
        long,
        help = "Override web search provider (off/native/tavily/google/brave)"
    )]
    pub web_search_provider: Option<String>,

    #[arg(long, help = "Enable debug mode")]
    pub debug_mode: bool,

    #[arg(trailing_var_arg = true)]
    pub prompt: Vec<String>,
}

impl ChatArgs {
    pub fn prompt_text(&self) -> Option<String> {
        let text = self.prompt.join(" ").trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

#[derive(Debug, Clone, Args)]
pub struct SessionsArgs {
    #[arg(
        long,
        default_value_t = 20,
        help = "Maximum number of sessions to print"
    )]
    pub limit: usize,

    #[arg(long, help = "Emit JSON instead of a table")]
    pub json: bool,
}
