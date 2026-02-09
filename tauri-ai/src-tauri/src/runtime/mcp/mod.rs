use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::FutureExt;
use futures::StreamExt;
use rmcp::model::{
    CallToolRequestParam, ClientCapabilities, ClientInfo, Implementation, InitializeRequestParam,
    JsonObject, ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParam,
    ReadResourceRequestParam, ReadResourceResult, Resource, ResourceTemplate, Tool,
};
use rmcp::service::{self, NotificationContext, RequestContext, RunningService, ServiceError};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::{worker::Worker, worker::WorkerConfig, worker::WorkerContext, worker::WorkerQuitReason, WorkerTransport};
use rmcp::ClientHandler;
use rmcp::RoleClient;
use serde_json::Value;
use sse_stream::SseStream;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{OnceCell, Notify, RwLock};
use tokio::time;

use crate::models::{McpServerConfig, McpServerTransportConfig};

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
// tools/call 默认超时（对应前端 toolTimeoutMs 默认值）
const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_millis(6000);

#[derive(Debug, Clone, Default)]
pub struct McpServerRuntimeStatus {
    pub ready: bool,
    pub last_error: Option<String>,
    pub last_tools_count: Option<usize>,
}

pub struct McpRuntime {
    clients: RwLock<HashMap<String, Arc<McpClient>>>,
    status: RwLock<HashMap<String, McpServerRuntimeStatus>>,
    tools_cache: RwLock<HashMap<String, McpToolsSnapshot>>,
}

#[derive(Debug, Clone)]
struct McpToolsSnapshot {
    cfg: McpServerConfig,
    tools: Vec<Tool>,
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
            status: RwLock::new(HashMap::new()),
            tools_cache: RwLock::new(HashMap::new()),
        }
    }
}

static MCP_RUNTIME: OnceLock<Arc<McpRuntime>> = OnceLock::new();

pub fn global_mcp_runtime() -> Arc<McpRuntime> {
    MCP_RUNTIME
        .get_or_init(|| Arc::new(McpRuntime::default()))
        .clone()
}

impl McpRuntime {
    pub async fn get_status_snapshot(&self) -> HashMap<String, McpServerRuntimeStatus> {
        self.status.read().await.clone()
    }

    /// List tools with an in-memory cache (keyed by server name + config).
    ///
    /// Notes:
    /// - Cache is invalidated automatically when the server config changes.
    /// - On cache miss, this falls back to a real `tools/list` call.
    pub async fn list_tools_cached(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
    ) -> Result<Vec<Tool>, String> {
        if let Some(snapshot) = self.tools_cache.read().await.get(server_name) {
            if &snapshot.cfg == cfg {
                return Ok(snapshot.tools.clone());
            }
        }
        self.list_tools(server_name, cfg).await
    }

