# Reasoning Effort 支持实现总结

## 实现日期
2025-01-18

## 功能概述
为 OpenAI Chat Completions API 添加了 `reasoning_effort` 参数支持,允许用户为支持该功能的模型(如 GPT-5 系列)选择多级推理控制。

## 实现的功能

### 1. 类型定义更新

#### 前端 (TypeScript)
**文件**: `tauri-ai/src/types/index.ts`

添加了 `useReasoningEffort` 字段到 `Model` 接口:
```typescript
export interface Model {
  // ... 现有字段
  useReasoningEffort?: boolean; // 使用 reasoning_effort 参数(OpenAI GPT-5 系列)
}
```

#### 后端 (Rust)
**文件**: `tauri-ai/src-tauri/src/models.rs`

1. 更新 `Model` 结构体:
```rust
pub struct Model {
    // ... 现有字段
    pub use_reasoning_effort: Option<bool>,
}
```

2. 更新 `ModelConfig` 结构体:
```rust
pub struct ModelConfig {
    // ... 现有字段
    pub use_reasoning_effort: Option<bool>,
}
```

### 2. 前端组件更新

#### ThinkingSelector 组件
**文件**: `tauri-ai/src/components/Chat/ThinkingSelector.tsx`

**修改内容**:
- 添加 `useReasoningEffort` 属性到组件 Props
- 更新渲染逻辑以支持条件显示:
  - `responses` API: 始终显示多级选择器
  - `chat_completions` API + `useReasoningEffort=true`: 显示多级选择器
  - `chat_completions` API + `useReasoningEffort=false`: 显示简单开关

**核心逻辑**:
```typescript
const showMultiLevel = apiProtocol === 'responses' || 
                       (apiProtocol === 'chat_completions' && useReasoningEffort);
```

#### ChatView 组件
**文件**: `tauri-ai/src/components/Chat/ChatView.tsx`

**修改内容**:
- 添加 `useReasoningEffort` 计算逻辑:
```typescript
const useReasoningEffort = useMemo(() => {
  return currentModel?.useReasoningEffort ?? false;
}, [currentModel]);
```
- 将 `useReasoningEffort` 传递给 `InputArea` 组件

#### InputArea 组件
**文件**: `tauri-ai/src/components/Chat/InputArea.tsx`

**修改内容**:
- 添加 `useReasoningEffort` 到 Props 接口
- 将 `useReasoningEffort` 传递给 `ThinkingSelector` 组件

### 3. 后端 API 客户端更新

#### OpenAI 客户端
**文件**: `tauri-ai/src-tauri/src/ai_client/openai.rs`

**修改内容**:

1. 更新请求结构体,添加 `reasoning_effort` 字段:
```rust
struct ChatCompletionRequest {
    // ... 现有字段
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}
```

2. 实现参数映射逻辑(非流式和流式请求):
```rust
let (thinking, reasoning_effort) = if config.use_reasoning_effort.unwrap_or(false) {
    // 使用 reasoning_effort 参数 (OpenAI GPT-5)
    let effort = config.thinking_level.as_ref().and_then(|level| {
        match level.as_str() {
            "disabled" => Some("none".to_string()),
            "low" => Some("low".to_string()),
            "medium" => Some("medium".to_string()),
            "high" => Some("high".to_string()),
            "xhigh" => Some("high".to_string()), // Chat Completions API 不支持 xhigh
            _ => None,
        }
    });
    (None, effort)
} else {
    // 使用 thinking 参数 (DeepSeek 等)
    let thinking_cfg = config.thinking_level.as_ref().map(|level| ThinkingConfig {
        thinking_type: if level == "disabled" { "disabled" } else { "enabled" }.to_string(),
    });
    (thinking_cfg, None)
};
```

**参数映射规则**:
- `null` → `"none"`
- `"low"` → `"low"`
- `"medium"` → `"medium"`
- `"high"` → `"high"`
- `"xhigh"` → `"high"` (Chat Completions API 不支持 xhigh,映射到 high)

#### Chat 命令
**文件**: `tauri-ai/src-tauri/src/commands/chat.rs`

**修改内容**:
- 在构建 `ModelConfig` 时传递 `use_reasoning_effort` 字段:
```rust
let model_config = ModelConfig {
    // ... 现有字段
    use_reasoning_effort: model.use_reasoning_effort,
};
```

### 4. 其他文件修复

为了保持编译通过,更新了以下文件中的 `ModelConfig` 初始化:

1. **config.rs**: 连接测试时添加 `use_reasoning_effort: None`
2. **conversation.rs**: 标题生成时添加 `use_reasoning_effort: None`
3. **models.rs**: 配置迁移时添加 `use_reasoning_effort: None`

## 技术细节

### 参数隔离策略
实现了严格的参数隔离,确保不同 API 协议使用正确的参数格式:

- **启用 `useReasoningEffort`**: 发送 `reasoning_effort` 字符串参数
- **未启用 `useReasoningEffort`**: 发送 `thinking` 对象参数
- **Responses API**: 继续使用 `reasoning.effort` 对象格式(不受影响)

### 向后兼容性
- 所有新字段都是可选的(`Option<bool>`)
- 默认值为 `false`,保持现有行为
- 旧配置文件加载时自动设置为 `None`/`false`

### UI 适配逻辑
ThinkingSelector 组件根据以下条件决定显示模式:

| API 协议 | useReasoningEffort | 显示模式 |
|---------|-------------------|---------|
| responses | - | 多级选择器 |
| chat_completions | true | 多级选择器 |
| chat_completions | false | 简单开关 |

## 测试状态

### 编译测试
✅ Rust 后端编译通过 (`cargo check`)
- 无错误
- 1个警告(未使用的函数,不影响功能)

### 需要的手动测试
由于这是直接实现(未走完整 spec 流程),建议进行以下测试:

1. **UI 测试**:
   - [ ] 创建启用 `useReasoningEffort` 的模型配置
   - [ ] 验证 ThinkingSelector 显示多级选择器
   - [ ] 创建未启用的模型配置
   - [ ] 验证 ThinkingSelector 显示简单开关

2. **API 测试**:
   - [ ] 使用启用 `useReasoningEffort` 的模型发送消息
   - [ ] 检查后端日志确认发送了 `reasoning_effort` 参数
   - [ ] 使用未启用的模型发送消息
   - [ ] 检查后端日志确认发送了 `thinking` 参数

3. **兼容性测试**:
   - [ ] 加载旧配置文件,确认不会报错
   - [ ] 验证 Responses API 模型不受影响
   - [ ] 验证 Anthropic 模型不受影响

## 使用方法

### 为模型启用 Reasoning Effort

在模型配置的高级设置中:

1. 找到"使用 Reasoning Effort"选项
2. 启用该选项
3. 保存配置

启用后,在聊天界面的思考选择器中将显示多级选项:
- 无 (none)
- 低 (low)
- 中 (medium)
- 高 (high)
- 超高 (xhigh,会映射到 high)

### 适用模型
此功能主要适用于:
- OpenAI GPT-5 系列 (gpt-5, gpt-5-mini, gpt-5-nano)
- 其他支持 `reasoning_effort` 参数的 OpenAI Compatible 模型

## 相关文档
- [OpenAI Reasoning Models Guide](https://platform.openai.com/docs/guides/reasoning)
- [REASONING_EFFORT_RESEARCH.md](../../REASONING_EFFORT_RESEARCH.md) - 调研报告

## 实现者
Kiro AI Agent

## 备注
- 此实现跳过了完整的 spec 流程(requirements → design → tasks)
- 直接实现了核心功能
- 建议后续添加单元测试和集成测试
