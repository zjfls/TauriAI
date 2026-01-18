# 设计文档：紧凑附件预览

## 概述

本设计文档描述如何将 `InputArea` 组件从使用独立的 `TextFilePreview` 和 `PdfPreview` 组件迁移到统一使用 `AttachmentPreview` 组件。`AttachmentPreview` 组件已经实现了紧凑显示和展开功能，支持所有附件类型（图片、文本文件、PDF）。

主要变更：
- 移除 `InputArea` 中对 `TextFilePreview` 和 `PdfPreview` 的导入和使用
- 统一使用 `AttachmentPreview` 组件渲染所有附件类型
- 保持现有的附件管理逻辑（添加、移除、状态管理）
- 保持 PDF 调试模式功能

## 架构

### 组件层次结构

```
InputArea
├── AttachmentPreview (图片附件) ×N
├── AttachmentPreview (文本文件附件) ×N
└── AttachmentPreview (PDF 附件) ×N
```

### 数据流

1. **附件添加流程**：
   - 用户通过文件选择器、拖拽或粘贴添加附件
   - `InputArea` 将附件添加到对应的状态数组（`pendingImages`、`pendingTextFiles`、`pendingPdfs`）
   - `InputArea` 渲染 `AttachmentPreview` 组件，传递附件数据和类型

2. **附件展开/收起流程**：
   - 用户点击 `AttachmentPreview` 组件
   - `AttachmentPreview` 内部管理展开/收起状态（`isExpanded`）
   - 组件根据状态切换显示紧凑视图或展开视图

3. **附件移除流程**：
   - 用户点击 `AttachmentPreview` 的移除按钮
   - `AttachmentPreview` 调用 `onRemove` 回调，传递附件 ID
   - `InputArea` 从对应的状态数组中移除该附件

4. **PDF 调试模式流程**：
   - `InputArea` 通过 props 传递 `pdfDebugMode` 标志
   - `AttachmentPreview` 在展开模式下显示调试控件（如果 `pdfDebugMode` 为 true）
   - 用户修改页面范围或内容选项
   - `AttachmentPreview` 调用相应的回调函数更新 PDF 设置

## 组件和接口

### AttachmentPreview 组件（已存在）

**Props 接口**：
```typescript
interface AttachmentPreviewProps {
  attachment: PendingImage | PendingTextFile | PendingPdf;
  type: 'image' | 'text' | 'pdf';
  onRemove: (id: string) => void;
  pdfDebugMode?: boolean;
  onPdfPageRangeChange?: (id: string, startPage?: number, endPage?: number) => void;
  onPdfIncludeImagesChange?: (id: string, includeImages: boolean) => void;
  onPdfIncludeTextChange?: (id: string, includeText: boolean) => void;
}
```

**功能**：
- 根据 `type` 参数渲染不同类型的附件
- 默认显示紧凑视图（图标、文件名、大小）
- 点击后展开显示详细内容
- 提供移除按钮
- 支持 PDF 调试模式（页面范围选择、内容选项）

### InputArea 组件修改

**需要修改的部分**：

1. **导入语句**：
   - 移除：`import { TextFilePreview } from './TextFilePreview';`
   - 移除：`import { PdfPreview } from './PdfPreview';`
   - 添加：`import { AttachmentPreview } from './AttachmentPreview';`

2. **附件预览区域渲染**：
   - 将三个独立的预览区域（图片、文本文件、PDF）合并为一个统一的附件预览区域
   - 使用 `AttachmentPreview` 组件渲染所有附件

3. **PDF 调试模式支持**：
   - 添加 `pdfDebugMode` prop 到 `InputAreaProps`
   - 添加 PDF 页面范围和内容选项的回调函数
   - 在状态中管理 PDF 的页面范围和内容选项

**新增 Props**：
```typescript
interface InputAreaProps {
  // ... 现有 props
  pdfDebugMode?: boolean;  // 新增：PDF 调试模式标志
}
```

**新增状态管理函数**：
```typescript
// 处理 PDF 页面范围变更
const handlePdfPageRangeChange = useCallback((id: string, startPage?: number, endPage?: number) => {
  setPendingPdfs(prev => 
    prev.map(pdf => 
      pdf.id === id 
        ? { ...pdf, pageRangeStart: startPage, pageRangeEnd: endPage }
        : pdf
    )
  );
}, []);

// 处理 PDF 包含图片选项变更
const handlePdfIncludeImagesChange = useCallback((id: string, includeImages: boolean) => {
  setPendingPdfs(prev => 
    prev.map(pdf => 
      pdf.id === id 
        ? { ...pdf, includeImages }
        : pdf
    )
  );
}, []);

// 处理 PDF 包含文本选项变更
const handlePdfIncludeTextChange = useCallback((id: string, includeText: boolean) => {
  setPendingPdfs(prev => 
    prev.map(pdf => 
      pdf.id === id 
        ? { ...pdf, includeText }
        : pdf
    )
  );
}, []);
```

## 数据模型

### 附件类型定义（已存在）

