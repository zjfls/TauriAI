import { create } from 'zustand';
import { useWorkspaceTabStore } from './workspaceTabStore';
import { useTerminalSessionStore } from './terminalSessionStore';
import { getWindowScopedStorageKey } from '../utils/windowStorage';

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

type PersistedTerminalTabState = {
  version: 1;
  tabs: TerminalTab[];
  activeTabId: string | null;
};

const STORAGE_KEY_PREFIX = 'tauri-ai:terminal-tabs:v1';
const getStorageKey = (): string => getWindowScopedStorageKey(STORAGE_KEY_PREFIX);

const safeParseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const loadInitialState = (): Pick<TerminalTabState, 'tabs' | 'activeTabId'> => {
  try {
    if (typeof window === 'undefined') return { tabs: [], activeTabId: null };
    const raw = window.localStorage.getItem(getStorageKey());
    const parsed = safeParseJson<PersistedTerminalTabState>(raw);
    const tabsRaw = Array.isArray(parsed?.tabs) ? parsed!.tabs : [];

    const tabs: TerminalTab[] = [];
    const seen = new Set<string>();
    for (const t of tabsRaw) {
      const id = typeof (t as any)?.id === 'string' ? (t as any).id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = (typeof (t as any)?.title === 'string' ? (t as any).title : '').trim() || '终端';
      const workdir = typeof (t as any)?.workdir === 'string' ? (t as any).workdir : null;
      const createdAt = typeof (t as any)?.createdAt === 'string' ? (t as any).createdAt : new Date().toISOString();
      const lastActiveAt = typeof (t as any)?.lastActiveAt === 'string' ? (t as any).lastActiveAt : createdAt;
      tabs.push({ id, title, workdir, createdAt, lastActiveAt });
    }

    const activeTabId =
      typeof parsed?.activeTabId === 'string' && tabs.some((t) => t.id === parsed.activeTabId) ? parsed.activeTabId : null;
    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
};

const persistState = (next: Pick<TerminalTabState, 'tabs' | 'activeTabId'>) => {
  try {
    if (typeof window === 'undefined') return;
    const payload: PersistedTerminalTabState = {
      version: 1,
      tabs: next.tabs,
      activeTabId: next.activeTabId,
    };
    window.localStorage.setItem(getStorageKey(), JSON.stringify(payload));
  } catch {
    // ignore
  }
};

export const useTerminalTabStore = create<TerminalTabState>((set, get) => ({
  ...(typeof window === 'undefined' ? { tabs: [], activeTabId: null } : loadInitialState()),

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
    persistState({ tabs: get().tabs, activeTabId: get().activeTabId });
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
    persistState({ tabs: nextTabs, activeTabId: nextActive });
  },

  setActiveTerminalTab: (id) => {
    set((state) => ({
      activeTabId: id,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: new Date().toISOString() } : t
      ),
    }));
    persistState({ tabs: get().tabs, activeTabId: id });
  },

  clearAll: async () => {
    const ids = get().tabs.map((t) => t.id);
    // eslint-disable-next-line no-await-in-loop
    for (const id of ids) await get().closeTerminalTab(id);
    persistState({ tabs: [], activeTabId: null });
  },
}));
