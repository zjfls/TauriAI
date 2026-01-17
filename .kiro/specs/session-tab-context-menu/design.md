# 设计文档：Session Tab 右键菜单

## 概述

本设计为 TauriAI 应用的 SessionTabBar 组件添加右键上下文菜单功能。该功能允许用户通过右键点击 session tab 来执行批量标签页管理操作，包括关闭其他、左侧、右侧或当前标签页。

设计采用 React 组件模式，使用 React hooks 管理菜单状态，并与现有的 Zustand SessionStore 集成以执行标签页操作。

## 架构

### 组件层次结构

```
SessionTabBar (现有组件)
├── Session Tab (多个)
│   └── ContextMenu (新增)
│       └── MenuItem (多个)
```

### 状态管理

- **本地状态**: 使用 React useState 管理菜单的显示/隐藏状态和位置
- **全局状态**: 使用现有的 SessionStore (Zustand) 管理 session 的创建、关闭和切换

### 事件流

1. 用户在 Session Tab 上右键点击
2. 阻止浏览器默认右键菜单
3. 计算并显示自定义 Context Menu
4. 用户点击菜单项
5. 执行对应的 SessionStore 操作
6. 关闭菜单

## 组件和接口

### ContextMenu 组件

新建的独立组件，负责渲染和管理右键菜单。

```typescript
interface ContextMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  targetSessionId: string;
  targetSessionIndex: number;
  totalSessions: number;
  onClose: () => void;
}

interface MenuItem {
  label: string;
  action: () => void;
  disabled: boolean;
  divider?: boolean;
}
```

### SessionTabBar 修改

在现有的 SessionTabBar 组件中添加：

```typescript
// 新增状态
const [contextMenu, setContextMenu] = useState<{
  visible: boolean;
  position: { x: number; y: number };
  targetSessionId: string;
  targetSessionIndex: number;
} | null>(null);

// 新增事件处理器
const handleContextMenu = (
  e: React.MouseEvent,
  sessionId: string,
  index: number
) => {
  e.preventDefault();
  setContextMenu({
    visible: true,
    position: { x: e.clientX, y: e.clientY },
    targetSessionId: sessionId,
    targetSessionIndex: index
  });
};

const handleCloseContextMenu = () => {
  setContextMenu(null);
};
```

### SessionStore 扩展

在现有的 SessionStore 中添加批量操作方法：

```typescript
interface SessionStore {
  // 现有方法
  sessions: Map<string, AgentSession>;
  activeSessionId: string | null;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  
  // 新增方法
  closeOtherSessions: (keepSessionId: string) => void;
  closeSessionsToLeft: (sessionId: string) => void;
  closeSessionsToRight: (sessionId: string) => void;
}
```

## 数据模型

### ContextMenuState

```typescript
interface ContextMenuState {
  visible: boolean;
  position: {
    x: number;  // 鼠标点击的 X 坐标
    y: number;  // 鼠标点击的 Y 坐标
  };
  targetSessionId: string;      // 被右键点击的 session ID
  targetSessionIndex: number;   // 被右键点击的 session 在列表中的索引
}
```

### MenuItemConfig

```typescript
interface MenuItemConfig {
  label: string;           // 菜单项显示文本
  action: () => void;      // 点击时执行的操作
  disabled: boolean;       // 是否禁用
  divider?: boolean;       // 是否在此项后显示分隔线
}
```

## 正确性属性


属性是一种特征或行为，应该在系统的所有有效执行中保持为真——本质上是关于系统应该做什么的形式化陈述。属性作为人类可读规范和机器可验证正确性保证之间的桥梁。

### 属性 1: 右键点击显示菜单

*对于任何* session tab，当用户执行右键点击时，上下文菜单应该显示在点击位置附近，并且菜单的 visible 状态应该为 true。

**验证需求: 1.1**

### 属性 2: 点击外部关闭菜单

*对于任何* 打开的上下文菜单，当用户点击菜单边界外的任何区域时，菜单应该关闭（visible 状态变为 false）。

**验证需求: 1.2**

### 属性 3: Escape 键关闭菜单

*对于任何* 打开的上下文菜单，当用户按下 Escape 键时，菜单应该关闭（visible 状态变为 false）。

**验证需求: 1.3**

### 属性 4: 关闭其他标签页保留目标

*对于任何* 包含多个 session 的 session 列表和任何目标 session，执行"关闭其他"操作后，session 列表应该只包含目标 session，并且目标 session 应该成为活动 session。

**验证需求: 2.1, 2.2**

### 属性 5: 关闭左侧标签页

*对于任何* session 列表和任何目标 session 索引，执行"关闭左侧"操作后，所有索引小于目标索引的 session 应该被移除，目标 session 及其右侧的 session 应该保留。

**验证需求: 3.1**

### 属性 6: 关闭右侧标签页

*对于任何* session 列表和任何目标 session 索引，执行"关闭右侧"操作后，所有索引大于目标索引的 session 应该被移除，目标 session 及其左侧的 session 应该保留。

**验证需求: 4.1**

### 属性 7: 非活动目标关闭时保持活动 session

