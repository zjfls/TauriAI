use std::collections::HashMap;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use serde_json::Value;

use crate::models::{Message, MessageBlock, MessageRole};
use crate::runtime::events::{RunEvent, RunEventPayload};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    User,
    Assistant,
    Thinking,
    ToolCall,
    ToolResult,
    Approval,
    Error,
    WebSearch,
    Status,
    Info,
}

#[derive(Debug, Clone)]
pub struct TranscriptItem {
    pub kind: TranscriptKind,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub request_id: String,
    pub tool_name: String,
    pub arguments: String,
    pub reason: Option<String>,
    pub status: String,
}

#[derive(Debug, Default, Clone)]
pub struct TranscriptState {
    pub items: Vec<TranscriptItem>,
    pub pending_approval: Option<PendingApproval>,
    pub status_line: String,
    block_index: HashMap<String, usize>,
}

impl TranscriptState {
    pub fn from_messages(messages: &[Message]) -> Self {
        let mut state = Self {
            status_line: "Ready".to_string(),
            ..Default::default()
        };
        for message in messages {
            state.push_message(message);
        }
        state
    }

    pub fn push_user_input(&mut self, text: &str) {
        let trimmed = text.trim_end();
        if trimmed.is_empty() {
            return;
        }
        self.items.push(TranscriptItem {
            kind: TranscriptKind::User,
            title: "You".to_string(),
            body: trimmed.to_string(),
        });
    }

    pub fn push_info(&mut self, title: impl Into<String>, body: impl Into<String>) {
        self.items.push(TranscriptItem {
            kind: TranscriptKind::Info,
            title: title.into(),
            body: body.into(),
        });
    }

