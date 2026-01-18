# 需求文档：聊天布局溢出修复

## 简介

本功能旨在修复 TauriAI 应用中聊天界面的布局溢出问题。当智能体输出长文本块（特别是代码块）时，会导致布局混乱、UI 元素被挤压，以及用户体验问题。

## 术语表

- **ChatView**: 聊天视图组件，显示对话消息列表
- **CodeBlock**: 代码块组件，用于渲染和显示代码内容
- **MessageItem**: 单条消息项组件
- **Sidebar**: 侧边栏组件，提供导航和功能入口
- **MainLayout**: 主布局组件，管理整体页面结构
- **溢出（Overflow）**: 内容超出容器边界导致布局错乱的现象

## 需求

### 需求 1：防止长文本块破坏布局

**用户故事：** 作为用户，我希望当智能体输出长文本或代码块时，不会破坏整体页面布局，以便我能正常使用其他 UI 功能。

#### 验收标准

1. WHEN 智能体输出长代码块 THEN THE ChatView SHALL 保持在其容器边界内而不挤占其他顶层 UI 元素
2. WHEN 代码块宽度超过容器宽度 THEN THE CodeBlock SHALL 显示横向滚动条而不是溢出容器
3. WHEN 消息内容过长 THEN THE MessageItem SHALL 在其容器内正确处理溢出而不影响父容器
4. THE Sidebar SHALL 保持固定宽度（展开时 192px，收起时 64px）而不被右侧内容挤压
5. THE MainLayout SHALL 正确处理内容溢出，确保主内容区域不会破坏整体布局

### 需求 2：提供代码复制功能

**用户故事：** 作为用户，我希望能够方便地复制代码块内容，以便在其他地方使用这些代码。

#### 验收标准

1. WHEN 代码块显示时 THEN THE CodeBlock SHALL 显示一个复制按钮
2. WHEN 用户点击复制按钮 THEN THE System SHALL 将代码内容复制到剪贴板
3. WHEN 复制成功后 THEN THE System SHALL 显示"已复制"状态反馈
4. WHEN 显示"已复制"状态 2 秒后 THEN THE System SHALL 自动恢复为"复制"状态
5. THE 复制按钮 SHALL 显示清晰的文字标签和图标

### 需求 3：提供显眼的滚动条

**用户故事：** 作为用户，我希望当代码块可以横向滚动时，能够清楚地看到滚动条，以便我知道可以查看更多内容。

#### 验收标准

1. WHEN 代码块内容超出容器宽度 THEN THE System SHALL 显示自定义样式的滚动条
2. THE 滚动条 SHALL 使用蓝色高亮颜色（#60a5fa）以提高可见性
3. THE 滚动条 SHALL 具有 12px 的高度，比默认滚动条更粗
4. WHEN 用户悬停在滚动条上 THEN THE System SHALL 显示 hover 效果
5. THE 滚动条样式 SHALL 支持暗色模式
