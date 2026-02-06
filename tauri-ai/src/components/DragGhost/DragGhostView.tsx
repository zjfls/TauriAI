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
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  return (
    <div className="h-screen w-screen bg-transparent">
      {/* 目标：让 ghost 看起来像“正在拖拽的 tab”，而不是一个独立卡片 */}
      <div className="pointer-events-none h-full w-full select-none overflow-hidden">
        <div
          className={[
            // 不要用额外的 vertical padding，避免视觉高度与 tab bar 不一致（高度由后端按 tabRect.height 设置）
            'flex h-full w-full items-center gap-2 px-3',
            'rounded border border-gray-200/80 bg-white/95 shadow-md backdrop-blur-sm',
            'dark:border-gray-700/80 dark:bg-gray-900/90',
          ].join(' ')}
        >
          <span className="flex-shrink-0">
            <FileText size={14} className="text-gray-600 dark:text-gray-300" />
          </span>

          <span className="flex-1 min-w-0 truncate text-[13px] font-medium leading-none text-gray-900 dark:text-gray-50">
            {title || '...'}
          </span>

          <span className="flex-shrink-0 text-[9px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            GHOST
          </span>
        </div>
      </div>
    </div>
  );
};
