import { MessageSquareText, Settings, History, NotebookPen } from "lucide-react";
import type { ReactNode } from "react";
import { clsx } from "../lib/clsx";
import type { RootTab } from "./types";

export function PhoneShell({
  tab,
  onTabChange,
  children,
}: {
  tab: RootTab;
  onTabChange: (next: RootTab) => void;
  children: ReactNode;
}) {
  return (
    <div className="safe-top h-full box-border flex flex-col overflow-x-hidden overflow-y-hidden">
      <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-hidden">{children}</div>
      <nav className="safe-bottom border-t border-white/10 bg-[#0b1220]">
        <div className="grid grid-cols-4">
          <TabButton
            active={tab === "chat"}
            label="聊天"
            onClick={() => onTabChange("chat")}
            icon={<MessageSquareText size={18} />}
          />
          <TabButton
            active={tab === "history"}
            label="会话"
            onClick={() => onTabChange("history")}
            icon={<History size={18} />}
          />
          <TabButton
            active={tab === "practice"}
            label="练习"
            onClick={() => onTabChange("practice")}
            icon={<NotebookPen size={18} />}
          />
          <TabButton
            active={tab === "settings"}
            label="设置"
            onClick={() => onTabChange("settings")}
            icon={<Settings size={18} />}
          />
        </div>
      </nav>
    </div>
  );
}

function TabButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "h-14 flex flex-col items-center justify-center gap-1 text-xs",
        active ? "text-white" : "text-white/60",
      )}
      onClick={onClick}
      type="button"
    >
      {icon}
      <div>{label}</div>
    </button>
  );
}
