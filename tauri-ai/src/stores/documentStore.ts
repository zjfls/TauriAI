import { create } from 'zustand';
import { useWorkspaceTabStore } from './workspaceTabStore';

export type DocumentKind = 'text';

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
  openDocument: (doc: Omit<OpenDocument, 'id' | 'openedAt' | 'updatedAt'> & { id?: string }) => string;
  closeDocument: (id: string) => void;
  setActiveDocument: (id: string | null) => void;
  updateDocumentContent: (id: string, content: string) => void;
  clearAllDocuments: () => void;
}

const makeDocId = () => `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  activeDocumentId: null,

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
    set({ documents: nextDocs, activeDocumentId: nextActive });
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

  clearAllDocuments: () => {
    for (const d of get().documents) {
      useWorkspaceTabStore.getState().removeDocumentTab(d.id);
    }
    set({ documents: [], activeDocumentId: null });
  },
}));
