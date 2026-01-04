/**
 * Conversation Store
 * Manages conversation and message state using Zustand
 * Requirements: 5.2, 5.3, 5.4
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Conversation, Message } from '../types';

interface StreamEvent {
  conversation_id: string;
  event_type: 'token' | 'done' | 'error';
  content: string;
}

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, isGenerating: false, streamingMessage: null });
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
    const unlisten = await listen<StreamEvent>('chat-stream', (event) => {
      const { event_type, content } = event.payload;

      switch (event_type) {
        case 'token':
          get().appendStreamingToken(content);
          break;
        case 'done':
          get().finalizeStreaming(content);
          break;
        case 'error':
          set({ error: content, isGenerating: false, streamingMessage: null });
          break;
      }
    });

    return unlisten;
  },
}));
