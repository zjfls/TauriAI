/**
 * useDragGhostSession Hook
 * 在拖拽过程中，当鼠标离开当前窗口边界时，使用 Tauri 的“幽灵窗口”在窗口外呈现拖拽标签。
 *
 * 设计要点：
 * - 只在 Tauri 环境下启用（避免 Web 环境报错/无意义轮询）
 * - 高频只轮询 cursorPosition；窗口 bounds 优先缓存，降低 outerPosition/outerSize 调用开销
 * - dnd-kit 在拖拽离开窗口/进入其它应用时可能触发 cancel：允许短时间延长跟踪，保持窗外可见
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { hideDragGhostWindow, primeDragGhostWindow, showAndMoveDragGhostWindow } from '../utils/dragGhostWindow';

type WindowBounds = { x: number; y: number; width: number; height: number };

const getDebugWindowLabel = () => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return 'unknown';
  }
};

type DragGhostSession = {
  enabled: boolean;
  title: string;
  trackingUntilMs: number;
  manualVisible?: boolean;
  bounds: WindowBounds | null;
  lastCursor: { x: number; y: number } | null;
};

export type UseDragGhostSessionOptions = {
  thresholdPx: number;
  pollIntervalMs?: number;
  boundsRefreshMinIntervalMs?: number;
  /** window: 离开窗口边界才显示；manual: 由调用方决定显示时机 */
  mode?: 'window' | 'manual';
};

export type DragGhostSessionController = {
  start: (title: string) => void;
  setTitle: (title: string) => void;
  setVisible: (visible: boolean) => void;
  stop: () => void;
  extend: (ms: number) => void;
};

