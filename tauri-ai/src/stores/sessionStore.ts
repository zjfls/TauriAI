/**
 * Session Store
 * Manages multi-agent workspace sessions using Zustand
 * Requirements: 1.1-1.5, 2.1-2.6, 4.1-4.5, 5.1-5.5, 6.1-6.3, 7.1-7.5
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentSession, Message, DebugInfo, TokenUsage, PersistedSession, PersistedSessionState, ContentPart, ThinkingMode, ApiProtocolType, RunEventPayload, MessageBlock, ProviderType, MessageTurn, Workstudio } from '../types';
import { getApiProtocol, getDefaultThinkingMode, getProviderType } from '../utils/apiUtils';
import { hydrateMessagesFromBackend } from '../utils/hydrateMessages';
import { useConfigStore } from './configStore';
import { useWorkspaceTabStore } from './workspaceTabStore';

// Constants for persistence
const SESSION_STORAGE_KEY = 'tauri-ai:sessions';
const PERSISTENCE_VERSION = 1;
const MAX_SESSIONS = 10;
const DRAFT_PERSIST_DEBOUNCE_MS = 500;
let draftPersistTimeout: ReturnType<typeof setTimeout> | null = null;

const coerceThinkingModeForProtocol = (
  thinkingMode: ThinkingMode | undefined,
  apiProtocol: ApiProtocolType,
  providerType?: ProviderType
): ThinkingMode => {
  let coerced: ThinkingMode;

  if (thinkingMode === undefined) {
    coerced = getDefaultThinkingMode(apiProtocol) as ThinkingMode;
  } else if (apiProtocol === 'responses') {
    // Convert binary -> multi-level
    coerced = typeof thinkingMode === 'boolean' ? (thinkingMode ? 'medium' : null) : thinkingMode;
  } else {
    // chat_completions: Convert multi-level -> binary
    coerced =
      typeof thinkingMode === 'boolean' ? thinkingMode : thinkingMode === null ? false : true;
  }

  // Provider-specific clamp:
  // - Google Gemini 没有“超高”，统一回退为“高”
  if (apiProtocol === 'responses' && providerType === 'google' && coerced === 'xhigh') {
    return 'high';
  }

  return coerced;
};

export interface SessionState {
  // Session management
  sessions: Map<string, AgentSession>;
  activeSessionId: string | null;

  // Session operations
  createSession: (agentName: string) => Promise<string>;
  closeSession: (sessionId: string) => Promise<void>;
  switchSession: (sessionId: string) => void;
  closeOtherSessions: (keepSessionId: string) => void;
  closeSessionsToLeft: (sessionId: string) => void;
  closeSessionsToRight: (sessionId: string) => void;

  // Message operations (act on specified session)
  sendMessage: (sessionId: string, content: string, thinking?: boolean | string, images?: ContentPart[]) => Promise<void>;
  abortGeneration: (sessionId: string) => Promise<void>;
  retry: (sessionId: string, messageId: string) => Promise<void>;
  undoToMessage: (sessionId: string, messageId: string) => void;

  // Streaming updates (internal use)
  appendStreamingToken: (sessionId: string, token: string) => void;
  appendThinkingToken: (sessionId: string, token: string) => void;
  finalizeStreaming: (sessionId: string, turnId: string, fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string, assistantMessageId?: string, format?: string) => void;
  handleError: (sessionId: string, error: string, debugInfo?: DebugInfo, turnId?: string, assistantMessageId?: string) => void;

  // Model switching (async due to API type check)
  setSessionModel: (sessionId: string, modelRef: string) => Promise<void>;

  // Agent switching
  setSessionAgent: (sessionId: string, agentName: string) => void;

  // Per-session settings
  setSessionThinkingMode: (sessionId: string, thinkingMode: ThinkingMode) => void;
  setSessionWebSearchEnabled: (sessionId: string, enabled: boolean) => void;
  setSessionDraftContent: (sessionId: string, draftContent: string) => void;

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

// 撤回/删除属于“强一致性操作”：需要忽略当前正在进行的流式 run 的 done/error，避免 UI/状态被回写。
const discardNextFinalizeByConversationId = new Set<string>();

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
    const config = useConfigStore.getState().config;

    const modelRef = agent?.modelRef;
    const apiProtocol = modelRef && config ? getApiProtocol(modelRef, config.providers) : 'chat_completions';
    const providerType = modelRef && config ? getProviderType(modelRef, config.providers) : undefined;
    const thinkingMode = coerceThinkingModeForProtocol(undefined, apiProtocol, providerType);

    const agentType = agent?.type ?? 'chat';
    const workspaceEnabled = agentType === 'tool' && (agent?.workspaceSupport ?? true);

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
      thinkingMode,
    }).catch(console.error);

    let resolvedWorkstudioId: string | null = null;
    if (workspaceEnabled) {
      try {
        const ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', {
          conversationId: conversation.id,
        });
        resolvedWorkstudioId = ws.id;
      } catch (error) {
        console.warn('ensure_workstudio_for_conversation failed:', error);
      }
    }

    const session: AgentSession = {
      id: sessionId,
      agentName,
      title: defaultTitle,
      modelRef,
      conversationId: conversation.id,
      workstudioId: resolvedWorkstudioId,
      apiType: apiProtocol, // 当前会话协议（不再做“首条消息锁定”）
      thinkingMode,
      draftContent: '',
      messages: [],
      streamingBlocks: null,
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

    // WorkspaceTabBar uses a separate order list; keep it in sync.
    useWorkspaceTabStore.getState().upsertChatTab(sessionId);

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

    useWorkspaceTabStore.getState().removeChatTab(sessionId);

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
   * Close all sessions except the specified one
   * Requirements: 2.1, 2.2
   */
  closeOtherSessions: (keepSessionId: string) => {
    const { sessions } = get();

    // Check if the session to keep exists
    if (!sessions.has(keepSessionId)) return;

    // Create new sessions map with only the session to keep
    const newSessions = new Map<string, AgentSession>();
    const sessionToKeep = sessions.get(keepSessionId);
    if (sessionToKeep) {
      newSessions.set(keepSessionId, sessionToKeep);
    }

    // Update state: keep only the specified session and set it as active
    set({
      sessions: newSessions,
      activeSessionId: keepSessionId,
    });

    useWorkspaceTabStore.getState().syncTabs([keepSessionId], []);

    // Save state after closing sessions
    get().saveSessionState();
  },

  /**
   * Close all sessions to the left of the specified session
   * Requirements: 3.1, 3.3
   */
  closeSessionsToLeft: (sessionId: string) => {
    const { sessions, activeSessionId } = get();

    // Check if the target session exists
    if (!sessions.has(sessionId)) return;

    // Convert sessions map to array to get indices
    const sessionArray = Array.from(sessions.entries());

    // Find the index of the target session
    const targetIndex = sessionArray.findIndex(([id]) => id === sessionId);
    if (targetIndex === -1) return;

    // If target is at index 0, there are no sessions to the left
    if (targetIndex === 0) return;

    // Create new sessions map excluding sessions to the left
    const newSessions = new Map<string, AgentSession>();
    for (let i = targetIndex; i < sessionArray.length; i++) {
      const [id, session] = sessionArray[i];
      newSessions.set(id, session);
    }

    // Determine new active session
    let newActiveId = activeSessionId;

    // If the active session was closed (it was to the left), update active session
    if (activeSessionId && !newSessions.has(activeSessionId)) {
      // Set the target session or the first remaining session as active
      newActiveId = sessionId;
    }

    // Update state
    set({
      sessions: newSessions,
      activeSessionId: newActiveId,
    });

    useWorkspaceTabStore.getState().syncTabs(Array.from(newSessions.keys()), []);

    // Save state after closing sessions
    get().saveSessionState();
  },

  /**
   * Close all sessions to the right of the specified session
   * Requirements: 4.1, 4.3
   */
  closeSessionsToRight: (sessionId: string) => {
    const { sessions, activeSessionId } = get();

    // Check if the target session exists
    if (!sessions.has(sessionId)) return;

    // Convert sessions map to array to get indices
    const sessionArray = Array.from(sessions.entries());

    // Find the index of the target session
    const targetIndex = sessionArray.findIndex(([id]) => id === sessionId);
    if (targetIndex === -1) return;

    // If target is at the last index, there are no sessions to the right
    if (targetIndex === sessionArray.length - 1) return;

    // Create new sessions map excluding sessions to the right
    const newSessions = new Map<string, AgentSession>();
    for (let i = 0; i <= targetIndex; i++) {
      const [id, session] = sessionArray[i];
      newSessions.set(id, session);
    }

    // Determine new active session
    let newActiveId = activeSessionId;

    // If the active session was closed (it was to the right), update active session
    if (activeSessionId && !newSessions.has(activeSessionId)) {
      // Set the target session or the first remaining session as active
      newActiveId = sessionId;
    }

    // Update state
    set({
      sessions: newSessions,
      activeSessionId: newActiveId,
    });

    useWorkspaceTabStore.getState().syncTabs(Array.from(newSessions.keys()), []);

    // Save state after closing sessions
    get().saveSessionState();
  },


  /**
   * Send a message in a specific session
   * Requirements: 4.3, 4.4
   */
  sendMessage: async (sessionId: string, content: string, thinking?: boolean | string, images?: ContentPart[]) => {
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

    // 新一轮发送开始：确保不会被“上一次撤回”的 discard 标记误伤
    discardNextFinalizeByConversationId.delete(session.conversationId);

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

    // Clear any previous run's turn indexes (defensive)
    clearTurnIndexesForSession(sessionId);

    // Update session state (stream start)
    set((state) => {
      const newSessions = new Map(state.sessions);
      const currentSession = newSessions.get(sessionId);
      if (currentSession) {
        newSessions.set(sessionId, {
          ...currentSession,
          messages: [...currentSession.messages, userMessage],
          isGenerating: true,
          streamingBlocks: [],
          streamingTurns: new Map(),
          error: null,
          lastActiveAt: new Date().toISOString(),
        });
      }
      return { sessions: newSessions };
    });

    try {
      const debugMode = useConfigStore.getState().config?.general?.debugMode ?? false;
      await invoke('run_task', {
        conversationId: session.conversationId,
        messageId: userMessage.id,
        content,
        contentParts: contentParts.length > 0 ? contentParts : undefined,
        agentName: session.agentName,
        modelRef: session.modelRef,
        thinking,  // 直接传递 thinking，可以是 boolean 或 string
        webSearchEnabled: session.webSearchEnabled,  // 传递 web search 状态
        debugMode,
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
      await invoke('abort_run', { conversationId: session.conversationId });

      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(sessionId);
        if (currentSession) {
          newSessions.set(sessionId, {
            ...currentSession,
            isGenerating: false,
            streamingBlocks: null,
            streamingTurns: undefined,
          });
        }
        return { sessions: newSessions };
      });

      // 丢弃节流队列里尚未 flush 的 token，避免中止后“复活” UI
      clearPendingChunks(sessionId);
      clearTurnIndexesForSession(sessionId);
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
            // 撤回时如果正在生成，需要清空 streaming UI，避免后续 token 把 UI/状态“复活”
            isGenerating: false,
            streamingBlocks: null,
            error: null,
          });

          // Sync with backend
          // Chain operation to ensure it completes before next message send
          if (session.conversationId) {
            discardNextFinalizeByConversationId.add(session.conversationId);
            // Fallback: avoid长期占用（正常情况下会在 done/error 时清理）
            setTimeout(() => discardNextFinalizeByConversationId.delete(session.conversationId!), 10_000);
          }
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
        const blocks = session.streamingBlocks ?? [];
        const idx = blocks.findIndex((b) => b.id === 'assistant_text');
        const nextBlocks = [...blocks];

        if (idx >= 0 && nextBlocks[idx].type === 'text') {
          const current = nextBlocks[idx] as any;
          nextBlocks[idx] = { ...current, text: (current.text || '') + token };
        } else {
          nextBlocks.push({
            id: 'assistant_text',
            type: 'text',
            format: 'markdown',
            text: token,
          });
        }

        newSessions.set(sessionId, {
          ...session,
          streamingBlocks: nextBlocks,
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
        const blocks = session.streamingBlocks ?? [];
        const idx = blocks.findIndex((b) => b.id === 'assistant_thinking');
        const nextBlocks = [...blocks];

        if (idx >= 0 && nextBlocks[idx].type === 'thinking') {
          const current = nextBlocks[idx] as any;
          nextBlocks[idx] = { ...current, text: (current.text || '') + token };
        } else {
          nextBlocks.push({
            id: 'assistant_thinking',
            type: 'thinking',
            text: token,
          });
        }

        newSessions.set(sessionId, {
          ...session,
          streamingBlocks: nextBlocks,
        });
      }
      return { sessions: newSessions };
    });
  },

  /**
   * Finalize streaming and add assistant message
   * Requirements: 7.5
   */
  finalizeStreaming: (sessionId: string, turnId: string, fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string, assistantMessageId?: string, format?: string) => {
    const session = get().sessions.get(sessionId);
    if (!session?.conversationId) return;

    const baseBlocks = session.streamingBlocks ?? [];
    const blocksById = new Map<string, MessageBlock>(baseBlocks.map((b) => [b.id, b]));

    const thinkingBlockId = `${turnId}:assistant_thinking`;
    const textBlockId = `${turnId}:assistant_text`;
    const finalTurnIndex =
      getTurnIndexForSession(sessionId, turnId) ??
      blocksById.get(thinkingBlockId)?.turnIndex ??
      blocksById.get(textBlockId)?.turnIndex;

    const getThinkingFromBlocks = (): string | undefined => {
      const b = blocksById.get(thinkingBlockId);
      if (b?.type === 'thinking') return b.text;
      const legacy = blocksById.get('assistant_thinking');
      if (legacy?.type === 'thinking') return legacy.text;
      return undefined;
    };

    const getTextFromBlocks = (): { text: string; format?: string } => {
      const b = blocksById.get(textBlockId);
      if (b?.type === 'text') return { text: b.text, format: b.format };
      const legacy = blocksById.get('assistant_text');
      if (legacy?.type === 'text') return { text: legacy.text, format: legacy.format };
      return { text: '' };
    };

    const baseThinking = thinking ?? getThinkingFromBlocks();
    let finalThinking = baseThinking && baseThinking.trim().length > 0 ? baseThinking : undefined;

    const baseContent = fullContent || getTextFromBlocks().text;
    let finalContent = baseContent && baseContent.trim().length > 0 ? baseContent : '';

    // 兜底：某些服务会把“可见输出”错误地放到 thinking 通道里，导致正文为空
    // 这里把“仅有 thinking、正文为空”的情况当作正文展示，避免用户看到一片空白。
    if (!finalContent && finalThinking) {
      finalContent = finalThinking;
      finalThinking = undefined;
    }

    if (finalThinking) {
      blocksById.set(thinkingBlockId, {
        id: thinkingBlockId,
        type: 'thinking',
        turnId,
        turnIndex: finalTurnIndex,
        text: finalThinking,
      });
    } else {
      blocksById.delete(thinkingBlockId);
    }

    if (finalContent) {
      const existingFormat =
        blocksById.get(textBlockId)?.type === 'text' ? (blocksById.get(textBlockId) as any).format : undefined;
      const legacyFormat = getTextFromBlocks().format;
      const inferredFormat = format || existingFormat || legacyFormat || 'markdown';

      blocksById.set(textBlockId, {
        id: textBlockId,
        type: 'text',
        turnId,
        turnIndex: finalTurnIndex,
        format: inferredFormat,
        text: finalContent,
      });
    } else {
      blocksById.delete(textBlockId);
    }

    const blocks: MessageBlock[] = [];
    const baseOrder = baseBlocks.map((b) => b.id);
    for (const id of baseOrder) {
      const block = blocksById.get(id);
      if (block) {
        blocks.push(block);
        blocksById.delete(id);
      }
    }
    // Ensure final-turn core blocks are appended if they were not present in streaming order
    for (const id of [thinkingBlockId, textBlockId]) {
      const block = blocksById.get(id);
      if (block) {
        blocks.push(block);
        blocksById.delete(id);
      }
    }
    for (const block of blocksById.values()) {
      blocks.push(block);
    }

    const assistantMessage: Message = {
      id: assistantMessageId || crypto.randomUUID(),
      conversationId: session.conversationId,
      role: 'assistant',
      content: finalContent,
      thinking: finalThinking,
      blocks: blocks.length > 0 ? blocks : undefined,
      meta: model ? { model } : undefined,
      debugInfo,
      turns: session.streamingTurns
        ? Array.from(session.streamingTurns.values()).sort((a, b) => a.turnIndex - b.turnIndex)
        : undefined,
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
          streamingBlocks: null,
          streamingTurns: undefined,
          isGenerating: false,
          lastActiveAt: new Date().toISOString(),
        });
      }
      return { sessions: newSessions };
    });

    clearTurnIndexesForSession(sessionId);

    // Trigger auto-title generation
    // Condition: messages >= 3 OR substantial single-reply OR multi-turn run
    const updatedSession = get().sessions.get(sessionId);
    if (updatedSession) {
      const newMessagesCount = updatedSession.messages.length;
      // NOTE:
      // - `fullContent` comes from the backend `done` payload, but some providers (or multi-turn
      //   runs) may deliver the visible text via `block_delta` instead, leaving `fullContent` empty.
      // - Tool agents can have many internal turns while still producing only one assistant message
      //   (so `messages.length` may stay at 2 for a "substantial" run).
      const turnCount = assistantMessage.turns?.length ?? 0;
      const shouldGenerateTitle =
        newMessagesCount >= 3 ||
        assistantMessage.content.length >= 100 ||
        turnCount >= 2;

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
  handleError: (sessionId: string, error: string, debugInfo?: DebugInfo, turnId?: string, assistantMessageId?: string) => {
    const session = get().sessions.get(sessionId);
    if (!session?.conversationId) return;

    const turnsSorted = session.streamingTurns
      ? Array.from(session.streamingTurns.values()).sort((a, b) => a.turnIndex - b.turnIndex)
      : undefined;

    const resolvedTurnId =
      turnId ||
      turnsSorted?.[turnsSorted.length - 1]?.turnId ||
      session.streamingBlocks?.find((b) => b.turnId)?.turnId;

    const resolvedTurnIndex =
      resolvedTurnId ? getTurnIndexForSession(sessionId, resolvedTurnId) ?? turnsSorted?.find((t) => t.turnId === resolvedTurnId)?.turnIndex : undefined;

    const blocks = (() => {
      const baseBlocks = session.streamingBlocks ?? [];
      const blocksById = new Map<string, MessageBlock>(baseBlocks.map((b) => [b.id, b]));

      if (resolvedTurnId) {
        const errorBlockId = `${resolvedTurnId}:assistant_error`;
        const existing = blocksById.get(errorBlockId);
        if (existing && existing.type === 'error') {
          blocksById.set(errorBlockId, { ...existing, text: existing.text || error, turnIndex: existing.turnIndex ?? resolvedTurnIndex });
        } else {
          blocksById.set(errorBlockId, {
            id: errorBlockId,
            type: 'error',
            turnId: resolvedTurnId,
            turnIndex: resolvedTurnIndex,
            text: error,
          });
        }
      } else {
        // 没有 turnId（极少数：模型还没开始 Turn 就失败）时，退化成 legacy block。
        blocksById.set('assistant_error', { id: 'assistant_error', type: 'error', text: error });
      }

      // 保持原始顺序，并把新增块追加到末尾
      const ordered: MessageBlock[] = [];
      for (const b of baseBlocks) {
        const v = blocksById.get(b.id);
        if (v) {
          ordered.push(v);
          blocksById.delete(b.id);
        }
      }
      for (const v of blocksById.values()) ordered.push(v);
      return ordered;
    })();

    set((state) => {
      const newSessions = new Map(state.sessions);
      const currentSession = newSessions.get(sessionId);
      if (!currentSession) return {};

      const updatedMessages = [...currentSession.messages];
      for (let i = updatedMessages.length - 1; i >= 0; i--) {
        if (updatedMessages[i].role === 'user' && updatedMessages[i].status === 'pending') {
          updatedMessages[i] = { ...updatedMessages[i], status: 'success', error: undefined };
          break;
        }
      }

      // 把 Error 事件里携带的 debugInfo（若有）补到对应 turn 上，保证出错也能点 Debug。
      const mergedTurns = (() => {
        const map = currentSession.streamingTurns ? new Map(currentSession.streamingTurns) : undefined;
        if (map && resolvedTurnId && debugInfo) {
          const existing = map.get(resolvedTurnId);
          map.set(resolvedTurnId, { ...(existing || { turnId: resolvedTurnId, turnIndex: resolvedTurnIndex || 0 }), debugInfo: existing?.debugInfo ?? debugInfo });
        }
        return map ? Array.from(map.values()).sort((a, b) => a.turnIndex - b.turnIndex) : turnsSorted;
      })();

      const lastModel = mergedTurns?.[mergedTurns.length - 1]?.model;

      const assistantMessage: Message = {
        id: assistantMessageId || crypto.randomUUID(),
        conversationId: currentSession.conversationId || '',
        role: 'assistant',
        content: '',
        blocks: blocks.length > 0 ? blocks : undefined,
        meta: lastModel ? { model: lastModel } : undefined,
        debugInfo,
        turns: mergedTurns,
        status: 'failed',
        error,
        createdAt: new Date().toISOString(),
      };

      newSessions.set(sessionId, {
        ...currentSession,
        messages: [...updatedMessages, assistantMessage],
        error,
        isGenerating: false,
        streamingBlocks: null,
        streamingTurns: undefined,
      });

      return { sessions: newSessions };
    });

    clearTurnIndexesForSession(sessionId);
  },

  /**
   * Set the model for a specific session
   * Requirements: 6.1, 6.2, 6.3
   */
  setSessionModel: async (sessionId: string, modelRef: string) => {
    const session = get().sessions.get(sessionId);
    if (!session) return;
    const { useConfigStore } = await import('./configStore');
    const config = useConfigStore.getState().config;
    const apiProtocol = config ? getApiProtocol(modelRef, config.providers) : 'chat_completions';
    const providerType = config ? getProviderType(modelRef, config.providers) : undefined;

    set((state) => {
      const newSessions = new Map(state.sessions);
      const s = newSessions.get(sessionId);
      if (s) {
        newSessions.set(sessionId, {
          ...s,
          modelRef,
          apiType: apiProtocol,
          thinkingMode: coerceThinkingModeForProtocol(s.thinkingMode, apiProtocol, providerType),
        });
      }
      return { sessions: newSessions };
    });

    // Sync to DB
    // We need to pass both agent and model because the backend overwrites
    const nextThinkingMode = coerceThinkingModeForProtocol(session.thinkingMode, apiProtocol, providerType);
    invoke('update_conversation_metadata', {
      conversationId: session.conversationId,
      agentName: session.agentName,
      modelRef: modelRef,
      thinkingMode: nextThinkingMode,
    }).catch(console.error);

    if (session.conversationId) {
      void import('./conversationStore').then(({ useConversationStore }) => {
        useConversationStore.getState().patchConversation(session.conversationId!, {
          agentName: session.agentName,
          modelRef,
          thinkingMode: nextThinkingMode,
        });
      }).catch(console.error);
    }

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
    const config = useConfigStore.getState().config;

    const modelRef = agent?.modelRef;
    const apiProtocol = modelRef && config ? getApiProtocol(modelRef, config.providers) : 'chat_completions';
    const providerType = modelRef && config ? getProviderType(modelRef, config.providers) : undefined;

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (session) {
        newSessions.set(sessionId, {
          ...session,
          agentName,
          modelRef, // Update to agent's default model
          apiType: apiProtocol,
          thinkingMode: coerceThinkingModeForProtocol(session.thinkingMode, apiProtocol, providerType),
        });
      }
      return { sessions: newSessions };
    });

    // Sync to DB
    const nextThinkingMode = coerceThinkingModeForProtocol(currentSession.thinkingMode, apiProtocol, providerType);
    invoke('update_conversation_metadata', {
      conversationId: currentSession.conversationId,
      agentName: agentName,
      modelRef: agent?.modelRef,
      thinkingMode: nextThinkingMode,
    }).catch(console.error);

    if (currentSession.conversationId) {
      void import('./conversationStore').then(({ useConversationStore }) => {
        useConversationStore.getState().patchConversation(currentSession.conversationId!, {
          agentName,
          modelRef: agent?.modelRef,
          thinkingMode: nextThinkingMode,
        });
      }).catch(console.error);
    }

    // Save state after agent change
    get().saveSessionState();
  },

  /**
   * Update per-session thinking mode/level
   */
  setSessionThinkingMode: (sessionId: string, thinkingMode: ThinkingMode) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};

      newSessions.set(sessionId, {
        ...session,
        thinkingMode,
        lastActiveAt: new Date().toISOString(),
      });

      return { sessions: newSessions };
    });

    get().saveSessionState();

    const session = get().sessions.get(sessionId);
    if (session?.conversationId) {
      invoke('update_conversation_metadata', {
        conversationId: session.conversationId,
        thinkingMode,
      }).catch(console.error);

      void import('./conversationStore').then(({ useConversationStore }) => {
        useConversationStore.getState().patchConversation(session.conversationId!, {
          thinkingMode,
        });
      }).catch(console.error);
    }
  },

  /**
   * Update per-session web search enabled state
   */
  setSessionWebSearchEnabled: (sessionId: string, enabled: boolean) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};

      newSessions.set(sessionId, {
        ...session,
        webSearchEnabled: enabled,
        lastActiveAt: new Date().toISOString(),
      });

      return { sessions: newSessions };
    });

    get().saveSessionState();
  },

  /**
   * Update per-session draft input content (unsent text)
   */
  setSessionDraftContent: (sessionId: string, draftContent: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};

      if (session.draftContent === draftContent) return {};

      newSessions.set(sessionId, {
        ...session,
        draftContent,
      });

      return { sessions: newSessions };
    });

    if (draftPersistTimeout) {
      clearTimeout(draftPersistTimeout);
    }
    draftPersistTimeout = setTimeout(() => {
      draftPersistTimeout = null;
      void get().saveSessionState();
    }, DRAFT_PERSIST_DEBOUNCE_MS);
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
      workstudioId: session.workstudioId ?? null,
      apiType: session.apiType,
      thinkingMode: session.thinkingMode,
      webSearchEnabled: session.webSearchEnabled,
      draftContent: session.draftContent,
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
            messages = hydrateMessagesFromBackend(
              await invoke<Message[]>('get_messages', {
                conversationId: persisted.conversationId,
                limit: 100,
              })
            );
          } catch (error) {
            console.error('Failed to load messages for session:', error);
          }
        }

        // Get title from conversation store
        const { useConversationStore } = await import('./conversationStore');
        const conversations = useConversationStore.getState().conversations;
        const conv = conversations.find(c => c.id === persisted.conversationId);
        const title = conv?.title || '新对话';
        const convWorkstudioId = conv?.workstudioId ?? null;

        const agent = useConfigStore.getState().getAgent(agentName);
        const modelRef = persisted.modelRef || agent?.modelRef;
        const apiProtocol = modelRef && config ? getApiProtocol(modelRef, config.providers) : 'chat_completions';
        const providerType = modelRef && config ? getProviderType(modelRef, config.providers) : undefined;

        const session: AgentSession = {
          id: persisted.id,
          agentName,
          title,
          modelRef,
          conversationId: persisted.conversationId,
          workstudioId: persisted.workstudioId ?? convWorkstudioId,
          apiType: apiProtocol,
          thinkingMode: coerceThinkingModeForProtocol(persisted.thinkingMode, apiProtocol, providerType),
          webSearchEnabled: persisted.webSearchEnabled,
          draftContent: persisted.draftContent ?? '',
          messages,
          streamingBlocks: null,
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

      useWorkspaceTabStore.getState().syncTabs(Array.from(newSessions.keys()), []);
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

    const modelRef = conversation?.modelRef || agent?.modelRef;
    const apiProtocol = modelRef && config ? getApiProtocol(modelRef, config.providers) : 'chat_completions';
    const providerType = modelRef && config ? getProviderType(modelRef, config.providers) : undefined;

    const agentType = agent?.type ?? 'chat';
    const workspaceEnabled = agentType === 'tool' && (agent?.workspaceSupport ?? true);

    let resolvedWorkstudioId: string | null = conversation?.workstudioId ?? null;
    if (workspaceEnabled) {
      try {
        const ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
        resolvedWorkstudioId = ws.id;
      } catch (error) {
        console.warn('ensure_workstudio_for_conversation failed:', error);
      }
    }

    // Load messages
    let messages: Message[] = [];
    try {
      messages = hydrateMessagesFromBackend(
        await invoke<Message[]>('get_messages', {
          conversationId,
          limit: 100,
        })
      );
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
        modelRef,
      }).catch(console.error);
    }

    const session: AgentSession = {
      id: sessionId,
      agentName,
      title: conversation?.title || '新对话',
      modelRef,
      conversationId,
      workstudioId: resolvedWorkstudioId,
      apiType: apiProtocol,
      thinkingMode: coerceThinkingModeForProtocol(conversation?.thinkingMode, apiProtocol, providerType),
      draftContent: '',
      messages,
      streamingBlocks: null,
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

    useWorkspaceTabStore.getState().upsertChatTab(sessionId);

    // Save state
    get().saveSessionState();

    return sessionId;
  },
}));