    pub async fn list_tools(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
    ) -> Result<Vec<Tool>, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .startup_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_STARTUP_TIMEOUT));

        let tools = client.list_tools(timeout).await?;
        let tools = filter_tools(tools, &cfg.enabled_tools, &cfg.disabled_tools);

        self.tools_cache.write().await.insert(
            server_name.to_string(),
            McpToolsSnapshot {
                cfg: cfg.clone(),
                tools: tools.clone(),
            },
        );

        self.status.write().await.insert(
            server_name.to_string(),
            McpServerRuntimeStatus {
                ready: true,
                last_error: None,
                last_tools_count: Some(tools.len()),
            },
        );

        Ok(tools)
    }

    pub async fn call_tool(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
        tool_name: &str,
        arguments: Option<Value>,
    ) -> Result<Value, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .tool_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_TOOL_TIMEOUT));
        client.call_tool(tool_name, arguments, timeout).await
    }

    pub async fn list_resources(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
        cursor: Option<String>,
    ) -> Result<ListResourcesResult, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .startup_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_STARTUP_TIMEOUT));
        client.list_resources(cursor, timeout).await
    }

    pub async fn list_all_resources(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
    ) -> Result<Vec<Resource>, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .startup_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_STARTUP_TIMEOUT));
        client.list_all_resources(timeout).await
    }

    pub async fn list_resource_templates(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
        cursor: Option<String>,
    ) -> Result<ListResourceTemplatesResult, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .startup_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_STARTUP_TIMEOUT));
        client.list_resource_templates(cursor, timeout).await
    }

    pub async fn list_all_resource_templates(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
    ) -> Result<Vec<ResourceTemplate>, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .startup_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_STARTUP_TIMEOUT));
        client.list_all_resource_templates(timeout).await
    }

    pub async fn read_resource(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
        uri: &str,
    ) -> Result<ReadResourceResult, String> {
        let client = self.ensure_client(server_name, cfg).await?;
        let timeout = cfg
            .tool_timeout_ms
            .map(Duration::from_millis)
            .or(Some(DEFAULT_TOOL_TIMEOUT));
        client.read_resource(uri, timeout).await
    }

    async fn ensure_client(
        &self,
        server_name: &str,
        cfg: &McpServerConfig,
    ) -> Result<Arc<McpClient>, String> {
        if server_name.trim().is_empty() {
            return Err("server_name 不能为空".to_string());
        }
        if !server_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "非法 MCP server name: '{server_name}'（仅允许 [a-zA-Z0-9_-]）"
            ));
        }

        // IMPORTANT:
        // - server_name 是稳定 key，但 cfg 是可编辑的（transport/url/headers/timeout 等）。
        // - 不能无条件复用旧 client，否则 UI 改配置后仍会用旧连接，表现为“怎么改都不生效/一直超时”。
        if let Some(existing) = self.clients.read().await.get(server_name).cloned() {
            if &existing.cfg == cfg {
                return Ok(existing);
            }
        }

        let client = Arc::new(McpClient::new(server_name, cfg).await?);

        // Re-check under write lock (避免并发重复创建)。
        let mut w = self.clients.write().await;
        if let Some(existing) = w.get(server_name).cloned() {
            if &existing.cfg == cfg {
                return Ok(existing);
            }
        }
        w.insert(server_name.to_string(), client.clone());
        drop(w);

        // Clear tool snapshot cache for this server since the config changed.
        self.tools_cache.write().await.remove(server_name);

        // Reset status snapshot so diagnostics reflect the new config.
        self.status.write().await.insert(
            server_name.to_string(),
            McpServerRuntimeStatus {
                ready: false,
                last_error: Some("MCP 配置已更新，将按新配置重新初始化".to_string()),
                last_tools_count: None,
            },
        );

        Ok(client)
    }
}

fn filter_tools(mut tools: Vec<Tool>, enabled: &[String], disabled: &[String]) -> Vec<Tool> {
    if !enabled.is_empty() {
        let allow: std::collections::HashSet<&str> = enabled.iter().map(|s| s.as_str()).collect();
        tools.retain(|t| allow.contains(t.name.as_ref()));
    }
    if !disabled.is_empty() {
        let deny: std::collections::HashSet<&str> = disabled.iter().map(|s| s.as_str()).collect();
        tools.retain(|t| !deny.contains(t.name.as_ref()));
    }
    tools
}

struct BasicClientHandler {
    client_info: ClientInfo,
}

impl ClientHandler for BasicClientHandler {
    fn get_info(&self) -> ClientInfo {
        self.client_info.clone()
    }

    async fn create_elicitation(
        &self,
        _request: rmcp::model::CreateElicitationRequestParam,
        _context: RequestContext<RoleClient>,
    ) -> Result<rmcp::model::CreateElicitationResult, rmcp::ErrorData> {
        Err(rmcp::ErrorData::internal_error(
            "TauriAI 暂不支持 MCP elicitation".to_string(),
            None,
        ))
    }

    async fn on_logging_message(
        &self,
        params: rmcp::model::LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        let level = params.level;
        let logger = params.logger.unwrap_or_default();
        let data = params.data;
        println!("[MCP][{level:?}][{logger}] {data}");
    }
}

enum PendingTransport {
    ChildProcess(TokioChildProcess),
    StreamableHttp {
        transport: StreamableHttpClientTransport<reqwest::Client>,
    },
    Sse {
        transport: WorkerTransport<SseClientWorker>,
    },
}

pub struct McpClient {
    server_name: String,
    cfg: McpServerConfig,
    service: OnceCell<Arc<RunningService<RoleClient, BasicClientHandler>>>,
}

impl McpClient {
    pub async fn new(server_name: &str, cfg: &McpServerConfig) -> Result<Self, String> {
        Ok(Self {
            server_name: server_name.to_string(),
            cfg: cfg.clone(),
            service: OnceCell::new(),
        })
    }

