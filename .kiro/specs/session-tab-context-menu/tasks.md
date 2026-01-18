# 实施计划：Session Tab 右键菜单

## 概述

本实施计划将为 TauriAI 应用的 SessionTabBar 组件添加右键上下文菜单功能。实施将分为三个主要阶段：创建 ContextMenu 组件、扩展 SessionStore 功能、集成到 SessionTabBar 并添加测试。

## 任务

- [ ] 1. 创建 ContextMenu 组件
  - [x] 1.1 创建 ContextMenu 组件文件和类型定义
    - 在 `tauri-ai/src/components/Session/` 目录下创建 `ContextMenu.tsx`
    - 定义 `ContextMenuProps` 和 `MenuItemConfig` 接口
    - 实现基础组件结构（接收 props，渲染菜单容器）
    - _需求: 1.1, 1.4_
  
  - [x] 1.2 实现菜单项渲染和禁用状态逻辑
    - 根据 targetSessionIndex 和 totalSessions 计算每个菜单项的禁用状态
    - 渲染四个菜单项：关闭其他、关闭左侧、关闭右侧、关闭当前
    - 应用禁用样式（降低透明度）
    - _需求: 2.3, 3.2, 4.2, 5.3_
  
  - [x] 1.3 实现菜单定位和边界检测
    - 根据 position prop 设置菜单的初始位置
    - 检测菜单是否超出视口边界
    - 如果超出，调整菜单位置（向左或向上）
    - _需求: 1.1_
  
  - [x] 1.4 实现菜单关闭逻辑
    - 添加点击外部区域关闭菜单的事件监听器
    - 添加 Escape 键关闭菜单的键盘事件监听器
    - 在组件卸载时清理事件监听器
    - _需求: 1.2, 1.3_
  
  - [x] 1.5 添加 dark mode 主题样式
    - 使用 Tailwind CSS 或现有样式系统
    - 实现深色背景、文字颜色、阴影和圆角
    - 添加悬停高亮效果
    - 添加禁用状态样式
    - _需求: 6.1, 6.2, 6.3, 6.4_
  
  - [x] 1.6 为 ContextMenu 组件编写单元测试
    - 测试组件渲染和 props 传递
    - 测试边界情况下的菜单项禁用状态
    - 测试菜单位置计算
    - _需求: 1.4, 2.3, 3.2, 4.2_

- [ ] 2. 扩展 SessionStore 批量操作方法
  - [x] 2.1 实现 closeOtherSessions 方法
    - 在 `tauri-ai/src/stores/sessionStore.ts` 中添加方法
    - 遍历所有 session，关闭除指定 sessionId 外的所有 session
    - 将指定的 session 设置为活动 session
    - _需求: 2.1, 2.2_
  
  - [x] 2.2 为 closeOtherSessions 编写属性测试
    - **属性 4: 关闭其他标签页保留目标**
    - **验证需求: 2.1, 2.2**
    - 使用 fast-check 生成随机 session 列表和目标 session
    - 验证操作后只保留目标 session 且它是活动的
    - 最少 100 次迭代
  
  - [x] 2.3 实现 closeSessionsToLeft 方法
    - 接收 sessionId 参数
    - 获取 session 在列表中的索引
    - 关闭所有索引小于目标索引的 session
    - 如果活动 session 被关闭，保持目标 session 或其他剩余 session 为活动
    - _需求: 3.1, 3.3_
  
  - [x] 2.4 为 closeSessionsToLeft 编写属性测试
    - **属性 5: 关闭左侧标签页**
    - **验证需求: 3.1**
    - 生成随机 session 列表和目标索引
    - 验证左侧 session 被移除，右侧保留
    - 最少 100 次迭代
  
  - [x] 2.5 实现 closeSessionsToRight 方法
    - 接收 sessionId 参数
    - 获取 session 在列表中的索引
    - 关闭所有索引大于目标索引的 session
    - 如果活动 session 被关闭，保持目标 session 或其他剩余 session 为活动
    - _需求: 4.1, 4.3_
  
  - [x] 2.6 为 closeSessionsToRight 编写属性测试
    - **属性 6: 关闭右侧标签页**
    - **验证需求: 4.1**
    - 生成随机 session 列表和目标索引
    - 验证右侧 session 被移除，左侧保留
    - 最少 100 次迭代
  
  - [x] 2.7 为活动 session 保持编写属性测试
    - **属性 7: 非活动目标关闭时保持活动 session**
    - **验证需求: 3.3, 4.3**
    - 生成随机配置（目标非活动）
    - 验证关闭左侧或右侧后活动 session 不变
    - 最少 100 次迭代