export function useDragGhostSession(options: UseDragGhostSessionOptions): DragGhostSessionController {
  const { thresholdPx, pollIntervalMs = 32, boundsRefreshMinIntervalMs = 220, mode = 'window' } = options;

  const sessionRef = useRef<DragGhostSession | null>(null);
  const boundsFetchAtRef = useRef(0);
  const [sessionVersion, setSessionVersion] = useState(0);

  const fetchWindowBounds = useCallback(async (): Promise<WindowBounds | null> => {
    try {
      const win = getCurrentWebviewWindow();
      const [pos, size] = await Promise.all([win.outerPosition().catch(() => null), win.outerSize().catch(() => null)]);
      if (!pos || !size) return null;
      return { x: pos.x, y: pos.y, width: size.width, height: size.height };
    } catch {
      return null;
    }
  }, []);

  const start = useCallback(
    (title: string) => {
      if (!isTauri()) return;
      const trimmed = (title ?? '').trim();
      if (!trimmed) return;
      // eslint-disable-next-line no-console
      console.log('[dragGhost][start]', { label: getDebugWindowLabel(), mode, title: trimmed });
      sessionRef.current = {
        enabled: true,
        title: trimmed,
        trackingUntilMs: Number.POSITIVE_INFINITY,
        bounds: sessionRef.current?.bounds ?? null,
        lastCursor: null,
      };
      boundsFetchAtRef.current = 0;
      setSessionVersion((v) => v + 1);
    },
    [mode]
  );

  const stop = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log('[dragGhost][stop]', { label: getDebugWindowLabel(), mode });
    sessionRef.current = null;
    boundsFetchAtRef.current = 0;
    setSessionVersion((v) => v + 1);
    void hideDragGhostWindow();
  }, [mode]);

  const setTitle = useCallback((title: string) => {
    const session = sessionRef.current;
    if (!session) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;
    session.title = trimmed;
  }, []);

  const setVisible = useCallback((visible: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    session.manualVisible = Boolean(visible);
    // eslint-disable-next-line no-console
    console.log('[dragGhost][setVisible]', {
      label: getDebugWindowLabel(),
      mode,
      visible: Boolean(visible),
      title: session.title,
    });
  }, [mode]);

  const extend = useCallback((ms: number) => {
    const session = sessionRef.current;
    if (!session) return;
    session.trackingUntilMs = Date.now() + Math.max(0, ms);
    setSessionVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    const session = sessionRef.current;
    if (!session?.enabled) {
      void hideDragGhostWindow();
      return;
    }

    void primeDragGhostWindow({ title: session.title || '文件' });

    let disposed = false;
    let inFlight = false;
    let wasOutside = false;
    let lastCursorNullAt = 0;

    const tick = async () => {
      if (disposed) return;
      if (inFlight) return;
      inFlight = true;
      try {
        const current = sessionRef.current;
        const now = Date.now();
        if (!current?.enabled) {
          if (wasOutside) {
            wasOutside = false;
            await hideDragGhostWindow();
          }
          return;
        }

        const title = current.title || '文件';

        if (now > current.trackingUntilMs) {
          stop();
          return;
        }

        const cursor = await cursorPosition().catch((e) => {
          // eslint-disable-next-line no-console
          console.log('[dragGhost][cursorPosition][ERR]', { label: getDebugWindowLabel(), mode, error: e });
          return null;
        });
        if (cursor) current.lastCursor = cursor;
        const effectiveCursor = cursor ?? current.lastCursor;
        if (!effectiveCursor) {
          if (now - lastCursorNullAt > 800) {
            lastCursorNullAt = now;
            // eslint-disable-next-line no-console
            console.log('[dragGhost][cursorPosition]=null', {
              label: getDebugWindowLabel(),
              mode,
              manualVisible: Boolean(current.manualVisible),
              hasLastCursor: Boolean(current.lastCursor),
              title: current.title,
            });
          }
          return;
        }

        const shouldRefreshBounds = now - boundsFetchAtRef.current >= boundsRefreshMinIntervalMs;
        if ((!current.bounds || shouldRefreshBounds) && shouldRefreshBounds) {
          boundsFetchAtRef.current = now;
          const nextBounds = await fetchWindowBounds();
          if (nextBounds) current.bounds = nextBounds;
        }

        const bounds = current.bounds;
        const outsideByBounds = (() => {
          if (!bounds) return false;
          const left = bounds.x - thresholdPx;
          const top = bounds.y - thresholdPx;
          const right = bounds.x + bounds.width + thresholdPx;
          const bottom = bounds.y + bounds.height + thresholdPx;
          return (
            effectiveCursor.x < left ||
            effectiveCursor.x > right ||
            effectiveCursor.y < top ||
            effectiveCursor.y > bottom
          );
        })();

        if (mode === 'manual') {
          // manual 模式：调用方控制“应当显示”的时机（例如离开 tab strip），
          // 但仍然需要兜底：当鼠标确实已经离开当前窗口时，即使未能及时收到 pointer move 更新，
          // 也要让 ghost 可靠显示（否则 cancel 时延长跟踪没有意义）。
          const shouldShow = Boolean(current.manualVisible) || outsideByBounds;
          if (shouldShow) {
            wasOutside = true;
            // eslint-disable-next-line no-console
            console.log('[dragGhost][show][manual]', {
              label: getDebugWindowLabel(),
              x: effectiveCursor.x,
              y: effectiveCursor.y,
              outsideByBounds,
              title,
            });
            await showAndMoveDragGhostWindow({ title }, effectiveCursor);
            return;
          }
          if (wasOutside) {
            wasOutside = false;
            // eslint-disable-next-line no-console
            console.log('[dragGhost][hide][manual]', { label: getDebugWindowLabel() });
            await hideDragGhostWindow();
          }
          return;
        }

        if (outsideByBounds) {
          wasOutside = true;
          // eslint-disable-next-line no-console
          console.log('[dragGhost][show][window]', {
            label: getDebugWindowLabel(),
            x: effectiveCursor.x,
            y: effectiveCursor.y,
            title,
          });
          await showAndMoveDragGhostWindow({ title }, effectiveCursor);
          return;
        }

        if (wasOutside) {
          wasOutside = false;
          // eslint-disable-next-line no-console
          console.log('[dragGhost][hide][window]', { label: getDebugWindowLabel() });
          await hideDragGhostWindow();
        }
      } catch {
        // ignore
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const interval = window.setInterval(() => void tick(), pollIntervalMs);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      void hideDragGhostWindow();
    };
  }, [boundsRefreshMinIntervalMs, fetchWindowBounds, mode, pollIntervalMs, sessionVersion, stop, thresholdPx]);

  return { start, setTitle, setVisible, stop, extend };
}
