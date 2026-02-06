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
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  createDragGhostWindow,
  destroyDragGhostWindow,
  moveDragGhostWindow,
  moveDragGhostWindowClient,
  startDragGhostFollow,
  stopDragGhostFollow,
} from '../utils/dragGhostWindow';
import { DRAG_GHOST_BROADCAST_KEY } from './useRemoteDragSplitPreview';

type DragGhostSession = {
  enabled: boolean;
  title: string;
};

export type UseDragGhostSessionOptions = {
  pollIntervalMs?: number;
};

export type DragGhostSessionController = {
  start: (
    title: string,
    opts?: {
      anchorRect?: { left: number; top: number; width: number; height: number };
      clientPoint?: { x: number; y: number };
    }
  ) => void;
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
  const pointerMoveHandlerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const dbgRef = useRef({
    lastLogAt: 0,
    pointerMoves: 0,
    flushes: 0,
  });
  const followActiveRef = useRef(false);
  const broadcastTimerRef = useRef<number | null>(null);

  const setBroadcast = useCallback((title: string) => {
    try {
      const sourceLabel = getCurrentWebviewWindow()?.label;
      window.localStorage.setItem(
        DRAG_GHOST_BROADCAST_KEY,
        JSON.stringify({ ts: Date.now(), title, sourceLabel })
      );
    } catch {
      // ignore
    }
  }, []);

  const clearBroadcast = useCallback(() => {
    try {
      window.localStorage.removeItem(DRAG_GHOST_BROADCAST_KEY);
    } catch {
      // ignore
    }
  }, []);

  const flushPendingClientMove = useCallback(() => {
    if (!isTauri()) return;
    if (!readyRef.current) return;
    const cur = sessionRef.current;
    if (!cur?.enabled) return;
    if (followActiveRef.current) return;
    if (inFlightRef.current) return;

    dbgRef.current.flushes += 1;
    const now = Date.now();
    if (now - dbgRef.current.lastLogAt > 400) {
      dbgRef.current.lastLogAt = now;
      // eslint-disable-next-line no-console
      console.log('[dragGhost][flush]', {
        enabled: Boolean(cur?.enabled),
        ready: readyRef.current,
        inFlight: inFlightRef.current,
        pending: Boolean(pendingClientRef.current),
        pointerMoves: dbgRef.current.pointerMoves,
        flushes: dbgRef.current.flushes,
      });
    }

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

  const start = useCallback((title: string, opts?: { anchorRect?: { left: number; top: number; width: number; height: number }; clientPoint?: { x: number; y: number } }) => {
    if (!isTauri()) return;
    const trimmed = (title ?? '').trim();
    if (!trimmed) return;

    const session: DragGhostSession = {
      enabled: true,
      title: trimmed,
    };
    sessionRef.current = session;

    setBroadcast(trimmed);
    if (broadcastTimerRef.current != null) {
      window.clearInterval(broadcastTimerRef.current);
      broadcastTimerRef.current = null;
    }
    broadcastTimerRef.current = window.setInterval(() => setBroadcast(trimmed), 250);

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

    // 拖拽期间：用全局 pointermove 持续推送 client 坐标（比 cursorPosition 更稳定）。
    // 这样即便 dnd-kit 的 onDragMove 在某些边界条件下不触发，也能保持 ghost 跟随。
    if (!pointerMoveHandlerRef.current) {
      pointerMoveHandlerRef.current = (e: PointerEvent) => {
        const cur = sessionRef.current;
        if (!cur?.enabled) return;
        if (followActiveRef.current) return;
        if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
        lastClientAtRef.current = Date.now();
        pendingClientRef.current = { x: e.clientX, y: e.clientY };
        dbgRef.current.pointerMoves += 1;
        const now = Date.now();
        if (now - dbgRef.current.lastLogAt > 400) {
          dbgRef.current.lastLogAt = now;
          // eslint-disable-next-line no-console
          console.log('[dragGhost][pointermove]', {
            x: e.clientX,
            y: e.clientY,
            pointerMoves: dbgRef.current.pointerMoves,
            flushes: dbgRef.current.flushes,
          });
        }
        flushPendingClientMove();
      };
      window.addEventListener('pointermove', pointerMoveHandlerRef.current, { capture: true });
      // eslint-disable-next-line no-console
      console.log('[dragGhost][pointermove][on]');
    }

    void (async () => {
      try {
        const anchorRect = opts?.anchorRect;
        const clientPoint = opts?.clientPoint;
        await createDragGhostWindow({
          title: trimmed || '文件',
          width: anchorRect?.width,
          height: anchorRect?.height,
          offsetX: anchorRect && clientPoint ? clientPoint.x - anchorRect.left : undefined,
          offsetY: anchorRect && clientPoint ? clientPoint.y - anchorRect.top : undefined,
        });
        readyRef.current = true;

        // 先用 clientPoint 做一次“立即定位”，确保 ghost 在第一帧就出现在鼠标附近（尤其是 mac 调试时）。
        if (clientPoint) {
          await moveDragGhostWindowClient(clientPoint);
        }

        // Scheme A：后端自己轮询全局鼠标并移动 ghost（Windows 上更稳，且可跨窗口拖拽）。
        const followPayload =
          anchorRect && clientPoint
            ? {
                offsetX: clientPoint.x - anchorRect.left,
                offsetY: clientPoint.y - anchorRect.top,
                width: anchorRect.width,
                height: anchorRect.height,
                clientX: clientPoint.x,
                clientY: clientPoint.y,
              }
            : null;
        followActiveRef.current = await startDragGhostFollow(followPayload ?? undefined);
        if (!followActiveRef.current) {
          flushPendingClientMove();
        }
        const current = sessionRef.current;
        if (!current || current !== session || !current.enabled) {
          // drag 已结束/被替换：避免 create 结束较晚导致 ghost 残留在屏幕上
          await destroyDragGhostWindow();
          if (followActiveRef.current) await stopDragGhostFollow();
          return;
        }

        if (followActiveRef.current) {
          // 后端跟随模式：不再推送前端 client move，避免两条路径同时移动导致抖动
          if (pointerMoveHandlerRef.current) {
            window.removeEventListener('pointermove', pointerMoveHandlerRef.current, { capture: true } as any);
            pointerMoveHandlerRef.current = null;
            // eslint-disable-next-line no-console
            console.log('[dragGhost][pointermove][off][follow]');
          }
          // 后端跟随模式不需要前端 move loop
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
  }, [flushPendingClientMove, pollIntervalMs, setBroadcast]);

  const moveByClientPoint = useCallback(
    (point: { x: number; y: number }) => {
      if (!isTauri()) return;
      const cur = sessionRef.current;
      if (!cur?.enabled) return;
      if (followActiveRef.current) return;
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
    if (broadcastTimerRef.current != null) {
      window.clearInterval(broadcastTimerRef.current);
      broadcastTimerRef.current = null;
    }
    clearBroadcast();
    if (pointerMoveHandlerRef.current) {
      window.removeEventListener('pointermove', pointerMoveHandlerRef.current, { capture: true } as any);
      pointerMoveHandlerRef.current = null;
      // eslint-disable-next-line no-console
      console.log('[dragGhost][pointermove][off]');
    }
    if (followActiveRef.current) {
      followActiveRef.current = false;
      void stopDragGhostFollow();
    }
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    void destroyDragGhostWindow();
  }, [clearBroadcast]);

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
