# 设计文档

## 概述

本设计为 OpenAI Responses API 客户端添加多模态内容支持，使其能够处理图片、文本文件和 PDF 文档。设计遵循项目现有的架构模式，使用共享的 `content_converter` 模块进行内容转换，确保与其他 AI 客户端（`openai.rs`、`anthropic.rs`）的一致性。

OpenAI Responses API 使用 `input` 数组而非 `messages` 数组，且每个 input 项包含 `role` 和 `content` 字段。**Responses API 支持通过 data URL 在 content 字段中嵌入图片**，因此我们可以直接发送完整的图片数据。

## 架构

### 整体架构

```
Message (with content_parts)
    ↓
content_converter::content_part_to_blocks()
    ↓
Vec<ContentBlock> (Text, ImageUrl, ImageBase64)
    ↓
convert_to_responses_input()
    ↓
Vec<ResponsesInput> (role + content string with data URLs)
    ↓
OpenAI Responses API
```

### 关键设计决策

1. **使用统一的 content_converter 模块**: 与 `openai.rs` 和 `anthropic.rs` 保持一致
2. **支持 data URL 图片**: Responses API 支持在 content 字段中嵌入 data URL 格式的图片
3. **支持 vision_enabled 配置**: 当模型不支持视觉时跳过图片内容
4. **保持向后兼容**: 纯文本消息继续使用原有逻辑

## 组件和接口

### 1. 修改 `convert_messages` 函数

当前函数签名：
```rust
fn convert_messages(
    messages: &[Message],
    system_prompt: Option<&str>,
) -> (Vec<ResponsesInput>, Option<String>)
```

修改后的函数签名：
```rust
fn convert_messages(
    messages: &[Message],
    system_prompt: Option<&str>,
    vision_enabled: bool,
) -> (Vec<ResponsesInput>, Option<String>)
```

**功能说明:**
- 添加 `vision_enabled` 参数以控制是否包含图片
- 使用 `msg.has_multimodal_content()` 检测多模态内容
- 使用 `msg.get_content_parts()` 获取所有内容部分
- 调用 `content_converter::content_part_to_blocks()` 进行转换
- 将 `ContentBlock` 转换为 `ResponsesInput` 格式

### 2. ContentBlock 到 ResponsesInput 的转换

由于 Responses API 的限制，我们需要将不同类型的 ContentBlock 转换为文本格式：

```rust
fn content_blocks_to_text(blocks: Vec<ContentBlock>) -> String {
    blocks
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text,
            ContentBlock::ImageUrl { url, .. } => {
                // Responses API 支持 data URLs
                // 保留完整的 URL（data URLs 和 HTTP URLs）
                url
            }
            ContentBlock::ImageBase64 { media_type, data, .. } => {
                // 重构为 data URL 供 Responses API 使用
                format!("data:{};base64,{}", media_type, data)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
```

**实现说明**: OpenAI Responses API 支持在 content 字段中直接嵌入 data URL 格式的图片。图片会以完整的 data URL 形式包含在请求中，API 能够正确识别和处理这些图片。

### 3. 修改 `chat` 和 `chat_stream` 方法

在两个方法中，将 `convert_messages` 调用更新为：

```rust
let (inputs, instructions) = convert_messages(
    &messages,
    config.parameters.system_prompt.as_deref(),
    config.vision_enabled,
);
```

## 数据模型

### 现有数据结构（无需修改）

```rust
// 来自 models.rs
pub enum ContentPart {
    Text { text: String },
    Image { url: String, detail: ImageDetail },
    TextFile { filename: String, content: String },
    PdfDocument {
        filename: String,
        pages: Vec<PdfPage>,
        total_pages: u32,
        metadata: Option<PdfMetadata>,
    },
}

// 来自 content_converter.rs
pub enum ContentBlock {
    Text { text: String },
    ImageUrl { url: String, detail: ImageDetail },
    ImageBase64 { media_type: String, data: String, detail: ImageDetail },
}

// 来自 openai_responses.rs
struct ResponsesInput {
    role: String,
    content: String,
}
```

## 正确性属性

