import { create } from "zustand";
import { loadJson, saveJson } from "../lib/storage";
import type { ChatMessage, Conversation } from "../types/chat";

export type CreateConversationOptions = {
  title?: string;
  agentName?: string;
};

type State = {
  conversations: Conversation[];
  activeConversationId: string | null;
  createConversation: (opts?: CreateConversationOptions) => string;
  setActiveConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  appendMessage: (conversationId: string, message: ChatMessage) => void;
  appendMessageDelta: (conversationId: string, messageId: string, delta: string) => void;
  setMessageContent: (conversationId: string, messageId: string, content: string) => void;
  setTitle: (conversationId: string, title: string) => void;
};

const STORAGE_KEY = "tauriai.mobile.conversations.v1";

function now() {
  return Date.now();
}

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function createEmptyConversation(opts?: CreateConversationOptions): Conversation {
  const id = newId("c");
  return {
    id,
    title: opts?.title || "新对话",
    agentName: opts?.agentName,
    updatedAt: now(),
    messages: [],
  };
}

function loadInitial() {
  const data = loadJson<{ conversations: Conversation[]; activeConversationId: string | null }>(
    STORAGE_KEY,
    { conversations: [], activeConversationId: null },
  );

  if (data.conversations.length === 0) {
    const conv = createEmptyConversation();
    return { conversations: [conv], activeConversationId: conv.id };
  }

  return data;
}

export const useConversationStore = create<State>((set) => {
  const initial = loadInitial();

  const persist = (next: Pick<State, "conversations" | "activeConversationId">) => {
    saveJson(STORAGE_KEY, next);
  };

  return {
    conversations: initial.conversations,
    activeConversationId: initial.activeConversationId,
    createConversation: (opts) => {
      const conv = createEmptyConversation(opts);
      set((s) => {
        const next = { conversations: [conv, ...s.conversations], activeConversationId: conv.id };
        persist(next);
        return next;
      });
      return conv.id;
    },
    setActiveConversation: (id) => {
      set((s) => {
        const next = { conversations: s.conversations, activeConversationId: id };
        persist(next);
        return next;
      });
    },
    deleteConversation: (id) => {
      set((s) => {
        const remaining = s.conversations.filter((c) => c.id !== id);
        const nextActive =
          s.activeConversationId === id ? (remaining[0]?.id ?? null) : s.activeConversationId;
        const next = { conversations: remaining, activeConversationId: nextActive };
        persist(next);
        return next;
      });
    },
    appendMessage: (conversationId, message) => {
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          return { ...c, messages: [...c.messages, message], updatedAt: now() };
        });
        const next = { conversations, activeConversationId: s.activeConversationId };
        persist(next);
        return next;
      });
    },
    appendMessageDelta: (conversationId, messageId, delta) => {
      if (!delta) return;
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) =>
            m.id === messageId ? { ...m, content: (m.content ?? "") + delta } : m,
          );
          return { ...c, messages, updatedAt: now() };
        });
        // 流式 token 更新非常频繁；这里不落盘，避免 localStorage 高频写入导致卡顿。
        return { conversations, activeConversationId: s.activeConversationId };
      });
    },
    setMessageContent: (conversationId, messageId, content) => {
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) => (m.id === messageId ? { ...m, content } : m));
          return { ...c, messages, updatedAt: now() };
        });
        const next = { conversations, activeConversationId: s.activeConversationId };
        persist(next);
        return next;
      });
    },
    setTitle: (conversationId, title) => {
      set((s) => {
        const conversations = s.conversations.map((c) =>
          c.id === conversationId ? { ...c, title, updatedAt: now() } : c,
        );
        const next = { conversations, activeConversationId: s.activeConversationId };
        persist(next);
        return next;
      });
    },
  };
});

export function getActiveConversation(): Conversation {
  const { conversations, activeConversationId } = useConversationStore.getState();
  const c =
    (activeConversationId && conversations.find((x) => x.id === activeConversationId)) ||
    conversations[0];
  if (!c) {
    const id = useConversationStore.getState().createConversation();
    return useConversationStore.getState().conversations.find((x) => x.id === id)!;
  }
  return c;
}
