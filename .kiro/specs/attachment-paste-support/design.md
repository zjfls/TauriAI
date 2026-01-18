# 设计文档：附件复制粘贴功能

## 概述

本设计文档描述了如何扩展 TauriAI 聊天应用的附件粘贴功能，以支持 PDF 文件的复制粘贴，并改进整体的粘贴体验。当前系统已经支持图片和文本文件的粘贴，本设计将在现有基础上添加 PDF 支持，并优化多文件粘贴、错误处理和用户反馈机制。

### 设计目标

1. 扩展 `handlePaste` 函数以支持 PDF 文件
2. 改进多文件粘贴时的处理逻辑
3. 增强错误处理和用户反馈
4. 确保遵守文件数量限制
5. 保持与现有附件系统的一致性

## 架构

### 当前架构

InputArea 组件已经实现了以下功能：

```
InputArea Component
├── handlePaste (处理粘贴事件)
│   ├── 检测图片文件 (image/*)
│   ├── 检测文本文件 (通过 isSupportedTextFile)
│   └── 调用相应的处理函数
├── handleImageSelect (处理图片文件)
├── handleTextFileSelect (处理文本文件)
└── handlePdfSelect (处理 PDF 文件) - 已存在但未在 handlePaste 中调用
```

### 扩展架构

```
InputArea Component
├── handlePaste (扩展版本)
│   ├── 检测图片文件 (image/*)
│   ├── 检测文本文件 (通过 isSupportedTextFile)
│   ├── 检测 PDF 文件 (application/pdf) ← 新增
│   ├── 批量处理多个文件 ← 改进
│   └── 统一错误处理 ← 改进
├── handleImageSelect
├── handleTextFileSelect
├── handlePdfSelect
└── validatePasteFiles (新增辅助函数)
    ├── 验证文件类型
    ├── 验证文件数量限制
    └── 返回验证结果
```

## 组件和接口

### 1. handlePaste 函数扩展

**当前签名：**
```typescript
const handlePaste = useCallback((e: React.ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  const imageFiles: File[] = [];
  const textFiles: File[] = [];
  
  // 处理逻辑...
}, [supportsVision, handleImageSelect, handleTextFileSelect, createFileList]);
```

**扩展后签名：**
```typescript
const handlePaste = useCallback((e: React.ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  const imageFiles: File[] = [];
  const textFiles: File[] = [];
  const pdfFiles: File[] = []; // 新增
  
  // 处理逻辑...
}, [supportsVision, handleImageSelect, handleTextFileSelect, handlePdfSelect, createFileList]);
```

### 2. 文件分类逻辑

**伪代码：**
```
function classifyPastedFiles(items: DataTransferItemList):
  imageFiles = []
  textFiles = []
  pdfFiles = []
  
  for each item in items:
    file = item.getAsFile()
    if file is null:
      continue
    
    if item.type starts with "image/" AND supportsVision:
      imageFiles.append(file)
    else if item.type equals "application/pdf" OR file.name ends with ".pdf":
      pdfFiles.append(file)
    else if isSupportedTextFile(file.name):
      textFiles.append(file)
    // 不支持的文件类型会被静默忽略
  
  return (imageFiles, textFiles, pdfFiles)
```

### 3. 文件数量验证

**新增辅助函数：**
```typescript
interface PasteValidationResult {
  canProceed: boolean;
  imageFiles: File[];
  textFiles: File[];
  pdfFiles: File[];
  errors: string[];
}

function validatePasteFiles(
  imageFiles: File[],
  textFiles: File[],
  pdfFiles: File[],
  currentImageCount: number,
  currentTextFileCount: number,
  currentPdfCount: number,
  supportsVision: boolean
): PasteValidationResult
```

