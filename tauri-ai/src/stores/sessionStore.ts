/**
 * Session Store
 * Manages multi-agent workspace sessions using Zustand
 * Requirements: 1.1-1.5, 2.1-2.6, 4.1-4.5, 5.1-5.5, 6.1-6.3, 7.1-7.5
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentSession, Message, DebugInfo, TokenUsage, PersistedSession, PersistedSessionState, ContentPart } from '../types';

// Constants for persistence
const SESSION_STORAGE_KEY = 'tauri-ai:sessions';
const PERSISTENCE_VERSION = 1;
const MAX_SESSIONS = 10;

export interface SessionState {
  // Session management
  sessions: Map<string, AgentSession>;
  activeSessionId: string | null;

  // Session operations
  createSession: (agentName: string) => Promise<string>;
  closeSession: (sessionId: string) => Promise<void>;
  switchSession: (sessionId: string) => void;

  // Message operations (act on specified session)
  sendMessage: (sessionId: string, content: string, enableThinking?: boolean, images?: ContentPart[]) => Promise<void>;
  abortGeneration: (sessionId: string) => Promise<void>;
  retry: (sessionId: string, messageId: string) => Promise<void>;
  undoToMessage: (sessionId: string, messageId: string) => void;

  // Streaming updates (internal use)
  appendStreamingToken: (sessionId: string, token: string) => void;
  appendThinkingToken: (sessionId: string, token: string) => void;
  finalizeStreaming: (sessionId: string, fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string) => void;
  handleError: (sessionId: string, error: string, debugInfo?: DebugInfo) => void;

  // Model switching (async due to API type check)
  setSessionModel: (sessionId: string, modelRef: string) => Promise<void>;

  // Agent switching
  setSessionAgent: (sessionId: string, agentName: string) => void;

  // Title generation
  generateTitle: (sessionId: string) => Promise<void>;

  // Persistence
  saveSessionState: () => Promise<void>;
  restoreSessionState: () => Promise<void>;

  // History
  openHistoricalConversation: (conversationId: string) => Promise<string>;

  // Getters
  getActiveSession: () => AgentSession | undefined;
  getSession: (sessionId: string) => AgentSession | undefined;
  getSessionByConversationId: (conversationId: string) => AgentSession | undefined;
}

// Queue to ensure undo operations complete before sending new messages
let pendingUndoOperation: Promise<any> = Promise.resolve();

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: new Map<string, AgentSession>(),
  activeSessionId: null,

  /**
   * Get the currently active session
   * Requirements: 2.2
   */
  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    if (!activeSessionId) return undefined;
    return sessions.get(activeSessionId);
  },

  /**
   * Get a session by ID
   */
  getSession: (sessionId: string) => {
    return get().sessions.get(sessionId);
  },

  /**
   * Get a session by conversation ID (for event routing)
   * Requirements: 7.2, 7.3
   */
  getSessionByConversationId: (conversationId: string) => {
    const { sessions } = get();
    for (const session of sessions.values()) {
      if (session.conversationId === conversationId) {
        return session;
      }
    }
    return undefined;
  },


  /**
   * Create a new session with the specified agent
   * Requirements: 1.3, 1.5, 3.3, 3.4
   */
  createSession: async (agentName: string) => {
    const { sessions } = get();

    // Check max sessions limit
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(`已达到最大会话数限制 (${MAX_SESSIONS})`);
    }

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    // Create conversation in backend
    const { useConfigStore } = await import('./configStore');
    const agent = useConfigStore.getState().getAgent(agentName);

    // Generate default title with timestamp: 新对话_MM-DD HH:mm
    const nowDate = new Date();
    const month = (nowDate.getMonth() + 1).toString().padStart(2, '0');
    const day = nowDate.getDate().toString().padStart(2, '0');
    const hour = nowDate.getHours().toString().padStart(2, '0');
    const minute = nowDate.getMinutes().toString().padStart(2, '0');
    const defaultTitle = `新对话_${month}-${day} ${hour}:${minute}`;

    const conversation = await invoke<{ id: string }>('create_conversation', {
      title: defaultTitle,
      // agentName is ignored by create_conversation command, so we need to update it separately
    });

    // Sync metadata to DB immediately
    await invoke('update_conversation_metadata', {
      conversationId: conversation.id,
      agentName: agentName,
      modelRef: agent?.modelRef,
    }).catch(console.error);

    const session: AgentSession = {
      id: sessionId,
      agentName,
      title: defaultTitle,
      modelRef: agent?.modelRef,
      conversationId: conversation.id,
      apiType: null,  // Not locked until first message
      messages: [],
      streamingMessage: null,
      streamingThinking: null,
      isGenerating: false,
      error: null,
      createdAt: now,
      lastActiveAt: now,
    };

    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, session);
      return {
        sessions: newSessions,
        activeSessionId: sessionId,
      };
    });

    // Save state after creating session
    get().saveSessionState();

    // Refresh conversation list so new conversation appears in history immediately
    // This also ensures generateTitle can find the conversation
    const { useConversationStore } = await import('./conversationStore');
    await useConversationStore.getState().loadConversations();

    return sessionId;
  },

  /**
   * Close a session and persist its conversation history
   * Requirements: 1.4, 3.3, 3.4
   */
  closeSession: async (sessionId: string) => {
    const { sessions } = get();
    const session = sessions.get(sessionId);

    if (!session) return;

    // Remove session from state
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);

      // If closing active session, switch to another
      let newActiveId = state.activeSessionId;
      if (state.activeSessionId === sessionId) {
        const remainingSessions = Array.from(newSessions.keys());
        newActiveId = remainingSessions.length > 0 ? remainingSessions[0] : null;
      }

      return {
        sessions: newSessions,
        activeSessionId: newActiveId,
      };
    });

    // Save state after closing session
    get().saveSessionState();
  },

  /**
   * Switch to a different session
   * Requirements: 2.2
   */
  switchSession: (sessionId: string) => {
    const { sessions } = get();
    if (!sessions.has(sessionId)) return;

    set({
      activeSessionId: sessionId,
    });

    // Update lastActiveAt
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (session) {
        newSessions.set(sessionId, {
          ...session,
          lastActiveAt: new Date().toISOString(),
        });
      }
      return { sessions: newSessions };
    });

    // Save state after switching
    get().saveSessionState();
  },


  /**
   * Send a message in a specific session
   * Requirements: 4.3, 4.4
   */
  sendMessage: async (sessionId: string, content: string, enableThinking?: boolean, images?: ContentPart[]) => {
    // Wait for any pending undo operations to complete first
    // This prevents race conditions where new messages are sent before backend deletion finishes
    await pendingUndoOperation;

    const session = get().sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (!session.conversationId) {
      throw new Error('Session has no conversation');
    }

    // Build content parts if images are provided
    const contentParts: ContentPart[] = [];
    if (content) {
      contentParts.push({ type: 'text', text: content });
    }
    if (images && images.length > 0) {
      contentParts.push(...images);
    }

    // Create user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: session.conversationId,
      role: 'user',
      content,
      contentParts: contentParts.length > 0 ? contentParts : undefined,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // Get API type if not locked yet
    let apiTypeToLock = session.apiType;
    if (!session.apiType && session.modelRef) {
      const { useConfigStore } = await import('./configStore');
      const config = useConfigStore.getState().config;
      if (config) {
        const { getApiTypeFromModelRef } = await import('../utils/apiType');
        apiTypeToLock = getApiTypeFromModelRef(session.modelRef, config);
      }
    }

    // Update session state with API type lock
    set((state) => {
      const newSessions = new Map(state.sessions);
      const currentSession = newSessions.get(sessionId);
      if (currentSession) {
        newSessions.set(sessionId, {
          ...currentSession,
          messages: [...currentSession.messages, userMessage],
          isGenerating: true,
          streamingMessage: '',
          streamingThinking: null,
          error: null,
          lastActiveAt: new Date().toISOString(),
          // Lock API type on first message
          apiType: currentSession.apiType || apiTypeToLock,
        });
      }
      return { sessions: newSessions };
    });

    try {
      await invoke('chat_stream', {
        conversationId: session.conversationId,
        content,
        contentParts: contentParts.length > 0 ? contentParts : undefined,
        agentName: session.agentName,
        modelRef: session.modelRef,
        enableThinking,
      });
    } catch (err) {
      get().handleError(sessionId, (err as any).message || String(err));
    }
  },

  /**
   * Abort generation in a specific session
   * Requirements: 4.4
   */
  abortGeneration: async (sessionId: string) => {
    const session = get().sessions.get(sessionId);
    if (!session?.conversationId) return;

    try {
      await invoke('abort_chat', { conversationId: session.conversationId });

      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(sessionId);
        if (currentSession) {
          newSessions.set(sessionId, {
            ...currentSession,
            isGenerating: false,
            streamingMessage: null,
            streamingThinking: null,
          });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('Failed to abort generation:', error);
    }
  },

  /**
   * Retry a message in a specific session
   */
  retry: async (sessionId: string, messageId: string) => {
    const session = get().sessions.get(sessionId);
    if (!session) return;

    const { messages } = session;
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    const targetMsg = messages[index];
    let promptToResend = '';
    let newMessages = messages;

    if (targetMsg.role === 'assistant' || targetMsg.role === 'error') {
      // Search backwards for the user message
      for (let i = index - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          promptToResend = messages[i].content;
          newMessages = messages.slice(0, index);
          break;
        }
      }
    } else if (targetMsg.role === 'user') {
      promptToResend = targetMsg.content;
      newMessages = messages.slice(0, index);
    }

    if (promptToResend) {
      // Update messages first
      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(sessionId);
        if (currentSession) {
          newSessions.set(sessionId, {
            ...currentSession,
            messages: newMessages,
          });
        }
        return { sessions: newSessions };
      });

      // Then resend
      await get().sendMessage(sessionId, promptToResend);
    }
  },


  /**
   * Undo to a specific message (remove it and all subsequent messages)
   * Used for "Withdraw" functionality
   */
  undoToMessage: (sessionId: string, messageId: string) => {
    // Optimistically update UI
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (session) {
        const messageIndex = session.messages.findIndex((m) => m.id === messageId);
        if (messageIndex !== -1) {
          // Keep messages only up to the one before the target message
          const newMessages = session.messages.slice(0, messageIndex);
          newSessions.set(sessionId, {
            ...session,
            messages: newMessages,
          });

          // Sync with backend
          // Chain operation to ensure it completes before next message send
          const deleteOp = invoke('delete_messages_from', {
            conversationId: session.conversationId,
            messageId: messageId
          }).catch(console.error);

          pendingUndoOperation = pendingUndoOperation.then(() => deleteOp);
        }
      }
      return { sessions: newSessions };
    });
    // Persist state
    get().saveSessionState();
  },

  /**
   * Append a streaming token to a session
   * Requirements: 7.5
   */
  appendStreamingToken: (sessionId: string, token: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (session) {
        newSessions.set(sessionId, {
          ...session,
          streamingMessage: (session.streamingMessage || '') + token,
        });
      }
      return { sessions: newSessions };
    });
  },

  /**
   * Append a thinking token to a session
   */
  appendThinkingToken: (sessionId: string, token: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (session) {
        newSessions.set(sessionId, {
          ...session,
          streamingThinking: (session.streamingThinking || '') + token,
        });
      }
      return { sessions: newSessions };
    });
  },

  /**
   * Finalize streaming and add assistant message
   * Requirements: 7.5
   */
  finalizeStreaming: (sessionId: string, fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string) => {
    const session = get().sessions.get(sessionId);
    if (!session?.conversationId) return;

    const finalThinking = thinking || session.streamingThinking || undefined;

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: session.conversationId,
      role: 'assistant',
      content: fullContent,
      thinking: finalThinking,
      meta: model ? { model } : undefined,
      debugInfo,
      usage,
      createdAt: new Date().toISOString(),
    };

    set((state) => {
      const newSessions = new Map(state.sessions);
      const currentSession = newSessions.get(sessionId);
      if (currentSession) {
        // Find the last pending user message and mark as success
        const updatedMessages = [...currentSession.messages];
        for (let i = updatedMessages.length - 1; i >= 0; i--) {
          if (updatedMessages[i].role === 'user' && updatedMessages[i].status === 'pending') {
            updatedMessages[i] = { ...updatedMessages[i], status: 'success' };
            break;
          }
        }

        newSessions.set(sessionId, {
          ...currentSession,
          messages: [...updatedMessages, assistantMessage],
          streamingMessage: null,
          streamingThinking: null,
          isGenerating: false,
          lastActiveAt: new Date().toISOString(),
        });
      }
      return { sessions: newSessions };
    });

    // Trigger auto-title generation
    // Condition: messages >= 3 OR response content >= 100 chars
    const updatedSession = get().sessions.get(sessionId);
    if (updatedSession) {
      const newMessagesCount = updatedSession.messages.length;
      const shouldGenerateTitle = newMessagesCount >= 3 || fullContent.length >= 100;

      if (shouldGenerateTitle) {
        // Async - don't await, let it run in background
        get().generateTitle(sessionId);
      }
    }
  },

  /**
   * Handle error in a session
   * Requirements: 7.4
   */
  handleError: (sessionId: string, error: string, debugInfo?: DebugInfo) => {
    console.log('[DEBUG] handleError called:', { sessionId, error, hasDebugInfo: !!debugInfo });
    set((state) => {
      const newSessions = new Map(state.sessions);
      const currentSession = newSessions.get(sessionId);
      console.log('[DEBUG] handleError - session found:', !!currentSession);
      if (currentSession) {
        // Find the last user message and mark as failed
        const updatedMessages = [...currentSession.messages];
        for (let i = updatedMessages.length - 1; i >= 0; i--) {
          if (updatedMessages[i].role === 'user') {
            updatedMessages[i] = {
              ...updatedMessages[i],
              status: 'failed',
              error: error,
            };
            break;
          }
        }

        newSessions.set(sessionId, {
          ...currentSession,
          messages: updatedMessages,
          error,
          isGenerating: false,
          streamingMessage: null,
          streamingThinking: null,
        });
      }
      return { sessions: newSessions };
    });
  },

  /**
   * Set the model for a specific session
   * Requirements: 6.1, 6.2, 6.3
   */
  setSessionModel: async (sessionId: string, modelRef: string) => {
    const session = get().sessions.get(sessionId);
    if (!session) return;

    // Check API type compatibility if session is locked
    if (session.apiType) {
      const { useConfigStore } = await import('./configStore');
      const config = useConfigStore.getState().config;
      if (config) {
        const { canSwitchModel } = await import('../utils/apiType');
        const result = canSwitchModel(session.apiType, modelRef, config);
        if (!result.allowed) {
          // Cannot switch - UI should handle this error
          console.warn(`Model switch blocked: ${result.reason}`);
          throw new Error(result.reason);
        }
      }
    }

    set((state) => {
      const newSessions = new Map(state.sessions);
      const s = newSessions.get(sessionId);
      if (s) {
        newSessions.set(sessionId, {
          ...s,
          modelRef,
        });
      }
      return { sessions: newSessions };
    });

    // Sync to DB
    // We need to pass both agent and model because the backend overwrites
    invoke('update_conversation_metadata', {
      conversationId: session.conversationId,
      agentName: session.agentName,
      modelRef: modelRef,
    }).catch(console.error);

    // Save state after model change
    get().saveSessionState();
  },

  /**
   * Set the agent for a specific session
   * Requirements: 6.1, 6.2
   */
  setSessionAgent: async (sessionId: string, agentName: string) => {
    const currentSession = get().sessions.get(sessionId);
    if (!currentSession) return;

    // Get the new agent's default model
    const { useConfigStore } = await import('./configStore');
    const agent = useConfigStore.getState().getAgent(agentName);

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (session) {
        newSessions.set(sessionId, {
          ...session,
          agentName,
          modelRef: agent?.modelRef, // Update to agent's default model
        });
      }
      return { sessions: newSessions };
    });

    // Sync to DB
    invoke('update_conversation_metadata', {
      conversationId: currentSession.conversationId,
      agentName: agentName,
      modelRef: agent?.modelRef,
    }).catch(console.error);

    // Save state after agent change
    get().saveSessionState();
  },

  /**
   * Generate title for a session based on conversation content
   * Triggered when messages >= 3 or content is substantial
   */
  generateTitle: async (sessionId: string) => {
    const session = get().sessions.get(sessionId);
    if (!session?.conversationId) return;

    // Load conversation to check current title
    const { useConversationStore } = await import('./conversationStore');
    const conversations = useConversationStore.getState().conversations;
    const conversation = conversations.find(c => c.id === session.conversationId);

    if (!conversation) return;

    // Only generate if title is still default (starts with "新对话")
    if (!conversation.title.startsWith('新对话')) return;

    try {
      const title = await invoke<string>('generate_title', {
        conversationId: session.conversationId,
        messages: session.messages.slice(0, 6), // Only send first 6 messages
      });

      // Update conversation store
      useConversationStore.getState().updateConversationTitle(session.conversationId, title);

      // Update session title as well
      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(sessionId);
        if (currentSession) {
          newSessions.set(sessionId, {
            ...currentSession,
            title,
          });
        }
        return { sessions: newSessions };
      });
    } catch (error) {
      console.error('Failed to generate title:', error);
      // Don't throw - title generation is not critical
    }
  },


  /**
   * Save session state to localStorage
   * Requirements: 5.1
   */
  saveSessionState: async () => {
    const { sessions, activeSessionId } = get();

    const persistedSessions: PersistedSession[] = Array.from(sessions.values()).map(session => ({
      id: session.id,
      agentName: session.agentName,
      modelRef: session.modelRef,
      conversationId: session.conversationId,
      apiType: session.apiType,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    }));

    const state: PersistedSessionState = {
      version: PERSISTENCE_VERSION,
      sessions: persistedSessions,
      activeSessionId,
    };

    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save session state:', error);
    }
  },

  /**
   * Restore session state from localStorage
   * Requirements: 5.2, 5.3, 5.4, 5.5
   */
  restoreSessionState: async () => {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) return;

    try {
      const state: PersistedSessionState = JSON.parse(stored);

      // Version check
      if (state.version !== PERSISTENCE_VERSION) {
        console.warn('Session state version mismatch, skipping restore');
        return;
      }

      // Get available agents from config
      const { useConfigStore } = await import('./configStore');
      const config = useConfigStore.getState().config;
      const availableAgents = config?.agents?.map(a => a.name) || [];
      const defaultAgent = config?.defaultAgent || availableAgents[0] || '';

      const newSessions = new Map<string, AgentSession>();

      for (const persisted of state.sessions) {
        // Validate agent exists, use default if not
        let agentName = persisted.agentName;
        if (!availableAgents.includes(agentName)) {
          agentName = defaultAgent;
        }

        // Load messages from backend
        let messages: Message[] = [];
        if (persisted.conversationId) {
          try {
            messages = await invoke<Message[]>('get_messages', {
              conversationId: persisted.conversationId,
              limit: 100,
            });
          } catch (error) {
            console.error('Failed to load messages for session:', error);
          }
        }

        // Get title from conversation store
        const { useConversationStore } = await import('./conversationStore');
        const conversations = useConversationStore.getState().conversations;
        const conv = conversations.find(c => c.id === persisted.conversationId);
        const title = conv?.title || '新对话';

        const session: AgentSession = {
          id: persisted.id,
          agentName,
          title,
          modelRef: persisted.modelRef,
          conversationId: persisted.conversationId,
          apiType: persisted.apiType,
          messages,
          streamingMessage: null,
          streamingThinking: null,
          isGenerating: false,
          error: null,
          createdAt: persisted.createdAt,
          lastActiveAt: persisted.lastActiveAt,
        };

        newSessions.set(session.id, session);
      }

      // Validate active session ID
      let activeSessionId = state.activeSessionId;
      if (activeSessionId && !newSessions.has(activeSessionId)) {
        activeSessionId = newSessions.size > 0 ? Array.from(newSessions.keys())[0] : null;
      }

      set({
        sessions: newSessions,
        activeSessionId,
      });
    } catch (error) {
      console.error('Failed to restore session state:', error);
    }
  },

  /**
   * Open a historical conversation in a new session
   * Requirements: 8.1, 8.2, 8.3, 8.4
   */
  openHistoricalConversation: async (conversationId: string) => {
    const { sessions } = get();

    // Check if already open
    for (const session of sessions.values()) {
      if (session.conversationId === conversationId) {
        get().switchSession(session.id);
        return session.id;
      }
    }

    // Check max sessions limit
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(`已达到最大会话数限制 (${MAX_SESSIONS})`);
    }

    // Load conversation details
    const { useConversationStore } = await import('./conversationStore');
    const conversations = useConversationStore.getState().conversations;
    const conversation = conversations.find(c => c.id === conversationId);

    // Get agent name from conversation or use default
    const { useConfigStore } = await import('./configStore');
    const config = useConfigStore.getState().config;
    let agentName = conversation?.agentName || config?.defaultAgent || '';

    // Validate agent exists
    const availableAgents = config?.agents?.map(a => a.name) || [];
    if (!availableAgents.includes(agentName)) {
      agentName = config?.defaultAgent || availableAgents[0] || '';
    }

    const agent = useConfigStore.getState().getAgent(agentName);

    // Load messages
    let messages: Message[] = [];
    try {
      messages = await invoke<Message[]>('get_messages', {
        conversationId,
        limit: 100,
      });
    } catch (error) {
      console.error('Failed to load messages:', error);
    }

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    // Sync metadata to DB if missing in conversation (Lazy migration)
    if (!conversation?.agentName || !conversation?.modelRef) {
      invoke('update_conversation_metadata', {
        conversationId,
        agentName: agentName,
        modelRef: agent?.modelRef,
      }).catch(console.error);
    }

    const session: AgentSession = {
      id: sessionId,
      agentName,
      title: conversation?.title || '新对话',
      modelRef: agent?.modelRef,
      conversationId,
      apiType: messages.length > 0 ? 'chat_completions' : null,  // Lock if has messages
      messages,
      streamingMessage: null,
      streamingThinking: null,
      isGenerating: false,
      error: null,
      createdAt: now,
      lastActiveAt: now,
    };

    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, session);
      return {
        sessions: newSessions,
        activeSessionId: sessionId,
      };
    });

    // Save state
    get().saveSessionState();

    return sessionId;
  },
}));


