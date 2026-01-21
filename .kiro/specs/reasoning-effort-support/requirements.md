# 需求文档

## 简介

本规范定义了为 OpenAI Chat Completions API 添加 `reasoning_effort` 参数支持的功能需求。当前系统已支持 OpenAI Responses API 的 `reasoning.effort` 参数和多级思考等级选择,但 Chat Completions API 仅支持简单的 thinking 开关(boolean)。根据 OpenAI 官方文档,Chat Completions API 也支持 `reasoning_effort` 参数,本规范旨在为该 API 添加完整的多级推理控制支持。

## 术语表

- **System**: TauriAI 应用程序
- **Chat_Completions_API**: OpenAI 的 `/v1/chat/completions` 端点
- **Responses_API**: OpenAI 的 `/v1/responses` 端点
- **Model_Config**: 模型配置对象,包含模型参数和能力设置
- **ThinkingSelector**: 前端组件,用于选择思考级别
- **Provider**: AI 服务提供商(如 OpenAI, DeepSeek 等)
- **Reasoning_Effort**: 推理努力程度参数,控制模型的思考深度
- **API_Protocol**: API 协议类型(chat_completions 或 responses)

## 需求

### 需求 1: 模型配置高级选项

**用户故事**: 作为系统管理员,我希望在模型配置中启用 Reasoning Effort 支持,以便为支持该功能的模型提供多级推理控制。

#### 验收标准

1. WHEN 用户访问模型配置的高级设置 THEN THE System SHALL 显示"使用 Reasoning Effort"开关选项
2. WHERE 提供商类型为 `openai` 或 `openai_compatible` THEN THE System SHALL 显示"使用 Reasoning Effort"选项
3. WHERE 提供商类型为 `openai_responses`, `anthropic` 或 `ollama` THEN THE System SHALL 隐藏"使用 Reasoning Effort"选项
4. WHEN 用户启用"使用 Reasoning Effort"开关 THEN THE System SHALL 将 `useReasoningEffort` 字段设置为 true
5. WHEN 用户禁用"使用 Reasoning Effort"开关 THEN THE System SHALL 将 `useReasoningEffort` 字段设置为 false
6. WHEN 创建新模型配置 THEN THE System SHALL 将 `useReasoningEffort` 默认值设置为 false

### 需求 2: 聊天界面适配

**用户故事**: 作为用户,我希望在聊天界面看到与模型配置匹配的思考控制选项,以便根据模型能力选择合适的推理级别。

#### 验收标准

1. WHEN 模型启用 `useReasoningEffort` 且 API 协议为 `chat_completions` THEN THE ThinkingSelector SHALL 显示多级选择器(无/低/中/高/超高)
2. WHEN 模型未启用 `useReasoningEffort` 且 API 协议为 `chat_completions` THEN THE ThinkingSelector SHALL 显示简单开关(开/关)
3. WHEN API 协议为 `responses` THEN THE ThinkingSelector SHALL 始终显示多级选择器(无/低/中/高/超高)
4. WHEN 用户在多级选择器中选择级别 THEN THE System SHALL 更新思考级别状态
5. WHEN 用户在简单开关中切换状态 THEN THE System SHALL 更新思考开关状态

### 需求 3: 后端参数映射

**用户故事**: 作为系统,我需要正确地将前端的思考级别映射到 API 参数,以确保不同 API 协议都能正确处理推理控制。

#### 验收标准

1. WHEN 模型启用 `useReasoningEffort` 且思考级别为 `null` THEN THE System SHALL 发送 `reasoning_effort: "none"` 参数
2. WHEN 模型启用 `useReasoningEffort` 且思考级别为 `"low"` THEN THE System SHALL 发送 `reasoning_effort: "low"` 参数
3. WHEN 模型启用 `useReasoningEffort` 且思考级别为 `"medium"` THEN THE System SHALL 发送 `reasoning_effort: "medium"` 参数
4. WHEN 模型启用 `useReasoningEffort` 且思考级别为 `"high"` THEN THE System SHALL 发送 `reasoning_effort: "high"` 参数
5. WHEN 模型启用 `useReasoningEffort` 且思考级别为 `"xhigh"` THEN THE System SHALL 发送 `reasoning_effort: "high"` 参数
6. WHEN 模型未启用 `useReasoningEffort` THEN THE System SHALL 使用现有的 `thinking` 参数(enabled/disabled)
7. WHEN 发送 `reasoning_effort` 参数 THEN THE System SHALL 将其作为顶级字符串参数发送

### 需求 4: 类型定义更新

**用户故事**: 作为开发者,我需要更新类型定义以支持新的配置字段,确保类型安全和代码一致性。

#### 验收标准

1. WHEN 定义 Model 接口 THEN THE System SHALL 包含 `useReasoningEffort?: boolean` 字段
2. WHEN 定义 Model 结构体 THEN THE System SHALL 包含 `use_reasoning_effort: Option<bool>` 字段
3. WHEN 序列化 Model 对象 THEN THE System SHALL 使用 camelCase 格式(`useReasoningEffort`)
4. WHEN 反序列化 Model 对象 THEN THE System SHALL 正确解析 `useReasoningEffort` 字段
5. WHEN `useReasoningEffort` 为 None 或 false THEN THE System SHALL 在序列化时跳过该字段

### 需求 5: 向后兼容性

**用户故事**: 作为系统维护者,我需要确保新功能不会破坏现有配置和行为,保持系统稳定性。

#### 验收标准

1. WHEN 加载不包含 `useReasoningEffort` 字段的旧配置 THEN THE System SHALL 将其视为 false
2. WHEN 模型未启用 `useReasoningEffort` THEN THE System SHALL 保持现有的 thinking 参数行为
3. WHEN 使用 Responses API THEN THE System SHALL 继续使用 `reasoning.effort` 对象格式
4. WHEN 使用 Anthropic API THEN THE System SHALL 继续使用 `thinking.budget_tokens` 参数
5. WHEN 使用 DeepSeek API 且未启用 `useReasoningEffort` THEN THE System SHALL 继续使用 `thinking.type` 参数

### 需求 6: API 协议隔离

**用户故事**: 作为系统架构师,我需要确保不同 API 协议的参数格式正确隔离,避免参数冲突和混淆。

#### 验收标准

1. WHEN 使用 Chat Completions API 且启用 `useReasoningEffort` THEN THE System SHALL 发送 `reasoning_effort` 字符串参数
2. WHEN 使用 Chat Completions API 且未启用 `useReasoningEffort` THEN THE System SHALL 发送 `thinking` 对象参数
3. WHEN 使用 Responses API THEN THE System SHALL 发送 `reasoning` 对象参数
4. WHEN 同时存在 `reasoning_effort` 和 `thinking` 参数 THEN THE System SHALL 只发送一个参数
5. WHEN 模型配置改变 THEN THE System SHALL 更新 API 参数格式

### 需求 7: 用户界面反馈

**用户故事**: 作为用户,我希望在界面上清楚地看到当前的推理控制模式,以便了解系统的行为。

#### 验收标准

1. WHEN ThinkingSelector 显示多级选择器 THEN THE System SHALL 显示当前选中的级别(无/低/中/高/超高)
2. WHEN ThinkingSelector 显示简单开关 THEN THE System SHALL 显示当前状态(开/关)
3. WHEN 用户悬停在 ThinkingSelector 上 THEN THE System SHALL 显示工具提示说明当前模式
4. WHEN 思考级别改变 THEN THE System SHALL 立即更新界面显示
5. WHEN 模型不支持推理控制 THEN THE System SHALL 禁用 ThinkingSelector 组件
