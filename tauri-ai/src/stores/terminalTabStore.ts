import { create } from 'zustand';
import { useWorkspaceTabStore } from './workspaceTabStore';
import { useTerminalSessionStore } from './terminalSessionStore';

export type TerminalTab = {
  id: string;
  title: string;
  workdir?: string | null;
  createdAt: string;
  lastActiveAt: string;
};

const makeId = () => `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;

interface TerminalTabState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  openTerminalTab: (opts?: { title?: string; workdir?: string; activate?: boolean }) => string;
  closeTerminalTab: (id: string) => Promise<void>;
  setActiveTerminalTab: (id: string | null) => void;
  clearAll: () => Promise<void>;
}

export const useTerminalTabStore = create<TerminalTabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTerminalTab: (opts) => {
    const id = makeId();
    const now = new Date().toISOString();
    const title = (opts?.title ?? '').trim() || '终端';
    const tab: TerminalTab = {
      id,
      title,
      workdir: opts?.workdir ?? null,
      createdAt: now,
      lastActiveAt: now,
    };

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: opts?.activate === false ? state.activeTabId : id,
    }));

    useWorkspaceTabStore.getState().upsertTerminalTab(id);
    return id;
  },

  closeTerminalTab: async (id) => {
    // Session 生命周期由统一的 terminalSessionStore 管理（scope 隔离）。
    // 关闭 tab 时主动关闭后端 PTY，避免组件未挂载时遗留会话。
    await useTerminalSessionStore.getState().closeSession({ kind: 'workspace_terminal', id });

    const nextTabs = get().tabs.filter((t) => t.id !== id);
    const nextActive =
      get().activeTabId === id ? (nextTabs.length > 0 ? nextTabs[nextTabs.length - 1]!.id : null) : get().activeTabId;
    set({ tabs: nextTabs, activeTabId: nextActive });
    useWorkspaceTabStore.getState().removeTerminalTab(id);
  },

  setActiveTerminalTab: (id) => {
    set((state) => ({
      activeTabId: id,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: new Date().toISOString() } : t
      ),
    }));
  },

  clearAll: async () => {
    const ids = get().tabs.map((t) => t.id);
    // eslint-disable-next-line no-await-in-loop
    for (const id of ids) await get().closeTerminalTab(id);
  },
}));