// Module-level event listener initialization
// Execute once to avoid race conditions from React lifecycle
let listenersInitialized = false;

export const initStreamListeners = async () => {
  // Prevent duplicate initialization
  if (listenersInitialized) return;
  listenersInitialized = true;

  try {
    // Listen for token events - route by conversationId
    await listen<{ conversationId: string; token: string }>('chat:token', (event) => {
      const session = useSessionStore.getState().getSessionByConversationId(event.payload.conversationId);
      if (session) {
        useSessionStore.getState().appendStreamingToken(session.id, event.payload.token);
      }
    });

    // Listen for thinking events - route by conversationId
    await listen<{ conversationId: string; token: string }>('chat:thinking', (event) => {
      const session = useSessionStore.getState().getSessionByConversationId(event.payload.conversationId);
      if (session) {
        useSessionStore.getState().appendThinkingToken(session.id, event.payload.token);
      }
    });

    // Listen for done events - route by conversationId
    await listen<{ conversationId: string; fullContent: string; thinking?: string; debugInfo?: DebugInfo; usage?: TokenUsage; model?: string }>('chat:done', (event) => {
      const session = useSessionStore.getState().getSessionByConversationId(event.payload.conversationId);
      if (session) {
        useSessionStore.getState().finalizeStreaming(
          session.id,
          event.payload.fullContent,
          event.payload.thinking,
          event.payload.debugInfo,
          event.payload.usage,
          event.payload.model
        );
      }
    });

    // Listen for error events - route by conversationId
    await listen<{ conversationId: string; error: string; debugInfo?: DebugInfo }>('chat:error', (event) => {
      console.log('[DEBUG] chat:error event received:', event.payload);
      const session = useSessionStore.getState().getSessionByConversationId(event.payload.conversationId);
      console.log('[DEBUG] chat:error - session lookup result:', session ? { id: session.id, convId: session.conversationId } : null);
      if (session) {
        useSessionStore.getState().handleError(session.id, event.payload.error, event.payload.debugInfo);
      } else {
        console.warn('[DEBUG] chat:error - No session found for conversationId:', event.payload.conversationId);
        // Log all current sessions for comparison
        const allSessions = Array.from(useSessionStore.getState().sessions.values());
        console.log('[DEBUG] chat:error - All current sessions:', allSessions.map(s => ({ id: s.id, convId: s.conversationId })));
      }
    });

    console.log('Session stream listeners initialized');
  } catch (error) {
    console.error('Failed to initialize stream listeners:', error);
    // Reset flag to allow retry
    listenersInitialized = false;
  }
};
