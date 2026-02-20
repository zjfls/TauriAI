import { create } from "zustand";
import { loadJson, saveJson } from "../lib/storage";
import type {
  ChatMessage,
  ChatMessageBlock,
  Conversation,
  ToolCallEvent,
  WebSearchEvent,
} from "../types/chat";

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
    result: { id: string; name?: string; output?: string; error?: string },
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

function ensureBlocks(message: ChatMessage): ChatMessageBlock[] {
  if (Array.isArray(message.blocks)) return message.blocks;

  const blocks: ChatMessageBlock[] = [];

  if (message.thinking && message.thinking.trim().length > 0) {
    blocks.push({
      id: `thinking_${message.id}`,
      type: "thinking",
      text: message.thinking,
    });
  }

  if (message.content && message.content.trim().length > 0) {
    blocks.push({
      id: `text_${message.id}`,
      type: "text",
      format: "markdown",
      text: message.content,
    });
  }

  if (Array.isArray(message.webSearch)) {
    for (const ev of message.webSearch) {
      if (!ev?.id) continue;
      blocks.push({
        id: `web_${ev.id}`,
        type: "web_search",
        event: ev,
      });
    }
  }

  if (Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      if (!call?.id) continue;
      blocks.push({
        id: `tool_${call.id}`,
        type: "tool_call",
        call,
      });
    }
  }

  return blocks;
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
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const nextContent = (m.content ?? "") + delta;
            const prevBlocks = ensureBlocks(m);
            const last = prevBlocks[prevBlocks.length - 1];
            const nextBlocks: ChatMessageBlock[] =
              last && last.type === "text"
                ? [
                    ...prevBlocks.slice(0, -1),
                    { ...last, text: (last.text ?? "") + delta },
                  ]
                : [
                    ...prevBlocks,
                    {
                      id: newId("b_text"),
                      type: "text",
                      format: "markdown",
                      text: delta,
                    },
                  ];
            return { ...m, content: nextContent, blocks: nextBlocks };
          });
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
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const nextThinking = (m.thinking ?? "") + delta;
            const prevBlocks = ensureBlocks(m);
            const last = prevBlocks[prevBlocks.length - 1];
            const nextBlocks: ChatMessageBlock[] =
              last && last.type === "thinking"
                ? [
                    ...prevBlocks.slice(0, -1),
                    { ...last, text: (last.text ?? "") + delta },
                  ]
                : [
                    ...prevBlocks,
                    {
                      id: newId("b_thinking"),
                      type: "thinking",
                      text: delta,
                    },
                  ];
            return { ...m, thinking: nextThinking, blocks: nextBlocks };
          });
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
            const prevBlocks = ensureBlocks(m);
            const existingIdx = prevBlocks.findIndex(
              (b) => b.type === "web_search" && b.event?.id === ev.id,
            );
            const nextBlocks: ChatMessageBlock[] =
              existingIdx >= 0
                ? prevBlocks.map((b, i) =>
                    i === existingIdx && b.type === "web_search"
                      ? { ...b, event: { ...b.event, ...ev } }
                      : b,
                  )
                : [
                    ...prevBlocks,
                    {
                      id: `web_${ev.id}`,
                      type: "web_search",
                      event: ev,
                    },
                  ];
            return { ...m, webSearch: next, blocks: nextBlocks };
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
            const byNextId = new Map(next.map((x) => [x.id, x] as const));
            const prevBlocks = ensureBlocks(m);
            const existingBlockIds = new Set(
              prevBlocks
                .filter((b): b is Extract<ChatMessageBlock, { type: "tool_call" }> => b.type === "tool_call")
                .map((b) => b.call.id),
            );

            let nextBlocks = [...prevBlocks];
            for (const call of calls) {
              if (!call?.id) continue;
              const merged = byNextId.get(call.id) ?? call;
              if (existingBlockIds.has(call.id)) {
                nextBlocks = nextBlocks.map((b) =>
                  b.type === "tool_call" && b.call.id === call.id
                    ? { ...b, call: { ...b.call, ...merged } }
                    : b,
                );
                continue;
              }
              existingBlockIds.add(call.id);
              nextBlocks.push({
                id: `tool_${call.id}`,
                type: "tool_call",
                call: merged,
              });
            }

            return { ...m, toolCalls: next, blocks: nextBlocks };
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
            const nextCalls =
              idx >= 0
                ? prev.map((x, i) => (i === idx ? { ...x, ...result } : x))
                : result.name
                  ? [
                      ...prev,
                      {
                        id: result.id,
                        name: result.name,
                        arguments: "",
                        output: result.output,
                        error: result.error,
                      },
                    ]
                  : prev;

            const prevBlocks = ensureBlocks(m);
            const blockIdx = prevBlocks.findIndex(
              (b) => b.type === "tool_call" && b.call?.id === result.id,
            );
            const nextBlocks: ChatMessageBlock[] =
              blockIdx >= 0
                ? prevBlocks.map((b, i) =>
                    i === blockIdx && b.type === "tool_call"
                      ? { ...b, call: { ...b.call, ...result } }
                      : b,
                  )
                : result.name
                  ? [
                      ...prevBlocks,
                      {
                        id: `tool_${result.id}`,
                        type: "tool_call",
                        call: {
                          id: result.id,
                          name: result.name,
                          arguments: "",
                          output: result.output,
                          error: result.error,
                        },
                      },
                    ]
                  : prevBlocks;

            return { ...m, toolCalls: nextCalls, blocks: nextBlocks };
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
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const nextMsg: ChatMessage = { ...m, ...patch };

            // Important: after introducing `blocks` (ordered by stream events), we must keep
            // blocks in sync when the backend sends a final `done` payload that contains the
            // full accumulated content (or when an `error` happens after tool calls).
            //
            // Otherwise, UI will keep rendering old blocks and appear to "stop" after MCP.
            const nextBlocks: ChatMessageBlock[] = ensureBlocks(m);

            const concatTextBlocks = (blocks: ChatMessageBlock[]) =>
              blocks
                .filter(
                  (b): b is Extract<ChatMessageBlock, { type: "text" }> => b.type === "text",
                )
                .map((b) => b.text || "")
                .join("");

            const concatThinkingBlocks = (blocks: ChatMessageBlock[]) =>
              blocks
                .filter(
                  (b): b is Extract<ChatMessageBlock, { type: "thinking" }> =>
                    b.type === "thinking",
                )
                .map((b) => b.text || "")
                .join("");

            if (typeof patch?.thinking === "string") {
              const target = nextMsg.thinking ?? "";
              const rendered = concatThinkingBlocks(nextBlocks);
              if (target.trim()) {
                if (rendered === "") {
                  nextBlocks.push({
                    id: newId("b_thinking_final"),
                    type: "thinking",
                    text: target,
                  });
                } else if (target !== rendered) {
                  const suffix = target.startsWith(rendered)
                    ? target.slice(rendered.length)
                    : target;
                  if (suffix.trim().length > 0) {
                    nextBlocks.push({
                      id: newId("b_thinking_suffix"),
                      type: "thinking",
                      text: suffix,
                    });
                  }
                }
              }
            }

            if (typeof patch?.content === "string") {
              const target = nextMsg.content ?? "";
              const rendered = concatTextBlocks(nextBlocks);
              if (target.trim()) {
                if (rendered === "") {
                  nextBlocks.push({
                    id: newId("b_text_final"),
                    type: "text",
                    format: "markdown",
                    text: target,
                  });
                } else if (target !== rendered) {
                  const suffix = target.startsWith(rendered)
                    ? target.slice(rendered.length)
                    : target;
                  if (suffix.trim().length > 0) {
                    nextBlocks.push({
                      id: newId("b_text_suffix"),
                      type: "text",
                      format: "markdown",
                      text: suffix,
                    });
                  }
                }
              }
            }

            nextMsg.blocks = nextBlocks;
            return nextMsg;
          });
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
