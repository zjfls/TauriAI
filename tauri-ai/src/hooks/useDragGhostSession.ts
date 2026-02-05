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

type DragGhostSession = {
  enabled: boolean;
  title: string;
  trackingUntilMs: number;
  bounds: WindowBounds | null;
  lastCursor: { x: number; y: number } | null;
};

export type UseDragGhostSessionOptions = {
  thresholdPx: number;
  pollIntervalMs?: number;
  boundsRefreshMinIntervalMs?: number;
};

export type DragGhostSessionController = {
  start: (title: string) => void;
  stop: () => void;
  extend: (ms: number) => void;
};

export function useDragGhostSession(options: UseDragGhostSessionOptions): DragGhostSessionController {
  const { thresholdPx, pollIntervalMs = 32, boundsRefreshMinIntervalMs = 220 } = options;

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
    []
  );

  const stop = useCallback(() => {
    sessionRef.current = null;
    boundsFetchAtRef.current = 0;
    setSessionVersion((v) => v + 1);
    void hideDragGhostWindow();
  }, []);

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

    const title = session.title || '文件';
    void primeDragGhostWindow({ title });

    let disposed = false;
    let inFlight = false;
    let wasOutside = false;

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

        if (now > current.trackingUntilMs) {
          stop();
          return;
        }

        const cursor = await cursorPosition().catch(() => null);
        if (cursor) current.lastCursor = cursor;
        const effectiveCursor = cursor ?? current.lastCursor;
        if (!effectiveCursor) return;

        const shouldRefreshBounds = now - boundsFetchAtRef.current >= boundsRefreshMinIntervalMs;
        if ((!current.bounds || shouldRefreshBounds) && shouldRefreshBounds) {
          boundsFetchAtRef.current = now;
          const nextBounds = await fetchWindowBounds();
          if (nextBounds) current.bounds = nextBounds;
        }

        const bounds = current.bounds;
        if (!bounds) return;

        const left = bounds.x - thresholdPx;
        const top = bounds.y - thresholdPx;
        const right = bounds.x + bounds.width + thresholdPx;
        const bottom = bounds.y + bounds.height + thresholdPx;
        const outside =
          effectiveCursor.x < left || effectiveCursor.x > right || effectiveCursor.y < top || effectiveCursor.y > bottom;

        if (outside) {
          wasOutside = true;
          await showAndMoveDragGhostWindow({ title }, effectiveCursor);
          return;
        }

        if (wasOutside) {
          wasOutside = false;
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
  }, [boundsRefreshMinIntervalMs, fetchWindowBounds, pollIntervalMs, sessionVersion, thresholdPx]);

  return { start, stop, extend };
}
