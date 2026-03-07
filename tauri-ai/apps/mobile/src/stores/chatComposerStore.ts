import { create } from "zustand";
import { loadJson, saveJson } from "../lib/storage";

type State = {
  drafts: Record<string, string>;
  setDraft: (conversationId: string, value: string) => void;
  clearDraft: (conversationId: string) => void;
};

const STORAGE_KEY = "tauriai.mobile.chat-composer.v1";

function persist(drafts: Record<string, string>) {
  saveJson(STORAGE_KEY, drafts);
}

export const useChatComposerStore = create<State>((set) => ({
  drafts: loadJson<Record<string, string>>(STORAGE_KEY, {}),
  setDraft: (conversationId, value) => {
    const id = conversationId.trim();
    if (!id) return;
    set((state) => {
      const nextDrafts = { ...state.drafts };
      if (value) {
        nextDrafts[id] = value;
      } else {
        delete nextDrafts[id];
      }
      persist(nextDrafts);
      return { drafts: nextDrafts };
    });
  },
  clearDraft: (conversationId) => {
    const id = conversationId.trim();
    if (!id) return;
    set((state) => {
      if (!(id in state.drafts)) return state;
      const nextDrafts = { ...state.drafts };
      delete nextDrafts[id];
      persist(nextDrafts);
      return { drafts: nextDrafts };
    });
  },
}));
