mod args;
mod commands;
mod repl;
mod runtime;
mod transcript;
mod tui;

use std::io::IsTerminal;

use clap::Parser;

use args::{ChatArgs, Cli, Command};
use runtime::CliRuntime;

pub use runtime::{AgentChoice, ModelChoice, SessionPreferences, SessionState};

pub async fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Chat(ChatArgs::default())) {
        Command::Chat(args) => {
            let should_use_tui = if args.repl {
                false
            } else if args.tui {
                true
            } else {
                std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
            };

            if should_use_tui {
                tui::run_tui(args).await
            } else {
                repl::run_repl(args).await
            }
        }
        Command::Sessions(args) => {
            let runtime = CliRuntime::new().await?;
            let sessions = runtime.list_conversations(args.limit).await?;
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?
                );
                return Ok(());
            }

            if sessions.is_empty() {
                println!("No conversations found.");
                return Ok(());
            }

            for (index, conversation) in sessions.iter().enumerate() {
                let model = conversation.model_ref.as_deref().unwrap_or("-");
                let agent = conversation.agent_name.as_deref().unwrap_or("-");
                let updated_at = conversation.updated_at.format("%Y-%m-%d %H:%M");
                println!(
                    "[{:<2}] {}\n      id={}\n      agent={}  model={}  updated={}\n",
                    index + 1,
                    conversation.title,
                    conversation.id,
                    agent,
                    model,
                    updated_at,
                );
            }
            Ok(())
        }
    }
}
