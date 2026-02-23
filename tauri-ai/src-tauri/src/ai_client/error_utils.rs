use std::collections::HashMap;
use std::error::Error as StdError;
use std::io;

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReqwestErrorClass {
    Timeout,
    ConnectionReset,
    BrokenPipe,
    Dns,
    Tls,
    Connect,
    Request,
    Status,
    Body,
    Decode,
    Unknown,
}

impl Default for ReqwestErrorClass {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReqwestErrorSummary {
    pub class: ReqwestErrorClass,
    /// Best-effort stage hint: connect|send|read_body|decode|unknown
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    pub is_timeout: bool,
    pub is_connect: bool,
    pub is_request: bool,
    pub is_status: bool,
    pub is_body: bool,
    pub is_decode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub io_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_code_name: Option<String>,
    /// Retryable *in general* (caller still needs to decide if resume is available when partial output already exists).
    pub retryable: bool,
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

fn find_first_io_error(err: &reqwest::Error) -> Option<&io::Error> {
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    let mut depth: usize = 0;
    while let Some(e) = cur {
        if let Some(ioe) = e.downcast_ref::<io::Error>() {
            return Some(ioe);
        }
        cur = e.source();
        depth = depth.saturating_add(1);
        if depth >= 12 {
            break;
        }
    }
    None
}

fn os_code_name(code: i32) -> Option<&'static str> {
    // NOTE: across platforms the numeric codes differ (macOS vs Linux).
    // We map the most common ones for diagnostics and retry policy.
    match code {
        // timeout
        60 | 110 => Some("ETIMEDOUT"),
        // connection reset
        54 | 104 => Some("ECONNRESET"),
        // broken pipe
        32 => Some("EPIPE"),
        // connection refused
        61 | 111 => Some("ECONNREFUSED"),
        // host/network unreachable
        65 | 113 => Some("EHOSTUNREACH"),
        51 | 101 => Some("ENETUNREACH"),
        // not connected
        57 | 107 => Some("ENOTCONN"),
        _ => None,
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    let lower = haystack.to_ascii_lowercase();
    needles.iter().any(|n| lower.contains(n))
}

fn find_timeout_message(err: &reqwest::Error) -> Option<String> {
    if err.is_timeout() {
        return Some("timeout".to_string());
    }

    if let Some(ioe) = find_first_io_error(err) {
        if ioe.kind() == io::ErrorKind::TimedOut {
            let msg = ioe.to_string();
            return Some(if msg.trim().is_empty() {
                "Operation timed out".to_string()
            } else {
                msg
            });
        }
        if let Some(code) = ioe.raw_os_error() {
            if matches!(os_code_name(code), Some("ETIMEDOUT")) {
                let msg = ioe.to_string();
                return Some(if msg.trim().is_empty() {
                    "Operation timed out".to_string()
                } else {
                    msg
                });
            }
        }
    }

    // Some intermediate error types don't expose the io::Error directly; fall back to message heuristics.
    let msg = err.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return Some(msg);
    }

