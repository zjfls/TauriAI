/**
 * Conversation Store
 * Manages conversation and message state using Zustand
 * Requirements: 5.2, 5.3, 5.4
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Conversation, Message } from '../types';

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  streamingMessage: string | null;
  isGenerating: boolean;
  error: string | null;

  // Actions
  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  createConversation: (title?: string) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<void>;
  updateConversationTitle: (id: string, title: string) => Promise<void>;
  setCurrentConversation: (id: string | null) => void;
  sendMessage: (content: string) => Promise<void>;
  abortGeneration: () => Promise<void>;
  appendStreamingToken: (token: string) => void;
  finalizeStreaming: (fullContent: string) => void;
  clearError: () => void;
  retry: (messageId: string) => Promise<void>;
  setupStreamListener: () => Promise<UnlistenFn>;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  streamingMessage: null,
  isGenerating: false,
  error: null,

  /**
   * Load all conversations from the backend
   * Requirements: 5.2
   */
  loadConversations: async () => {
    try {
      const conversations = await invoke<Conversation[]>('get_conversations');
      set({ conversations });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  /**
   * Load messages for a specific conversation
   */
  loadMessages: async (conversationId: string) => {
    try {
      const messages = await invoke<Message[]>('get_messages', {
        conversationId,
        limit: 100,
      });
      set({ messages, currentConversationId: conversationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  /**
   * Create a new conversation
   */
  createConversation: async (title?: string) => {
    try {
      const conversation = await invoke<Conversation>('create_conversation', {
        title: title || 'New Conversation',
      });
      set((state) => ({
        conversations: [conversation, ...state.conversations],
        currentConversationId: conversation.id,
        messages: [],
      }));
      return conversation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    }
  },

  /**
   * Delete a conversation
   */
  deleteConversation: async (id: string) => {
    try {
      await invoke('delete_conversation', { id });
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
        currentConversationId:
          state.currentConversationId === id ? null : state.currentConversationId,
        messages: state.currentConversationId === id ? [] : state.messages,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  /**
   * Update conversation title
   */
  updateConversationTitle: async (id: string, title: string) => {
    try {
      await invoke('update_conversation_title', { id, title });
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

  /**
   * Set the current conversation
   */
  setCurrentConversation: (id: string | null) => {
    set({ currentConversationId: id });
    if (id) {
      get().loadMessages(id);
    } else {
      set({ messages: [] });
    }
  },

  /**
   * Send a message and initiate streaming response
   * Requirements: 5.3
   */
  sendMessage: async (content: string) => {
    const { currentConversationId, createConversation } = get();

    let conversationId = currentConversationId;

    // Create a new conversation if none exists
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
    }

    // Create user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };

    // Add user message to state
    set((state) => ({
      messages: [...state.messages, userMessage],
      isGenerating: true,
      streamingMessage: '',
      error: null,
    }));

    try {
      // Initiate streaming chat
      await invoke('chat_stream', {
        conversationId,
        content,
      });
    } catch (err) {
      set({ isGenerating: false });

      const errorMessage: Message = {
        id: crypto.randomUUID(),
        conversationId,
        role: 'error',
        content: (err as any).message || String(err),
        actions: (err as any).actions || [],
        createdAt: new Date().toISOString(),
      };

      set((state) => ({
        messages: [...state.messages, errorMessage],
        currentConversationId: conversationId,
      }));
    }
  },

  retry: async (messageId: string) => {
    const state = get();
    const { messages, sendMessage } = state;

    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    const targetMsg = messages[index];
    let promptToResend = '';

    // If we are retrying an Assistant message or Error message,
    // we want to roll back to the user message before it.
    if (targetMsg.role === 'assistant' || targetMsg.role === 'error') {
      // Search backwards for the user message
      for (let i = index - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          promptToResend = messages[i].content;
          // Rollback state to before this user message 
          // (effectively deleting the user message and everything after, so we can re-add it)
          set({ messages: messages.slice(0, i) });
          break;
        }
      }
    } else if (targetMsg.role === 'user') {
      // Retrying a user message (rare, but maybe if it failed to send?)
      promptToResend = targetMsg.content;
      set({ messages: messages.slice(0, index) });
    }

    if (promptToResend) {
      await sendMessage(promptToResend);
    }
  },

  /**
   * Abort the current generation
   */
  abortGeneration: async () => {
    const { currentConversationId } = get();
    if (!currentConversationId) return;

    try {
      await invoke('abort_chat', { conversationId: currentConversationId });
      set({ isGenerating: false, streamingMessage: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    }
  },

  /**
   * Append a streaming token to the current message
   * Requirements: 5.4
   */
  appendStreamingToken: (token: string) => {
    set((state) => ({
      streamingMessage: (state.streamingMessage || '') + token,
    }));
  },

  /**
   * Finalize the streaming message and add it to messages
   */
  finalizeStreaming: (fullContent: string) => {
    const { currentConversationId } = get();
    if (!currentConversationId) return;

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: currentConversationId,
      role: 'assistant',
      content: fullContent,
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      messages: [...state.messages, assistantMessage],
      streamingMessage: null,
      isGenerating: false,
    }));
  },

  /**
   * Clear the current error
   */
  clearError: () => {
    set({ error: null });
  },

  /**
   * Set up the event listener for streaming tokens
   */
  setupStreamListener: async () => {
    const unlisteners: (() => void)[] = [];

    // Listen for token events
    const unlistenToken = await listen<{ conversation_id: string; token: string }>('chat:token', (event) => {
      get().appendStreamingToken(event.payload.token);
    });
    unlisteners.push(unlistenToken);

    // Listen for done events
    const unlistenDone = await listen<{ conversation_id: string; full_content: string }>('chat:done', (event) => {
      get().finalizeStreaming(event.payload.full_content);
    });
    unlisteners.push(unlistenDone);

    // Listen for error events
    const unlistenError = await listen<{ conversation_id: string; error: string }>('chat:error', (event) => {
      set({ error: event.payload.error, isGenerating: false, streamingMessage: null });
    });
    unlisteners.push(unlistenError);

    // Return a combined unlisten function
    return () => {
      unlisteners.forEach(unlisten => unlisten());
    };
  },
}));
