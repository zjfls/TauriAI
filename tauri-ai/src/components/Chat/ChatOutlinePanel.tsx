import React, { useMemo } from 'react';
import { ChevronLeft, ListOrdered } from 'lucide-react';

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
  onToggle: () => void;
  onSelect: (messageId: string) => void;
}> = ({ items, selectedMessageId, selectedFullText, isOpen, onToggle, onSelect }) => {
  const selected = useMemo(() => {
    if (!selectedMessageId) return null;
    return items.find((i) => i.messageId === selectedMessageId) ?? null;
  }, [items, selectedMessageId]);

  return (
    <div
      className={[
        isOpen ? 'w-56' : 'w-7',
        'flex-shrink-0 overflow-hidden',
        'transition-[width] duration-200 ease-out',
        isOpen ? 'border-r border-gray-200 dark:border-gray-800' : 'border-r border-transparent',
        isOpen ? 'bg-white/60 dark:bg-gray-900/40 backdrop-blur' : 'bg-transparent',
        'flex min-h-0 flex-col',
      ].join(' ')}
      aria-label="消息目录"
    >
      {!isOpen ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex h-full w-full flex-col items-center gap-2 px-1 py-2 text-gray-500 hover:bg-gray-100/70 dark:text-gray-400 dark:hover:bg-gray-800/40"
          aria-label="打开消息目录"
          title="打开消息目录"
        >
          <ListOrdered size={16} className="mt-1 shrink-0" />
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            {items.length}
          </span>
        </button>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-gray-200/70 px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-300">
            <div className="flex items-center gap-2">
              <ListOrdered size={14} className="text-gray-400" />
              <span className="font-medium">目录</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {items.length}
              </span>
              <button
                type="button"
                onClick={onToggle}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                aria-label="收起消息目录"
                title="收起消息目录"
              >
                <ChevronLeft size={14} />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
              {items.length === 0 ? (
                <div className="px-2 py-3 text-xs text-gray-400">暂无请求目录</div>
              ) : (
                items.map((item) => {
                  const active = item.messageId === selectedMessageId;
                  return (
                    <button
                      key={item.messageId}
                      type="button"
                      onClick={() => onSelect(item.messageId)}
                      className={[
                        'w-full rounded-md px-2 py-2 text-left',
                        'transition-colors',
                        active
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/25 dark:text-blue-200'
                          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800/60',
                      ].join(' ')}
                      title={item.preview}
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 w-8 flex-shrink-0 text-[10px] text-gray-400">#{item.index}</span>
                        <span className="min-w-0 flex-1 truncate text-xs">{item.preview}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="border-t border-gray-200/70 px-3 py-2 dark:border-gray-800">
              {selected ? (
                <>
                  <div className="mb-1 text-[10px] text-gray-400">请求 #{selected.index}</div>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-gray-700 scrollbar-thin scrollbar-thumb-gray-300 dark:text-gray-200 dark:scrollbar-thumb-gray-700">
                    {selectedFullText ?? '（未找到原文）'}
                  </div>
                </>
              ) : (
                <div className="text-xs text-gray-400">点击目录项查看完整文本</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ChatOutlinePanel;