*属性是一种特征或行为，应该在系统的所有有效执行中保持为真——本质上是关于系统应该做什么的形式化陈述。属性作为人类可读规范和机器可验证正确性保证之间的桥梁。*


### 属性 1: 图片内容转换

*对于任意* 包含 ContentPart::Image 的消息，使用 content_converter 转换后应该产生对应的 ContentBlock::ImageUrl 或 ContentBlock::ImageBase64

**验证需求: 1.1**

### 属性 2: 视觉功能控制

*对于任意* 消息和模型配置，当 vision_enabled 为 true 时，转换结果应该包含图片内容；当 vision_enabled 为 false 时，转换结果应该不包含图片内容

**验证需求: 1.2, 1.3, 3.4, 3.5**

### 属性 3: Data URL 格式保持

*对于任意* 使用 data URL 格式的图片，转换后应该保持 data URL 格式不变

**验证需求: 1.4**

### 属性 4: 文本文件格式化

*对于任意* ContentPart::TextFile，转换后的文本应该包含文件名标识（📄 filename）和 markdown 代码块标记（```）

**验证需求: 2.1, 2.2, 2.3**

### 属性 5: PDF 文档交替块结构

*对于任意* ContentPart::PdfDocument，当 vision_enabled 为 true 时，转换后应该为每一页生成交替的文本块和图片块（文本、图片、文本、图片...）

**验证需求: 3.1, 3.2**

### 属性 6: PDF 页面文本内容

*对于任意* PDF 页面，转换后的文本块应该包含文件名、页码和页面文本内容

**验证需求: 3.3**

### 属性 7: ContentBlock 到 ResponsesInput 转换

*对于任意* ContentBlock 列表，转换为 ResponsesInput 后，所有文本块应该被合并到 content 字段中

**验证需求: 4.2, 4.4, 4.5**

### 属性 8: 多部分内容合并

*对于任意* 包含多个 ContentPart 的用户消息，转换后应该生成单个 ResponsesInput，其 content 字段包含所有部分的合并文本

**验证需求: 5.3**

### 属性 9: 助手消息文本提取

*对于任意* 包含多模态内容的助手消息，转换后应该只包含文本内容，忽略图片

**验证需求: 5.4**

## 错误处理

### 错误场景

1. **无效图片 URL**: 继续处理其他内容部分，不中断整个转换流程
2. **空 PDF 文档**: 跳过该文档，不生成任何块
3. **所有内容被过滤**: 如果所有内容部分都被跳过（例如禁用视觉时只有图片），返回错误
4. **转换异常**: 捕获并记录错误，尝试继续处理剩余内容

### 错误处理策略

```rust
// 伪代码示例
fn convert_content_parts(parts: &[ContentPart], vision_enabled: bool) -> Result<Vec<ContentBlock>, AiError> {
    let mut blocks = Vec::new();
    
    for part in parts {
        match content_part_to_blocks(part, vision_enabled) {
            Ok(part_blocks) => blocks.extend(part_blocks),
            Err(e) => {
                eprintln!("[OpenAI Responses] 内容转换错误: {}", e);
                // 继续处理下一个部分
                continue;
            }
        }
    }
    
    if blocks.is_empty() {
        return Err(AiError::InvalidRequest("没有有效的内容可发送".to_string()));
    }
    
    Ok(blocks)
}
```

## 测试策略

### 双重测试方法

本功能将采用单元测试和属性测试相结合的方式：

- **单元测试**: 验证特定示例、边缘情况和错误条件
- **属性测试**: 验证跨所有输入的通用属性

两者是互补的，都是全面覆盖所必需的。

### 单元测试重点

单元测试应该专注于：
- 特定示例（单张图片、单个文本文件、单页 PDF）
- 边缘情况（空内容、无效 URL、空 PDF）
- 错误条件（所有内容被过滤、转换失败）
- 组件集成点（content_converter 与 convert_messages 的集成）

避免编写过多的单元测试 - 属性测试会处理大量输入的覆盖。

### 属性测试配置

- **测试库**: 使用 `proptest` crate（项目已使用）
- **迭代次数**: 每个属性测试最少 100 次迭代
- **标签格式**: `// Feature: openai-responses-multimodal, Property N: [属性文本]`
- **一对一映射**: 每个正确性属性必须由单个属性测试实现

