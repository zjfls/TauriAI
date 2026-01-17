# Implementation Plan: Text File Attachment

## Overview

本实现计划将文本文件附件功能分解为可执行的编码任务。遵循现有图片附件功能的模式，扩展前端组件和后端数据模型。

## Tasks

- [x] 1. 扩展后端数据模型
  - [x] 1.1 在 `models.rs` 中扩展 ContentPart 枚举，添加 TextFile 变体
    - 添加 `TextFile { filename: String, content: String }` 变体
    - 添加 `text_file()` 构造函数
    - _Requirements: 6.1_
  
  - [x] 1.2 编写 ContentPart 序列化往返属性测试
    - **Property 7: ContentPart Serialization Round-Trip**
    - **Validates: Requirements 6.2, 6.3, 6.4**

- [x] 2. 扩展前端类型定义
  - [x] 2.1 在 `types/index.ts` 中扩展 ContentPart 类型
    - 添加 `text_file` 类型定义
    - _Requirements: 6.1_
  
  - [x] 2.2 添加 PendingTextFile 接口和相关常量
    - 定义 `PendingTextFile` 接口
    - 定义 `SUPPORTED_TEXT_EXTENSIONS` 常量
    - 定义 `MAX_TEXT_FILE_SIZE` 和 `MAX_TEXT_FILES` 常量
    - _Requirements: 1.2, 5.3_

- [x] 3. 实现文件验证和读取函数
  - [x] 3.1 实现 `isSupportedTextFile()` 函数
    - 检查文件扩展名是否在支持列表中
    - 支持大小写不敏感匹配
    - _Requirements: 1.4, 4.3_
  
  - [x] 3.2 编写扩展名验证属性测试
    - **Property 2: Extension Validation**
    - **Validates: Requirements 1.4, 4.3**
  
  - [x] 3.3 实现 `readTextFile()` 函数
    - 验证文件大小 (<= 1MB)
    - 读取文件内容为 UTF-8 文本
    - 处理编码错误和 IO 错误
    - _Requirements: 1.3, 1.5, 7.1, 7.2, 7.3_
  
  - [x] 3.4 编写文件大小验证属性测试
    - **Property 3: Size Validation**
    - **Validates: Requirements 1.5, 4.4**

- [x] 4. Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 5. 实现文本文件预览组件
  - [x] 5.1 创建 `TextFilePreview` 组件
    - 显示文件图标和文件名
    - 显示内容预览（前500字符，超出显示省略号）
    - 显示文件大小
    - 提供删除按钮
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  
  - [x] 5.2 编写内容截断属性测试
    - **Property 4: Content Truncation**
    - **Validates: Requirements 2.2**

- [x] 6. 扩展 InputArea 组件
  - [x] 6.1 添加文本文件状态管理
    - 添加 `pendingTextFiles` 状态
    - 实现 `handleTextFileSelect()` 处理函数
    - 实现 `removeTextFile()` 删除函数
    - _Requirements: 1.1, 1.3, 2.4_
  
  - [x] 6.2 更新 AttachmentMenu 组件
    - 启用"文本文件"菜单项
    - 添加隐藏的文件输入元素
    - 配置 accept 属性为支持的扩展名
    - _Requirements: 1.1, 1.2_
  
  - [x] 6.3 实现拖拽支持
    - 扩展现有的 `handleDrop()` 处理文本文件
    - 验证文件类型和大小
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  
  - [x] 6.4 实现文件数量限制
    - 检查当前文件数量
    - 超出限制时显示错误提示
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  
  - [x] 6.5 编写文件数量限制属性测试
    - **Property 6: File Count Limit Invariant**
    - **Validates: Requirements 5.3, 5.4**

- [x] 7. 实现消息发送集成
  - [x] 7.1 更新 `handleSend()` 函数
    - 将文本文件转换为 ContentPart
    - 格式化文件内容为 "📄 {filename}\n```\n{content}\n```"
    - 发送后清空 pendingTextFiles
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  
  - [x] 7.2 编写消息格式化属性测试
    - **Property 5: Message Formatting**
    - **Validates: Requirements 3.1, 3.2, 3.4**

- [x] 8. 集成测试和最终验证
  - [x] 8.1 验证完整流程
    - 测试通过菜单选择文件
    - 测试拖拽文件
    - 测试预览显示
    - 测试发送消息
    - _Requirements: 1.1-7.3_

- [x] 9. Final Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## Notes

- 所有任务都是必需的，包括属性测试
- 每个任务都引用了具体的需求条款以便追溯
- 属性测试验证通用正确性属性
- 单元测试验证具体示例和边界情况
