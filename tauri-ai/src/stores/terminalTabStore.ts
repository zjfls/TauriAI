import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useWorkspaceTabStore } from './workspaceTabStore';

export type TerminalTab = {
  id: string;
  title: string;
  workdir?: string | null;
  sessionId: number | null;
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
  ensureTerminalSession: (id: string) => Promise<number | null>;
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
      sessionId: null,
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
    const state = get();
    const target = state.tabs.find((t) => t.id === id) ?? null;

    if (target?.sessionId && isTauri()) {
      try {
        await invoke('terminal_close', { terminalId: id, sessionId: target.sessionId });
      } catch {
        // ignore
      }
    }

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

  ensureTerminalSession: async (id) => {
    const state = get();
    const target = state.tabs.find((t) => t.id === id) ?? null;
    if (!target) return null;
    if (target.sessionId) return target.sessionId;
    if (!isTauri()) return null;

    const sessionId = await invoke<number>('terminal_create', {
      terminalId: id,
      workdir: target.workdir ?? undefined,
    });

    set((prev) => ({
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, sessionId } : t)),
    }));
    return sessionId;
  },

  clearAll: async () => {
    const ids = get().tabs.map((t) => t.id);
    // eslint-disable-next-line no-await-in-loop
    for (const id of ids) await get().closeTerminalTab(id);
  },
}));
