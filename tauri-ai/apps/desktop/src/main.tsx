import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import * as pdfjsLib from 'pdfjs-dist';
import './utils/monacoEnv';
import type { ActiveView } from './types';
import { createWindowBrandIconRgba, resolveWindowBrandKind } from './utils/windowBranding';

// 配置 PDF.js worker - 使用本地 worker 文件
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// 开发模式：为当前窗口设置一个带 “DEV” 标识的图标，避免与打包版本混淆。
void (async () => {
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    if (!isTauri()) return;

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { Image } = await import('@tauri-apps/api/image');

    const rawView = (((window as any).__TAURIAI_VIEW_PARAMS__?.view ?? null) as ActiveView | null);
    const rawLabel = getCurrentWebviewWindow().label;
    const brandKind = resolveWindowBrandKind(rawView, rawLabel);
    if (brandKind === 'other') return;

    const icon = await Image.new(
      createWindowBrandIconRgba(brandKind, 32, { devBadge: Boolean(import.meta.env.DEV) }),
      32,
      32
    );
    await getCurrentWindow().setIcon(icon);
  } catch {
    // ignore: best-effort branding
  }
})();

import { showGlobalError } from './utils/errorUtils';
import { useConfigStore } from './stores/configStore';

// 拦截 console.error，防止“写了 catch 但里面只有一行 console.error(e)”的鸵鸟行为
const originalConsoleError = console.error;
console.error = (...args) => {
  originalConsoleError(...args);

  // 严格隔离：如果有专门配置需要拦截 console.error
  const state = useConfigStore.getState();
  if (state.config?.interceptConsoleError !== false) { // 默认 true
    const errorText = args.map(arg =>
      typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : JSON.stringify(arg)
    ).join(' ');

    const firstObj = args.find(a => a instanceof Error);

    // 不要 await，避免阻塞控制台输出本身
    void showGlobalError('捕获到隐藏日志错误 (控制台隔离)', errorText, firstObj);
  }
};

// Add global error handler for uncaught errors
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  const errMsg = event.error?.message || event.message || '未知 JS 异常';
  void showGlobalError('应用发生未知错误', errMsg, event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason: any = (event as any)?.reason;

  // Monaco (and some platform APIs) use promise rejection to signal expected cancellation.
  // These are noisy in a global handler and usually not actionable.
  const isCancellation = (() => {
    if (!reason) return false;
    const name = typeof reason?.name === 'string' ? reason.name : '';
    if (name === 'Canceled' || name === 'Cancelled' || name === 'AbortError') return true;
    const msg = typeof reason?.message === 'string' ? reason.message : String(reason);
    if (/Canceled:\s*Canceled/i.test(msg)) return true;
    if (/Cancelled:\s*Cancelled/i.test(msg)) return true;
    if (/aborted/i.test(msg)) return true;
    // Best-effort: some Monaco bundles surface cancellation stack traces from editor.api-*.js.
    const stack = typeof reason?.stack === 'string' ? reason.stack : '';
    if (stack && /editor\.api/i.test(stack) && /(Canceled|Cancelled)/i.test(msg)) return true;
    return false;
  })();

  if (isCancellation) {
    // Suppress noisy "expected cancellation" errors.
    event.preventDefault();
    return;
  }

  console.error('Unhandled promise rejection:', reason);

  const reasonText = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : JSON.stringify(reason);
  void showGlobalError('未处理的异步/后端异常', reasonText, reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

try {
  document.getElementById('tauriai-boot')?.remove();
} catch {
  // ignore
}
