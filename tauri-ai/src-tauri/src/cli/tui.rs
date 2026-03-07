use std::io;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use crossterm::event::{self, Event as CEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Terminal;
use tokio::sync::mpsc;
use tui_textarea::{Input, Key, TextArea};

use crate::runtime::approvals::ApprovalDecision;

use super::args::ChatArgs;
use super::commands::{help_text, parse_slash_command, SlashCommand};
use super::runtime::{
    normalize_thinking, normalize_web_search_provider, AgentChoice, CliRuntime, ModelChoice,
    RuntimeEvent, SessionPreferences, SessionState,
};
use super::transcript::{PendingApproval, TranscriptState};

pub async fn run_tui(args: ChatArgs) -> Result<(), String> {
    let runtime = CliRuntime::new().await?;
    let session = runtime
        .open_session(
            args.conversation_id.as_deref(),
            args.new,
            args.title.as_deref(),
            SessionPreferences::from_chat_args(&args),
        )
        .await?;
    let messages = runtime.load_messages(session.conversation_id()).await?;

    let (runtime_tx, runtime_rx) = mpsc::unbounded_channel();
    let (terminal_tx, mut terminal_rx) = mpsc::unbounded_channel();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();
    std::thread::spawn(move || {
        while !stop_flag_for_thread.load(Ordering::Relaxed) {
            match event::poll(Duration::from_millis(50)) {
                Ok(true) => {
                    if let Ok(event) = event::read() {
                        let _ = terminal_tx.send(TerminalEvent::Event(event));
                    }
                }
                Ok(false) => {
                    let _ = terminal_tx.send(TerminalEvent::Tick);
                }
                Err(_) => {
                    let _ = terminal_tx.send(TerminalEvent::Tick);
                }
            }
        }
    });

    let mut terminal_guard = TerminalGuard::new().map_err(|e| e.to_string())?;
    let mut app = TuiApp::new(
        runtime,
        session,
        TranscriptState::from_messages(&messages),
        runtime_tx,
        runtime_rx,
    )
    .await?;
    if let Some(initial_prompt) = args.prompt_text() {
        app.set_input(&initial_prompt);
        app.submit_current_input().await?;
    }

    let loop_result = async {
        loop {
            terminal_guard
                .terminal
                .draw(|frame| app.render(frame))
                .map_err(|e| e.to_string())?;

            tokio::select! {
                maybe_runtime_event = app.runtime_rx.recv() => {
                    if let Some(event) = maybe_runtime_event {
                        app.handle_runtime_event(event).await?;
                    }
                }
                maybe_terminal_event = terminal_rx.recv() => {
                    if let Some(event) = maybe_terminal_event {
                        app.handle_terminal_event(event).await?;
                    }
                }
            }

            if app.should_quit {
                break;
            }
        }
        Ok::<(), String>(())
    }
    .await;

    stop_flag.store(true, Ordering::Relaxed);
    loop_result
}

struct TuiApp {
    runtime: CliRuntime,
    session: SessionState,
    transcript: TranscriptState,
    textarea: TextArea<'static>,
    runtime_tx: mpsc::UnboundedSender<RuntimeEvent>,
    runtime_rx: mpsc::UnboundedReceiver<RuntimeEvent>,
    running: bool,
    should_quit: bool,
    overlay: Overlay,
    sessions: Vec<crate::models::Conversation>,
    agents: Vec<AgentChoice>,
    models: Vec<ModelChoice>,
    scroll: u16,
    footer: String,
    summary: String,
}

#[derive(Debug, Clone)]
enum Overlay {
    None,
    Help,
    Sessions { selected: usize },
    Agents { selected: usize },
    Models { selected: usize },
    Approval(PendingApproval),
}

#[derive(Debug, Clone)]
enum TerminalEvent {
    Event(CEvent),
    Tick,
}

impl TuiApp {
    async fn new(
        runtime: CliRuntime,
        session: SessionState,
        transcript: TranscriptState,
        runtime_tx: mpsc::UnboundedSender<RuntimeEvent>,
        runtime_rx: mpsc::UnboundedReceiver<RuntimeEvent>,
    ) -> Result<Self, String> {
        let mut textarea = TextArea::default();
        textarea.set_cursor_line_style(Style::default());
        let summary = runtime.resolve_session_summary(&session).await?;
        Ok(Self {
            runtime,
            session,
            transcript,
            textarea,
            runtime_tx,
            runtime_rx,
            running: false,
            should_quit: false,
            overlay: Overlay::None,
            sessions: Vec::new(),
            agents: Vec::new(),
            models: Vec::new(),
            scroll: 0,
            footer: "F1 help · F2 sessions · F3 agents · F4 models · Enter send · Ctrl+N newline · Ctrl+C abort/quit".to_string(),
            summary,
        })
    }

    fn set_input(&mut self, text: &str) {
        self.textarea = TextArea::default();
        self.textarea.insert_str(text);
    }

    fn input_text(&self) -> String {
        self.textarea.lines().join("\n")
    }

    fn clear_input(&mut self) {
        self.textarea = TextArea::default();
    }

    async fn refresh_summary(&mut self) -> Result<(), String> {
        self.summary = self.runtime.resolve_session_summary(&self.session).await?;
        Ok(())
    }

    async fn submit_current_input(&mut self) -> Result<(), String> {
        if self.running {
            self.transcript.status_line = "A run is already in progress".to_string();
            return Ok(());
        }

        let input = self.input_text();
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Ok(());
        }

        if let Some(command) = parse_slash_command(trimmed) {
            let should_quit = self.execute_slash_command(command).await?;
            if should_quit {
                self.should_quit = true;
            }
            self.clear_input();
            return Ok(());
        }

        self.transcript.push_user_input(trimmed);
        self.clear_input();
        self.running = true;
        self.transcript.status_line = "Running…".to_string();
        self.runtime
            .submit(&self.session, trimmed.to_string(), self.runtime_tx.clone())
            .await?;
        Ok(())
    }

    async fn execute_slash_command(&mut self, command: SlashCommand) -> Result<bool, String> {
        match command {
            SlashCommand::Help => {
                self.overlay = Overlay::Help;
            }
            SlashCommand::New { title } => {
                self.session = self
                    .runtime
                    .open_session(
                        None,
                        true,
                        title.as_deref(),
                        self.session.preferences.clone(),
                    )
                    .await?;
                self.reload_current_conversation().await?;
            }
            SlashCommand::Sessions => {
                self.open_sessions_overlay().await?;
            }
            SlashCommand::Resume { target } => {
                self.session.conversation = self.runtime.conversation_from_target(&target).await?;
                self.session
                    .preferences
                    .apply_missing_from_conversation(&self.session.conversation);
                self.reload_current_conversation().await?;
            }
            SlashCommand::Fork { target } => {
                let source = self.runtime.conversation_from_target(&target).await?;
                self.session.conversation = self.runtime.clone_conversation(&source.id).await?;
                self.session
                    .preferences
                    .apply_missing_from_conversation(&self.session.conversation);
                self.reload_current_conversation().await?;
            }
            SlashCommand::Agent { name } => {
                self.session.preferences.agent_name = Some(name);
                self.runtime.refresh_session(&mut self.session).await?;
                self.refresh_summary().await?;
            }
            SlashCommand::Model { model_ref } => {
                self.session.preferences.model_ref = Some(model_ref);
                self.runtime.refresh_session(&mut self.session).await?;
                self.refresh_summary().await?;
            }
            SlashCommand::Thinking { value } => {
                self.session.preferences.thinking = normalize_thinking(Some(&value));
                self.runtime.refresh_session(&mut self.session).await?;
                self.refresh_summary().await?;
            }
            SlashCommand::Search { value } => {
                self.session.preferences.web_search_provider =
                    normalize_web_search_provider(Some(&value));
                self.runtime.refresh_session(&mut self.session).await?;
                self.refresh_summary().await?;
            }
            SlashCommand::Rename { title } => {
                self.session.conversation = self
                    .runtime
                    .rename_conversation(self.session.conversation_id(), &title)
                    .await?;
                self.refresh_summary().await?;
            }
            SlashCommand::Status => {
                self.transcript.push_info(
                    "Status",
                    self.runtime.resolve_session_summary(&self.session).await?,
                );
            }
            SlashCommand::Quit => return Ok(true),
        }
        Ok(false)
    }

    async fn reload_current_conversation(&mut self) -> Result<(), String> {
        let messages = self
            .runtime
            .load_messages(self.session.conversation_id())
            .await?;
        self.transcript = TranscriptState::from_messages(&messages);
        self.overlay = Overlay::None;
        self.scroll = 0;
        self.refresh_summary().await
    }

    async fn open_sessions_overlay(&mut self) -> Result<(), String> {
        self.sessions = self.runtime.list_conversations(50).await?;
        self.overlay = Overlay::Sessions { selected: 0 };
        Ok(())
    }

    async fn open_agents_overlay(&mut self) -> Result<(), String> {
        self.agents = self.runtime.list_agents().await?;
        self.overlay = Overlay::Agents { selected: 0 };
        Ok(())
    }

    async fn open_models_overlay(&mut self) -> Result<(), String> {
        self.models = self.runtime.list_models().await?;
        self.overlay = Overlay::Models { selected: 0 };
        Ok(())
    }

    async fn handle_runtime_event(&mut self, event: RuntimeEvent) -> Result<(), String> {
        match event {
            RuntimeEvent::Run(payload) => {
                self.transcript.apply_runtime_event(&payload);
                if let Some(approval) = self.transcript.pending_approval.clone() {
                    self.overlay = Overlay::Approval(approval);
                } else if matches!(self.overlay, Overlay::Approval(_)) {
                    self.overlay = Overlay::None;
                }
            }
            RuntimeEvent::Finished(finished) => {
                self.running = false;
                if let Some(conversation) = finished.conversation {
                    self.session.conversation = conversation;
                    self.session
                        .preferences
                        .apply_missing_from_conversation(&self.session.conversation);
                    self.refresh_summary().await?;
                }
                match finished.result {
                    Ok(()) => {
                        self.transcript.status_line = "Run complete".to_string();
                    }
                    Err(error) => {
                        self.transcript.push_info("Run failed", error.clone());
                        self.transcript.status_line = error;
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle_terminal_event(&mut self, event: TerminalEvent) -> Result<(), String> {
        match event {
            TerminalEvent::Tick => {}
            TerminalEvent::Event(CEvent::Resize(_, _)) => {}
            TerminalEvent::Event(CEvent::Mouse(_)) => {}
            TerminalEvent::Event(CEvent::Paste(text)) => {
                self.textarea.insert_str(text);
            }
            TerminalEvent::Event(CEvent::Key(key)) => {
                if key.kind != KeyEventKind::Press {
                    return Ok(());
                }
                let overlay = self.overlay.clone();
                match overlay {
                    Overlay::None => self.handle_main_key(key).await?,
                    Overlay::Help => {
                        if matches!(key.code, KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q')) {
                            self.overlay = Overlay::None;
                        }
                    }
                    Overlay::Sessions { selected } => {
                        self.handle_sessions_overlay_key(key, selected).await?;
                    }
                    Overlay::Agents { selected } => {
                        self.handle_agents_overlay_key(key, selected).await?;
                    }
                    Overlay::Models { selected } => {
                        self.handle_models_overlay_key(key, selected).await?;
                    }
                    Overlay::Approval(approval) => {
                        self.handle_approval_key(key, approval).await?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_main_key(&mut self, key: KeyEvent) -> Result<(), String> {
        match (key.code, key.modifiers) {
            (KeyCode::F(1), _) => self.overlay = Overlay::Help,
            (KeyCode::F(2), _) => self.open_sessions_overlay().await?,
            (KeyCode::F(3), _) => self.open_agents_overlay().await?,
            (KeyCode::F(4), _) => self.open_models_overlay().await?,
            (KeyCode::PageUp, _) => self.scroll = self.scroll.saturating_add(5),
            (KeyCode::PageDown, _) => self.scroll = self.scroll.saturating_sub(5),
            (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                if self.running {
                    self.runtime.abort(self.session.conversation_id()).await;
                    self.transcript.status_line = "Abort requested".to_string();
                } else {
                    self.should_quit = true;
                }
            }
            (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                self.textarea.insert_str("\n");
            }
            (KeyCode::Enter, _) => {
                self.submit_current_input().await?;
            }
            (KeyCode::Esc, _) => self.clear_input(),
            _ => {
                self.textarea.input(convert_key_event(key));
            }
        }
        Ok(())
    }

    async fn handle_sessions_overlay_key(
        &mut self,
        key: KeyEvent,
        mut selected: usize,
    ) -> Result<(), String> {
        match key.code {
            KeyCode::Esc => self.overlay = Overlay::None,
            KeyCode::Up => {
                selected = selected.saturating_sub(1);
                self.overlay = Overlay::Sessions { selected };
            }
            KeyCode::Down => {
                if !self.sessions.is_empty() {
                    selected = (selected + 1).min(self.sessions.len().saturating_sub(1));
                }
                self.overlay = Overlay::Sessions { selected };
            }
            KeyCode::Char('r') => self.open_sessions_overlay().await?,
            KeyCode::Char('n') => {
                self.session = self
                    .runtime
                    .open_session(None, true, None, self.session.preferences.clone())
                    .await?;
                self.reload_current_conversation().await?;
            }
            KeyCode::Char('f') => {
                if let Some(conversation) = self.sessions.get(selected) {
                    self.session.conversation =
                        self.runtime.clone_conversation(&conversation.id).await?;
                    self.reload_current_conversation().await?;
                }
            }
            KeyCode::Enter => {
                if let Some(conversation) = self.sessions.get(selected) {
                    self.session.conversation = conversation.clone();
                    self.session
                        .preferences
                        .apply_missing_from_conversation(&self.session.conversation);
                    self.reload_current_conversation().await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_agents_overlay_key(
        &mut self,
        key: KeyEvent,
        mut selected: usize,
    ) -> Result<(), String> {
        match key.code {
            KeyCode::Esc => self.overlay = Overlay::None,
            KeyCode::Up => {
                selected = selected.saturating_sub(1);
                self.overlay = Overlay::Agents { selected };
            }
            KeyCode::Down => {
                if !self.agents.is_empty() {
                    selected = (selected + 1).min(self.agents.len().saturating_sub(1));
                }
                self.overlay = Overlay::Agents { selected };
            }
            KeyCode::Enter => {
                if let Some(agent) = self.agents.get(selected) {
                    self.session.preferences.agent_name = Some(agent.name.clone());
                    self.runtime.refresh_session(&mut self.session).await?;
                    self.refresh_summary().await?;
                    self.overlay = Overlay::None;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_models_overlay_key(
        &mut self,
        key: KeyEvent,
        mut selected: usize,
    ) -> Result<(), String> {
        match key.code {
            KeyCode::Esc => self.overlay = Overlay::None,
            KeyCode::Up => {
                selected = selected.saturating_sub(1);
                self.overlay = Overlay::Models { selected };
            }
            KeyCode::Down => {
                if !self.models.is_empty() {
                    selected = (selected + 1).min(self.models.len().saturating_sub(1));
                }
                self.overlay = Overlay::Models { selected };
            }
            KeyCode::Enter => {
                if let Some(model) = self.models.get(selected) {
                    self.session.preferences.model_ref = Some(model.model_ref.clone());
                    self.runtime.refresh_session(&mut self.session).await?;
                    self.refresh_summary().await?;
                    self.overlay = Overlay::None;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_approval_key(
        &mut self,
        key: KeyEvent,
        approval: PendingApproval,
    ) -> Result<(), String> {
        let decision = match key.code {
            KeyCode::Char('a') => Some(ApprovalDecision::Approved),
            KeyCode::Char('s') => Some(ApprovalDecision::ApprovedForSession),
            KeyCode::Char('d') => Some(ApprovalDecision::Denied),
            KeyCode::Char('x') | KeyCode::Esc => Some(ApprovalDecision::Abort),
            _ => None,
        };
        if let Some(decision) = decision {
            let _ = self
                .runtime
                .respond_approval(
                    self.session.conversation_id(),
                    &approval.request_id,
                    decision,
                )
                .await;
            self.overlay = Overlay::None;
        }
        Ok(())
    }

    fn render(&mut self, frame: &mut ratatui::Frame<'_>) {
        let size = frame.area();
        let input_height = (self.textarea.lines().len() as u16).clamp(3, 8) + 2;
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(1),
                Constraint::Length(input_height),
                Constraint::Length(1),
            ])
            .split(size);

        let header = Paragraph::new(self.summary.clone())
            .block(Block::default().borders(Borders::ALL).title("Session"))
            .wrap(Wrap { trim: false });
        frame.render_widget(header, chunks[0]);

        let transcript = Paragraph::new(self.transcript.render_text())
            .block(Block::default().borders(Borders::ALL).title("Conversation"))
            .wrap(Wrap { trim: false })
            .scroll((self.scroll, 0));
        frame.render_widget(transcript, chunks[1]);

        self.textarea.set_block(
            Block::default()
                .borders(Borders::ALL)
                .title(if self.running {
                    "Input (busy)"
                } else {
                    "Input"
                }),
        );
        frame.render_widget(&self.textarea, chunks[2]);

        let footer_text = if self.running {
            format!("{} | {}", self.footer, self.transcript.status_line)
        } else {
            format!("{} | {}", self.footer, self.transcript.status_line)
        };
        let footer = Paragraph::new(footer_text)
            .alignment(Alignment::Left)
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(footer, chunks[3]);

        match &self.overlay {
            Overlay::None => {}
            Overlay::Help => render_help_overlay(frame, size),
            Overlay::Sessions { selected } => {
                render_sessions_overlay(frame, size, &self.sessions, *selected)
            }
            Overlay::Agents { selected } => {
                render_agents_overlay(frame, size, &self.agents, *selected)
            }
            Overlay::Models { selected } => {
                render_models_overlay(frame, size, &self.models, *selected)
            }
            Overlay::Approval(approval) => render_approval_overlay(frame, size, approval),
        }
    }
}

fn render_help_overlay(frame: &mut ratatui::Frame<'_>, area: Rect) {
    let popup = centered_rect(70, 70, area);
    frame.render_widget(Clear, popup);
    let text = format!(
        "{}\n\nKeys:\n  F1 Help\n  F2 Sessions\n  F3 Agents\n  F4 Models\n  Enter Send\n  Ctrl+N Insert newline\n  Ctrl+C Abort run / Quit\n  PageUp/PageDown Scroll transcript\n  Esc Close overlay or clear input\n\nApproval overlay:\n  a approve · s approve for session · d deny · x abort",
        help_text()
    );
    let widget = Paragraph::new(text)
        .block(Block::default().borders(Borders::ALL).title("Help"))
        .wrap(Wrap { trim: false });
    frame.render_widget(widget, popup);
}

fn render_sessions_overlay(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    sessions: &[crate::models::Conversation],
    selected: usize,
) {
    let popup = centered_rect(80, 70, area);
    frame.render_widget(Clear, popup);
    let items = if sessions.is_empty() {
        vec![ListItem::new("No conversations")]
    } else {
        sessions
            .iter()
            .enumerate()
            .map(|(index, conversation)| {
                ListItem::new(format!(
                    "[{}] {}\n    {} · {}",
                    index + 1,
                    conversation.title,
                    conversation.id,
                    conversation.updated_at.format("%Y-%m-%d %H:%M")
                ))
            })
            .collect::<Vec<_>>()
    };
    let mut state = ListState::default();
    if !sessions.is_empty() {
        state.select(Some(selected.min(sessions.len().saturating_sub(1))));
    }
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Sessions · Enter resume · f fork · n new · r refresh"),
        )
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        );
    frame.render_stateful_widget(list, popup, &mut state);
}

fn render_agents_overlay(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    agents: &[AgentChoice],
    selected: usize,
) {
    let popup = centered_rect(60, 60, area);
    frame.render_widget(Clear, popup);
    let items = if agents.is_empty() {
        vec![ListItem::new("No agents")]
    } else {
        agents
            .iter()
            .map(|agent| ListItem::new(format!("{}\n    {}", agent.display_name, agent.model_ref)))
            .collect::<Vec<_>>()
    };
    let mut state = ListState::default();
    if !agents.is_empty() {
        state.select(Some(selected.min(agents.len().saturating_sub(1))));
    }
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Agents · Enter apply"),
        )
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        );
    frame.render_stateful_widget(list, popup, &mut state);
}

fn render_models_overlay(
    frame: &mut ratatui::Frame<'_>,
    area: Rect,
    models: &[ModelChoice],
    selected: usize,
) {
    let popup = centered_rect(70, 70, area);
    frame.render_widget(Clear, popup);
    let items = if models.is_empty() {
        vec![ListItem::new("No models")]
    } else {
        models
            .iter()
            .map(|model| ListItem::new(format!("{}\n    {}", model.label, model.model_ref)))
            .collect::<Vec<_>>()
    };
    let mut state = ListState::default();
    if !models.is_empty() {
        state.select(Some(selected.min(models.len().saturating_sub(1))));
    }
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Models · Enter apply"),
        )
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        );
    frame.render_stateful_widget(list, popup, &mut state);
}

fn render_approval_overlay(frame: &mut ratatui::Frame<'_>, area: Rect, approval: &PendingApproval) {
    let popup = centered_rect(70, 55, area);
    frame.render_widget(Clear, popup);
    let text = format!(
        "Tool: {}\nStatus: {}\n{}\n\nArguments:\n{}\n\nKeys: a approve · s approve for session · d deny · x abort",
        approval.tool_name,
        approval.status,
        approval
            .reason
            .as_deref()
            .map(|reason| format!("Reason: {reason}"))
            .unwrap_or_default(),
        approval.arguments,
    );
    let widget = Paragraph::new(text)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Approval Required"),
        )
        .wrap(Wrap { trim: false });
    frame.render_widget(widget, popup);
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

fn convert_key_event(key: KeyEvent) -> Input {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let mapped = match key.code {
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Enter => Key::Enter,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Home => Key::Home,
        KeyCode::End => Key::End,
        KeyCode::PageUp => Key::PageUp,
        KeyCode::PageDown => Key::PageDown,
        KeyCode::Tab => Key::Tab,
        KeyCode::Delete => Key::Delete,
        KeyCode::Esc => Key::Esc,
        KeyCode::Char(c) => Key::Char(c),
        _ => Key::Null,
    };
    Input {
        key: mapped,
        ctrl,
        alt,
        shift,
    }
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
}

impl TerminalGuard {
    fn new() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}
