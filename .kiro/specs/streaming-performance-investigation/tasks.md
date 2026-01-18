# 实施计划: 流式响应性能调查

## 概述

本实施计划将流式响应性能问题的调查和优化分为三个阶段：
1. 性能监控工具实现（建立基准）
2. 核心优化实施（解决主要积累效应）
3. 验证和回归测试（确保优化效果）

## 任务

### 阶段 1: 性能监控基础设施

- [ ] 1. 实现性能监控工具
  - [ ] 1.1 创建 PerformanceMonitor 类
    - 实现 FPS 测量（使用 requestAnimationFrame）
    - 实现渲染时间测量（使用 Performance API）
    - 实现 DOM 节点计数
    - 实现内存使用监控（使用 performance.memory）
    - _Requirements: 10.1, 10.2_
  
  - [ ]* 1.2 编写 PerformanceMonitor 单元测试
    - 测试 FPS 测量准确性
    - 测试指标收集完整性
    - _Requirements: 10.1_
  
  - [ ] 1.3 实现性能数据导出功能
    - 实现 exportReport() 方法
    - 生成 JSON 格式的性能报告
    - 包含摘要、时间线和分析结果
    - _Requirements: 10.1_

- [ ] 2. 建立性能基准测试
  - [ ] 2.1 创建流式响应模拟工具
    - 实现 simulateTokenArrival() 函数
    - 支持可配置的 token 发送频率
    - 支持可配置的流式持续时间
    - _Requirements: 10.5_
  
  - [ ]* 2.2 编写性能基准测试用例
    - **Property 1: 渐进式性能恶化**
    - **Validates: Requirements 1.2**
    - 测试 30 秒流式响应的 FPS 变化曲线
    - 验证 FPS 是否随时间下降
  
  - [ ]* 2.3 编写性能恢复测试用例
    - **Property 2: 性能立即恢复**
    - **Validates: Requirements 1.4**
    - 测试停止吐字后 FPS 是否在 1 秒内恢复

- [ ] 3. Checkpoint - 验证监控工具正常工作
  - 确保性能监控工具能正确收集数据，询问用户是否有问题

### 阶段 2: 核心优化实施

- [ ] 4. 组件渲染优化（优先级: 高）
  - [ ] 4.1 为 MessageItem 添加 React.memo 优化
    - 使用 React.memo 包装 MessageItem 组件
    - 实现自定义比较函数（只比较 content）
    - 确保历史消息不会重新渲染
    - _Requirements: 9.3_
  
  - [ ]* 4.2 编写 MessageItem memo 测试
    - 测试内容不变时不重新渲染
    - 测试内容变化时正确渲染
    - _Requirements: 9.3_
  
  - [ ] 4.3 分离流式消息和历史消息渲染
    - 创建 StreamingMessageItem 组件
    - 在 MessageList 中分别渲染历史和流式消息
    - _Requirements: 9.3_
  
  - [ ]* 4.4 编写渲染优化属性测试
    - **Property 7: 渲染任务积压检测**
    - **Validates: Requirements 4.2**
    - 测试优化后渲染延迟是否降低

- [ ] 5. 滚动优化（优先级: 高）
  - [ ] 5.1 实现滚动节流
    - 使用 lodash.throttle 或自定义节流函数
    - 设置节流间隔为 200ms
    - 确保 leading 和 trailing 都触发
    - _Requirements: 9.5_
  
  - [ ] 5.2 移除平滑滚动动画
    - 将 scrollIntoView behavior 从 'smooth' 改为 'instant'
    - 避免滚动动画积压
    - _Requirements: 9.5_
  
  - [ ]* 5.3 编写滚动节流测试
    - 测试滚动调用频率是否降低
    - 测试节流后滚动仍然正常工作
    - _Requirements: 9.5_
  
  - [ ]* 5.4 编写重排停止属性测试
    - **Property 12: 重排操作立即停止**
    - **Validates: Requirements 6.5**
    - 测试停止吐字后重排是否在 500ms 内停止

- [ ] 6. 事件监听器管理（优先级: 高）
  - [ ] 6.1 实现监听器清理机制
    - 在 initStreamListeners 中先清理旧监听器
    - 保存 unlisten 函数引用
    - 实现 cleanupStreamListeners 函数
    - _Requirements: 9.4_
  
  - [ ] 6.2 在组件卸载时清理监听器
    - 在 useEffect cleanup 中调用 cleanupStreamListeners
    - 确保监听器不会泄漏
    - _Requirements: 9.4_
  
  - [ ]* 6.3 编写监听器泄漏测试
    - **Property 10: 事件监听器无泄漏**
    - **Validates: Requirements 5.3, 5.4**
    - 测试多次初始化后监听器数量不增长
    - 测试单个事件不会触发多次处理