    async fn build_transport(&self) -> Result<PendingTransport, String> {
        match &self.cfg.transport {
            McpServerTransportConfig::Stdio {
                command,
                args,
                env,
                env_vars,
                cwd,
            } => {
                let mut command_builder = Command::new(command);
                command_builder
                    .kill_on_drop(true)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .env_clear()
                    .envs(create_env_for_mcp_server(env.clone(), env_vars))
                    .args(args);
                if let Some(cwd) = cwd {
                    command_builder.current_dir(cwd);
                }

                let (transport, stderr) = TokioChildProcess::builder(command_builder)
                    .spawn()
                    .map_err(|e| format!("启动 MCP 子进程失败: {e}"))?;

                if let Some(stderr) = stderr {
                    let program_name = command.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(stderr).lines();
                        while let Ok(Some(line)) = reader.next_line().await {
                            println!("[MCP][stderr][{program_name}] {line}");
                        }
                    });
                }

                Ok(PendingTransport::ChildProcess(transport))
            }
            McpServerTransportConfig::StreamableHttp {
                url,
                bearer_token_env_var,
                http_headers,
                env_http_headers,
            } => {
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.to_string());
                if let Some(env_var) = bearer_token_env_var.as_deref() {
                    if let Ok(token) = std::env::var(env_var) {
                        if !token.trim().is_empty() {
                            config = config.auth_header(token);
                        }
                    }
                }

