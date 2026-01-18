# 实现计划: OpenAI Responses 多模态支持

## 概述

为 OpenAI Responses API 客户端添加多模态内容支持，使其能够处理图片、文本文件和 PDF 文档。实现将使用现有的 `content_converter` 模块，保持与其他 AI 客户端的一致性。

## 任务

- [x] 1. 添加 ContentBlock 到文本的转换函数
  - 在 `openai_responses.rs` 中创建 `content_blocks_to_text()` 函数
  - 处理 Text、ImageUrl、ImageBase64 三种类型的 ContentBlock
  - 对于图片块，生成适当的文本表示
  - _需求: 4.2, 4.4, 4.5_

- [x]* 1.1 为 content_blocks_to_text 编写单元测试
  - 测试纯文本块的转换
  - 测试图片 URL 块的转换
  - 测试 Base64 图片块的转换
  - 测试混合内容的转换
  - _需求: 4.2, 4.4, 4.5_

- [x] 2. 修改 convert_messages 函数支持多模态
  - [x] 2.1 添加 vision_enabled 参数到函数签名
    - 更新函数签名: `fn convert_messages(messages: &[Message], system_prompt: Option<&str>, vision_enabled: bool)`
    - _需求: 1.2, 1.3_

  - [x] 2.2 实现多模态内容检测和转换
    - 使用 `msg.has_multimodal_content()` 检测多模态消息
    - 使用 `msg.get_content_parts()` 获取内容部分
    - 调用 `content_converter::content_part_to_blocks()` 进行转换
    - 使用 `content_blocks_to_text()` 将块转换为文本
    - _需求: 1.1, 2.1, 3.1, 4.1, 4.2_

  - [x] 2.3 处理纯文本消息的向后兼容
    - 保持纯文本消息的原有处理逻辑
    - 确保不影响现有功能
    - _需求: 5.2_

- [ ]* 2.4 为 convert_messages 编写单元测试
  - 测试纯文本消息的转换
  - 测试单张图片的转换
  - 测试文本文件的转换
  - 测试 vision_enabled=true 时包含图片
  - 测试 vision_enabled=false 时跳过图片
  - _需求: 1.2, 1.3, 2.1, 5.2_

- [x] 3. 更新 chat 和 chat_stream 方法
  - [x] 3.1 在 chat 方法中传递 vision_enabled 参数
    - 从 `config.vision_enabled` 获取配置
    - 传递给 `convert_messages` 函数
    - _需求: 1.2, 1.3_

  - [x] 3.2 在 chat_stream 方法中传递 vision_enabled 参数
    - 从 `config.vision_enabled` 获取配置
    - 传递给 `convert_messages` 函数
    - _需求: 1.2, 1.3_

- [x] 4. 添加 PDF 文档支持测试
  - [ ]* 4.1 编写单页 PDF 转换的单元测试
    - 创建包含单页的 PDF ContentPart
    - 验证生成文本块和图片块
    - 验证文本块包含文件名、页码和内容
    - _需求: 3.1, 3.2, 3.3_

  - [ ]* 4.2 编写多页 PDF 转换的单元测试
    - 创建包含多页的 PDF ContentPart
    - 验证每页生成两个块（文本+图片）
    - 验证块的交替顺序
    - _需求: 3.1, 3.2_

  - [ ]* 4.3 编写 PDF 视觉功能控制的单元测试
    - 测试 vision_enabled=true 时包含图片
    - 测试 vision_enabled=false 时只包含文本
    - _需求: 3.4, 3.5_

- [x]* 5. 添加属性测试
  - [ ]* 5.1 编写 PDF 文档交替块结构的属性测试
    - **属性 5: PDF 文档交替块结构**
    - **验证需求: 3.1, 3.2**
    - 生成任意 PDF 文档（随机页数、内容）
    - 验证块数量 = 页数 * 2
    - 验证交替模式（文本、图片、文本、图片...）

  - [ ]* 5.2 编写视觉功能控制的属性测试
    - **属性 2: 视觉功能控制**
    - **验证需求: 1.2, 1.3, 3.4, 3.5**
    - 生成任意消息和配置
    - 验证 vision_enabled=true 时包含图片
    - 验证 vision_enabled=false 时不包含图片

  - [ ]* 5.3 编写多部分内容合并的属性测试
    - **属性 8: 多部分内容合并**
    - **验证需求: 5.3**
    - 生成任意多部分消息
    - 验证生成单个 ResponsesInput
    - 验证所有部分被合并到 content 字段

- [x] 6. 添加错误处理和边缘情况测试
  - [ ]* 6.1 测试空 PDF 文档的处理
    - 创建空页面列表的 PDF
    - 验证跳过该文档
    - _需求: 6.2_

  - [ ]* 6.2 测试所有内容被过滤的情况
    - 创建只包含图片的消息
    - 设置 vision_enabled=false
    - 验证返回适当的错误
    - _需求: 6.3_

  - [ ]* 6.3 测试混合内容的处理
    - 创建包含文本、图片、文本文件、PDF 的消息
    - 验证所有内容正确转换和合并
    - _需求: 5.3_

- [x] 7. 检查点 - 确保所有测试通过
  - 运行所有单元测试和属性测试
  - 验证代码覆盖率
  - 如有问题请询问用户

- [x] 8. 代码审查和文档更新
  - 检查代码风格和一致性
  - 确保与 openai.rs 和 anthropic.rs 的模式一致
  - 添加必要的代码注释
  - 更新模块文档说明多模态支持

## 注意事项

- 标记为 `*` 的任务是可选的，可以跳过以加快 MVP 开发
- 每个任务都引用了具体的需求以便追溯
- 检查点确保增量验证
- 属性测试验证通用正确性属性
- 单元测试验证特定示例和边缘情况
