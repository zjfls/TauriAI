# PDF 分析功能修复

## 问题描述

在分析 PDF 文件时出现错误：
```
invalid args `contentParts` for command `chat_stream`: missing field `page_number`
```

## 根本原因

前后端序列化字段命名不一致：
- **前端 TypeScript**：使用驼峰命名 `pageNumber`、`totalPages`、`createdAt` 等
- **后端 Rust**：使用蛇形命名 `page_number`、`total_pages`、`created_at` 等

当前端发送 PDF 数据时，JSON 中的字段是驼峰命名，但后端 Serde 反序列化期望蛇形命名，导致反序列化失败。

## 解决方案

在后端 Rust 代码中添加 Serde 属性，让其自动处理驼峰和蛇形命名的转换：

### 1. `PdfPage` 结构体
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]  // 添加此行
pub struct PdfPage {
    pub page_number: u32,  // 序列化为 pageNumber
    pub text: String,
    pub image: String,
}
```

### 2. `PdfMetadata` 结构体
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]  // 添加此行
pub struct PdfMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub created_at: Option<String>,  // 序列化为 createdAt
    // ...
}
```

### 3. `ContentPart::PdfDocument` 变体
```rust
PdfDocument {
    filename: String,
    pages: Vec<PdfPage>,
    #[serde(rename = "totalPages")]  // 添加此行
    total_pages: u32,
    metadata: Option<PdfMetadata>,
}
```

## 测试验证

所有相关测试已更新并通过：
- ✅ `test_pdf_document_serialization_format` - 验证序列化格式
- ✅ `test_pdf_document_deserialization` - 验证反序列化
- ✅ `test_pdf_document_with_metadata_serialization` - 验证元数据序列化
- ✅ `prop_content_part_pdf_document_roundtrip` - 属性测试验证往返转换

## 影响范围

此修复确保前后端 PDF 数据交换的兼容性，不影响其他功能。

## 修改文件

- `tauri-ai/src-tauri/src/models.rs` - 添加 Serde 重命名属性和更新测试
