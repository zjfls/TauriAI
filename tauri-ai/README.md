# TauriAI

TauriAI 是一个基于 Tauri、Rust、React 和 TypeScript 的多端 AI 工作台。

这个仓库现在按职责拆成了 3 类可执行物：

- `src-tauri/`：桌面主应用 `tauri-ai`
- `crates/headless-runner/`：随主应用一起发布的 sidecar `tauri-ai-headless`
- `crates/cli-runner/`：本地 CLI 工具 `tauri-ai-cli`

这样做的目的很简单：

- 主应用包只负责桌面 App 本体
- sidecar 继续参与发布，但只通过 `externalBin` 进入安装包
- CLI 和 headless 不再作为主应用包的额外 `bin` 被重复打包

## 目录结构

- `apps/desktop/`：桌面端前端
- `apps/mobile/`：移动端前端
- `apps/common/`：桌面/移动共享前端逻辑
- `src-tauri/`：Tauri 主应用与共享 Rust 库
- `crates/headless-runner/`：headless sidecar crate
- `crates/cli-runner/`：CLI crate
- `scripts/prepare-headless-sidecar.mjs`：构建并分发 sidecar 到 `src-tauri/binaries/`

## 桌面开发

在 `tauri-ai/` 目录执行：

- `npm install`
- `npm run tauri dev`
- `npm run tauri build`

说明：

- `npm run tauri dev` 会先执行 `prepare:headless`
- 这个步骤会单独编译 `tauri-ai-headless`，然后再启动前端 dev server
- 发布时 sidecar 通过 `src-tauri/tauri.*.conf.json` 里的 `externalBin` 一起进入安装包

## 移动端

移动端前端在 `apps/mobile/`，仍然复用 `src-tauri/` 的 Rust 代码，但会按平台裁剪掉桌面专用能力。

常用命令：

- `npm run dev:mobile`
- `npm run build:mobile`
- `npm run android:init`
- `npm run android:build`
- `npm run ios:sim:build`

## Headless Sidecar

`tauri-ai-headless` 是主应用发布物的一部分，但它以 sidecar 身份发布，而不是主应用包里的额外 `bin`。

在仓库根目录可以这样运行：

- 纯文本输出：
  - `cargo run -p tauri-ai-headless -- --prompt "解释这个函数的作用"`
- JSONL 事件流：
  - `echo '{"task":{"content":"解释这个函数的作用"},"output":{"mode":"jsonl"}}' | cargo run -p tauri-ai-headless`
- 最终 JSON：
  - `cargo run -p tauri-ai-headless -- --request-file request.json --output-mode final_json`

协议文档：

- `docs/headless/request.schema.json`
- `docs/headless/response.schema.json`

## CLI

NPM 脚本已经改为指向独立 CLI crate：

- `npm run cli:tui`
- `npm run cli:repl`
- `npm run cli:sessions`

如果直接用 Cargo：

- `cargo run --manifest-path crates/cli-runner/Cargo.toml -- chat --tui`
- `cargo run --manifest-path crates/cli-runner/Cargo.toml -- chat --repl`
- `cargo run --manifest-path crates/cli-runner/Cargo.toml -- sessions`

## Workspace 说明

仓库根的 `Cargo.toml` 现在包含多个 workspace member，但默认 member 仍然只有主应用包：

- `tauri-ai/src-tauri`

这保证了从仓库根直接执行 `cargo build` 时，默认行为仍然聚焦主应用，不会把 CLI 和 headless 一起当成主包产物处理。
