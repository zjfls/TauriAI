# Design Document: TauriAI Chat UI MVP

## Overview

本设计文档描述 TauriAI MVP 聊天界面的技术实现方案。基于 Tauri v2 + React 19 + TypeScript + Rust 技术栈，实现一个支持多 AI 模型的桌面聊天应用。

核心功能包括：
- 现代化聊天界面（Markdown 渲染、代码高亮、流式输出）
- 多 AI Provider 支持（OpenAI、Anthropic、Ollama）
- 本地对话历史存储（SQLite）
- 配置管理（JSON 文件）
- 系统托盘常驻

## Architecture

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React + TypeScript)             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  ChatView   │  │  Settings   │  │   HistoryPanel      │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         └────────────────┼─────────────────────┘             │
│                          │                                   │
│                   ┌──────▼──────┐                            │
│                   │ Zustand     │                            │
│                   │ Stores      │                            │
│                   └──────┬──────┘                            │
└──────────────────────────┼───────────────────────────────────┘
                           │ invoke() / listen()
┌──────────────────────────┼───────────────────────────────────┐
│                    Tauri Bridge                              │
└──────────────────────────┼───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│                    Backend (Rust)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  commands   │  │  ai_client  │  │   storage           │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         │         ┌──────▼──────┐       ┌──────▼──────┐     │
│         │         │  OpenAI     │       │  SQLite     │     │
│         │         │  Anthropic  │       │  (data.db)  │     │
│         │         │  Ollama     │       └─────────────┘     │
│         │         └─────────────┘                           │
│         │                                                    │
│  ┌──────▼──────┐  ┌─────────────┐                           │
│  │   config    │  │   system    │                           │
│  │ (JSON file) │  │ (tray/hotkey)│                          │
│  └─────────────┘  └─────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

### 数据流

1. **发送消息流程**:
   - 用户输入 → Zustand store → invoke("chat_stream") → Rust ai_client → AI API
   - AI 响应 → SSE 解析 → Tauri Event → Frontend listen → 更新 UI

2. **配置加载流程**:
   - 应用启动 → Rust config::load() → invoke("get_app_config") → Zustand configStore

## Components and Interfaces

### Frontend Components

#### 1. Layout Components

```typescript
// src/components/Layout/MainLayout.tsx
interface MainLayoutProps {
  children: React.ReactNode;
}

// src/components/Layout/Sidebar.tsx
interface SidebarProps {
  activeView: 'chat' | 'history' | 'settings';
  onViewChange: (view: string) => void;
}

// src/components/Layout/Header.tsx
interface HeaderProps {
  title: string;
  onModelSelect: (modelId: string) => void;
  currentModelId: string;
  models: ModelConfig[];
}
```

#### 2. Chat Components

```typescript
// src/components/Chat/ChatView.tsx
interface ChatViewProps {
  conversationId: string | null;
}

// src/components/Chat/MessageList.tsx
interface MessageListProps {
  messages: Message[];
  streamingContent: string | null;
  isGenerating: boolean;
}

// src/components/Chat/MessageItem.tsx
interface MessageItemProps {
  message: Message;
  isStreaming?: boolean;
  onCopy: () => void;
  onRetry?: () => void;
}

// src/components/Chat/InputArea.tsx
interface InputAreaProps {
  onSend: (content: string) => void;
  disabled: boolean;
  isGenerating: boolean;
}
```

#### 3. Settings Components

```typescript
// src/components/Settings/SettingsView.tsx
interface SettingsViewProps {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
}

// src/components/Settings/ModelConfigForm.tsx
interface ModelConfigFormProps {
  model: ModelConfig | null;
  onSave: (model: ModelConfig) => void;
  onTest: (model: ModelConfig) => Promise<TestResult>;
}
```

### Zustand Stores

```typescript
// src/stores/configStore.ts
interface ConfigState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  setActiveModel: (modelId: string) => void;
  addModel: (model: ModelConfig) => void;
  updateModel: (model: ModelConfig) => void;
  deleteModel: (modelId: string) => void;
}

// src/stores/conversationStore.ts
interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  streamingMessage: string | null;
  isGenerating: boolean;
  error: string | null;
  
  // Actions
  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  createConversation: (title?: string) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  abortGeneration: () => Promise<void>;
  appendStreamingToken: (token: string) => void;
  finalizeStreaming: (fullContent: string) => void;
}

// src/stores/uiStore.ts
interface UIState {
  sidebarExpanded: boolean;
  activeView: 'chat' | 'history' | 'settings';
  theme: 'light' | 'dark' | 'system';
  
  // Actions
  toggleSidebar: () => void;
  setActiveView: (view: string) => void;
  setTheme: (theme: string) => void;
}
```

