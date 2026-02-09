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
