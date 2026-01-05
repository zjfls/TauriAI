# TauriAI Agent Guide
## 规则
1.必须说中文


## 项目概述
TauriAI 是一个使用 **Tauri v2 + React 19 + TypeScript + Rust 2021** 构建的桌面应用程序。

## 技术栈

### 前端
- React 19（含 React DOM）
- TypeScript
- Vite
- `@tauri-apps/api`（通过 `invoke()` 与 Rust 通信）
- `@tauri-apps/plugin-opener`（打开 URL/文件）

### 后端
- Rust 2021
- Tauri v2
- Serde / Serde JSON

## 目录结构（关键部分）
- `tauri-ai/`：主应用目录
  - `src/`：前端源码（React）
  - `src-tauri/`：后端源码（Rust / Tauri）

## 常用命令
在 `tauri-ai/` 目录下执行：

```bash
npm run dev
npm run build
npm run preview
npm run tauri
```

## 核心模式：前端调用后端
前端使用 `@tauri-apps/api/core` 的 `invoke()` 调用 Rust 命令：

```ts
await invoke("command_name", { /* params */ });
```

## 添加/修改功能的推荐位置

### 新增 Tauri 命令（Rust）
1. 在 `tauri-ai/src-tauri/src/lib.rs` 中新增 `#[tauri::command]` 函数（返回值需可序列化）。
2. 在 `run()` 中通过 `.invoke_handler(tauri::generate_handler![...])` 注册（白名单模式）。
3. 前端在 `tauri-ai/src/` 中通过 `invoke("command_name", { ... })` 调用。

### 新增 React 组件（前端）
- 代码放在 `tauri-ai/src/` 下，优先使用 React hooks（`useState`、`useEffect` 等）。

### 新增依赖
- 前端依赖：`tauri-ai/package.json`
- 后端依赖：`tauri-ai/src-tauri/Cargo.toml`

## 安全注意事项
- Tauri 命令需显式注册才能被调用（白名单）。
- 注意处理错误与输入校验，避免将不可信输入直接用于系统能力（文件/URL 打开等）。

