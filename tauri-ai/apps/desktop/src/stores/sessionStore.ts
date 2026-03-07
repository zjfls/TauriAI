/**
 * Session Store
 * Manages multi-agent workspace sessions using Zustand
 * Requirements: 1.1-1.5, 2.1-2.6, 4.1-4.5, 5.1-5.5, 6.1-6.3, 7.1-7.5
 */

import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import { tauriInvoke as invoke, showGlobalError } from '../utils/errorUtils';
import { listen } from '@tauri-apps/api/event';
import type {
  AgentSession,
  Message,
  DebugInfo,
  TokenUsage,
  PersistedSession,
  PersistedSessionState,
  ContentPart,
  CodeSnippetContentPart,
  WorkspaceMentionChip,
  ThinkingMode,
  ApiProtocolType,
  RunEventPayload,
  MessageBlock,
  ProviderType,
  MessageTurn,
  Workstudio,
  RunMode,
  Conversation,
  QueuedSessionMessage,
} from '../types';
import { getApiProtocol, getDefaultThinkingMode, getProviderType } from '../utils/apiUtils';
import { hydrateMessagesFromBackend } from '../utils/hydrateMessages';
import { markChatOpenProfile, setChatOpenProfileTarget } from '../utils/chatOpenProfile';
import { requestConversationScrollToBottomOnce } from '../utils/conversationViewState';
import {
  closeCurrentWindow,
  dockConversationToWindow,
  emitToWindowLabel,
  getViewWindowParams,
  type ChatDockPlacement,
  type WorkspaceDockRequestPayload,
} from '../utils/viewWindow';
import { getWindowLabelForStorage, getWindowScopedStorageKey, isMainWindowLabel } from '../utils/windowStorage';
import { useConfigStore } from './configStore';
import { useDocumentStore } from './documentStore';
import { notifyTaskCompletion, syncUnreadCompletionBadge } from '../utils/completionNotifications';
import { useTerminalTabStore } from './terminalTabStore';
import { useUIStore } from './uiStore';
import { useWebTabStore } from './webTabStore';
import { useWindowLayoutStore } from './windowLayoutStore';
import { chatTabId, docTabId, terminalTabId, useWorkspaceTabStore, webTabId, type WorkspaceTabId } from './workspaceTabStore';

// Constants for persistence
const SESSION_STORAGE_KEY_PREFIX = 'tauri-ai:sessions:v3';
const LEGACY_SESSION_STORAGE_KEY = 'tauri-ai:sessions';
const PERSISTENCE_VERSION = 2;
const MAX_SESSIONS = 20;
const DRAFT_PERSIST_DEBOUNCE_MS = 500;
const MAX_PERSISTED_DRAFT_CODE_SNIPPET_CHARS = 200_000;
let draftPersistTimeout: ReturnType<typeof setTimeout> | null = null;

const countUnreadCompletions = (sessions: Map<string, AgentSession>): number => {
  let unread = 0;
  for (const session of sessions.values()) {
    if (session.hasUnreadCompletion) unread += 1;
  }
  return unread;
};

const shouldDispatchCompletionNotification = (
  state: Pick<SessionState, 'panes' | 'activeSessionId'>,
  sessionId: string
): boolean => {
  const windowVisible = typeof document !== 'undefined' && !document.hidden && document.hasFocus();
  if (!windowVisible) return true;
  if (useUIStore.getState().activeView !== 'chat') return true;
  const visibleInPane = state.panes.some((pane) => pane.activeSessionId === sessionId);
  return !(visibleInPane || state.activeSessionId === sessionId);
};

const isStandaloneWindow = (): boolean => {
  try {
    return getViewWindowParams().standalone;
  } catch {
    return false;
  }
};

const getSessionStateStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null;
    // 多窗口隔离：standalone 窗口用 sessionStorage（每个窗口独立），主窗口用 localStorage（跨重启持久化）。
    return window.localStorage;
  } catch {
    return null;
  }
};

const getSessionStateStorageKey = (): string => getWindowScopedStorageKey(SESSION_STORAGE_KEY_PREFIX);

const isRunMode = (v: unknown): v is RunMode =>
  v === 'chat' || v === 'agent' || v === 'agent-custom' || v === 'agent-full-access';

export interface SessionPane {
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
  /** 用于横向分屏的宽度权重（flex-grow） */
  weight: number;
}

type SanitizedLayout = {
  panes: SessionPane[];
  changed: boolean;
};

const normalizePaneWeights = (panes: SessionPane[]): SessionPane[] => {
  if (panes.length === 0) return panes;
  const sanitized = panes.map((p) => ({
    ...p,
    weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
  }));
  const total = sanitized.reduce((acc, p) => acc + p.weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return sanitized.map((p) => ({ ...p, weight: 1 }));
  }
  return sanitized;
};

const findPaneIndexBySessionId = (panes: SessionPane[], sessionId: string): number => {
  return panes.findIndex((p) => p.sessionIds.includes(sessionId));
};

const ensureAtLeastOnePane = (panes: SessionPane[]): SessionPane[] => {
  if (panes.length > 0) return panes;
  return [
    {
      id: crypto.randomUUID(),
      sessionIds: [],
      activeSessionId: null,
      weight: 1,
    },
  ];
};

const sanitizePanesForSessions = (
  panes: SessionPane[],
  sessions: Map<string, AgentSession>
): SanitizedLayout => {
  let changed = false;
  let next: SessionPane[] = panes.length > 0 ? panes : ensureAtLeastOnePane([]);

  // 1) 过滤不存在的 sessionId + 反重复（一个 session 只能属于一个 pane）
  const assigned = new Set<string>();
  next = next.map((p) => {
    const filtered: string[] = [];
    for (const sid of p.sessionIds) {
      if (!sessions.has(sid)) {
        changed = true;
        continue;
      }
      if (assigned.has(sid)) {
        changed = true;
        continue;
      }
      assigned.add(sid);
      filtered.push(sid);
    }

    let active = p.activeSessionId;
    if (active && !filtered.includes(active)) {
      active = filtered[0] ?? null;
      changed = true;
    }
    if (!active && filtered.length > 0) {
      active = filtered[0]!;
      changed = true;
    }

    const weight = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1;
    if (weight !== p.weight) changed = true;

    return {
      ...p,
      sessionIds: filtered,
      activeSessionId: active,
      weight,
    };
  });

  // 2) 移除空 pane（只要还有任意非空 pane）
  const nonEmpty = next.filter((p) => p.sessionIds.length > 0);
  if (nonEmpty.length > 0 && nonEmpty.length !== next.length) {
    next = nonEmpty;
    changed = true;
  }

  // 3) 至少保留一个 pane
  if (next.length === 0) {
    next = ensureAtLeastOnePane([]);
    changed = true;
  } else if (next.length === 1 && next[0]!.sessionIds.length === 0 && next[0]!.activeSessionId !== null) {
    next = [{ ...next[0]!, activeSessionId: null }];
    changed = true;
  }

  const normalized = normalizePaneWeights(next);
  if (normalized !== next) changed = true;

  return { panes: normalized, changed };
};

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
  /**
   * 是否已完成过一次 `restoreSessionState()`（本窗口维度）。
   *
   * 说明：
   * - 启动早期 sessions 可能暂时为空（等待 config/DB 读取），但工作区 split/tab 布局可能已从 localStorage 读入。
   * - 若此时按“当前 sessionsMap”去清洗布局，会把持久化的 chat tabs 误删并写回，造成“分屏布局持久化没生效”的观感。
   */
  hydrated: boolean;
  // Pane/group management (VS Code-like)
  panes: SessionPane[];
  focusedPaneId: string | null;

  // Session operations
  createSession: (agentName: string) => Promise<string>;
  closeSession: (sessionId: string) => Promise<void>;
  /** 把一个会话（conversation）停靠/移入另一个窗口（作为 tab 或分屏），成功后关闭本窗口该 tab */
  dockSessionToWindow: (sessionId: string, targetWindowLabel: string, placement?: ChatDockPlacement) => Promise<void>;
  switchSession: (sessionId: string) => void;
  /** 将会话的“新结果红点”标记为已读（仅在用户实际交互后调用） */
  acknowledgeUnreadCompletion: (sessionId: string) => void;
  closeOtherSessions: (keepSessionId: string) => void;
  closeSessionsToLeft: (sessionId: string) => void;
  closeSessionsToRight: (sessionId: string) => void;

  // Pane operations
  setFocusedPane: (paneId: string) => void;
  setActiveSessionInPane: (paneId: string, sessionId: string) => void;
  reorderSessionInPane: (paneId: string, activeSessionId: string, overSessionId: string) => void;
  moveSessionToPane: (sessionId: string, toPaneId: string, toIndex?: number) => void;
  splitSessionToNewPane: (
    sessionId: string,
    direction: 'left' | 'right',
    targetPaneId: string
  ) => void;
  closePaneAndMerge: (paneId: string) => void;
  setPaneWeights: (weights: Array<{ paneId: string; weight: number }>) => void;
  /** 修复历史/边界情况下残留的空 pane、失效 activeSessionId 等布局状态 */
  sanitizeLayoutState: () => void;

  // Message operations (act on specified session)
  sendMessage: (sessionId: string, content: string, thinking?: boolean | string, images?: ContentPart[]) => Promise<void>;
  abortGeneration: (sessionId: string) => Promise<void>;
  retry: (sessionId: string, messageId: string) => Promise<void>;
  retryTurn: (sessionId: string, assistantMessageId: string, turnId: string) => Promise<void>;
  undoToMessage: (sessionId: string, messageId: string) => void;
  moveQueuedMessage: (sessionId: string, messageId: string, direction: 'up' | 'down') => void;
  removeQueuedMessage: (sessionId: string, messageId: string) => void;
  updateQueuedMessageContent: (sessionId: string, messageId: string, content: string) => void;

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
		  setSessionRunMode: (sessionId: string, runMode: RunMode) => void;
		  setSessionThinkingMode: (sessionId: string, thinkingMode: ThinkingMode) => void;
		  setSessionWebSearchProvider: (sessionId: string, provider: 'native' | 'tavily' | 'google' | 'brave' | null) => void;
		  setSessionDraftContent: (sessionId: string, draftContent: string) => void;
		  setSessionDraftWorkspaceMentions: (sessionId: string, mentions: WorkspaceMentionChip[]) => void;
		  setSessionDraftCodeSnippets: (sessionId: string, snippets: CodeSnippetContentPart[]) => void;

  // Title (conversation title shown in tab)
  setSessionTitle: (sessionId: string, title: string) => void;
  /** 当 conversation 标题在其它入口被修改时，同步更新当前窗口已打开的 session（按 conversationId 匹配） */
  syncConversationTitle: (conversationId: string, title: string) => void;

  // Title generation
  generateTitle: (sessionId: string) => Promise<void>;

  // Persistence
  saveSessionState: () => Promise<void>;
  restoreSessionState: () => Promise<void>;

  // History
  openHistoricalConversation: (
    conversationId: string,
    opts?: { agentName?: string; runMode?: RunMode }
  ) => Promise<string>;
  /** 克隆当前会话对应的对话，并在同一 Pane 新建一个 tab 打开 */
  cloneConversation: (sessionId: string) => Promise<string>;

  // Getters
  getActiveSession: () => AgentSession | undefined;
  getSession: (sessionId: string) => AgentSession | undefined;
  getSessionByConversationId: (conversationId: string) => AgentSession | undefined;
}

// Queue to ensure undo operations complete before sending new messages
let pendingUndoOperation: Promise<any> = Promise.resolve();

// 撤回/删除属于“强一致性操作”：需要忽略当前正在进行的流式 run 的 done/error，避免 UI/状态被回写。
const discardNextFinalizeByConversationId = new Set<string>();

const drainingQueuedSessions = new Set<string>();

const cloneQueuedImages = (images?: ContentPart[]): ContentPart[] | undefined =>
  images ? images.map((part) => ({ ...part })) : undefined;

