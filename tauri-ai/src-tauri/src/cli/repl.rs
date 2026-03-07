use std::collections::HashSet;
use std::io::{self, BufRead, Write};

use tokio::sync::mpsc;

use crate::runtime::approvals::ApprovalDecision;
use crate::runtime::events::RunEvent;

use super::args::ChatArgs;
use super::commands::{help_text, parse_slash_command, SlashCommand};
use super::runtime::{
    format_message_for_list, normalize_thinking, normalize_web_search_provider, CliRuntime,
    RuntimeEvent, SessionPreferences, SessionState,
};
use super::transcript::TranscriptState;

pub async fn run_repl(args: ChatArgs) -> Result<(), String> {
    let runtime = CliRuntime::new().await?;
    let mut session = runtime
        .open_session(
            args.conversation_id.as_deref(),
            args.new,
            args.title.as_deref(),
            SessionPreferences::from_chat_args(&args),
        )
        .await?;
    let messages = runtime.load_messages(session.conversation_id()).await?;
    let mut transcript = TranscriptState::from_messages(&messages);

    println!("TauriAI REPL");
    println!("{}", runtime.resolve_session_summary(&session).await?);
    println!("Type /help for commands. Ctrl-D exits.\n");

    if let Some(initial_prompt) = args.prompt_text() {
        execute_prompt(&runtime, &mut session, &mut transcript, &initial_prompt).await?;
    }

    let stdin = io::stdin();
    loop {
        print!("tauri> ");
        io::stdout().flush().map_err(|e| e.to_string())?;

        let mut input = String::new();
        let bytes = stdin
            .lock()
            .read_line(&mut input)
            .map_err(|e| e.to_string())?;
        if bytes == 0 {
            println!();
            break;
        }

        let trimmed = input.trim_end_matches(['\n', '\r']);
        if trimmed.trim().is_empty() {
            continue;
        }

        if let Some(command) = parse_slash_command(trimmed) {
            if handle_slash_command(&runtime, &mut session, &mut transcript, command).await? {
                break;
            }
            continue;
        }

        execute_prompt(&runtime, &mut session, &mut transcript, trimmed).await?;
    }

    Ok(())
}

async fn execute_prompt(
    runtime: &CliRuntime,
    session: &mut SessionState,
    transcript: &mut TranscriptState,
    prompt: &str,
) -> Result<(), String> {
    transcript.push_user_input(prompt);
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    runtime
        .submit(session, prompt.to_string(), event_tx)
        .await?;

    let mut printed_special_blocks = HashSet::<String>::new();
    let mut text_line_open = false;
    while let Some(event) = event_rx.recv().await {
        match event {
            RuntimeEvent::Run(payload) => {
                transcript.apply_runtime_event(&payload);
                match &payload.event {
                    RunEvent::BlockDelta {
                        block_id,
                        block_type,
                        delta,
                        ..
                    } => match block_type.as_str() {
                        "text" => {
                            print!("{delta}");
                            io::stdout().flush().map_err(|e| e.to_string())?;
                            text_line_open = true;
                        }
                        "thinking" => {
                            if text_line_open {
                                println!();
                                text_line_open = false;
                            }
                            if printed_special_blocks.insert(block_id.clone()) {
                                println!("\n[thinking]");
                            }
                            print!("{delta}");
                            io::stdout().flush().map_err(|e| e.to_string())?;
                        }
                        "tool_call" | "tool_result" | "web_search" | "status" | "error" => {
                            if printed_special_blocks.insert(block_id.clone()) {
                                if text_line_open {
                                    println!();
                                    text_line_open = false;
                                }
                                let label = match block_type.as_str() {
                                    "tool_call" => "tool call",
                                    "tool_result" => "tool result",
                                    "web_search" => "web search",
                                    "status" => "status",
                                    _ => "error",
                                };
                                println!("\n[{label}]\n{delta}");
                            }
                        }
                        "approval" => {
                            if text_line_open {
                                println!();
                                text_line_open = false;
                            }
                            if let Some(approval) = transcript.pending_approval.clone() {
                                println!(
                                    "\n[approval] tool={} status={}{}",
                                    approval.tool_name,
                                    approval.status,
                                    approval
                                        .reason
                                        .as_deref()
                                        .map(|reason| format!(" reason={reason}"))
                                        .unwrap_or_default(),
                                );
                                println!("arguments:\n{}", approval.arguments);
                                let decision = prompt_for_approval()?;
                                let _ = runtime
                                    .respond_approval(
                                        session.conversation_id(),
                                        &approval.request_id,
                                        decision,
                                    )
                                    .await;
                            }
                        }
                        _ => {}
                    },
                    RunEvent::Done { .. } => {
                        if text_line_open {
                            println!();
                            text_line_open = false;
                        }
                    }
                    RunEvent::Error { error, .. } => {
                        if text_line_open {
                            println!();
                            text_line_open = false;
                        }
                        eprintln!("\n[run error] {error}");
                    }
                    _ => {}
                }
            }
            RuntimeEvent::Finished(finished) => {
                if text_line_open {
                    println!();
                }
                if let Some(conversation) = finished.conversation {
                    session.conversation = conversation;
                    session
                        .preferences
                        .apply_missing_from_conversation(&session.conversation);
                }
                match finished.result {
                    Ok(()) => {
                        println!("\n[ok] {}\n", transcript.status_line);
                    }
                    Err(error) => {
                        println!("\n[failed] {error}\n");
                    }
                }
                return Ok(());
            }
        }
    }

    Ok(())
}

