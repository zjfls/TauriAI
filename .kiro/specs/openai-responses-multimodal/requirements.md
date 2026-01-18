# 需求文档

## 简介

本功能为 OpenAI Responses API 客户端 (`openai_responses.rs`) 添加多模态内容支持，使其能够处理图片、文本文件和 PDF 文档。该功能将使用项目中已有的 `content_converter` 模块来实现统一的多模态内容转换，保持与其他 AI 客户端（如 `openai.rs` 和 `anthropic.rs`）的一致性。

## 术语表

- **OpenAI_Responses_Client**: OpenAI Responses API 客户端，使用 `/v1/responses` 端点
- **Content_Converter**: 统一的多模态内容转换模块，提供 `content_part_to_blocks()` 函数
- **ContentPart**: 消息内容部分的枚举类型，包括 Text、Image、TextFile、PdfDocument
- **ContentBlock**: 中间表示格式，包括 Text、ImageUrl、ImageBase64
- **ResponsesInput**: OpenAI Responses API 的输入消息格式
- **Vision_Enabled**: 模型配置参数，指示模型是否支持视觉功能

## 需求

### 需求 1: 图片内容支持

**用户故事:** 作为用户，我希望能够在使用 OpenAI Responses API 时发送图片内容，以便让支持视觉的模型分析图片。

#### 验收标准

1. WHEN 消息包含 ContentPart::Image THEN THE OpenAI_Responses_Client SHALL 使用 content_converter 将其转换为 ContentBlock
2. WHEN 模型配置中 vision_enabled 为 true THEN THE OpenAI_Responses_Client SHALL 在请求中包含图片内容
3. WHEN 模型配置中 vision_enabled 为 false THEN THE OpenAI_Responses_Client SHALL 跳过图片内容
4. WHEN 图片使用 data URL 格式 THEN THE OpenAI_Responses_Client SHALL 保持 data URL 格式不变
5. WHEN 图片指定了 detail 级别 THEN THE OpenAI_Responses_Client SHALL 忽略 detail 参数（Responses API 不支持）

### 需求 2: 文本文件内容支持

**用户故事:** 作为用户，我希望能够在使用 OpenAI Responses API 时发送文本文件内容，以便模型分析文件内容。

#### 验收标准

1. WHEN 消息包含 ContentPart::TextFile THEN THE OpenAI_Responses_Client SHALL 使用 content_converter 将其转换为格式化的文本块
2. WHEN 转换文本文件 THEN THE Content_Converter SHALL 使用 markdown 代码块格式包装文件内容
3. WHEN 转换文本文件 THEN THE Content_Converter SHALL 在内容前添加文件名标识（📄 filename）

### 需求 3: PDF 文档内容支持

**用户故事:** 作为用户，我希望能够在使用 OpenAI Responses API 时发送 PDF 文档，以便模型分析 PDF 的文本和图片内容。

#### 验收标准

1. WHEN 消息包含 ContentPart::PdfDocument THEN THE OpenAI_Responses_Client SHALL 使用 content_converter 将其转换为交替的文本和图片块
2. WHEN 转换 PDF 文档 THEN THE Content_Converter SHALL 为每一页生成一个文本块和一个图片块
3. WHEN 转换 PDF 页面文本 THEN THE Content_Converter SHALL 包含文件名、页码和页面文本内容
4. WHEN 模型支持视觉功能 THEN THE OpenAI_Responses_Client SHALL 包含 PDF 页面的图片
5. WHEN 模型不支持视觉功能 THEN THE OpenAI_Responses_Client SHALL 仅包含 PDF 页面的文本内容

### 需求 4: 内容转换统一性

**用户故事:** 作为开发者，我希望所有 AI 客户端使用统一的内容转换逻辑，以便保持代码一致性和可维护性。

#### 验收标准

1. THE OpenAI_Responses_Client SHALL 使用 content_converter::content_part_to_blocks() 函数进行内容转换
2. THE OpenAI_Responses_Client SHALL 将 ContentBlock 转换为 ResponsesInput 格式
3. WHEN 处理多模态消息 THEN THE OpenAI_Responses_Client SHALL 遵循与 openai.rs 相同的转换模式
4. WHEN ContentBlock 为 Text 类型 THEN THE OpenAI_Responses_Client SHALL 将其作为文本内容添加到 input 数组
5. WHEN ContentBlock 为 ImageUrl 类型 THEN THE OpenAI_Responses_Client SHALL 将图片 URL 作为文本描述添加到 input 数组（Responses API 限制）

### 需求 5: 消息格式转换

**用户故事:** 作为开发者，我希望正确处理包含多模态内容的消息，以便将其转换为 Responses API 所需的格式。

#### 验收标准

1. WHEN 消息包含 content_parts THEN THE OpenAI_Responses_Client SHALL 使用 get_content_parts() 获取所有内容部分
2. WHEN 消息仅包含纯文本 THEN THE OpenAI_Responses_Client SHALL 使用 content 字段作为文本内容
3. WHEN 用户消息包含多个 ContentPart THEN THE OpenAI_Responses_Client SHALL 将所有部分合并为单个 ResponsesInput 的 content 字段
4. WHEN 助手消息包含多模态内容 THEN THE OpenAI_Responses_Client SHALL 仅提取文本内容（Responses API 限制）

### 需求 6: 错误处理

**用户故事:** 作为用户，我希望在多模态内容处理失败时收到清晰的错误信息，以便了解问题所在。

#### 验收标准

1. WHEN 图片 URL 格式无效 THEN THE OpenAI_Responses_Client SHALL 继续处理其他内容部分
2. WHEN PDF 文档为空 THEN THE OpenAI_Responses_Client SHALL 跳过该文档
3. WHEN 所有内容部分都被跳过 THEN THE OpenAI_Responses_Client SHALL 返回错误信息
4. WHEN 内容转换过程中发生错误 THEN THE OpenAI_Responses_Client SHALL 记录错误并继续处理

### 需求 7: 测试覆盖

**用户故事:** 作为开发者，我希望有完整的测试覆盖，以便确保多模态功能的正确性。

#### 验收标准

1. THE 测试套件 SHALL 包含单元测试验证 ContentPart 到 ResponsesInput 的转换
2. THE 测试套件 SHALL 包含测试验证 vision_enabled 配置的影响
3. THE 测试套件 SHALL 包含测试验证 PDF 文档的正确转换
4. THE 测试套件 SHALL 包含测试验证混合内容（文本+图片+PDF）的处理
5. THE 测试套件 SHALL 包含属性测试验证任意 PDF 文档的转换正确性
