# Implementation Plan: Multi-Agent Workspace

## Overview

本实现计划将应用从单智能体模式重构为多智能体工作区模式。采用渐进式重构策略，先建立新的状态管理，再迁移 UI 组件，最后清理旧代码。

## Tasks

- [x] 1. 定义类型和接口
  - [x] 1.1 在 `src/types/index.ts` 中添加 `AgentSession` 类型
    - 包含 id, agentName, modelRef, conversationId, messages, streamingMessage, streamingThinking, isGenerating, error, createdAt, lastActiveAt
    - _Requirements: 1.1, 1.2, 4.1, 4.2_
  - [x] 1.2 添加 `PersistedSessionState` 类型用于持久化
    - 包含 version, sessions 数组, activeSessionId
    - _Requirements: 5.1, 5.2_

- [-] 2. 创建 SessionStore
  - [x] 2.1 创建 `src/stores/sessionStore.ts` 基础结构
    - 使用 Zustand 创建 store
    - 定义 sessions Map 和 activeSessionId
    - 实现 getActiveSession, getSession, getSessionByConversationId
    - _Requirements: 1.1, 1.2, 4.5_
  - [x] 2.2 实现会话创建和关闭
    - createSession: 创建新会话，设为活动会话
    - closeSession: 关闭会话，持久化对话历史
    - 实现最大 10 个会话的限制
    - _Requirements: 1.3, 1.4, 1.5, 3.3, 3.4_
  - [x] 2.3 实现会话切换
    - switchSession: 切换活动会话
    - 加载对应会话的消息历史
    - _Requirements: 2.2_
  - [x] 2.4 实现消息发送和流式处理
    - sendMessage: 向指定会话发送消息
    - appendStreamingToken, appendThinkingToken: 更新指定会话的流式内容
    - finalizeStreaming: 完成流式响应
    - handleError: 处理错误
    - _Requirements: 4.3, 4.4, 7.1, 7.5_
  - [x] 2.5 实现事件监听和路由
    - 监听 chat:token, chat:thinking, chat:done, chat:error 事件
    - 根据 conversationId 路由到对应会话
    - _Requirements: 7.2, 7.3, 7.4_
  - [x] 2.6 编写 SessionStore 属性测试
    - **Property 1: Session State Isolation**
    - **Property 4: Event Routing Correctness**
    - **Validates: Requirements 1.2, 4.1-4.5, 7.2-7.4**

- [x] 3. 实现会话持久化
  - [x] 3.1 实现 saveSessionState 方法
    - 将会话状态序列化为 PersistedSessionState
    - 保存到 localStorage
    - _Requirements: 5.1_
  - [x] 3.2 实现 restoreSessionState 方法
    - 从 localStorage 读取并反序列化
    - 处理智能体不存在的情况（使用默认智能体）
    - 恢复消息历史
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
  - [x] 3.3 编写持久化属性测试
    - **Property 3: Session Persistence Round-Trip**
    - **Validates: Requirements 5.1-5.4**

- [x] 4. 实现模型切换
  - [x] 4.1 实现 setSessionModel 方法
    - 更新指定会话的 modelRef
    - 不影响其他会话
    - _Requirements: 6.1, 6.2, 6.3_
  - [x] 4.2 编写模型独立性属性测试
    - **Property 5: Model Independence**
    - **Validates: Requirements 6.1, 6.2**

- [x] 5. Checkpoint - 确保 SessionStore 测试通过
  - 运行所有属性测试
  - 确保状态隔离、事件路由、持久化、模型独立性测试通过
  - 如有问题请询问用户

- [x] 6. 创建 SessionTabBar 组件
  - [x] 6.1 创建 `src/components/Session/SessionTabBar.tsx`
    - 显示所有会话标签
    - 每个标签显示智能体名称和关闭按钮
    - 活动标签高亮显示
    - 支持水平滚动
    - _Requirements: 2.1, 2.3, 2.6_
  - [x] 6.2 实现标签交互
    - 点击标签切换会话
    - 点击关闭按钮关闭会话
    - 显示加载指示器（当 isGenerating 为 true）
    - _Requirements: 2.2, 2.4, 2.5_
  - [x] 6.3 实现新建会话按钮
    - "+" 按钮打开智能体选择菜单
    - 选择智能体后创建新会话
    - 处理无智能体配置的情况
    - _Requirements: 3.1, 3.2, 3.5_

- [x] 7. 重构 ChatView 组件
  - [x] 7.1 修改 ChatView 接收 sessionId 而非 conversationId
    - 从 SessionStore 获取会话状态
    - 使用会话的 messages, streamingMessage 等
    - _Requirements: 4.1, 4.2_
  - [x] 7.2 更新消息发送逻辑
    - 调用 sessionStore.sendMessage(sessionId, content)
    - 调用 sessionStore.abortGeneration(sessionId)
    - _Requirements: 4.3, 4.4_

- [-] 8. 重构 App.tsx
  - [x] 8.1 集成 SessionTabBar
    - 在 MainLayout 中添加 SessionTabBar
    - 连接到 SessionStore
    - _Requirements: 2.1_
  - [ ] 8.2 更新视图渲染逻辑
    - 根据 activeSessionId 渲染对应的 ChatView
    - 处理无活动会话的情况
    - _Requirements: 2.2_
  - [ ] 8.3 实现应用启动时的会话恢复
    - 调用 restoreSessionState
    - 如果没有会话，创建默认会话
    - _Requirements: 5.2_

- [ ] 9. 更新 HistoryPanel
  - [ ] 9.1 修改历史记录点击行为
    - 点击历史对话时调用 openHistoricalConversation
    - 在新会话中打开历史对话
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 10. 实现快捷键支持
  - [ ] 10.1 添加全局快捷键监听
    - Ctrl+T: 创建新会话
    - Ctrl+W: 关闭当前会话
    - Ctrl+Tab: 切换到下一个会话
    - Ctrl+Shift+Tab: 切换到上一个会话
    - Ctrl+1-9: 切换到对应索引的会话
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 11. Checkpoint - 集成测试
  - 测试多会话创建和切换
  - 测试并发流式响应
  - 测试会话持久化和恢复
  - 测试快捷键功能
  - 如有问题请询问用户

- [ ] 12. 清理和迁移
  - [ ] 12.1 迁移 conversationStore 的剩余功能
    - loadConversations 移到 sessionStore 或保留在 conversationStore
    - 确保历史记录功能正常
    - _Requirements: 8.1_
  - [ ] 12.2 更新类型导出
    - 在 types/index.ts 导出新类型
    - 标记废弃的类型
  - [ ] 12.3 更新组件导出
    - 在 components/index.ts 导出 SessionTabBar

- [ ] 13. Final Checkpoint - 完整功能验证
  - 验证所有需求已实现
  - 确保所有测试通过
  - 如有问题请询问用户

## Notes

- 所有任务都是必须完成的，包括属性测试
- 每个 Checkpoint 是验证点，确保阶段性功能正常
- 属性测试使用 fast-check 库，每个测试运行 100 次迭代
- 保持向后兼容，conversationStore 的部分功能可能需要保留
