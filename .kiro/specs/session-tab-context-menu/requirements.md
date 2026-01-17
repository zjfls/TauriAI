# 需求文档

## 简介

为 TauriAI 应用的 SessionTabBar 组件添加右键上下文菜单功能，允许用户通过右键点击 session tab 来执行批量关闭操作，提升多标签页管理的效率。

## 术语表

- **SessionTabBar**: 显示所有打开的 chat session 标签页的组件
- **Session_Tab**: SessionTabBar 中的单个标签页元素，代表一个 chat session
- **Context_Menu**: 右键点击 Session_Tab 时显示的上下文菜单
- **Active_Session**: 当前正在显示的 session
- **Target_Session**: 被右键点击的 session
- **SessionStore**: 使用 Zustand 管理 session 状态的全局存储

## 需求

### 需求 1: 显示右键上下文菜单

**用户故事:** 作为用户，我想要在右键点击 session tab 时看到上下文菜单，以便快速访问标签页管理功能。

#### 验收标准

1. WHEN 用户在 Session_Tab 上执行右键点击操作，THEN THE Context_Menu SHALL 在鼠标位置附近显示
2. WHEN Context_Menu 正在显示时，IF 用户点击菜单外的区域，THEN THE Context_Menu SHALL 关闭
3. WHEN Context_Menu 正在显示时，IF 用户按下 Escape 键，THEN THE Context_Menu SHALL 关闭
4. THE Context_Menu SHALL 包含四个菜单项：关闭其他标签页、关闭左侧标签页、关闭右侧标签页、关闭当前标签页

### 需求 2: 关闭其他标签页

**用户故事:** 作为用户，我想要关闭除当前标签页外的所有其他标签页，以便快速清理工作区。

#### 验收标准

1. WHEN 用户点击"关闭其他标签页"菜单项，THEN THE SessionStore SHALL 关闭除 Target_Session 外的所有 session
2. WHEN 执行关闭其他标签页操作后，THE Target_Session SHALL 成为 Active_Session
3. WHEN 只有一个 Session_Tab 存在时，THE "关闭其他标签页"菜单项 SHALL 处于禁用状态

### 需求 3: 关闭左侧标签页

**用户故事:** 作为用户，我想要关闭当前标签页左侧的所有标签页，以便清理已完成的对话。

#### 验收标准

1. WHEN 用户点击"关闭左侧标签页"菜单项，THEN THE SessionStore SHALL 关闭所有位于 Target_Session 左侧的 session
2. WHEN Target_Session 是最左侧的标签页时，THE "关闭左侧标签页"菜单项 SHALL 处于禁用状态
3. WHEN 关闭左侧标签页后，IF Target_Session 不是 Active_Session，THEN THE Active_Session SHALL 保持不变

### 需求 4: 关闭右侧标签页

**用户故事:** 作为用户，我想要关闭当前标签页右侧的所有标签页，以便保留早期的对话记录。

#### 验收标准

1. WHEN 用户点击"关闭右侧标签页"菜单项，THEN THE SessionStore SHALL 关闭所有位于 Target_Session 右侧的 session
2. WHEN Target_Session 是最右侧的标签页时，THE "关闭右侧标签页"菜单项 SHALL 处于禁用状态
3. WHEN 关闭右侧标签页后，IF Target_Session 不是 Active_Session，THEN THE Active_Session SHALL 保持不变

### 需求 5: 关闭当前标签页

**用户故事:** 作为用户，我想要通过右键菜单关闭当前标签页，以便提供另一种关闭方式。

#### 验收标准

1. WHEN 用户点击"关闭当前标签页"菜单项，THEN THE SessionStore SHALL 关闭 Target_Session
2. WHEN Target_Session 是 Active_Session 且被关闭后，THE SessionStore SHALL 自动切换到相邻的 session
3. WHEN 只有一个 Session_Tab 存在时，THE "关闭当前标签页"菜单项 SHALL 保持启用状态

### 需求 6: 菜单样式与主题一致性

**用户故事:** 作为用户，我想要上下文菜单的样式与应用的 dark mode 主题一致，以便获得统一的视觉体验。

#### 验收标准

1. THE Context_Menu SHALL 使用与应用 dark mode 主题一致的背景色和文字颜色
2. WHEN 鼠标悬停在菜单项上时，THE 菜单项 SHALL 显示高亮效果
3. WHEN 菜单项处于禁用状态时，THE 菜单项 SHALL 显示降低透明度的文字颜色
4. THE Context_Menu SHALL 包含适当的阴影和圆角以符合现代 UI 设计规范

### 需求 7: 菜单交互响应

**用户故事:** 作为用户，我想要点击菜单项后立即执行操作并关闭菜单，以便获得流畅的交互体验。

#### 验收标准

1. WHEN 用户点击任何启用的菜单项，THEN THE Context_Menu SHALL 立即关闭
2. WHEN 用户点击任何启用的菜单项，THEN THE 对应的操作 SHALL 在菜单关闭后立即执行
3. WHEN 用户点击禁用的菜单项时，THE Context_Menu SHALL 保持打开状态且不执行任何操作
