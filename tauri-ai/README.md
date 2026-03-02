# TauriAI

本项目使用 **Tauri（Rust 后端）+ React/TypeScript 前端**。

为了长期维护与扩展（桌面/移动互不影响），前端按 `apps/desktop` 与 `apps/mobile` **物理隔离**，后端复用 `src-tauri`，并按平台裁剪桌面专用能力。

## 目录结构

- `apps/desktop/`：桌面端 UI（当前桌面主入口）
- `apps/mobile/`：移动端 UI（独立构建，供 Android/iOS 使用）
- `src-tauri/`：Rust 后端与 Tauri 配置
  - `src-tauri/tauri.conf.json`：桌面端配置（`frontendDist=../dist/desktop`）
  - `src-tauri/tauri.android.conf.json`：Android 配置（`frontendDist=../dist/mobile`）
  - `src-tauri/tauri.ios.conf.json`：iOS 配置（`frontendDist=../dist/mobile`）

## 桌面端开发 / 构建（必须保持可用）

在 `tauri-ai/` 目录执行：

- `npm install`
- `npm run tauri dev`
- `npm run tauri build`

## 移动端（Android / iOS）

移动端使用 `apps/mobile`，后端仍为 `src-tauri`（移动端会禁用 tray/pty/mcp/数据库等桌面专用模块，保证可编译可打包）。

### Android

- 初始化工程：`npm run android:init`
- 构建 APK（示例）：`npm run android:build`

macOS 上如果系统 `java` 不可用，需要设置 `JAVA_HOME` / `PATH` 指向已安装的 JDK（建议 JDK 21）。

### iOS

- 初始化工程：`npx tauri ios init`
- 构建 Simulator（示例）：`npx tauri ios build -d -t aarch64-sim`
- 一键安装到模拟器（默认 iPhone 17）：`npm run ios:sim:install`
  - 指定设备示例：`IOS_SIM_DEVICE="iPad (A16)" npm run ios:sim:install`
- 同步配置到模拟器（优先用 `~/.tauriai/config.json`，否则用 `~/.tauri-ai/config.json`）：`npm run ios:sim:sync-config`

如果遇到 `swiftCompatibility*` 链接失败（常见于 Xcode 26 工具链路径指向 MetalToolchain），运行：

- `npm run patch:ios-gen`

## Headless 子进程模式

在 `src-tauri` 目录可使用独立二进制 `tauri-ai-headless` 执行 Agent 任务（支持工具调用、会话续跑、结构化输出）：

- 纯文本模式（默认，仅输出最终 assistant 内容）  
  - `cargo run --bin tauri-ai-headless -- --prompt "解释这个函数的作用"`
- JSONL 事件流模式（每条 `run:event` + 最后一条 `final`）  
  - `echo '{"task":{"content":"解释这个函数的作用"},"output":{"mode":"jsonl"}}' | cargo run --bin tauri-ai-headless`
- 最终 JSON 模式（单条结果对象）  
  - `cargo run --bin tauri-ai-headless -- --request-file request.json --output-mode final_json`

### 请求结构（camelCase）

```json
{
  "requestId": "可选",
  "task": {
    "messageId": "可选（建议传入主线程 user message id）",
    "content": "用户输入",
    "contentParts": [],
    "agentName": "可选",
    "modelRef": "可选",
    "runMode": "chat|agent|agent-custom|agent-full-access",
    "thinking": "可选",
    "webSearchProvider": "可选",
    "debugMode": true
  },
  "session": {
    "backend": "db|memory",
    "mode": "new|resume",
    "conversationId": "可选（resume 推荐）",
    "dbPath": "可选（backend=db 时）",
    "title": "可选",
    "messages": []
  },
  "output": {
    "mode": "plain|final_json|jsonl",
    "includeEvents": false,
    "includeMessages": false,
    "expectedResultSchema": {}
  },
  "runtime": {
    "timeoutMs": 600000,
    "maxEvents": 5000,
    "maxSnapshotMessages": 1000
  }
}
```

完整契约（JSON Schema）：

- 请求：`docs/headless/request.schema.json`
- 响应：`docs/headless/response.schema.json`

### 会话语义

- `backend=db`：使用 SQLite 持久化会话（默认 `~/.tauri-ai/data.db`）。
- `backend=memory`：进程内内存会话；返回结果里会附带 `sessionRef.snapshot`，可用于下次 `resume`。
- `mode=new`：创建新会话（可导入 `session.messages` 作为初始历史）。
- `mode=resume`：续跑已有会话；若会话不存在，必须提供 `session.messages`（或 `snapshot.messages`）用于重建。

### 输出语义

- 成功/失败都会输出统一结构，核心字段：`ok`、`requestId`、`runId`、`sessionRef`、`result`、`usage`、`error`。
- 所有输出都会附带 `eventStats`（`totalReceived/kept/dropped`），用于判断事件是否被上限裁剪。
- 配置 `output.expectedResultSchema` 时，会对 assistant 最终内容做 JSON 校验，并在 `schemaValidation` 返回校验结果。

### 运行时保护（建议）

- `runtime.timeoutMs`：单任务超时（默认 600000ms，超时后会触发 abort 并返回 `runtime_timeout`）。
- `runtime.maxEvents`：事件缓存上限（默认 5000，超出后丢弃最旧事件，`eventStats.dropped` 可观测）。
- `runtime.maxSnapshotMessages`：snapshot 消息上限（默认 1000，返回时仅保留最新 N 条）。

### 父进程调用约定（推荐）

- 使用稳定 `requestId` 做请求追踪（日志与错误定位统一）。
- 若已有会话消息主键，建议同时传 `task.messageId`，确保和主线程落库主键一致。
- 对同一会话建议“串行请求 + 上层幂等去重”（避免并发写入导致上下文竞态）。
- 失败重试只建议用于 `transport/http/protocol` 层，`content/tool/db` 层先排查再重试。
