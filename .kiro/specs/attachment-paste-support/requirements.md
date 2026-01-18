# 需求文档

## 介绍

本功能旨在增强 TauriAI 聊天应用的附件添加体验，通过支持复制粘贴方式添加附件（包括图片、文本文件和 PDF 文件），使用户能够更快速、更直观地分享文件内容。当前系统已支持图片和文本文件的粘贴，本需求将扩展 PDF 文件支持，并改进整体粘贴体验。

## 术语表

- **InputArea**: 聊天输入区域组件，负责处理用户输入和附件管理
- **ClipboardEvent**: 浏览器提供的剪贴板事件 API
- **Attachment**: 附件，包括图片、文本文件和 PDF 文件
- **Vision_Support**: 视觉支持功能，决定是否允许粘贴图片文件
- **File_Limit**: 文件数量限制，控制可添加的最大附件数量

## 需求

### 需求 1: PDF 文件粘贴支持

**用户故事:** 作为用户，我希望能够通过复制粘贴方式添加 PDF 文件到聊天输入区域，以便快速分享 PDF 文档内容。

#### 验收标准

1. WHEN 用户复制一个 PDF 文件并粘贴到输入区域 THEN THE InputArea SHALL 将该 PDF 文件添加到附件列表
2. WHEN 用户粘贴的文件类型为 application/pdf THEN THE InputArea SHALL 识别并处理该文件
3. WHEN 用户粘贴 PDF 文件时附件数量已达上限 THEN THE InputArea SHALL 拒绝添加并保持当前状态
4. WHEN PDF 文件成功添加 THEN THE InputArea SHALL 在附件预览区域显示该文件

### 需求 2: 多文件粘贴处理

**用户故事:** 作为用户，我希望能够一次性粘贴多个文件，以便批量添加附件。

#### 验收标准

1. WHEN 用户同时粘贴多个文件 THEN THE InputArea SHALL 按顺序处理每个文件
2. WHEN 粘贴的文件数量加上现有附件数量超过限制 THEN THE InputArea SHALL 只添加允许范围内的文件
3. WHEN 处理多个文件时部分文件类型不支持 THEN THE InputArea SHALL 跳过不支持的文件并添加支持的文件
4. WHEN 多文件粘贴完成 THEN THE InputArea SHALL 更新附件列表显示所有成功添加的文件

### 需求 3: 文件类型验证

**用户故事:** 作为用户，我希望系统能够验证粘贴的文件类型，以便只添加支持的文件格式。

#### 验收标准

1. WHEN 用户粘贴文件 THEN THE InputArea SHALL 检查文件的 MIME 类型
2. WHEN 文件类型为图片且 Vision_Support 为 true THEN THE InputArea SHALL 接受该文件
3. WHEN 文件类型为文本文件（text/*）THEN THE InputArea SHALL 接受该文件
4. WHEN 文件类型为 PDF（application/pdf）THEN THE InputArea SHALL 接受该文件
5. WHEN 文件类型不在支持列表中 THEN THE InputArea SHALL 拒绝该文件

### 需求 4: 错误处理和用户反馈

**用户故事:** 作为用户，我希望在粘贴文件失败时能够收到清晰的错误提示，以便了解失败原因。

#### 验收标准

1. WHEN 粘贴的文件类型不支持 THEN THE InputArea SHALL 显示错误提示信息
2. WHEN 附件数量达到上限时用户尝试粘贴 THEN THE InputArea SHALL 提示用户已达文件数量限制
3. WHEN 文件读取过程中发生错误 THEN THE InputArea SHALL 捕获错误并显示友好的错误消息
4. WHEN 粘贴操作成功 THEN THE InputArea SHALL 提供视觉反馈确认文件已添加

### 需求 5: 粘贴事件处理优化

**用户故事:** 作为用户，我希望粘贴操作能够流畅执行，不会干扰正常的文本粘贴功能。

#### 验收标准

1. WHEN 用户粘贴纯文本内容 THEN THE InputArea SHALL 保持默认文本粘贴行为
2. WHEN 用户粘贴包含文件的内容 THEN THE InputArea SHALL 阻止默认行为并处理文件
3. WHEN 粘贴事件包含文件和文本 THEN THE InputArea SHALL 优先处理文件
4. WHEN 处理粘贴事件时 THEN THE InputArea SHALL 不阻塞用户界面

### 需求 6: 文件数量限制遵守

**用户故事:** 作为系统，我需要确保粘贴的文件遵守系统设定的文件数量限制，以便维护系统稳定性。

#### 验收标准

1. WHEN 检查是否可以添加文件 THEN THE InputArea SHALL 验证当前附件数量加上待添加文件数量不超过限制
2. WHEN 粘贴操作会导致超过限制 THEN THE InputArea SHALL 计算可添加的最大文件数量
3. WHEN 已达到文件数量限制 THEN THE InputArea SHALL 拒绝所有新的粘贴文件
4. THE InputArea SHALL 在添加每个文件前验证文件数量限制

### 需求 7: 剪贴板数据访问

**用户故事:** 作为系统，我需要正确访问和解析剪贴板数据，以便准确识别用户粘贴的内容类型。

#### 验收标准

1. WHEN 粘贴事件触发 THEN THE InputArea SHALL 通过 ClipboardEvent.clipboardData 访问剪贴板内容
2. WHEN 遍历剪贴板项目 THEN THE InputArea SHALL 检查每个 DataTransferItem 的类型
3. WHEN DataTransferItem 类型为 "file" THEN THE InputArea SHALL 调用 getAsFile() 获取文件对象
4. WHEN 获取文件对象失败 THEN THE InputArea SHALL 跳过该项目并继续处理其他项目
