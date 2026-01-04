# Requirements Document

## Introduction

本文档定义 TauriAI MVP 版本的聊天界面实现需求。TauriAI 是一个系统级 AI 助手桌面应用，需要实现完整的聊天界面、多模型支持、对话历史管理和系统托盘功能。当前项目处于 Tauri 初始模板状态，需要从零构建完整的 UI 和后端功能。

## Glossary

- **TauriAI**: 本项目的系统名称，一个基于 Tauri v2 的桌面 AI 助手应用
- **Provider**: AI 服务提供商（如 OpenAI、Anthropic、Ollama）
- **ModelConfig**: 模型配置对象，包含 API 密钥、端点、参数等
- **Conversation**: 对话会话，包含多条消息
- **Message**: 单条消息，包含角色（user/assistant/system）和内容
- **Preset**: 预设配置，包含模型配置和系统提示词的组合
- **SSE**: Server-Sent Events，用于流式传输 AI 响应
- **Zustand**: 轻量级 React 状态管理库

## Requirements

### Requirement 1: 项目基础设施搭建

**User Story:** As a developer, I want to set up the project infrastructure with proper dependencies and configuration, so that I can build the chat UI efficiently.

#### Acceptance Criteria

1. WHEN the project is initialized THEN TauriAI SHALL have Tailwind CSS configured with typography plugin for Markdown styling
2. WHEN the project is initialized THEN TauriAI SHALL have Zustand installed for state management
3. WHEN the project is initialized THEN TauriAI SHALL have react-markdown and react-syntax-highlighter installed for message rendering
4. WHEN the project is initialized THEN TauriAI SHALL have lucide-react installed for consistent iconography
5. WHEN the project is initialized THEN TauriAI SHALL have the Rust backend configured with reqwest, tokio, rusqlite, and uuid dependencies

### Requirement 2: 主窗口布局实现

**User Story:** As a user, I want a clean and intuitive main window layout, so that I can easily navigate and use the chat interface.

#### Acceptance Criteria

1. WHEN the main window loads THEN TauriAI SHALL display a sidebar with navigation icons (chat, history, settings)
2. WHEN the main window loads THEN TauriAI SHALL display a header area with the current conversation title and model selector
3. WHEN the main window loads THEN TauriAI SHALL display a chat area for message list with automatic scrolling
4. WHEN the main window loads THEN TauriAI SHALL display an input area with auto-expanding textarea and send button
5. WHEN the user drags the header area THEN TauriAI SHALL allow window movement
6. WHEN the system theme changes THEN TauriAI SHALL switch between light and dark mode accordingly

### Requirement 3: 消息渲染组件

**User Story:** As a user, I want messages to be displayed clearly with proper formatting, so that I can read AI responses with code highlighting and Markdown support.

#### Acceptance Criteria

1. WHEN a user message is displayed THEN TauriAI SHALL render it with a distinct user avatar and blue background bubble
2. WHEN an assistant message is displayed THEN TauriAI SHALL render it with an AI avatar, model name label, and white background
3. WHEN a message contains Markdown THEN TauriAI SHALL render it with proper typography using prose styling
4. WHEN a message contains code blocks THEN TauriAI SHALL render them with syntax highlighting and a copy button
5. WHEN the AI is generating a response THEN TauriAI SHALL display a blinking cursor at the end of the streaming text
6. WHEN hovering over a message THEN TauriAI SHALL display action buttons (copy, retry for assistant messages)

### Requirement 4: 输入区域功能

**User Story:** As a user, I want a responsive input area, so that I can compose and send messages efficiently.

#### Acceptance Criteria

1. WHEN the user types in the input field THEN TauriAI SHALL auto-expand the textarea height up to a maximum limit
2. WHEN the user presses Enter (without Shift) THEN TauriAI SHALL send the message
3. WHEN the user presses Shift+Enter THEN TauriAI SHALL insert a newline without sending
4. WHEN the user clicks the send button THEN TauriAI SHALL send the message
5. WHEN a message is being generated THEN TauriAI SHALL disable the send button and show a loading indicator
6. WHEN the input is empty or whitespace-only THEN TauriAI SHALL disable the send button

### Requirement 5: 状态管理实现

**User Story:** As a developer, I want centralized state management, so that the application state is predictable and maintainable.

#### Acceptance Criteria