// Module-level event listener initialization
// Execute once to avoid race conditions from React lifecycle
let listenersInitialized = false;

// ============================================================================
// Streaming UI update throttling
// - Token events can be very frequent; updating React/Zustand on every token will
//   cause excessive re-renders. We buffer tokens and flush at a fixed rate.
// - 调整刷新频率：把 STREAM_UI_UPDATE_FPS 改成 2 或 3 即可（2=每秒2次，3=每秒3次）
// ============================================================================
const STREAM_UI_UPDATE_FPS = 20;
const STREAM_UI_UPDATE_INTERVAL_MS = Math.round(1000 / STREAM_UI_UPDATE_FPS);

type PendingStreamChunks = {
  // key: uiBlockId（turnId:blockId）
  blocks: Map<
    string,
    {
      blockType: string;
      format?: string;
      turnId: string;
      turnIndex?: number;
      chunks: string[];
    }
  >;
};

const pendingStreamChunksBySessionId = new Map<string, PendingStreamChunks>();
let streamFlushTimeout: ReturnType<typeof setTimeout> | null = null;

type StreamingTurnsById = Map<string, MessageTurn>;
const streamingTurnIndexBySessionId = new Map<string, Map<string, number>>();

const setTurnIndexForSession = (sessionId: string, turnId: string, turnIndex: number) => {
  let byTurn = streamingTurnIndexBySessionId.get(sessionId);
  if (!byTurn) {
    byTurn = new Map<string, number>();
    streamingTurnIndexBySessionId.set(sessionId, byTurn);
  }
  byTurn.set(turnId, turnIndex);
};

