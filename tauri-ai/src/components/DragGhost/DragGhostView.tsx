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
    <div className="h-screen w-screen p-3">
      <div className="pointer-events-none flex h-full w-full items-center justify-center rounded-xl border border-gray-200/80 bg-white/90 shadow-xl backdrop-blur-sm dark:border-gray-700/80 dark:bg-gray-900/80">
        <div className="flex max-w-full items-center gap-3 px-4 py-3">
          <FileText size={24} className="text-gray-700 dark:text-gray-200" />
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Drag Ghost
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
