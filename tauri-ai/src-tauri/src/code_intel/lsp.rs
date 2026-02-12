use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Url};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::models::Workstudio;

use super::types::{LspEvent, LspEventPayload, LspLaunchConfig, LspServerStatus, LSP_EVENT_NAME};

// NOTE:
// - 这里实现的是一个“够用且可扩展”的 LSP stdio JSON-RPC 传输层。
// - 目标：支撑 Workstudio 的定义/引用/悬停/补全/诊断（VS Code-like 体验）
// - 不追求 100% 覆盖 VS Code 的客户端实现；对 server->client 的 request 做了必要兜底。

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LspKey {
    workstudio_id: String,
    language_id: String,
}

#[derive(Debug, Default)]
struct LspServerState {
    child: Option<tokio::process::Child>,
    stdin: Option<tokio::process::ChildStdin>,
    started: bool,
    initialized: bool,
    last_error: Option<String>,
}

#[derive(Debug, Default)]
struct PendingRequests {
    by_id: HashMap<i64, oneshot::Sender<serde_json::Value>>,
}

pub struct LspManager {
    app: AppHandle,
    servers: Mutex<HashMap<LspKey, Arc<LspServer>>>,
}

impl LspManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            servers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn ensure(
        &self,
        ws: &Workstudio,
        language_id: &str,
        launch: LspLaunchConfig,
    ) -> Result<Arc<LspServer>, String> {
        let key = LspKey {
            workstudio_id: ws.id.clone(),
            language_id: language_id.to_string(),
        };

        // Fast path: already exists.
        if let Some(existing) = self.servers.lock().await.get(&key).cloned() {
            existing.ensure_started_and_initialized(ws).await?;
            return Ok(existing);
        }

        // Slow path: create & insert (avoid race).
        let server = Arc::new(LspServer::new(
            self.app.clone(),
            ws.id.clone(),
            language_id.to_string(),
            ws.main_folder.clone(),
            ws.folders.clone(),
            launch,
        ));

        {
            let mut map = self.servers.lock().await;
            if let Some(existing) = map.get(&key).cloned() {
                drop(map);
                existing.ensure_started_and_initialized(ws).await?;
                return Ok(existing);
            }
            map.insert(key, server.clone());
        }

        server.ensure_started_and_initialized(ws).await?;
        Ok(server)
    }

    pub async fn shutdown_workstudio(&self, workstudio_id: &str) {
        let mut servers = Vec::new();
        {
            let mut map = self.servers.lock().await;
            let keys: Vec<LspKey> = map
                .keys()
                .filter(|k| k.workstudio_id == workstudio_id)
                .cloned()
                .collect();
            for k in keys {
                if let Some(s) = map.remove(&k) {
                    servers.push(s);
                }
            }
        }

        for s in servers {
            let _ = s.shutdown().await;
        }
    }

    pub async fn status(&self, workstudio_id: &str) -> Vec<LspServerStatus> {
        let map = self.servers.lock().await;
        let mut out = Vec::new();
        for (k, s) in map.iter() {
            if k.workstudio_id != workstudio_id {
                continue;
            }
            out.push(s.status().await);
        }
        out
    }
}

pub struct LspServer {
    app: AppHandle,
    workstudio_id: String,
    language_id: String,
    main_folder: String,
    folders: Vec<String>,
    launch: LspLaunchConfig,

    next_id: AtomicI64,
    pending: Mutex<PendingRequests>,
    state: Mutex<LspServerState>,
    start_gate: Mutex<()>,
    init_gate: Mutex<()>,
}

impl LspServer {
    fn new(
        app: AppHandle,
        workstudio_id: String,
        language_id: String,
        main_folder: String,
        folders: Vec<String>,
        launch: LspLaunchConfig,
    ) -> Self {
        Self {
            app,
            workstudio_id,
            language_id,
            main_folder,
            folders,
            launch,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(PendingRequests::default()),
            state: Mutex::new(LspServerState::default()),
            start_gate: Mutex::new(()),
            init_gate: Mutex::new(()),
        }
    }

