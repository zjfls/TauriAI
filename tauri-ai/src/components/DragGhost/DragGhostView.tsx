import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';

type DragGhostUpdatePayload = {
  title?: string | null;
};

export const DragGhostView = () => {
  const initialTitle = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('ghostTitle') ?? '';
  }, []);

  const [title, setTitle] = useState<string>(initialTitle);

  useEffect(() => {
    // 调试友好：让幽灵窗在窗口枚举/日志里一眼可辨。
    const prev = document.title;
    document.title = title ? `[GHOST] ${title}` : '[GHOST] Drag';
    return () => {
      document.title = prev;
    };
  }, [title]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: null | (() => void) = null;
    void listen<DragGhostUpdatePayload>('drag-ghost:update', (event) => {
      const nextTitle = (event.payload?.title ?? '').trim();
      if (nextTitle) setTitle(nextTitle);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.backgroundColor;
    const prevBodyBg = document.body.style.backgroundColor;
    const prevBodyOverflow = document.body.style.overflow;

    // 调试用：让 ghost 窗口足够显眼（方便确认是否真的显示出来）
    document.documentElement.style.backgroundColor = 'rgba(255, 0, 255, 0.22)';
    document.body.style.backgroundColor = 'rgba(255, 0, 255, 0.22)';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.backgroundColor = prevBodyBg;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  return (
    <div className="h-screen w-screen p-3">
      <div className="pointer-events-none flex h-full w-full items-center justify-center rounded-xl border-4 border-fuchsia-500/90 bg-fuchsia-500/20 shadow-2xl backdrop-blur-sm dark:border-fuchsia-300/80 dark:bg-fuchsia-900/30">
        <div className="flex max-w-full items-center gap-3 px-4 py-3">
          <FileText size={28} className="text-fuchsia-800/90 dark:text-fuchsia-200/90" />
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-fuchsia-900/80 dark:text-fuchsia-100/80">
              Drag Ghost (Debug)
            </div>
            <div className="mt-1 max-w-[72vw] truncate text-lg font-semibold text-gray-950 dark:text-gray-50">
              {title || '...'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