const getTurnIndexForSession = (sessionId: string, turnId: string): number | undefined => {
  return streamingTurnIndexBySessionId.get(sessionId)?.get(turnId);
};

const clearTurnIndexesForSession = (sessionId: string) => {
  streamingTurnIndexBySessionId.delete(sessionId);
};

const getOrCreatePendingChunks = (sessionId: string): PendingStreamChunks => {
  let chunks = pendingStreamChunksBySessionId.get(sessionId);
  if (!chunks) {
    chunks = { blocks: new Map() };
    pendingStreamChunksBySessionId.set(sessionId, chunks);
  }
  return chunks;
};

const clearPendingChunks = (sessionId: string) => {
  pendingStreamChunksBySessionId.delete(sessionId);
};

const flushPendingStreamChunks = () => {
  if (pendingStreamChunksBySessionId.size === 0) return;

  const snapshot = Array.from(pendingStreamChunksBySessionId.entries());
  pendingStreamChunksBySessionId.clear();

  useSessionStore.setState((state) => {
    let updated = false;
    const newSessions = new Map(state.sessions);

    for (const [sessionId, chunks] of snapshot) {
      if (chunks.blocks.size === 0) continue;

      const session = newSessions.get(sessionId);
      if (!session) continue;

      // Streaming already ended/aborted: drop buffered tokens to avoid resurrecting UI
      if (session.streamingBlocks === null) continue;

      let nextBlocks = session.streamingBlocks ?? [];

      const parseJson = (text: string): any | null => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };

      const extractSuffixId = (prefix: string, id: string): string => {
        const idx = id.lastIndexOf(prefix);
        return idx === -1 ? id : id.slice(idx + prefix.length);
      };

      // Some block types are emitted as full JSON snapshots; for these we should not concat deltas.
      const isSnapshotBlockType = (blockType: string) => {
        return blockType === 'web_search' || blockType === 'tool_call';
      };

      const upsertBlock = (
        blocks: MessageBlock[],
        blockId: string,
        blockType: string,
        format: string | undefined,
        turnId: string,
        turnIndex: number | undefined,
        delta: string
      ): MessageBlock[] => {
        const idx = blocks.findIndex((b) => b.id === blockId);

        const createBlock = (): MessageBlock => {
          if (blockType === 'thinking') {
            return { id: blockId, type: 'thinking', turnId, turnIndex, text: delta };
          }
          if (blockType === 'text') {
            return { id: blockId, type: 'text', format: format || 'markdown', turnId, turnIndex, text: delta };
          }
          if (blockType === 'tool_result') {
            return {
              id: blockId,
              type: 'tool_result',
              callId: extractSuffixId('tool_result:', blockId),
              turnId,
              turnIndex,
              text: delta,
            };
          }
          if (blockType === 'error') {
            return { id: blockId, type: 'error', turnId, turnIndex, text: delta };
          }
          if (blockType === 'tool_call') {
            const v = parseJson(delta);
            if (v && typeof v === 'object') {
              const callId = typeof v.id === 'string' ? v.id : extractSuffixId('tool_call:', blockId);
              const name = typeof v.name === 'string' ? v.name : '';
              const args = typeof v.arguments === 'string' ? v.arguments : '';
              return { id: blockId, type: 'tool_call', callId, name, arguments: args, turnId, turnIndex };
            }
          }
          if (blockType === 'web_search') {
            const v = parseJson(delta);
            if (v && typeof v === 'object') {
              const callId = typeof v.id === 'string' ? v.id : extractSuffixId('web_search:', blockId);
              const status = typeof v.status === 'string' ? v.status : 'unknown';
              const action = v.action;
              return { id: blockId, type: 'web_search', callId, status, action, turnId, turnIndex };
            }
          }
          return { id: blockId, type: 'unknown', turnId, turnIndex, data: { blockType, format, text: delta } };
        };

        if (idx === -1) {
          return [...blocks, createBlock()];
        }

        const current = blocks[idx];
        const next: MessageBlock = (() => {
          if (current.type === 'thinking' && blockType === 'thinking') {
            return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: current.text + delta };
          }
          if (current.type === 'text' && blockType === 'text') {
            return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: current.text + delta, format: current.format || format || 'markdown' };
          }
          if (current.type === 'tool_result' && blockType === 'tool_result') {
            return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: current.text + delta };
          }
          if (current.type === 'error' && blockType === 'error') {
            return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: current.text + delta };
          }
          if (current.type === 'tool_call' && blockType === 'tool_call') {
            // Snapshot update: overwrite (arguments may arrive in multiple updates in future)
            return createBlock();
          }
          if (current.type === 'web_search' && blockType === 'web_search') {
            // Snapshot update: overwrite
            return createBlock();
          }
          if (current.type === 'unknown') {
            // If we now recognize the blockType, upgrade it to a typed block; otherwise append text.
            if (blockType === 'text' || blockType === 'thinking' || blockType === 'tool_call' || blockType === 'tool_result' || blockType === 'web_search' || blockType === 'error') {
              return createBlock();
            }

            const data = current.data as any;
            const prevText = typeof data?.text === 'string' ? data.text : '';
            return {
              ...current,
              turnIndex: current.turnIndex ?? turnIndex,
              data: {
                ...(typeof data === 'object' && data ? data : {}),
                blockType,
                format,
                text: prevText + delta,
              },
            };
          }

          // Type changed: replace block with the new type
          return createBlock();
        })();

        if (next === current) return blocks;
        const copy = blocks.slice();
        copy[idx] = next;
        return copy;
      };

      for (const [blockId, b] of chunks.blocks.entries()) {
        const delta = b.chunks.length > 0
          ? (isSnapshotBlockType(b.blockType) ? b.chunks[b.chunks.length - 1] : b.chunks.join(''))
          : '';
        if (!delta) continue;
        nextBlocks = upsertBlock(nextBlocks, blockId, b.blockType, b.format, b.turnId, b.turnIndex, delta);
      }

      if (nextBlocks !== session.streamingBlocks) {
        newSessions.set(sessionId, {
          ...session,
          streamingBlocks: nextBlocks,
        });
        updated = true;
      }
    }

    return updated ? { sessions: newSessions } : {};
  });
};

