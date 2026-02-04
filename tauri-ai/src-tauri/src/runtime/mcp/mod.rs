use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::FutureExt;
use rmcp::model::{
    CallToolRequestParam, ClientCapabilities, ClientInfo, Implementation, InitializeRequestParam,
    JsonObject, ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParam,
    ReadResourceRequestParam, ReadResourceResult, Resource, ResourceTemplate, Tool,
};
use rmcp::service::{self, NotificationContext, RequestContext, RunningService, ServiceError};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ClientHandler;
use rmcp::RoleClient;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock};
use tokio::time;

use crate::models::{McpServerConfig, McpServerTransportConfig};

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default)]
pub struct McpServerRuntimeStatus {
    pub ready: bool,
    pub last_error: Option<String>,
    pub last_tools_count: Option<usize>,
}

pub struct McpRuntime {
    clients: RwLock<HashMap<String, Arc<McpClient>>>,
    status: RwLock<HashMap<String, McpServerRuntimeStatus>>,
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
            status: RwLock::new(HashMap::new()),
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

        if let Some(existing) = self.clients.read().await.get(server_name).cloned() {
            return Ok(existing);
        }

        let client = Arc::new(McpClient::new(server_name, cfg).await?);
        self.clients
            .write()
            .await
            .insert(server_name.to_string(), client.clone());
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

enum ClientState {
    Connecting {
        transport: Option<PendingTransport>,
    },
    Ready {
        service: Arc<RunningService<RoleClient, BasicClientHandler>>,
    },
}

enum PendingTransport {
    ChildProcess(TokioChildProcess),
    StreamableHttp {
        transport: StreamableHttpClientTransport<reqwest::Client>,
    },
}

pub struct McpClient {
    state: Mutex<ClientState>,
}

impl McpClient {
    pub async fn new(server_name: &str, cfg: &McpServerConfig) -> Result<Self, String> {
        let transport = match &cfg.transport {
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

                PendingTransport::ChildProcess(transport)
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
                PendingTransport::StreamableHttp { transport }
            }
        };

        println!("[MCP] 初始化客户端: {server_name}");
        Ok(Self {
            state: Mutex::new(ClientState::Connecting {
                transport: Some(transport),
            }),
        })
    }

    async fn ensure_ready(&self, timeout: Option<Duration>) -> Result<(), String> {
        let transport_fut: BoxFuture<
            'static,
            Result<
                RunningService<RoleClient, BasicClientHandler>,
                rmcp::service::ClientInitializeError,
            >,
        > = {
            let mut guard = self.state.lock().await;
            match &mut *guard {
                ClientState::Ready { .. } => return Ok(()),
                ClientState::Connecting { transport } => {
                    let pending = transport
                        .take()
                        .ok_or_else(|| "client already initializing".to_string())?;

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

                    match pending {
                        PendingTransport::ChildProcess(t) => {
                            service::serve_client(handler, t).boxed()
                        }
                        PendingTransport::StreamableHttp { transport } => {
                            service::serve_client(handler, transport).boxed()
                        }
                    }
                }
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

        {
            let mut guard = self.state.lock().await;
            *guard = ClientState::Ready {
                service: Arc::new(service),
            };
        }

        Ok(())
    }

    async fn service(&self) -> Result<Arc<RunningService<RoleClient, BasicClientHandler>>, String> {
        let guard = self.state.lock().await;
        match &*guard {
            ClientState::Ready { service } => Ok(Arc::clone(service)),
            ClientState::Connecting { .. } => Err("MCP client 未初始化".to_string()),
        }
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