    None
}

pub fn summarize_reqwest_error(err: &reqwest::Error) -> ReqwestErrorSummary {
    let raw = err.to_string();
    let is_timeout = err.is_timeout() || find_timeout_message(err).is_some();
    let is_connect = err.is_connect();
    let is_request = err.is_request();
    let is_status = err.is_status();
    let is_body = err.is_body();
    let is_decode = err.is_decode();

    let (io_kind, os_code, os_code_name_str) = if let Some(ioe) = find_first_io_error(err) {
        let kind = format!("{:?}", ioe.kind());
        let code = ioe.raw_os_error();
        let code_name = code.and_then(os_code_name).map(|s| s.to_string());
        (Some(kind), code, code_name)
    } else {
        (None, None, None)
    };

    let looks_tls = contains_any(
        &raw,
        &[
            "tls",
            "ssl",
            "certificate",
            "cert",
            "x509",
            "invalid certificate",
            "unknown issuer",
        ],
    );
    let looks_dns = contains_any(
        &raw,
        &[
            "dns",
            "failed to lookup",
            "failed to resolve",
            "name or service not known",
            "nodename nor servname provided",
            "no such host",
        ],
    );

    let class = if is_timeout {
        ReqwestErrorClass::Timeout
    } else if matches!(os_code_name_str.as_deref(), Some("ECONNRESET")) {
        ReqwestErrorClass::ConnectionReset
    } else if matches!(os_code_name_str.as_deref(), Some("EPIPE")) {
        ReqwestErrorClass::BrokenPipe
    } else if looks_tls {
        ReqwestErrorClass::Tls
    } else if looks_dns {
        ReqwestErrorClass::Dns
    } else if is_connect {
        ReqwestErrorClass::Connect
    } else if is_status {
        ReqwestErrorClass::Status
    } else if is_request {
        ReqwestErrorClass::Request
    } else if is_decode {
        ReqwestErrorClass::Decode
    } else if is_body {
        ReqwestErrorClass::Body
    } else {
        ReqwestErrorClass::Unknown
    };

    let stage = if is_connect {
        Some("connect".to_string())
    } else if is_request {
        Some("send".to_string())
    } else if is_decode {
        Some("decode".to_string())
    } else if is_body {
        Some("read_body".to_string())
    } else {
        None
    };

    let retryable = !matches!(
        class,
        ReqwestErrorClass::Tls | ReqwestErrorClass::Request | ReqwestErrorClass::Status
    ) || matches!(class, ReqwestErrorClass::Status);

    ReqwestErrorSummary {
        class,
        stage,
        is_timeout,
        is_connect,
        is_request,
        is_status,
        is_body,
        is_decode,
        io_kind,
        os_code,
        os_code_name: os_code_name_str,
        retryable,
    }
}

pub fn summarize_reqwest_stream_error(err: &reqwest::Error) -> String {
    let facts = summarize_reqwest_error(err);
    let raw = err.to_string();

    match facts.class {
        ReqwestErrorClass::Timeout => {
            if let Some(msg) = find_timeout_message(err) {
                format!("读取流超时（{msg}）")
            } else {
                "读取流超时".to_string()
            }
        }
        ReqwestErrorClass::ConnectionReset => {
            if let Some(code) = facts.os_code {
                let name = facts.os_code_name.as_deref().unwrap_or("ECONNRESET");
                format!("连接被对端重置（{name}/{code}）")
            } else {
                "连接被对端重置".to_string()
            }
        }
        ReqwestErrorClass::BrokenPipe => {
            if let Some(code) = facts.os_code {
                let name = facts.os_code_name.as_deref().unwrap_or("EPIPE");
                format!("连接已断开（{name}/{code}）")
            } else {
                "连接已断开（BrokenPipe）".to_string()
            }
        }
        ReqwestErrorClass::Dns => format!("DNS 解析失败（{raw}）"),
        ReqwestErrorClass::Tls => format!("TLS/证书错误（{raw}）"),
        ReqwestErrorClass::Connect => format!("连接失败（{raw}）"),
        ReqwestErrorClass::Request => format!("请求失败（{raw}）"),
        ReqwestErrorClass::Decode => format!("读取流失败（解码错误：{raw}）"),
        ReqwestErrorClass::Body => format!("读取流失败（Body 错误：{raw}）"),
        ReqwestErrorClass::Status => format!("HTTP 状态错误（{raw}）"),
        ReqwestErrorClass::Unknown => raw,
    }
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
    let summary = summarize_reqwest_stream_error(err);
    let facts = summarize_reqwest_error(err);
    lines.push(summary.clone());
    let raw = err.to_string();
    if raw != summary {
        lines.push(format!("raw_error: {raw}"));
    }

    lines.push(String::new());
    lines.push("error_facts:".to_string());
    lines.push(format!("- class: {:?}", facts.class));
    if let Some(stage) = facts.stage.as_deref() {
        lines.push(format!("- stage: {stage}"));
    }
    if let Some(io_kind) = facts.io_kind.as_deref() {
        lines.push(format!("- io_kind: {io_kind}"));
    }
    if let Some(code) = facts.os_code {
        if let Some(name) = facts.os_code_name.as_deref() {
            lines.push(format!("- os_code: {code} ({name})"));
        } else {
            lines.push(format!("- os_code: {code}"));
        }
    }
    lines.push(format!("- retryable: {}", facts.retryable));

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
            lines.push(format!(
                "- expected_protocol: {}",
                head_chars(v, MAX_SNIPPET_CHARS)
            ));
        }
        if let Some(v) = ctx.expected_signal.as_deref() {
            lines.push(format!(
                "- expected_signal: {}",
                head_chars(v, MAX_SNIPPET_CHARS)
            ));
        }
        if let Some(v) = ctx.observed_signal.as_deref() {
            lines.push(format!(
                "- observed_signal: {}",
                head_chars(v, MAX_SNIPPET_CHARS)
            ));
        }
        if let Some(v) = ctx.last_event_type.as_deref() {
            lines.push(format!(
                "- last_event_type: {}",
                head_chars(v, MAX_SNIPPET_CHARS)
            ));
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
