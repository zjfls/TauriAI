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

    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.backgroundColor = prevBodyBg;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  return (
    <div className="h-screen w-screen bg-transparent">
      <div className="flex h-full w-full items-center justify-center p-0">
        <div className="pointer-events-none flex max-w-full items-center gap-2 rounded-md border border-gray-200/70 bg-white/70 px-3 py-1 text-xs text-gray-900 shadow-md backdrop-blur-sm dark:border-gray-700/70 dark:bg-gray-900/60 dark:text-gray-100">
          <FileText size={12} className="opacity-80" />
          <span className="max-w-[320px] truncate">{title || '...'}</span>
        </div>
      </div>
    </div>
  );
};