    pub async fn status(&self) -> LspServerStatus {
        let st = self.state.lock().await;
        LspServerStatus {
            workstudio_id: self.workstudio_id.clone(),
            language_id: self.language_id.clone(),
            started: st.started,
            initialized: st.initialized,
            command: Some(self.launch.command.clone()),
            args: Some(self.launch.args.clone()),
            last_error: st.last_error.clone(),
        }
    }

    async fn ensure_started_and_initialized(self: &Arc<Self>, ws: &Workstudio) -> Result<(), String> {
        self.ensure_started(ws).await?;
        self.ensure_initialized(ws).await?;
        Ok(())
    }

    async fn ensure_started(self: &Arc<Self>, ws: &Workstudio) -> Result<(), String> {
        let _gate = self.start_gate.lock().await;
        {
            let st = self.state.lock().await;
            if st.started {
                return Ok(());
            }
        }

        let command = self.launch.command.trim();
        if command.is_empty() {
            let err = "LSP command 为空".to_string();
            self.set_last_error(err.clone()).await;
            return Err(err);
        }

        let mut cmd = Command::new(command);
        cmd.args(&self.launch.args);

        // 在项目根目录下运行（对 rust-analyzer/cargo 等更友好）
        let cwd = ws.main_folder.trim();
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }

        for (k, v) in &self.launch.env {
            cmd.env(k, v);
        }

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err = format!("启动 LSP 失败: {e}");
                self.set_last_error(err.clone()).await;
                return Err(err);
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 LSP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 LSP stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法获取 LSP stderr".to_string())?;

        {
            let mut st = self.state.lock().await;
            st.child = Some(child);
            st.stdin = Some(stdin);
            st.started = true;
            st.last_error = None;
        }

        // Background tasks
        {
            let server = Arc::clone(self);
            tokio::spawn(async move {
                server.read_stdout_loop(stdout).await;
            });
        }
        {
            let server = Arc::clone(self);
            tokio::spawn(async move {
                server.read_stderr_loop(stderr).await;
            });
        }
        {
            let server = Arc::clone(self);
            tokio::spawn(async move {
                server.monitor_exit_loop().await;
            });
        }

