# Requirements Document

## Introduction

本功能为 TauriAI 聊天应用添加文本文件附件支持。用户可以上传常见的文本文件（如 .txt, .md, .json, .yaml 等），系统将读取文件内容并作为消息的一部分发送给 AI。该功能扩展了现有的图片附件功能，复用相同的 UI 模式和数据结构。

## Glossary

- **Text_File_Attachment**: 用户上传的文本文件，包含文件名、内容和元数据
- **InputArea**: 聊天输入区域组件，负责处理用户输入和附件
- **ContentPart**: 消息内容的组成部分，可以是文本、图片或文件内容
- **Attachment_Menu**: 附件菜单组件，提供添加不同类型附件的入口
- **File_Reader**: 负责读取文件内容的模块
- **Supported_Extensions**: 支持的文本文件扩展名列表（.txt, .md, .json, .yaml, .yml, .xml, .csv, .log, .ini, .toml, .html, .css, .js, .ts, .py, .rs, .go, .java, .c, .cpp, .h）

## Requirements

### Requirement 1: 文本文件选择

**User Story:** As a user, I want to select text files through the attachment menu, so that I can share file content with the AI.

#### Acceptance Criteria

1. WHEN a user clicks the "文本文件" option in the Attachment_Menu, THE InputArea SHALL open a file picker dialog
2. WHEN the file picker opens, THE InputArea SHALL filter to show only Supported_Extensions
3. WHEN a user selects a valid text file, THE File_Reader SHALL read the file content
4. IF a user selects a file with unsupported extension, THEN THE InputArea SHALL display an error message and reject the file
5. IF a user selects a file larger than 1MB, THEN THE InputArea SHALL display an error message and reject the file

### Requirement 2: 文件内容预览

**User Story:** As a user, I want to preview the content of attached text files, so that I can verify I selected the correct file.

#### Acceptance Criteria

1. WHEN a text file is successfully loaded, THE InputArea SHALL display a preview card showing the file name and content preview
2. WHEN displaying the preview, THE InputArea SHALL show the first 500 characters of the file content with truncation indicator if longer
3. WHEN a user hovers over the preview card, THE InputArea SHALL show a tooltip with the full file name and size
4. WHEN a user clicks the remove button on the preview card, THE InputArea SHALL remove the file from pending attachments

### Requirement 3: 文件内容发送

**User Story:** As a user, I want to send text file content as part of my message, so that the AI can analyze or respond to the file content.

#### Acceptance Criteria

1. WHEN a user sends a message with text file attachments, THE InputArea SHALL include the file content as a Text_File_Attachment ContentPart
2. WHEN constructing the ContentPart, THE InputArea SHALL include the file name as a header before the content
3. WHEN the message is sent, THE InputArea SHALL clear all pending file attachments
4. THE ContentPart for text files SHALL use the format: "📄 {filename}\n```\n{content}\n```"

### Requirement 4: 拖拽和粘贴支持

**User Story:** As a user, I want to drag and drop or paste text files, so that I can quickly attach files without using the menu.

#### Acceptance Criteria

1. WHEN a user drags a text file over the InputArea, THE InputArea SHALL show a visual drop indicator
2. WHEN a user drops a valid text file, THE File_Reader SHALL read and add it to pending attachments
3. IF a user drops an unsupported file type, THEN THE InputArea SHALL ignore the file silently
4. IF a user drops a file larger than 1MB, THEN THE InputArea SHALL display an error message

### Requirement 5: 多文件支持

**User Story:** As a user, I want to attach multiple text files at once, so that I can share related files together.

#### Acceptance Criteria

1. WHEN a user selects multiple files in the file picker, THE File_Reader SHALL read all valid files
2. WHEN multiple files are attached, THE InputArea SHALL display all preview cards in a scrollable container
3. THE InputArea SHALL limit the total number of attached files to 5
4. IF a user attempts to attach more than 5 files, THEN THE InputArea SHALL display an error message and reject the excess files

### Requirement 6: 数据模型扩展

**User Story:** As a developer, I want the ContentPart model to support text file attachments, so that file content can be properly stored and transmitted.

#### Acceptance Criteria

1. THE ContentPart enum SHALL include a TextFile variant with filename and content fields
2. WHEN serializing a TextFile ContentPart, THE system SHALL use the tag "text_file" in JSON
3. WHEN deserializing a TextFile ContentPart, THE system SHALL correctly parse the filename and content fields
4. THE storage module SHALL correctly persist and retrieve TextFile ContentParts

### Requirement 7: 错误处理

**User Story:** As a user, I want clear error messages when file operations fail, so that I understand what went wrong.

#### Acceptance Criteria

1. IF file reading fails due to encoding issues, THEN THE File_Reader SHALL display "文件编码不支持，请使用 UTF-8 编码的文件"
2. IF file reading fails due to permission issues, THEN THE File_Reader SHALL display "无法读取文件，请检查文件权限"
3. IF file reading fails due to other IO errors, THEN THE File_Reader SHALL display "读取文件失败: {error_message}"
