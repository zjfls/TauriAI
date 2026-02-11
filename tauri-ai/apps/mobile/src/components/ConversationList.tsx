import { Plus, Trash2 } from "lucide-react";
import type { Conversation } from "../types/chat";
import { clsx } from "../lib/clsx";
import { Button } from "../ui/Button";

export function ConversationList({
  conversations,
  activeId,
  onCreate,
  onSelect,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="h-full flex flex-col overflow-x-hidden">
      <div className="safe-top border-b border-white/10">
        <div className="h-12 flex items-center justify-between px-3">
          <div className="text-sm text-white/80">会话</div>
          <Button size="sm" variant="ghost" onClick={onCreate} title="新建对话">
            <Plus size={16} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-none overflow-x-hidden">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={clsx(
              "px-3 py-2 border-b border-white/5 cursor-pointer group",
              c.id === activeId ? "bg-indigo-500/10" : "hover:bg-white/5",
            )}
            onClick={() => onSelect(c.id)}
            role="button"
            tabIndex={0}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm truncate">{c.title || "未命名"}</div>
                <div className="text-xs text-white/50 truncate">
                  {c.messages.length > 0 ? c.messages[c.messages.length - 1]?.content : "（空对话）"}
                </div>
              </div>
              <button
                type="button"
                className="h-8 w-8 rounded-md bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                title="删除"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