    pub fn apply_runtime_event(&mut self, payload: &RunEventPayload) {
        match &payload.event {
            RunEvent::TaskStarted { task_kind, .. } => {
                self.status_line = format!("Running {task_kind:?} task");
            }
            RunEvent::TurnStarted { turn_index, .. } => {
                self.status_line = format!("Turn {turn_index} running");
            }
            RunEvent::TurnFinished {
                status,
                usage,
                model,
                ..
            } => {
                let usage_text = usage
                    .as_ref()
                    .map(|usage| {
                        format!(
                            " in={} out={} total={}",
                            usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
                        )
                    })
                    .unwrap_or_default();
                let model_text = model
                    .as_deref()
                    .map(|value| format!(" model={value}"))
                    .unwrap_or_default();
                self.status_line = format!("Turn finished: {status:?}{model_text}{usage_text}");
            }
            RunEvent::BlockDelta {
                block_id,
                block_type,
                format,
                delta,
                ..
            } => {
                self.apply_block_delta(block_id, block_type, format.as_deref(), delta);
            }
            RunEvent::Done {
                full_content,
                model,
                usage,
                ..
            } => {
                if !full_content.trim().is_empty()
                    && !self
                        .items
                        .last()
                        .is_some_and(|item| item.kind == TranscriptKind::Assistant)
                {
                    self.items.push(TranscriptItem {
                        kind: TranscriptKind::Assistant,
                        title: "Assistant".to_string(),
                        body: full_content.clone(),
                    });
                }
                let usage_text = usage
                    .as_ref()
                    .map(|value| {
                        format!(
                            " in={} out={} total={}",
                            value.prompt_tokens, value.completion_tokens, value.total_tokens
                        )
                    })
                    .unwrap_or_default();
                self.status_line = format!(
                    "Done{}{}",
                    model
                        .as_deref()
                        .map(|value| format!(" model={value}"))
                        .unwrap_or_default(),
                    usage_text
                );
            }
            RunEvent::Error { error, .. } => {
                self.status_line = "Error".to_string();
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Error,
                    title: "Error".to_string(),
                    body: error.clone(),
                });
            }
            RunEvent::HistorySyncNeeded { reason, .. } => {
                self.status_line = format!("History updated: {reason}");
            }
            RunEvent::PlanCreated { .. }
            | RunEvent::TurnPhaseStarted { .. }
            | RunEvent::TurnPhaseFinished { .. } => {}
        }
    }

    pub fn render_text(&self) -> Text<'static> {
        let mut lines: Vec<Line<'static>> = Vec::new();
        for item in &self.items {
            let title_style = title_style(item.kind);
            lines.push(Line::from(vec![Span::styled(
                format!("{}", item.title),
                title_style,
            )]));

            for line in item.body.lines() {
                lines.push(Line::from(vec![Span::raw(format!("  {line}"))]));
            }
            if item.body.is_empty() {
                lines.push(Line::from("  "));
            }
            lines.push(Line::from(""));
        }
        if lines.is_empty() {
            lines.push(Line::from(vec![Span::styled(
                "No messages yet. Start typing below.",
                Style::default().fg(Color::DarkGray),
            )]));
        }
        Text::from(lines)
    }

    fn push_message(&mut self, message: &Message) {
        match message.role {
            MessageRole::User => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::User,
                    title: "You".to_string(),
                    body: message.content.clone(),
                });
            }
            MessageRole::Assistant => {
                if let Some(meta) = message.meta.as_ref() {
                    if let Some(blocks) = meta.blocks.as_ref() {
                        if !blocks.is_empty() {
                            for block in blocks {
                                self.push_message_block(block);
                            }
                            return;
                        }
                    }
                }

                if !message.content.trim().is_empty() {
                    self.items.push(TranscriptItem {
                        kind: TranscriptKind::Assistant,
                        title: "Assistant".to_string(),
                        body: message.content.clone(),
                    });
                }
                if let Some(thinking) = message
                    .thinking
                    .as_ref()
                    .filter(|text| !text.trim().is_empty())
                {
                    self.items.push(TranscriptItem {
                        kind: TranscriptKind::Thinking,
                        title: "Thinking".to_string(),
                        body: thinking.clone(),
                    });
                }
            }
            MessageRole::Tool => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::ToolResult,
                    title: "Tool".to_string(),
                    body: message.content.clone(),
                });
            }
            MessageRole::System => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Info,
                    title: "System".to_string(),
                    body: message.content.clone(),
                });
            }
        }
    }

    fn push_message_block(&mut self, block: &MessageBlock) {
        match block {
            MessageBlock::Text { id: _, text, .. } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Assistant,
                    title: "Assistant".to_string(),
                    body: text.clone(),
                });
            }
            MessageBlock::Thinking { id: _, text, .. } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Thinking,
                    title: "Thinking".to_string(),
                    body: text.clone(),
                });
            }
            MessageBlock::ToolCall {
                id: _,
                name,
                arguments,
                meta,
                ..
            } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::ToolCall,
                    title: format!("Tool Call · {name}"),
                    body: format_tool_call(arguments, meta.as_ref()),
                });
            }
            MessageBlock::ToolResult { id: _, text, .. } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::ToolResult,
                    title: "Tool Result".to_string(),
                    body: text.clone(),
                });
            }
            MessageBlock::Approval {
                id: _,
                request_id,
                tool_name,
                arguments,
                status,
                reason,
                ..
            } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Approval,
                    title: format!("Approval · {tool_name}"),
                    body: format_approval_body(arguments, reason.as_deref(), status),
                });
                if status == "pending" {
                    self.pending_approval = Some(PendingApproval {
                        request_id: request_id.clone(),
                        tool_name: tool_name.clone(),
                        arguments: arguments.clone(),
                        reason: reason.clone(),
                        status: status.clone(),
                    });
                }
            }
            MessageBlock::Error { id: _, text, .. } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Error,
                    title: "Error".to_string(),
                    body: text.clone(),
                });
            }
            MessageBlock::WebSearch {
                id: _,
                status,
                action,
                ..
            } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::WebSearch,
                    title: format!("Web Search · {status}"),
                    body: action
                        .as_ref()
                        .map(pretty_json_value)
                        .unwrap_or_else(|| "(no payload)".to_string()),
                });
            }
            MessageBlock::Unknown { id: _, data, .. } => {
                self.items.push(TranscriptItem {
                    kind: TranscriptKind::Info,
                    title: "Unknown Block".to_string(),
                    body: pretty_json_value(data),
                });
            }
        }
    }

    fn apply_block_delta(
        &mut self,
        block_id: &str,
        block_type: &str,
        format: Option<&str>,
        delta: &str,
    ) {
        let kind = match block_type {
            "text" => TranscriptKind::Assistant,
            "thinking" => TranscriptKind::Thinking,
            "tool_call" => TranscriptKind::ToolCall,
            "tool_result" => TranscriptKind::ToolResult,
            "approval" => TranscriptKind::Approval,
            "error" => TranscriptKind::Error,
            "web_search" => TranscriptKind::WebSearch,
            "status" => TranscriptKind::Status,
            _ => TranscriptKind::Info,
        };
        let index = if let Some(index) = self.block_index.get(block_id).copied() {
            index
        } else {
            self.items.push(TranscriptItem {
                kind,
                title: default_title(block_type).to_string(),
                body: String::new(),
            });
            let index = self.items.len() - 1;
            self.block_index.insert(block_id.to_string(), index);
            index
        };

        let item = &mut self.items[index];
        item.kind = kind;
        item.title = default_title(block_type).to_string();
        match block_type {
            "text" | "thinking" => {
                item.body.push_str(delta);
            }
            "tool_call" => {
                item.title =
                    parsed_tool_call_title(delta).unwrap_or_else(|| "Tool Call".to_string());
                item.body = parsed_tool_call_body(delta);
            }
            "tool_result" => {
                if item.body.is_empty() {
                    item.body = delta.to_string();
                } else if item.body != delta {
                    item.body.push_str("\n\n");
                    item.body.push_str(delta);
                }
            }
            "approval" => {
                item.title = parsed_approval_title(delta).unwrap_or_else(|| "Approval".to_string());
                item.body = parsed_approval_body(delta);
                self.pending_approval = parsed_pending_approval(delta).or_else(|| {
                    self.pending_approval
                        .as_ref()
                        .filter(|approval| {
                            approval.request_id != parsed_request_id(delta).unwrap_or_default()
                        })
                        .cloned()
                });
            }
            "web_search" => {
                item.body = parse_json_or_plain(delta, format);
            }
            "status" | "error" | _ => {
                item.body = parse_json_or_plain(delta, format);
            }
        }
    }
}

