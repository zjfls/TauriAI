import { isTauri } from '@tauri-apps/api/core';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type ClientPoint = { x: number; y: number };
type PhysicalPoint = { x: number; y: number };

const GEOMETRY_TTL_MS = 800;
const CURSOR_TTL_MS = 220;

let cachedInnerPos: PhysicalPoint | null = null;
let cachedScale = 1;
let cachedGeometryAt = 0;
let geometryInFlight: Promise<void> | null = null;

let lastCursor: PhysicalPoint | null = null;
let lastCursorAt = 0;

async function ensureWindowGeometry(win: ReturnType<typeof getCurrentWebviewWindow>): Promise<void> {
  const now = Date.now();
  if (cachedInnerPos && now - cachedGeometryAt <= GEOMETRY_TTL_MS) return;
  if (geometryInFlight) return geometryInFlight;

  geometryInFlight = (async () => {
    try {
      const [innerPos, scale] = await Promise.all([
        win.innerPosition().catch(() => null),
        win.scaleFactor().catch(() => 1),
      ]);

      if (innerPos) {
        cachedInnerPos = { x: innerPos.x, y: innerPos.y };
        cachedGeometryAt = Date.now();
      }

      const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
      cachedScale = s;
    } finally {
      geometryInFlight = null;
    }
  })();

  return geometryInFlight;
}

/**
 * 将系统全局鼠标坐标换算为“当前窗口 WebView 的 client 坐标”（CSS px）。
 * 用于跨窗口拖拽时的 split 预览（即使本窗口没有参与 dnd-kit 拖拽，也能显示指引）。
 */
export async function getGlobalCursorClientPoint(): Promise<ClientPoint | null> {
  if (!isTauri()) return null;
  try {
    const win = getCurrentWebviewWindow();
    await ensureWindowGeometry(win);

    const cursor = await cursorPosition().catch(() => null);
    if (cursor) {
      lastCursor = { x: cursor.x, y: cursor.y };
      lastCursorAt = Date.now();
    }

    const effectiveCursor =
      cursor ?? (lastCursor && Date.now() - lastCursorAt <= CURSOR_TTL_MS ? lastCursor : null);
    if (!effectiveCursor || !cachedInnerPos) return null;

    const s = cachedScale;
    const x = (effectiveCursor.x - cachedInnerPos.x) / s;
    const y = (effectiveCursor.y - cachedInnerPos.y) / s;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}