                let client = build_http_client(http_headers.as_ref(), env_http_headers.as_ref())
                    .map_err(|e| format!("构建 HTTP client 失败: {e}"))?;
                let transport = StreamableHttpClientTransport::with_client(client, config);
                Ok(PendingTransport::StreamableHttp { transport })
            }
            McpServerTransportConfig::Sse {
                url,
                bearer_token_env_var,
                http_headers,
                env_http_headers,
            } => {
                let sse_url = reqwest::Url::parse(url)
                    .map_err(|e| format!("SSE url 非法: {e}"))?;

                let bearer_token = bearer_token_env_var
                    .as_deref()
                    .and_then(|env_var| std::env::var(env_var).ok())
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());

                let client = build_http_client(http_headers.as_ref(), env_http_headers.as_ref())
                    .map_err(|e| format!("构建 HTTP client 失败: {e}"))?;

                let worker = SseClientWorker {
                    client,
                    sse_url,
                    bearer_token,
                };
                let transport = WorkerTransport::spawn(worker);
                Ok(PendingTransport::Sse { transport })
            }
        }
    }

    async fn ensure_ready(&self, timeout: Option<Duration>) -> Result<(), String> {
        if self.service.get().is_some() {
            return Ok(());
        }

        self.service
            .get_or_try_init(|| async {
                println!("[MCP] 初始化客户端: {}", self.server_name);

                let client_info = InitializeRequestParam {
                    protocol_version: rmcp::model::ProtocolVersion::default(),
                    capabilities: ClientCapabilities {
                        ..ClientCapabilities::default()
                    },
                    client_info: Implementation {
                        name: "tauri-ai".to_string(),
                        title: Some("TauriAI".to_string()),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                        icons: None,
                        website_url: None,
                    },
                };

                let handler = BasicClientHandler {
                    client_info: client_info.clone(),
                };

                // 并发初始化：只允许一个 init 在跑，其余调用会在这里 await，不再报 "already initializing"。
                let pending = self.build_transport().await?;
                let transport_fut: BoxFuture<
                    'static,
                    Result<
                        RunningService<RoleClient, BasicClientHandler>,
                        rmcp::service::ClientInitializeError,
                    >,
                > = match pending {
                    PendingTransport::ChildProcess(t) => service::serve_client(handler, t).boxed(),
                    PendingTransport::StreamableHttp { transport } => {
                        service::serve_client(handler, transport).boxed()
                    }
                    PendingTransport::Sse { transport } => {
                        service::serve_client(handler, transport).boxed()
                    }
                };

                let service = match timeout {
                    Some(duration) => time::timeout(duration, transport_fut)
                        .await
                        .map_err(|_| format!("MCP 初始化超时（{duration:?}）"))?
                        .map_err(|err| format!("MCP 初始化失败: {err}"))?,
                    None => transport_fut
                        .await
                        .map_err(|err| format!("MCP 初始化失败: {err}"))?,
                };

                Ok(Arc::new(service))
            })
            .await
            .map(|_| ())
    }

    async fn service(&self) -> Result<Arc<RunningService<RoleClient, BasicClientHandler>>, String> {
        self.service
            .get()
            .cloned()
            .ok_or_else(|| "MCP client 未初始化".to_string())
    }

    pub async fn list_tools(&self, timeout: Option<Duration>) -> Result<Vec<Tool>, String> {
        self.ensure_ready(timeout).await?;
        let service = self.service().await?;
        let fut = service.list_tools(None::<PaginatedRequestParam>);
        let result = run_with_timeout(fut, timeout, "tools/list").await?;
        Ok(result.tools)
    }

    pub async fn list_resources(
        &self,
        cursor: Option<String>,
        timeout: Option<Duration>,
    ) -> Result<ListResourcesResult, String> {
        self.ensure_ready(timeout).await?;
        let service = self.service().await?;
        let params = cursor.map(|cursor| PaginatedRequestParam {
            cursor: Some(cursor),
        });
        let fut = service.list_resources(params);
        run_with_timeout(fut, timeout, "resources/list").await
    }

    pub async fn list_all_resources(
        &self,
        timeout: Option<Duration>,
    ) -> Result<Vec<Resource>, String> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let res = self.list_resources(cursor.clone(), timeout).await?;
            all.extend(res.resources);
            cursor = res.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok(all)
    }

    pub async fn list_resource_templates(
        &self,
        cursor: Option<String>,
        timeout: Option<Duration>,
    ) -> Result<ListResourceTemplatesResult, String> {
        self.ensure_ready(timeout).await?;
        let service = self.service().await?;
        let params = cursor.map(|cursor| PaginatedRequestParam {
            cursor: Some(cursor),
        });
        let fut = service.list_resource_templates(params);
        run_with_timeout(fut, timeout, "resources/templates/list").await
    }

    pub async fn list_all_resource_templates(
        &self,
        timeout: Option<Duration>,
    ) -> Result<Vec<ResourceTemplate>, String> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let res = self
                .list_resource_templates(cursor.clone(), timeout)
                .await?;
            all.extend(res.resource_templates);
            cursor = res.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok(all)
    }

    pub async fn read_resource(
        &self,
        uri: &str,
        timeout: Option<Duration>,
    ) -> Result<ReadResourceResult, String> {
        self.ensure_ready(timeout).await?;
        let service = self.service().await?;
        let fut = service.read_resource(ReadResourceRequestParam {
            uri: uri.to_string(),
        });
        run_with_timeout(fut, timeout, "resources/read").await
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: Option<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        self.ensure_ready(timeout).await?;
        let service = self.service().await?;

        let args: Option<JsonObject> = match arguments {
            None => None,
            Some(Value::Object(map)) => Some(map),
            Some(other) => {
                return Err(format!(
                    "MCP tool arguments 必须是 object（JSON），实际为: {}",
                    other
                ))
            }
        };

        let params = CallToolRequestParam {
            name: tool_name.to_string().into(),
            arguments: args,
        };

        let fut = service.call_tool(params);
        let result = run_with_timeout(fut, timeout, "tools/call").await?;
        serde_json::to_value(result).map_err(|e| format!("序列化 MCP tool result 失败: {e}"))
    }
}

