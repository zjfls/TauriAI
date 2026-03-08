import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import { getWindowLabelForStorage, getWindowScopedStorageKey, isMainWindowLabel } from '../utils/windowStorage';

export type WorkspaceTabKind = 'chat' | 'document' | 'web' | 'terminal' | 'practice';

export type WorkspaceTabId =
  | `chat:${string}`
  | `doc:${string}`
  | `web:${string}`
  | `term:${string}`
  | `practice:${string}`;

export interface WorkspaceTab {
  id: WorkspaceTabId;
  kind: WorkspaceTabKind;
  sessionId?: string;
  documentId?: string;
  webTabId?: string;
  terminalTabId?: string;
  practiceTabId?: string;
}

export const PRACTICE_TAB_KEY = 'main';

export const chatTabId = (sessionId: string): WorkspaceTabId => `chat:${sessionId}`;
export const docTabId = (documentId: string): WorkspaceTabId => `doc:${documentId}`;
export const webTabId = (webTabId: string): WorkspaceTabId => `web:${webTabId}`;
export const terminalTabId = (terminalTabId: string): WorkspaceTabId => `term:${terminalTabId}`;
export const practiceTabId = (practiceId: string = PRACTICE_TAB_KEY): WorkspaceTabId => `practice:${practiceId}`;

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
  if (id.startsWith('practice:')) {
    const practiceId = id.slice('practice:'.length);
    return { id, kind: 'practice', practiceTabId: practiceId };
  }
  const termId = id.slice('term:'.length);
  return { id, kind: 'terminal', terminalTabId: termId };
};

const STORAGE_KEY_PREFIX = 'tauri-ai:workspace-tabs:v2';
const LEGACY_STORAGE_KEY = 'tauri-ai:workspace-tabs:v1';

const getStorageKey = (): string => getWindowScopedStorageKey(STORAGE_KEY_PREFIX);

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

  upsertPracticeTab: () => void;
  removePracticeTab: () => void;

  reorderTabs: (activeId: WorkspaceTabId, overId: WorkspaceTabId) => void;
  setTabOrder: (order: WorkspaceTabId[]) => void;
  syncTabs: (chatSessionIds: string[], documentIds: string[], webTabIds: string[], terminalTabIds: string[]) => void;
}

const loadInitialOrder = (): WorkspaceTabId[] => {
  try {
    if (typeof window === 'undefined') return [];
    const storage = window.localStorage;
    const key = getStorageKey();
    let raw = storage.getItem(key);

    if (!raw && isMainWindowLabel(getWindowLabelForStorage())) {
      raw = storage.getItem(LEGACY_STORAGE_KEY);
    }

    if (!raw) return [];
    const parsed = JSON.parse(raw) as { tabOrder?: string[] } | null;
    const items = parsed?.tabOrder ?? [];

    const next = items
      .filter((s) => typeof s === 'string')
      .filter(
        (s) =>
          s.startsWith('chat:') ||
          s.startsWith('doc:') ||
          s.startsWith('web:') ||
          s.startsWith('term:') ||
          s.startsWith('practice:')
      ) as WorkspaceTabId[];

    try {
      storage.setItem(key, JSON.stringify({ tabOrder: next }));
    } catch {
      // ignore
    }

    return next;
  } catch {
    return [];
  }
};

const persistOrder = (tabOrder: WorkspaceTabId[]) => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(getStorageKey(), JSON.stringify({ tabOrder }));
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

  upsertPracticeTab: () => {
    const id = practiceTabId();
    const { tabOrder } = get();
    if (tabOrder.includes(id)) return;
    const next = [...tabOrder, id];
    set({ tabOrder: next });
    persistOrder(next);
  },

  removePracticeTab: () => {
    const id = practiceTabId();
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
    const current = get().tabOrder;
    const known = new Set<WorkspaceTabId>();
    for (const id of chatSessionIds) known.add(chatTabId(id));
    for (const id of documentIds) known.add(docTabId(id));
    for (const id of webTabIds) known.add(webTabId(id));
    for (const id of terminalTabIds) known.add(terminalTabId(id));

    const practiceId = practiceTabId();
    if (current.includes(practiceId)) {
      known.add(practiceId);
    }

    const next: WorkspaceTabId[] = [];

    for (const t of current) {
      if (known.has(t)) {
        next.push(t);
        known.delete(t);
      }
    }

    for (const t of known) {
      next.push(t);
    }

    set({ tabOrder: next });
    persistOrder(next);
  },
}));
