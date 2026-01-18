# 后端多级别思考支持适配指南

## 当前状态

### ✅ 前端已完成
- UI 支持多级别选择（无/最少/低/中/高）
- 类型定义：`ThinkingLevel = null | 'minimal' | 'low' | 'medium' | 'high'`
- ChatView 将 ThinkingLevel 转换为字符串传递给后端
- sessionStore 接受 `thinking?: boolean | string` 参数

### ⚠️ 后端待适配
- 当前只接受 `thinking_enabled: Option<bool>`
- 需要改为接受字符串级别

## OpenAI 官方文档参考

根据 OpenAI 官方文档,reasoning effort 的有效值为:
- **`minimal`**: 最少推理 (最快,最少 token)
- **`low`**: 低推理
- **`medium`**: 中等推理 (默认值)
- **`high`**: 高推理 (最彻底)

参考: https://cookbook.openai.com/examples/gpt-5/gpt-5_new_params_and_tools

## 需要修改的后端文件

### 1. `src-tauri/src/models.rs`

**当前代码：**
```rust
pub struct ModelConfig {
    // ...
    pub thinking_enabled: Option<bool>,
}
```

**需要改为：**
```rust
pub struct ModelConfig {
    // ...
    /// Thinking configuration
    /// - None: Model doesn't support thinking
    /// - Some("disabled"): Explicitly disable thinking
    /// - Some("low" | "medium" | "high" | "very_high"): Enable with specific effort level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}
```

### 2. `src-tauri/src/commands/chat.rs`

**当前代码（约第189行）：**
```rust
thinking_enabled: if model.capabilities.thinking {
    Some(enable_thinking.unwrap_or(true))
} else {
    None
},
```

**需要改为：**
```rust
thinking_level: if model.capabilities.thinking {
    // thinking 参数可以是 boolean 或 string
    match thinking {
        Some(serde_json::Value::Bool(true)) => Some("medium".to_string()),
        Some(serde_json::Value::Bool(false)) => Some("disabled".to_string()),
        Some(serde_json::Value::String(level)) => Some(level),
        _ => Some("medium".to_string()), // 默认值
    }
} else {
    None
},
```

**同时需要修改函数签名：**
```rust
#[tauri::command]
pub async fn chat_stream(
    // ...
    thinking: Option<serde_json::Value>,  // 改为接受 JSON 值
    // ...
) -> Result<(), String> {
```

### 3. `src-tauri/src/ai_client/openai_responses.rs`

**当前代码（约第235行和第331行）：**
```rust
let reasoning = if config.thinking_enabled == Some(true) {
    Some(ReasoningConfig {
        effort: Some("medium".to_string()),
        summary: Some("auto".to_string()),
    })
} else {
    None
};
```

**需要改为：**
```rust
let reasoning = config.thinking_level.as_ref().and_then(|level| {
    if level == "disabled" {
        None
    } else {
        Some(ReasoningConfig {
            effort: Some(level.clone()),
            summary: Some("auto".to_string()),
        })
    }
});
```

### 4. `src-tauri/src/ai_client/openai.rs`

**当前代码（约第319行和第391行）：**
```rust
let thinking = config.thinking_enabled.map(|enabled| ThinkingConfig {
    thinking_type: if enabled { "enabled" } else { "disabled" }.to_string(),
});
```

**需要改为：**
```rust
let thinking = config.thinking_level.as_ref().map(|level| ThinkingConfig {
    thinking_type: if level == "disabled" { 
        "disabled".to_string() 
    } else { 
        "enabled".to_string() 
    },
});
```

### 5. `src-tauri/src/commands/config.rs`

**当前代码（约第58行）：**
```rust
thinking_enabled: None,
```

**需要改为：**
```rust
thinking_level: None,
```

### 6. `src-tauri/src/commands/conversation.rs`

**当前代码（约第118行）：**
```rust
thinking_enabled: None,
```

**需要改为：**
```rust
thinking_level: None,
```

## 实现步骤

1. **修改类型定义** (`models.rs`)
   - 将 `thinking_enabled: Option<bool>` 改为 `thinking_level: Option<String>`

2. **修改命令接口** (`commands/chat.rs`)
   - 将 `enable_thinking: Option<bool>` 改为 `thinking: Option<serde_json::Value>`
   - 添加类型转换逻辑

3. **修改 AI 客户端** (`ai_client/*.rs`)
   - OpenAI Responses API: 直接使用 level 字符串
   - OpenAI Chat Completions API: 将 level 转换为 enabled/disabled

4. **测试验证**
   - 测试 chat_completions API（boolean 模式）
   - 测试 responses API（多级别模式）
   - 验证默认值和边界情况

## 向后兼容性

为了保持向后兼容，可以在 Rust 端添加迁移逻辑：

```rust
// 如果前端传递 boolean，自动转换为字符串
match thinking {
    Some(serde_json::Value::Bool(true)) => Some("medium".to_string()),
    Some(serde_json::Value::Bool(false)) => Some("disabled".to_string()),
    Some(serde_json::Value::String(level)) => Some(level),
    _ => None,
}
```

## 测试用例

### 前端测试
```typescript
// chat_completions API
thinking: true  → backend receives: "medium"
thinking: false → backend receives: "disabled"

// responses API
thinking: null        → backend receives: "disabled"
thinking: 'minimal'   → backend receives: "minimal"
thinking: 'low'       → backend receives: "low"
thinking: 'medium'    → backend receives: "medium"
thinking: 'high'      → backend receives: "high"
```

### 后端测试
```rust
// OpenAI Responses API
thinking_level: Some("minimal")   → reasoning.effort = "minimal"
thinking_level: Some("low")       → reasoning.effort = "low"
thinking_level: Some("medium")    → reasoning.effort = "medium"
thinking_level: Some("high")      → reasoning.effort = "high"
thinking_level: Some("disabled")  → reasoning = None
thinking_level: None              → reasoning = None
```

## 当前临时方案

在后端完全适配之前，前端已经实现了以下临时方案：
- UI 完全支持多级别选择
- 前端将多级别转换为字符串传递
- 后端需要适配以正确处理这些字符串值

用户可以看到和选择不同的思考级别，但实际效果取决于后端的实现进度。
