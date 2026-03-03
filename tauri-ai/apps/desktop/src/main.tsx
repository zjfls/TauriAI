import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import * as pdfjsLib from 'pdfjs-dist';
import './utils/monacoEnv';

const createDevIconRgba = (size = 32): Uint8Array => {
  const rgba = new Uint8Array(size * size * 4);

  const setPixel = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 239;
      let g = 68;
      let b = 68;
      if ((x + y) % 8 < 4) {
        r = Math.min(255, r + 18);
        g = Math.min(255, g + 18);
        b = Math.min(255, b + 18);
      }
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
        r = 255;
        g = 255;
        b = 255;
      }
      setPixel(x, y, r, g, b, 255);
    }
  }

  const glyphs: Record<string, string[]> = {
    D: [
      "1110",
      "1001",
      "1001",
      "1001",
      "1001",
      "1110",
    ],
    E: [
      "1111",
      "1000",
      "1110",
      "1000",
      "1000",
      "1111",
    ],
    V: [
      "1001",
      "1001",
      "1001",
      "1001",
      "0101",
      "0010",
    ],
  };

  const letters = ["D", "E", "V"];
  const glyphW = 4;
  const glyphH = 6;
  const scale = 2;
  const spacing = 2;
  const totalW = letters.length * glyphW * scale + (letters.length - 1) * spacing;
  const totalH = glyphH * scale;
  const startX = Math.floor((size - totalW) / 2);
  const startY = Math.floor((size - totalH) / 2);

  for (let li = 0; li < letters.length; li++) {
    const glyph = glyphs[letters[li]];
    if (!glyph) continue;
    const baseX = startX + li * (glyphW * scale + spacing);
    for (let gy = 0; gy < glyphH; gy++) {
      const row = glyph[gy] ?? "";
      for (let gx = 0; gx < glyphW; gx++) {
        if (row[gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            setPixel(baseX + gx * scale + sx, startY + gy * scale + sy, 255, 255, 255, 255);
          }
        }
      }
    }
  }

  return rgba;
};

// 配置 PDF.js worker - 使用本地 worker 文件
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// 开发模式：为当前窗口设置一个带 “DEV” 标识的图标，避免与打包版本混淆。
if (import.meta.env.DEV) {
  void (async () => {
    try {
      const { isTauri } = await import('@tauri-apps/api/core');
      if (!isTauri()) return;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const { Image } = await import('@tauri-apps/api/image');

      const icon = await Image.new(createDevIconRgba(32), 32, 32);
      await getCurrentWindow().setIcon(icon);
    } catch (error) {
      // ignore (dev-only best-effort)
    }
  })();
}

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
