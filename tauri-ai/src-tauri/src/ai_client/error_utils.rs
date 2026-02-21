use std::collections::HashMap;
use std::error::Error as StdError;

const MAX_ERROR_TEXT_LEN: usize = 12_000;
const MAX_SNIPPET_CHARS: usize = 1200;

#[derive(Debug, Clone, Default)]
pub struct StreamProtocolContext {
    /// Human-readable protocol hint, e.g. "sse_marker (data: JSON)" / "ndjson (one JSON per line)".
    pub expected_protocol: Option<String>,
    /// Completion marker/event we expect, e.g. "[DONE]" / "message_stop" / "done=true".
    pub expected_signal: Option<String>,
    /// Observed completion marker/event (if any).
    pub observed_signal: Option<String>,
    /// Provider event type, if the protocol carries it (e.g. Anthropic/OpenAI Responses `type` field).
    pub last_event_type: Option<String>,
    /// Last successfully decoded `data:` payload / JSON line (best-effort, truncated).
    pub last_data_snippet: Option<String>,
    /// Tail of the in-memory stream buffer at failure time (best-effort, truncated).
    pub buffer_tail: Option<String>,
    /// Received transport chunks count (best-effort). Note: this is not SSE "event" count.
    pub chunks_received: Option<u32>,
    /// Received protocol payload count (e.g. SSE `data:` lines / NDJSON lines).
    pub events_received: Option<u32>,
}

fn truncate(mut s: String) -> String {
    if s.len() <= MAX_ERROR_TEXT_LEN {
        return s;
    }
    s.truncate(MAX_ERROR_TEXT_LEN);
    s.push_str("\n...(truncated)");
    s
}

fn redact_url(url: &str) -> String {
    // Avoid leaking secrets embedded in query params (e.g. Google `?key=...`).
    url.split('?').next().unwrap_or(url).to_string()
}

fn header_value<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    let key = name.to_ascii_lowercase();
    headers.get(&key).map(|s| s.as_str())
}

fn format_error_chain(err: &dyn StdError) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = err.source();
    let mut depth: usize = 0;
    while let Some(e) = cur {
        depth = depth.saturating_add(1);
        out.push(format!("caused_by[{depth}]: {e}"));
        cur = e.source();
        if depth >= 12 {
            out.push("caused_by: ...(truncated)".to_string());
            break;
        }
    }
    out
}

fn head_chars(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            out.push_str("...(truncated)");
            break;
        }
        out.push(ch);
    }
    out
}

fn tail_chars(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    let skip = total.saturating_sub(max_chars);
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i < skip {
            continue;
        }
        out.push(ch);
    }
    format!("...(truncated head)\n{out}")
}

pub fn format_reqwest_stream_error(
    provider: &str,
    model: &str,
    url: Option<&str>,
    status: Option<u16>,
    headers: Option<&HashMap<String, String>>,
    err: &reqwest::Error,
    stream_ctx: Option<&StreamProtocolContext>,
) -> String {
    let mut lines: Vec<String> = Vec::new();

    // Summary first (kept intentionally short; details follow).
    lines.push(err.to_string());

    // Context
    lines.push(String::new());
    lines.push("context:".to_string());
    lines.push(format!("- provider: {provider}"));
    lines.push(format!("- model: {model}"));
    if let Some(u) = url {
        lines.push(format!("- url: {}", redact_url(u)));
    }
    if let Some(code) = status {
        lines.push(format!("- http_status: {code}"));
    }

    if let Some(h) = headers {
        if let Some(v) = header_value(h, "content-type") {
            if !v.trim().is_empty() {
                lines.push(format!("- content-type: {v}"));
            }
        }
        if let Some(v) = header_value(h, "content-encoding") {
            if !v.trim().is_empty() {
                lines.push(format!("- content-encoding: {v}"));
            }
        }
        if let Some(v) = header_value(h, "transfer-encoding") {
            if !v.trim().is_empty() {
                lines.push(format!("- transfer-encoding: {v}"));
            }
        }
    }

    if let Some(ctx) = stream_ctx {
        lines.push(String::new());
        lines.push("stream:".to_string());

        if let Some(v) = ctx.expected_protocol.as_deref() {
            lines.push(format!("- expected_protocol: {}", head_chars(v, MAX_SNIPPET_CHARS)));
        }
        if let Some(v) = ctx.expected_signal.as_deref() {
            lines.push(format!("- expected_signal: {}", head_chars(v, MAX_SNIPPET_CHARS)));
        }
        if let Some(v) = ctx.observed_signal.as_deref() {
            lines.push(format!("- observed_signal: {}", head_chars(v, MAX_SNIPPET_CHARS)));
        }
        if let Some(v) = ctx.last_event_type.as_deref() {
            lines.push(format!("- last_event_type: {}", head_chars(v, MAX_SNIPPET_CHARS)));
        }
        if let Some(v) = ctx.chunks_received {
            lines.push(format!("- chunks_received: {v}"));
        }
        if let Some(v) = ctx.events_received {
            lines.push(format!("- events_received: {v}"));
        }
        if let Some(v) = ctx.last_data_snippet.as_deref() {
            lines.push(String::new());
            lines.push("last_data_snippet:".to_string());
            lines.push(head_chars(v, MAX_SNIPPET_CHARS));
        }
        if let Some(v) = ctx.buffer_tail.as_deref() {
            lines.push(String::new());
            lines.push("buffer_tail:".to_string());
            lines.push(tail_chars(v, MAX_SNIPPET_CHARS));
        }
    }

    // reqwest debug view often includes the underlying Decode/Body errors.
    lines.push(String::new());
    lines.push(format!("reqwest_debug: {err:?}"));

    // Source chain
    let chain = format_error_chain(err);
    if !chain.is_empty() {
        lines.push(String::new());
        lines.push("error_chain:".to_string());
        for c in chain {
            lines.push(format!("- {c}"));
        }
    }

    truncate(lines.join("\n"))
}
