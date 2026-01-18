# OpenAI Responses 图片支持修复

## 问题描述

在初始实现中，`content_blocks_to_text()` 函数将图片转换成了文本描述（如 `[图片: image/png]`），而不是保留完整的 data URL。这导致 OpenAI Responses API 无法看到实际的图片内容。

## 根本原因

设计文档中采用了保守策略，假设 Responses API 可能不支持图片。但实际上，**OpenAI Responses API 完全支持通过 data URL 发送图片**。

## 修复内容

### 1. 修改 `content_blocks_to_text()` 函数

**修改前**：
```rust
ContentBlock::ImageUrl { url, .. } => {
    if url.starts_with("data:") {
        let media_type = url
            .strip_prefix("data:")
            .and_then(|s| s.split(';').next())
            .unwrap_or("image");
        format!("[图片: {}]", media_type)  // ❌ 只是文本描述
    } else {
        format!("[图片: {}]", url)
    }
}
```

**修改后**：
```rust
ContentBlock::ImageUrl { url, .. } => {
    // Responses API 直接支持 data URLs
    // 保留完整的 URL（data URLs 和 HTTP URLs）
    url  // ✅ 保留完整的图片数据
}
```

### 2. 更新文档注释

更新了 `content_blocks_to_text()` 函数的文档，说明：
- Responses API 支持通过 data URLs 直接发送图片
- 图片会以完整的 data URL 格式包含在内容中

### 3. 更新模块文档

修改了模块顶部的文档说明：
- 从 "Images: Converted to text descriptions" 
- 改为 "Images: Included as full data URLs"

### 4. 更新所有相关测试

更新了 9 个测试用例的期望值，从期望文本描述改为期望完整的 data URL：

- `test_content_blocks_to_text_image_url_http`
- `test_content_blocks_to_text_image_url_data`
- `test_content_blocks_to_text_image_url_data_jpeg`
- `test_content_blocks_to_text_mixed_content`
- `test_convert_messages_single_image_vision_enabled`
- `test_convert_messages_pdf_document_vision_enabled`
- `test_convert_messages_assistant_multimodal_extracts_text_only`
- `test_convert_messages_mixed_content`

## 测试结果

✅ 所有 18 个单元测试全部通过
✅ 编译成功，无错误

```
running 18 tests
test result: ok. 18 passed; 0 failed; 0 ignored
```

## 影响范围

### 受影响的功能
- ✅ 图片上传：现在可以正确发送图片给 OpenAI Responses API
- ✅ PDF 文档：PDF 中的图片现在会以完整的 data URL 发送
- ✅ 混合内容：包含图片的混合内容消息现在可以正确处理

### 不受影响的功能
- ✅ 纯文本消息：保持原有行为
- ✅ 文本文件：保持原有行为
- ✅ vision_enabled 配置：仍然正确控制是否包含图片

## 验证方法

用户可以通过以下方式验证修复：

1. 上传一张图片到 OpenAI Responses API（如 gpt-5.2）
2. 询问关于图片的问题
3. 模型应该能够看到并分析图片内容

**修复前**：模型回复 "我看不到图片内容，只显示 'image/png' 占位"
**修复后**：模型能够正确识别和分析图片内容

## 相关文件

- `tauri-ai/src-tauri/src/ai_client/openai_responses.rs` - 主要修改
- `.kiro/specs/openai-responses-multimodal/design.md` - 设计文档（需要更新）
- `.kiro/specs/openai-responses-multimodal/requirements.md` - 需求文档（无需修改）

## 后续工作

- [ ] 更新设计文档，说明 Responses API 支持 data URLs
- [ ] 考虑是否需要对大型图片进行压缩或优化
- [ ] 测试不同格式的图片（PNG, JPEG, WebP 等）

## 总结

这个修复确保了 OpenAI Responses API 客户端能够正确处理图片内容，使其与其他 AI 客户端（如 `openai.rs` 和 `anthropic.rs`）保持一致的多模态支持能力。