#[derive(Debug, thiserror::Error)]
enum SseTransportError {
    #[error("HTTP 请求失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("SSE 解析失败: {0}")]
    Sse(#[from] sse_stream::Error),
    #[error("JSON 解析失败: {0}")]
    Json(#[from] serde_json::Error),
    #[error("SSE 未提供 endpoint（event: endpoint）")]
    MissingEndpoint,
    #[error("等待 SSE endpoint 超时（{0:?}）")]
    EndpointTimeout(Duration),
    #[error("无法解析 SSE endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("Transport 通道已关闭")]
    TransportChannelClosed,
    #[error("Tokio join error: {0}")]
    TokioJoinError(#[from] tokio::task::JoinError),
    #[error("HTTP 状态码异常: {status}（{body}）")]
    HttpStatus { status: reqwest::StatusCode, body: String },
}

#[derive(Clone)]
struct SseClientWorker {
    client: reqwest::Client,
    sse_url: reqwest::Url,
    bearer_token: Option<String>,
}

impl Worker for SseClientWorker {
    type Role = RoleClient;
    type Error = SseTransportError;

    fn err_closed() -> Self::Error {
        SseTransportError::TransportChannelClosed
    }

    fn err_join(e: tokio::task::JoinError) -> Self::Error {
        SseTransportError::TokioJoinError(e)
    }

    fn config(&self) -> WorkerConfig {
        WorkerConfig {
            name: Some("SseClientWorker".into()),
            channel_buffer_capacity: 64,
        }
    }

    async fn run(
        self,
        mut context: WorkerContext<Self>,
    ) -> Result<(), WorkerQuitReason<Self::Error>> {
        let endpoint = Arc::new(RwLock::<Option<reqwest::Url>>::new(None));
        let endpoint_notify = Arc::new(Notify::new());

        // SSE reader: connects to sse_url, consumes `event: endpoint` to learn POST endpoint,
        // and forwards JSON-RPC messages from SSE `message` frames to the transport receive channel.
        let (sse_to_transport_tx, mut sse_to_transport_rx) =
            tokio::sync::mpsc::channel::<rmcp::model::ServerJsonRpcMessage>(64);
        let ct = context.cancellation_token.clone();
        let sse_url = self.sse_url.clone();
        let bearer_token = self.bearer_token.clone();
        let client = self.client.clone();
        let endpoint_for_task = endpoint.clone();
        let notify_for_task = endpoint_notify.clone();

        let mut sse_task = tokio::spawn(async move {
            let mut last_event_id: Option<String> = None;
            let mut retry_interval = Duration::from_millis(1000);
            let max_retry_interval = Duration::from_secs(30);

            loop {
                if ct.is_cancelled() {
                    return Ok(());
                }

                let mut req = client
                    .get(sse_url.clone())
                    .header(reqwest::header::ACCEPT, "text/event-stream")
                    .header(reqwest::header::CACHE_CONTROL, "no-cache");
                if let Some(id) = last_event_id.as_deref() {
                    req = req.header("Last-Event-ID", id);
                }
                if let Some(token) = bearer_token.as_deref() {
                    req = req.bearer_auth(token);
                }

                let resp = match req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        println!("[MCP][SSE] 连接失败，{retry_interval:?} 后重试: {e}");
                        tokio::select! {
                            _ = ct.cancelled() => return Ok(()),
                            _ = tokio::time::sleep(retry_interval) => {}
                        }
                        retry_interval = (retry_interval * 2).min(max_retry_interval);
                        continue;
                    }
                };

                let status = resp.status();
                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();

                    // 4xx 通常是配置/鉴权错误，重试没有意义；直接让 worker 失败并把原因上抛到 UI。
                    if status.is_client_error() {
                        return Err(SseTransportError::HttpStatus { status, body });
                    }

                    println!(
                        "[MCP][SSE] HTTP 状态异常，{retry_interval:?} 后重试: {status} {body}"
                    );
                    tokio::select! {
                        _ = ct.cancelled() => return Ok(()),
                        _ = tokio::time::sleep(retry_interval) => {}
                    }
                    retry_interval = (retry_interval * 2).min(max_retry_interval);
                    continue;
                }

                retry_interval = Duration::from_millis(1000);

                let mut stream = SseStream::from_byte_stream(resp.bytes_stream());
                loop {
                    let next = tokio::select! {
                        _ = ct.cancelled() => return Ok(()),
                        ev = stream.next() => ev,
                    };

                    let Some(ev) = next.transpose()? else {
                        // server closed the stream; reconnect
                        println!("[MCP][SSE] stream 结束，准备重连…");
                        break;
                    };

                    if let Some(new_retry) = ev.retry {
                        retry_interval = Duration::from_millis(new_retry).max(Duration::from_millis(200));
                    }
                    if let Some(id) = ev.id.clone() {
                        last_event_id = Some(id);
                    }

                    match ev.event.as_deref() {
                        Some("endpoint") => {
                            let raw = ev.data.unwrap_or_default();
                            let raw = raw.trim();
                            if raw.is_empty() {
                                continue;
                            }

                            let endpoint_str: String = match serde_json::from_str::<serde_json::Value>(raw) {
                                Ok(v) => {
                                    if let Some(s) = v.as_str() {
                                        s.to_string()
                                    } else if let Some(s) = v.get("endpoint").and_then(|v| v.as_str()) {
                                        s.to_string()
                                    } else if let Some(s) = v.get("url").and_then(|v| v.as_str()) {
                                        s.to_string()
                                    } else {
                                        raw.to_string()
                                    }
                                }
                                Err(_) => raw.to_string(),
                            };

                            let endpoint_str = endpoint_str.trim();
                            if endpoint_str.is_empty() {
                                continue;
                            }

                            let full = match reqwest::Url::parse(endpoint_str) {
                                Ok(u) => u,
                                Err(_) => sse_url
                                    .join(endpoint_str)
                                    .map_err(|_| SseTransportError::InvalidEndpoint(endpoint_str.to_string()))?,
                            };

                            {
                                let mut w = endpoint_for_task.write().await;
                                *w = Some(full.clone());
                            }
                            notify_for_task.notify_waiters();
                            println!("[MCP][SSE] endpoint 已更新: {full}");
                        }
                        None | Some("") | Some("message") => {
                            let Some(data) = ev.data else {
                                continue;
                            };
                            let data = data.trim();
                            if data.is_empty() {
                                continue;
                            }

                            match serde_json::from_str::<rmcp::model::ServerJsonRpcMessage>(data) {
                                Ok(msg) => {
                                    if sse_to_transport_tx.send(msg).await.is_err() {
                                        return Ok(());
                                    }
                                }
                                Err(e) => {
                                    // 某些 server 会混入非 JSON 文本（例如 keep-alive），这里降噪处理。
                                    println!("[MCP][SSE] 忽略无法解析的 message frame: {e}");
                                }
                            }
                        }
                        _ => {
                            // ping / keepalive / 其它控制帧：忽略
                        }
                    }
                }

                tokio::select! {
                    _ = ct.cancelled() => return Ok(()),
                    _ = tokio::time::sleep(retry_interval) => {}
                }
            }
        });

        let post_client = self.client.clone();
        let post_bearer = self.bearer_token.clone();

        loop {
            tokio::select! {
                _ = context.cancellation_token.cancelled() => {
                    return Err(WorkerQuitReason::Cancelled);
                }
                sse_result = (&mut sse_task) => {
                    match sse_result {
                        Ok(Ok(())) => return Ok(()),
                        Ok(Err(e)) => return Err(WorkerQuitReason::fatal(e, "sse reader task")),
                        Err(join_err) => return Err(WorkerQuitReason::Join(join_err)),
                    }
                }
                maybe_server_msg = sse_to_transport_rx.recv() => {
                    let Some(msg) = maybe_server_msg else {
                        return Err(WorkerQuitReason::TransportClosed);
                    };
                    context.send_to_handler(msg).await?;
                }
                maybe_req = context.from_handler_rx.recv() => {
                    let Some(req) = maybe_req else {
                        return Err(WorkerQuitReason::HandlerTerminated);
                    };

                    // 等待 SSE endpoint 准备好（server 会通过 `event: endpoint` 下发）。
                    let endpoint_url = {
                        let deadline = Duration::from_secs(10);
                        let started = std::time::Instant::now();
                        loop {
                            if let Some(u) = endpoint.read().await.clone() {
                                break Ok(u);
                            }
                            if started.elapsed() >= deadline {
                                break Err(SseTransportError::EndpointTimeout(deadline));
                            }
                            let remaining = deadline.saturating_sub(started.elapsed());
                            tokio::select! {
                                _ = context.cancellation_token.cancelled() => {
                                    break Err(SseTransportError::TransportChannelClosed);
                                }
                                _ = endpoint_notify.notified() => {}
                                _ = tokio::time::sleep(remaining) => {
                                    break Err(SseTransportError::EndpointTimeout(deadline));
                                }
                            }
                        }
                    };
                    let endpoint_url = match endpoint_url {
                        Ok(u) => u,
                        Err(e) => {
                            let _ = req.responder.send(Err(e));
                            continue;
                        }
                    };

                    // POST JSON-RPC 消息到 endpoint。
                    let mut http_req = post_client
                        .post(endpoint_url.clone())
                        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
                        .json(&req.message);
                    if let Some(token) = post_bearer.as_deref() {
                        http_req = http_req.bearer_auth(token);
                    }

                    let resp = match http_req.send().await {
                        Ok(r) => r,
                        Err(e) => {
                            let _ = req.responder.send(Err(SseTransportError::Http(e)));
                            continue;
                        }
                    };

                    let status = resp.status();
                    if !status.is_success() {
                        let body = resp.text().await.unwrap_or_default();
                        let _ = req.responder.send(Err(SseTransportError::HttpStatus { status, body }));
                        continue;
                    }

                    // send() 表示“已发出请求”；响应一般会从 SSE 回来，所以这里优先 ack。
                    let _ = req.responder.send(Ok(()));

                    // 一些 server 可能会在 HTTP 响应里直接返回 JSON-RPC（兼容处理）。
                    if status != reqwest::StatusCode::ACCEPTED && status != reqwest::StatusCode::NO_CONTENT {
                        let ct = resp
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if ct.starts_with("application/json") {
                            if let Ok(msg) = resp.json::<rmcp::model::ServerJsonRpcMessage>().await {
                                context.send_to_handler(msg).await?;
                            }
                        }
                    }
                }
            }
        }
    }
}

