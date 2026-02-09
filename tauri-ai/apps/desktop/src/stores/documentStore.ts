import { create } from 'zustand';
import { useWorkspaceTabStore } from './workspaceTabStore';
import { getWindowScopedStorageKey } from '../utils/windowStorage';

export type DocumentKind = 'text';

export type DocumentRevealTarget = {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
};

export interface OpenDocument {
  id: string;
  title: string;
  path?: string;
  kind: DocumentKind;
  content: string;
  /** 是否已加载内容（用于避免把大文件内容塞进 localStorage；需要时再从磁盘读） */
  contentLoaded?: boolean;
  openedAt: string;
  updatedAt: string;
}

interface DocumentState {
  documents: OpenDocument[];
  activeDocumentId: string | null;
  revealTargets: Record<string, DocumentRevealTarget | undefined>;
  openDocument: (doc: Omit<OpenDocument, 'id' | 'openedAt' | 'updatedAt'> & { id?: string }) => string;
  closeDocument: (id: string) => void;
  setActiveDocument: (id: string | null) => void;
  updateDocumentContent: (id: string, content: string) => void;
  updateDocumentMeta: (
    id: string,
    meta: Partial<Pick<OpenDocument, 'title' | 'path' | 'kind'>>
  ) => void;
  setRevealTarget: (id: string, target: DocumentRevealTarget | null) => void;
  clearAllDocuments: () => void;
}

const makeDocId = () => `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`;

type PersistedDocument = {
  id: string;
  title: string;
  path?: string | null;
  kind: DocumentKind;
  content?: string | null;
  contentLoaded?: boolean;
  openedAt: string;
  updatedAt: string;
};

type PersistedDocumentState = {
  version: 1;
  documents: PersistedDocument[];
  activeDocumentId: string | null;
};

const STORAGE_KEY_PREFIX = 'tauri-ai:documents:v1';
const getStorageKey = (): string => getWindowScopedStorageKey(STORAGE_KEY_PREFIX);

const MAX_PERSIST_DOC_CHARS = 220_000;
const PERSIST_DEBOUNCE_MS = 800;

const safeParseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const loadInitialState = (): Pick<DocumentState, 'documents' | 'activeDocumentId'> => {
  try {
    if (typeof window === 'undefined') return { documents: [], activeDocumentId: null };
    const raw = window.localStorage.getItem(getStorageKey());
    const parsed = safeParseJson<PersistedDocumentState>(raw);
    const docsRaw = Array.isArray(parsed?.documents) ? parsed!.documents : [];

    const documents: OpenDocument[] = [];
    const seen = new Set<string>();
    for (const d of docsRaw) {
      const id = typeof d?.id === 'string' ? d.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const title = typeof d?.title === 'string' ? d.title : 'Untitled';
      const path = typeof d?.path === 'string' && d.path.trim() ? d.path.trim() : undefined;
      const kind: DocumentKind = d?.kind === 'text' ? 'text' : 'text';
      const openedAt = typeof d?.openedAt === 'string' ? d.openedAt : new Date().toISOString();
      const updatedAt = typeof d?.updatedAt === 'string' ? d.updatedAt : openedAt;

      const contentStr = typeof d?.content === 'string' ? d.content : '';
      const contentLoaded = typeof d?.contentLoaded === 'boolean' ? d.contentLoaded : Boolean(contentStr);

      documents.push({
        id,
        title,
        path,
        kind,
        content: contentStr,
        contentLoaded,
        openedAt,
        updatedAt,
      });
    }

    const activeDocumentId =
      typeof parsed?.activeDocumentId === 'string' && documents.some((d) => d.id === parsed.activeDocumentId)
        ? parsed.activeDocumentId
        : null;

    return { documents, activeDocumentId };
  } catch {
    return { documents: [], activeDocumentId: null };
  }
};

const persistState = (next: Pick<DocumentState, 'documents' | 'activeDocumentId'>) => {
  try {
    if (typeof window === 'undefined') return;

    const documents: PersistedDocument[] = next.documents.map((d) => {
      const content = (d.content ?? '').toString();
      const canPersistContent = content.length <= MAX_PERSIST_DOC_CHARS;
      return {
        id: d.id,
        title: d.title,
        path: d.path ?? null,
        kind: d.kind,
        content: canPersistContent ? content : null,
        // When content is too large, do not claim it is loaded; we expect a lazy reload from disk when possible.
        contentLoaded: canPersistContent ? true : false,
        openedAt: d.openedAt,
        updatedAt: d.updatedAt,
      };
    });

    const payload: PersistedDocumentState = {
      version: 1,
      documents,
      activeDocumentId: next.activeDocumentId,
    };

    window.localStorage.setItem(getStorageKey(), JSON.stringify(payload));
  } catch {
    // ignore
  }
};

