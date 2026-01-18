# 需求文档

## 介绍

本规格文档记录了 TauriAI 应用中 HTTP 流式响应性能问题的深度调查结果。在 AI 对话流式响应过程中，界面刷新会**越来越慢**直到卡住，但响应完成后界面又**立即恢复正常**。

**核心观察**: 这是一个**渐进式恶化**的问题，而非渲染能力不足。关键特征：
- 流式响应开始时性能正常
- 随着时间推移性能逐渐下降
- 停止吐字后，界面响应速度立即恢复正常
- 这表明问题不是渲染能力不够，而是在流式过程中**触发或积累了某些负面因素**

本文档旨在系统性地分析这种渐进式恶化的根源，并提出优化方案。

## 术语表

- **Streaming_Response**: 流式响应，服务器逐步发送数据而非一次性返回完整响应
- **Token**: AI 模型生成的最小文本单元，通常是一个词或词的一部分
- **React_Render**: React 组件重新渲染过程，根据状态变化更新 DOM
- **Zustand_Store**: 应用使用的状态管理库
- **Markdown_Parser**: 将 Markdown 文本解析为 HTML 的组件
- **DOM_Reflow**: 浏览器重新计算元素位置和大小的过程
- **Event_Emission**: Tauri 后端向前端发送事件的机制
- **Progressive_Degradation**: 渐进式恶化，性能随时间逐渐下降的现象
- **Accumulation_Effect**: 积累效应，某些负面因素在流式过程中不断累积

## 需求

### 需求 1: 渐进式恶化现象记录

**用户故事:** 作为开发者，我需要准确记录性能渐进式恶化的表现，以便识别积累性问题的根源。

#### 验收标准

1. WHEN 流式响应开始 THEN THE System SHALL 表现出正常的界面刷新速度
2. WHILE 流式响应持续进行 THEN THE System SHALL 表现出逐渐降低的界面刷新速度
3. WHEN 流式响应达到一定时长 THEN THE System SHALL 出现界面卡住现象
4. WHEN 流式响应停止（吐字完成）THEN THE System SHALL 立即恢复正常界面响应速度
5. THE System SHALL 记录性能下降的时间曲线（非线性恶化）
6. THE System SHALL 验证停止吐字后性能立即恢复的现象
7. THE System SHALL 排除渲染能力不足的假设（因为停止后立即恢复）

### 需求 2: 事件积累和背压分析

**用户故事:** 作为开发者，我需要分析事件发送和处理机制，以便识别是否存在事件积压或背压问题。

#### 验收标准

1. THE System SHALL 分析后端 emit() 事件的发送队列机制
2. THE System SHALL 检测前端事件监听器是否存在处理延迟
3. WHEN 事件发送速度超过处理速度 THEN THE System SHALL 识别事件积压现象
4. THE System SHALL 记录事件队列长度随时间的变化
5. THE System SHALL 分析是否存在事件丢失或延迟处理
6. THE System SHALL 评估事件积压对性能渐进式恶化的贡献

### 需求 3: 状态更新积累效应分析

**用户故事:** 作为开发者，我需要分析状态更新机制，以便识别是否存在状态积累导致的性能问题。

#### 验收标准

1. THE System SHALL 分析 Zustand 状态更新的批处理机制
2. WHEN 高频率状态更新发生 THEN THE System SHALL 检测是否存在更新积压
3. THE System SHALL 分析每次状态更新触发的订阅者数量
4. THE System SHALL 检测是否存在状态更新导致的内存泄漏
5. THE System SHALL 记录状态对象大小随流式响应的增长趋势
6. THE System SHALL 分析状态更新频率与性能下降的相关性

### 需求 4: 渲染任务队列积压分析

**用户故事:** 作为开发者，我需要分析 React 渲染调度机制，以便识别渲染任务积压问题。

#### 验收标准

1. THE System SHALL 分析 React 渲染任务队列的调度机制
2. WHEN 高频率状态更新触发渲染 THEN THE System SHALL 检测渲染任务是否积压
3. THE System SHALL 记录渲染任务队列长度随时间的变化
4. THE System SHALL 分析每次渲染的实际执行时间
5. THE System SHALL 检测渲染任务是否阻塞事件处理
6. THE System SHALL 评估渲染任务积压对性能渐进式恶化的贡献

### 需求 5: DOM 操作积累效应分析