async fn run_with_timeout<F, T>(fut: F, timeout: Option<Duration>, label: &str) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, ServiceError>>,
{
    match timeout {
        Some(duration) => time::timeout(duration, fut)
            .await
            .map_err(|_| format!("{label} 超时（{duration:?}）"))?
            .map_err(|e| format!("{label} 失败: {e}")),
        None => fut.await.map_err(|e| format!("{label} 失败: {e}")),
    }
}

fn build_http_client(
    http_headers: Option<&HashMap<String, String>>,
    env_http_headers: Option<&HashMap<String, String>>,
) -> Result<reqwest::Client, anyhow::Error> {
    let mut headers = reqwest::header::HeaderMap::new();

    if let Some(static_headers) = http_headers {
        for (name, value) in static_headers {
            let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Ok(value) = reqwest::header::HeaderValue::from_str(value.as_str()) else {
                continue;
            };
            headers.insert(name, value);
        }
    }

    if let Some(env_headers) = env_http_headers {
        for (name, env_var) in env_headers {
            let Ok(v) = std::env::var(env_var) else {
                continue;
            };
            if v.trim().is_empty() {
                continue;
            }
            let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Ok(value) = reqwest::header::HeaderValue::from_str(v.as_str()) else {
                continue;
            };
            headers.insert(name, value);
        }
    }

    Ok(reqwest::Client::builder()
        .default_headers(headers)
        .build()?)
}

