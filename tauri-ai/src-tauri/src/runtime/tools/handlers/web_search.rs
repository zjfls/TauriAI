use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use crate::ai_client::ToolCall;
use crate::models::{SandboxPolicy, WebSearchProvider, WebSearchToolSettings};
use crate::runtime::events::RunEvent;
use crate::runtime::tools::registry::{ToolCallResult, ToolError, ToolExecutionContext, ToolHandler};
use crate::runtime::tools::spec::ToolSpec;

pub struct WebSearchTool {
    pub settings: WebSearchToolSettings,
    /// Provider override for this specific tool instance (from user selection)
    pub provider_override: Option<WebSearchProvider>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchArgs {
    query: String,
    #[serde(default)]
    max_results: Option<u32>,
}

#[async_trait]
impl ToolHandler for WebSearchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "web_search".to_string(),
            description: Some("本地网络搜索工具（当模型无内置 web_search 能力时使用）".to_string()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "搜索关键词/问题" },
                    "maxResults": { "type": "integer", "description": "最多返回条数（可选）" }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            // 该工具是"隐藏工具"：不出现在 UI 的工具列表里，但会在需要时暴露给模型。
            // 权限控制由：沙箱网络策略 + web_search_enabled + API key 配置共同决定。
            required_permissions: vec![],
        }
    }

    async fn is_mutating(&self, _call: &ToolCall) -> bool {
        false
    }

    async fn call(
        &self,
        ctx: &mut ToolExecutionContext<'_>,
        call: &ToolCall,
    ) -> Result<ToolCallResult, ToolError> {
        if !sandbox_allows_network(&ctx.sandbox_policy) {
            return Err(ToolError::denied("当前沙箱策略禁止网络访问，无法使用 web_search"));
        }

        let args: WebSearchArgs = serde_json::from_str(&call.arguments)
            .map_err(|e| ToolError::invalid(format!("解析 web_search 参数失败: {e}")))?;
        let query = args.query.trim().to_string();
        if query.is_empty() {
            return Err(ToolError::invalid("query 不能为空"));
        }

        // Determine which provider to use: override (from user selection) or default from settings
        let provider = self.provider_override.unwrap_or(self.settings.provider);

        let min_interval = self.settings.min_interval_ms.unwrap_or(1200);
        ctx.services.web_search.wait_for_interval(min_interval).await;

        let max_results = args
            .max_results
            .or(self.settings.max_results)
            .unwrap_or(5)
            .clamp(1, 10);

        let result = match provider {
            WebSearchProvider::Tavily => tavily_search(&query, max_results, &self.settings).await?,
            WebSearchProvider::Brave => brave_search(&query, max_results, &self.settings).await?,
            WebSearchProvider::Google => google_search(&query, max_results, &self.settings).await?,
        };

        let pretty = serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
        emit_web_search_block(ctx, call.id.as_str(), "done", Some(&result));
        Ok(ToolCallResult { content: pretty })
    }
}

fn sandbox_allows_network(policy: &SandboxPolicy) -> bool {
    match policy {
        SandboxPolicy::DangerFullAccess => true,
        SandboxPolicy::ReadOnly => false,
        SandboxPolicy::ExternalSandbox { network_access } => network_access.is_enabled(),
        SandboxPolicy::WorkspaceWrite { network_access, .. } => *network_access,
    }
}

fn emit_web_search_block(
    ctx: &mut ToolExecutionContext<'_>,
    call_id: &str,
    status: &str,
    action: Option<&serde_json::Value>,
) {
    ctx.emitter.emit(RunEvent::BlockDelta {
        task_id: ctx.task_id.to_string(),
        turn_id: ctx.turn_id.to_string(),
        assistant_message_id: Some(ctx.assistant_message_id.to_string()),
        block_id: format!("web_search:{call_id}"),
        block_type: "web_search".to_string(),
        format: Some("json".to_string()),
        delta: json!({
            "callId": call_id,
            "status": status,
            "action": action
        })
        .to_string(),
    });
}

async fn tavily_search(
    query: &str,
    max_results: u32,
    settings: &WebSearchToolSettings,
) -> Result<serde_json::Value, ToolError> {
    let api_key = settings
        .tavily_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::denied("未配置 Tavily API Key"))?;

    let body = json!({
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "include_answer": false,
        "include_raw_content": false
    });

    let resp = reqwest::Client::new()
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
        .map_err(|e| ToolError::new(format!("Tavily 请求失败: {e}")))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| ToolError::new(format!("读取 Tavily 响应失败: {e}")))?;
    if !status.is_success() {
        return Err(ToolError::new(format!(
            "Tavily 返回错误（{status}）: {text}"
        )));
    }
    serde_json::from_str(&text).map_err(|e| ToolError::new(format!("解析 Tavily 响应失败: {e}")))
}

async fn brave_search(
    query: &str,
    max_results: u32,
    settings: &WebSearchToolSettings,
) -> Result<serde_json::Value, ToolError> {
    let api_key = settings
        .brave_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::denied("未配置 Brave Search API Key"))?;

    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        urlencoding::encode(query),
        max_results
    );

    let resp = reqwest::Client::new()
        .get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|e| ToolError::new(format!("Brave 请求失败: {e}")))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| ToolError::new(format!("读取 Brave 响应失败: {e}")))?;
    if !status.is_success() {
        return Err(ToolError::new(format!(
            "Brave 返回错误（{status}）: {text}"
        )));
    }
    serde_json::from_str(&text).map_err(|e| ToolError::new(format!("解析 Brave 响应失败: {e}")))
}

async fn google_search(
    query: &str,
    max_results: u32,
    settings: &WebSearchToolSettings,
) -> Result<serde_json::Value, ToolError> {
    let api_key = settings
        .google_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::denied("未配置 Google API Key"))?;
    let cx = settings
        .google_cx
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::denied("未配置 Google CX（Custom Search Engine）"))?;

    let url = format!(
        "https://customsearch.googleapis.com/customsearch/v1?key={}&cx={}&q={}&num={}",
        urlencoding::encode(api_key),
        urlencoding::encode(cx),
        urlencoding::encode(query),
        max_results
    );

    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| ToolError::new(format!("Google 请求失败: {e}")))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| ToolError::new(format!("读取 Google 响应失败: {e}")))?;
    if !status.is_success() {
        return Err(ToolError::new(format!(
            "Google 返回错误（{status}）: {text}"
        )));
    }
    serde_json::from_str(&text).map_err(|e| ToolError::new(format!("解析 Google 响应失败: {e}")))
}