### Rust Backend Modules

#### 1. AI Client Trait

```rust
// src-tauri/src/ai_client/traits.rs
#[async_trait]
pub trait AiClient: Send + Sync {
    async fn chat(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
    ) -> Result<String, AiError>;
    
    async fn chat_stream(
        &self,
        messages: Vec<Message>,
        config: &ModelConfig,
        token_sender: mpsc::Sender<StreamEvent>,
    ) -> Result<(), AiError>;
}

pub enum StreamEvent {
    Token(String),
    Done(String),
    Error(String),
}
```

#### 2. Storage Interface

```rust
// src-tauri/src/storage/mod.rs
pub trait Storage: Send + Sync {
    fn create_conversation(&self, title: &str) -> Result<Conversation, StorageError>;
    fn get_conversations(&self) -> Result<Vec<Conversation>, StorageError>;
    fn get_conversation(&self, id: &str) -> Result<Option<Conversation>, StorageError>;
    fn delete_conversation(&self, id: &str) -> Result<(), StorageError>;
    fn update_conversation_title(&self, id: &str, title: &str) -> Result<(), StorageError>;
    
    fn add_message(&self, conversation_id: &str, message: &Message) -> Result<(), StorageError>;
    fn get_messages(&self, conversation_id: &str, limit: usize, before_id: Option<&str>) -> Result<Vec<Message>, StorageError>;
}
```

#### 3. Config Manager

```rust
// src-tauri/src/config/mod.rs
pub struct ConfigManager {
    config_path: PathBuf,
}

impl ConfigManager {
    pub fn load(&self) -> Result<AppConfig, ConfigError>;
    pub fn save(&self, config: &AppConfig) -> Result<(), ConfigError>;
    pub fn ensure_default(&self) -> Result<AppConfig, ConfigError>;
}
```

## Data Models

### Frontend Types (TypeScript)

```typescript
// src/types/index.ts

interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: MessageMeta;
  createdAt: string;
}

interface MessageMeta {
  model?: string;
  tokens?: number;
  duration?: number;
}

interface Conversation {
  id: string;
  title: string;
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ModelConfig {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
  apiBase?: string;
  apiKey?: string;
  model: string;
  parameters: ModelParameters;
}

interface ModelParameters {
  temperature: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
}

interface Preset {
  id: string;
  name: string;
  modelConfigId: string;
  systemPrompt: string;
  parametersOverride?: Partial<ModelParameters>;
}

interface AppConfig {
  appearance: {
    theme: 'system' | 'light' | 'dark';
    alwaysOnTop: boolean;
  };
  general: {
    language: string;
    autoStart: boolean;
  };
  activeModelId: string;
  models: ModelConfig[];
  presets: Preset[];
}
```

### Backend Types (Rust)

