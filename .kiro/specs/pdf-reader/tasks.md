# Implementation Plan: PDF 多模态解读功能

## Overview

本实现计划将 PDF 多模态解读功能分解为可执行的编码任务。该功能允许用户上传 PDF 文档，系统提取每页的文本和图像，以多模态格式（文本+图片）发送给 LLM 进行智能分析。

## Tasks

- [ ] 1. 扩展后端数据模型
  - [x] 1.1 在 `models.rs` 中添加 PDF 相关数据结构
    - 添加 `PdfPage` 结构体（page_number, text, image）
    - 添加 `PdfMetadata` 结构体（title, author, created_at 等）
    - 扩展 `ContentPart` 枚举，添加 `PdfDocument` 变体
    - 添加 `ContentPart::pdf_document()` 构造函数
    - _Requirements: 8.1, 8.2_
  
  - [x] 1.2 编写 PdfDocument 序列化往返属性测试
    - **Property 1: PdfDocument Serialization Round-Trip**
    - **Validates: Requirements 8.2, 8.3**
    - 验证 PdfDocument ContentPart 的 JSON 序列化和反序列化往返一致性

- [ ] 2. 扩展前端类型定义
  - [x] 2.1 在 `types/index.ts` 中添加 PDF 相关类型
    - 添加 `PdfPage` 接口
    - 添加 `PdfMetadata` 接口
    - 添加 `PdfDocumentContentPart` 接口
    - 添加 `PendingPdf` 接口
    - 扩展 `ContentPart` 类型联合
    - 定义 PDF 相关常量（MAX_PDF_SIZE, MAX_PDF_PAGES 等）
    - _Requirements: 8.1, 1.3, 1.5_

- [ ] 3. 安装和配置 PDF.js 依赖
  - [x] 3.1 安装 pdfjs-dist 包
    - 在 `tauri-ai/package.json` 中添加 `pdfjs-dist` 依赖
    - 运行 `npm install`
    - _Requirements: 3.1_
  
  - [x] 3.2 配置 PDF.js worker
    - 在前端入口文件中配置 `GlobalWorkerOptions.workerSrc`
    - _Requirements: 3.1_

- [ ] 4. 实现 PDF 处理工具函数
  - [x] 4.1 创建 `utils/pdfUtils.ts` 文件
    - 实现 `isValidPdfFile()` 函数（验证文件类型）
    - 实现 `validatePdfSize()` 函数（验证文件大小 <= 20MB）
    - _Requirements: 1.1, 1.2, 1.3, 1.5_
  
  - [x] 4.2 编写 PDF 文件验证属性测试
    - **Property 2: PDF File Validation**
    - **Validates: Requirements 1.2, 1.3, 1.5**
    - 验证文件类型和大小验证的正确性
  
  - [x] 4.3 实现 `extractPageContent()` 函数
    - 提取单页文本内容
    - 渲染页面为 Canvas
    - 转换 Canvas 为 Base64 PNG 图片
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  
  - [x] 4.4 实现 `processPdfFile()` 函数
    - 加载 PDF 文档
    - 验证页数限制（<= 50 页）
    - 提取文档元数据
    - 分批处理页面（每批 5 页）
    - 更新处理进度
    - 返回 `PendingPdf` 对象
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 9.1, 9.3_
  
  - [x] 4.5 编写页面提取属性测试
    - **Property 3: Page Content Extraction**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
    - 验证每页都包含有效的文本和图片数据

- [ ] 5. Checkpoint - 确保 PDF 处理测试通过
  - 运行所有 PDF 处理相关测试
  - 确保测试通过，如有问题请询问用户

- [ ] 6. 实现 PDF 预览组件
  - [x] 6.1 创建 `components/Chat/PdfPreview.tsx` 组件
    - 显示 PDF 文件名和元数据
    - 显示处理进度条
    - 显示页面缩略图网格（最多显示前 6 页）
    - 显示总页数信息
    - 提供删除按钮
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6_
  
  - [x] 6.2 添加 PDF 预览样式
    - 实现响应式网格布局
    - 添加缩略图悬停效果
    - 添加进度条动画
    - _Requirements: 5.1, 5.2_