- [ ] 7. Checkpoint - 验证核心优化效果
  - 运行性能基准测试，对比优化前后数据，询问用户是否继续

### 阶段 3: 高级优化和验证

- [ ] 8. Token 批处理（优先级: 中）
  - [ ] 8.1 实现 token 缓冲机制
    - 创建 tokenBuffer 数组
    - 实现 100ms 的批处理定时器
    - 在定时器触发时批量更新状态
    - _Requirements: 9.1_
  
  - [ ] 8.2 实现立即 flush 机制
    - 在停止吐字时立即 flush 缓冲区
    - 确保最后的 token 不会丢失
    - _Requirements: 9.1_
  
  - [ ]* 8.3 编写 token 批处理测试
    - 测试多个 token 是否被批量处理
    - 测试批处理后状态更新频率降低
    - 测试停止时缓冲区被正确 flush
    - _Requirements: 9.1_
  
  - [ ]* 8.4 编写事件完整性属性测试
    - **Property 3: 事件完整性**
    - **Validates: Requirements 2.5**
    - 测试发送 N 个事件后接收到 N 个事件

- [ ] 9. Markdown 解析优化（优先级: 中）
  - [ ] 9.1 实现增量 Markdown 解析
    - 检测新增内容（使用 lastContentRef）
    - 只解析新增部分
    - 拼接到已有 HTML
    - _Requirements: 9.2_
  
  - [ ] 9.2 处理跨块元素的边界情况
    - 检测 Markdown 语法边界
    - 必要时重新解析完整内容
    - _Requirements: 9.2_
  
  - [ ]* 9.3 编写 Markdown 解析测试
    - 测试增量解析结果正确性
    - 测试跨块元素边界情况
    - 测试解析性能提升
    - _Requirements: 9.2_

- [ ] 10. 内存泄漏检测和修复
  - [ ] 10.1 实现内存监控
    - 在 PerformanceMonitor 中添加内存追踪
    - 记录堆内存使用量
    - 检测内存持续增长
    - _Requirements: 10.2_
  
  - [ ]* 10.2 编写内存泄漏属性测试
    - **Property 6: 内存泄漏检测**
    - **Validates: Requirements 3.4, 7.2, 7.5**
    - 测试多轮流式响应后内存不持续增长
    - 测试清理后内存恢复到初始水平
  
  - [ ] 10.3 修复发现的内存泄漏
    - 根据测试结果识别泄漏源
    - 修复闭包引用问题
    - 确保对象正确释放
    - _Requirements: 9.6_

- [ ] 11. 综合性能验证
  - [ ]* 11.1 编写性能回归测试
    - **Property 13: 性能回归检测**
    - **Validates: Requirements 10.6**
    - 测试 30 秒流式响应的 FPS 下降不超过 30%
    - 确保不再出现严重渐进式恶化
  
  - [ ]* 11.2 编写 DOM 清理属性测试
    - **Property 9: DOM 节点清理**
    - **Validates: Requirements 5.2, 5.5**
    - 测试停止并清理后 DOM 节点数量恢复
  
  - [ ]* 11.3 编写强制同步布局检测测试
    - **Property 11: 强制同步布局检测**
    - **Validates: Requirements 6.3**
    - 使用 Performance Observer 检测强制同步布局
  
  - [ ] 11.4 生成优化前后对比报告
    - 收集优化前的性能基准数据
    - 收集优化后的性能数据
    - 生成对比报告（FPS、内存、渲染时间等）
    - _Requirements: 10.4_

- [ ] 12. Final Checkpoint - 确保所有测试通过
  - 运行所有性能测试和属性测试，确认优化效果，询问用户是否满意

## 注意事项

- 标记 `*` 的任务为可选任务，可以跳过以加快 MVP 开发
- 每个任务都引用了具体的需求编号，确保可追溯性
- Checkpoint 任务用于增量验证，确保每个阶段的工作正确
- 属性测试用于验证通用正确性，单元测试用于验证具体实现
- 优化方案按优先级排序，优先实施高收益低风险的优化