fn default_title(block_type: &str) -> &str {
    match block_type {
        "text" => "Assistant",
        "thinking" => "Thinking",
        "tool_call" => "Tool Call",
        "tool_result" => "Tool Result",
        "approval" => "Approval",
        "error" => "Error",
        "web_search" => "Web Search",
        "status" => "Status",
        _ => "Info",
    }
}

fn title_style(kind: TranscriptKind) -> Style {
    match kind {
        TranscriptKind::User => Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::Assistant => Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::Thinking => Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::ToolCall => Style::default()
            .fg(Color::Magenta)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::ToolResult => Style::default().fg(Color::LightMagenta),
        TranscriptKind::Approval => Style::default()
            .fg(Color::LightYellow)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::Error => Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        TranscriptKind::WebSearch => Style::default()
            .fg(Color::Blue)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::Status => Style::default()
            .fg(Color::LightBlue)
            .add_modifier(Modifier::BOLD),
        TranscriptKind::Info => Style::default()
            .fg(Color::Gray)
            .add_modifier(Modifier::BOLD),
    }
}

fn pretty_json_value(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn parse_json_or_plain(delta: &str, format: Option<&str>) -> String {
    if format == Some("json") {
        if let Ok(value) = serde_json::from_str::<Value>(delta) {
            return pretty_json_value(&value);
        }
    }
    delta.to_string()
}

fn format_tool_call(arguments: &str, meta: Option<&Value>) -> String {
    let mut sections = Vec::new();
    sections.push(parse_json_or_plain(arguments, Some("json")));
    if let Some(meta) = meta {
        sections.push(format!("meta:\n{}", pretty_json_value(meta)));
    }
    sections.join("\n\n")
}

fn format_approval_body(arguments: &str, reason: Option<&str>, status: &str) -> String {
    let mut lines = vec![format!("status: {status}")];
    if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
        lines.push(format!("reason: {reason}"));
    }
    lines.push("arguments:".to_string());
    lines.push(parse_json_or_plain(arguments, Some("json")));
    lines.join("\n")
}

fn parsed_tool_call_title(raw: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let name = value.get("name")?.as_str()?;
    Some(format!("Tool Call · {name}"))
}

fn parsed_tool_call_body(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    let arguments = value
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let meta = value.get("meta");
    format_tool_call(arguments, meta)
}

fn parsed_approval_title(raw: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let tool_name = value.get("tool_name")?.as_str()?;
    Some(format!("Approval · {tool_name}"))
}

fn parsed_request_id(raw: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    value
        .get("request_id")?
        .as_str()
        .map(|value| value.to_string())
}

fn parsed_approval_body(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    let arguments = value
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reason = value.get("reason").and_then(Value::as_str);
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format_approval_body(arguments, reason, status)
}

fn parsed_pending_approval(raw: &str) -> Option<PendingApproval> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let status = value.get("status")?.as_str()?.to_string();
    let request_id = value.get("request_id")?.as_str()?.to_string();
    if status != "pending" {
        return None;
    }
    Some(PendingApproval {
        request_id,
        tool_name: value.get("tool_name")?.as_str()?.to_string(),
        arguments: value
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        reason: value
            .get("reason")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        status,
    })
}
