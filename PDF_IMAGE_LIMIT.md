# PDF 图片数量限制功能

## 功能描述

当用户同时上传图片和 PDF 文件时，如果总图片数量超过模型的 `maxImages` 限制，系统会自动跳过 PDF 中的图片，只发送 PDF 的文本内容，以确保独立上传的图片能够被处理。

## 实现逻辑

### 1. 图片数量计算
- **独立图片**：用户直接上传的图片文件
- **PDF 图片**：PDF 文档中每一页渲染的图片

### 2. 限制规则
```
总图片数 = 独立图片数 + PDF 图片数

如果 总图片数 > maxImages 且 独立图片数 <= maxImages:
    跳过 PDF 图片，只发送 PDF 文本
否则:
    正常发送所有图片
```

### 3. 默认值
- 如果模型未配置 `maxImages`，默认值为 **10**

## 代码修改

### 后端 Rust

#### 1. Model 结构添加 `max_images` 字段
**文件**: `tauri-ai/src-tauri/src/models.rs`

```rust
pub struct Model {
    pub name: String,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub context_length: Option<u32>,
    pub capabilities: ModelCapabilities,
    pub max_images: Option<u32>,  // 新增字段
}
```

#### 2. ModelConfig 结构添加 `max_images` 字段
**文件**: `tauri-ai/src-tauri/src/models.rs`

```rust
pub struct ModelConfig {
    // ... 其他字段
    pub vision_enabled: bool,
    pub max_images: Option<u32>,  // 新增字段
}
```

#### 3. 新增图片限制逻辑
**文件**: `tauri-ai/src-tauri/src/ai_client/content_converter.rs`

新增函数 `content_parts_to_blocks_with_limit`:
- 统计独立图片和 PDF 图片数量
- 根据 `max_images` 限制决定是否跳过 PDF 图片
- 返回转换后的内容块和是否跳过 PDF 图片的标志

```rust
pub fn content_parts_to_blocks_with_limit(
    parts: &[ContentPart],
    include_images: bool,
    max_images: Option<u32>,
) -> (Vec<ContentBlock>, bool)
```

#### 4. 更新 Anthropic 客户端
**文件**: `tauri-ai/src-tauri/src/ai_client/anthropic.rs`

修改 `convert_messages` 函数：
- 添加 `max_images` 参数
- 使用 `content_parts_to_blocks_with_limit` 替代原有逻辑
- 记录是否跳过 PDF 图片的日志

#### 5. 更新 chat_stream 命令
**文件**: `tauri-ai/src-tauri/src/commands/chat.rs`

在创建 `ModelConfig` 时传递 `max_images`:
```rust
let model_config = ModelConfig {
    // ... 其他字段
    vision_enabled: model.capabilities.vision,
    max_images: model.max_images,  // 从 Model 获取
};
```

### 前端 TypeScript

前端的 `Model` 接口已经包含 `maxImages` 字段（在 `types/index.ts` 中），无需修改。

## 使用示例

### 配置模型的最大图片数
在配置文件中为模型设置 `maxImages`:

```json
{
  "providers": [
    {
      "name": "anthropic",
      "models": [
        {
          "name": "claude-3-5-sonnet-20241022",
          "temperature": 0.7,
          "maxImages": 5,
          "capabilities": {
            "vision": true
          }
        }
      ]
    }
  ]
}
```

### 行为示例

**场景 1**: 用户上传 3 张图片 + 1 个 5 页的 PDF，模型 `maxImages = 10`
- 总图片数 = 3 + 5 = 8 ≤ 10
- **结果**: 发送所有图片（3 张独立图片 + 5 张 PDF 图片）

**场景 2**: 用户上传 8 张图片 + 1 个 5 页的 PDF，模型 `maxImages = 10`
- 总图片数 = 8 + 5 = 13 > 10
- 独立图片数 = 8 ≤ 10
- **结果**: 发送 8 张独立图片 + PDF 文本（跳过 PDF 图片）

**场景 3**: 用户上传 12 张图片 + 1 个 5 页的 PDF，模型 `maxImages = 10`
- 总图片数 = 12 + 5 = 17 > 10
- 独立图片数 = 12 > 10
- **结果**: 发送所有图片（超出限制，由 API 处理错误）

## 日志输出

当 PDF 图片被跳过时，后端会输出日志：
```
[Anthropic] PDF images skipped due to max_images limit
```

## 测试验证

所有相关测试已更新并通过：
- ✅ 54 个单元测试全部通过
- ✅ 编译成功无警告（除了未使用的辅助函数）
- ✅ PDF 序列化/反序列化测试通过
- ✅ Anthropic 客户端测试通过

## 注意事项

1. **默认值**: 如果模型未配置 `maxImages`，默认为 10
2. **优先级**: 独立上传的图片优先级高于 PDF 图片
3. **文本保留**: 即使跳过 PDF 图片，PDF 的文本内容仍会发送
4. **向后兼容**: 未配置 `maxImages` 的模型不受影响
