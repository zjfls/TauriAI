# Design Document

## Overview

将模型配置系统从扁平结构重构为三层架构：

```
Provider (提供商)
    └── Model (模型)
            └── Agent (智能体) ← 用户实际使用的入口
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Config Structure                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  providers: [                                                   │
│    {                                                            │
│      name: "siliconflow",        // 唯一标识                     │
│      displayName: "硅基流动",                                    │
│      type: "openai_compatible",                                 │
│      apiBase: "https://api.siliconflow.cn/v1",                 │
│      apiKey: "sk-xxx",                                          │
│      models: [                   // 该 Provider 下的模型         │
│        { name: "deepseek-v3", temperature: 0.7, maxTokens: 4096 },
│        { name: "qwen-72b", temperature: 0.7, maxTokens: 8192 }  │
│      ]                                                          │
│    },                                                           │
│    {                                                            │
│      name: "ollama",                                            │
│      displayName: "Ollama Local",                               │
│      type: "ollama",                                            │
│      apiBase: "http://localhost:11434",                         │
│      apiKey: null,                                              │
│      models: [...]                                              │
│    }                                                            │
│  ],                                                             │
│                                                                 │
│  agents: [                                                      │
│    {                                                            │
│      name: "default",            // 唯一标识                     │
│      displayName: "默认助手",                                    │
│      description: "通用 AI 助手",                                │
│      modelRef: "siliconflow/deepseek-v3",  // provider/model    │
│      systemPrompt: "你是一个有帮助的 AI 助手...",                 │
│      formatType: "chat"          // 输出格式类型                 │
│    },                                                           │
│    {                                                            │
│      name: "coder",                                             │
│      displayName: "编程助手",                                    │
│      modelRef: "siliconflow/deepseek-v3",                       │
│      systemPrompt: "你是一个专业的编程助手...",                   │
│      formatType: "chat"                                         │
│    }                                                            │
│  ],                                                             │
│                                                                 │
│  defaultAgent: "default"                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### TypeScript Types (Frontend)

```typescript
// Provider 类型
type ProviderType = 'openai_compatible' | 'anthropic' | 'ollama';

// 模型配置 (纯模型参数，无 system prompt)
interface Model {
  name: string;                    // 模型名称，如 "deepseek-v3"
  temperature: number;
  maxTokens?: number;
  topP?: number;
}

// Provider 配置
interface Provider {
  name: string;                    // 唯一标识，如 "siliconflow"
  displayName: string;             // 显示名称，如 "硅基流动"
  type: ProviderType;
  apiBase: string;
  apiKey?: string;
  models: Model[];
}

// Agent 配置
interface Agent {
  name: string;                    // 唯一标识
  displayName: string;             // 显示名称
  description?: string;
  modelRef: string;                // 格式: "provider_name/model_name"
  systemPrompt: string;
  formatType: FormatPromptType;    // 'chat' | 'plain' | 'json' | 'none'
}

// 应用配置
interface AppConfig {
  appearance: AppearanceSettings;
  general: GeneralSettings;
  providers: Provider[];
  agents: Agent[];
  defaultAgent: string;            // Agent name
}
```

### Rust Types (Backend)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    OpenaiCompatible,
    Anthropic,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub name: String,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub name: String,
    pub display_name: String,
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    pub api_base: String,
    pub api_key: Option<String>,
    pub models: Vec<Model>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub model_ref: String,           // "provider_name/model_name"
    pub system_prompt: String,
    pub format_type: FormatPromptType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub appearance: AppearanceSettings,
    pub general: GeneralSettings,
    pub providers: Vec<Provider>,
    pub agents: Vec<Agent>,
    pub default_agent: String,
}
```

## Data Flow

### Chat 请求流程

```
User sends message
        │
        ▼
┌───────────────────┐
│ Get current Agent │
└─────────┬─────────┘
          │
          ▼
┌───────────────────────────────┐
│ Parse modelRef                │
│ "siliconflow/deepseek-v3"     │
│   → provider: "siliconflow"   │
│   → model: "deepseek-v3"      │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Resolve Provider              │
│ - Get apiBase, apiKey         │
│ - Get Model parameters        │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Build Request                 │
│ - System: agent.systemPrompt  │
│   + formatPrompt              │
│ - Messages: conversation      │
│ - Model params: temperature   │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Call AI API                   │
│ (via provider's apiBase)      │
└───────────────────────────────┘
```

### 模型查询流程

```
User clicks "Fetch Models"
        │
        ▼
┌───────────────────────────────┐
│ Call provider's /models API   │
│ (OpenAI compatible endpoint)  │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Parse response                │
│ { data: [{ id: "model-1" }] } │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Update provider.models[]      │
│ with default parameters       │
└───────────────────────────────┘
```

## UI Design

