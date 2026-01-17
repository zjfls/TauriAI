# PDF 多模态序列化问题修复

## 问题描述

用户在使用 PDF 多模态功能时遇到错误：

```
invalid args `contentParts` for command `chat_stream`: missing field `page_number`
```

## 根本原因

前端（TypeScript）和后端（Rust）之间的字段命名约定不一致：

### 前端（TypeScript）- 使用 camelCase
```typescript
export interface PdfPage {
  pageNumber: number;      // camelCase
  text: string;
  image: string;
}

export interface PdfMetadata {
  createdAt?: string;      // camelCase
  // ...
}

export interface PdfDocumentContentPart {
  totalPages: number;      // camelCase
  // ...
}
```

### 后端（Rust）- 使用 snake_case
```rust
pub struct PdfPage {
    pub page_number: u32,    // snake_case
    pub text: String,
    pub image: String,
}

pub struct PdfMetadata {
    pub created_at: Option<String>,  // snake_case
    // ...
}

pub enum ContentPart {
    PdfDocument {
        total_pages: u32,    // snake_case
        // ...
    },
}
```

当前端发送 JSON 数据到后端时，字段名是 `pageNumber`，但 Rust 期望的是 `page_number`，导致反序列化失败。

## 解决方案

在 Rust 结构体上添加 `#[serde(rename_all = "camelCase")]` 属性，使其能够正确处理 camelCase 格式的 JSON：

### 1. PdfPage 结构体
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]  // 新增
pub struct PdfPage {
    pub page_number: u32,  // 序列化为 "pageNumber"
    pub text: String,
    pub image: String,
}
```

### 2. PdfMetadata 结构体
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]  // 新增
pub struct PdfMetadata {
    pub created_at: Option<String>,  // 序列化为 "createdAt"
    // ...
}
```

### 3. ContentPart 枚举的 total_pages 字段
```rust
pub enum ContentPart {
    PdfDocument {
        filename: String,
        pages: Vec<PdfPage>,
        #[serde(rename = "totalPages")]  // 新增
        total_pages: u32,
        metadata: Option<PdfMetadata>,
    },
}
```

## 修改文件

- `src-tauri/src/models.rs`
  - 为 `PdfPage` 添加 `#[serde(rename_all = "camelCase")]`
  - 为 `PdfMetadata` 添加 `#[serde(rename_all = "camelCase")]`
  - 为 `ContentPart::PdfDocument::total_pages` 添加 `#[serde(rename = "totalPages")]`
  - 更新相关测试以使用 camelCase

## 测试结果

所有 54 个测试通过：

```
test result: ok. 54 passed; 0 failed; 0 ignored; 0 measured
```

包括：
- PDF 序列化/反序列化测试
- PDF 元数据测试
- Property-based 测试
- 所有 AI 客户端测试

## 影响范围

此修复确保了前后端数据格式的一致性，解决了 PDF 多模态功能的序列化问题。修改是向后兼容的，因为：

1. Rust 内部仍使用 snake_case 字段名
2. 只有序列化/反序列化时才转换为 camelCase
3. 所有现有测试通过

## 验证方法

1. 编译项目：`cargo build`
2. 运行测试：`cargo test --package tauri-ai --lib`
3. 在应用中上传 PDF 文件并发送消息
4. 确认不再出现 "missing field" 错误