fn create_env_for_mcp_server(
    extra_env: Option<HashMap<String, String>>,
    env_vars: &[String],
) -> HashMap<String, String> {
    DEFAULT_ENV_VARS
        .iter()
        .copied()
        .chain(env_vars.iter().map(String::as_str))
        .filter_map(|var| {
            std::env::var(var)
                .ok()
                .map(|value| (var.to_string(), value))
        })
        .chain(extra_env.unwrap_or_default())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_init_does_not_error_already_initializing() {
        let cfg = McpServerConfig {
            transport: McpServerTransportConfig::StreamableHttp {
                url: "http://127.0.0.1:1".to_string(),
                bearer_token_env_var: None,
                http_headers: None,
                env_http_headers: None,
            },
            enabled: true,
            startup_timeout_ms: Some(50),
            tool_timeout_ms: Some(50),
            enabled_tools: Vec::new(),
            disabled_tools: Vec::new(),
        };

        let client = McpClient::new("test", &cfg).await.unwrap();
        let timeout = Some(Duration::from_millis(50));

        let (a, b) = tokio::join!(client.list_tools(timeout), client.list_tools(timeout));
        assert!(a.is_err());
        assert!(b.is_err());
        assert!(!a.unwrap_err().contains("already initializing"));
        assert!(!b.unwrap_err().contains("already initializing"));
    }
}

#[cfg(unix)]
const DEFAULT_ENV_VARS: &[&str] = &[
    "HOME",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
    "__CF_USER_TEXT_ENCODING",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "TZ",
];

#[cfg(windows)]
const DEFAULT_ENV_VARS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "USERNAME",
    "USERDOMAIN",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "POWERSHELL",
    "PWSH",
];
