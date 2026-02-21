use std::collections::HashMap;
use std::error::Error as StdError;

const MAX_ERROR_TEXT_LEN: usize = 12_000;

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

pub fn format_reqwest_stream_error(
    provider: &str,
    model: &str,
    url: Option<&str>,
    status: Option<u16>,
    headers: Option<&HashMap<String, String>>,
    err: &reqwest::Error,
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

