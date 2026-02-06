import { isTauri } from '@tauri-apps/api/core';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type ClientPoint = { x: number; y: number };

/**
 * 将系统全局鼠标坐标换算为“当前窗口 WebView 的 client 坐标”（CSS px）。
 * 用于跨窗口拖拽时的 split 预览（即使本窗口没有参与 dnd-kit 拖拽，也能显示指引）。
 */
export async function getGlobalCursorClientPoint(): Promise<ClientPoint | null> {
  if (!isTauri()) return null;
  try {
    const win = getCurrentWebviewWindow();
    const [cursor, innerPos, scale] = await Promise.all([
      cursorPosition().catch(() => null),
      win.innerPosition().catch(() => null),
      win.scaleFactor().catch(() => 1),
    ]);
    if (!cursor || !innerPos) return null;

    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const x = (cursor.x - innerPos.x) / s;
    const y = (cursor.y - innerPos.y) / s;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