const enqueueQueuedMessage = (
  sessionId: string,
  content: string,
  thinking?: boolean | string,
  images?: ContentPart[]
) => {
  useSessionStore.setState((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(sessionId);
    if (!session) return {};
    const nextQueue: QueuedSessionMessage[] = [
      ...(session.queuedMessages ?? []),
      {
        id: crypto.randomUUID(),
        content,
        thinking,
        images: cloneQueuedImages(images),
        enqueuedAt: new Date().toISOString(),
      },
    ];
    newSessions.set(sessionId, {
      ...session,
      queuedMessages: nextQueue,
    });
    return { sessions: newSessions };
  });
};

const shiftQueuedMessage = (sessionId: string): QueuedSessionMessage | undefined => {
  let next: QueuedSessionMessage | undefined;
  useSessionStore.setState((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(sessionId);
    if (!session) return {};
    const queue = session.queuedMessages ?? [];
    if (queue.length === 0) return {};
    next = queue[0];
    newSessions.set(sessionId, {
      ...session,
      queuedMessages: queue.slice(1),
    });
    return { sessions: newSessions };
  });
  return next;
};

const clearQueuedMessagesForSession = (sessionId: string) => {
  useSessionStore.setState((state) => {
    const newSessions = new Map(state.sessions);
    const session = newSessions.get(sessionId);
    if (!session) return {};
    if (!session.queuedMessages || session.queuedMessages.length === 0) return {};
    newSessions.set(sessionId, {
      ...session,
      queuedMessages: [],
    });
    return { sessions: newSessions };
  });
  drainingQueuedSessions.delete(sessionId);
};