const scheduleStreamFlush = () => {
  if (streamFlushTimeout) return;
  streamFlushTimeout = setTimeout(() => {
    streamFlushTimeout = null;
    flushPendingStreamChunks();

    // If tokens arrive again during the next tick, they'll schedule another flush.
    if (pendingStreamChunksBySessionId.size > 0) {
      scheduleStreamFlush();
    }
  }, STREAM_UI_UPDATE_INTERVAL_MS);
};

const queueBlockDelta = (
  sessionId: string,
  turnId: string,
  turnIndex: number | undefined,
  blockId: string,
  blockType: string,
  format: string | undefined,
  delta: string
) => {
  const chunks = getOrCreatePendingChunks(sessionId);
  const uiBlockId = `${turnId}:${blockId}`;
  const entry = chunks.blocks.get(uiBlockId);
  if (entry) {
    entry.chunks.push(delta);
    return scheduleStreamFlush();
  }

  chunks.blocks.set(uiBlockId, {
    blockType,
    format,
    turnId,
    turnIndex,
    chunks: [delta],
  });
  scheduleStreamFlush();
};

export const initStreamListeners = async () => {
  // Prevent duplicate initialization
  if (listenersInitialized) return;
  listenersInitialized = true;

  try {
    // Unified stream channel - route by conversationId
    // 说明：所有运行时事件只走 run:event（可扩展到 tool/websearch/非文本输出等）。
    await listen<RunEventPayload>('run:event', (event) => {
      const payload = event.payload;
      const session = useSessionStore.getState().getSessionByConversationId(payload.conversationId);
      if (!session) return;

      if (payload.type === 'turn_started') {
        setTurnIndexForSession(session.id, payload.turnId, payload.turnIndex);

        useSessionStore.setState((state) => {
          const newSessions = new Map(state.sessions);
          const currentSession = newSessions.get(session.id);
          if (!currentSession) return {};

          const turns: StreamingTurnsById =
            currentSession.streamingTurns ?? new Map<string, MessageTurn>();
          const existing = turns.get(payload.turnId);
          turns.set(payload.turnId, {
            turnId: payload.turnId,
            turnIndex: payload.turnIndex,
            status: existing?.status,
            debugInfo: existing?.debugInfo,
            usage: existing?.usage,
            model: existing?.model,
          });

          newSessions.set(session.id, {
            ...currentSession,
            streamingTurns: turns,
          });
          return { sessions: newSessions };
        });
        return;
      }

      if (payload.type === 'turn_finished') {
        if (typeof payload.turnIndex === 'number') {
          setTurnIndexForSession(session.id, payload.turnId, payload.turnIndex);
        }

        useSessionStore.setState((state) => {
          const newSessions = new Map(state.sessions);
          const currentSession = newSessions.get(session.id);
          if (!currentSession) return {};

          const turns: StreamingTurnsById =
            currentSession.streamingTurns ?? new Map<string, MessageTurn>();
          const existing = turns.get(payload.turnId);
          turns.set(payload.turnId, {
            turnId: payload.turnId,
            turnIndex: payload.turnIndex ?? existing?.turnIndex ?? 0,
            status: payload.status,
            debugInfo: payload.debugInfo ?? existing?.debugInfo,
            usage: payload.usage ?? existing?.usage,
            model: payload.model ?? existing?.model,
          });

          newSessions.set(session.id, {
            ...currentSession,
            streamingTurns: turns,
          });
          return { sessions: newSessions };
        });
        return;
      }

      if (payload.type === 'block_delta') {
        // 统一缓存所有 block_delta：具体渲染/业务处理由上层按 blockType 决定（thinking/text/tool/websearch/...）。
        queueBlockDelta(
          session.id,
          payload.turnId,
          getTurnIndexForSession(session.id, payload.turnId),
          payload.blockId,
          payload.blockType,
          payload.format,
          payload.delta
        );
        return;
      }

      if (payload.type === 'done') {
        // 收尾前先 flush 一次，避免最后一批 token 被节流队列丢弃
        flushPendingStreamChunks();
        if (discardNextFinalizeByConversationId.has(payload.conversationId)) {
          discardNextFinalizeByConversationId.delete(payload.conversationId);
          return;
        }
        useSessionStore.getState().finalizeStreaming(
          session.id,
          payload.turnId,
          payload.fullContent,
          payload.thinking,
          payload.debugInfo,
          payload.usage,
          payload.model,
          payload.assistantMessageId,
          payload.format
        );
        return;
      }

      if (payload.type === 'error') {
        flushPendingStreamChunks();
        if (discardNextFinalizeByConversationId.has(payload.conversationId)) {
          discardNextFinalizeByConversationId.delete(payload.conversationId);
          return;
        }
        useSessionStore.getState().handleError(
          session.id,
          payload.error,
          payload.debugInfo,
          payload.turnId,
          payload.assistantMessageId
        );
      }
    });

    console.log('Session stream listeners initialized');
  } catch (error) {
    console.error('Failed to initialize stream listeners:', error);
    // Reset flag to allow retry
    listenersInitialized = false;
  }
};