1. WHEN the application loads THEN TauriAI SHALL initialize useConfigStore with configuration from the backend
2. WHEN the application loads THEN TauriAI SHALL initialize useConversationStore with the current conversation state
3. WHEN the user sends a message THEN TauriAI SHALL update the conversation store with the new message
4. WHEN streaming tokens arrive THEN TauriAI SHALL update the streamingMessage state in real-time
5. WHEN the user switches models THEN TauriAI SHALL update the activeModelId in the config store
6. WHEN configuration changes THEN TauriAI SHALL persist changes to the backend

### Requirement 6: Rust 后端 AI 客户端

**User Story:** As a user, I want to connect to multiple AI providers, so that I can use my preferred AI model.

#### Acceptance Criteria

1. WHEN a chat request is made with OpenAI provider THEN TauriAI SHALL call the OpenAI API with proper authentication
2. WHEN a chat request is made with Anthropic provider THEN TauriAI SHALL call the Anthropic API with proper authentication
3. WHEN a chat request is made with Ollama provider THEN TauriAI SHALL call the local Ollama REST API
4. WHEN streaming is enabled THEN TauriAI SHALL process SSE responses and emit tokens via Tauri events
5. WHEN an API call fails THEN TauriAI SHALL return a descriptive error message to the frontend
6. WHEN testing a connection THEN TauriAI SHALL send a minimal test request and report success or failure

### Requirement 7: 对话存储功能

**User Story:** As a user, I want my conversations to be saved locally, so that I can access my chat history later.

#### Acceptance Criteria

1. WHEN a new conversation is created THEN TauriAI SHALL persist it to the SQLite database with a unique ID
2. WHEN a message is sent or received THEN TauriAI SHALL append it to the conversation in the database
3. WHEN the user requests conversation history THEN TauriAI SHALL return conversations sorted by update time descending
4. WHEN the user deletes a conversation THEN TauriAI SHALL remove it and all associated messages from the database
5. WHEN the user updates a conversation title THEN TauriAI SHALL persist the change to the database
6. WHEN loading messages THEN TauriAI SHALL support pagination with limit and before_id parameters

### Requirement 8: 配置管理功能

**User Story:** As a user, I want to manage my AI model configurations, so that I can customize my chat experience.

#### Acceptance Criteria

1. WHEN the application starts THEN TauriAI SHALL load configuration from ~/.tauri-ai/config.json
2. WHEN configuration does not exist THEN TauriAI SHALL create a default configuration file
3. WHEN the user saves a model configuration THEN TauriAI SHALL persist it to the config file
4. WHEN the user creates a preset THEN TauriAI SHALL save the model config ID and system prompt combination
5. WHEN the user switches the active model THEN TauriAI SHALL update the activeModelId in configuration
6. WHEN serializing configuration THEN TauriAI SHALL produce valid JSON that can be deserialized back to the same structure

### Requirement 9: 系统托盘功能

**User Story:** As a user, I want the application to run in the system tray, so that I can quickly access it without keeping a window open.

#### Acceptance Criteria

1. WHEN the application starts THEN TauriAI SHALL display an icon in the system tray
2. WHEN the user clicks the tray icon THEN TauriAI SHALL toggle the main window visibility
3. WHEN the user right-clicks the tray icon THEN TauriAI SHALL display a context menu with "Show Window" and "Quit" options
4. WHEN the user clicks the window close button THEN TauriAI SHALL hide the window instead of quitting
5. WHEN the user selects "Quit" from the tray menu THEN TauriAI SHALL save state and exit the application

### Requirement 10: Tauri Commands 实现

**User Story:** As a developer, I want well-defined Tauri commands, so that the frontend can communicate with the backend reliably.

#### Acceptance Criteria

1. WHEN the frontend calls chat_stream THEN TauriAI SHALL initiate a streaming chat request and emit token events
2. WHEN the frontend calls abort_chat THEN TauriAI SHALL cancel the ongoing generation for the specified conversation
3. WHEN the frontend calls get_conversations THEN TauriAI SHALL return the list of conversations
4. WHEN the frontend calls get_messages THEN TauriAI SHALL return messages for the specified conversation with pagination
5. WHEN the frontend calls create_conversation THEN TauriAI SHALL create and return a new conversation
6. WHEN the frontend calls get_app_config THEN TauriAI SHALL return the current application configuration
7. WHEN the frontend calls save_app_config THEN TauriAI SHALL persist the provided configuration
8. WHEN the frontend calls test_connection THEN TauriAI SHALL test the model configuration and return the result
