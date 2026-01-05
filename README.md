# TauriAI

一个基于 Tauri v2 构建的跨平台桌面 AI 助手应用，支持多种 AI 模型提供商。

## 功能特性

- **多模型支持** - 支持 OpenAI、Anthropic Claude、Ollama 本地模型
- **流式响应** - 实时显示 AI 回复，支持打字机效果
- **Markdown 渲染** - 完整的 Markdown 支持，包含代码语法高亮
- **对话历史** - 本地 SQLite 存储，支持对话管理和搜索
- **系统托盘** - 后台常驻，快速唤起
- **深色模式** - 自动跟随系统主题
- **预设管理** - 保存常用的模型配置和系统提示词

## 技术栈

### 前端
- React 19 + TypeScript
- Tailwind CSS 4 + Typography 插件
- Zustand 状态管理
- react-markdown + react-syntax-highlighter
- Lucide React 图标库

### 后端
- Rust 2021 Edition
- Tauri v2
- SQLite (rusqlite)
- reqwest (HTTP 客户端，支持流式传输)
- tokio (异步运行时)

## 安装

### 前置要求

- Node.js 18+
- Rust 1.70+
- 系统依赖（参考 [Tauri 官方文档](https://tauri.app/start/prerequisites/)）

### 开发环境

```bash
# 克隆仓库
git clone https://github.com/your-username/TauriAI.git
cd TauriAI/tauri-ai

# 安装前端依赖
npm install

# 启动开发服务器
npm run tauri dev
```

### 构建发布版本

```bash
cd tauri-ai
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

## 使用指南

### 配置 AI 提供商

1. 启动应用后，点击侧边栏的设置图标
2. 在「模型配置」标签页添加新模型
3. 选择提供商类型（OpenAI / Anthropic / Ollama）
4. 填写 API 密钥和端点（Ollama 默认为 `http://localhost:11434`）
5. 点击「测试连接」验证配置
6. 保存后在顶部下拉菜单切换模型

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Esc` | 取消生成 |

### 数据存储

- 配置文件：`~/.tauri-ai/config.json`
- 对话数据库：`~/.tauri-ai/data.db`

## 项目结构

```
TauriAI/
├── tauri-ai/                 # 主应用目录
│   ├── src/                  # 前端源码
│   │   ├── components/       # React 组件
│   │   │   ├── Chat/         # 聊天相关组件
│   │   │   ├── History/      # 历史记录组件
│   │   │   ├── Layout/       # 布局组件
│   │   │   └── Settings/     # 设置组件
│   │   ├── services/         # Tauri 服务封装
│   │   ├── stores/           # Zustand 状态管理
│   │   └── types/            # TypeScript 类型定义
│   └── src-tauri/            # Rust 后端
│       └── src/
│           ├── ai_client/    # AI 客户端实现
│           ├── commands/     # Tauri 命令
│           ├── config/       # 配置管理
│           └── storage/      # SQLite 存储
└── docs/                     # 项目文档
```

## 开发

### 常用命令

```bash
# 开发模式（热重载）
npm run tauri dev

# 构建前端
npm run build

# 构建完整应用
npm run tauri build

# 仅运行前端开发服务器
npm run dev
```

### 添加新的 Tauri 命令

1. 在 `src-tauri/src/commands/` 下创建命令函数
2. 使用 `#[tauri::command]` 宏标记
3. 在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中注册
4. 前端通过 `invoke("command_name", { params })` 调用

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