        Ok(())
    }

    async fn ensure_initialized(self: &Arc<Self>, ws: &Workstudio) -> Result<(), String> {
        let _gate = self.init_gate.lock().await;
        {
            let st = self.state.lock().await;
            if st.initialized {
                return Ok(());
            }
            if !st.started {
                let err = "LSP 尚未启动".to_string();
                drop(st);
                self.set_last_error(err.clone()).await;
                return Err(err);
            }
        }

        let root_uri = file_uri(&ws.main_folder).ok();
        let workspace_folders = workspace_folders_value(&ws.main_folder, &ws.folders);

        let init_params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "workspaceFolders": workspace_folders,
            "capabilities": {
                "workspace": {
                    "workspaceFolders": true,
                    "configuration": true,
                    "applyEdit": false
                },
                "window": {
                    "workDoneProgress": true
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "willSave": false,
                        "didSave": true,
                        "willSaveWaitUntil": false
                    },
                    "definition": { "dynamicRegistration": false, "linkSupport": true },
                    "typeDefinition": { "dynamicRegistration": false, "linkSupport": true },
                    "references": { "dynamicRegistration": false },
                    "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
                    "completion": {
                        "dynamicRegistration": false,
                        "completionItem": {
                            "snippetSupport": false,
                            "documentationFormat": ["markdown", "plaintext"]
                        }
                    },
                    "documentSymbol": {
                        "dynamicRegistration": false,
                        "hierarchicalDocumentSymbolSupport": true
                    }
                }
            },
            "initializationOptions": self.launch.initialization_options,
            "clientInfo": { "name": "TauriAI", "version": env!("CARGO_PKG_VERSION") },
            "trace": "off"
        });

        // initialize -> initialized
        if let Err(e) = self
            .request("initialize", init_params, Some(Duration::from_secs(30)))
            .await
        {
            self.set_last_error(e.clone()).await;
            return Err(e);
        }
        if let Err(e) = self.notify("initialized", json!({})).await {
            self.set_last_error(e.clone()).await;
            return Err(e);
        }

        // Best-effort configuration push（部分 server 会忽略，转而 pull workspace/configuration）
        let _ = self
            .notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": self.launch.settings }),
            )
            .await;

        {
            let mut st = self.state.lock().await;
            st.initialized = true;
            st.last_error = None;
        }

        Ok(())
    }

    pub async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Option<Duration>,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        {
            let mut pending = self.pending.lock().await;
            pending.by_id.insert(id, tx);
        }

        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;

        let msg = if let Some(t) = timeout {
            match tokio::time::timeout(t, rx).await {
                Ok(Ok(v)) => v,
                Ok(Err(_)) => return Err("LSP 请求被取消".to_string()),
                Err(_) => return Err(format!("LSP 请求超时: {method}")),
            }
        } else {
            rx.await.map_err(|_| "LSP 请求被取消".to_string())?
        };

        if let Some(err) = msg.get("error") {
            return Err(format!("LSP error: {err}"));
        }
        Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null))
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        // Graceful shutdown first
        let _ = self
            .request("shutdown", json!({}), Some(Duration::from_secs(5)))
            .await;
        let _ = self.notify("exit", json!({})).await;

        // Then force kill (best-effort)
        let mut st = self.state.lock().await;
        if let Some(mut child) = st.child.take() {
            let _ = child.kill().await;
        }
        st.stdin = None;
        st.started = false;
        st.initialized = false;
        st.last_error = None;
        Ok(())
    }

    async fn send(&self, msg: serde_json::Value) -> Result<(), String> {
        let bytes = encode_lsp_message(&msg)?;
        let mut st = self.state.lock().await;
        let stdin = st
            .stdin
            .as_mut()
            .ok_or_else(|| "LSP stdin 不可用".to_string())?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("写入 LSP stdin 失败: {e}"))?;
        let _ = stdin.flush().await;
        Ok(())
    }

    async fn read_stdout_loop(self: Arc<Self>, mut stdout: tokio::process::ChildStdout) {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match read_one_lsp_message(&mut stdout, &mut buf).await {
                Ok(Some(v)) => {
                    if let Err(e) = self.handle_incoming(v).await {
                        self.set_last_error(e).await;
                    }
                }
                Ok(None) => break, // EOF
                Err(e) => {
                    self.set_last_error(e).await;
                    break;
                }
            }
        }
    }

    async fn read_stderr_loop(self: Arc<Self>, stderr: tokio::process::ChildStderr) {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    self.emit(LspEvent::Stderr {
                        line: trimmed.to_string(),
                    });
                }
                Err(_) => break,
            }
        }
    }

    async fn monitor_exit_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let status = {
                let mut st = self.state.lock().await;
                let Some(child) = st.child.as_mut() else {
                    return;
                };
                match child.try_wait() {
                    Ok(Some(s)) => {
                        st.child = None;
                        st.stdin = None;
                        st.started = false;
                        st.initialized = false;
                        Some(s)
                    }
                    Ok(None) => None,
                    Err(_) => None,
                }
            };

            if let Some(s) = status {
                self.emit(LspEvent::Exited {
                    code: s.code(),
                    signal: exit_status_signal(&s),
                });
                return;
            }
        }
    }

    async fn handle_incoming(&self, msg: serde_json::Value) -> Result<(), String> {
        // response: has id, no method
        if msg.get("id").is_some() && msg.get("method").is_none() {
            return self.handle_response(msg).await;
        }

        let method = msg
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        if method.is_empty() {
            return Ok(());
        }

        // server request -> client must respond
        if let Some(id) = msg.get("id").cloned() {
            let params = msg.get("params").cloned().unwrap_or(serde_json::Value::Null);
            match self.handle_server_request(&method, params).await {
                Ok(result) => {
                    let _ = self
                        .send(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": result
                        }))
                        .await;
                }
                Err(err) => {
                    let _ = self
                        .send(json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32603, "message": err }
                        }))
                        .await;
                }
            }
            return Ok(());
        }

        // notification
        let params = msg.get("params").cloned().unwrap_or(serde_json::Value::Null);
        self.emit(LspEvent::Notification { method, params });
        Ok(())
    }

    async fn handle_response(&self, msg: serde_json::Value) -> Result<(), String> {
        let id = msg
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "LSP response 缺少数值 id".to_string())?;
        let tx = {
            let mut pending = self.pending.lock().await;
            pending.by_id.remove(&id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(msg);
        }
        Ok(())
    }

    async fn handle_server_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        match method {
            "workspace/configuration" => {
                let items = params
                    .get("items")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut out: Vec<serde_json::Value> = Vec::with_capacity(items.len());
                for item in items {
                    let section = item
                        .get("section")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    if section.is_empty() {
                        out.push(self.launch.settings.clone());
                        continue;
                    }
                    if let Some(v) = self.launch.settings.get(section) {
                        out.push(v.clone());
                    } else {
                        out.push(serde_json::Value::Null);
                    }
                }
                Ok(serde_json::Value::Array(out))
            }
            "workspace/workspaceFolders" => Ok(workspace_folders_value(&self.main_folder, &self.folders)),
            "client/registerCapability" => Ok(serde_json::Value::Null),
            "client/unregisterCapability" => Ok(serde_json::Value::Null),
            "window/workDoneProgress/create" => Ok(serde_json::Value::Null),
            "workspace/semanticTokens/refresh" => Ok(serde_json::Value::Null),
            "workspace/inlayHint/refresh" => Ok(serde_json::Value::Null),
            "workspace/applyEdit" => Ok(json!({
                "applied": false,
                "failureReason": "TauriAI 暂不支持 workspace/applyEdit"
            })),
            _ => Ok(serde_json::Value::Null),
        }
    }

    async fn set_last_error(&self, err: String) {
        let mut st = self.state.lock().await;
        st.last_error = Some(err);
    }

    fn emit(&self, event: LspEvent) {
        let payload = LspEventPayload {
            workstudio_id: self.workstudio_id.clone(),
            language_id: self.language_id.clone(),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event,
        };
        let _ = self.app.emit(LSP_EVENT_NAME, payload);
    }
}