export const useDocumentStore = create<DocumentState>((set, get) => {
  const initial = typeof window === 'undefined' ? { documents: [], activeDocumentId: null } : loadInitialState();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const persistNow = () => {
    if (typeof window === 'undefined') return;
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    const { documents, activeDocumentId } = get();
    persistState({ documents, activeDocumentId });
  };

  const schedulePersist = () => {
    if (typeof window === 'undefined') return;
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      const { documents, activeDocumentId } = get();
      persistState({ documents, activeDocumentId });
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    documents: initial.documents,
    activeDocumentId: initial.activeDocumentId,
    revealTargets: {},

  openDocument: (doc) => {
    const now = new Date().toISOString();
    const { documents } = get();

    // If a doc is opened from a file path, treat path as a stable identity.
    if (doc.path) {
      const existing = documents.find((d) => d.path === doc.path);
      if (existing) {
        set({
          documents: documents.map((d) =>
            d.id === existing.id
              ? {
                  ...d,
                  title: doc.title,
                  kind: doc.kind,
                  content: doc.content,
                  contentLoaded: true,
                  updatedAt: now,
                }
              : d
          ),
          activeDocumentId: existing.id,
        });
        useWorkspaceTabStore.getState().upsertDocumentTab(existing.id);
        persistNow();
        return existing.id;
      }
    }

    const id = doc.id ?? makeDocId();
    set({
      documents: [
        ...documents,
        {
          id,
          title: doc.title,
          path: doc.path,
          kind: doc.kind,
          content: doc.content,
          contentLoaded: true,
          openedAt: now,
          updatedAt: now,
        },
      ],
      activeDocumentId: id,
    });
    useWorkspaceTabStore.getState().upsertDocumentTab(id);
    persistNow();
    return id;
  },

  closeDocument: (id) => {
    const { documents, activeDocumentId } = get();
    const nextDocs = documents.filter((d) => d.id !== id);
    const nextActive =
      activeDocumentId === id
        ? (nextDocs.length > 0 ? nextDocs[nextDocs.length - 1].id : null)
        : activeDocumentId;
    set((state) => {
      const nextReveal = { ...state.revealTargets };
      delete nextReveal[id];
      return { documents: nextDocs, activeDocumentId: nextActive, revealTargets: nextReveal };
    });
    useWorkspaceTabStore.getState().removeDocumentTab(id);
    persistNow();
  },

  setActiveDocument: (id) => {
    set({ activeDocumentId: id });
    persistNow();
  },

  updateDocumentContent: (id, content) => {
    const { documents } = get();
    const now = new Date().toISOString();
    set({
      documents: documents.map((d) =>
        d.id === id ? { ...d, content, contentLoaded: true, updatedAt: now } : d
      ),
    });
    schedulePersist();
  },

  updateDocumentMeta: (id, meta) => {
    const { documents, activeDocumentId } = get();
    const now = new Date().toISOString();
    const target = documents.find((d) => d.id === id);
    if (!target) return;

    const nextPath = meta.path?.trim();
    if (nextPath) {
      const existingByPath = documents.find((d) => d.path === nextPath && d.id !== id);
      if (existingByPath) {
        // Path is treated as stable identity; avoid duplicates by merging into the existing doc.
        const mergedDocs = documents
          .filter((d) => d.id !== id)
          .map((d) =>
            d.id === existingByPath.id
              ? {
                  ...d,
                  title: meta.title ?? d.title,
                  path: nextPath,
                  kind: meta.kind ?? d.kind,
                  content: target.content,
                  updatedAt: now,
                }
              : d
          );
        const nextActive = activeDocumentId === id ? existingByPath.id : activeDocumentId;
        set({ documents: mergedDocs, activeDocumentId: nextActive });
        useWorkspaceTabStore.getState().removeDocumentTab(id);
        persistNow();
        return;
      }
    }

    set({
      documents: documents.map((d) =>
        d.id === id
          ? {
              ...d,
              ...(meta.title !== undefined ? { title: meta.title } : {}),
              ...(meta.path !== undefined ? { path: meta.path } : {}),
              ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
              updatedAt: now,
            }
          : d
      ),
    });
    persistNow();
  },

  setRevealTarget: (id, target) => {
    set((state) => {
      const next = { ...state.revealTargets };
      if (target) next[id] = target;
      else delete next[id];
      return { revealTargets: next };
    });
  },

  clearAllDocuments: () => {
    for (const d of get().documents) {
      useWorkspaceTabStore.getState().removeDocumentTab(d.id);
    }
    set({ documents: [], activeDocumentId: null, revealTargets: {} });
    persistNow();
  },
  };
});
