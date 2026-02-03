import { create } from 'zustand';
import { useWorkspaceTabStore } from './workspaceTabStore';

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

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  activeDocumentId: null,
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
                  updatedAt: now,
                }
              : d
          ),
          activeDocumentId: existing.id,
        });
        useWorkspaceTabStore.getState().upsertDocumentTab(existing.id);
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
          openedAt: now,
          updatedAt: now,
        },
      ],
      activeDocumentId: id,
    });
    useWorkspaceTabStore.getState().upsertDocumentTab(id);
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
  },

  setActiveDocument: (id) => {
    set({ activeDocumentId: id });
  },

  updateDocumentContent: (id, content) => {
    const { documents } = get();
    const now = new Date().toISOString();
    set({
      documents: documents.map((d) =>
        d.id === id ? { ...d, content, updatedAt: now } : d
      ),
    });
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
  },
}));
