import { ChevronLeft, ChevronRight, ListOrdered } from "lucide-react";
import { clsx } from "../lib/clsx";

export type ChatOutlineItem = {
  messageId: string;
  index: number;
  preview: string;
};

export function ChatOutlineDrawer({
  open,
  items,
  selectedMessageId,
  selectedFullText,
  onClose,
  onToggle,
  onSelect,
}: {
  open: boolean;
  items: ChatOutlineItem[];
  selectedMessageId: string | null;
  selectedFullText?: string | null;
  onClose: () => void;
  onToggle: () => void;
  onSelect: (messageId: string) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" aria-hidden={!open}>
      <button
        type="button"
        aria-label="关闭消息目录"
        className={clsx(
          "absolute inset-0 bg-black/40 transition-opacity duration-200",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />

      <aside
        className={clsx(
          "absolute inset-y-0 left-0 w-[82vw] max-w-[340px]",
          "border-r border-white/10 bg-[#0b1220]/95 backdrop-blur",
          "flex flex-col min-h-0 transition-transform duration-200 ease-out",
          open ? "translate-x-0 pointer-events-auto" : "-translate-x-full pointer-events-none",
        )}
        aria-label="消息目录"
      >
        <div className="safe-top border-b border-white/10">
          <div className="h-12 px-3 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <ListOrdered size={16} className="text-white/70 shrink-0" />
              <span className="text-sm font-semibold text-white">目录</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
                {items.length}
              </span>
            </div>
            <button
              type="button"
              onClick={onToggle}
              className="h-8 w-8 rounded-md bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/80"
              title="收起消息目录"
              aria-label="收起消息目录"
            >
              <ChevronLeft size={14} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-none p-2">
          {items.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/60">
              暂无请求目录
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((item) => {
                const active = item.messageId === selectedMessageId;
                return (
                  <button
                    key={item.messageId}
                    type="button"
                    onClick={() => onSelect(item.messageId)}
                    className={clsx(
                      "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                      "border border-white/10",
                      active
                        ? "bg-indigo-500/20 text-white border-indigo-400/40"
                        : "bg-white/5 text-white/85 hover:bg-white/10",
                    )}
                    title={item.preview}
                    aria-current={active ? "true" : undefined}
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className={clsx(
                          "mt-0.5 inline-flex h-5 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold",
                          active ? "bg-indigo-500/30 text-indigo-100" : "bg-white/10 text-white/70",
                        )}
                      >
                        {item.index}
                      </span>
                      <span className="min-w-0 flex-1 text-xs leading-5">
                        <span className="block max-h-10 overflow-hidden break-words">
                          {item.preview}
                        </span>
                      </span>
                      <ChevronRight size={14} className={clsx("mt-0.5 shrink-0", active ? "text-indigo-200" : "text-white/30")} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="safe-bottom border-t border-white/10 bg-white/5 px-3 py-2">
          {selectedMessageId ? (
            <div className="space-y-1">
              <div className="text-[11px] text-white/60">当前请求</div>
              <div className="max-h-28 overflow-y-auto overscroll-none whitespace-pre-wrap text-xs leading-5 text-white/85">
                {selectedFullText?.trim() || "（未找到原文）"}
              </div>
            </div>
          ) : (
            <div className="text-xs text-white/60">点击目录项可定位消息</div>
          )}
        </div>
      </aside>
    </div>
  );
}

