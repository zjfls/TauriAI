# TauriAI 项目

## 项目概述
TauriAI 是一个使用 Tauri v2、React 19 和 TypeScript 构建的桌面应用程序。它结合了 Rust 后端的强大功能和现代 React 前端，提供了一个轻量级且安全的桌面应用程序框架。

## 技术栈

### 前端
- **React**: v19.1.0（含 React DOM）
- **TypeScript**: v5.8.3
- **Vite**: v7.0.4（构建工具和开发服务器）
- **Tauri API**: v2（前端与 Rust 后端的桥梁）
- **Tauri Plugin Opener**: v2（用于打开 URL 和文件）

### 后端
- **Rust**: 2021 版本
- **Tauri**: v2（核心框架）
- **Serde**: v1（序列化/反序列化）
- **Serde JSON**: v1（JSON 支持）

## 项目结构

```
TauriAI/
├── tauri-ai/                 # 主应用目录
│   ├── src/                  # 前端源代码
│   │   ├── App.tsx          # 主 React 组件
│   │   ├── main.tsx         # React 入口文件
│   │   ├── App.css          # 应用样式
│   │   ├── vite-env.d.ts    # Vite 类型定义
│   │   └── assets/          # 静态资源
│   ├── src-tauri/           # Rust 后端
│   │   ├── src/
│   │   │   ├── lib.rs       # 主库文件，包含 Tauri 命令
│   │   │   └── main.rs      # 应用程序入口
│   │   ├── Cargo.toml       # Rust 依赖配置
│   │   └── build.rs         # 构建脚本
│   ├── public/              # 公共静态文件
│   ├── index.html           # HTML 入口文件
│   ├── package.json         # Node 依赖配置
│   ├── tsconfig.json        # TypeScript 配置
│   ├── vite.config.ts       # Vite 配置
│   └── README.md            # 项目文档
└── README.md                # 根目录 README
```

## 核心功能

### 当前实现
- **问候命令（Greeting Command）**: 一个演示前后端通信的示例 Tauri 命令
  - 前端通过 `invoke("greet", { name })` 调用 Rust 函数
  - 后端处理请求并返回格式化的问候语
  - 位于 [src-tauri/src/lib.rs:3-5](tauri-ai/src-tauri/src/lib.rs#L3-L5)

### Tauri 命令
Tauri 命令在 Rust 中使用 `#[tauri::command]` 宏定义，并在 `run()` 函数中注册。前端可以使用 Tauri API 调用这些命令。

## 开发

### 可用脚本
```bash
# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览生产构建
npm run preview

# 运行 Tauri CLI 命令
npm run tauri
```

### 开发工作流程
1. 运行 `npm run dev` 启动 Vite 开发服务器
2. 前端更改会自动热重载
3. 后端更改需要重新编译 Rust 代码
4. 使用 `@tauri-apps/api/core` 中的 `invoke()` 来调用 Rust 命令

## 架构

### 前端 → 后端通信
应用程序使用 Tauri 的命令系统进行前后端通信：

1. **在 Rust 中定义命令**: 使用 `#[tauri::command]` 宏
2. **注册处理程序**: 添加到 `run()` 函数的 `invoke_handler` 中
3. **从前端调用**: 使用 `invoke("command_name", { params })`

[App.tsx:12](tauri-ai/src/App.tsx#L12) 中的示例：
```typescript
setGreetMsg(await invoke("greet", { name }));
```

### 构建配置
- **Vite**: 处理前端打包和优化
- **TypeScript**: 为前端代码提供类型安全
- **Cargo**: 管理 Rust 依赖和编译
- **Tauri Build**: 将前端和后端集成到单个可执行文件中

## IDE 配置
推荐的 VS Code 扩展：
- Tauri (tauri-apps.tauri-vscode)
- rust-analyzer (rust-lang.rust-analyzer)
- TypeScript 和 React 相关扩展

## 依赖项

### 前端依赖
- `react` & `react-dom`: React 核心库
- `@tauri-apps/api`: 连接 Rust 后端的桥梁
- `@tauri-apps/plugin-opener`: 打开 URL 和文件

### 前端开发依赖
- `@types/react` & `@types/react-dom`: TypeScript 类型定义
- `@vitejs/plugin-react`: Vite React 支持
- `typescript`: TypeScript 编译器
- `vite`: 构建工具和开发服务器
- `@tauri-apps/cli`: Tauri 命令行工具

### 后端依赖
- `tauri`: Tauri 核心框架
- `tauri-plugin-opener`: 用于打开 URL/文件的插件
- `serde` & `serde_json`: 序列化支持
- `tauri-build`: 构建时依赖

## AI 助手使用说明

### 添加新功能时
1. **新 Tauri 命令**: 添加到 [src-tauri/src/lib.rs](tauri-ai/src-tauri/src/lib.rs) 并在 `invoke_handler` 中注册
2. **新 React 组件**: 添加到 [src/](tauri-ai/src/) 目录
3. **新依赖项**:
   - 前端: 添加到 [package.json](tauri-ai/package.json)
   - 后端: 添加到 [src-tauri/Cargo.toml](tauri-ai/src-tauri/Cargo.toml)

### 常见模式
- 对 Tauri 命令使用 `async/await`
- 命令必须返回可序列化的类型（需要 Serde 支持）
- 前端状态管理使用 React hooks（useState、useEffect 等）
- 前后端都应该实现错误处理

### 安全注意事项
- Tauri 提供默认安全的方法
- 命令需要显式注册（白名单模式）
- 默认情况下没有远程代码执行
- 通过 Tauri 配置设置 CSP（内容安全策略）

## Git 状态
- 当前分支: `main`
- 仓库状态: 干净，已有初始提交
- Git 已初始化并跟踪更改