- [ ] 7. 扩展 InputArea 组件
  - [x] 7.1 添加 PDF 状态管理
    - 添加 `pendingPdfs` 状态
    - 添加 `pdfError` 状态
    - 添加 `pdfFileInputRef` 引用
    - _Requirements: 1.1, 1.4, 1.6, 10.1-10.7_
  
  - [x] 7.2 实现 `handlePdfSelect()` 处理函数
    - 验证文件类型和大小
    - 调用 `processPdfFile()` 处理 PDF
    - 更新 `pendingPdfs` 状态
    - 处理错误并显示错误消息
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 10.1-10.7_
  
  - [x] 7.3 实现 `removePdf()` 删除函数
    - 从 `pendingPdfs` 中移除指定 PDF
    - _Requirements: 5.1_
  
  - [x] 7.4 更新 AttachmentMenu 组件
    - 添加"PDF 文档"菜单项
    - 添加隐藏的 PDF 文件输入元素
    - 配置 accept 属性为 ".pdf"
    - _Requirements: 1.1, 1.2_
  
  - [x] 7.5 实现拖拽支持
    - 扩展现有的 `handleDrop()` 处理 PDF 文件
    - 验证文件类型和大小
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_
  
  - [x] 7.6 实现 PDF 数量限制
    - 检查当前 PDF 数量（最多 3 个）
    - 超出限制时显示错误提示
    - _Requirements: 6.2, 6.5_
  
  - [x] 7.7 编写 PDF 数量限制属性测试
    - **Property 4: PDF Count Limit Invariant**
    - **Validates: Requirements 6.2, 6.5**
    - 验证系统始终遵守 PDF 数量限制

- [ ] 8. 实现消息发送集成
  - [x] 8.1 更新 `handleSend()` 函数
    - 将 `pendingPdfs` 转换为 `PdfDocumentContentPart`
    - 添加到 `contentParts` 数组
    - 发送后清空 `pendingPdfs`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  
  - [x] 8.2 编写消息格式化属性测试
    - **Property 5: PDF Message Formatting**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.7**
    - 验证 PDF 被正确转换为 ContentPart 格式

- [ ] 9. 扩展后端 OpenAI 客户端
  - [x] 9.1 在 `openai.rs` 中添加 PdfDocument 转换逻辑
    - 在 `convert_messages()` 函数中处理 `ContentPart::PdfDocument`
    - 为每一页生成文本 + 图片的 ContentPart 序列
    - 文本格式：`"📄 {filename} - 第{page_number}页\n```\n{text}\n```"`
    - 图片格式：`ImageUrl { url: page.image, detail: "high" }`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  
  - [x] 9.2 编写 OpenAI 转换属性测试
    - **Property 6: OpenAI API Conversion**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
    - 验证 PdfDocument 被正确转换为 OpenAI API 格式

- [ ] 10. Checkpoint - 确保集成测试通过
  - 运行所有集成测试
  - 确保测试通过，如有问题请询问用户

- [ ] 11. 实现错误处理和用户反馈
  - [x] 11.1 添加错误消息常量
    - 定义所有错误场景的错误消息
    - _Requirements: 10.1-10.7_
  
  - [x] 11.2 实现错误处理逻辑
    - 处理 PDF 损坏错误
    - 处理 PDF 加密错误
    - 处理文本提取失败
    - 处理图片渲染失败
    - 处理处理超时
    - _Requirements: 1.6, 10.1-10.7_
  
  - [x] 11.3 编写错误处理属性测试
    - **Property 7: Error Handling Completeness**
    - **Validates: Requirements 10.1-10.7**
    - 验证所有错误场景都有适当的错误消息

- [ ] 12. 性能优化
  - [x] 12.1 实现图片压缩
    - 使用 JPEG 格式和质量参数压缩页面图片
    - 平衡图片质量和文件大小
    - _Requirements: 9.2_
  
  - [x] 12.2 实现 Token 估算函数
    - 创建 `estimatePdfTokens()` 函数
    - 估算文本和图片的 token 使用量
    - _Requirements: 9.4_
  
  - [x] 12.3 实现内存管理
    - 处理完成后释放 Canvas 资源
    - 清理不再使用的 PDF 对象
    - _Requirements: 9.6_

- [ ] 13. 集成测试和最终验证
  - [x] 13.1 验证完整流程
    - 测试通过菜单选择 PDF 文件
    - 测试拖拽 PDF 文件
    - 测试 PDF 预览显示
    - 测试发送包含 PDF 的消息
    - 测试多页 PDF 处理
    - 测试错误场景（超大文件、损坏文件等）
    - _Requirements: 1.1-10.7_
  
  - [x] 13.2 编写端到端集成测试
    - 创建 `InputArea.pdf.integration.test.tsx`
    - 测试完整的 PDF 上传和发送流程
    - _Requirements: 1.1-10.7_

- [ ] 14. Final Checkpoint - 确保所有测试通过
  - 运行完整测试套件
  - 确保所有测试通过，如有问题请询问用户

## Notes

- 所有任务都是必需的，包括属性测试
- 每个任务都引用了具体的需求条款以便追溯
- 属性测试验证通用正确性属性
- 单元测试验证具体示例和边界情况
- PDF 处理在前端完成，后端只负责存储和转发
- 使用分批处理策略避免阻塞 UI
- 图片使用 Base64 data URL 格式
- 发送给 LLM 的格式为交替的文本和图片序列