fn encode_lsp_message(msg: &serde_json::Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(msg).map_err(|e| format!("序列化 LSP JSON 失败: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

async fn read_one_lsp_message<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> Result<Option<serde_json::Value>, String> {
    loop {
        if let Some((header_len, content_len)) = try_parse_header(buf)? {
            let total_len = header_len + content_len;
            while buf.len() < total_len {
                let mut tmp = [0u8; 8192];
                let n = reader.read(&mut tmp).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(None);
                }
                buf.extend_from_slice(&tmp[..n]);
            }

            let body = buf[header_len..total_len].to_vec();
            buf.drain(0..total_len);

            let v: serde_json::Value =
                serde_json::from_slice(&body).map_err(|e| format!("解析 LSP JSON 失败: {e}"))?;
            return Ok(Some(v));
        }

        // Need more bytes to parse header.
        let mut tmp = [0u8; 8192];
        let n = reader.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

fn try_parse_header(buf: &[u8]) -> Result<Option<(usize, usize)>, String> {
    let marker = b"\r\n\r\n";
    let Some(pos) = buf.windows(marker.len()).position(|w| w == marker) else {
        return Ok(None);
    };
    let header_bytes = &buf[..pos];
    let header_str = String::from_utf8_lossy(header_bytes);
    let mut content_len: Option<usize> = None;
    for line in header_str.split("\r\n") {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            let n = rest.trim().parse::<usize>().map_err(|e| e.to_string())?;
            content_len = Some(n);
        }
    }
    let Some(len) = content_len else {
        return Err("LSP header 缺少 Content-Length".to_string());
    };
    Ok(Some((pos + marker.len(), len)))
}

fn file_uri(path: &str) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("path 为空".to_string());
    }
    Url::from_file_path(p)
        .map(|u| u.to_string())
        .map_err(|_| format!("无法转换为 file:// URI: {p}"))
}

fn workspace_folders_value(main_folder: &str, folders: &[String]) -> serde_json::Value {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut push = |p: &str| {
        if let Ok(uri) = file_uri(p) {
            let name = std::path::Path::new(p)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("workspace")
                .to_string();
            out.push(json!({ "uri": uri, "name": name }));
        }
    };
    let mf = main_folder.trim();
    if !mf.is_empty() {
        push(mf);
    }
    for f in folders {
        let f = f.trim();
        if f.is_empty() {
            continue;
        }
        push(f);
    }
    serde_json::Value::Array(out)
}

fn exit_status_signal(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
