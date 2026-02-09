import { create } from 'zustand';
import { useWorkspaceTabStore } from './workspaceTabStore';
import { getWindowScopedStorageKey } from '../utils/windowStorage';

export type WebTab = {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
};

type PersistedWebTabState = {
  version: 1;
  tabs: WebTab[];
  activeTabId: string | null;
};

const STORAGE_KEY_PREFIX = 'tauri-ai:web-tabs:v1';
const getStorageKey = (): string => getWindowScopedStorageKey(STORAGE_KEY_PREFIX);

const safeParseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const loadInitialState = (): Pick<WebTabState, 'tabs' | 'activeTabId'> => {
  try {
    if (typeof window === 'undefined') return { tabs: [], activeTabId: null };
    const raw = window.localStorage.getItem(getStorageKey());
    const parsed = safeParseJson<PersistedWebTabState>(raw);
    const tabsRaw = Array.isArray(parsed?.tabs) ? parsed!.tabs : [];

    const tabs: WebTab[] = [];
    const seen = new Set<string>();
    for (const t of tabsRaw) {
      const id = typeof t?.id === 'string' ? t.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const url = normalizeWebUrl(typeof t?.url === 'string' ? t.url : 'about:blank');
      const title = (typeof t?.title === 'string' ? t.title : '').trim() || defaultTitleForUrl(url);
      const createdAt = typeof t?.createdAt === 'string' ? t.createdAt : new Date().toISOString();
      const lastActiveAt = typeof t?.lastActiveAt === 'string' ? t.lastActiveAt : createdAt;
      tabs.push({ id, url, title, createdAt, lastActiveAt });
    }

    const activeTabId =
      typeof parsed?.activeTabId === 'string' && tabs.some((t) => t.id === parsed.activeTabId) ? parsed.activeTabId : null;
    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
};

const persistState = (next: Pick<WebTabState, 'tabs' | 'activeTabId'>) => {
  try {
    if (typeof window === 'undefined') return;
    const payload: PersistedWebTabState = {
      version: 1,
      tabs: next.tabs,
      activeTabId: next.activeTabId,
    };
    window.localStorage.setItem(getStorageKey(), JSON.stringify(payload));
  } catch {
    // ignore
  }
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
  ...(typeof window === 'undefined' ? { tabs: [], activeTabId: null } : loadInitialState()),

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
    persistState({ tabs: [...get().tabs], activeTabId: get().activeTabId });
    return id;
  },

  closeWebTab: (id) => {
    const state = get();
    const nextTabs = state.tabs.filter((t) => t.id !== id);
    const nextActive =
      state.activeTabId === id ? (nextTabs.length > 0 ? nextTabs[nextTabs.length - 1]!.id : null) : state.activeTabId;

    set({ tabs: nextTabs, activeTabId: nextActive });
    useWorkspaceTabStore.getState().removeWebTab(id);
    persistState({ tabs: nextTabs, activeTabId: nextActive });
  },

  setActiveWebTab: (id) => {
    set((state) => ({
      activeTabId: id,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, lastActiveAt: new Date().toISOString() } : t
      ),
    }));
    persistState({ tabs: get().tabs, activeTabId: id });
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
    persistState({ tabs: get().tabs, activeTabId: get().activeTabId });
  },

  clearAll: () => {
    const ids = get().tabs.map((t) => t.id);
    for (const id of ids) {
      useWorkspaceTabStore.getState().removeWebTab(id);
    }
    set({ tabs: [], activeTabId: null });
    persistState({ tabs: [], activeTabId: null });
  },
}));
