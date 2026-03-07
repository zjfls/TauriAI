import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight, ListOrdered, X } from 'lucide-react';

export type ChatOutlineDisplayMode = 'sidebar' | 'overlay';

export type ChatOutlineItem = {
  messageId: string;
  index: number;
  preview: string;
};

export const ChatOutlinePanel: React.FC<{
  items: ChatOutlineItem[];
  selectedMessageId: string | null;
  selectedFullText?: string | null;
  isOpen: boolean;
  displayMode?: ChatOutlineDisplayMode;
  onToggle: () => void;
  onSelect: (messageId: string) => void;
}> = ({ items, selectedMessageId, selectedFullText, isOpen, displayMode = 'sidebar', onToggle, onSelect }) => {
  const selected = useMemo(() => {
    if (!selectedMessageId) return null;
    return items.find((i) => i.messageId === selectedMessageId) ?? null;
  }, [items, selectedMessageId]);
  const isOverlay = displayMode === 'overlay';
  const closeLabel = isOverlay ? '关闭消息目录' : '收起消息目录';

  return (
    <div
      className={[
        isOpen ? (isOverlay ? 'w-72' : 'w-64') : 'w-0',
        'flex-shrink-0 overflow-hidden h-full',
        'transition-[width,opacity,transform] duration-200 ease-out',
        isOverlay
          ? 'rounded-xl border border-gray-200/80 bg-white/95 shadow-xl dark:border-gray-800 dark:bg-gray-900/90'
          : isOpen
            ? 'border-r border-gray-200 bg-white/70 backdrop-blur dark:border-gray-800 dark:bg-gray-900/55'
            : 'border-r-0 bg-transparent',
        isOverlay && !isOpen ? '-translate-x-3 opacity-0' : 'translate-x-0 opacity-100',
        isOpen ? 'pointer-events-auto' : 'pointer-events-none',
        'flex min-h-0 flex-col',
      ].join(' ')}
      aria-label="消息目录"
      aria-hidden={!isOpen}
    >
      {isOpen ? (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-gray-200/70 px-3 py-2.5 text-sm dark:border-gray-800">
            <div className="flex items-center gap-2">
              <ListOrdered size={16} className="text-gray-400" />
              <span className="font-semibold text-gray-700 dark:text-gray-200">目录</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-gray-200 bg-white/70 px-2 py-0.5 text-[11px] font-medium text-gray-600 shadow-sm dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                {items.length}
              </span>
              <button
                type="button"
                onClick={onToggle}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                aria-label={closeLabel}
                title={closeLabel}
              >
                {isOverlay ? <X size={14} /> : <ChevronLeft size={14} />}
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
              {items.length === 0 ? (
                <div className="px-2 py-3 text-xs text-gray-400">暂无请求目录</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {items.map((item) => {
                    const active = item.messageId === selectedMessageId;
                    return (
                      <button
                        key={item.messageId}
                        type="button"
                        onClick={() => onSelect(item.messageId)}
                        className={[
                          'group relative w-full rounded-lg px-2.5 py-2 text-left',
                          'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900',
                          active
                            ? "bg-blue-50 text-blue-800 before:absolute before:left-0 before:top-1/2 before:h-6 before:w-1 before:-translate-y-1/2 before:rounded-r before:bg-blue-500 before:content-[''] dark:bg-blue-900/25 dark:text-blue-100 dark:before:bg-blue-400"
                            : 'text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800/60',
                        ].join(' ')}
                        title={item.preview}
                        aria-current={active ? 'true' : undefined}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className={[
                              'mt-0.5 inline-flex h-5 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold',
                              active
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                                : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                            ].join(' ')}
                          >
                            {item.index}
                          </span>
                          <span className="min-w-0 flex-1 text-xs leading-5">
                            <span className={`block line-clamp-2 ${active ? 'font-semibold' : 'font-medium'}`}>
                              {item.preview}
                            </span>
                          </span>
                          <ChevronRight
                            size={14}
                            className={[
                              'mt-0.5 shrink-0 text-gray-300 transition-opacity',
                              active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                              'dark:text-gray-600',
                            ].join(' ')}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-gray-200/70 bg-white/40 px-3 py-2 dark:border-gray-800 dark:bg-gray-900/20">
              {selected ? (
                <>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
                    <span>请求 #{selected.index}</span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">点击目录项可定位</span>
                  </div>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-gray-700 scrollbar-thin scrollbar-thumb-gray-300 dark:text-gray-200 dark:scrollbar-thumb-gray-700">
                    {selectedFullText ?? '（未找到原文）'}
                  </div>
                </>
              ) : (
                <div className="text-xs text-gray-400">点击目录项查看完整文本</div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default ChatOutlinePanel;