// -----------------------------------------------------------------------------
// Debug: store update storm detector
// -----------------------------------------------------------------------------
// 用于定位类似 "Maximum update depth exceeded" 这类循环更新问题。
// 说明：
// - 很多情况下用户打不开 DevTools（应用直接崩），所以这里默认在 DEV 下启用，
//   并把关键堆栈写入 localStorage，方便 ErrorBoundary 直接展示。
// - 触发后也会打印一次 console.trace()（若 DevTools 可用更直观）。
const SESSION_STORE_DEBUG_LAST_STORM_KEY = 'tauri-ai:debug:last_session_store_storm';
const sessionStoreStormDebugEnabled = (() => {
  try {
    return import.meta.env.DEV;
  } catch {
    return false;
  }
})();

if (sessionStoreStormDebugEnabled) {
  let windowStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let updatesInWindow = 0;
  let tracedInWindow = false;

  // 500ms 内更新次数过多，基本可以判定为“循环更新/风暴”
  const WINDOW_MS = 500;
  // React "Maximum update depth exceeded" 通常在 ~50 次左右触发，这里提前一点点抓堆栈。
  const TRACE_THRESHOLD = 40;

  useSessionStore.subscribe((state, prev) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      updatesInWindow = 0;
      tracedInWindow = false;
    }

    updatesInWindow += 1;

    if (!tracedInWindow && updatesInWindow >= TRACE_THRESHOLD) {
      tracedInWindow = true;

      const activeId = state.activeSessionId;
      const active = activeId ? state.sessions.get(activeId) : undefined;
      const prevActive = prev.activeSessionId ? prev.sessions.get(prev.activeSessionId) : undefined;

      const stack = (() => {
        try {
          return new Error('sessionStore update storm').stack || '';
        } catch {
          return '';
        }
      })();

      // 记录到 localStorage，方便 ErrorBoundary 在“没法开 DevTools”时直接展示
      try {
        if (typeof localStorage !== 'undefined') {
          const record = {
            ts: Date.now(),
            updatesInWindow,
            windowMs: WINDOW_MS,
            activeSessionId: activeId ?? null,
            active: {
              conversationId: active?.conversationId ?? null,
              isGenerating: active?.isGenerating ?? null,
              messages: active?.messages?.length ?? null,
              streamingBlocks: active?.streamingBlocks ? active.streamingBlocks.length : null,
              draftLen: active?.draftContent?.length ?? 0,
            },
            prevActive: {
              conversationId: prevActive?.conversationId ?? null,
              isGenerating: prevActive?.isGenerating ?? null,
              messages: prevActive?.messages?.length ?? null,
              streamingBlocks: prevActive?.streamingBlocks ? prevActive.streamingBlocks.length : null,
              draftLen: prevActive?.draftContent?.length ?? 0,
            },
            stack,
          };
          localStorage.setItem(SESSION_STORE_DEBUG_LAST_STORM_KEY, JSON.stringify(record));
        }
      } catch {
        // ignore
      }

      console.groupCollapsed(
        `[debug] sessionStore 更新风暴: ${updatesInWindow}/${WINDOW_MS}ms (active=${activeId ?? 'null'})`
      );
      console.log('active snapshot:', {
        conversationId: active?.conversationId,
        isGenerating: active?.isGenerating,
        messages: active?.messages?.length,
        streamingBlocks: active?.streamingBlocks ? active.streamingBlocks.length : null,
        draftLen: active?.draftContent?.length ?? 0,
      });
      console.log('active prev snapshot:', {
        conversationId: prevActive?.conversationId,
        isGenerating: prevActive?.isGenerating,
        messages: prevActive?.messages?.length,
        streamingBlocks: prevActive?.streamingBlocks ? prevActive.streamingBlocks.length : null,
        draftLen: prevActive?.draftContent?.length ?? 0,
      });
      console.trace('sessionStore update storm stack');
      if (stack) console.log('captured stack:', stack);
      console.groupEnd();
    }
  });
}