**验证逻辑伪代码：**
```
function validatePasteFiles(...):
  errors = []
  validImageFiles = []
  validTextFiles = []
  validPdfFiles = []
  
  // 验证图片文件
  if supportsVision:
    remainingImageSlots = MAX_IMAGE_COUNT - currentImageCount
    if imageFiles.length > remainingImageSlots:
      errors.append("图片数量超过限制")
      validImageFiles = imageFiles[0:remainingImageSlots]
    else:
      validImageFiles = imageFiles
  else if imageFiles.length > 0:
    errors.append("当前模型不支持图片")
  
  // 验证文本文件
  remainingTextSlots = MAX_TEXT_FILE_COUNT - currentTextFileCount
  if textFiles.length > remainingTextSlots:
    errors.append("文本文件数量超过限制")
    validTextFiles = textFiles[0:remainingTextSlots]
  else:
    validTextFiles = textFiles
  
  // 验证 PDF 文件
  remainingPdfSlots = MAX_PDF_COUNT - currentPdfCount
  if pdfFiles.length > remainingPdfSlots:
    errors.append("PDF 文件数量超过限制")
    validPdfFiles = pdfFiles[0:remainingPdfSlots]
  else:
    validPdfFiles = pdfFiles
  
  canProceed = (validImageFiles.length > 0 OR 
                validTextFiles.length > 0 OR 
                validPdfFiles.length > 0)
  
  return {
    canProceed,
    imageFiles: validImageFiles,
    textFiles: validTextFiles,
    pdfFiles: validPdfFiles,
    errors
  }
```

### 4. 错误处理和用户反馈

**错误状态管理：**
```typescript
// 现有状态
const [fileError, setFileError] = useState<string | null>(null);
const [pdfError, setPdfError] = useState<string | null>(null);

// 建议：统一错误状态（可选优化）
interface AttachmentError {
  type: 'image' | 'text' | 'pdf' | 'general';
  message: string;
  timestamp: number;
}

const [attachmentErrors, setAttachmentErrors] = useState<AttachmentError[]>([]);
```

**错误消息常量：**
```typescript
const PASTE_ERROR_MESSAGES = {
  IMAGE_NOT_SUPPORTED: '当前模型不支持图片',
  IMAGE_LIMIT_EXCEEDED: '图片数量已达上限',
  TEXT_FILE_LIMIT_EXCEEDED: '文本文件数量已达上限',
  PDF_LIMIT_EXCEEDED: 'PDF 文件数量已达上限',
  PDF_INVALID_TYPE: '只支持 PDF 文件',
  PDF_TOO_LARGE: (maxSize: number) => `PDF 文件过大，请选择小于 ${maxSize}MB 的文件`,
  MIXED_LIMIT_EXCEEDED: '部分文件因数量限制未能添加',
  NO_SUPPORTED_FILES: '未检测到支持的文件类型',
} as const;
```

## 数据模型

### ClipboardEvent 数据流

```
ClipboardEvent
└── clipboardData: DataTransfer
    └── items: DataTransferItemList
        └── DataTransferItem[]
            ├── type: string (MIME type)
            ├── kind: "file" | "string"
            └── getAsFile(): File | null
```

### 文件类型检测

```typescript
interface FileTypeDetection {
  // 图片检测
  isImage: (mimeType: string) => boolean;
  // mimeType.startsWith('image/')
  
  // PDF 检测
  isPdf: (mimeType: string, filename: string) => boolean;
  // mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')
  
  // 文本文件检测
  isTextFile: (filename: string) => boolean;
  // 使用现有的 isSupportedTextFile 函数
}
```

### 粘贴处理流程

```
用户粘贴
    ↓
获取 ClipboardEvent.clipboardData.items
    ↓
遍历 DataTransferItem[]
    ↓
分类文件（图片/文本/PDF）
    ↓
验证文件数量和类型
    ↓
┌─────────────┬─────────────┬─────────────┐
│  图片文件   │  文本文件   │  PDF 文件   │
└─────────────┴─────────────┴─────────────┘
    ↓              ↓              ↓
handleImageSelect  handleTextFileSelect  handlePdfSelect
    ↓              ↓              ↓
更新 pendingImages  更新 pendingTextFiles  更新 pendingPdfs
    ↓              ↓              ↓
显示预览和错误消息（如有）
```

## Correctness Properties

*属性（Property）是关于系统行为的特征或规则，应该在所有有效执行中保持为真。属性是人类可读规范和机器可验证正确性保证之间的桥梁。*


### 属性 1：PDF 文件粘贴添加
*对于任意* PDF 文件，当用户将其粘贴到输入区域时，该文件应该被添加到 pendingPdfs 列表中，并在附件预览区域显示。
**验证需求：1.1, 1.2, 1.4**

