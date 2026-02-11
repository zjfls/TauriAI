import { create } from "zustand";
import { loadJson, saveJson } from "../lib/storage";
import type { ChatMessage, Conversation, ToolCallEvent, WebSearchEvent } from "../types/chat";

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
  appendThinkingDelta: (conversationId: string, messageId: string, delta: string) => void;
  upsertWebSearchEvent: (conversationId: string, messageId: string, ev: WebSearchEvent) => void;
  setToolCalls: (conversationId: string, messageId: string, calls: ToolCallEvent[]) => void;
  setToolCallResult: (
    conversationId: string,
    messageId: string,
    result: { id: string; output?: string; error?: string },
  ) => void;
  setMessageContent: (conversationId: string, messageId: string, content: string) => void;
  finalizeMessage: (
    conversationId: string,
    messageId: string,
    patch: { content?: string; thinking?: string },
  ) => void;
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
    appendThinkingDelta: (conversationId, messageId, delta) => {
      if (!delta) return;
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) =>
            m.id === messageId ? { ...m, thinking: (m.thinking ?? "") + delta } : m,
          );
          return { ...c, messages, updatedAt: now() };
        });
        // thinking 也可能高频；同样不落盘。
        return { conversations, activeConversationId: s.activeConversationId };
      });
    },
    upsertWebSearchEvent: (conversationId, messageId, ev) => {
      if (!ev || !ev.id) return;
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const prev = Array.isArray(m.webSearch) ? m.webSearch : [];
            const idx = prev.findIndex((x) => x && x.id === ev.id);
            const next = idx >= 0 ? prev.map((x, i) => (i === idx ? { ...x, ...ev } : x)) : [...prev, ev];
            return { ...m, webSearch: next };
          });
          return { ...c, messages, updatedAt: now() };
        });
        // web_search 事件频率不高，但也先不落盘；在 done 时统一持久化。
        return { conversations, activeConversationId: s.activeConversationId };
      });
    },
    setToolCalls: (conversationId, messageId, calls) => {
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const prev = Array.isArray(m.toolCalls) ? m.toolCalls : [];
            if (!Array.isArray(calls) || calls.length === 0) return { ...m, toolCalls: prev };

            const byId = new Map(prev.map((x) => [x.id, x] as const));
            const next = [...prev];
            for (const call of calls) {
              if (!call || !call.id) continue;
              const existing = byId.get(call.id);
              if (existing) {
                // 保留已写入的 output/error，同时更新 name/arguments（避免后端格式差异）。
                const merged = { ...existing, ...call, output: existing.output, error: existing.error };
                const idx = next.findIndex((x) => x.id === call.id);
                if (idx >= 0) next[idx] = merged;
              } else {
                next.push(call);
              }
            }
            return { ...m, toolCalls: next };
          });
          return { ...c, messages, updatedAt: now() };
        });
        return { conversations, activeConversationId: s.activeConversationId };
      });
    },
    setToolCallResult: (conversationId, messageId, result) => {
      if (!result?.id) return;
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const prev = Array.isArray(m.toolCalls) ? m.toolCalls : [];
            const idx = prev.findIndex((x) => x && x.id === result.id);
            if (idx < 0) return m;
            const next = prev.map((x, i) => (i === idx ? { ...x, ...result } : x));
            return { ...m, toolCalls: next };
          });
          return { ...c, messages, updatedAt: now() };
        });
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
    finalizeMessage: (conversationId, messageId, patch) => {
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const messages = c.messages.map((m) =>
            m.id === messageId ? { ...m, ...patch } : m,
          );
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