const drainQueuedMessages = async (sessionId: string): Promise<void> => {
  if (drainingQueuedSessions.has(sessionId)) return;
  drainingQueuedSessions.add(sessionId);

  try {
    while (true) {
      const state = useSessionStore.getState();
      const session = state.sessions.get(sessionId);
      if (!session) {
        clearQueuedMessagesForSession(sessionId);
        return;
      }

      if (session.isGenerating) {
        return;
      }

      const nextQueuedMessage = shiftQueuedMessage(sessionId);
      if (!nextQueuedMessage) {
        return;
      }

      try {
        await state.sendMessage(
          sessionId,
          nextQueuedMessage.content,
          nextQueuedMessage.thinking,
          nextQueuedMessage.images
        );
      } catch (error) {
        console.error('Failed to send queued message:', error);
      }
    }
  } finally {
    drainingQueuedSessions.delete(sessionId);
  }
};

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: new Map<string, AgentSession>(),
  activeSessionId: null,
  hydrated: false,
  panes: ensureAtLeastOnePane([]),
  focusedPaneId: null,

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
    const toolLikeAgent = agentType === 'tool' || agentType === 'task_agent';
    const workspaceEnabled = toolLikeAgent && (agent?.workspaceSupport ?? true);
    const fallbackRunMode: RunMode = toolLikeAgent ? 'agent' : 'chat';
    const runMode: RunMode = isRunMode(agent?.defaultRunMode) ? agent.defaultRunMode : fallbackRunMode;

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
      runMode,
      thinkingMode,
    }).catch(console.error);

    // Session 启动阶段：预热 MCP（Codex-like），避免首次消息触发工具注入时再去拉 tools/list。
    // Best-effort：不阻塞会话创建流程。
    invoke('warmup_mcp_servers').catch((e) => console.warn('warmup_mcp_servers failed:', e));

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
	      runMode,
			      thinkingMode,
			      draftContent: '',
			      draftWorkspaceMentions: [],
			      draftCodeSnippets: [],
			      messages: [],
			      queuedMessages: [],
		      streamingBlocks: null,
	      isGenerating: false,
	      error: null,
	      hasUnreadCompletion: false,
	      unreadCompletionMessageId: null,
	      createdAt: now,
	      lastActiveAt: now,
	    };

    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, session);

      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds].filter((id) => id !== sessionId),
      }));

      const resolvedFocusedPaneId =
        state.focusedPaneId && nextPanes.some((p) => p.id === state.focusedPaneId)
          ? state.focusedPaneId
          : nextPanes[0].id;
      const targetIndex = Math.max(0, nextPanes.findIndex((p) => p.id === resolvedFocusedPaneId));
      const targetPane = nextPanes[targetIndex]!;
      targetPane.sessionIds.push(sessionId);
      targetPane.activeSessionId = sessionId;

      return {
        sessions: newSessions,
        activeSessionId: sessionId,
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId: targetPane.id,
      };
    });

    // WorkspaceTabBar uses a separate order list; keep it in sync.
    // 多窗口隔离：standalone 窗口不应影响主窗口的 workspace tab 顺序（文档 tabs 也依赖该顺序）。
    useWorkspaceTabStore.getState().upsertChatTab(sessionId);

    // Workspace panes: ensure the new session is visible as a tab in the focused pane.
    useWindowLayoutStore.getState().openTabInFocusedPane(chatTabId(sessionId));

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
    clearQueuedMessagesForSession(sessionId);

    // Remove session from state
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);

      let nextPanes = ensureAtLeastOnePane(state.panes ?? []).map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));

      let removedPaneIndex = -1;
      let removedIndexInPane = -1;
      for (let i = 0; i < nextPanes.length; i++) {
        const idx = nextPanes[i]!.sessionIds.indexOf(sessionId);
        if (idx >= 0) {
          removedPaneIndex = i;
          removedIndexInPane = idx;
          nextPanes[i]!.sessionIds.splice(idx, 1);
          break;
        }
      }

      if (removedPaneIndex >= 0) {
        const pane = nextPanes[removedPaneIndex]!;
        if (pane.activeSessionId === sessionId) {
          pane.activeSessionId =
            pane.sessionIds.length > 0
              ? pane.sessionIds[Math.min(removedIndexInPane, pane.sessionIds.length - 1)]!
              : null;
        }
        // 空 pane 且存在其它 pane 时，自动移除（避免出现“空分屏”）
        if (pane.sessionIds.length === 0 && nextPanes.length > 1) {
          nextPanes.splice(removedPaneIndex, 1);
        }
      }

      // 修复各 pane 的 activeSessionId（防御：确保在本 pane 内）
      nextPanes = ensureAtLeastOnePane(nextPanes).map((p) => {
        if (p.activeSessionId && !p.sessionIds.includes(p.activeSessionId)) {
          return { ...p, activeSessionId: p.sessionIds[0] ?? null };
        }
        if (!p.activeSessionId && p.sessionIds.length > 0) {
          return { ...p, activeSessionId: p.sessionIds[0]! };
        }
        return p;
      });

      let focusedPaneId = state.focusedPaneId;
      if (!focusedPaneId || !nextPanes.some((p) => p.id === focusedPaneId)) {
        const fallbackIndex =
          removedPaneIndex >= 0 ? Math.min(removedPaneIndex, nextPanes.length - 1) : 0;
        focusedPaneId = nextPanes[fallbackIndex]!.id;
      }

      const focusedPane = nextPanes.find((p) => p.id === focusedPaneId) ?? nextPanes[0]!;

      // 兼容旧字段：全局 activeSessionId 代表“当前聚焦 pane 的 active tab”
      let newActiveId: string | null = focusedPane.activeSessionId;
      if (newActiveId && !newSessions.has(newActiveId)) {
        newActiveId = null;
      }
      if (!newActiveId) {
        for (const p of nextPanes) {
          const candidate = p.activeSessionId ?? p.sessionIds[0] ?? null;
          if (candidate && newSessions.has(candidate)) {
            newActiveId = candidate;
            break;
          }
        }
      }

      return {
        sessions: newSessions,
        activeSessionId: newActiveId,
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId,
      };
    });

    useWorkspaceTabStore.getState().removeChatTab(sessionId);

    // Save state after closing session
    get().saveSessionState();
  },

  dockSessionToWindow: async (sessionId: string, targetWindowLabel: string, placement: ChatDockPlacement = 'tab') => {
    const session = get().sessions.get(sessionId);
    if (!session) return;
    if (session.isGenerating) {
      throw new Error('流式生成中，暂不支持停靠');
    }
    if (!session.conversationId) {
      throw new Error('对话尚未初始化，无法停靠');
    }

    await dockConversationToWindow(session.conversationId, targetWindowLabel, placement, {
      runMode: session.runMode,
      agentName: session.agentName,
    });
    await get().closeSession(sessionId);

    if (isStandaloneWindow() && get().sessions.size === 0) {
      try {
        await closeCurrentWindow();
      } catch {
        // ignore
      }
    }
  },

  /**
   * Switch to a different session
   * Requirements: 2.2
   */
  switchSession: (sessionId: string) => {
    const { sessions } = get();
    if (!sessions.has(sessionId)) return;

    const startedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    markChatOpenProfile('sessionStore:switchSession:start', { sessionId });

    set((state) => {
      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));

      const paneIndex = findPaneIndexBySessionId(nextPanes, sessionId);
      if (paneIndex >= 0) {
        nextPanes[paneIndex]!.activeSessionId = sessionId;
      }

      const focusedPaneId =
        paneIndex >= 0 ? nextPanes[paneIndex]!.id : state.focusedPaneId ?? nextPanes[0]!.id;

      return {
        activeSessionId: sessionId,
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId,
      };
    });

    const afterSetActiveAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    markChatOpenProfile('sessionStore:switchSession:after_set_active', {
      sessionId,
      meta: { deltaMs: Number((afterSetActiveAt - startedAt).toFixed(1)) },
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

    const afterLastActiveAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    markChatOpenProfile('sessionStore:switchSession:after_update_lastActiveAt', {
      sessionId,
      meta: { deltaMs: Number((afterLastActiveAt - startedAt).toFixed(1)) },
    });

    // Save state after switching
    const beforeSaveAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    get().saveSessionState();
    const afterSaveAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    markChatOpenProfile('sessionStore:switchSession:after_save', {
      sessionId,
      meta: {
        deltaMs: Number((afterSaveAt - startedAt).toFixed(1)),
        saveMs: Number((afterSaveAt - beforeSaveAt).toFixed(1)),
      },
    });
  },

  acknowledgeUnreadCompletion: (sessionId: string) => {
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return {};
      if (!session.hasUnreadCompletion) return {};
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, {
        ...session,
        hasUnreadCompletion: false,
        unreadCompletionMessageId: null,
      });
      return { sessions: newSessions };
    });
    void syncUnreadCompletionBadge(countUnreadCompletions(get().sessions));
  },

  /**
   * Close all sessions except the specified one
   * Requirements: 2.1, 2.2
   */
  closeOtherSessions: (keepSessionId: string) => {
    const { sessions, panes } = get();
    if (!sessions.has(keepSessionId)) return;

    const paneIndex = findPaneIndexBySessionId(panes ?? [], keepSessionId);
    if (paneIndex < 0) return;

    const toClose = panes[paneIndex]!.sessionIds.filter((id) => id !== keepSessionId);
    for (const id of toClose) clearQueuedMessagesForSession(id);

    set((state) => {
      const newSessions = new Map(state.sessions);
      for (const id of toClose) newSessions.delete(id);

      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const targetPaneId = state.panes?.[paneIndex]?.id ?? basePanes[paneIndex]?.id ?? null;
      const nextPanes = basePanes.map((p) => {
        const isTarget = targetPaneId ? p.id === targetPaneId : false;
        return {
          ...p,
          sessionIds: isTarget ? [keepSessionId] : p.sessionIds.filter((sid) => newSessions.has(sid)),
          activeSessionId: isTarget ? keepSessionId : p.activeSessionId,
        };
      });

      const sanitized = sanitizePanesForSessions(nextPanes, newSessions);
      const focusedPaneId =
        sanitized.panes.find((p) => p.sessionIds.includes(keepSessionId))?.id ??
        state.focusedPaneId ??
        sanitized.panes[0]!.id;

      return {
        sessions: newSessions,
        panes: sanitized.panes,
        focusedPaneId,
        activeSessionId: keepSessionId,
      };
    });

    for (const id of toClose) {
      useWorkspaceTabStore.getState().removeChatTab(id);
    }

    get().saveSessionState();
  },

  /**
   * Close all sessions to the left of the specified session
   * Requirements: 3.1, 3.3
   */
  closeSessionsToLeft: (sessionId: string) => {
    const { sessions, panes, activeSessionId } = get();
    if (!sessions.has(sessionId)) return;

    const paneIndex = findPaneIndexBySessionId(panes ?? [], sessionId);
    if (paneIndex < 0) return;

    const pane = panes[paneIndex]!;
    const targetIndex = pane.sessionIds.indexOf(sessionId);
    if (targetIndex <= 0) return;

    const toClose = pane.sessionIds.slice(0, targetIndex);
    for (const id of toClose) clearQueuedMessagesForSession(id);

    set((state) => {
      const newSessions = new Map(state.sessions);
      for (const id of toClose) newSessions.delete(id);

      const nextPanes = ensureAtLeastOnePane(state.panes ?? []).map((p) => {
        if (p.id !== pane.id) {
          return {
            ...p,
            sessionIds: p.sessionIds.filter((id) => newSessions.has(id)),
          };
        }

        const kept = p.sessionIds.filter((id) => id === sessionId || !toClose.includes(id));
        const nextActive =
          p.activeSessionId && newSessions.has(p.activeSessionId)
            ? p.activeSessionId
            : sessionId;
        return {
          ...p,
          sessionIds: kept,
          activeSessionId: nextActive,
        };
      });

      let newActiveId = activeSessionId;
      if (newActiveId && !newSessions.has(newActiveId)) newActiveId = sessionId;

      const sanitized = sanitizePanesForSessions(nextPanes, newSessions);
      return {
        sessions: newSessions,
        panes: sanitized.panes,
        activeSessionId: newActiveId,
      };
    });

    for (const id of toClose) {
      useWorkspaceTabStore.getState().removeChatTab(id);
    }

    get().saveSessionState();
  },

  /**
   * Close all sessions to the right of the specified session
   * Requirements: 4.1, 4.3
   */
  closeSessionsToRight: (sessionId: string) => {
    const { sessions, panes, activeSessionId } = get();
    if (!sessions.has(sessionId)) return;

    const paneIndex = findPaneIndexBySessionId(panes ?? [], sessionId);
    if (paneIndex < 0) return;

    const pane = panes[paneIndex]!;
    const targetIndex = pane.sessionIds.indexOf(sessionId);
    if (targetIndex < 0 || targetIndex >= pane.sessionIds.length - 1) return;

    const toClose = pane.sessionIds.slice(targetIndex + 1);
    for (const id of toClose) clearQueuedMessagesForSession(id);

    set((state) => {
      const newSessions = new Map(state.sessions);
      for (const id of toClose) newSessions.delete(id);

      const nextPanes = ensureAtLeastOnePane(state.panes ?? []).map((p) => {
        if (p.id !== pane.id) {
          return {
            ...p,
            sessionIds: p.sessionIds.filter((id) => newSessions.has(id)),
          };
        }

        const kept = p.sessionIds.filter((id) => !toClose.includes(id));
        const nextActive =
          p.activeSessionId && newSessions.has(p.activeSessionId)
            ? p.activeSessionId
            : sessionId;
        return {
          ...p,
          sessionIds: kept,
          activeSessionId: nextActive,
        };
      });

      let newActiveId = activeSessionId;
      if (newActiveId && !newSessions.has(newActiveId)) newActiveId = sessionId;

      const sanitized = sanitizePanesForSessions(nextPanes, newSessions);
      return {
        sessions: newSessions,
        panes: sanitized.panes,
        activeSessionId: newActiveId,
      };
    });

    for (const id of toClose) {
      useWorkspaceTabStore.getState().removeChatTab(id);
    }

    get().saveSessionState();
  },

  setFocusedPane: (paneId: string) => {
    set((state) => {
      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));

      const idx = nextPanes.findIndex((p) => p.id === paneId);
      if (idx < 0) return {};

      const pane = nextPanes[idx]!;
      if (pane.activeSessionId && !pane.sessionIds.includes(pane.activeSessionId)) {
        pane.activeSessionId = pane.sessionIds[0] ?? null;
      }
      if (!pane.activeSessionId && pane.sessionIds.length > 0) {
        pane.activeSessionId = pane.sessionIds[0]!;
      }

      return {
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId: pane.id,
        activeSessionId: pane.activeSessionId ?? null,
      };
    });
    void get().saveSessionState();
  },

  setActiveSessionInPane: (paneId: string, sessionId: string) => {
    if (!get().sessions.has(sessionId)) return;
    set((state) => {
      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));
      const idx = nextPanes.findIndex((p) => p.id === paneId);
      if (idx < 0) return {};
      const pane = nextPanes[idx]!;
      if (!pane.sessionIds.includes(sessionId)) return {};
      pane.activeSessionId = sessionId;

      const isFocused = (state.focusedPaneId ?? nextPanes[0]!.id) === paneId;
      return {
        panes: normalizePaneWeights(nextPanes),
        activeSessionId: isFocused ? sessionId : state.activeSessionId,
      };
    });
    void get().saveSessionState();
  },

  reorderSessionInPane: (paneId: string, activeSessionId: string, overSessionId: string) => {
    set((state) => {
      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));
      const idx = nextPanes.findIndex((p) => p.id === paneId);
      if (idx < 0) return {};
      const pane = nextPanes[idx]!;
      const oldIndex = pane.sessionIds.indexOf(activeSessionId);
      const newIndex = pane.sessionIds.indexOf(overSessionId);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return {};
      pane.sessionIds = arrayMove(pane.sessionIds, oldIndex, newIndex);
      return { panes: normalizePaneWeights(nextPanes) };
    });
    void get().saveSessionState();
  },

  moveSessionToPane: (sessionId: string, toPaneId: string, toIndex?: number) => {
    if (!get().sessions.has(sessionId)) return;
    set((state) => {
      let nextPanes: SessionPane[] = ensureAtLeastOnePane(state.panes ?? []).map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));

      // 1) 从原 pane 移除
      for (const p of nextPanes) {
        const idx = p.sessionIds.indexOf(sessionId);
        if (idx < 0) continue;
        p.sessionIds.splice(idx, 1);
        if (p.activeSessionId === sessionId) {
          p.activeSessionId = p.sessionIds[0] ?? null;
        }
      }

      // 2) 移除空 pane（但至少保留一个）
      nextPanes = nextPanes.filter((p) => p.sessionIds.length > 0 || nextPanes.length === 1);
      nextPanes = ensureAtLeastOnePane(nextPanes);

      // 3) 插入到目标 pane
      const targetIdx = nextPanes.findIndex((p) => p.id === toPaneId);
      if (targetIdx < 0) return {};
      const targetPane = nextPanes[targetIdx]!;

      const insertIndex = (() => {
        const raw = toIndex ?? targetPane.sessionIds.length;
        return Math.max(0, Math.min(raw, targetPane.sessionIds.length));
      })();

      if (!targetPane.sessionIds.includes(sessionId)) {
        targetPane.sessionIds.splice(insertIndex, 0, sessionId);
      }
      targetPane.activeSessionId = sessionId;

      // 目标 pane 变为焦点
      return {
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId: targetPane.id,
        activeSessionId: sessionId,
      };
    });
    void get().saveSessionState();
  },

  splitSessionToNewPane: (sessionId: string, direction: 'left' | 'right', targetPaneId: string) => {
    if (!get().sessions.has(sessionId)) return;

    set((state) => {
      let nextPanes: SessionPane[] = ensureAtLeastOnePane(state.panes ?? []).map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));

      // 从任意 pane 移除该 session
      for (const p of nextPanes) {
        const idx = p.sessionIds.indexOf(sessionId);
        if (idx < 0) continue;
        p.sessionIds.splice(idx, 1);
        if (p.activeSessionId === sessionId) {
          p.activeSessionId = p.sessionIds[0] ?? null;
        }
      }

      // 清理空 pane（但至少保留一个）
      nextPanes = nextPanes.filter((p) => p.sessionIds.length > 0 || nextPanes.length === 1);
      nextPanes = ensureAtLeastOnePane(nextPanes);

      const targetIndex = Math.max(0, nextPanes.findIndex((p) => p.id === targetPaneId));
      const targetPane = nextPanes[targetIndex] ?? nextPanes[0]!;

      const baseWeight = Number.isFinite(targetPane.weight) && targetPane.weight > 0 ? targetPane.weight : 1;
      const newPaneWeight = Math.max(0.4, baseWeight / 2);
      targetPane.weight = Math.max(0.4, baseWeight - newPaneWeight);

      const newPane: SessionPane = {
        id: crypto.randomUUID(),
        sessionIds: [sessionId],
        activeSessionId: sessionId,
        weight: newPaneWeight,
      };

      const insertAt = direction === 'left' ? targetIndex : targetIndex + 1;
      nextPanes.splice(insertAt, 0, newPane);

      return {
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId: newPane.id,
        activeSessionId: sessionId,
      };
    });

    void get().saveSessionState();
  },

  closePaneAndMerge: (paneId: string) => {
    set((state) => {
      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      if (basePanes.length <= 1) return {};

      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds],
      }));

      const idx = nextPanes.findIndex((p) => p.id === paneId);
      if (idx < 0) return {};

      const closing = nextPanes[idx]!;
      const targetIdx = idx < nextPanes.length - 1 ? idx + 1 : idx - 1;
      const target = nextPanes[targetIdx]!;

      // 合并 tabs：追加到目标 pane 的末尾（保留目标 pane 当前 active）
      for (const sid of closing.sessionIds) {
        if (!target.sessionIds.includes(sid)) {
          target.sessionIds.push(sid);
        }
      }

      target.weight = (Number.isFinite(target.weight) ? target.weight : 1) + (Number.isFinite(closing.weight) ? closing.weight : 1);
      if (target.activeSessionId && !target.sessionIds.includes(target.activeSessionId)) {
        target.activeSessionId = target.sessionIds[0] ?? null;
      }
      if (!target.activeSessionId && target.sessionIds.length > 0) {
        target.activeSessionId = target.sessionIds[0]!;
      }

      nextPanes.splice(idx, 1);

      let focusedPaneId = state.focusedPaneId;
      if (focusedPaneId === paneId) focusedPaneId = target.id;
      if (!focusedPaneId || !nextPanes.some((p) => p.id === focusedPaneId)) {
        focusedPaneId = nextPanes[0]!.id;
      }
      const focusedPane = nextPanes.find((p) => p.id === focusedPaneId) ?? nextPanes[0]!;

      return {
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId,
        activeSessionId: focusedPane.activeSessionId ?? null,
      };
    });
    void get().saveSessionState();
  },

  setPaneWeights: (weights) => {
    if (!Array.isArray(weights) || weights.length === 0) return;
    set((state) => {
      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const map = new Map(weights.map((w) => [w.paneId, w.weight] as const));
      const nextPanes: SessionPane[] = basePanes.map((p) => {
        const next = map.get(p.id);
        if (next === undefined) return p;
        return {
          ...p,
          weight: Number.isFinite(next) && next > 0 ? next : p.weight,
        };
      });
      return { panes: normalizePaneWeights(nextPanes) };
    });
  },

  sanitizeLayoutState: () => {
    set((state) => {
      const sanitized = sanitizePanesForSessions(state.panes ?? [], state.sessions);
      if (!sanitized.changed) return {};

      let focusedPaneId = state.focusedPaneId;
      if (!focusedPaneId || !sanitized.panes.some((p) => p.id === focusedPaneId)) {
        const idx = state.activeSessionId ? findPaneIndexBySessionId(sanitized.panes, state.activeSessionId) : -1;
        focusedPaneId = idx >= 0 ? sanitized.panes[idx]!.id : sanitized.panes[0]!.id;
      }

      const focusedPane = sanitized.panes.find((p) => p.id === focusedPaneId) ?? sanitized.panes[0]!;
      const activeSessionId = focusedPane.activeSessionId ?? focusedPane.sessionIds[0] ?? null;

      return {
        panes: sanitized.panes,
        focusedPaneId,
        activeSessionId,
      };
    });
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

    if (session.isGenerating) {
      enqueueQueuedMessage(sessionId, content, thinking, images);
      return;
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
          streamingAssistantMessageId: null,
          error: null,
          lastActiveAt: new Date().toISOString(),
        });
      }
      return { sessions: newSessions };
    });

    try {
      const debugMode = useConfigStore.getState().config?.general?.debugMode ?? false;
      // Ensure any debounced config edits are persisted before the backend reads config for this run.
      // (e.g. user edits agent/provider settings and immediately sends a message)
      await useConfigStore.getState().flushConfigSaves?.();
      await invoke('run_task', {
        conversationId: session.conversationId,
        messageId: userMessage.id,
        content,
        contentParts: contentParts.length > 0 ? contentParts : undefined,
        agentName: session.agentName,
        modelRef: session.modelRef,
        runMode: session.runMode,
        thinking,  // 直接传递 thinking，可以是 boolean 或 string
        webSearchProvider: session.webSearchProvider,  // 传递 web search provider
        debugMode,
      });
    } catch (err) {
      get().handleError(sessionId, (err as any).message || String(err));
    } finally {
      void drainQueuedMessages(sessionId);
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
            streamingAssistantMessageId: null,
          });
        }
        return { sessions: newSessions };
      });

      // 丢弃节流队列里尚未 flush 的 token，避免中止后“复活” UI
      clearPendingChunks(sessionId);
      clearTurnIndexesForSession(sessionId);
    } catch (error) {
      console.error('Failed to abort generation:', error);
    } finally {
      void drainQueuedMessages(sessionId);
    }
  },

  /**
   * Retry a message in a specific session
   */
  retry: async (sessionId: string, messageId: string) => {
    const session = get().sessions.get(sessionId);
    if (!session) return;

    const { messages } = session;
    const assistantIndex = messages.findIndex((m) => m.id === messageId);
    if (assistantIndex === -1) return;

    // 语义对齐 Codex：重试 assistant 回复时，先回滚“该轮 user+assistant”（删除该 user 消息起的全部后续），再重新发送该 user 输入。
    // 这样避免“重复插入相同 user 消息/后端上下文不一致”的问题。
    let userMsg: Message | undefined;
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userMsg = messages[i];
        break;
      }
    }
    if (!userMsg) return;

    const partsToResend = userMsg.contentParts?.filter((p) => p.type !== 'text') ?? [];

    const thinkingMode = session.thinkingMode;
    const thinkingParam: boolean | string | undefined =
      thinkingMode === undefined ? undefined : thinkingMode === null ? false : thinkingMode;

    get().undoToMessage(sessionId, userMsg.id);
    await get().sendMessage(sessionId, userMsg.content, thinkingParam, partsToResend);
  },

  /**
   * Retry a specific internal turn (replay context before that turn)
   */
  retryTurn: async (sessionId: string, assistantMessageId: string, turnId: string) => {
    // Wait for any pending undo operations to complete first
    await pendingUndoOperation;

    const session = get().sessions.get(sessionId);
    if (!session?.conversationId) return;

    if (session.isGenerating) {
      await get().abortGeneration(sessionId);
    }

    discardNextFinalizeByConversationId.delete(session.conversationId);
    clearTurnIndexesForSession(sessionId);

    set((state) => {
      const newSessions = new Map(state.sessions);
      const currentSession = newSessions.get(sessionId);
      if (currentSession) {
        // Business semantics:
        // - Retry from a specific internal turn should *rewind* the assistant bubble to that turn,
        //   removing later turns, and also remove all subsequent messages/tasks in the conversation.
        let nextMessages = currentSession.messages;
        const assistantIndex = currentSession.messages.findIndex((m) => m.id === assistantMessageId);
        if (assistantIndex !== -1) {
          const assistant = currentSession.messages[assistantIndex];
          const turnIndexById = new Map<string, number>(
            (assistant.turns ?? []).map((t) => [t.turnId, t.turnIndex])
          );
          const targetTurnIndex =
            assistant.turns?.find((t) => t.turnId === turnId)?.turnIndex ??
            assistant.blocks?.find((b: any) => b?.turnId === turnId && typeof b?.turnIndex === 'number')?.turnIndex ??
            1;

          const trimmedTurns = assistant.turns?.filter((t) => t.turnIndex < targetTurnIndex);
          const trimmedBlocks = assistant.blocks?.filter((b: any) => {
            const idx =
              typeof b?.turnIndex === 'number'
                ? b.turnIndex
                : typeof b?.turnId === 'string'
                  ? turnIndexById.get(b.turnId)
                  : undefined;
            return typeof idx === 'number' ? idx < targetTurnIndex : false;
          });

          const trimmedAssistant: Message = {
            ...assistant,
            // Avoid showing legacy final content after rewind.
            content: '',
            thinking: undefined,
            blocks: trimmedBlocks && trimmedBlocks.length > 0 ? trimmedBlocks : undefined,
            turns: trimmedTurns && trimmedTurns.length > 0 ? trimmedTurns : undefined,
          };

          nextMessages = currentSession.messages.slice(0, assistantIndex + 1);
          nextMessages[assistantIndex] = trimmedAssistant;
        }

        newSessions.set(sessionId, {
          ...currentSession,
          messages: nextMessages,
          isGenerating: true,
          streamingBlocks: [],
          streamingTurns: new Map(),
          streamingAssistantMessageId: assistantMessageId,
          error: null,
          lastActiveAt: new Date().toISOString(),
        });
      }
      return { sessions: newSessions };
    });

    try {
      const debugMode = useConfigStore.getState().config?.general?.debugMode ?? false;
      await useConfigStore.getState().flushConfigSaves?.();

      const thinkingMode = session.thinkingMode;
      const thinkingParam: boolean | string | undefined =
        thinkingMode === undefined ? undefined : thinkingMode === null ? false : thinkingMode;

      await invoke('retry_turn', {
        conversationId: session.conversationId,
        assistantMessageId,
        turnId,
        agentName: session.agentName,
        modelRef: session.modelRef,
        runMode: session.runMode,
        thinking: thinkingParam,
        webSearchProvider: session.webSearchProvider,
        debugMode,
      });
    } catch (err) {
      get().handleError(sessionId, (err as any).message || String(err));
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

  moveQueuedMessage: (sessionId: string, messageId: string, direction: 'up' | 'down') => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};
      const queue = session.queuedMessages ?? [];
      const currentIndex = queue.findIndex((item) => item.id === messageId);
      if (currentIndex === -1) return {};
      const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= queue.length) return {};
      const nextQueue = queue.slice();
      const [item] = nextQueue.splice(currentIndex, 1);
      nextQueue.splice(targetIndex, 0, item);
      newSessions.set(sessionId, {
        ...session,
        queuedMessages: nextQueue,
      });
      return { sessions: newSessions };
    });
  },

  removeQueuedMessage: (sessionId: string, messageId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};
      const queue = session.queuedMessages ?? [];
      const nextQueue = queue.filter((item) => item.id !== messageId);
      if (nextQueue.length === queue.length) return {};
      newSessions.set(sessionId, {
        ...session,
        queuedMessages: nextQueue,
      });
      return { sessions: newSessions };
    });
  },

  updateQueuedMessageContent: (sessionId: string, messageId: string, content: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};
      const queue = session.queuedMessages ?? [];
      const idx = queue.findIndex((item) => item.id === messageId);
      if (idx === -1) return {};
      const nextQueue = queue.slice();
      const current = nextQueue[idx]!;
      if (current.content === content) return {};
      nextQueue[idx] = { ...current, content };
      newSessions.set(sessionId, {
        ...session,
        queuedMessages: nextQueue,
      });
      return { sessions: newSessions };
    });
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
    const stateBeforeFinalize = get();
    const session = stateBeforeFinalize.sessions.get(sessionId);
    if (!session?.conversationId) return;
    const config = useConfigStore.getState().config;
    const shouldNotify = shouldDispatchCompletionNotification(stateBeforeFinalize, sessionId);

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

    const resolvedAssistantMessageId = assistantMessageId || crypto.randomUUID();
    const assistantMessage: Message = {
      id: resolvedAssistantMessageId,
      conversationId: session.conversationId,
      role: 'assistant',
      content: finalContent,
      thinking: finalThinking,
      source: 'live',
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
	        const hasUnreadCompletion = true;
	        // Find the last pending user message and mark as success
	        const updatedMessages = [...currentSession.messages];
	        for (let i = updatedMessages.length - 1; i >= 0; i--) {
	          if (updatedMessages[i].role === 'user' && updatedMessages[i].status === 'pending') {
	            updatedMessages[i] = { ...updatedMessages[i], status: 'success' };
            break;
          }
        }

        const existingIndex = updatedMessages.findIndex((m) => m.id === resolvedAssistantMessageId);
        const existing = existingIndex !== -1 ? updatedMessages[existingIndex] : null;

        const mergedBlocks = (() => {
          const out: MessageBlock[] = [];
          const seen = new Set<string>();
          const prefix = existing?.blocks ?? [];
          const next = assistantMessage.blocks ?? [];
          for (const b of [...prefix, ...next]) {
            if (!seen.has(b.id)) {
              seen.add(b.id);
              out.push(b);
            }
          }
          return out.length > 0 ? out : undefined;
        })();

        const mergedTurns = (() => {
          const out: MessageTurn[] = [];
          const seen = new Set<string>();
          const prefix = existing?.turns ?? [];
          const next = assistantMessage.turns ?? [];
          for (const t of [...prefix, ...next]) {
            if (!seen.has(t.turnId)) {
              seen.add(t.turnId);
              out.push(t);
            }
          }
          out.sort((a, b) => a.turnIndex - b.turnIndex);
          return out.length > 0 ? out : undefined;
        })();

        const mergedAssistant: Message = existing
          ? {
            ...assistantMessage,
            // Keep original timestamp to avoid reordering in UI.
            createdAt: existing.createdAt,
            blocks: mergedBlocks,
            turns: mergedTurns,
          }
          : {
            ...assistantMessage,
            blocks: mergedBlocks,
            turns: mergedTurns,
          };

        const nextMessages =
          existingIndex !== -1
            ? (() => {
              const copy = updatedMessages.slice();
              copy[existingIndex] = mergedAssistant;
              return copy;
            })()
            : [...updatedMessages, mergedAssistant];

	        newSessions.set(sessionId, {
	          ...currentSession,
	          messages: nextMessages,
	          streamingBlocks: null,
	          streamingTurns: undefined,
	          streamingAssistantMessageId: null,
	          isGenerating: false,
	          lastActiveAt: new Date().toISOString(),
	          hasUnreadCompletion,
	          unreadCompletionMessageId: hasUnreadCompletion ? resolvedAssistantMessageId : null,
	        });
	      }
	      return { sessions: newSessions };
	    });

    void syncUnreadCompletionBadge(countUnreadCompletions(get().sessions));
    if (shouldNotify) {
      void notifyTaskCompletion(
        {
          kind: 'success',
          sessionTitle: session.title,
          agentName: session.agentName,
          previewText: finalContent || finalThinking || '任务已经完成。',
        },
        config
      );
    }

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
    void drainQueuedMessages(sessionId);
  },

  /**
   * Handle error in a session
   * Requirements: 7.4
   */
  handleError: (sessionId: string, error: string, debugInfo?: DebugInfo, turnId?: string, assistantMessageId?: string) => {
    const stateBeforeError = get();
    const session = stateBeforeError.sessions.get(sessionId);
    if (!session?.conversationId) return;
    const config = useConfigStore.getState().config;
    const shouldNotify = shouldDispatchCompletionNotification(stateBeforeError, sessionId);

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
	      const hasUnreadCompletion = true;

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

    // ---------------------------------------------------------------------
    // Global error exposure (avoid "black-box" failures like `openai_error`)
    // ---------------------------------------------------------------------
    try {
      const cfg = useConfigStore.getState().config;
      const strict = cfg?.strictErrorMode === true;

      const trimmed = (error ?? '').trim();
      const looksLikeCodeToken = /^[a-z0-9][a-z0-9_\-]*$/i.test(trimmed) && !/\s/.test(trimmed);
      const looksLikeBareErrorCode =
        looksLikeCodeToken &&
        trimmed.length > 0 &&
        trimmed.length <= 64 &&
        (trimmed.toLowerCase().endsWith('_error') || trimmed.toLowerCase().endsWith('_failed'));

      const shouldPopup = strict || looksLikeBareErrorCode;
      if (shouldPopup) {
        const di =
          debugInfo ??
          (resolvedTurnId
            ? turnsSorted?.find((t) => t.turnId === resolvedTurnId)?.debugInfo
            : undefined);

        const requestLine = di?.request?.url
          ? `${di?.request?.method ? `${di.request.method} ` : ''}${di.request.url}`.trim()
          : null;
        const httpLine = typeof di?.response?.status === 'number' ? `HTTP ${di.response.status}` : null;

        const lines: string[] = [];
        lines.push(`- conversationId: ${session.conversationId}`);
        if (resolvedTurnId) lines.push(`- turnId: ${resolvedTurnId}`);
        if (typeof resolvedTurnIndex === 'number') lines.push(`- turnIndex: ${resolvedTurnIndex}`);
        if (lastModel) lines.push(`- model: ${lastModel}`);
        if (requestLine) lines.push(`- request: ${requestLine}`);
        if (httpLine) lines.push(`- ${httpLine}`);

        const modalMessage = [
          trimmed || error,
          '',
          '上下文：',
          ...(lines.length > 0 ? lines : ['- （无）']),
          '',
          '提示：点击消息右侧 Debug 可查看更完整的请求/响应与工具过程。',
        ].join('\n');

        void showGlobalError('任务失败', modalMessage);
      }
    } catch {
      // ignore
    }

    const resolvedAssistantMessageId = assistantMessageId || crypto.randomUUID();
    const assistantMessage: Message = {
      id: resolvedAssistantMessageId,
      conversationId: currentSession.conversationId || '',
      role: 'assistant',
        content: '',
        source: 'live',
        blocks: blocks.length > 0 ? blocks : undefined,
        meta: lastModel ? { model: lastModel } : undefined,
        debugInfo,
        turns: mergedTurns,
        status: 'failed',
        error,
        createdAt: new Date().toISOString(),
      };

      const existingIndex = updatedMessages.findIndex((m) => m.id === resolvedAssistantMessageId);
      const existing = existingIndex !== -1 ? updatedMessages[existingIndex] : null;

      const mergedBlocks = (() => {
        const out: MessageBlock[] = [];
        const seen = new Set<string>();
        const prefix = existing?.blocks ?? [];
        const next = assistantMessage.blocks ?? [];
        for (const b of [...prefix, ...next]) {
          if (!seen.has(b.id)) {
            seen.add(b.id);
            out.push(b);
          }
        }
        return out.length > 0 ? out : undefined;
      })();

      const mergedTurnsOut = (() => {
        const out: MessageTurn[] = [];
        const seen = new Set<string>();
        const prefix = existing?.turns ?? [];
        const next = assistantMessage.turns ?? [];
        for (const t of [...prefix, ...next]) {
          if (!seen.has(t.turnId)) {
            seen.add(t.turnId);
            out.push(t);
          }
        }
        out.sort((a, b) => a.turnIndex - b.turnIndex);
        return out.length > 0 ? out : undefined;
      })();

      const mergedAssistant: Message = existing
        ? {
          ...assistantMessage,
          createdAt: existing.createdAt,
          blocks: mergedBlocks,
          turns: mergedTurnsOut,
        }
        : {
          ...assistantMessage,
          blocks: mergedBlocks,
          turns: mergedTurnsOut,
        };

      const nextMessages =
        existingIndex !== -1
          ? (() => {
            const copy = updatedMessages.slice();
            copy[existingIndex] = mergedAssistant;
            return copy;
          })()
          : [...updatedMessages, mergedAssistant];

	      newSessions.set(sessionId, {
	        ...currentSession,
	        messages: nextMessages,
	        error,
	        isGenerating: false,
	        streamingBlocks: null,
	        streamingTurns: undefined,
	        streamingAssistantMessageId: null,
	        hasUnreadCompletion,
	        unreadCompletionMessageId: hasUnreadCompletion ? resolvedAssistantMessageId : null,
	      });

      return { sessions: newSessions };
    });

    void syncUnreadCompletionBadge(countUnreadCompletions(get().sessions));
    if (shouldNotify) {
      void notifyTaskCompletion(
        {
          kind: 'failure',
          sessionTitle: session.title,
          agentName: session.agentName,
          previewText: error,
        },
        config
      );
    }

    clearTurnIndexesForSession(sessionId);
    void drainQueuedMessages(sessionId);
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
   * Update per-session run mode (chat/agent/full access)
   */
  setSessionRunMode: (sessionId: string, runMode: RunMode) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};

      newSessions.set(sessionId, {
        ...session,
        runMode,
        lastActiveAt: new Date().toISOString(),
      });

      return { sessions: newSessions };
    });

    get().saveSessionState();

    const session = get().sessions.get(sessionId);
    if (session?.conversationId) {
      invoke('update_conversation_metadata', {
        conversationId: session.conversationId,
        runMode,
      }).catch(console.error);

      void import('./conversationStore')
        .then(({ useConversationStore }) => {
          useConversationStore.getState().patchConversation(session.conversationId!, { runMode });
        })
        .catch(() => {});
    }
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
   * Update per-session web search provider selection
   */
  setSessionWebSearchProvider: (sessionId: string, provider: 'native' | 'tavily' | 'google' | 'brave' | null) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};

      newSessions.set(sessionId, {
        ...session,
        webSearchProvider: provider,
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

	  setSessionDraftWorkspaceMentions: (sessionId: string, mentions: WorkspaceMentionChip[]) => {
	    set((state) => {
	      const newSessions = new Map(state.sessions);
	      const session = newSessions.get(sessionId);
	      if (!session) return {};

	      const raw = Array.isArray(mentions) ? mentions : [];
	      const next: WorkspaceMentionChip[] = [];
	      const seen = new Set<string>();
	      for (const m of raw) {
	        const id = String(m?.id ?? '').trim();
	        const absPath = String(m?.absPath ?? '').trim();
	        const label = String(m?.label ?? '').trim();
	        if (!id || !absPath) continue;
	        if (seen.has(id)) continue;
	        seen.add(id);
	        next.push({ id, absPath, label: label || absPath.split('/').pop() || absPath });
	      }

	      newSessions.set(sessionId, {
	        ...session,
	        draftWorkspaceMentions: next,
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

	  setSessionDraftCodeSnippets: (sessionId: string, snippets: CodeSnippetContentPart[]) => {
	    set((state) => {
	      const newSessions = new Map(state.sessions);
	      const session = newSessions.get(sessionId);
      if (!session) return {};

      const next = Array.isArray(snippets) ? snippets.filter((s) => s?.type === 'code_snippet') : [];
      newSessions.set(sessionId, {
        ...session,
        draftCodeSnippets: next,
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

  setSessionTitle: (sessionId: string, title: string) => {
    const next = (title ?? '').trim();
    if (!next) return;

    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(sessionId);
      if (!session) return {};
      if (session.title === next) return {};
      newSessions.set(sessionId, { ...session, title: next });
      return { sessions: newSessions };
    });
  },

  syncConversationTitle: (conversationId: string, title: string) => {
    const cid = (conversationId ?? '').trim();
    const next = (title ?? '').trim();
    if (!cid || !next) return;

    set((state) => {
      let changed = false;
      const newSessions = new Map(state.sessions);
      for (const [sid, s] of newSessions.entries()) {
        if (s.conversationId === cid && s.title !== next) {
          newSessions.set(sid, { ...s, title: next });
          changed = true;
        }
      }
      return changed ? { sessions: newSessions } : {};
    });
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
		    const { sessions, activeSessionId, panes, focusedPaneId } = get();

		    const persistedSessions: PersistedSession[] = Array.from(sessions.values()).map((session) => {
		      const rawMentions = Array.isArray(session.draftWorkspaceMentions) ? session.draftWorkspaceMentions : [];
		      const draftWorkspaceMentions: WorkspaceMentionChip[] | undefined =
		        rawMentions.length > 0
		          ? rawMentions
		              .map((m) => ({
		                id: String(m?.id ?? '').trim(),
		                absPath: String(m?.absPath ?? '').trim(),
		                label: String(m?.label ?? '').trim(),
		              }))
		              .filter((m) => m.id && m.absPath)
		          : undefined;

		      const rawSnippets = Array.isArray(session.draftCodeSnippets) ? session.draftCodeSnippets : [];
		      let draftCodeSnippets: CodeSnippetContentPart[] | undefined;
		      if (rawSnippets.length > 0) {
		        let totalChars = 0;
	        const kept: CodeSnippetContentPart[] = [];
	        for (const s of rawSnippets) {
	          if (!s || s.type !== 'code_snippet') continue;
	          totalChars += typeof s.text === 'string' ? s.text.length : 0;
	          if (totalChars > MAX_PERSISTED_DRAFT_CODE_SNIPPET_CHARS) {
	            // 太大就不持久化，避免 localStorage 爆掉
	            kept.length = 0;
	            break;
	          }
	          kept.push(s);
	        }
	        if (kept.length > 0) {
	          draftCodeSnippets = kept;
	        }
	      }

	      return {
	        id: session.id,
	        agentName: session.agentName,
	        modelRef: session.modelRef,
	        conversationId: session.conversationId,
	        workstudioId: session.workstudioId ?? null,
	        apiType: session.apiType,
	        runMode: session.runMode,
		        thinkingMode: session.thinkingMode,
		        webSearchProvider: session.webSearchProvider,
		        draftContent: session.draftContent,
		        draftWorkspaceMentions,
		        draftCodeSnippets,
		        createdAt: session.createdAt,
		        lastActiveAt: session.lastActiveAt,
		      };
		    });

    const state: PersistedSessionState = {
      version: PERSISTENCE_VERSION,
      sessions: persistedSessions,
      activeSessionId,
      panes: normalizePaneWeights(ensureAtLeastOnePane(panes ?? [])).map((p) => ({
        id: p.id,
        sessionIds: [...p.sessionIds],
        activeSessionId: p.activeSessionId,
        weight: p.weight,
      })),
      focusedPaneId: focusedPaneId ?? null,
    };

    try {
      const storage = getSessionStateStorage();
      storage?.setItem(getSessionStateStorageKey(), JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save session state:', error);
    }
  },

  /**
   * Restore session state from localStorage
   * Requirements: 5.2, 5.3, 5.4, 5.5
   */
  restoreSessionState: async () => {
    const storage = getSessionStateStorage();
    const nextKey = getSessionStateStorageKey();
    let stored = storage?.getItem(nextKey) ?? null;
    let loadedFromLegacy = false;

    if (!stored && storage) {
      const label = getWindowLabelForStorage();
      if (isMainWindowLabel(label)) {
        stored = storage.getItem(LEGACY_SESSION_STORAGE_KEY);
        loadedFromLegacy = Boolean(stored);
      }
    }

    if (!stored) {
      set({ hydrated: true });
      return;
    }

    try {
      const canUseSharedWorkspaceTabs = true;
      const raw = JSON.parse(stored) as PersistedSessionState | null;
      const storedVersion = typeof raw?.version === 'number' ? raw.version : 1;
      const persistedSessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
      const storedActiveSessionId =
        typeof raw?.activeSessionId === 'string' || raw?.activeSessionId === null
          ? raw.activeSessionId
          : null;
      const storedPanes = Array.isArray(raw?.panes) ? raw.panes : null;
      const storedFocusedPaneId =
        typeof raw?.focusedPaneId === 'string' || raw?.focusedPaneId === null
          ? raw.focusedPaneId
          : null;

      // Get available agents from config
      const { useConfigStore } = await import('./configStore');
      const config = useConfigStore.getState().config;
      const availableAgents = config?.agents?.map(a => a.name) || [];
      const defaultAgent = config?.defaultAgent || availableAgents[0] || '';

      const newSessions = new Map<string, AgentSession>();

      for (const persisted of persistedSessions) {
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
        const defaultRunMode: RunMode =
          (agent?.type ?? 'chat') === 'tool' || (agent?.type ?? 'chat') === 'task_agent'
            ? 'agent'
            : 'chat';
        const runMode = persisted.runMode ?? defaultRunMode;

			        const session: AgentSession = {
			          id: persisted.id,
			          agentName,
			          title,
			          modelRef,
			          conversationId: persisted.conversationId,
			          workstudioId: persisted.workstudioId ?? convWorkstudioId,
			          apiType: apiProtocol,
			          runMode,
			          thinkingMode: coerceThinkingModeForProtocol(persisted.thinkingMode, apiProtocol, providerType),
			          webSearchProvider: persisted.webSearchProvider,
			          draftContent: persisted.draftContent ?? '',
			          draftWorkspaceMentions: Array.isArray(persisted.draftWorkspaceMentions)
			            ? persisted.draftWorkspaceMentions
			                .map((m) => ({
			                  id: String((m as any)?.id ?? '').trim(),
			                  absPath: String((m as any)?.absPath ?? '').trim(),
			                  label: String((m as any)?.label ?? '').trim(),
			                }))
			                .filter((m) => m.id && m.absPath)
			            : [],
			          draftCodeSnippets: Array.isArray(persisted.draftCodeSnippets)
			            ? persisted.draftCodeSnippets.filter((s) => s?.type === 'code_snippet')
			            : [],
			          messages,
		          queuedMessages: [],
		          streamingBlocks: null,
		          isGenerating: false,
		          error: null,
		          hasUnreadCompletion: false,
		          unreadCompletionMessageId: null,
		          createdAt: persisted.createdAt,
		          lastActiveAt: persisted.lastActiveAt,
		        };

        newSessions.set(session.id, session);
      }

      const allSessionIds = Array.from(newSessions.keys());

      // panes: v2 优先使用存储的 panes；v1 则降级为单 pane
      let panes: SessionPane[] = [];
      if (storedPanes && storedPanes.length > 0) {
        const assigned = new Set<string>();
        for (const p of storedPanes) {
          const paneId = typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID();
          const ids = Array.isArray(p.sessionIds)
            ? p.sessionIds.filter((sid) => typeof sid === 'string' && newSessions.has(sid) && !assigned.has(sid))
            : [];
          for (const sid of ids) assigned.add(sid);

          const active =
            typeof p.activeSessionId === 'string' && ids.includes(p.activeSessionId)
              ? p.activeSessionId
              : ids[0] ?? null;
          const weight = typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1;

          panes.push({
            id: paneId,
            sessionIds: ids,
            activeSessionId: active,
            weight,
          });
        }

        // 把未归属的 session 补到第一个 pane
        const unassigned = allSessionIds.filter((sid) => !assigned.has(sid));
        if (unassigned.length > 0) {
          if (panes.length === 0) {
            panes.push({ id: crypto.randomUUID(), sessionIds: [], activeSessionId: null, weight: 1 });
          }
          panes[0]!.sessionIds.push(...unassigned);
          if (!panes[0]!.activeSessionId) panes[0]!.activeSessionId = panes[0]!.sessionIds[0] ?? null;
        }

        // 清理空 pane（但至少保留一个）
        panes = panes.filter((p) => p.sessionIds.length > 0 || panes.length === 1);
      } else {
        // v1 迁移：尽量沿用全局 tabOrder 的 chat 顺序
        const orderedFromTabs: string[] = [];
        if (canUseSharedWorkspaceTabs) {
          for (const tid of useWorkspaceTabStore.getState().tabOrder) {
            if (typeof tid !== 'string') continue;
            if (!tid.startsWith('chat:')) continue;
            const sid = tid.slice('chat:'.length);
            if (!newSessions.has(sid)) continue;
            if (orderedFromTabs.includes(sid)) continue;
            orderedFromTabs.push(sid);
          }
        }

        const remaining = allSessionIds.filter((sid) => !orderedFromTabs.includes(sid));
        remaining.sort((a, b) => {
          const sa = newSessions.get(a);
          const sb = newSessions.get(b);
          const ta = sa ? new Date(sa.createdAt).getTime() : 0;
          const tb = sb ? new Date(sb.createdAt).getTime() : 0;
          return ta - tb;
        });

        const sessionIds = [...orderedFromTabs, ...remaining];

        panes = [
          {
            id: crypto.randomUUID(),
            sessionIds,
            activeSessionId: storedActiveSessionId && sessionIds.includes(storedActiveSessionId) ? storedActiveSessionId : sessionIds[0] ?? null,
            weight: 1,
          },
        ];
      }

      panes = normalizePaneWeights(ensureAtLeastOnePane(panes));

      // focused pane
      let focusedPaneId =
        storedFocusedPaneId && panes.some((p) => p.id === storedFocusedPaneId) ? storedFocusedPaneId : null;
      if (!focusedPaneId && storedActiveSessionId) {
        const idx = findPaneIndexBySessionId(panes, storedActiveSessionId);
        if (idx >= 0) focusedPaneId = panes[idx]!.id;
      }
      if (!focusedPaneId) focusedPaneId = panes[0]!.id;

      // global active session：代表“聚焦 pane 的 active tab”
      let activeSessionId: string | null =
        storedActiveSessionId && newSessions.has(storedActiveSessionId) ? storedActiveSessionId : null;
      if (!activeSessionId) {
        const fp = panes.find((p) => p.id === focusedPaneId) ?? panes[0]!;
        activeSessionId = fp.activeSessionId ?? fp.sessionIds[0] ?? null;
      }
      if (activeSessionId) {
        const idx = findPaneIndexBySessionId(panes, activeSessionId);
        if (idx >= 0) panes[idx]!.activeSessionId = activeSessionId;
      }

      set({
        sessions: newSessions,
        panes,
        focusedPaneId,
        activeSessionId,
        hydrated: true,
      });

      // App/session 启动阶段：预热 MCP（Codex-like），让后续 tool 注入走缓存而不是每次请求 tools/list。
      // Best-effort：不阻塞 UI hydration。
      invoke('warmup_mcp_servers').catch((e) => console.warn('warmup_mcp_servers failed:', e));

      if (loadedFromLegacy) {
        try {
          storage?.setItem(nextKey, stored);
        } catch {
          // ignore
        }
      }

      // 让全局 tabOrder（用于文档/历史）保持整洁：移除不存在的 chat
      if (canUseSharedWorkspaceTabs) {
        useWorkspaceTabStore
          .getState()
          .syncTabs(allSessionIds, useDocumentStore.getState().documents.map((d) => d.id), [], []);
      }

      if (storedVersion !== PERSISTENCE_VERSION) {
        console.info(`Session state migrated: v${storedVersion} -> v${PERSISTENCE_VERSION}`);
      }
    } catch (error) {
      console.error('Failed to restore session state:', error);
      set({ hydrated: true });
    }
  },

  /**
  * Open a historical conversation in a new session
  * Requirements: 8.1, 8.2, 8.3, 8.4
  */
  openHistoricalConversation: async (
    conversationId: string,
    opts?: { agentName?: string; runMode?: RunMode }
  ) => {
    markChatOpenProfile('sessionStore:openHistoricalConversation:enter', { conversationId });
    requestConversationScrollToBottomOnce(conversationId);
    const { sessions } = get();

    // Check if already open
    for (const session of sessions.values()) {
      if (session.conversationId === conversationId) {
        if (opts?.runMode && session.runMode !== opts.runMode) {
          get().setSessionRunMode(session.id, opts.runMode);
        }
        setChatOpenProfileTarget({ conversationId, sessionId: session.id });
        markChatOpenProfile('sessionStore:openHistoricalConversation:already_open', {
          conversationId,
          meta: { sessionId: session.id },
        });
        get().switchSession(session.id);
        useWindowLayoutStore.getState().openTabInFocusedPane(chatTabId(session.id));
        markChatOpenProfile('sessionStore:switchSession(done)', {
          conversationId,
          meta: { sessionId: session.id },
        });
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

    // Get agent name from conversation or use default (allow override from window docking/popout)
    const { useConfigStore } = await import('./configStore');
    const config = useConfigStore.getState().config;

    const availableAgents = config?.agents?.map((a) => a.name) || [];
    const defaultAgent = config?.defaultAgent || availableAgents[0] || '';

    let agentName = conversation?.agentName || defaultAgent || '';
    const requestedAgentName = (opts?.agentName ?? '').trim();
    if (requestedAgentName && availableAgents.includes(requestedAgentName)) {
      agentName = requestedAgentName;
    }
    if (!availableAgents.includes(agentName)) {
      agentName = defaultAgent;
    }

    const agent = useConfigStore.getState().getAgent(agentName);

    const modelRef = conversation?.modelRef || agent?.modelRef;
    const apiProtocol = modelRef && config ? getApiProtocol(modelRef, config.providers) : 'chat_completions';
    const providerType = modelRef && config ? getProviderType(modelRef, config.providers) : undefined;

    const agentType = agent?.type ?? 'chat';
    const toolLikeAgent = agentType === 'tool' || agentType === 'task_agent';
    const workspaceEnabled = toolLikeAgent && (agent?.workspaceSupport ?? true);
    const fallbackRunMode: RunMode = toolLikeAgent ? 'agent' : 'chat';
    const agentDefaultRunMode: RunMode = isRunMode(agent?.defaultRunMode) ? agent.defaultRunMode : fallbackRunMode;
    const runMode: RunMode = opts?.runMode ?? (isRunMode(conversation?.runMode) ? conversation.runMode : agentDefaultRunMode);

    let resolvedWorkstudioId: string | null = conversation?.workstudioId ?? null;
    if (workspaceEnabled) {
      try {
        markChatOpenProfile('sessionStore:ensure_workstudio_for_conversation:start', {
          conversationId,
        });
        const ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
        resolvedWorkstudioId = ws.id;
        markChatOpenProfile('sessionStore:ensure_workstudio_for_conversation:done', {
          conversationId,
          meta: { workstudioId: ws.id },
        });
      } catch (error) {
        console.warn('ensure_workstudio_for_conversation failed:', error);
        markChatOpenProfile('sessionStore:ensure_workstudio_for_conversation:failed', {
          conversationId,
        });
      }
    }

    // Load messages
    let messages: Message[] = [];
    try {
      markChatOpenProfile('sessionStore:get_messages:start', { conversationId, meta: { limit: 100 } });
      messages = hydrateMessagesFromBackend(
        await invoke<Message[]>('get_messages', {
          conversationId,
          limit: 100,
        })
      );
      markChatOpenProfile('sessionStore:get_messages:done', {
        conversationId,
        meta: { count: messages.length },
      });
    } catch (error) {
      console.error('Failed to load messages:', error);
      markChatOpenProfile('sessionStore:get_messages:failed', { conversationId });
    }

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    setChatOpenProfileTarget({ conversationId, sessionId });

    // Sync metadata to DB if missing in conversation (Lazy migration)
    if (!conversation?.agentName || !conversation?.modelRef || !conversation?.runMode) {
      invoke('update_conversation_metadata', {
        conversationId,
        agentName: !conversation?.agentName ? agentName : undefined,
        modelRef: !conversation?.modelRef ? modelRef : undefined,
        runMode: !conversation?.runMode ? runMode : undefined,
      }).catch(console.error);

      void import('./conversationStore')
        .then(({ useConversationStore }) => {
          useConversationStore.getState().patchConversation(conversationId, {
            agentName,
            modelRef,
            runMode,
          });
        })
        .catch(() => {});
    }

	    const session: AgentSession = {
	      id: sessionId,
	      agentName,
	      title: conversation?.title || '新对话',
	      modelRef,
	      conversationId,
	      workstudioId: resolvedWorkstudioId,
	      apiType: apiProtocol,
	      runMode,
	      thinkingMode: coerceThinkingModeForProtocol(conversation?.thinkingMode, apiProtocol, providerType),
	      draftContent: '',
	      messages,
	      queuedMessages: [],
	      streamingBlocks: null,
	      isGenerating: false,
	      error: null,
	      hasUnreadCompletion: false,
	      unreadCompletionMessageId: null,
	      createdAt: now,
	      lastActiveAt: now,
	    };

    markChatOpenProfile('sessionStore:setState(start)', { conversationId, meta: { sessionId } });
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, session);

      const basePanes = ensureAtLeastOnePane(state.panes ?? []);
      const nextPanes: SessionPane[] = basePanes.map((p) => ({
        ...p,
        sessionIds: [...p.sessionIds].filter((id) => id !== sessionId),
      }));

      const resolvedFocusedPaneId =
        state.focusedPaneId && nextPanes.some((p) => p.id === state.focusedPaneId)
          ? state.focusedPaneId
          : nextPanes[0].id;
      const targetIndex = Math.max(0, nextPanes.findIndex((p) => p.id === resolvedFocusedPaneId));
      const targetPane = nextPanes[targetIndex]!;
      targetPane.sessionIds.push(sessionId);
      targetPane.activeSessionId = sessionId;

      return {
        sessions: newSessions,
        activeSessionId: sessionId,
        panes: normalizePaneWeights(nextPanes),
        focusedPaneId: targetPane.id,
      };
    });
    markChatOpenProfile('sessionStore:setState(done)', { conversationId, meta: { sessionId } });

    useWorkspaceTabStore.getState().upsertChatTab(sessionId);
    markChatOpenProfile('sessionStore:upsertChatTab', { conversationId, meta: { sessionId } });

    useWindowLayoutStore.getState().openTabInFocusedPane(chatTabId(sessionId));

    // Save state
    get().saveSessionState();
    markChatOpenProfile('sessionStore:saveSessionState', { conversationId, meta: { sessionId } });

    return sessionId;
  },

  cloneConversation: async (sourceSessionId: string) => {
    const { sessions, panes } = get();
    const source = sessions.get(sourceSessionId);
    if (!source?.conversationId) {
      throw new Error('当前会话未绑定对话，无法克隆');
    }
    if (source.isGenerating) {
      throw new Error('生成中，无法克隆（请先停止生成）');
    }

    const basePanes = ensureAtLeastOnePane(panes ?? []);
    const sourcePaneIndex = findPaneIndexBySessionId(basePanes, sourceSessionId);
    const sourcePaneId = sourcePaneIndex >= 0 ? basePanes[sourcePaneIndex]!.id : null;
    const sourceTabIndex =
      sourcePaneIndex >= 0 ? basePanes[sourcePaneIndex]!.sessionIds.indexOf(sourceSessionId) : -1;

    // 保证“打开/新建 tab”发生在正确的 pane 上（避免多 pane 时归属错误）。
    if (sourcePaneId) {
      get().setFocusedPane(sourcePaneId);
    }

    const cloned = await invoke<Conversation>('clone_conversation', {
      conversationId: source.conversationId,
    });

    // 刷新历史列表（确保能读到克隆后的 metadata，如 agentName/modelRef/workstudioId）
    const { useConversationStore } = await import('./conversationStore');
    await useConversationStore.getState().loadConversations();

    const newSessionId = await get().openHistoricalConversation(cloned.id);
    // 克隆对话：在 UI 层也保持与源会话一致的 runMode（对话级 runMode 也会在后端/DB 层复制）。
    if (source.runMode) {
      get().setSessionRunMode(newSessionId, source.runMode);
    }

    // VS Code-like：把新 tab 放在源 tab 的右侧（同一 pane）
    if (sourcePaneId && sourceTabIndex >= 0) {
      get().moveSessionToPane(newSessionId, sourcePaneId, sourceTabIndex + 1);
    }

    return newSessionId;
  },
}));


// Module-level event listener initialization
// Execute once to avoid race conditions from React lifecycle
let listenersInitialized = false;

// ============================================================================
// Streaming UI update throttling
// - Token events can be very frequent; updating React/Zustand on every token will
//   cause excessive re-renders. We buffer tokens and flush at a fixed rate.
// - 不同可见级别采用不同刷新上限：激活 15fps、可见未激活 6fps、隐藏 1fps。
// ============================================================================
export type SessionStreamVisibilityTier = 'hidden' | 'visible' | 'active';

const STREAM_UI_UPDATE_ACTIVE_FPS = 15;
const STREAM_UI_UPDATE_VISIBLE_FPS = 6;
const STREAM_UI_UPDATE_HIDDEN_FPS = 1;
const STREAM_UI_UPDATE_INTERVAL_MS_BY_TIER: Record<SessionStreamVisibilityTier, number> = {
  active: Math.round(1000 / STREAM_UI_UPDATE_ACTIVE_FPS),
  visible: Math.round(1000 / STREAM_UI_UPDATE_VISIBLE_FPS),
  hidden: Math.round(1000 / STREAM_UI_UPDATE_HIDDEN_FPS),
};
const STREAM_VISIBILITY_WEIGHT: Record<SessionStreamVisibilityTier, number> = {
  hidden: 0,
  visible: 1,
  active: 2,
};

type PendingStreamChunks = {
  queuedAtMs: number;
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

type ChatDockRequestPayload = {
  requestId: string;
  conversationId: string;
  fromWindowLabel: string;
  placement?: ChatDockPlacement;
  runMode?: RunMode;
  agentName?: string;
};

const pendingStreamChunksBySessionId = new Map<string, PendingStreamChunks>();
const sessionStreamViewerVisibilityBySessionId = new Map<string, Map<string, SessionStreamVisibilityTier>>();
let globalChatStreamVisibility = true;
let streamFlushTimeout: ReturnType<typeof setTimeout> | null = null;
let scheduledStreamFlushAtMs: number | null = null;

const getSessionStreamVisibilityTier = (sessionId: string): SessionStreamVisibilityTier => {
  if (!globalChatStreamVisibility) return 'hidden';

  const viewers = sessionStreamViewerVisibilityBySessionId.get(sessionId);
  if (!viewers || viewers.size === 0) return 'hidden';

  let best: SessionStreamVisibilityTier = 'hidden';
  for (const tier of viewers.values()) {
    if (STREAM_VISIBILITY_WEIGHT[tier] > STREAM_VISIBILITY_WEIGHT[best]) {
      best = tier;
      if (best === 'active') break;
    }
  }
  return best;
};

const getSessionStreamUpdateIntervalMs = (sessionId: string): number => {
  return STREAM_UI_UPDATE_INTERVAL_MS_BY_TIER[getSessionStreamVisibilityTier(sessionId)];
};

export const setGlobalChatStreamVisibility = (visible: boolean) => {
  if (globalChatStreamVisibility === visible) return;
  globalChatStreamVisibility = visible;
  if (pendingStreamChunksBySessionId.size > 0) scheduleStreamFlush();
};

export const setSessionStreamViewerVisibility = (
  sessionId: string,
  viewerId: string,
  tier: SessionStreamVisibilityTier
) => {
  if (!sessionId || !viewerId) return;
  let viewers = sessionStreamViewerVisibilityBySessionId.get(sessionId);
  if (!viewers) {
    viewers = new Map<string, SessionStreamVisibilityTier>();
    sessionStreamViewerVisibilityBySessionId.set(sessionId, viewers);
  }
  if (viewers.get(viewerId) === tier) return;
  viewers.set(viewerId, tier);
  if (pendingStreamChunksBySessionId.size > 0) scheduleStreamFlush();
};

export const clearSessionStreamViewerVisibility = (sessionId: string, viewerId: string) => {
  if (!sessionId || !viewerId) return;
  const viewers = sessionStreamViewerVisibilityBySessionId.get(sessionId);
  if (!viewers) return;
  viewers.delete(viewerId);
  if (viewers.size === 0) {
    sessionStreamViewerVisibilityBySessionId.delete(sessionId);
  }
  if (pendingStreamChunksBySessionId.size > 0) scheduleStreamFlush();
};

type StreamingTurnsById = Map<string, MessageTurn>;
const streamingTurnIndexBySessionId = new Map<string, Map<string, number>>();

// Global error exposure for tool failures.
// - Avoid "silent" TOOL_ERROR blocks hidden behind collapsed tool details.
// - De-dupe by (conversationId + callId) to prevent repeated popups during streaming flush.
const shownGlobalToolErrorPopupKeys = new Set<string>();

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
    chunks = { queuedAtMs: Date.now(), blocks: new Map() };
    pendingStreamChunksBySessionId.set(sessionId, chunks);
  }
  return chunks;
};

const clearPendingChunks = (sessionId: string) => {
  pendingStreamChunksBySessionId.delete(sessionId);
  if (pendingStreamChunksBySessionId.size === 0 && streamFlushTimeout) {
    clearTimeout(streamFlushTimeout);
    streamFlushTimeout = null;
    scheduledStreamFlushAtMs = null;
  }
};

type FlushPendingStreamOptions = {
  nowMs?: number;
  forceSessionIds?: Set<string> | null;
};

const flushPendingStreamChunks = (options: FlushPendingStreamOptions = {}) => {
  if (pendingStreamChunksBySessionId.size === 0) return;

  const nowMs = options.nowMs ?? Date.now();
  const snapshot: Array<[string, PendingStreamChunks]> = [];

  for (const [sessionId, chunks] of pendingStreamChunksBySessionId.entries()) {
    const forced = options.forceSessionIds?.has(sessionId) ?? false;
    if (!forced) {
      const intervalMs = getSessionStreamUpdateIntervalMs(sessionId);
      const ageMs = nowMs - chunks.queuedAtMs;
      if (ageMs < intervalMs) continue;
    }

    snapshot.push([sessionId, chunks]);
    pendingStreamChunksBySessionId.delete(sessionId);
  }

  if (snapshot.length === 0) return;

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

      // Some providers/gateways incorrectly send "delta" as the full content-so-far.
      // If we blindly append, UI will show exponentially duplicated text.
      const mergeStreamingTextDelta = (prevText: string, nextDelta: string): string => {
        if (!nextDelta) return prevText;
        if (!prevText) return nextDelta;

        // If delta is actually the full snapshot (content-so-far), replace.
        if (nextDelta.startsWith(prevText)) {
          return nextDelta;
        }

        // If we've already appended it (replay/dup), ignore.
        if (prevText.endsWith(nextDelta)) {
          return prevText;
        }

        // Overlap merge: append only the non-overlapping tail of delta.
        const maxOverlap = Math.min(prevText.length, nextDelta.length);
        for (let k = maxOverlap; k >= 1; k--) {
          if (prevText.slice(prevText.length - k) === nextDelta.slice(0, k)) {
            return prevText + nextDelta.slice(k);
          }
        }

        return prevText + nextDelta;
      };

      // Some block types are emitted as full JSON snapshots; for these we should not concat deltas.
      const isSnapshotBlockType = (blockType: string) => {
        return blockType === 'web_search' || blockType === 'tool_call' || blockType === 'approval';
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
            if (blockType === 'status') {
              return { id: blockId, type: 'status', turnId, turnIndex, text: delta };
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
              const meta = (v as any).meta;
              return { id: blockId, type: 'tool_call', callId, name, arguments: args, meta, turnId, turnIndex };
            }
          }
          if (blockType === 'approval') {
            const v = parseJson(delta);
            if (v && typeof v === 'object') {
              const requestId = typeof v.request_id === 'string' ? v.request_id : extractSuffixId('approval:', blockId);
              const callId = typeof v.call_id === 'string' ? v.call_id : requestId;
              const toolName = typeof v.tool_name === 'string' ? v.tool_name : '';
              const args = typeof v.arguments === 'string' ? v.arguments : '';
              const status = typeof v.status === 'string' ? v.status : 'unknown';
              const securityPolicy = typeof (v as any).security_policy === 'string' ? (v as any).security_policy : undefined;
              const escalated = typeof v.escalated === 'boolean' ? v.escalated : undefined;
              const reason = typeof v.reason === 'string' ? v.reason : undefined;
              return {
                id: blockId,
                type: 'approval',
                requestId,
                callId,
                toolName,
                arguments: args,
                status,
                securityPolicy,
                escalated,
                reason,
                turnId,
                turnIndex,
              };
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
              return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
            }
            if (current.type === 'status' && blockType === 'status') {
              return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
            }
            if (current.type === 'text' && blockType === 'text') {
              return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta), format: current.format || format || 'markdown' };
            }
          if (current.type === 'tool_result' && blockType === 'tool_result') {
            return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
          }
          if (current.type === 'error' && blockType === 'error') {
            return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
          }
          if (current.type === 'tool_call' && blockType === 'tool_call') {
            // Snapshot update: overwrite (arguments may arrive in multiple updates in future)
            return createBlock();
          }
          if (current.type === 'approval' && blockType === 'approval') {
            // Snapshot update: overwrite
            return createBlock();
          }
          if (current.type === 'web_search' && blockType === 'web_search') {
            // Snapshot update: overwrite
            return createBlock();
          }
          if (current.type === 'unknown') {
            // If we now recognize the blockType, upgrade it to a typed block; otherwise append text.
            if (blockType === 'text' || blockType === 'thinking' || blockType === 'status' || blockType === 'tool_call' || blockType === 'tool_result' || blockType === 'web_search' || blockType === 'error' || blockType === 'approval') {
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

      // -------------------------------------------------------------------
      // Tool failure global popup (dev/build; strict mode + critical tools)
      // -------------------------------------------------------------------
      try {
        const cfg = useConfigStore.getState().config;
        const strict = cfg?.strictErrorMode === true;

        const toolCallById = new Map<string, { name: string; arguments?: string }>();
        for (const b of nextBlocks) {
          if (b.type !== 'tool_call') continue;
          toolCallById.set(b.callId, { name: b.name, arguments: b.arguments });
        }

        const clip = (text: string, limit: number): string => {
          if (!text) return '';
          if (text.length <= limit) return text;
          return `${text.slice(0, limit - 1)}…`;
        };

        for (const b of nextBlocks) {
          if (b.type !== 'tool_result') continue;
          const trimmed = (b.text || '').trimStart();
          const isToolError =
            trimmed.startsWith('TOOL_ERROR:') || trimmed.startsWith('TOOL_RESULT_MISSING:');
          if (!isToolError) continue;

          const convId = session.conversationId ?? 'null';
          const key = `${convId}:${b.callId}`;
          if (shownGlobalToolErrorPopupKeys.has(key)) continue;

          const toolCall = toolCallById.get(b.callId);
          const toolName = toolCall?.name || 'unknown';
          const isCriticalTool = toolName === 'apply_patch' || toolName === 'apply_patch_unified_diff';
          const shouldPopup = strict || isCriticalTool;
          if (!shouldPopup) continue;

          shownGlobalToolErrorPopupKeys.add(key);

          const ctxLines: string[] = [];
          ctxLines.push(`- conversationId: ${convId}`);
          if (b.turnId) ctxLines.push(`- turnId: ${b.turnId}`);
          if (typeof b.turnIndex === 'number') ctxLines.push(`- turnIndex: ${b.turnIndex}`);
          ctxLines.push(`- tool: ${toolName}`);
          ctxLines.push(`- callId: ${b.callId}`);

          const modalMessage = [
            clip(trimmed, 50_000),
            '',
            '上下文：',
            ...ctxLines,
            '',
            '提示：点击对应工具块可查看完整参数与 meta（含 patch 诊断、ghost commits 等）。',
          ].join('\n');

          void showGlobalError(`工具失败: ${toolName}`, modalMessage);
        }
      } catch {
        // ignore
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

const getNextStreamFlushDelayMs = (nowMs: number): number | null => {
  let nextDelayMs: number | null = null;

  for (const [sessionId, chunks] of pendingStreamChunksBySessionId.entries()) {
    const intervalMs = getSessionStreamUpdateIntervalMs(sessionId);
    const ageMs = nowMs - chunks.queuedAtMs;
    const delayMs = Math.max(0, intervalMs - ageMs);
    if (nextDelayMs === null || delayMs < nextDelayMs) {
      nextDelayMs = delayMs;
    }
  }

  return nextDelayMs;
};

const scheduleStreamFlush = () => {
  if (pendingStreamChunksBySessionId.size === 0) {
    if (streamFlushTimeout) {
      clearTimeout(streamFlushTimeout);
      streamFlushTimeout = null;
    }
    scheduledStreamFlushAtMs = null;
    return;
  }

  const nowMs = Date.now();
  const nextDelayMs = getNextStreamFlushDelayMs(nowMs);
  if (nextDelayMs === null) return;

  const nextFlushAtMs = nowMs + nextDelayMs;
  if (
    streamFlushTimeout !== null &&
    scheduledStreamFlushAtMs !== null &&
    scheduledStreamFlushAtMs <= nextFlushAtMs + 1
  ) {
    return;
  }

  if (streamFlushTimeout) {
    clearTimeout(streamFlushTimeout);
  }

  scheduledStreamFlushAtMs = nextFlushAtMs;
  streamFlushTimeout = setTimeout(() => {
    streamFlushTimeout = null;
    scheduledStreamFlushAtMs = null;
    flushPendingStreamChunks({ nowMs: Date.now() });

    if (pendingStreamChunksBySessionId.size > 0) {
      scheduleStreamFlush();
    }
  }, Math.max(0, Math.ceil(nextDelayMs)));
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

      if (payload.type === 'history_sync_needed') {
        // Backend mutated persisted history (e.g. normal compact). Reload messages from DB.
        void (async () => {
          try {
            const next = hydrateMessagesFromBackend(
              await invoke<Message[]>('get_messages', {
                conversationId: payload.conversationId,
                limit: 100,
              })
            );
            useSessionStore.setState((state) => {
              const newSessions = new Map(state.sessions);
              const currentSession = newSessions.get(session.id);
              if (!currentSession) return {};
              newSessions.set(session.id, { ...currentSession, messages: next });
              return { sessions: newSessions };
            });
          } catch (e) {
            console.warn('history_sync_needed: reload messages failed:', e);
          }
        })();
        return;
      }

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
            contextTrim: existing?.contextTrim,
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
            contextTrim: payload.contextTrim ?? existing?.contextTrim,
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
        flushPendingStreamChunks({ forceSessionIds: new Set([session.id]) });
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
        flushPendingStreamChunks({ forceSessionIds: new Set([session.id]) });
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

    // 跨窗口停靠：把某个 conversation “移入本窗口”（作为 tab 或分屏）。
    await listen<ChatDockRequestPayload>('chat:dock_request', (event) => {
      const payload = event.payload;
      if (!payload?.requestId || !payload?.conversationId || !payload?.fromWindowLabel) return;

      void (async () => {
        try {
          // 主窗口可能停留在 History/Settings，停靠时应直接切回聊天界面。
          try {
            useUIStore.getState().setActiveView('chat');
          } catch {
            // ignore
          }

          const state = useSessionStore.getState();
          const layout = useWindowLayoutStore.getState();
          const basePaneId = layout.focusedPaneId ?? layout.panes?.[0]?.id ?? null;
          const placement: ChatDockPlacement = payload.placement ?? 'tab';

          const sessionId = await state.openHistoricalConversation(payload.conversationId, {
            agentName: payload.agentName,
            runMode: payload.runMode,
          });

          if (placement !== 'tab' && basePaneId) {
            const direction = placement === 'split-left' ? 'left' : 'right';
            useWindowLayoutStore.getState().splitTabToNewPane(chatTabId(sessionId), direction, basePaneId);
          }

          await emitToWindowLabel(payload.fromWindowLabel, 'chat:dock_ack', {
            requestId: payload.requestId,
            ok: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await emitToWindowLabel(payload.fromWindowLabel, 'chat:dock_ack', {
            requestId: payload.requestId,
            ok: false,
            error: message,
          });
        }
      })();
    });

    // 跨窗口停靠：把一个“非聊天 tab”（文档/网页/终端）移入本窗口（作为 tab 或分屏）。
    await listen<WorkspaceDockRequestPayload>('workspace:dock_request', (event) => {
      const payload = event.payload;
      if (!payload?.requestId || !payload?.fromWindowLabel || !payload?.item?.kind) return;

      void (async () => {
        try {
          // 主窗口可能停留在 History/Settings，停靠时应直接切回聊天界面（workspace 容器）。
          try {
            useUIStore.getState().setActiveView('chat');
          } catch {
            // ignore
          }

          const layout = useWindowLayoutStore.getState();
          const basePaneId = layout.focusedPaneId ?? layout.panes?.[0]?.id ?? null;
          const placement: ChatDockPlacement = payload.placement ?? 'tab';

          let tabId: WorkspaceTabId | null = null;

          if (payload.item.kind === 'document') {
            const path = (payload.item.documentPath ?? '').trim();
            if (!path) throw new Error('缺少 documentPath');

            const file = await invoke<{
              filename: string;
              mime: string;
              base64: string;
              size: number;
            }>('read_local_file_base64', { path });

            const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
            const content = new TextDecoder('utf-8').decode(bytes);

            const docId = useDocumentStore.getState().openDocument({
              title: (payload.item.title ?? '').trim() || file.filename,
              path,
              kind: 'text',
              content,
            });
            tabId = docTabId(docId);
          } else if (payload.item.kind === 'web') {
            const url = (payload.item.webUrl ?? '').trim();
            if (!url) throw new Error('缺少 webUrl');
            const wid = useWebTabStore.getState().openWebTab(url, {
              title: payload.item.title ?? undefined,
              activate: true,
            });
            tabId = webTabId(wid);
          } else if (payload.item.kind === 'terminal') {
            const tid = useTerminalTabStore.getState().openTerminalTab({
              title: payload.item.title ?? undefined,
              workdir: payload.item.terminalWorkdir ?? undefined,
              activate: true,
            });
            tabId = terminalTabId(tid);
          } else {
            throw new Error(`不支持的停靠类型：${(payload.item as any).kind}`);
          }

          if (!tabId) throw new Error('无法创建目标 tab');

          if (placement === 'tab' || !basePaneId) {
            useWindowLayoutStore.getState().openTabInFocusedPane(tabId);
          } else {
            const direction = placement === 'split-left' ? 'left' : 'right';
            useWindowLayoutStore.getState().splitTabToNewPane(tabId, direction, basePaneId);
          }

          await emitToWindowLabel(payload.fromWindowLabel, 'workspace:dock_ack', {
            requestId: payload.requestId,
            ok: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await emitToWindowLabel(payload.fromWindowLabel, 'workspace:dock_ack', {
            requestId: payload.requestId,
            ok: false,
            error: message,
          });
        }
      })();
    });

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
