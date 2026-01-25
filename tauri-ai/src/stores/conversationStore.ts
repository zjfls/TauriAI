/**
 * Conversation Store
 *
 * 说明：
 * - 这个 store 只负责“历史会话列表/元数据”（加载、重命名、删除）
 * - 所有“正在进行的聊天/流式生成/撤回重发”等交互都由 sessionStore 负责
 *
 * 这样可以避免两套状态机并存导致的分裂与竞态。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Conversation } from '../types';

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  error: string | null;

  loadConversations: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  updateConversationTitle: (id: string, title: string) => Promise<void>;
  patchConversation: (id: string, patch: Partial<Conversation>) => void;
  setCurrentConversation: (id: string | null) => void;
  clearError: () => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  currentConversationId: null,
  error: null,

  loadConversations: async () => {
    try {
      const conversations = await invoke<Conversation[]>('get_conversations');
      set({ conversations });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  deleteConversation: async (id: string) => {
    try {
      await invoke('delete_conversation', { conversationId: id });
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
        currentConversationId:
          state.currentConversationId === id ? null : state.currentConversationId,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  updateConversationTitle: async (id: string, title: string) => {
    try {
      await invoke('update_conversation_title', { conversationId: id, title });
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, title } : c
        ),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  // 仅更新前端列表中的元数据（避免为了同步小字段频繁全量 reload）
  patchConversation: (id: string, patch: Partial<Conversation>) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      ),
    }));
  },

  setCurrentConversation: (id: string | null) => {
    set({ currentConversationId: id });
  },

  clearError: () => set({ error: null }),
}));

// -----------------------------------------------------------------------------
// Debug: conversation store update storm detector (DEV only)
// -----------------------------------------------------------------------------
const CONVERSATION_STORE_DEBUG_LAST_STORM_KEY = 'tauri-ai:debug:last_conversation_store_storm';
const conversationStoreStormDebugEnabled = (() => {
  try {
    return import.meta.env.DEV;
  } catch {
    return false;
  }
})();

if (conversationStoreStormDebugEnabled) {
  let windowStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let updatesInWindow = 0;
  let tracedInWindow = false;

  const WINDOW_MS = 500;
  const TRACE_THRESHOLD = 40;

  useConversationStore.subscribe((state, prev) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      updatesInWindow = 0;
      tracedInWindow = false;
    }

    updatesInWindow += 1;

    if (!tracedInWindow && updatesInWindow >= TRACE_THRESHOLD) {
      tracedInWindow = true;

      const stack = (() => {
        try {
          return new Error('conversationStore update storm').stack || '';
        } catch {
          return '';
        }
      })();

      try {
        if (typeof localStorage !== 'undefined') {
          const record = {
            ts: Date.now(),
            updatesInWindow,
            windowMs: WINDOW_MS,
            state: {
              conversations: state.conversations.length,
              currentConversationId: state.currentConversationId,
              error: state.error,
            },
            prevState: {
              conversations: prev.conversations.length,
              currentConversationId: prev.currentConversationId,
              error: prev.error,
            },
            stack,
          };
          localStorage.setItem(CONVERSATION_STORE_DEBUG_LAST_STORM_KEY, JSON.stringify(record));
        }
      } catch {
        // ignore
      }

      console.groupCollapsed(`[debug] conversationStore 更新风暴: ${updatesInWindow}/${WINDOW_MS}ms`);
      console.log('state:', {
        conversations: state.conversations.length,
        currentConversationId: state.currentConversationId,
        error: state.error,
      });
      console.log('prev:', {
        conversations: prev.conversations.length,
        currentConversationId: prev.currentConversationId,
        error: prev.error,
      });
      console.trace('conversationStore update storm stack');
      if (stack) console.log('captured stack:', stack);
      console.groupEnd();
    }
  });
}
