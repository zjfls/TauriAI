import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';

export type WorkspaceTabKind = 'chat' | 'document';

export type WorkspaceTabId = `chat:${string}` | `doc:${string}`;

export interface WorkspaceTab {
  id: WorkspaceTabId;
  kind: WorkspaceTabKind;
  // One of these will be set depending on kind.
  sessionId?: string;
  documentId?: string;
}

export const chatTabId = (sessionId: string): WorkspaceTabId => `chat:${sessionId}`;
export const docTabId = (documentId: string): WorkspaceTabId => `doc:${documentId}`;

export const parseWorkspaceTabId = (id: WorkspaceTabId): WorkspaceTab => {
  if (id.startsWith('chat:')) {
    const sessionId = id.slice('chat:'.length);
    return { id, kind: 'chat', sessionId };
  }
  const documentId = id.slice('doc:'.length);
  return { id, kind: 'document', documentId };
};

const STORAGE_KEY = 'tauri-ai:workspace-tabs:v1';

interface WorkspaceTabState {
  tabOrder: WorkspaceTabId[];

  upsertChatTab: (sessionId: string) => void;
  removeChatTab: (sessionId: string) => void;

  upsertDocumentTab: (documentId: string) => void;
  removeDocumentTab: (documentId: string) => void;

  reorderTabs: (activeId: WorkspaceTabId, overId: WorkspaceTabId) => void;
  setTabOrder: (order: WorkspaceTabId[]) => void;
  syncTabs: (chatSessionIds: string[], documentIds: string[]) => void;
}

const loadInitialOrder = (): WorkspaceTabId[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { tabOrder?: string[] } | null;
    const items = parsed?.tabOrder ?? [];
    // Best-effort validation: keep only known prefixes.
    return items
      .filter((s) => typeof s === 'string')
      .filter((s) => s.startsWith('chat:') || s.startsWith('doc:')) as WorkspaceTabId[];
  } catch {
    return [];
  }
};

const persistOrder = (tabOrder: WorkspaceTabId[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabOrder }));
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

  syncTabs: (chatSessionIds, documentIds) => {
    const known = new Set<WorkspaceTabId>();
    for (const id of chatSessionIds) known.add(chatTabId(id));
    for (const id of documentIds) known.add(docTabId(id));

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