- [x] 3. 检查点 - 确保 SessionStore 测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [ ] 4. 集成到 SessionTabBar 组件
  - [x] 4.1 在 SessionTabBar 中添加上下文菜单状态
    - 在 `tauri-ai/src/components/Session/SessionTabBar.tsx` 中添加 useState
    - 定义 contextMenu 状态（包含 visible、position、targetSessionId、targetSessionIndex）
    - 实现 handleContextMenu 和 handleCloseContextMenu 函数
    - _需求: 1.1_
  
  - [x] 4.2 为每个 session tab 添加 onContextMenu 事件处理器
    - 在渲染 session tab 的地方添加 onContextMenu 属性
    - 调用 handleContextMenu 并传递事件、sessionId 和索引
    - 阻止浏览器默认右键菜单（e.preventDefault()）
    - _需求: 1.1_
  
  - [x] 4.3 渲染 ContextMenu 组件
    - 在 SessionTabBar 的 JSX 中条件渲染 ContextMenu
    - 传递所有必需的 props（visible、position、targetSessionId 等）
    - 连接菜单项的 action 到 SessionStore 的方法
    - _需求: 1.4, 7.1, 7.2_
  
  - [x] 4.4 实现菜单项操作回调
    - 为"关闭其他"连接到 closeOtherSessions
    - 为"关闭左侧"连接到 closeSessionsToLeft
    - 为"关闭右侧"连接到 closeSessionsToRight
    - 为"关闭当前"连接到 closeSession
    - 确保操作执行后菜单关闭
    - _需求: 2.1, 3.1, 4.1, 5.1, 7.1, 7.2_
  
  - [x] 4.5 为 SessionTabBar 集成编写单元测试
    - 使用 React Testing Library
    - 测试右键点击显示菜单
    - 测试菜单项点击执行正确的 SessionStore 方法
    - 测试菜单关闭行为
    - _需求: 1.1, 1.2, 1.3, 7.1, 7.2, 7.3_

- [ ] 5. 编写集成和属性测试
  - [x] 5.1 为菜单显示和关闭编写属性测试
    - **属性 1: 右键点击显示菜单**
    - **验证需求: 1.1**
    - 生成随机 session tab 配置
    - 模拟右键点击，验证菜单显示
    - 最少 100 次迭代
  
  - [x] 5.2 为点击外部关闭编写属性测试
    - **属性 2: 点击外部关闭菜单**
    - **验证需求: 1.2**
    - 生成随机菜单状态
    - 模拟外部点击，验证菜单关闭
    - 最少 100 次迭代
  
  - [x] 5.3 为 Escape 键关闭编写属性测试
    - **属性 3: Escape 键关闭菜单**
    - **验证需求: 1.3**
    - 生成随机菜单状态
    - 模拟 Escape 键，验证菜单关闭
    - 最少 100 次迭代
  
  - [x] 5.4 为关闭当前标签页编写属性测试
    - **属性 8: 关闭当前标签页移除目标**
    - **验证需求: 5.1**
    - 生成随机 session 列表
    - 验证目标 session 被移除
    - 最少 100 次迭代
  
  - [x] 5.5 为关闭活动标签页自动切换编写属性测试
    - **属性 9: 关闭活动标签页自动切换**
    - **验证需求: 5.2**
    - 生成包含多个 session 的列表
    - 关闭活动 session，验证自动切换到相邻 session
    - 最少 100 次迭代
  
  - [x] 5.6 为菜单项交互编写属性测试
    - **属性 10: 菜单项点击执行操作并关闭**
    - **属性 11: 禁用菜单项不响应点击**
    - **验证需求: 7.1, 7.2, 7.3**
    - 生成随机菜单项配置（启用/禁用）
    - 验证点击行为和操作执行
    - 最少 100 次迭代

- [x] 6. 最终检查点 - 确保所有测试通过
  - 运行所有单元测试和属性测试
  - 手动测试右键菜单的完整交互流程
  - 确保所有测试通过，如有问题请询问用户。

## 注意事项

- 每个任务都引用了具体的需求以确保可追溯性
- 检查点确保增量验证
- 属性测试验证通用正确性属性
- 单元测试验证特定示例和边缘情况
- 所有代码应该使用 TypeScript 编写
- 遵循项目现有的代码风格和组织结构