async fn handle_slash_command(
    runtime: &CliRuntime,
    session: &mut SessionState,
    transcript: &mut TranscriptState,
    command: SlashCommand,
) -> Result<bool, String> {
    match command {
        SlashCommand::Help => {
            println!("{}", help_text());
        }
        SlashCommand::New { title } => {
            let new_session = runtime
                .open_session(None, true, title.as_deref(), session.preferences.clone())
                .await?;
            *session = new_session;
            let messages = runtime.load_messages(session.conversation_id()).await?;
            *transcript = TranscriptState::from_messages(&messages);
            println!("Started new conversation: {}", session.title());
        }
        SlashCommand::Sessions => {
            let conversations = runtime.list_conversations(20).await?;
            if conversations.is_empty() {
                println!("No conversations found.");
            } else {
                for (index, conversation) in conversations.iter().enumerate() {
                    let preview = runtime
                        .load_messages(&conversation.id)
                        .await?
                        .last()
                        .map(format_message_for_list)
                        .unwrap_or_else(|| "(empty)".to_string());
                    println!(
                        "[{}] {}\n     id={}\n     {}\n",
                        index + 1,
                        conversation.title,
                        conversation.id,
                        preview,
                    );
                }
            }
        }
        SlashCommand::Resume { target } => {
            let conversation = runtime.conversation_from_target(&target).await?;
            session.conversation = conversation;
            session
                .preferences
                .apply_missing_from_conversation(&session.conversation);
            let messages = runtime.load_messages(session.conversation_id()).await?;
            *transcript = TranscriptState::from_messages(&messages);
            println!("Resumed: {}", session.title());
        }
        SlashCommand::Fork { target } => {
            let source = runtime.conversation_from_target(&target).await?;
            session.conversation = runtime.clone_conversation(&source.id).await?;
            session
                .preferences
                .apply_missing_from_conversation(&session.conversation);
            let messages = runtime.load_messages(session.conversation_id()).await?;
            *transcript = TranscriptState::from_messages(&messages);
            println!("Forked into: {}", session.title());
        }
        SlashCommand::Agent { name } => {
            session.preferences.agent_name = Some(name.clone());
            runtime.refresh_session(session).await?;
            println!("Agent set to {name}");
        }
        SlashCommand::Model { model_ref } => {
            session.preferences.model_ref = Some(model_ref.clone());
            runtime.refresh_session(session).await?;
            println!("Model set to {model_ref}");
        }
        SlashCommand::Thinking { value } => {
            session.preferences.thinking = normalize_thinking(Some(&value));
            runtime.refresh_session(session).await?;
            println!("Thinking set to {value}");
        }
        SlashCommand::Search { value } => {
            session.preferences.web_search_provider = normalize_web_search_provider(Some(&value));
            runtime.refresh_session(session).await?;
            println!(
                "Web search set to {}",
                session
                    .preferences
                    .web_search_provider
                    .clone()
                    .unwrap_or_else(|| "off".to_string())
            );
        }
        SlashCommand::Rename { title } => {
            session.conversation = runtime
                .rename_conversation(session.conversation_id(), &title)
                .await?;
            println!("Renamed conversation to {}", session.title());
        }
        SlashCommand::Status => {
            println!("{}", runtime.resolve_session_summary(session).await?);
        }
        SlashCommand::Quit => return Ok(true),
    }

    Ok(false)
}

fn prompt_for_approval() -> Result<ApprovalDecision, String> {
    loop {
        print!("Approve? [a]pprove / approve for [s]ession / [d]eny / [x]abort: ");
        io::stdout().flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        io::stdin()
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        match line.trim().to_ascii_lowercase().as_str() {
            "a" | "approve" => return Ok(ApprovalDecision::Approved),
            "s" | "session" => return Ok(ApprovalDecision::ApprovedForSession),
            "d" | "deny" => return Ok(ApprovalDecision::Denied),
            "x" | "abort" => return Ok(ApprovalDecision::Abort),
            _ => println!("Please enter a/s/d/x."),
        }
    }
}
