# Reasoning Effort 参数调研报告

## 调研日期
2026-01-18

## 调研目标
确认各个 AI 模型提供商对 reasoning_effort 参数的支持情况,以决定是否统一使用 effort 模式。

## 调研结果

### 1. OpenAI

#### Chat Completions API (`/v1/chat/completions`)
- **支持**: ✅ 是
- **参数名**: `reasoning_effort`
- **参数值**: `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`
- **适用模型**: GPT-5 系列 (gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-search-api)
- **示例**:
```json
{
  "model": "gpt-5",
  "reasoning_effort": "medium",
  "messages": [...]
}
```

#### Responses API (`/v1/responses`)
- **支持**: ✅ 是
- **参数名**: `reasoning` (对象)
- **参数格式**: `{ "effort": "low" | "medium" | "high" }`
- **适用模型**: GPT-5 系列, o1, o3 系列
- **示例**:
```json
{
  "model": "gpt-5",
  "reasoning": { "effort": "medium" },
  "input": [...]
}
```

### 2. DeepSeek

#### Chat Completions API
- **支持**: ⚠️ 部分支持
- **参数名**: `thinking` (对象)
- **参数格式**: `{ "type": "enabled" | "disabled" }`
- **适用模型**: deepseek-chat, deepseek-reasoner
- **特点**: 
  - 不支持 effort 级别控制
  - 只能开启/关闭思考模式
  - 未来可能支持 `reasoning_effort` 参数(文档提到 "will be available soon")
- **示例**:
```json
{
  "model": "deepseek-chat",
  "thinking": { "type": "enabled" },
  "messages": [...]
}
```

### 3. Anthropic Claude

#### Messages API
- **支持**: ✅ 是 (扩展思考)
- **参数名**: `thinking` (对象)
- **参数格式**: `{ "type": "enabled", "budget_tokens": 1024 }`
- **适用模型**: Claude 3.5 Sonnet, Claude 3 Opus
- **特点**:
  - 使用 token 预算而非 effort 级别
  - 需要指定 budget_tokens (>=1024 且 < max_tokens)
- **示例**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "thinking": {
    "type": "enabled",
    "budget_tokens": 2048
  },
  "messages": [...]
}
```

### 4. 其他 OpenAI Compatible 提供商

大多数 OpenAI Compatible 提供商(如 SiliconFlow, OpenRouter 等):
- **支持**: ❌ 不支持
- **原因**: 这些提供商通常只实现基础的 Chat Completions API,不支持高级推理功能

## 结论

### 统一性分析

**不同点**:
1. **参数名称不统一**:
   - OpenAI Chat Completions: `reasoning_effort` (字符串)
   - OpenAI Responses: `reasoning.effort` (对象)
   - DeepSeek: `thinking.type` (对象,只有 enabled/disabled)
   - Anthropic: `thinking` (对象,使用 budget_tokens)

2. **参数格式不统一**:
   - OpenAI: 直接字符串或对象中的 effort 字段
   - DeepSeek: 对象中的 type 字段
   - Anthropic: 对象中的 budget_tokens 字段

3. **支持的级别不统一**:
   - OpenAI: none, minimal, low, medium, high
   - DeepSeek: enabled/disabled (二元)
   - Anthropic: token 预算数值

### 建议方案

#### 方案 A: 保持现状 (推荐)
**理由**:
- 各家 API 差异太大,难以统一
- 当前的实现已经能够满足需求
- 避免引入复杂的适配层

**实现**:
- OpenAI Chat Completions: 继续使用 `thinking_level` 映射到 `reasoning_effort`
- OpenAI Responses: 继续使用 `thinking_level` 映射到 `reasoning.effort`
- DeepSeek: 继续使用 `thinking_level` 映射到 `thinking.type` (enabled/disabled)
- Anthropic: 继续使用 `thinking_level` 映射到 `thinking.budget_tokens`

#### 方案 B: 添加高级选项 (可选)
如果需要更精细的控制,可以在模型配置中添加高级选项:

**前端类型定义**:
```typescript
interface Model {
  // ... 现有字段
  
  // 高级推理选项
  advancedReasoning?: {
    enabled: boolean;           // 是否启用高级推理控制
    mode: 'effort' | 'budget';  // 控制模式
    // effort 模式 (OpenAI, DeepSeek)
    effortLevel?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    // budget 模式 (Anthropic)
    budgetTokens?: number;
  };
}
```

**UI 实现**:
- 在模型配置的高级设置中添加"高级推理"开关
- 开启后,在聊天界面显示推理控制选项
- 根据模型类型显示不同的控制方式

## 实施建议

### 短期 (当前版本)
✅ **保持现状**,不做大的改动:
- 当前的 `thinking_level` 映射机制已经能够满足需求
- 各家 API 差异太大,统一成本高

### 中期 (下一个版本)
🔄 **优化映射逻辑**:
- 为 OpenAI Chat Completions API 添加 `reasoning_effort` 支持
- 更新文档,说明各个提供商的推理参数映射关系

### 长期 (未来版本)
🚀 **添加高级选项** (如果用户有需求):
- 在模型配置中添加"高级推理"设置
- 支持更精细的推理控制
- 提供预设模板,简化配置

## 参考资料

1. [OpenAI Reasoning Models Guide](https://platform.openai.com/docs/guides/reasoning)
2. [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
3. [Anthropic Extended Thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
4. [OpenRouter Reasoning Tokens](https://docs.onerouter.pro/features/reasoning-tokens)

## 附录: API 对比表

| 提供商 | API 类型 | 参数名 | 参数格式 | 支持级别 |
|--------|---------|--------|---------|---------|
| OpenAI | Chat Completions | `reasoning_effort` | 字符串 | none, minimal, low, medium, high |
| OpenAI | Responses | `reasoning.effort` | 对象 | low, medium, high |
| DeepSeek | Chat Completions | `thinking.type` | 对象 | enabled, disabled |
| Anthropic | Messages | `thinking` | 对象 | budget_tokens (数值) |
| Others | Chat Completions | - | - | 不支持 |