*对于任何* session 列表，当执行关闭左侧或关闭右侧操作时，如果目标 session 不是活动 session，则活动 session 应该保持不变（前提是活动 session 不在被关闭的范围内）。

**验证需求: 3.3, 4.3**

### 属性 8: 关闭当前标签页移除目标

*对于任何* session 列表和任何目标 session，执行"关闭当前"操作后，目标 session 应该从列表中移除。

**验证需求: 5.1**

### 属性 9: 关闭活动标签页自动切换

*对于任何* 包含多个 session 的列表，当关闭当前活动的 session 时，系统应该自动将相邻的 session 设置为新的活动 session。

**验证需求: 5.2**

### 属性 10: 菜单项点击执行操作并关闭

*对于任何* 启用的菜单项，当用户点击该菜单项时，对应的操作应该被执行，并且菜单应该立即关闭。

**验证需求: 7.1, 7.2**

### 属性 11: 禁用菜单项不响应点击

*对于任何* 禁用的菜单项，当用户点击该菜单项时，不应该执行任何操作，并且菜单应该保持打开状态。

**验证需求: 7.3**

## 错误处理

### 边界条件

1. **单个 session**: 当只有一个 session 时
   - "关闭其他标签页"应该禁用
   - "关闭左侧标签页"应该禁用
   - "关闭右侧标签页"应该禁用
   - "关闭当前标签页"应该保持启用

2. **最左侧 session**: 当目标是第一个 session 时
   - "关闭左侧标签页"应该禁用

3. **最右侧 session**: 当目标是最后一个 session 时
   - "关闭右侧标签页"应该禁用

4. **关闭最后一个 session**: 当关闭最后剩余的 session 时
   - 应该创建一个新的默认 session（依赖现有的 SessionStore 行为）

### 菜单位置处理

1. **屏幕边界检测**: 如果菜单在鼠标位置显示会超出屏幕边界
   - 调整菜单位置使其完全可见
   - 优先向左或向上调整

2. **滚动容器**: 如果 SessionTabBar 在可滚动容器中
   - 考虑滚动偏移量计算菜单位置

### 状态一致性

1. **并发操作**: 防止在菜单操作执行期间触发其他 session 操作
   - 使用 SessionStore 的事务性操作
   - 在操作完成前禁用其他交互

2. **Session 不存在**: 如果目标 session 在菜单显示期间被其他方式关闭
   - 关闭菜单
   - 不执行任何操作

## 测试策略

### 双重测试方法

本功能将采用单元测试和基于属性的测试相结合的方法：

- **单元测试**: 验证特定示例、边缘情况和错误条件
- **属性测试**: 验证跨所有输入的通用属性

### 单元测试重点

单元测试应该专注于：
- 菜单组件的渲染和样式
- 特定的边缘情况（单个 session、最左/最右 session）
- 菜单位置计算的边界条件
- 与 SessionStore 的集成点

避免编写过多的单元测试 - 基于属性的测试会处理大量输入的覆盖。

### 基于属性的测试配置

- **测试库**: 使用 `fast-check` (JavaScript/TypeScript 的属性测试库)
- **迭代次数**: 每个属性测试最少运行 100 次迭代
- **标签格式**: 每个测试必须包含注释引用设计文档中的属性
  - 格式: `// Feature: session-tab-context-menu, Property {number}: {property_text}`

### 测试覆盖范围

1. **菜单显示和关闭** (属性 1-3)
   - 生成随机的鼠标事件和键盘事件
   - 验证菜单状态转换

2. **批量关闭操作** (属性 4-6)
   - 生成随机的 session 列表（不同长度和配置）
   - 生成随机的目标索引
   - 验证操作后的 session 列表状态

3. **活动 session 管理** (属性 7, 9)
   - 生成随机的活动 session 配置
   - 验证关闭操作后的活动 session 状态

4. **菜单交互** (属性 10-11)
   - 生成随机的菜单项配置（启用/禁用）
   - 验证点击行为和操作执行

### 测试数据生成

使用 `fast-check` 的 arbitrary 生成器：

```typescript
// Session 列表生成器
const sessionListArbitrary = fc.array(
  fc.record({
    id: fc.uuid(),
    title: fc.string(),
    // ... 其他 session 属性
  }),
  { minLength: 1, maxLength: 20 }
);

// 目标索引生成器（基于列表长度）
const targetIndexArbitrary = (sessions: any[]) =>
  fc.integer({ min: 0, max: sessions.length - 1 });

// 菜单位置生成器
const positionArbitrary = fc.record({
  x: fc.integer({ min: 0, max: 1920 }),
  y: fc.integer({ min: 0, max: 1080 })
});
```

### 集成测试

除了单元测试和属性测试外，还应该包括：
- 使用 React Testing Library 的组件集成测试
- 验证 SessionTabBar 和 ContextMenu 的完整交互流程
- 测试与真实 SessionStore 的集成

### 测试执行

- 所有测试应该在 CI/CD 管道中自动运行
- 属性测试失败时应该显示导致失败的具体输入（fast-check 会自动缩小失败案例）
- 测试覆盖率目标：核心逻辑 > 90%