### 测试用例示例

#### 单元测试示例

```rust
#[test]
fn test_single_image_conversion() {
    let message = Message {
        content_parts: vec![
            ContentPart::text("分析这张图片"),
            ContentPart::image("data:image/png;base64,abc123"),
        ],
        // ... 其他字段
    };
    
    let (inputs, _) = convert_messages(&[message], None, true);
    
    assert_eq!(inputs.len(), 1);
    assert!(inputs[0].content.contains("分析这张图片"));
    // 验证图片内容被包含
}

#[test]
fn test_vision_disabled_skips_images() {
    let message = Message {
        content_parts: vec![
            ContentPart::text("文本"),
            ContentPart::image("data:image/png;base64,abc123"),
        ],
        // ... 其他字段
    };
    
    let (inputs, _) = convert_messages(&[message], None, false);
    
    assert_eq!(inputs.len(), 1);
    assert!(inputs[0].content.contains("文本"));
    // 验证图片内容被跳过
}
```

#### 属性测试示例

```rust
use proptest::prelude::*;

proptest! {
    // Feature: openai-responses-multimodal, Property 5: PDF 文档交替块结构
    #[test]
    fn prop_pdf_alternating_blocks(
        filename in "[a-zA-Z0-9_.-]{1,50}\\.pdf",
        pages in prop::collection::vec(arb_pdf_page(), 1..10)
    ) {
        let pdf_part = ContentPart::pdf_document(filename.clone(), pages.clone(), None);
        let message = Message {
            content_parts: vec![pdf_part],
            // ... 其他字段
        };
        
        let blocks = content_part_to_blocks(&message.content_parts[0], true);
        
        // 验证块数量 = 页数 * 2
        prop_assert_eq!(blocks.len(), pages.len() * 2);
        
        // 验证交替模式：文本、图片、文本、图片...
        for (i, block) in blocks.iter().enumerate() {
            if i % 2 == 0 {
                prop_assert!(matches!(block, ContentBlock::Text { .. }));
            } else {
                prop_assert!(matches!(block, ContentBlock::ImageUrl { .. }));
            }
        }
    }
}
```

### 测试覆盖目标

1. ✅ ContentPart 到 ContentBlock 的转换
2. ✅ ContentBlock 到 ResponsesInput 的转换
3. ✅ vision_enabled 配置的影响
4. ✅ PDF 文档的正确转换（属性测试）
5. ✅ 混合内容的处理
6. ✅ 错误场景的处理

## 实现注意事项

### 1. 与现有代码的集成

- 修改 `convert_messages` 函数时保持向后兼容
- 确保纯文本消息的处理逻辑不受影响
- 使用现有的 `content_converter` 模块，不重复实现

### 2. 性能考虑

- PDF 文档可能包含大量页面，注意内存使用
- 图片 data URL 可能很大，避免不必要的复制
- 使用迭代器和 `into_iter()` 减少内存分配

### 3. Responses API 的特殊限制

- `input` 数组中的 `content` 字段只支持纯文本
- 不支持像 Chat Completions API 那样的结构化内容数组
- 图片信息需要以某种文本形式表示（data URL 或描述）

### 4. 代码组织

```
openai_responses.rs
├── convert_messages() - 主转换函数
├── content_blocks_to_text() - 新增：ContentBlock 到文本的转换
├── chat() - 更新：传递 vision_enabled
├── chat_stream() - 更新：传递 vision_enabled
└── tests - 新增：单元测试和属性测试
```

## 未来扩展

1. **更好的图片支持**: 如果 Responses API 未来支持结构化内容，可以直接传递图片 URL
2. **图片压缩**: 对于大型图片，可以考虑压缩或调整大小
3. **PDF 元数据**: 利用 PDF 元数据提供更丰富的上下文
4. **流式处理**: 对于大型 PDF，考虑流式处理而非一次性加载所有页面
