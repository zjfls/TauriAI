/**
 * useDragGhostSession Hook
 * 拖拽开始即显示 ghost 窗口，停止即隐藏。
 *
 * 设计要点：
 * - 只在 Tauri 环境下启用
 * - 高频轮询 cursorPosition，让 ghost 窗口持续跟随鼠标
 * - 不再区分 mode：显示/隐藏只与 start/stop/extend 相关
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { hideDragGhostWindow, primeDragGhostWindow, showAndMoveDragGhostWindow } from '../utils/dragGhostWindow';

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
  lastCursor: { x: number; y: number } | null;
};

export type UseDragGhostSessionOptions = {
  pollIntervalMs?: number;
};

export type DragGhostSessionController = {
  start: (title: string) => void;
  setTitle: (title: string) => void;
  stop: () => void;
  /** 继续显示一段时间（常用于 dnd-kit cancel 后的短暂可见性） */
  extend: (ms: number) => void;
};

export function useDragGhostSession(options: UseDragGhostSessionOptions = {}): DragGhostSessionController {
  const { pollIntervalMs = 32 } = options;

  const sessionRef = useRef<DragGhostSession | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);

  const start = useCallback((title: string) => {
    if (!isTauri()) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;

    // eslint-disable-next-line no-console
    console.log('[dragGhost][start]', { label: getDebugWindowLabel(), title: trimmed });
    sessionRef.current = {
      enabled: true,
      title: trimmed,
      trackingUntilMs: Number.POSITIVE_INFINITY,
      lastCursor: null,
    };
    setSessionVersion((v) => v + 1);

    void primeDragGhostWindow({ title: trimmed || '文件' });

    // 尽量立刻显示（避免等下一个 interval tick 才出现）
    void (async () => {
      const cursor = await cursorPosition().catch(() => null);
      if (!cursor) return;
      const current = sessionRef.current;
      if (!current?.enabled) return;
      current.lastCursor = cursor;
      await showAndMoveDragGhostWindow({ title: current.title || '文件' }, cursor);
    })();
  }, []);

  const stop = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log('[dragGhost][stop]', { label: getDebugWindowLabel() });
    sessionRef.current = null;
    setSessionVersion((v) => v + 1);
    void hideDragGhostWindow();
  }, []);

  const setTitle = useCallback((title: string) => {
    const session = sessionRef.current;
    if (!session) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;
    session.title = trimmed;
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

    void primeDragGhostWindow({ title: session.title || '文件' });

    let disposed = false;
    let inFlight = false;
    let lastCursorNullAt = 0;

    const tick = async () => {
      if (disposed) return;
      if (inFlight) return;
      inFlight = true;
      try {
        const current = sessionRef.current;
        const now = Date.now();
        if (!current?.enabled) {
          await hideDragGhostWindow();
          return;
        }

        if (now > current.trackingUntilMs) {
          stop();
          return;
        }

        const cursor = await cursorPosition().catch((e) => {
          // eslint-disable-next-line no-console
          console.log('[dragGhost][cursorPosition][ERR]', { label: getDebugWindowLabel(), error: e });
          return null;
        });
        if (cursor) current.lastCursor = cursor;

        const effectiveCursor = cursor ?? current.lastCursor;
        if (!effectiveCursor) {
          if (now - lastCursorNullAt > 800) {
            lastCursorNullAt = now;
            // eslint-disable-next-line no-console
            console.log('[dragGhost][cursorPosition]=null', { label: getDebugWindowLabel(), title: current.title });
          }
          return;
        }

        await showAndMoveDragGhostWindow({ title: current.title || '文件' }, effectiveCursor);
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
  }, [pollIntervalMs, sessionVersion, stop]);

  return { start, setTitle, stop, extend };
}

