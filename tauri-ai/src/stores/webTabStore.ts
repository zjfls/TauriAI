import { create } from 'zustand';
import { useUIStore } from './uiStore';
import { useWorkspaceTabStore } from './workspaceTabStore';

export type WebTab = {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
};

const normalizeWebUrl = (input: string): string => {
  const raw = (input ?? '').trim();
  if (!raw) return 'about:blank';
  if (raw.startsWith('about:')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return `https://${raw}`;
};

const defaultTitleForUrl = (url: string): string => {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:') return '网页';
    return u.hostname || url;
  } catch {
    return url || '网页';
  }
};

const makeId = () => `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;

interface WebTabState {
  tabs: WebTab[];
  activeTabId: string | null;

  openWebTab: (url: string, opts?: { title?: string; activate?: boolean }) => string;
  closeWebTab: (id: string) => void;
  setActiveWebTab: (id: string | null) => void;
  updateWebTab: (id: string, patch: Partial<Pick<WebTab, 'url' | 'title'>>) => void;
  clearAll: () => void;
}

export const useWebTabStore = create<WebTabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openWebTab: (url, opts) => {
    const normalized = normalizeWebUrl(url);
    const id = makeId();
    const now = new Date().toISOString();
    const title = (opts?.title ?? '').trim() || defaultTitleForUrl(normalized);

    const tab: WebTab = {
      id,
      url: normalized,
      title,
      createdAt: now,
      lastActiveAt: now,
    };

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: opts?.activate === false ? state.activeTabId : id,
    }));

    useWorkspaceTabStore.getState().upsertWebTab(id);
    if (opts?.activate !== false) {
      useUIStore.getState().setActiveView('web');
    }
    return id;
  },

  closeWebTab: (id) => {
    const state = get();
    const nextTabs = state.tabs.filter((t) => t.id !== id);
    const nextActive =
      state.activeTabId === id ? (nextTabs.length > 0 ? nextTabs[nextTabs.length - 1]!.id : null) : state.activeTabId;

    set({ tabs: nextTabs, activeTabId: nextActive });
    useWorkspaceTabStore.getState().removeWebTab(id);

    if (nextTabs.length === 0 && useUIStore.getState().activeView === 'web') {
      useUIStore.getState().setActiveView('chat');
    }
  },

  setActiveWebTab: (id) => {
    set((state) => ({
      activeTabId: id,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: new Date().toISOString() } : t
      ),
    }));
  },

  updateWebTab: (id, patch) => {
    const nextUrl = patch.url !== undefined ? normalizeWebUrl(patch.url) : undefined;
    const nextTitle = patch.title !== undefined ? patch.title : undefined;
    const now = new Date().toISOString();

    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.id !== id) return t;
        const url = nextUrl ?? t.url;
        const title = (nextTitle ?? t.title).trim() || defaultTitleForUrl(url);
        return { ...t, url, title, lastActiveAt: now };
      }),
    }));
  },

  clearAll: () => {
    const ids = get().tabs.map((t) => t.id);
    for (const id of ids) {
      useWorkspaceTabStore.getState().removeWebTab(id);
    }
    set({ tabs: [], activeTabId: null });
    if (useUIStore.getState().activeView === 'web') {
      useUIStore.getState().setActiveView('chat');
    }
  },
}));

