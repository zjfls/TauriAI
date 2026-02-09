import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import * as pdfjsLib from 'pdfjs-dist';

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
      console.warn('设置 DEV 窗口图标失败:', error);
    }
  })();
}

// Add global error handler for uncaught errors
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
