import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';

export type WorkspaceTabKind = 'chat' | 'document' | 'web' | 'terminal';

export type WorkspaceTabId = `chat:${string}` | `doc:${string}` | `web:${string}` | `term:${string}`;

export interface WorkspaceTab {
  id: WorkspaceTabId;
  kind: WorkspaceTabKind;
  // One of these will be set depending on kind.
  sessionId?: string;
  documentId?: string;
  webTabId?: string;
  terminalTabId?: string;
}

export const chatTabId = (sessionId: string): WorkspaceTabId => `chat:${sessionId}`;
export const docTabId = (documentId: string): WorkspaceTabId => `doc:${documentId}`;
export const webTabId = (webTabId: string): WorkspaceTabId => `web:${webTabId}`;
export const terminalTabId = (terminalTabId: string): WorkspaceTabId => `term:${terminalTabId}`;

export const parseWorkspaceTabId = (id: WorkspaceTabId): WorkspaceTab => {
  if (id.startsWith('chat:')) {
    const sessionId = id.slice('chat:'.length);
    return { id, kind: 'chat', sessionId };
  }
  if (id.startsWith('doc:')) {
    const documentId = id.slice('doc:'.length);
    return { id, kind: 'document', documentId };
  }
  if (id.startsWith('web:')) {
    const webId = id.slice('web:'.length);
    return { id, kind: 'web', webTabId: webId };
  }
  const termId = id.slice('term:'.length);
  return { id, kind: 'terminal', terminalTabId: termId };
};

const STORAGE_KEY = 'tauri-ai:workspace-tabs:v1';

const isStandaloneWindow = (): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('standalone') === '1';
  } catch {
    return false;
  }
};

const getWorkspaceTabStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null;
    // 多窗口隔离：standalone 窗口用 sessionStorage（每个窗口独立），主窗口用 localStorage（跨重启持久化）。
    return isStandaloneWindow() ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
};

interface WorkspaceTabState {
  tabOrder: WorkspaceTabId[];

  upsertChatTab: (sessionId: string) => void;
  removeChatTab: (sessionId: string) => void;

  upsertDocumentTab: (documentId: string) => void;
  removeDocumentTab: (documentId: string) => void;

  upsertWebTab: (webTabId: string) => void;
  removeWebTab: (webTabId: string) => void;

  upsertTerminalTab: (terminalTabId: string) => void;
  removeTerminalTab: (terminalTabId: string) => void;

  reorderTabs: (activeId: WorkspaceTabId, overId: WorkspaceTabId) => void;
  setTabOrder: (order: WorkspaceTabId[]) => void;
  syncTabs: (chatSessionIds: string[], documentIds: string[], webTabIds: string[], terminalTabIds: string[]) => void;
}

const loadInitialOrder = (): WorkspaceTabId[] => {
  try {
    const storage = getWorkspaceTabStorage();
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { tabOrder?: string[] } | null;
    const items = parsed?.tabOrder ?? [];
    // Best-effort validation: keep only known prefixes.
    return items
      .filter((s) => typeof s === 'string')
      .filter((s) => s.startsWith('chat:') || s.startsWith('doc:') || s.startsWith('web:') || s.startsWith('term:')) as WorkspaceTabId[];
  } catch {
    return [];
  }
};

const persistOrder = (tabOrder: WorkspaceTabId[]) => {
  try {
    const storage = getWorkspaceTabStorage();
    storage?.setItem(STORAGE_KEY, JSON.stringify({ tabOrder }));
  } catch {
    // ignore
  }
};

export const useWorkspaceTabStore = create<WorkspaceTabState>((set, get) => ({
  tabOrder: typeof window === 'undefined' ? [] : loadInitialOrder(),

  upsertChatTab: (sessionId) => {
    const id = chatTabId(sessionId);
    const { tabOrder } = get();
    if (tabOrder.includes(id)) return;
    const next = [...tabOrder, id];
    set({ tabOrder: next });
    persistOrder(next);
  },

  removeChatTab: (sessionId) => {
    const id = chatTabId(sessionId);
    const next = get().tabOrder.filter((t) => t !== id);
    set({ tabOrder: next });
    persistOrder(next);
  },

  upsertDocumentTab: (documentId) => {
    const id = docTabId(documentId);
    const { tabOrder } = get();
    if (tabOrder.includes(id)) return;
    const next = [...tabOrder, id];
    set({ tabOrder: next });
    persistOrder(next);
  },

  removeDocumentTab: (documentId) => {
    const id = docTabId(documentId);
    const next = get().tabOrder.filter((t) => t !== id);
    set({ tabOrder: next });
    persistOrder(next);
  },

  upsertWebTab: (webId) => {
    const id = webTabId(webId);
    const { tabOrder } = get();
    if (tabOrder.includes(id)) return;
    const next = [...tabOrder, id];
    set({ tabOrder: next });
    persistOrder(next);
  },

  removeWebTab: (webId) => {
    const id = webTabId(webId);
    const next = get().tabOrder.filter((t) => t !== id);
    set({ tabOrder: next });
    persistOrder(next);
  },

  upsertTerminalTab: (termId) => {
    const id = terminalTabId(termId);
    const { tabOrder } = get();
    if (tabOrder.includes(id)) return;
    const next = [...tabOrder, id];
    set({ tabOrder: next });
    persistOrder(next);
  },

  removeTerminalTab: (termId) => {
    const id = terminalTabId(termId);
    const next = get().tabOrder.filter((t) => t !== id);
    set({ tabOrder: next });
    persistOrder(next);
  },

  reorderTabs: (activeId, overId) => {
    const { tabOrder } = get();
    const oldIndex = tabOrder.indexOf(activeId);
    const newIndex = tabOrder.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const next = arrayMove(tabOrder, oldIndex, newIndex);
    set({ tabOrder: next });
    persistOrder(next);
  },

  setTabOrder: (order) => {
    set({ tabOrder: order });
    persistOrder(order);
  },

  syncTabs: (chatSessionIds, documentIds, webTabIds, terminalTabIds) => {
    const known = new Set<WorkspaceTabId>();
    for (const id of chatSessionIds) known.add(chatTabId(id));
    for (const id of documentIds) known.add(docTabId(id));
    for (const id of webTabIds) known.add(webTabId(id));
    for (const id of terminalTabIds) known.add(terminalTabId(id));

    const current = get().tabOrder;
    const next: WorkspaceTabId[] = [];

    // Keep existing order for items that still exist.
    for (const t of current) {
      if (known.has(t)) {
        next.push(t);
        known.delete(t);
      }
    }

    // Append any new tabs not previously recorded.
    for (const t of known) {
      next.push(t);
    }

    set({ tabOrder: next });
    persistOrder(next);
  },
}));

