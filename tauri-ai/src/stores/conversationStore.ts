/**
 * Conversation Store
 * Manages conversation history and message state using Zustand
 * 
 * NOTE: This store is now primarily used for:
 * - Loading and displaying conversation history (loadConversations)
 * - Managing conversation metadata (title, delete, etc.)
 * 
 * For active session management (multi-agent workspace), use sessionStore instead.
 * The sessionStore handles:
 * - Active session state and switching
 * - Message streaming and generation
 * - Session persistence
 * 
 * Requirements: 5.2, 5.3, 5.4, 8.1
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Conversation, Message, DebugInfo, TokenUsage } from '../types';

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  streamingMessage: string | null;
  streamingThinking: string | null;  // Thinking content being streamed
  isGenerating: boolean;
  error: string | null;

  // Actions
  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  createConversation: (title?: string) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<void>;
  updateConversationTitle: (id: string, title: string) => Promise<void>;
  setCurrentConversation: (id: string | null) => void;
  sendMessage: (content: string, enableThinking?: boolean) => Promise<void>;
  abortGeneration: () => Promise<void>;
  appendStreamingToken: (token: string) => void;
  appendThinkingToken: (token: string) => void;
  finalizeStreaming: (fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string) => void;
  clearError: () => void;
  retry: (messageId: string) => Promise<void>;
  generateTitle: () => Promise<void>;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  streamingMessage: null,
  streamingThinking: null,
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
      // Generate default title with timestamp
      let defaultTitle = title;
      if (!defaultTitle) {
        const now = new Date();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const hour = now.getHours().toString().padStart(2, '0');
        const minute = now.getMinutes().toString().padStart(2, '0');
        defaultTitle = `新对话 ${month}-${day} ${hour}:${minute}`;
      }

      const conversation = await invoke<Conversation>('create_conversation', {
        title: defaultTitle,
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
      await invoke('delete_conversation', { conversationId: id });
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
   * 注意：调用前必须确保 currentConversationId 已设置
   */
  sendMessage: async (content: string, enableThinking?: boolean) => {
    const { currentConversationId } = get();

    if (!currentConversationId) {
      throw new Error('No conversation selected. Please create a conversation first.');
    }

    // Get current model selection from config store
    const { useConfigStore } = await import('./configStore');
    const configState = useConfigStore.getState();
    const currentAgent = configState.getCurrentAgent();
    const currentModelRef = configState.getCurrentModelRef();

    // Create user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: currentConversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };

    // Add user message to state
    set((state) => ({
      messages: [...state.messages, userMessage],
      isGenerating: true,
      streamingMessage: '',
      streamingThinking: null,
      error: null,
    }));

    try {
      await invoke('chat_stream', {
        conversationId: currentConversationId,
        content,
        agentName: currentAgent?.name,
        modelRef: currentModelRef,
        enableThinking,
      });
    } catch (err) {
      set({ isGenerating: false });

      const errorMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: currentConversationId,
        role: 'error',
        content: (err as any).message || String(err),
        actions: (err as any).actions || [],
        createdAt: new Date().toISOString(),
      };

      set((state) => ({
        messages: [...state.messages, errorMessage],
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
          // Remove the error/assistant message and keep the user message
          // So we can resend from that point
          set({ messages: messages.slice(0, index) });
          break;
        }
      }
    } else if (targetMsg.role === 'user') {
      // Retrying a user message - remove it and everything after
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
      set({ isGenerating: false, streamingMessage: null, streamingThinking: null });
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
   * Append a thinking token to the current thinking content
   */
  appendThinkingToken: (token: string) => {
    set((state) => ({
      streamingThinking: (state.streamingThinking || '') + token,
    }));
  },

  /**
   * Finalize the streaming message and add it to messages
   */
  finalizeStreaming: (fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string) => {
    const { currentConversationId, messages, streamingThinking } = get();
    if (!currentConversationId) return;

    // Use provided thinking or the accumulated streamingThinking
    const finalThinking = thinking || streamingThinking || undefined;

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: currentConversationId,
      role: 'assistant',
      content: fullContent,
      thinking: finalThinking,
      meta: model ? { model } : undefined,
      debugInfo,
      usage,
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      messages: [...state.messages, assistantMessage],
      streamingMessage: null,
      streamingThinking: null,
      isGenerating: false,
    }));

    // Check if we should generate a title
    // Trigger when: messages >= 3 OR response content >= 100 chars
    const newMessagesCount = messages.length + 1; // +1 for the assistant message we just added
    const shouldGenerateTitle = newMessagesCount >= 3 || fullContent.length >= 100;

    if (shouldGenerateTitle) {
      // Async - don't await, let it run in background
      get().generateTitle();
    }
  },

  /**
   * Clear the current error
   */
  clearError: () => {
    set({ error: null });
  },

  /**
   * Generate a title for the current conversation using AI
   * Triggered when messages >= 3 or content is substantial
   */
  generateTitle: async () => {
    const { currentConversationId, messages, conversations } = get();
    if (!currentConversationId) return;

    // Find current conversation
    const currentConversation = conversations.find(c => c.id === currentConversationId);
    if (!currentConversation) return;

    // Only generate if title is still default
    if (!currentConversation.title.startsWith('新对话')) return;

    try {
      const title = await invoke<string>('generate_title', {
        conversationId: currentConversationId,
        messages: messages.slice(0, 6), // Only send first 6 messages
      });

      // Update local state
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === currentConversationId ? { ...c, title } : c
        ),
      }));
    } catch (error) {
      console.error('Failed to generate title:', error);
      // Don't throw - title generation is not critical
    }
  },
}));

// 模块级别的事件监听器初始化
// 只执行一次，避免 React 生命周期带来的竞态问题
const initStreamListeners = async () => {
  // Listen for token events
  await listen<{ conversationId: string; token: string }>('chat:token', (event) => {
    useConversationStore.getState().appendStreamingToken(event.payload.token);
  });

  // Listen for thinking events
  await listen<{ conversationId: string; token: string }>('chat:thinking', (event) => {
    useConversationStore.getState().appendThinkingToken(event.payload.token);
  });

  // Listen for done events
  await listen<{ conversationId: string; fullContent: string; thinking?: string; debugInfo?: DebugInfo; usage?: TokenUsage; model?: string }>('chat:done', (event) => {
    useConversationStore.getState().finalizeStreaming(
      event.payload.fullContent,
      event.payload.thinking,
      event.payload.debugInfo,
      event.payload.usage,
      event.payload.model
    );
  });

  // Listen for error events
  await listen<{ conversationId: string; error: string; debugInfo?: DebugInfo }>('chat:error', (event) => {
    const { currentConversationId, messages } = useConversationStore.getState();
    
    // Create error message bubble
    if (currentConversationId === event.payload.conversationId) {
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: event.payload.conversationId,
        role: 'error',
        content: event.payload.error,
        debugInfo: event.payload.debugInfo,
        createdAt: new Date().toISOString(),
      };
      
      // Keep the user message but add error message after it
      // This way user can see what they sent and what error occurred
      useConversationStore.setState({
        messages: [...messages, errorMessage],
        error: event.payload.error,
        isGenerating: false,
        streamingMessage: null,
        streamingThinking: null,
      });
    } else {
      useConversationStore.setState({
        error: event.payload.error,
        isGenerating: false,
        streamingMessage: null,
        streamingThinking: null,
      });
    }
  });
};

// 立即执行初始化
initStreamListeners();
