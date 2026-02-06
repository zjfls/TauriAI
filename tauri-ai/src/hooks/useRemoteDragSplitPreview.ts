import { useEffect, useRef, useState } from 'react';
import { getGlobalCursorClientPoint } from '../utils/globalCursor';

type DragGhostBroadcast = {
  ts: number;
  title?: string;
  sourceLabel?: string;
};

export const DRAG_GHOST_BROADCAST_KEY = 'tauriai.dragGhost.active';

export type UseRemoteDragSplitPreviewOptions<TPreview> = {
  /** 本窗口是否允许显示“远程拖拽”的 split 指引（本窗口自己在拖拽时建议关掉）。 */
  enabled: boolean;
  /** 将 client point 映射为 split preview。 */
  computePreview: (point: { x: number; y: number }) => TPreview | null;
  /** 用于写入到你自己的 state（避免 hook 强耦合具体的预览类型）。 */
  onPreview: (preview: TPreview | null) => void;
  /** 轮询频率（ms）。 */
  pollMs?: number;
  /** 心跳超时（ms）。 */
  ttlMs?: number;
};

function readBroadcast(): DragGhostBroadcast | null {
  try {
    const raw = window.localStorage.getItem(DRAG_GHOST_BROADCAST_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as DragGhostBroadcast;
    if (!data || typeof data.ts !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 跨窗口拖拽：当其它窗口触发 ghost 拖拽时，本窗口也要显示分屏指引。
 * 机制：
 * - source window 在 localStorage 写入心跳（ts）标记“拖拽进行中”
 * - target window 看到标记后，轮询全局鼠标坐标并换算为本窗口 client 坐标
 * - 调用 computePreview 渲染 split 指引
 */
export function useRemoteDragSplitPreview<TPreview>(options: UseRemoteDragSplitPreviewOptions<TPreview>) {
  const { enabled, computePreview, onPreview, pollMs = 48, ttlMs = 1500 } = options;

  const [active, setActive] = useState(false);
  const lastActiveRef = useRef(false);
  const computePreviewRef = useRef(computePreview);
  const onPreviewRef = useRef(onPreview);

  // 避免 computePreview/onPreview 引用变化导致 effect 反复重建（会触发 preview 清空 -> 产生闪烁）
  useEffect(() => {
    computePreviewRef.current = computePreview;
  }, [computePreview]);

  useEffect(() => {
    onPreviewRef.current = onPreview;
  }, [onPreview]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = () => {
      const b = readBroadcast();
      const ok = Boolean(b && Date.now() - b.ts <= ttlMs);
      setActive(ok);
    };
    refresh();

    const onStorage = (e: StorageEvent) => {
      if (e.key !== DRAG_GHOST_BROADCAST_KEY) return;
      refresh();
    };
    window.addEventListener('storage', onStorage);

    const t = window.setInterval(refresh, 500);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.clearInterval(t);
    };
  }, [ttlMs]);

  useEffect(() => {
    if (!enabled || !active) {
      if (lastActiveRef.current) onPreviewRef.current(null);
      lastActiveRef.current = false;
      return;
    }

    lastActiveRef.current = true;
    let disposed = false;
    let inFlight = false;
    let lastNonNullPreview: TPreview | null = null;
    let lastNonNullAt = 0;
    const NULL_HOLD_MS = 160;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      const point = await getGlobalCursorClientPoint();
      try {
        if (disposed) return;

        const next = point ? computePreviewRef.current(point) : null;
        const now = Date.now();

        if (next) {
          lastNonNullPreview = next;
          lastNonNullAt = now;
          onPreviewRef.current(next);
          return;
        }

        // 抖动保护：短时间内拿不到坐标/预览为空时，保留上一次的非空预览，避免闪烁
        if (lastNonNullPreview && now - lastNonNullAt <= NULL_HOLD_MS) {
          onPreviewRef.current(lastNonNullPreview);
          return;
        }

        lastNonNullPreview = null;
        onPreviewRef.current(null);
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const t = window.setInterval(() => void tick(), pollMs);
    return () => {
      disposed = true;
      window.clearInterval(t);
      onPreviewRef.current(null);
    };
  }, [active, enabled, pollMs]);
}
