# 思考等级对齐官方标准

## 修改概述

将 OpenAI Responses API 的思考等级选项对齐到官方标准,移除了 `minimal` 选项。

## 修改内容

### 1. 前端类型定义 (`src/types/index.ts`)

**修改前:**
```typescript
export type ThinkingLevel = null | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```

**修改后:**
```typescript
export type ThinkingLevel = null | 'low' | 'medium' | 'high' | 'xhigh';
```

### 2. 前端组件 (`src/components/Chat/ThinkingSelector.tsx`)

**修改前:**
```typescript
const levels: { value: ThinkingLevel; label: string }[] = [
  { value: null, label: '无' },
  { value: 'minimal', label: '最少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
];
```

**修改后:**
```typescript
const levels: { value: ThinkingLevel; label: string }[] = [
  { value: null, label: '无' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
];
```

### 3. 后端 Anthropic 客户端 (`src-tauri/src/ai_client/anthropic.rs`)

移除了对 `minimal` 的特殊处理:

**修改前:**
```rust
let default_budget_tokens = match thinking_level {
    "minimal" => 1024,
    "low" => max_budget_tokens / 4,
    // ...
};
```

**修改后:**
```rust
let default_budget_tokens = match thinking_level {
    "low" => max_budget_tokens / 4,
    // ...
};
```

### 4. 测试文件 (`src/components/Chat/ThinkingSelector.test.tsx`)

更新了测试用例:
- 将预期的选项数量从 6 改为 5
- 移除了对 "最少" 标签的检查

## 官方标准

根据 OpenAI 官方文档,Responses API 支持以下思考等级:

- **Low** (低): 低推理努力
- **Medium** (中): 中等推理努力(默认)
- **High** (高): 高推理努力
- **Extra high** (超高): 超高推理努力(约 95% 的 max_tokens)

另外保留了 `null` 选项用于禁用思考功能。

## 向后兼容性

- 如果用户之前选择了 `minimal` 等级,系统会自动回退到默认值 `medium`
- 后端代码已经使用字符串处理,因此兼容性良好
- 不需要数据迁移

## 测试结果

所有相关测试均已通过:
```
✓ ThinkingSelector (15 tests)
  ✓ Binary Mode (chat_completions) (3)
  ✓ Multi-level Mode (responses) (8)
  ✓ Styling (4)
```

## 修改的文件

1. `TauriAI-thinking-context/tauri-ai/src/types/index.ts`
2. `TauriAI-thinking-context/tauri-ai/src/components/Chat/ThinkingSelector.tsx`
3. `TauriAI-thinking-context/tauri-ai/src-tauri/src/ai_client/anthropic.rs`
4. `TauriAI-thinking-context/tauri-ai/src/components/Chat/ThinkingSelector.test.tsx`

## 日期

2026-01-18