### 属性 2：文件数量限制遵守
*对于任意* 文件粘贴操作，当现有附件数量加上待粘贴文件数量超过限制时，系统应该只添加允许范围内的文件，并拒绝超出部分。
**验证需求：1.3, 2.2, 6.2, 6.3**

### 属性 3：多文件顺序处理
*对于任意* 多文件粘贴操作，所有成功添加的文件应该按照粘贴顺序出现在附件列表中，并在 UI 中显示。
**验证需求：2.1, 2.4**

### 属性 4：不支持文件类型过滤
*对于任意* 包含混合文件类型的粘贴操作，系统应该只添加支持的文件类型（图片、文本、PDF），并静默跳过不支持的文件类型。
**验证需求：2.3, 3.5**

### 属性 5：支持的文件类型接受
*对于任意* 支持的文件类型（图片当 supportsVision=true、文本文件、PDF），粘贴时应该被系统接受并添加到相应的附件列表。
**验证需求：3.1, 3.2, 3.3, 3.4**

### 属性 6：文件类型错误反馈
*对于任意* 不支持的文件类型粘贴操作，系统应该显示相应的错误提示信息。
**验证需求：4.1**

### 属性 7：数量限制错误反馈
*对于任意* 在附件数量已达上限时的粘贴操作，系统应该显示文件数量限制的错误提示。
**验证需求：4.2**

### 属性 8：文件读取错误处理
*对于任意* 文件读取失败的情况，系统应该捕获错误并显示友好的错误消息，而不是崩溃。
**验证需求：4.3**

### 属性 9：纯文本粘贴保持默认行为
*对于任意* 不包含文件的纯文本粘贴操作，系统应该保持默认的文本粘贴行为（不调用 preventDefault）。
**验证需求：5.1**

### 属性 10：文件粘贴阻止默认行为
*对于任意* 包含文件的粘贴操作，系统应该阻止默认行为（调用 preventDefault）并处理文件。
**验证需求：5.2**

### 属性 11：文件优先于文本
*对于任意* 同时包含文件和文本的粘贴操作，系统应该优先处理文件。
**验证需求：5.3**

### 属性 12：添加前验证数量限制
*对于任意* 文件添加操作，系统应该在添加每个文件前验证当前附件数量加上待添加文件数量不超过限制。
**验证需求：6.1, 6.4**

### 属性 13：部分失败继续处理
*对于任意* 多文件粘贴操作，当某个文件的 getAsFile() 返回 null 时，系统应该跳过该文件并继续处理其他文件。
**验证需求：7.4**

## 错误处理

### 错误类型

1. **文件类型错误**
   - 不支持的文件类型
   - 图片文件但模型不支持视觉功能
   - 错误消息：使用 `PASTE_ERROR_MESSAGES` 常量

2. **文件数量错误**
   - 超过图片数量限制
   - 超过文本文件数量限制
   - 超过 PDF 文件数量限制
   - 错误消息：明确指出哪种类型的文件达到上限

3. **文件大小错误**
   - PDF 文件超过大小限制
   - 图片文件超过大小限制
   - 错误消息：显示当前文件大小和允许的最大大小

4. **文件读取错误**
   - 文件读取失败
   - PDF 处理失败
   - 错误消息：显示友好的错误描述，避免技术细节

### 错误处理策略

```typescript
// 错误处理流程
try {
  // 1. 验证文件类型和数量
  const validation = validatePasteFiles(...);
  
  if (!validation.canProceed) {
    // 显示所有错误消息
    setAttachmentErrors(validation.errors);
    return;
  }
  
  // 2. 处理有效文件
  await processValidFiles(validation);
  
  // 3. 如果有警告（部分文件被跳过），显示警告
  if (validation.errors.length > 0) {
    setAttachmentErrors(validation.errors);
  }
} catch (error) {
  // 4. 捕获未预期的错误
  console.error('Paste handling error:', error);
  setAttachmentErrors([{
    type: 'general',
    message: '粘贴文件时发生错误，请重试',
    timestamp: Date.now()
  }]);
}
```

### 错误恢复

1. **部分成功处理**：当多文件粘贴时部分文件失败，成功的文件仍应被添加
2. **错误清除**：当用户进行新的操作时，清除之前的错误消息
3. **重试机制**：允许用户在错误后重新尝试粘贴

## 测试策略

### 双重测试方法

本功能将采用单元测试和属性测试相结合的方法：

