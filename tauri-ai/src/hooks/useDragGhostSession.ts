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
import {
  createDragGhostWindow,
  destroyDragGhostWindow,
  moveDragGhostWindow,
  moveDragGhostWindowClient,
} from '../utils/dragGhostWindow';

type DragGhostSession = {
  enabled: boolean;
  title: string;
};

export type UseDragGhostSessionOptions = {
  pollIntervalMs?: number;
};

export type DragGhostSessionController = {
  start: (title: string) => void;
  /** 推送 client-space 指针位置（来自 dnd-kit 的 clientX/Y） */
  moveByClientPoint: (point: { x: number; y: number }) => void;
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
  const readyRef = useRef(false);
  const pendingClientRef = useRef<{ x: number; y: number } | null>(null);
  const lastClientAtRef = useRef(0);

  const flushPendingClientMove = useCallback(() => {
    if (!isTauri()) return;
    if (!readyRef.current) return;
    const cur = sessionRef.current;
    if (!cur?.enabled) return;
    if (inFlightRef.current) return;

    const point = pendingClientRef.current;
    if (!point) return;
    pendingClientRef.current = null;

    inFlightRef.current = true;
    void (async () => {
      try {
        await moveDragGhostWindowClient(point);
      } finally {
        inFlightRef.current = false;
        // 若移动过程中又来了新点，继续 flush
        if (pendingClientRef.current) flushPendingClientMove();
      }
    })();
  }, []);

  const start = useCallback((title: string) => {
    if (!isTauri()) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;

    const session: DragGhostSession = {
      enabled: true,
      title: trimmed,
    };
    sessionRef.current = session;

    // 关键：先确保 ghost window 已创建/复用，再开始高频 move。
    // 否则第一波 move 可能全部失败，用户观感是“ghost 不跟手/不跟随”。
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    lastCursorRef.current = null;
    pendingClientRef.current = null;
    lastClientAtRef.current = 0;
    inFlightRef.current = false;
    readyRef.current = false;

    void (async () => {
      try {
        await createDragGhostWindow({ title: trimmed || '文件' });
        readyRef.current = true;
        flushPendingClientMove();
        const current = sessionRef.current;
        if (!current || current !== session || !current.enabled) {
          // drag 已结束/被替换：避免 create 结束较晚导致 ghost 残留在屏幕上
          await destroyDragGhostWindow();
          return;
        }

        // 先做一次“立即定位”，避免等到下一次 interval 才移动。
        const cursor = await Promise.race([
          cursorPosition(),
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 120)),
        ]).catch(() => null);
        if (cursor) lastCursorRef.current = cursor;
        const effective = cursor ?? lastCursorRef.current;
        if (effective) {
          await moveDragGhostWindow(effective);
        }

        // 启动轮询：让 ghost 跟随鼠标
        if (intervalRef.current != null) window.clearInterval(intervalRef.current);
        intervalRef.current = window.setInterval(() => {
          if (inFlightRef.current) return;
          const cur = sessionRef.current;
          if (!cur?.enabled) return;
          // 最近一段时间持续有 client 点输入：优先用 client move（更轻、更稳）
          if (Date.now() - lastClientAtRef.current < 120) return;
          inFlightRef.current = true;
          void (async () => {
            try {
              const nextCursor = await Promise.race([
                cursorPosition(),
                new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 120)),
              ]).catch(() => null);
              if (nextCursor) lastCursorRef.current = nextCursor;
              const next = nextCursor ?? lastCursorRef.current;
              if (!next) return;
              await moveDragGhostWindow(next);
            } finally {
              inFlightRef.current = false;
              if (pendingClientRef.current) flushPendingClientMove();
            }
          })();
        }, pollIntervalMs);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log('[dragGhost][session][start][ERR]', err);
      }
    })();
  }, [flushPendingClientMove, pollIntervalMs]);

  const moveByClientPoint = useCallback(
    (point: { x: number; y: number }) => {
      if (!isTauri()) return;
      const cur = sessionRef.current;
      if (!cur?.enabled) return;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      lastClientAtRef.current = Date.now();
      pendingClientRef.current = point;
      flushPendingClientMove();
    },
    [flushPendingClientMove]
  );

  const stop = useCallback(() => {
    sessionRef.current = null;
    lastCursorRef.current = null;
    pendingClientRef.current = null;
    readyRef.current = false;
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

  return { start, moveByClientPoint, setTitle, stop, extend };
}
