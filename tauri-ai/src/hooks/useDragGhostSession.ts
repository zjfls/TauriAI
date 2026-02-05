/**
 * useDragGhostSession Hook
 * 拖拽开始：创建并显示 ghost 窗口
 * 拖拽结束：销毁 ghost 窗口
 *
 * 设计要点：
 * - 只在 Tauri 环境下启用
 */

import { useCallback, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { cursorPosition } from '@tauri-apps/api/window';
import { createDragGhostWindow, destroyDragGhostWindow, moveDragGhostWindow } from '../utils/dragGhostWindow';

type DragGhostSession = {
  enabled: boolean;
  title: string;
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
  const intervalRef = useRef<number | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const inFlightRef = useRef(false);

  const start = useCallback((title: string) => {
    if (!isTauri()) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;

    sessionRef.current = {
      enabled: true,
      title: trimmed,
    };

    void createDragGhostWindow({ title: trimmed || '文件' });

    // 启动轮询：让 ghost 跟随鼠标
    if (intervalRef.current != null) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(() => {
      if (inFlightRef.current) return;
      const current = sessionRef.current;
      if (!current?.enabled) return;
      inFlightRef.current = true;
      void (async () => {
        try {
          const cursor = await cursorPosition().catch(() => null);
          if (cursor) lastCursorRef.current = cursor;
          const effective = cursor ?? lastCursorRef.current;
          if (!effective) return;
          await moveDragGhostWindow(effective);
        } finally {
          inFlightRef.current = false;
        }
      })();
    }, pollIntervalMs);
  }, [pollIntervalMs]);

  const stop = useCallback(() => {
    sessionRef.current = null;
    lastCursorRef.current = null;
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    void destroyDragGhostWindow();
  }, []);

  const setTitle = useCallback((title: string) => {
    const session = sessionRef.current;
    if (!session) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;
    session.title = trimmed;
  }, []);

  const extend = useCallback((_ms: number) => {
    // 调试阶段先不做“延迟隐藏”，避免引入更多状态。
  }, []);

  return { start, setTitle, stop, extend };
}