- **单元测试**：验证特定示例、边界条件和错误情况
- **属性测试**：验证通用属性在所有输入下的正确性

两者互补，共同确保全面覆盖。

### 单元测试重点

单元测试应专注于：

1. **特定示例**
   - 粘贴单个 PDF 文件
   - 粘贴多个不同类型的文件
   - 粘贴纯文本内容

2. **边界条件**
   - 附件数量刚好达到上限
   - 粘贴文件数量刚好等于剩余槽位
   - 空的粘贴事件（无 clipboardData）

3. **错误条件**
   - 不支持的文件类型
   - 文件大小超限
   - 文件读取失败
   - getAsFile() 返回 null

4. **集成点**
   - handlePaste 与 handlePdfSelect 的集成
   - 错误状态与 UI 渲染的集成

### 属性测试配置

**测试库选择**：使用 `@fast-check/jest` 进行属性测试（TypeScript/React 项目标准）

**配置要求**：
- 每个属性测试最少运行 100 次迭代
- 每个测试必须引用设计文档中的属性
- 标签格式：`Feature: attachment-paste-support, Property {number}: {property_text}`

**属性测试重点**：

1. **属性 1-5**：文件处理正确性
   - 生成随机文件类型、数量、大小
   - 验证分类、过滤、添加逻辑

2. **属性 6-8**：错误处理
   - 生成各种错误场景
   - 验证错误消息正确显示

3. **属性 9-11**：事件处理
   - 生成不同的粘贴事件组合
   - 验证 preventDefault 调用时机

4. **属性 12-13**：边界和恢复
   - 生成边界条件
   - 验证验证逻辑和错误恢复

### 测试数据生成器

```typescript
// 用于属性测试的生成器
const fileGenerators = {
  // 生成随机 PDF 文件
  pdfFile: fc.record({
    name: fc.string().map(s => `${s}.pdf`),
    type: fc.constant('application/pdf'),
    size: fc.integer({ min: 1024, max: MAX_PDF_SIZE }),
  }),
  
  // 生成随机图片文件
  imageFile: fc.record({
    name: fc.string().map(s => `${s}.jpg`),
    type: fc.constantFrom('image/jpeg', 'image/png', 'image/gif'),
    size: fc.integer({ min: 1024, max: 20 * 1024 * 1024 }),
  }),
  
  // 生成随机文本文件
  textFile: fc.record({
    name: fc.string().map(s => `${s}.txt`),
    type: fc.constant('text/plain'),
    size: fc.integer({ min: 1, max: 1024 * 1024 }),
  }),
  
  // 生成不支持的文件
  unsupportedFile: fc.record({
    name: fc.string().map(s => `${s}.exe`),
    type: fc.constant('application/x-msdownload'),
    size: fc.integer({ min: 1024, max: 10 * 1024 * 1024 }),
  }),
  
  // 生成混合文件列表
  mixedFiles: fc.array(
    fc.oneof(
      fileGenerators.pdfFile,
      fileGenerators.imageFile,
      fileGenerators.textFile,
      fileGenerators.unsupportedFile
    ),
    { minLength: 1, maxLength: 10 }
  ),
};
```

### 测试覆盖目标

- 代码覆盖率：> 90%
- 分支覆盖率：> 85%
- 属性测试迭代：每个属性 ≥ 100 次
- 单元测试：覆盖所有边界条件和错误路径

## 实现注意事项

### 1. 性能考虑

- 文件分类应该在单次遍历中完成
- 避免不必要的文件读取操作
- 使用 `useCallback` 优化事件处理函数

### 2. 兼容性

- 确保 ClipboardEvent API 在目标浏览器中可用
- 处理不同浏览器对 MIME 类型的差异
- 考虑文件名扩展名作为类型检测的后备方案

### 3. 用户体验

- 提供即时的视觉反馈
- 错误消息应该清晰、可操作
- 支持批量操作以提高效率
- 保持与现有附件系统的一致性

### 4. 代码组织

- 将文件验证逻辑提取为独立函数
- 使用常量管理错误消息
- 保持 handlePaste 函数的可读性
- 添加详细的代码注释

### 5. 向后兼容

- 不破坏现有的图片和文本文件粘贴功能
- 保持现有的 API 和状态结构
- 确保现有测试继续通过
