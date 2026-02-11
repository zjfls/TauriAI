import { History, MessageSquareText, PanelLeft, PanelRight, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { clsx } from "../lib/clsx";
import { loadJson, saveJson } from "../lib/storage";
import type { RootTab } from "./types";

type ShellPrefs = {
  listVisible: boolean;
};

const PREF_KEY = "tauriai.mobile.shell.prefs.v1";

export function TabletShell({
  tab,
  onTabChange,
  list,
  detail,
  listVisible,
  onToggleList,
  onNewConversation,
}: {
  tab: RootTab;
  onTabChange: (next: RootTab) => void;
  list?: ReactNode;
  detail: ReactNode;
  listVisible: boolean;
  onToggleList: () => void;
  onNewConversation?: () => void;
}) {
  return (
    <div className="h-full flex overflow-x-hidden overflow-y-hidden">
      <Rail tab={tab} onTabChange={onTabChange} />

      {listVisible && list ? (
        <aside className="w-[360px] border-r border-white/10 bg-white/5">{list}</aside>
      ) : null}

      <main className="flex-1 min-w-0 overflow-x-hidden overflow-y-hidden">
        <div className="h-12 border-b border-white/10 bg-white/5 flex items-center gap-2 px-3">
          <button
            type="button"
            className="h-8 w-8 rounded-md bg-white/5 hover:bg-white/10 flex items-center justify-center"
            onClick={onToggleList}
            title={listVisible ? "隐藏会话列表" : "显示会话列表"}
          >
            {listVisible ? <PanelRight size={18} /> : <PanelLeft size={18} />}
          </button>
          <div className="text-sm text-white/80 flex-1 min-w-0 truncate">{tabTitle(tab)}</div>
          {onNewConversation && tab !== "settings" ? (
            <button
              type="button"
              className={clsx(
                "h-8 w-8 rounded-md bg-white/5 hover:bg-white/10 flex items-center justify-center",
                "text-white/80 hover:text-white",
              )}
              onClick={onNewConversation}
              title="新建对话"
            >
              <Plus size={18} />
            </button>
          ) : null}
        </div>
        <div className="h-[calc(100%-3rem)]">{detail}</div>
      </main>
    </div>
  );
}

function Rail({ tab, onTabChange }: { tab: RootTab; onTabChange: (t: RootTab) => void }) {
  return (
    <aside className="w-16 border-r border-white/10 bg-[#0b1220] flex flex-col items-center py-3 gap-2">
      <RailButton
        active={tab === "chat"}
        label="聊天"
        onClick={() => onTabChange("chat")}
        icon={<MessageSquareText size={20} />}
      />
      <RailButton
        active={tab === "history"}
        label="会话"
        onClick={() => onTabChange("history")}
        icon={<History size={20} />}
      />
      <RailButton
        active={tab === "settings"}
        label="设置"
        onClick={() => onTabChange("settings")}
        icon={<Settings size={20} />}
      />
    </aside>
  );
}

function RailButton({
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
      type="button"
      className={clsx(
        "h-12 w-12 rounded-xl flex items-center justify-center transition-colors",
        active ? "bg-indigo-500/20 text-white" : "bg-white/5 hover:bg-white/10 text-white/80",
      )}
      onClick={onClick}
      title={label}
    >
      {icon}
    </button>
  );
}

function tabTitle(tab: RootTab): string {
  if (tab === "chat") return "聊天";
  if (tab === "history") return "会话";
  return "设置";
}

export function loadShellPrefs(): ShellPrefs {
  return loadJson<ShellPrefs>(PREF_KEY, { listVisible: true });
}

export function saveShellPrefs(next: ShellPrefs): void {
  saveJson(PREF_KEY, next);
}
