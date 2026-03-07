import React from "react";
import { Search } from "lucide-react";

import type { SymbolSearchItem } from "./symbolSearch";

type SymbolSearchDialogProps = {
  title: string;
  shortcutLabel?: string;
  query: string;
  onQueryChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  loading?: boolean;
  error?: string | null;
  items: SymbolSearchItem[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onPick: (item: SymbolSearchItem) => void;
  onClose: () => void;
  emptyText: string;
  helperText?: string;
  pathLabel?: (item: SymbolSearchItem) => string;
};

export const SymbolSearchDialog: React.FC<SymbolSearchDialogProps> = ({
  title,
  shortcutLabel,
  query,
  onQueryChange,
  inputRef,
  placeholder,
  loading = false,
  error = null,
  items,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
  onClose,
  emptyText,
  helperText,
  pathLabel,
}) => {
  const selected = items[selectedIndex] ?? null;

  return (
    <div
      className="fixed inset-0 z-[230] flex items-start justify-center bg-black/40 px-4 py-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-[720px] max-w-[96vw] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </div>
              {(shortcutLabel || helperText) && (
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {shortcutLabel ? `快捷键：${shortcutLabel}` : helperText}
                  {shortcutLabel && helperText ? ` · ${helperText}` : ""}
                </div>
              )}
            </div>
            {selected && (
              <div className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                {selectedIndex + 1} / {items.length}
              </div>
            )}
          </div>
        </div>

        <div className="p-4">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              autoFocus
              ref={inputRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onClose();
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  onSelectedIndexChange(
                    Math.min(selectedIndex + 1, Math.max(0, items.length - 1)),
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  onSelectedIndexChange(Math.max(0, selectedIndex - 1));
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (selected) onPick(selected);
                }
              }}
            />
          </div>

          <div className="mt-3 max-h-[60vh] overflow-auto rounded-xl border border-gray-200 dark:border-gray-700">
            {error ? (
              <div className="px-3 py-3 whitespace-pre-wrap break-words text-sm text-red-600 dark:text-red-300">
                {error}
              </div>
            ) : loading && items.length === 0 ? (
              <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                搜索中...
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                {emptyText}
              </div>
            ) : (
              items.map((item, index) => {
                const locationLabel = `${item.selectionLine}:${item.selectionColumn}`;
                const extraSegments = [
                  item.containerName,
                  pathLabel ? pathLabel(item) : "",
                  locationLabel,
                ].filter(Boolean);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={[
                      "w-full px-3 py-2 text-left",
                      index === selectedIndex
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
                        : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800",
                    ].join(" ")}
                    onMouseEnter={() => onSelectedIndexChange(index)}
                    onClick={() => onPick(item)}
                    title={item.filePath}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.name}
                      </div>
                      <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        {item.kind}
                      </span>
                    </div>
                    {extraSegments.length > 0 && (
                      <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">
                        {extraSegments.join(" · ")}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