```typescript
// 图片附件
interface PendingImage {
  id: string;
  url: string;  // Base64 data URL
  file?: File;
}

// 文本文件附件
interface PendingTextFile {
  id: string;
  filename: string;
  content: string;
  size: number;
}

// PDF 附件
interface PendingPdf {
  id: string;
  filename: string;
  size: number;
  totalPages: number;
  pages: Array<{
    pageNumber: number;
    image: string;  // Base64 data URL
  }>;
  metadata?: {
    title?: string;
    author?: string;
  };
  processingProgress: number;
  pageRangeStart?: number;  // 调试模式：起始页
  pageRangeEnd?: number;    // 调试模式：结束页
  includeImages?: boolean;  // 调试模式：是否包含图片
  includeText?: boolean;    // 调试模式：是否包含文本
}
```

## 正确性属性

*属性是一个特征或行为，应该在系统的所有有效执行中保持为真。属性是人类可读规范和机器可验证正确性保证之间的桥梁。*

### 属性 1：紧凑模式初始状态

*对于任意*附件类型（图片、文本文件、PDF），当附件首次添加到输入区域时，应该以紧凑模式显示，包含文件类型图标、文件名、文件大小和向右箭头图标。

**验证需求：2.1, 2.2, 2.3**

### 属性 2：展开-收起往返

*对于任意*附件，点击紧凑模式应该展开显示详细内容，点击展开模式的头部应该收起回到紧凑模式，形成完整的往返操作。

**验证需求：3.1, 3.3**

### 属性 3：展开模式箭头指示

*对于任意*处于展开模式的附件，应该显示向下箭头图标指示可以收起。

**验证需求：3.2**

### 属性 4：文本内容截断

*对于任意*文本文件附件，当展开显示时，如果内容长度超过 500 字符，应该截断并显示截断指示符。

**验证需求：3.5**

### 属性 5：移除按钮可用性

*对于任意*附件，无论处于紧凑模式还是展开模式，悬停时都应该显示移除按钮，点击移除按钮应该从附件列表中移除该附件。

**验证需求：4.1, 4.2, 4.3**

### 属性 6：PDF 设置更新

*对于任意*PDF 附件，当用户修改页面范围、"包含图片"选项或"包含文本"选项时，系统应该更新该 PDF 附件的相应设置。

**验证需求：5.3, 5.4, 5.5**

## 错误处理

### 附件类型错误

如果传递给 `AttachmentPreview` 的附件类型与 `type` 参数不匹配，组件应该：
- 在开发模式下输出警告信息
- 尝试根据附件对象的结构推断正确的类型
- 如果无法推断，显示通用的文件图标和基本信息

### PDF 调试模式参数错误

如果用户在 PDF 调试模式下输入无效的页面范围（例如起始页大于结束页，或页码超出范围），组件应该：
- 不更新 PDF 设置
- 保持输入框中的无效值（允许用户继续编辑）
- 不显示错误消息（静默忽略无效输入）

### 移除回调错误

如果 `onRemove` 回调函数抛出错误，组件应该：
- 捕获错误并在控制台输出
- 不影响组件的正常显示
- 允许用户重试移除操作

## 测试策略

### 单元测试

使用 React Testing Library 和 Vitest 进行单元测试：

1. **AttachmentPreview 组件测试**（已存在）：
   - 测试不同类型附件的渲染
   - 测试紧凑模式和展开模式的切换
   - 测试移除按钮的功能
   - 测试 PDF 调试模式的控件

2. **InputArea 组件测试**（需要更新）：
   - 测试使用 AttachmentPreview 渲染图片附件
   - 测试使用 AttachmentPreview 渲染文本文件附件
   - 测试使用 AttachmentPreview 渲染 PDF 附件
   - 测试附件移除功能
   - 测试 PDF 调试模式的回调函数

3. **集成测试**：
   - 测试添加多个不同类型的附件
   - 测试展开多个附件
   - 测试移除部分附件后的状态
   - 测试 PDF 调试模式的完整流程

### 属性测试

由于这是 UI 组件的重构，主要通过单元测试和集成测试来验证正确性。属性测试可以应用于：

1. **属性 1：紧凑模式初始状态**
   - 生成随机的附件数据（不同类型、不同大小、不同文件名）
   - 验证所有附件初始都以紧凑模式显示
   - 验证紧凑模式包含必要的元素

2. **属性 2：展开-收起往返**
   - 生成随机的附件数据
   - 执行展开-收起操作
   - 验证状态正确往返

3. **属性 4：文本内容截断**
   - 生成不同长度的文本内容（包括短于、等于、长于 500 字符）
   - 验证截断逻辑正确应用

4. **属性 5：移除按钮可用性**
   - 生成随机的附件列表
   - 随机选择附件进行移除
   - 验证移除后列表状态正确

5. **属性 6：PDF 设置更新**
   - 生成随机的 PDF 附件和设置值
   - 验证设置更新正确应用

### 测试配置

- 每个属性测试运行至少 100 次迭代
- 使用 `@testing-library/react` 进行组件渲染和交互
- 使用 `@testing-library/user-event` 模拟用户操作
- 每个测试使用注释标记对应的设计属性：
  ```typescript
  // Feature: compact-attachment-preview, Property 1: 紧凑模式初始状态
  ```

### 视觉回归测试

虽然不在本次实现范围内，但建议未来添加视觉回归测试：
- 使用 Storybook 创建不同状态的组件故事
- 使用 Chromatic 或类似工具进行视觉快照对比
- 验证紧凑模式和展开模式的视觉一致性
- 验证深色模式的正确显示

