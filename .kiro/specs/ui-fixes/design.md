# UI 修复设计文档

## 1. 架构概述

本设计文档涵盖两个独立的 UI 修复：
1. Header 组件智能体选择器下拉菜单定位修复
2. InputArea 组件思考按钮多级别支持

这两个修复相互独立，可以分别实现和测试。

## 2. 智能体选择器下拉菜单修复

### 2.1 问题分析

当前问题：
- 下拉菜单使用 `absolute right-0 mt-2` 定位
- 父容器可能有 `overflow: hidden` 导致菜单被裁剪
- z-index 可能不够高，被其他元素遮挡

### 2.2 解决方案

**方案 1：调整父容器样式（推荐）**
- 检查并移除父容器的 `overflow: hidden`
- 确保 z-index 足够高（当前是 z-50）
- 添加 `overflow-visible` 到必要的父元素

**方案 2：使用 React Portal**
- 将下拉菜单渲染到 document.body
- 使用绝对定位计算菜单位置
- 更复杂但更可靠

**选择方案 1**，因为：
- 更简单，代码改动最小
- 性能更好
- 符合现有代码风格

### 2.3 实现细节

修改 `Header.tsx` 中的智能体选择器部分：

```typescript
{/* Agent Selector - only show when showSelectors is true */}
{showSelectors && (
  <div className="relative" ref={agentDropdownRef}>
    <button
      onClick={() => setIsAgentDropdownOpen(!isAgentDropdownOpen)}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
    >
      {/* ... 按钮内容 ... */}
    </button>

    {isAgentDropdownOpen && (
      <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-[100] max-h-80 overflow-auto">
        {/* 增加 z-index 到 z-[100] */}
        {/* 添加 max-h-80 overflow-auto 支持滚动 */}
        {/* ... 菜单内容 ... */}
      </div>
    )}
  </div>
)}
```

同时检查 Header 组件的父容器，确保没有 `overflow: hidden`。

## 3. 思考按钮多级别支持

### 3.1 类型定义

首先需要在 `types/index.ts` 中添加思考级别类型：

```typescript
/**
 * Thinking level for OpenAI Response API
 * - null: No thinking (disabled)
 * - 'low': Low reasoning effort
 * - 'medium': Medium reasoning effort
 * - 'high': High reasoning effort
 * - 'very_high': Very high reasoning effort
 */
export type ThinkingLevel = null | 'low' | 'medium' | 'high' | 'very_high';

/**
 * Thinking mode for different API protocols
 * - boolean: For chat_completions API (on/off)
 * - ThinkingLevel: For responses API (multi-level)
 */
export type ThinkingMode = boolean | ThinkingLevel;
```

### 3.2 检测 API 协议类型

需要从当前选择的模型中获取 API 协议类型。有两种方式：

**方案 1：通过 Provider 类型推断**
- `openai_responses` → responses API
- 其他 → chat_completions API

**方案 2：在 Model 中添加 apiProtocol 字段**
- 更明确，但需要修改类型定义和配置

**选择方案 1**，因为：
- 不需要修改现有类型
- Provider 类型已经包含了这个信息
- 更简单直接

### 3.3 组件设计

创建新的 `ThinkingSelector` 组件：

```typescript
interface ThinkingSelectorProps {
  apiProtocol: ApiProtocolType;
  value: ThinkingMode;
  onChange: (value: ThinkingMode) => void;
  disabled?: boolean;
}

const ThinkingSelector: React.FC<ThinkingSelectorProps> = ({
  apiProtocol,
  value,
  onChange,
  disabled = false,
}) => {
  if (apiProtocol === 'chat_completions') {
    // 二元开关模式
    return (
      <FeatureToggle
        icon={<Brain size={12} />}
        label="思考"
        enabled={value as boolean}
        onToggle={() => onChange(!(value as boolean))}
        disabled={disabled}
        activeColor="purple"
      />
    );
  }

  // responses API - 多级别模式
  const levels: { value: ThinkingLevel; label: string }[] = [
    { value: null, label: '无' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'very_high', label: '超高' },
  ];

  const currentLevel = value as ThinkingLevel;
  const currentLabel = levels.find(l => l.value === currentLevel)?.label || '无';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
          currentLevel
            ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-900/40 dark:text-purple-400 dark:border-purple-700'
            : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700'
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <Brain size={12} />
        <span>思考: {currentLabel}</span>
        <ChevronDown size={10} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-32 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
          {levels.map((level) => (
            <button
              key={level.value || 'none'}
              onClick={() => {
                onChange(level.value);
                setIsOpen(false);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <span className="text-xs text-gray-800 dark:text-white">
                {level.label}
              </span>
              {level.value === currentLevel && (
                <Check size={12} className="text-purple-500 flex-shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
```

### 3.4 InputArea 组件修改

修改 `InputArea.tsx`：

1. **更新 Props 类型**：
```typescript
interface InputAreaProps {
  onSend: (content: string, thinking?: ThinkingMode, images?: ContentPart[]) => void;
  // ... 其他 props
  apiProtocol?: ApiProtocolType;  // 新增：API 协议类型
}
```

2. **更新状态**：
```typescript
const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(
  apiProtocol === 'responses' ? 'medium' : true
);
```

3. **使用新组件**：
```typescript
{supportsThinking && (
  <ThinkingSelector
    apiProtocol={apiProtocol || 'chat_completions'}
    value={thinkingMode}
    onChange={setThinkingMode}
    disabled={isGenerating}
  />
)}
```

