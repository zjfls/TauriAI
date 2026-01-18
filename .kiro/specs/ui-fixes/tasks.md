# UI 修复任务列表

## 1. 智能体选择器下拉菜单修复

- [ ] 1.1 检查并修复 Header 组件中智能体选择器的 z-index
  - 将 z-index 从 z-50 提升到 z-[100]
  - 确保下拉菜单不被其他元素遮挡
  - 文件：`TauriAI-thinking-context/tauri-ai/src/components/Layout/Header.tsx`

- [ ] 1.2 添加下拉菜单滚动支持
  - 添加 max-h-80 和 overflow-auto 类
  - 确保多个智能体时可以滚动查看
  - 文件：`TauriAI-thinking-context/tauri-ai/src/components/Layout/Header.tsx`

- [ ] 1.3 检查父容器的 overflow 属性
  - 确保 Header 组件及其父容器没有 overflow: hidden
  - 如有必要，添加 overflow-visible
  - 文件：可能需要检查使用 Header 的父组件

- [ ] 1.4 手动测试智能体选择器
  - 测试不同数量的智能体（1个、3个、10个）
  - 测试暗色模式下的显示
  - 测试不同屏幕尺寸下的显示
  - 验证下拉菜单完整可见，不被裁剪

## 2. 思考按钮多级别支持

- [ ] 2.1 添加思考级别类型定义
  - 在 `types/index.ts` 中添加 `ThinkingLevel` 类型
  - 添加 `ThinkingMode` 联合类型
  - 添加相关的类型注释和文档
  - 文件：`TauriAI-thinking-context/tauri-ai/src/types/index.ts`

- [ ] 2.2 创建 ThinkingSelector 组件
  - 创建新的组件文件
  - 实现二元模式（chat_completions）
  - 实现多级别模式（responses）
  - 添加下拉菜单交互
  - 添加点击外部关闭功能
  - 支持暗色模式
  - 文件：`TauriAI-thinking-context/tauri-ai/src/components/Chat/ThinkingSelector.tsx`

- [ ] 2.3 更新 InputArea 组件
  - 添加 `apiProtocol` prop
  - 将 `enableThinking` 状态改为 `thinkingMode`
  - 集成 ThinkingSelector 组件
  - 更新 onSend 调用以传递 thinkingMode
  - 根据 apiProtocol 初始化默认值
  - 文件：`TauriAI-thinking-context/tauri-ai/src/components/Chat/InputArea.tsx`

- [ ] 2.4 实现 API 协议类型检测
  - 创建 `getApiProtocol` 工具函数
  - 根据 Provider 类型返回正确的协议
  - 文件：`TauriAI-thinking-context/tauri-ai/src/utils/apiUtils.ts`（新建）

- [ ] 2.5 更新父组件传递 apiProtocol
  - 在使用 InputArea 的组件中获取 apiProtocol
  - 将 apiProtocol 传递给 InputArea
  - 文件：需要查找使用 InputArea 的组件（可能是 ChatView）

- [ ] 2.6 编写 ThinkingSelector 单元测试
  - 测试二元模式渲染
  - 测试多级别模式渲染
  - 测试级别切换逻辑
  - 测试禁用状态
  - 测试暗色模式样式
  - 文件：`TauriAI-thinking-context/tauri-ai/src/components/Chat/ThinkingSelector.test.tsx`

- [ ] 2.7 编写 InputArea 集成测试
  - 测试不同 apiProtocol 下的渲染
  - 测试 thinkingMode 状态管理
  - 测试发送消息时的参数传递
  - 更新现有测试以适配新的 props
  - 文件：`TauriAI-thinking-context/tauri-ai/src/components/Chat/InputArea.test.tsx`

- [ ] 2.8 手动测试思考按钮功能
  - 测试 chat_completions 协议下的二元切换
  - 测试 responses 协议下的多级别选择
  - 测试切换模型时的状态重置
  - 测试发送消息时的参数传递
  - 验证 UI 交互流畅性

## 3. 文档和清理

- [ ] 3.1 更新组件文档
  - 为 ThinkingSelector 添加 JSDoc 注释
  - 更新 InputArea 的 Props 文档
  - 添加使用示例

- [ ] 3.2 代码审查和优化
  - 检查代码风格一致性
  - 优化性能（使用 useMemo、useCallback）
  - 确保可访问性（aria 标签、键盘导航）

- [ ] 3.3 最终验收测试
  - 运行所有单元测试
  - 执行完整的手动测试流程
  - 验证所有验收标准都已满足
  - 在不同浏览器/平台上测试（如适用）