**用户故事:** 作为开发者，我需要分析 DOM 操作的积累效应，以便识别是否存在 DOM 节点或事件监听器泄漏。

#### 验收标准

1. THE System SHALL 记录 DOM 节点数量随流式响应的变化
2. THE System SHALL 检测是否存在未清理的 DOM 节点
3. THE System SHALL 分析事件监听器数量是否随流式响应增长
4. THE System SHALL 检测是否存在重复绑定的事件监听器
5. WHEN 流式响应停止 THEN THE System SHALL 验证 DOM 节点是否被正确清理
6. THE System SHALL 评估 DOM 操作积累对性能渐进式恶化的贡献

### 需求 6: 浏览器重排积累分析

**用户故事:** 作为开发者，我需要分析浏览器重排操作的积累效应，以便识别布局计算的性能影响。

#### 验收标准

1. THE System SHALL 记录每次 scrollIntoView() 触发的重排次数
2. THE System SHALL 分析高频率滚动操作是否导致重排队列积压
3. THE System SHALL 检测是否存在强制同步布局（forced synchronous layout）
4. THE System SHALL 记录布局计算耗时随流式响应的变化
5. WHEN 流式响应停止 THEN THE System SHALL 验证重排操作是否立即停止
6. THE System SHALL 评估浏览器重排积累对性能渐进式恶化的贡献

### 需求 7: 内存泄漏和垃圾回收分析

**用户故事:** 作为开发者，我需要分析内存使用和垃圾回收情况，以便识别内存泄漏或 GC 压力问题。

#### 验收标准

1. THE System SHALL 记录内存使用量随流式响应的变化
2. THE System SHALL 检测是否存在内存泄漏（内存持续增长）
3. THE System SHALL 记录垃圾回收（GC）的触发频率和耗时
4. WHEN 流式响应持续进行 THEN THE System SHALL 分析 GC 压力是否增加
5. WHEN 流式响应停止 THEN THE System SHALL 验证内存是否被正确释放
6. THE System SHALL 评估 GC 压力对性能渐进式恶化的贡献
7. THE System SHALL 识别可能导致内存泄漏的闭包或引用

### 需求 8: 渐进式恶化根因综合分析

**用户故事:** 作为开发者，我需要综合分析所有积累效应，以便确定渐进式恶化的根本原因。

#### 验收标准

1. THE System SHALL 综合评估事件积压、状态积累、渲染队列、DOM 操作、内存泄漏等因素
2. THE System SHALL 识别哪些因素会随时间积累而非保持恒定
3. THE System SHALL 量化各积累因素对性能下降的贡献度
4. THE System SHALL 解释为什么停止吐字后性能立即恢复
5. THE System SHALL 确定主要积累效应的优先级
6. THE System SHALL 排除非积累性因素（如单次渲染耗时）作为主因

### 需求 9: 优化方案设计

**用户故事:** 作为开发者，我需要基于积累效应分析设计优化方案，以便消除渐进式恶化问题。

#### 验收标准

1. THE System SHALL 提供事件批处理方案以减少事件积压
2. THE System SHALL 提供状态更新优化方案以避免状态积累
3. THE System SHALL 提供渲染调度优化方案以防止渲染任务积压
4. THE System SHALL 提供 DOM 清理方案以避免节点和监听器泄漏
5. THE System SHALL 提供滚动节流方案以减少重排积压
6. THE System SHALL 提供内存管理方案以避免内存泄漏和 GC 压力
7. THE System SHALL 为每个优化方案提供预期效果评估
8. THE System SHALL 为优化方案提供实施优先级建议（优先解决积累效应最严重的问题）

### 需求 10: 性能监控和验证

**用户故事:** 作为开发者，我需要建立性能监控机制，以便验证优化效果和检测积累效应。

#### 验收标准

1. THE System SHALL 提供实时性能监控方案（监控渲染帧率、事件队列长度等）
2. THE System SHALL 提供积累效应监控方案（监控内存、DOM 节点、事件监听器数量）
3. THE System SHALL 提供性能下降曲线可视化方案
4. WHEN 实施优化后 THEN THE System SHALL 提供优化前后对比数据
5. THE System SHALL 建立性能基准测试用例（模拟长时间流式响应）
6. THE System SHALL 提供性能回归检测机制（确保优化后不再出现渐进式恶化）
