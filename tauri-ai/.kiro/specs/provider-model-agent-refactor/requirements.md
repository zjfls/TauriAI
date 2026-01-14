# Requirements Document

## Introduction

重构模型配置系统，将原有的扁平化模型配置改为三层架构：Provider（提供商）→ Model（模型）→ Agent（智能体）。这样可以更好地组织多个 AI 服务提供商及其模型，同时将 System Prompt 等行为配置从模型中分离到智能体层。

## Glossary

- **Provider**: AI 服务提供商，如硅基流动、OpenAI、Anthropic、Ollama 等，负责提供 API 接入点和认证信息
- **Model**: 具体的 AI 模型，如 DeepSeek-V3、Qwen-72B、GPT-4 等，属于某个 Provider，只包含模型参数
- **Agent**: 智能体，定义 AI 的行为和角色，包含 System Prompt 和对话策略，引用某个 Model
- **Model_Registry**: 模型注册表，Provider 提供的可用模型列表

## Requirements

### Requirement 1: Provider 管理

**User Story:** As a user, I want to configure multiple AI service providers, so that I can use different API endpoints and credentials for different services.

#### Acceptance Criteria

1. THE System SHALL support configuring multiple Providers with unique names
2. WHEN a Provider is created, THE System SHALL require name, api_base, and api_key fields
3. THE System SHALL support Provider types: openai_compatible, anthropic, ollama
4. WHEN a Provider type is openai_compatible, THE System SHALL use OpenAI-compatible API format
5. THE System SHALL allow testing Provider connectivity
6. THE System SHALL persist Provider configurations to config file

### Requirement 2: Model 管理

**User Story:** As a user, I want to manage models under each provider, so that I can select specific models for different tasks.

#### Acceptance Criteria

1. WHEN a Model is created, THE System SHALL associate it with exactly one Provider
2. THE Model SHALL contain only model-specific parameters: name, temperature, max_tokens, top_p
3. THE Model SHALL NOT contain system_prompt (moved to Agent)
4. THE System SHALL support querying available models from Provider API
5. WHEN querying models, THE System SHALL call Provider's model list endpoint
6. THE System SHALL allow manual model entry if API query is not supported
7. THE System SHALL use model name as unique identifier within a Provider

### Requirement 3: Agent 管理

**User Story:** As a user, I want to create agents with specific behaviors, so that I can have different AI personalities and capabilities.

#### Acceptance Criteria

1. WHEN an Agent is created, THE System SHALL require name and model reference
2. THE Agent SHALL contain: name, description, system_prompt, model_ref (provider_name/model_name)
3. THE System SHALL support multiple Agents using the same Model
4. THE System SHALL allow setting a default Agent for new conversations
5. WHEN starting a conversation, THE System SHALL use the selected Agent's system_prompt
6. THE System SHALL persist Agent configurations to config file

### Requirement 4: 配置数据结构

**User Story:** As a developer, I want a clear configuration structure, so that the config file is easy to read and maintain.

#### Acceptance Criteria

1. THE config file SHALL organize data as: providers[], agents[], default_agent
2. WHEN serializing config, THE System SHALL use JSON format with camelCase field names
3. THE System SHALL validate config structure on load
4. IF config validation fails, THEN THE System SHALL report specific errors
5. THE System SHALL migrate old config format to new format automatically

### Requirement 5: UI 交互

**User Story:** As a user, I want an intuitive settings interface, so that I can easily manage providers, models, and agents.

#### Acceptance Criteria

1. THE Settings UI SHALL have three tabs: Providers, Models, Agents
2. WHEN on Providers tab, THE System SHALL show provider list with add/edit/delete/test actions
3. WHEN on Models tab, THE System SHALL show models grouped by provider
4. WHEN on Models tab, THE System SHALL provide "Fetch Models" button to query provider API
5. WHEN on Agents tab, THE System SHALL show agent list with add/edit/delete actions
6. THE System SHALL show which agent is currently default
7. WHEN selecting a model for Agent, THE System SHALL show format "provider_name / model_name"

### Requirement 6: Chat 集成

**User Story:** As a user, I want to select an agent when chatting, so that I can use different AI behaviors.

#### Acceptance Criteria

1. WHEN starting a new conversation, THE System SHALL use the default Agent
2. THE Chat UI SHALL allow switching Agent during conversation
3. WHEN sending a message, THE System SHALL resolve Agent → Model → Provider chain
4. THE System SHALL inject Agent's system_prompt into the message context
5. IF Agent's referenced Model or Provider is missing, THEN THE System SHALL show error