```rust
// src-tauri/src/models.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    pub content: String,
    pub meta: Option<MessageMeta>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub model_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub api_base: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub parameters: ModelParameters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub appearance: AppearanceSettings,
    pub general: GeneralSettings,
    pub active_model_id: String,
    pub models: Vec<ModelConfig>,
    pub presets: Vec<Preset>,
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Based on the prework analysis, the following correctness properties have been identified:

### Property 1: User message rendering consistency
*For any* user message object, rendering it through MessageItem SHALL produce a component with user avatar styling and blue background CSS classes.
**Validates: Requirements 3.1**

### Property 2: Assistant message rendering consistency
*For any* assistant message object, rendering it through MessageItem SHALL produce a component with AI avatar, model name label, and white background styling.
**Validates: Requirements 3.2**

### Property 3: Markdown content transformation
*For any* message content containing valid Markdown syntax, the rendered output SHALL contain the corresponding HTML elements with prose typography classes.
**Validates: Requirements 3.3**

### Property 4: Code block detection and rendering
*For any* message content containing fenced code blocks, the rendered output SHALL include syntax-highlighted code elements with a copy button.
**Validates: Requirements 3.4**

### Property 5: Textarea auto-expansion
*For any* input text, the textarea height SHALL increase proportionally to the content line count, up to the defined maximum height.
**Validates: Requirements 4.1**

### Property 6: Whitespace input validation
*For any* input string consisting entirely of whitespace characters (spaces, tabs, newlines), the send button SHALL be disabled.
**Validates: Requirements 4.6**

### Property 7: Message store update consistency
*For any* valid message sent by the user, the conversation store SHALL contain that message after the send action completes.
**Validates: Requirements 5.3**

### Property 8: Streaming token concatenation
*For any* sequence of streaming tokens received, the streamingMessage state SHALL equal the concatenation of all received tokens in order.
**Validates: Requirements 5.4**

### Property 9: Model switching state update
*For any* valid model ID, switching to that model SHALL update the activeModelId in the config store to match.
**Validates: Requirements 5.5**

### Property 10: SSE token extraction
*For any* valid SSE response data containing content tokens, the parser SHALL extract and emit each token correctly.
**Validates: Requirements 6.4**

### Property 11: Conversation persistence round-trip
*For any* conversation created, retrieving conversations SHALL include that conversation with matching ID and title.
**Validates: Requirements 7.1**

### Property 12: Message persistence round-trip
*For any* message added to a conversation, retrieving messages for that conversation SHALL include that message with matching content.
**Validates: Requirements 7.2**

### Property 13: Conversation list ordering
*For any* set of conversations with different update times, the returned list SHALL be sorted by update time in descending order.
**Validates: Requirements 7.3**

### Property 14: Conversation deletion completeness
*For any* deleted conversation, subsequent retrieval attempts SHALL not return that conversation or its messages.
**Validates: Requirements 7.4**

### Property 15: Conversation title update persistence
*For any* conversation title update, retrieving that conversation SHALL return the updated title.
**Validates: Requirements 7.5**

### Property 16: Message pagination correctness
*For any* set of messages and pagination parameters (limit, before_id), the returned subset SHALL contain at most 'limit' messages, all with IDs less than 'before_id' when specified.
**Validates: Requirements 7.6**

### Property 17: Model config persistence round-trip
*For any* model configuration saved, loading the configuration SHALL return a model config with identical values.
**Validates: Requirements 8.3**

### Property 18: Preset persistence round-trip
*For any* preset created, loading presets SHALL include that preset with matching model_config_id and system_prompt.
**Validates: Requirements 8.4**

### Property 19: Active model persistence
*For any* active model ID set, loading configuration SHALL return that same active model ID.
**Validates: Requirements 8.5**

### Property 20: Configuration serialization round-trip
*For any* valid AppConfig object, serializing to JSON and deserializing back SHALL produce an equivalent AppConfig object.
**Validates: Requirements 8.6**

### Property 21: Get messages pagination
*For any* conversation with messages, calling get_messages with pagination parameters SHALL return the correct subset of messages.
**Validates: Requirements 10.4**

### Property 22: Save config round-trip
*For any* valid AppConfig, calling save_app_config followed by get_app_config SHALL return an equivalent configuration.
**Validates: Requirements 10.7**

## Error Handling

### Frontend Error Handling

```typescript
// Error types
interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

// Error handling in stores
const handleError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
};

// Toast notifications for user feedback
const showError = (message: string) => {
  // Display error toast
};
```

### Backend Error Handling

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("AI client error: {0}")]
    AiClient(#[from] AiError),
    
    #[error("Storage error: {0}")]
    Storage(#[from] StorageError),
    
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
```

## Testing Strategy

### Unit Testing

- **Frontend**: Use Vitest for React component testing
- **Backend**: Use Rust's built-in test framework with `#[cfg(test)]`

### Property-Based Testing

- **Frontend**: Use fast-check for TypeScript property tests
- **Backend**: Use proptest for Rust property tests

Each property-based test MUST:
1. Run a minimum of 100 iterations
2. Be tagged with a comment referencing the correctness property: `**Feature: chat-ui-mvp, Property {number}: {property_text}**`
3. Use smart generators that constrain to valid input spaces

### Test File Organization

```
src/
├── components/
│   └── Chat/
│       ├── MessageItem.tsx
│       └── MessageItem.test.tsx
├── stores/
│   ├── conversationStore.ts
│   └── conversationStore.test.ts
└── ...

src-tauri/src/
├── storage/
│   ├── mod.rs
│   └── tests.rs
├── config/
│   ├── mod.rs
│   └── tests.rs
└── ...
```