### Provider 配置界面（参考截图风格）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [Providers]  [Agents]  [Appearance]  [General]                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────┐  ┌───────────────────────────────────────────────┐│
│  │ 🔍 搜索提供商...     │  │                                               ││
│  ├─────────────────────┤  │  硅基流动                                      ││
│  │                     │  │                                               ││
│  │ ┌─────────────────┐ │  │  API Key                                      ││
│  │ │ 🤖 硅基流动  🔵 │ │  │  ┌─────────────────────────────────────────┐ ││
│  │ │     [ON/OFF ●]  │ │  │  │ sk-xxxxxxxxxxxxxxxxxxxxxxxx            │ ││
│  │ └─────────────────┘ │  │  └─────────────────────────────────────────┘ ││
│  │                     │  │                                               ││
│  │ ┌─────────────────┐ │  │  API 地址                                     ││
│  │ │ 🤖 OpenAI    ○  │ │  │  ┌─────────────────────────────────────────┐ ││
│  │ │     [ON/OFF ○]  │ │  │  │ https://api.siliconflow.cn/v1          │ ││
│  │ └─────────────────┘ │  │  └─────────────────────────────────────────┘ ││
│  │                     │  │                                               ││
│  │ ┌─────────────────┐ │  │  模型列表                    [管理] [+ 添加] ││
│  │ │ 🤖 Ollama    ○  │ │  │  ┌─────────────────────────────────────────┐ ││
│  │ │     [ON/OFF ○]  │ │  │  │ ▼ deepseek-v3                          │ ││
│  │ └─────────────────┘ │  │  │   temperature: 0.7  maxTokens: 4096    │ ││
│  │                     │  │  ├─────────────────────────────────────────┤ ││
│  │                     │  │  │ ▶ qwen-72b                              │ ││
│  │                     │  │  ├─────────────────────────────────────────┤ ││
│  │                     │  │  │ ▶ deepseek-coder                        │ ││
│  │ [+ 添加提供商]      │  │  └─────────────────────────────────────────┘ ││
│  │                     │  │                                               ││
│  │                     │  │  [测试连接]                          [保存]  ││
│  └─────────────────────┘  └───────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### UI 设计说明

**左侧 Provider 列表：**
- 顶部搜索框，支持按名称过滤
- 每个 Provider 卡片显示：图标、名称、启用状态指示器
- ON/OFF 开关控制 Provider 是否启用
- 选中的 Provider 高亮显示（蓝色边框/背景）
- 底部"添加提供商"按钮

**右侧配置面板：**
- 显示选中 Provider 的名称（大标题）
- API Key 输入框（密码类型，可切换显示）
- API 地址输入框
- 模型列表区域：
  - 标题栏带"管理"和"添加"按钮
  - 每个模型可展开/折叠查看参数
  - 展开后显示 temperature、maxTokens 等参数
- 底部操作按钮：测试连接、保存

### Agent 配置界面

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [Providers]  [Agents]  [Appearance]  [General]                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────┐  ┌───────────────────────────────────────────────┐│
│  │ 🔍 搜索智能体...     │  │                                               ││
│  ├─────────────────────┤  │  默认助手                              [★默认]││
│  │                     │  │                                               ││
│  │ ┌─────────────────┐ │  │  描述                                         ││
│  │ │ 🤖 默认助手  ★  │ │  │  ┌─────────────────────────────────────────┐ ││
│  │ └─────────────────┘ │  │  │ 通用 AI 助手，可以回答各种问题          │ ││
│  │                     │  │  └─────────────────────────────────────────┘ ││
│  │ ┌─────────────────┐ │  │                                               ││
│  │ │ 💻 编程助手     │ │  │  使用模型                                     ││
│  │ └─────────────────┘ │  │  ┌─────────────────────────────────────────┐ ││
│  │                     │  │  │ 硅基流动 / deepseek-v3              ▼   │ ││
│  │ ┌─────────────────┐ │  │  └─────────────────────────────────────────┘ ││
│  │ │ 🌐 翻译助手     │ │  │                                               ││
│  │ └─────────────────┘ │  │  系统提示词                                   ││
│  │                     │  │  ┌─────────────────────────────────────────┐ ││
│  │                     │  │  │ 你是一个有帮助的 AI 助手，请用简洁     │ ││
│  │                     │  │  │ 清晰的语言回答用户的问题。              │ ││
│  │                     │  │  │                                         │ ││
│  │                     │  │  └─────────────────────────────────────────┘ ││
│  │                     │  │                                               ││
│  │                     │  │  输出格式                                     ││
│  │ [+ 添加智能体]      │  │  ┌─────────────────────────────────────────┐ ││
│  │                     │  │  │ Chat (富文本)                       ▼   │ ││
│  │                     │  │  └─────────────────────────────────────────┘ ││
│  │                     │  │                                               ││
│  │                     │  │  [设为默认]  [删除]                   [保存]  ││
│  └─────────────────────┘  └───────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Agent UI 设计说明

**左侧 Agent 列表：**
- 顶部搜索框
- 每个 Agent 显示图标、名称
- 默认 Agent 显示星标 ★
- 底部"添加智能体"按钮

**右侧配置面板：**
- Agent 名称（大标题）+ 默认标记
- 描述输入框
- 模型选择下拉框（显示 "Provider / Model" 格式）
- 系统提示词多行文本框
- 输出格式选择（Chat/Plain/JSON/None）
- 底部操作按钮：设为默认、删除、保存

## Migration Strategy

### 旧配置格式

```json
{
  "activeModelId": "model_123",
  "models": [
    {
      "id": "model_123",
      "name": "GPT-4",
      "provider": "openai",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "sk-xxx",
      "model": "gpt-4",
      "parameters": {
        "temperature": 0.7,
        "systemPrompt": "You are helpful"
      }
    }
  ],
  "presets": [...]
}
```

### 迁移逻辑

1. 按 `provider` + `apiBase` 分组，创建 Provider
2. 每个旧 model 变成 Provider 下的 Model
3. 每个旧 model 的 `systemPrompt` 创建一个 Agent
4. `activeModelId` 对应的 Agent 设为 `defaultAgent`

## Error Handling

| 错误场景 | 处理方式 |
|---------|---------|
| Agent 引用的 Model 不存在 | 显示错误提示，禁止发送消息 |
| Provider API 连接失败 | 显示连接错误，允许重试 |
| 模型查询失败 | 显示错误，允许手动添加模型 |
| 配置迁移失败 | 保留旧配置，显示迁移错误 |

## Testing Strategy

1. **单元测试**: modelRef 解析、配置验证
2. **集成测试**: Provider 连接测试、模型查询
3. **迁移测试**: 旧配置格式转换