4. **发送消息时传递正确的值**：
```typescript
onSend(trimmedContent, supportsThinking ? thinkingMode : undefined, contentParts);
```

### 3.5 获取 API 协议类型

需要在父组件中获取当前模型的 API 协议类型并传递给 InputArea：

```typescript
// 在 ChatView 或类似组件中
const getApiProtocol = (modelRef: string, providers: Provider[]): ApiProtocolType => {
  const [providerName] = modelRef.split('/');
  const provider = providers.find(p => p.name === providerName);
  
  if (provider?.type === 'openai_responses') {
    return 'responses';
  }
  
  return 'chat_completions';
};

// 传递给 InputArea
<InputArea
  // ... 其他 props
  apiProtocol={getApiProtocol(currentModelRef, providers)}
/>
```

## 4. 数据流

### 4.1 智能体选择器
```
用户点击按钮 → 切换 isAgentDropdownOpen 状态 → 显示/隐藏下拉菜单
用户点击菜单项 → 调用 onAgentSelect → 关闭菜单
用户点击外部 → 关闭菜单
```

### 4.2 思考按钮
```
父组件获取 API 协议类型 → 传递给 InputArea
InputArea 根据协议类型渲染对应的选择器
用户选择思考级别 → 更新 thinkingMode 状态
用户发送消息 → 将 thinkingMode 传递给 onSend 回调
```

## 5. 错误处理

### 5.1 智能体选择器
- 如果没有智能体，显示"暂无配置的智能体"
- 如果当前智能体不在列表中，使用第一个智能体作为默认值

### 5.2 思考按钮
- 如果无法确定 API 协议类型，默认使用 chat_completions
- 如果 thinkingMode 值无效，使用默认值（chat_completions: true, responses: 'medium'）

## 6. 性能考虑

### 6.1 智能体选择器
- 使用 useRef 避免不必要的重渲染
- 使用事件委托处理点击外部关闭

### 6.2 思考按钮
- 使用 useMemo 缓存级别选项列表
- 避免在每次渲染时重新计算 API 协议类型

## 7. 可访问性

### 7.1 智能体选择器
- 添加 aria-expanded 属性指示下拉状态
- 添加 aria-haspopup="menu" 属性
- 支持 Escape 键关闭菜单

### 7.2 思考按钮
- 添加 aria-label 描述当前选择
- 支持键盘导航（上下箭头选择级别）
- 添加 role="menu" 和 role="menuitem"

## 8. 测试策略

### 8.1 智能体选择器
- 测试下拉菜单在不同位置的显示
- 测试点击外部关闭功能
- 测试暗色模式下的样式
- 测试多个智能体时的滚动

### 8.2 思考按钮
- 测试不同 API 协议下的渲染
- 测试级别切换逻辑
- 测试发送消息时的参数传递
- 测试禁用状态

## 9. 正确性属性

### 9.1 智能体选择器修复

**属性 1.1：下拉菜单完整可见性**
- **描述**：下拉菜单打开时，所有菜单项都应该完整可见，不被裁剪
- **形式化**：`∀ menu_item ∈ dropdown_menu: isFullyVisible(menu_item) = true`
- **测试方法**：手动测试 - 打开下拉菜单，检查所有项是否完整显示

**属性 1.2：z-index 层级正确性**
- **描述**：下拉菜单应该显示在所有其他 UI 元素之上
- **形式化**：`z_index(dropdown_menu) > z_index(other_elements)`
- **测试方法**：手动测试 - 检查菜单是否被其他元素遮挡

### 9.2 思考按钮多级别支持

**属性 2.1：协议类型检测正确性**
- **描述**：根据 Provider 类型正确识别 API 协议
- **形式化**：`provider.type = 'openai_responses' ⟹ apiProtocol = 'responses'`
- **测试方法**：单元测试 - 验证不同 Provider 类型的协议识别

**属性 2.2：思考模式类型一致性**
- **描述**：chat_completions 使用 boolean，responses 使用 ThinkingLevel
- **形式化**：
  - `apiProtocol = 'chat_completions' ⟹ thinkingMode ∈ {true, false}`
  - `apiProtocol = 'responses' ⟹ thinkingMode ∈ {null, 'low', 'medium', 'high', 'very_high'}`
- **测试方法**：单元测试 - 验证不同协议下的状态类型

**属性 2.3：级别切换完整性**
- **描述**：用户可以选择所有可用的思考级别
- **形式化**：`∀ level ∈ ThinkingLevel: canSelect(level) = true`
- **测试方法**：单元测试 - 验证所有级别都可以被选择

**属性 2.4：消息发送参数正确性**
- **描述**：发送消息时正确传递思考模式参数
- **形式化**：`onSend(content, thinkingMode, ...) ⟹ backend_receives(thinkingMode)`
- **测试方法**：单元测试 - 验证 onSend 回调接收到正确的参数

**属性 2.5：状态持久性**
- **描述**：切换模型时，思考模式应重置为合理的默认值
- **形式化**：
  - `modelChanged ∧ apiProtocol = 'chat_completions' ⟹ thinkingMode = true`
  - `modelChanged ∧ apiProtocol = 'responses' ⟹ thinkingMode = 'medium'`
- **测试方法**：单元测试 - 验证模型切换时的状态重置

## 10. 实现优先级

1. **P0**：修复智能体选择器下拉菜单裁剪（影响基本可用性）
2. **P1**：添加思考级别类型定义
3. **P1**：实现 ThinkingSelector 组件
4. **P1**：集成到 InputArea 组件
5. **P2**：添加单元测试
6. **P2**：优化性能和可访问性
