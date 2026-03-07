#[derive(Debug, Clone)]
pub enum SlashCommand {
    Help,
    New { title: Option<String> },
    Sessions,
    Resume { target: String },
    Fork { target: String },
    Agent { name: String },
    Model { model_ref: String },
    Thinking { value: String },
    Search { value: String },
    Rename { title: String },
    Status,
    Quit,
}

pub fn parse_slash_command(input: &str) -> Option<SlashCommand> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return None;
    }

    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let command = parts.next()?.trim();
    let rest = parts.next().unwrap_or("").trim();

    match command {
        "/help" | "/?" => Some(SlashCommand::Help),
        "/new" => Some(SlashCommand::New {
            title: if rest.is_empty() {
                None
            } else {
                Some(rest.to_string())
            },
        }),
        "/sessions" => Some(SlashCommand::Sessions),
        "/resume" if !rest.is_empty() => Some(SlashCommand::Resume {
            target: rest.to_string(),
        }),
        "/fork" if !rest.is_empty() => Some(SlashCommand::Fork {
            target: rest.to_string(),
        }),
        "/agent" if !rest.is_empty() => Some(SlashCommand::Agent {
            name: rest.to_string(),
        }),
        "/model" if !rest.is_empty() => Some(SlashCommand::Model {
            model_ref: rest.to_string(),
        }),
        "/thinking" if !rest.is_empty() => Some(SlashCommand::Thinking {
            value: rest.to_string(),
        }),
        "/search" if !rest.is_empty() => Some(SlashCommand::Search {
            value: rest.to_string(),
        }),
        "/rename" if !rest.is_empty() => Some(SlashCommand::Rename {
            title: rest.to_string(),
        }),
        "/status" => Some(SlashCommand::Status),
        "/quit" | "/exit" => Some(SlashCommand::Quit),
        _ => None,
    }
}

pub fn help_text() -> &'static str {
    "Commands:\n  /help                Show help\n  /new [title]         Create a new conversation\n  /sessions            Show recent conversations\n  /resume <id|index>   Resume a conversation\n  /fork <id|index>     Clone a conversation\n  /agent <name>        Switch current agent\n  /model <ref>         Switch current model_ref\n  /thinking <value>    Set thinking mode (off/low/medium/high)\n  /search <value>      Set web search provider (off/native/tavily/google/brave)\n  /rename <title>      Rename current conversation\n  /status              Show current session status\n  /quit                Exit the CLI"
}
