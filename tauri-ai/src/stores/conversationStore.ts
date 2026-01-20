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
