/**
 * ChatView Component
 * Main chat interface composing MessageList and InputArea
 * Requirements: 2.3, 2.4, 4.1, 4.2, 4.3, 4.4
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Folder, ChevronDown, Shield, ListOrdered, ArrowUp, ArrowDown, Pencil, Trash2, Check, X, Code2, ExternalLink, Bot } from 'lucide-react';
import {
  clearSessionStreamViewerVisibility,
  setSessionStreamViewerVisibility,
  type SessionStreamVisibilityTier,
  useSessionStore,
} from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { MessageList, type MessageListHandle } from './MessageList';
import { InputArea, type InputAreaHandle } from './InputArea';
import { ToolSessionsPanel } from './ToolSessionsPanel';
import { AgentSessionsPanel } from './AgentSessionsPanel';
import { estimateTokens } from '../../utils/tokenizer';
import { getApiProtocol } from '../../utils/apiUtils';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  TokenUsage,
  ContextUsageBreakdown,
  ContextMessageGroups,
  ContentPart,
  CodeSnippetContentPart,
  ThinkingMode,
  PtySessionInfo,
  Workstudio,
  Agent,
  SkillMetadata,
  SkillLoadOutcome,
  SandboxPolicy,
  SecurityPolicyConfig,
  Message,
  MessageBlock,
} from '../../types';
import { useToolSessionStore } from '../../stores/toolSessionStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { endChatOpenProfile, getActiveChatOpenProfile, markChatOpenProfile } from '../../utils/chatOpenProfile';
import { openOrFocusWorkstudioWindow } from '../../utils/viewWindow';
import { openWorkstudioFileInWorkspace } from '../../utils/workstudioOpenFile';
import { WorkstudioSecurityModal } from './WorkstudioSecurityModal';
import type { WebSearchProvider } from './WebSearchToggle';
import { ChatOutlinePanel, type ChatOutlineItem } from './ChatOutlinePanel';
import { stripAnsi } from '../../utils/stripAnsi';

interface ChatViewProps {
  sessionId: string | null;
  /** 仅在“当前聚焦 Pane 的激活会话”里自动聚焦输入框（避免 keep-alive 多实例抢焦点） */
  autoFocus?: boolean;
  streamVisibilityTier?: SessionStreamVisibilityTier;
}

const EMPTY_PTY_SESSIONS: PtySessionInfo[] = [];

export const ChatView: React.FC<ChatViewProps> = ({ sessionId, autoFocus = false, streamVisibilityTier = 'hidden' }) => {
  // Get session from SessionStore
		  const {
		    session,
		    sendMessage,
		    abortGeneration,
		    retry: retryMessage,
		    retryTurn,
		    cloneConversation,
		    setSessionModel,
		    undoToMessage,
		    moveQueuedMessage,
		    removeQueuedMessage,
		    updateQueuedMessageContent,
        acknowledgeUnreadCompletion,
			    setSessionRunMode,
				    setSessionThinkingMode,
				    setSessionDraftContent,
				    setSessionDraftWorkspaceMentions,
				    setSessionDraftCodeSnippets,
				  } = useSessionStore(
				    useShallow((state) => ({
			      session: sessionId ? state.sessions.get(sessionId) : undefined,
			      sendMessage: state.sendMessage,
			      abortGeneration: state.abortGeneration,
		      retry: state.retry,
		      retryTurn: state.retryTurn,
		      cloneConversation: state.cloneConversation,
		      setSessionModel: state.setSessionModel,
		      undoToMessage: state.undoToMessage,
		      moveQueuedMessage: state.moveQueuedMessage,
			      removeQueuedMessage: state.removeQueuedMessage,
			      updateQueuedMessageContent: state.updateQueuedMessageContent,
            acknowledgeUnreadCompletion: state.acknowledgeUnreadCompletion,
			      setSessionRunMode: state.setSessionRunMode,
				      setSessionThinkingMode: state.setSessionThinkingMode,
				      setSessionDraftContent: state.setSessionDraftContent,
				      setSessionDraftWorkspaceMentions: state.setSessionDraftWorkspaceMentions,
				      setSessionDraftCodeSnippets: state.setSessionDraftCodeSnippets,
				    }))
			  );
  const [showToolSessions, setShowToolSessions] = useState(false);
  const [showAgentSessions, setShowAgentSessions] = useState(false);
  const [selectedRequestMessageId, setSelectedRequestMessageId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [editingQueueMessageId, setEditingQueueMessageId] = useState<string | null>(null);
  const [editingQueueContent, setEditingQueueContent] = useState('');

  const inputRef = useRef<InputAreaHandle>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const outlinePanelRef = useRef<HTMLDivElement>(null);
  const streamViewerIdRef = useRef<string>(crypto.randomUUID());
  const outlineToggleButtonRef = useRef<HTMLButtonElement>(null);
  const chatOpenProfileScheduledRef = useRef<string | null>(null);

  // 仅对“当前聚焦 Pane 的激活会话”自动聚焦，避免 keep-alive 多会话同时挂载时互相抢焦点。
  useEffect(() => {
    if (!autoFocus) return;
    const focus = () => inputRef.current?.focus();
    if (typeof requestAnimationFrame === 'function') {
      const rafId = requestAnimationFrame(focus);
      return () => cancelAnimationFrame(rafId);
    }
    focus();
  }, [autoFocus, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const viewerId = streamViewerIdRef.current;
    setSessionStreamViewerVisibility(sessionId, viewerId, streamVisibilityTier);
    return () => {
      clearSessionStreamViewerVisibility(sessionId, viewerId);
    };
  }, [sessionId, streamVisibilityTier]);

  // 允许把文件/文本拖拽到聊天窗口（消息列表）时，直接追加到输入框里
  const handleDropFilesToInput = useCallback((files: FileList | File[]) => {
    inputRef.current?.addFiles(files);
    inputRef.current?.focus();
  }, []);

  const handleDropTextToInput = useCallback((text: string) => {
    inputRef.current?.insertText(text);
  }, []);

  // Extract session state with defaults for when no session exists
  const messages = session?.messages ?? [];
  const queuedMessages = session?.queuedMessages ?? [];
  const streamingBlocks = session?.streamingBlocks ?? null;
  const streamingTurns = session?.streamingTurns ? Array.from(session.streamingTurns.values()) : undefined;
  const streamingAssistantMessageId = session?.streamingAssistantMessageId ?? null;
  const isGenerating = session?.isGenerating ?? false;
  const conversationId = session?.conversationId ?? '';
  const agentName = session?.agentName ?? null;
  const chatWithScope = session?.chatWithScope ?? null;

  const maybeAcknowledgeUnreadCompletion = useCallback(() => {
    if (!sessionId) return;
    if (!session?.hasUnreadCompletion) return;
    acknowledgeUnreadCompletion(sessionId);
  }, [acknowledgeUnreadCompletion, session?.hasUnreadCompletion, sessionId]);

  // 目录：文本提取与缩略
  const messageToOutlineText = useCallback((m: Message): string => {
    const content = (m.content ?? '').trim();
    if (content) return content;
    const parts = m.contentParts ?? [];
    if (parts.length > 0) return `（附件 ${parts.length}）`;
    return '（空消息）';
  }, []);
  const textToOutlinePreview = useCallback((text: string): string => {
    const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
    const trimmed = line.trim();
    if (trimmed.length <= 32) return trimmed;
    return `${trimmed.slice(0, 32)}…`;
  }, []);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const outlineItems = useMemo((): ChatOutlineItem[] => {
    const out: ChatOutlineItem[] = [];
    let idx = 0;

    for (const m of messages) {
      if (m.role !== 'user') continue;
      idx += 1;
      const fullText = messageToOutlineText(m);
      out.push({
        messageId: m.id,
        index: idx,
        preview: textToOutlinePreview(fullText),
      });
    }
    return out;
  }, [messageToOutlineText, messages, textToOutlinePreview]);

  const selectedOutlineFullText = useMemo(() => {
    if (!selectedRequestMessageId) return null;
    const m = messages.find((x) => x.id === selectedRequestMessageId);
    if (!m) return null;
    return messageToOutlineText(m);
  }, [messageToOutlineText, messages, selectedRequestMessageId]);

  useEffect(() => {
    if (outlineItems.length === 0) {
      if (selectedRequestMessageId) setSelectedRequestMessageId(null);
      return;
    }
    if (selectedRequestMessageId && outlineItems.some((i) => i.messageId === selectedRequestMessageId)) return;
    setSelectedRequestMessageId(outlineItems[outlineItems.length - 1]?.messageId ?? null);
  }, [outlineItems, selectedRequestMessageId]);

  useEffect(() => {
    if (!editingQueueMessageId) return;
    if (queuedMessages.some((item) => item.id === editingQueueMessageId)) return;
    setEditingQueueMessageId(null);
    setEditingQueueContent('');
  }, [editingQueueMessageId, queuedMessages]);

  const beginEditQueuedMessage = useCallback((messageId: string, content: string) => {
    setEditingQueueMessageId(messageId);
    setEditingQueueContent(content);
  }, []);

  const cancelEditQueuedMessage = useCallback(() => {
    setEditingQueueMessageId(null);
    setEditingQueueContent('');
  }, []);

  const saveEditQueuedMessage = useCallback(
    (messageId: string) => {
      if (!sessionId) return;
      updateQueuedMessageContent(sessionId, messageId, editingQueueContent);
      setEditingQueueMessageId(null);
      setEditingQueueContent('');
    },
    [editingQueueContent, sessionId, updateQueuedMessageContent]
  );

  const handleSelectOutline = useCallback((messageId: string) => {
    setSelectedRequestMessageId(messageId);
    messageListRef.current?.scrollToMessage(messageId);
  }, []);

  // 快捷键：切换消息目录（仅作用于聚焦 Pane 的 ChatView）
  useEffect(() => {
    const onShortcut = (event: Event) => {
      if (!autoFocus) return;
      const e = event as CustomEvent<{ action?: string }>;
      if (e.detail?.action !== 'chat.toggleOutline') return;
      setOutlineOpen((v) => !v);
    };
    window.addEventListener('tauri-ai:shortcut', onShortcut as EventListener);
    return () => window.removeEventListener('tauri-ai:shortcut', onShortcut as EventListener);
  }, [autoFocus]);

  // ---------------------------------------------------------------------------
  // Debug performance: profile "click -> ChatView ready"
  // - Enabled by default in DEV, or via localStorage key: `tauri-ai:debug:profile_chat_open=1`
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    if (!conversationId) return;

    const profile = getActiveChatOpenProfile();
    if (!profile || profile.ended) return;

    const matches =
      (profile.sessionId ? profile.sessionId === sessionId : false) ||
      (!profile.sessionId && profile.conversationId ? profile.conversationId === conversationId : false);
    if (!matches) return;

    if (chatOpenProfileScheduledRef.current === profile.id) return;
    chatOpenProfileScheduledRef.current = profile.id;

    markChatOpenProfile('chatView:rendered(useEffect)', {
      profileId: profile.id,
      sessionId,
      conversationId,
      meta: { messageCount: messages.length, isGenerating, hasStreamingBlocks: Boolean(streamingBlocks) },
    });

    requestAnimationFrame(() => {
      markChatOpenProfile('chatView:raf1', { profileId: profile.id, sessionId, conversationId });
      requestAnimationFrame(() => {
        markChatOpenProfile('chatView:raf2', { profileId: profile.id, sessionId, conversationId });
        endChatOpenProfile('chatView:painted', {
          profileId: profile.id,
          sessionId,
          conversationId,
          meta: { messageCount: messages.length },
        });
      });
    });
  }, [sessionId, conversationId]);

  const { config, getProvider, getAgent, getModelOptions } = useConfigStore(
    useShallow((state) => ({
      config: state.config,
      getProvider: state.getProvider,
      getAgent: state.getAgent,
      getModelOptions: state.getModelOptions,
    }))
  );

  const agentForSession = useMemo(() => {
    return agentName ? getAgent(agentName) ?? null : null;
  }, [agentName, getAgent]);

  const activeFormatType = (agentForSession?.formatType || 'chat') as 'chat' | 'plain' | 'json' | 'none';
  const [formatPromptTextFromBackend, setFormatPromptTextFromBackend] = useState<string>('');
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (activeFormatType === 'none') {
        setFormatPromptTextFromBackend('');
        return;
      }
      if (!isTauri()) {
        setFormatPromptTextFromBackend('');
        return;
      }

      try {
        const res = await invoke<string | null>('get_format_prompt', { formatType: activeFormatType });
        if (!cancelled) setFormatPromptTextFromBackend(res ?? '');
      } catch {
        if (!cancelled) setFormatPromptTextFromBackend('');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeFormatType]);

  const [mcpResourceToolPromptTextFromBackend, setMcpResourceToolPromptTextFromBackend] = useState<string>('');
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!isTauri()) {
        setMcpResourceToolPromptTextFromBackend('');
        return;
      }

      try {
        const res = await invoke<string>('get_system_prompt', { promptType: 'mcp_resource_tool' });
        if (!cancelled) setMcpResourceToolPromptTextFromBackend(res ?? '');
      } catch {
        if (!cancelled) setMcpResourceToolPromptTextFromBackend('');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // Get current model's context length based on session's model or agent's default
  const resolvedModelRef = session?.modelRef || agentForSession?.modelRef || null;
  const currentModel = useMemo(() => {
    if (!resolvedModelRef) return null;

    const [providerName, modelName] = resolvedModelRef.split('/');
    const provider = getProvider(providerName);
    if (!provider) return null;

    return provider.models.find(m => m.name === modelName) || null;
  }, [config, getProvider, resolvedModelRef]);

  // Get provider type for current model (responses thinking levels differ by provider)
  const currentProviderType = useMemo(() => {
    if (!resolvedModelRef) return undefined;

    const [providerName] = resolvedModelRef.split('/');
    return getProvider(providerName)?.type;
  }, [config, getProvider, resolvedModelRef]);

  // Check if current model supports thinking
  const supportsThinking = useMemo(() => {
    return currentModel?.capabilities?.thinking ?? false;
  }, [currentModel]);

  // Check if current model supports vision/images
  const supportsVision = useMemo(() => {
    return currentModel?.capabilities?.vision ?? false;
  }, [currentModel]);

  const contextMessageGroups: ContextMessageGroups = useMemo(() => {
    const MESSAGE_LIMIT = 100; // keep in sync with backend run_task base_messages limit

    const isFailed = (m: Message): boolean => (m.status ?? 'success') === 'failed';
    const eligible = messages.filter((m) => !isFailed(m));
    const trimmedCount = Math.max(0, eligible.length - MESSAGE_LIMIT);

    const modelRef = session?.modelRef || agentForSession?.modelRef || '';
    const [providerName, modelName] = modelRef.split('/');
    const provider = providerName ? getProvider(providerName) : undefined;

    const thinkingEnabled = (() => {
      if (!supportsThinking) return false;
      const tm = session?.thinkingMode;
      // 与后端 build_model_config 对齐：thinking 未显式设置时，默认启用（medium/true）
      if (tm === undefined) return true;
      if (typeof tm === 'boolean') return tm;
      return tm !== null;
    })();

    const includeThinking =
      Boolean(currentModel?.reinjectReasoningContent) &&
      thinkingEnabled &&
      currentProviderType === 'openai_compatible' &&
      ((modelName || '').toLowerCase().startsWith('kimi-') ||
        (provider?.apiBase || '').toLowerCase().includes('moonshot'));

    return {
      used: eligible.slice(-MESSAGE_LIMIT),
      trimmed: trimmedCount > 0 ? eligible.slice(0, trimmedCount) : [],
      failed: messages.filter(isFailed),
      messageLimit: MESSAGE_LIMIT,
      includeThinking,
    };
  }, [agentForSession?.modelRef, currentModel?.reinjectReasoningContent, currentProviderType, getProvider, messages, session?.modelRef, session?.thinkingMode, supportsThinking]);

  // Available web search providers
  const availableWebSearchProviders = useMemo((): WebSearchProvider[] => {
    const providers: WebSearchProvider[] = [];
    
    // Check for native model web search
    if (currentModel?.capabilities?.webSearch) {
      providers.push('native');
    }
    
    // Check for local tool providers
    const ws = config?.general?.webSearchTool;
    if (ws?.tavilyEnabled && ws.tavilyApiKey?.trim()) {
      providers.push('tavily');
    }
    if (ws?.braveEnabled && ws.braveApiKey?.trim()) {
      providers.push('brave');
    }
    if (ws?.googleEnabled && ws.googleApiKey?.trim() && ws.googleCx?.trim()) {
      providers.push('google');
    }
    
    return providers;
  }, [currentModel, config]);

  // 任何场景都应该允许 web search（只要能力可用）：
  // - 模型支持 native web search，或
  // - 用户配置了本地 web search provider（Tavily/Google/Brave）
  //
  // 仅当两者都不可用时，隐藏搜索菜单。
  const supportsWebSearch = useMemo(() => availableWebSearchProviders.length > 0, [availableWebSearchProviders]);

  // 默认选择：仅在“未设置”时自动选一个；若用户显式选择了“不搜索”(null)则不覆盖。
  useEffect(() => {
    if (!sessionId) return;
    if (!supportsWebSearch) return;
    if (!availableWebSearchProviders.length) return;
    if (!agentName) return;
    if (session?.webSearchProvider !== undefined) return;

    const preferred =
      (availableWebSearchProviders.includes('native') ? 'native' : availableWebSearchProviders[0]) ??
      null;
    useSessionStore.getState().setSessionWebSearchProvider(sessionId, preferred);
  }, [agentName, availableWebSearchProviders, session?.webSearchProvider, sessionId, supportsWebSearch]);

  // 模型切换/配置变更后，校验一次当前会话的搜索提供方是否仍可用：
  // - 例如：从支持 native web search 的模型切到不支持的模型时，避免仍显示/使用 "native"
  // - 若用户显式选择了“不搜索”(null)，则保持不变
  useEffect(() => {
    if (!sessionId) return;
    if (!session) return;

    const selected = session.webSearchProvider;
    if (selected === undefined) return;
    if (selected === null) return;

    if (!availableWebSearchProviders.includes(selected)) {
      const fallback =
        (availableWebSearchProviders.includes('native') ? 'native' : availableWebSearchProviders[0]) ?? null;
      useSessionStore.getState().setSessionWebSearchProvider(sessionId, fallback);
    }
  }, [availableWebSearchProviders, sessionId, session?.webSearchProvider]);

  const webSearchDetails = useMemo(() => {
    if (availableWebSearchProviders.length === 0) {
      return '未配置搜索提供方（设置→通用）';
    }
    const ws = config?.general?.webSearchTool;
    const interval = ws?.minIntervalMs ?? 1200;
    const labels: Record<WebSearchProvider, string> = {
      native: '模型内置',
      tavily: 'Tavily',
      brave: 'Brave',
      google: 'Google',
    };
    return `可用提供方：${availableWebSearchProviders.map(p => labels[p]).join('、')}｜最小间隔：${interval}ms`;
  }, [availableWebSearchProviders, config]);

  const persistanceShellEnhance = useMemo(() => {
    if (!agentName) return false;
    const agent = getAgent(agentName);
    const toolsetName = agent?.toolset;
    if (!toolsetName) return false;
    const toolset = config?.tools?.toolsets?.find((t) => t.name === toolsetName);
    return Boolean(toolset?.persistanceShellEnhance);
  }, [agentName, getAgent, config]);

  // Check if current model uses reasoning_effort parameter
  const useReasoningEffort = useMemo(() => {
    return currentModel?.useReasoningEffort ?? false;
  }, [currentModel]);

  // Get API protocol type for thinking mode
  const apiProtocol = useMemo(() => {
    if (!resolvedModelRef) return 'chat_completions';
    return getApiProtocol(resolvedModelRef, config?.providers || []);
  }, [config, resolvedModelRef]);

  const thinkingMode = useMemo((): ThinkingMode => {
    if (session?.thinkingMode !== undefined) return session.thinkingMode;
    return apiProtocol === 'responses' ? 'medium' : true;
  }, [session?.thinkingMode, apiProtocol]);

  const draftContent = session?.draftContent ?? '';

  // Calculate total token usage for the conversation
  const totalUsage = useMemo((): TokenUsage | null => {
    const usages = messages
      .filter(m => m.usage)
      .map(m => m.usage!);

    if (usages.length === 0) return null;

    return usages.reduce((acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      reasoningTokens: (acc.reasoningTokens || 0) + (u.reasoningTokens || 0) || undefined,
      cachedTokens: (acc.cachedTokens || 0) + (u.cachedTokens || 0) || undefined,
    }), {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: undefined,
      cachedTokens: undefined,
    } as TokenUsage);
  }, [messages]);

  const showUsage = config?.general?.showUsage ?? true;

  const refreshToolSessions = useToolSessionStore((state) => state.refreshSessions);
  const refreshAgentSessions = useAgentSessionStore((state) => state.refreshSessions);
  const agentSessions = useAgentSessionStore((state) =>
    conversationId ? state.sessionsByScopeKey[`conversation:${conversationId}`] ?? [] : []
  );
  const toolSessions = useToolSessionStore(
    (state) =>
      conversationId
        ? state.sessionsByConversation[conversationId] ?? EMPTY_PTY_SESSIONS
        : EMPTY_PTY_SESSIONS
  );
  const persistentToolSessions = useMemo(() => {
    if (!persistanceShellEnhance) return EMPTY_PTY_SESSIONS;
    if (toolSessions.length === 0) return EMPTY_PTY_SESSIONS;
    const filtered = toolSessions.filter((s) => s.scope === 'conversation');
    return filtered.length > 0 ? filtered : EMPTY_PTY_SESSIONS;
  }, [toolSessions, persistanceShellEnhance]);
  const activeToolCount = persistentToolSessions.filter((s) => s.isAlive).length;
  const activeAgentSessionCount = agentSessions.filter((s) => s.status !== 'closed').length;

  const workspaceEnabled = useMemo(() => {
    if (!agentName) return false;
    const agent = getAgent(agentName);
    const agentType = agent?.type ?? 'chat';
    return (agentType === 'tool' || agentType === 'task_agent') && (agent?.workspaceSupport ?? true);
  }, [agentName, getAgent]);

  const [workstudio, setWorkstudio] = useState<Workstudio | null>(null);
  const [workstudioLoading, setWorkstudioLoading] = useState(false);
  const [workstudioMenuOpen, setWorkstudioMenuOpen] = useState(false);
  const [workstudioSecurityOpen, setWorkstudioSecurityOpen] = useState(false);
  const workstudioMenuRef = useRef<HTMLDivElement | null>(null);

  const showSetWorkstudioMainFolderMenu = useMemo(() => {
    const id = (workstudio?.id ?? '').trim();
    const main = (workstudio?.mainFolder ?? '').trim();
    if (!id || !main) return true;

    const normalized = main.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    const suffix = `/.tauri-ai/workstudios/${id}`.replace(/\\/g, '/');
    return normalized.toLowerCase().endsWith(suffix.toLowerCase());
  }, [workstudio?.id, workstudio?.mainFolder]);

  const currentAgentForDisplay = useMemo((): Agent | null => {
    if (!agentName) return null;
    return getAgent(agentName) ?? null;
  }, [agentName, getAgent]);

  // Determine if export should be shown based on format type (richtext)
  const canExportChat = useMemo(() => {
    if (!agentName) return false;
    const agent = getAgent(agentName);
    // Only 'chat' format (richtext) supports export
    return agent?.formatType === 'chat';
  }, [agentName, getAgent]);

  // Export chat to .tauri.richtxt
  const [exporting, setExporting] = useState(false);
  
  const buildRichTxtMarkdown = useCallback((sessionData: typeof session): string => {
    if (!sessionData) return '';
    
    const lines: string[] = [];
    const exportedAt = new Date().toISOString();
    const title = sessionData.title?.trim() || '对话导出';

    const roleLabel = (role: Message['role']) => {
      if (role === 'user') return '用户';
      if (role === 'assistant') return '助手';
      if (role === 'system') return '系统';
      if (role === 'error') return '错误';
      return String(role);
    };

    const renderBlock = (block: MessageBlock) => {
      switch (block.type) {
        case 'text': {
          const format = (block.format || 'markdown').toString().toLowerCase();
          if (format === 'json') {
            lines.push('```json');
            lines.push(block.text ?? '');
            lines.push('```');
            return;
          }
          if (format === 'plain') {
            lines.push('```text');
            lines.push(block.text ?? '');
            lines.push('```');
            return;
          }
          lines.push(block.text ?? '');
          return;
        }
        case 'thinking': {
          lines.push('<details><summary>思考</summary>');
          lines.push('');
          lines.push('```text');
          lines.push(block.text ?? '');
          lines.push('```');
          lines.push('');
          lines.push('</details>');
          return;
        }
        case 'tool_call': {
          lines.push(`**工具调用**：\`${block.name}\``);
          lines.push('```json');
          lines.push(block.arguments ?? '');
          lines.push('```');
          return;
        }
        case 'tool_result': {
          lines.push(`**工具结果**：\`${block.callId}\``);
          lines.push('```text');
          lines.push(block.text ?? '');
          lines.push('```');
          return;
        }
        case 'approval': {
          lines.push(`**审批**：\`${block.toolName}\`（${block.status}）`);
          lines.push('```json');
          lines.push(
            JSON.stringify(
              {
                requestId: block.requestId,
                callId: block.callId,
                toolName: block.toolName,
                status: block.status,
                escalated: block.escalated,
                reason: block.reason,
              },
              null,
              2
            )
          );
          lines.push('```');
          return;
        }
        case 'error': {
          lines.push('**错误**');
          lines.push('```text');
          lines.push(block.text ?? '');
          lines.push('```');
          return;
        }
        case 'web_search': {
          lines.push(`**WebSearch**：\`${block.status}\``);
          lines.push('```json');
          lines.push(JSON.stringify(block.action ?? null, null, 2));
          lines.push('```');
          return;
        }
        case 'unknown': {
          lines.push('**未知块**');
          lines.push('```json');
          lines.push(JSON.stringify(block.data ?? null, null, 2));
          lines.push('```');
          return;
        }
        default: {
          lines.push('**未知块**');
          lines.push('```json');
          lines.push(JSON.stringify(block as never, null, 2));
          lines.push('```');
        }
      }
    };

    lines.push(`<!-- tauri.richtxt v1 | exportedAt=${exportedAt} | conversationId=${sessionData.conversationId ?? ''} -->`);
    lines.push('');
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`- 导出时间：\`${exportedAt}\``);
    lines.push(`- 智能体：\`${sessionData.agentName}\``);
    if (sessionData.modelRef) lines.push(`- 模型：\`${sessionData.modelRef}\``);
    if (sessionData.conversationId) lines.push(`- Conversation ID：\`${sessionData.conversationId}\``);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of sessionData.messages) {
      const when = msg.createdAt ? ` · ${msg.createdAt}` : '';
      lines.push(`## ${roleLabel(msg.role)}${when}`);
      lines.push('');

      const blocks = msg.blocks ?? [];
      if (blocks.length > 0) {
        for (const b of blocks) {
          renderBlock(b);
          lines.push('');
        }
      } else {
        if (msg.thinking?.trim()) {
          lines.push('<details><summary>思考</summary>');
          lines.push('');
          lines.push('```text');
          lines.push(msg.thinking);
          lines.push('```');
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        if (msg.content?.trim()) {
          lines.push(msg.content);
          lines.push('');
        }
      }
    }

    return lines.join('\n').trim() + '\n';
  }, []);

  const handleExportChat = useCallback(async () => {
    if (!session || !session.conversationId) return;
    try {
      setExporting(true);
      const suggested = `${(session.title || 'chat').replace(/[\\/:*?"<>|]/g, '_')}.tauri.richtxt`;
      const picked = await saveDialog({
        title: '导出 .tauri.richtxt',
        defaultPath: suggested,
      });
      if (!picked) return;
      const path = picked.toLowerCase().endsWith('.tauri.richtxt') ? picked : `${picked}.tauri.richtxt`;
      const content = buildRichTxtMarkdown(session);
      await invoke('write_local_text_file', { path, content });
    } catch (e) {
      alert(String(e));
    } finally {
      setExporting(false);
    }
  }, [session, buildRichTxtMarkdown]);

  useEffect(() => {
    setWorkstudioMenuOpen(false);
    setWorkstudioSecurityOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!outlineOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (outlinePanelRef.current?.contains(target)) return;
      if (outlineToggleButtonRef.current?.contains(target)) return;
      setOutlineOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOutlineOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [outlineOpen]);

  useEffect(() => {
    if (!workstudioMenuOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (workstudioMenuRef.current?.contains(target)) return;
      setWorkstudioMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkstudioMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [workstudioMenuOpen]);

  useEffect(() => {
    if (!workspaceEnabled) {
      setWorkstudio(null);
      setWorkstudioLoading(false);
      return;
    }
    if (!isTauri()) {
      setWorkstudio(null);
      setWorkstudioLoading(false);
      return;
    }

    const wsId = session?.workstudioId;
    const convId = session?.conversationId;
    if (!convId) {
      setWorkstudio(null);
      setWorkstudioLoading(false);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setWorkstudioLoading(true);
      try {
        let ws: Workstudio | null = null;
        if (wsId) {
          ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId: wsId });
        }
        if (!ws) {
          ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId: convId });
        }
        if (!cancelled) setWorkstudio(ws);
      } catch (e) {
        if (!cancelled) setWorkstudio(null);
      } finally {
        if (!cancelled) setWorkstudioLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [workspaceEnabled, session?.workstudioId, session?.conversationId]);

  const ensureWorkstudio = useCallback(async (): Promise<Workstudio | null> => {
    if (!workspaceEnabled) return null;
    const convId = session?.conversationId;
    if (!convId) return null;
    if (!isTauri()) return null;

    if (workstudio) return workstudio;

    setWorkstudioLoading(true);
    try {
      const ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId: convId });
      setWorkstudio(ws);
      return ws;
    } catch {
      setWorkstudio(null);
      return null;
    } finally {
      setWorkstudioLoading(false);
    }
  }, [session?.conversationId, workspaceEnabled, workstudio]);

  const openWorkstudioWindow = useCallback(async () => {
    const ws = await ensureWorkstudio();
    if (!ws) return;
    await openOrFocusWorkstudioWindow(`Workstudio: ${ws.mainFolder}`, { workstudioId: ws.id, mainFolder: ws.mainFolder });
  }, [ensureWorkstudio]);

  const openChatWithSource = useCallback(async () => {
    if (!chatWithScope || !session?.workstudioId) return;
    await openWorkstudioFileInWorkspace({
      workstudioId: session.workstudioId,
      target: {
        filePath: chatWithScope.filePath,
        line: chatWithScope.range?.startLine,
        column: chatWithScope.range?.startColumn,
        endLine: chatWithScope.range?.endLine,
        endColumn: chatWithScope.range?.endColumn,
      },
    });
  }, [chatWithScope, session?.workstudioId]);

  // 快捷键：打开 Workstudio（仅作用于“当前聚焦 Pane”的 ChatView）
  useEffect(() => {
    const onShortcut = (event: Event) => {
      if (!autoFocus) return;
      const e = event as CustomEvent<{ action?: string }>;
      if (e.detail?.action !== 'chat.openWorkstudio') return;
      void openWorkstudioWindow();
    };
    window.addEventListener('tauri-ai:shortcut', onShortcut as EventListener);
    return () => window.removeEventListener('tauri-ai:shortcut', onShortcut as EventListener);
  }, [autoFocus, openWorkstudioWindow]);

  const handleSetWorkstudioMainFolder = useCallback(async () => {
    const ws = await ensureWorkstudio();
    if (!ws) return;
    if (!isTauri()) return;

    const selected = await openDialog({
      title: '设置主目录',
      multiple: false,
      directory: true,
    });
    if (!selected || Array.isArray(selected)) return;

    setWorkstudioLoading(true);
    try {
      const updated = await invoke<Workstudio>('add_workstudio_folder', {
        workstudioId: ws.id,
        folder: selected,
        setAsMain: true,
      });
      setWorkstudio(updated);
      await openOrFocusWorkstudioWindow(`Workstudio: ${updated.mainFolder}`, {
        workstudioId: updated.id,
        mainFolder: updated.mainFolder,
      });
    } catch (e) {
      console.error('set workstudio main folder failed:', e);
    } finally {
      setWorkstudioLoading(false);
    }
  }, [ensureWorkstudio]);

  const handleOpenWorkstudioSecurity = useCallback(async () => {
    const ws = await ensureWorkstudio();
    if (!ws) return;
    setWorkstudioSecurityOpen(true);
  }, [ensureWorkstudio]);

  const prevConversationIdRef = useRef<string | null>(null);
  const prevIsGeneratingRef = useRef<boolean>(false);
  const prevPersistentEnhanceRef = useRef<boolean>(false);

  useEffect(() => {
    if (!conversationId) return;
    const conversationChanged = prevConversationIdRef.current !== conversationId;
    const generationFinished = prevIsGeneratingRef.current && !isGenerating;
    const enhanceJustEnabled = !prevPersistentEnhanceRef.current && persistanceShellEnhance;

    prevConversationIdRef.current = conversationId;
    prevIsGeneratingRef.current = isGenerating;
    prevPersistentEnhanceRef.current = persistanceShellEnhance;

    if (persistanceShellEnhance && (conversationChanged || generationFinished || enhanceJustEnabled)) {
      refreshToolSessions(conversationId);
    }
    if (conversationChanged || generationFinished) {
      void refreshAgentSessions({ kind: 'conversation', id: conversationId });
    }
  }, [conversationId, isGenerating, refreshAgentSessions, refreshToolSessions, persistanceShellEnhance]);

  // 系统级提示词统一以 `src-tauri/src/prompts.rs` 为准；前端需要时通过 Tauri command 获取，避免两份数据漂移。

  // Skills catalog (for context usage estimation & tooltip)
  const [skillOutcome, setSkillOutcome] = useState<SkillLoadOutcome | null>(null);

  useEffect(() => {
    const agent = agentName ? getAgent(agentName) : null;
    const hasSkillSet = Boolean(agent?.skillSet);
    if (!hasSkillSet) {
      setSkillOutcome(null);
      return;
    }

    let cancelled = false;
    let unlisten: null | (() => void) = null;

    const load = async () => {
      try {
        const res = await invoke<[any, SkillLoadOutcome]>('list_skills', {
          args: {
            workstudioMainFolder: workstudio?.mainFolder || undefined,
            // 只需要元信息用于“技能列表/如何使用”提示与统计；加载全部 SKILL.md 内容会导致切换会话时明显卡顿
            includeContents: false,
          },
        });
        if (cancelled) return;
        setSkillOutcome(res[1]);
      } catch (e) {
        if (cancelled) return;
        setSkillOutcome({ skills: [], errors: [String(e)] });
      }
    };

    void load();

    void listen('skills:changed', () => {
      void load();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [agentName, getAgent, workstudio?.mainFolder]);

  const enabledSkillMetasForPrompt = useMemo((): SkillMetadata[] => {
    const agent = agentName ? getAgent(agentName) : null;
    const skillSetName = agent?.skillSet;
    if (!skillSetName || !config?.skills?.sets?.length || !skillOutcome?.skills?.length) return [];

    const set = config.skills.sets.find((s) => s.name === skillSetName);
    if (!set || !(set.enabled ?? true)) return [];

    const disabledGlobal = new Set(config.skills.disabledSkills ?? []);
    const disabledSet = new Set(set.disabledSkills ?? []);
    const setSkills = set.skills ?? [];
    const enabledNames =
      setSkills.length === 0 && set.name === '标准skill集'
        ? skillOutcome.skills
            .map((s) => s.meta.name)
            .filter((n) => !disabledGlobal.has(n) && !disabledSet.has(n))
        : setSkills.filter((n) => !disabledGlobal.has(n) && !disabledSet.has(n));

    const byName = new Map(skillOutcome.skills.map((s) => [s.meta.name, s.meta] as const));
    return enabledNames.map((n) => byName.get(n)).filter(Boolean) as SkillMetadata[];
  }, [agentName, getAgent, config, skillOutcome]);

  const [skillsSectionTextFromBackend, setSkillsSectionTextFromBackend] = useState<string>('');
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!isTauri()) {
        setSkillsSectionTextFromBackend('');
        return;
      }
      if (!enabledSkillMetasForPrompt.length) {
        setSkillsSectionTextFromBackend('');
        return;
      }

      try {
        const res = await invoke<string | null>('render_skills_section', { skills: enabledSkillMetasForPrompt });
        if (!cancelled) setSkillsSectionTextFromBackend(res ?? '');
      } catch {
        if (!cancelled) setSkillsSectionTextFromBackend('');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [enabledSkillMetasForPrompt]);

  // Calculate context usage breakdown (async compute; avoid blocking initial render)
  const computeContextUsage = useCallback((): ContextUsageBreakdown | null => {
    if (!session) return null;
    const contextLength = currentModel?.contextLength ?? 0;

    // Get system prompt and format type from session's agent
    const agent = getAgent(session.agentName);
    const userSystemPrompt = agent?.systemPrompt || '';
    const formatType = agent?.formatType || 'chat';

    // Calculate system prompt tokens (user's custom prompt) using accurate tokenizer
    const systemPromptTokens = estimateTokens(userSystemPrompt);

    // Calculate format prompt tokens based on format type
    let formatPromptTokens = 0;
    let formatPromptText = '';
    if (formatType !== 'none' && formatPromptTextFromBackend) {
      formatPromptText = formatPromptTextFromBackend;
      formatPromptTokens = estimateTokens(formatPromptTextFromBackend);
    }
    // 'none' type has no format prompt

    // Skills prompt tokens (injected by backend)
    const skillsSectionText = skillsSectionTextFromBackend || '';
    const skillsInjectedText = '';
    const skillsTokens = skillsSectionText ? estimateTokens(skillsSectionText) : 0;

    // MCP prompt tokens (Codex-like MCP resource helpers)
    const hasFullNetworkAccess = (policy: SandboxPolicy): boolean => {
      switch (policy.type) {
        case 'danger-full-access':
          return true;
        case 'external-sandbox':
          return policy.networkAccess === 'enabled';
        case 'read-only':
          return false;
        case 'workspace-write':
          // Backend default is true; keep UI estimation aligned.
          return policy.networkAccess ?? true;
        default:
          return false;
      }
    };

    let mcpPromptText = '';
    let mcpTokens = 0;
    const isToolRun = (session?.runMode ?? 'chat') !== 'chat';
    const mcpSetName = agent?.mcpSet;
    if (isToolRun && mcpSetName && config?.mcp?.sets?.length) {
      const securityPolicies = config?.security?.policies ?? [];
      const defaultPolicyName = config?.security?.defaultPolicy ?? securityPolicies[0]?.name ?? '';
      const basePolicyName = agent?.securityPolicy ?? defaultPolicyName;
      const basePolicy: SecurityPolicyConfig | undefined =
        securityPolicies.find((p) => p.name === basePolicyName) ??
        securityPolicies.find((p) => p.name === defaultPolicyName) ??
        securityPolicies[0];

      const sandboxPolicy: SandboxPolicy =
        (session?.runMode ?? 'chat') === 'agent-full-access'
          ? { type: 'danger-full-access' }
          : agent?.sandboxPolicy ?? basePolicy?.sandboxPolicy ?? { type: 'workspace-write', networkAccess: true };

      const allowMcpExec = hasFullNetworkAccess(sandboxPolicy);
      if (allowMcpExec) {
        const set = config.mcp.sets.find((s) => s.name === mcpSetName);
        if (set) {
          const serverMap = new Map(config.mcp.servers.map((e) => [e.name, e.config] as const));
          const hasEffectiveServer = (set.servers ?? []).some((s) => {
            if (!s.enabled) return false;
            const serverCfg = serverMap.get(s.server);
            return Boolean(serverCfg && serverCfg.enabled);
          });

          if (hasEffectiveServer) {
            mcpPromptText = (mcpResourceToolPromptTextFromBackend || '').trim();
            mcpTokens = estimateTokens(mcpPromptText);
          }
        }
      }
    }

    // Base context usage (system prompt + format prompt + skills + mcp)
    const baseTokens = systemPromptTokens + formatPromptTokens + skillsTokens + mcpTokens;

    const getTextFromBlocks = (blocks: MessageBlock[] | undefined): string => {
      if (!blocks || blocks.length === 0) return '';
      const texts: string[] = [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof (b as any).text === 'string' && (b as any).text.trim()) {
          texts.push((b as any).text);
        }
      }
      return texts.join('\n\n');
    };

    const sanitizeToolTextForModel = (text: string): string => {
      if (!text) return '';
      const trimmed = text.trim();
      if (!trimmed) return '';

      // Best-effort align with backend `sanitize_tool_text_for_model`:
      // - Strip ANSI codes in known string fields when the payload is JSON.
      // - Fallback to plain ANSI stripping for raw text.
      const maybeJsonContainer =
        trimmed.length <= 400_000 &&
        ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']')));
      if (maybeJsonContainer) {
        try {
          const v = JSON.parse(trimmed);
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const key of ['output', 'stdout', 'stderr', 'text', 'result']) {
              const cur = (v as any)[key];
              if (typeof cur === 'string') {
                (v as any)[key] = stripAnsi(cur);
              }
            }
            return JSON.stringify(v);
          }
        } catch {
          // ignore
        }
      }

      return stripAnsi(trimmed);
    };

    const estimateToolTraceTokens = (blocks: MessageBlock[] | undefined): number => {
      if (!blocks || blocks.length === 0) return 0;
      let tokens = 0;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_call') {
          const callId = String((b as any).callId ?? '').trim();
          const name = String((b as any).name ?? '').trim();
          const args = String((b as any).arguments ?? '').trim();
          const turn = typeof (b as any).turnIndex === 'number' ? (b as any).turnIndex : 0;
          tokens += estimateTokens(`[tool_call] turn=${turn} id=${callId} name=${name} args=`);
          tokens += estimateTokens(args);
        } else if (b.type === 'tool_result') {
          const callId = String((b as any).callId ?? '').trim();
          const rawText = String((b as any).text ?? '');
          const cleaned = sanitizeToolTextForModel(rawText);
          const turn = typeof (b as any).turnIndex === 'number' ? (b as any).turnIndex : 0;
          tokens += estimateTokens(`[tool_result] turn=${turn} id=${callId} text=`);
          tokens += estimateTokens(cleaned);
        } else if (b.type === 'web_search') {
          const callId = String((b as any).callId ?? '').trim();
          const status = String((b as any).status ?? '').trim();
          const turn = typeof (b as any).turnIndex === 'number' ? (b as any).turnIndex : 0;
          const action = (b as any).action;
          const actionStr = (() => {
            if (action === null || action === undefined) return 'null';
            try {
              return JSON.stringify(action);
            } catch {
              return String(action);
            }
          })();
          tokens += estimateTokens(`[web_search] turn=${turn} id=${callId} status=${status} action=`);
          tokens += estimateTokens(actionStr);
        }
      }
      return tokens;
    };

    // Predict next-request prompt tokens (instead of reusing last-request usage).
    const estimateMessagePromptTokens = (m: Message): number => {
      let total = 8 + estimateTokens(String(m.role ?? ''));

      const content = (() => {
        const direct = typeof m.content === 'string' ? m.content : '';
        if (direct.trim()) return direct;
        // Some providers may deliver visible text only via blocks (fullContent empty).
        return getTextFromBlocks(m.blocks);
      })();
      total += estimateTokens(content);

      if (contextMessageGroups.includeThinking && m.thinking && m.thinking.trim()) {
        total += estimateTokens(m.thinking);
      }

      // Backend prompt-view includes tool calls/results (either expanded into tool-role messages
      // or appended as [tool_trace]). Our message list doesn't include tool-role messages, so
      // we add an approximate token cost from persisted blocks to keep estimation close to actual usage.
      total += estimateToolTraceTokens(m.blocks);
      return total;
    };

    type TaskGroup = { messages: Message[]; tokens: number };
    const buildTaskGroups = (used: Message[]): TaskGroup[] => {
      const groups: TaskGroup[] = [];
      let cur: Message[] = [];
      for (const message of used) {
        if (message.role === 'user') {
          if (cur.length > 0) groups.push({ messages: cur, tokens: cur.reduce((acc, m) => acc + estimateMessagePromptTokens(m), 0) });
          cur = [message];
        } else {
          if (cur.length === 0) cur = [message];
          else cur.push(message);
        }
      }
      if (cur.length > 0) groups.push({ messages: cur, tokens: cur.reduce((acc, m) => acc + estimateMessagePromptTokens(m), 0) });
      return groups;
    };

    const policy = (agent?.contextPolicy ?? { type: 'simple' }) as any;
    const policyTypeRaw = String(policy?.type ?? 'simple').trim().toLowerCase();
    const policyType = policyTypeRaw === 'disabled' ? 'simple' : policyTypeRaw;
    const trimEnabled = (() => {
      if (policyType === 'custom') return true;
      return Boolean(policy?.enabled ?? true) && Boolean(policy?.trimEnabled ?? true);
    })();
    const hardLimitPercent = Math.max(1, Math.min(99, Number(policy?.hardLimitPercent ?? 90)));
    const trimTargetPercent = Math.max(
      1,
      Math.min(hardLimitPercent, Number(policy?.trimTargetPercent ?? hardLimitPercent))
    );

    let effectiveGroups: ContextMessageGroups = contextMessageGroups;
    let taskGroups = buildTaskGroups(contextMessageGroups.used);
    let messageTokens = taskGroups.reduce((acc, g) => acc + g.tokens, 0);
    let totalContextTokens = baseTokens + messageTokens;

	    if (trimEnabled && contextLength > 0) {
	      const hardLimitTokens = Math.max(1, Math.floor((contextLength * hardLimitPercent) / 100));
	      const trimTargetTokens = Math.max(
	        1,
	        Math.min(hardLimitTokens, Math.floor((contextLength * trimTargetPercent) / 100))
	      );

      if (totalContextTokens > hardLimitTokens && taskGroups.length > 0) {
        const keepMask = new Array<boolean>(taskGroups.length).fill(false);
        let selected = baseTokens;
        for (let i = taskGroups.length - 1; i >= 0; i--) {
          if (!keepMask.some(Boolean)) {
            keepMask[i] = true;
            selected += taskGroups[i].tokens;
            continue;
          }
          const next = selected + taskGroups[i].tokens;
          if (next <= trimTargetTokens) {
            keepMask[i] = true;
            selected = next;
          } else {
            break;
          }
        }

        const keptMessages = taskGroups
          .flatMap((g, i) => (keepMask[i] ? g.messages : []));
        const trimmedByToken = taskGroups
          .flatMap((g, i) => (keepMask[i] ? [] : g.messages));
        effectiveGroups = {
          ...contextMessageGroups,
          used: keptMessages,
          trimmed: [...contextMessageGroups.trimmed, ...trimmedByToken],
        };
        taskGroups = buildTaskGroups(keptMessages);
        messageTokens = taskGroups.reduce((acc, g) => acc + g.tokens, 0);
        totalContextTokens = baseTokens + messageTokens;
      }
	    }

	    const percentage = contextLength > 0 ? (totalContextTokens / contextLength) * 100 : 0;

	    // Use the latest server-returned usage as the "accurate total" reference.
	    // This reflects the last completed request (not the next predicted request).
	    const actualUsage = (() => {
	      for (let i = messages.length - 1; i >= 0; i--) {
	        const m = messages[i];
	        if (m?.usage) return m.usage;
	        const turns = m?.turns;
	        if (Array.isArray(turns) && turns.length > 0) {
	          for (let j = turns.length - 1; j >= 0; j--) {
	            const u = turns[j]?.usage;
	            if (u) return u;
	          }
	        }
	      }
	      return undefined;
	    })();

	    return {
	      systemPrompt: systemPromptTokens,
	      formatPrompt: formatPromptTokens,
	      skills: skillsTokens,
	      messages: messageTokens,
	      messageGroups: effectiveGroups,
	      tools: 0,  // Future: tool definitions
	      mcp: mcpTokens,
	      actualUsage,
	      systemPromptText: userSystemPrompt || undefined,
	      formatPromptText: formatPromptText || undefined,
	      skillsSectionText: skillsSectionText || undefined,
	      skillsInjectedText: skillsInjectedText || undefined,
	      mcpPromptText: mcpPromptText || undefined,
      total: totalContextTokens,
      limit: contextLength,
      percentage: Math.min(percentage, 100),
    };
  }, [
    currentModel,
    messages,
    session,
    getAgent,
    config,
    formatPromptTextFromBackend,
    skillsSectionTextFromBackend,
    mcpResourceToolPromptTextFromBackend,
    contextMessageGroups,
  ]);

  // 消息加载由 setCurrentConversation 负责，这里不再调用 loadMessages
  // 这样创建新对话时不会触发 loadMessages，避免竞态条件

  const [contextUsage, setContextUsage] = useState<ContextUsageBreakdown | null>(null);
  const contextUsageCalcIdRef = useRef(0);

  // Avoid briefly showing stale usage when switching sessions.
  useEffect(() => {
    markChatOpenProfile('chatView:contextUsage:reset', {
      sessionId: sessionId ?? undefined,
      conversationId: conversationId || undefined,
      meta: { hadPrev: Boolean(contextUsage) },
    });
    setContextUsage(null);
  }, [conversationId, sessionId]);

  // Compute usage off the render path to prevent blocking initial paint.
  useEffect(() => {
    contextUsageCalcIdRef.current += 1;
    const calcId = contextUsageCalcIdRef.current;

    markChatOpenProfile('chatView:contextUsage:scheduled', {
      sessionId: sessionId ?? undefined,
      conversationId: conversationId || undefined,
      meta: { messageCount: messages.length },
    });

    const run = () => {
      if (contextUsageCalcIdRef.current !== calcId) return;

      const startedAt =
        typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      markChatOpenProfile('chatView:contextUsage:compute:start', {
        sessionId: sessionId ?? undefined,
        conversationId: conversationId || undefined,
        meta: { messageCount: messages.length },
      });

      const next = computeContextUsage();
      if (contextUsageCalcIdRef.current !== calcId) return;

      const endedAt =
        typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      markChatOpenProfile('chatView:contextUsage:compute:done', {
        sessionId: sessionId ?? undefined,
        conversationId: conversationId || undefined,
        meta: {
          durationMs: Number((endedAt - startedAt).toFixed(1)),
          totalTokens: next?.total ?? 0,
          percentage: next?.percentage ?? 0,
        },
      });

      setContextUsage(next);
    };

    const w = globalThis as any;
    const requestIdleCallback: ((cb: () => void, opts?: { timeout?: number }) => number) | undefined =
      typeof w.requestIdleCallback === 'function' ? w.requestIdleCallback.bind(w) : undefined;
    const cancelIdleCallback: ((id: number) => void) | undefined =
      typeof w.cancelIdleCallback === 'function' ? w.cancelIdleCallback.bind(w) : undefined;

    let handle: number | ReturnType<typeof setTimeout> | null = null;
    if (requestIdleCallback) {
      handle = requestIdleCallback(run, { timeout: 400 });
    } else {
      handle = window.setTimeout(run, 0);
    }

    return () => {
      if (handle === null) return;
      if (requestIdleCallback && cancelIdleCallback) cancelIdleCallback(handle as number);
      else clearTimeout(handle);
    };
  }, [computeContextUsage]);

  // Note: Stream listener is set up in sessionStore to route events by conversationId

  const handleSend = async (content: string, thinking?: ThinkingMode, images?: ContentPart[]) => {
    if (!sessionId) {
      console.error('Cannot send message: no active session');
      return;
    }
    // Convert ThinkingMode to appropriate format for backend
    // - boolean: pass as-is (for chat_completions API)
    // - ThinkingLevel: pass as string (for responses API)
    let thinkingParam: boolean | string | undefined;
    if (thinking !== undefined) {
      if (typeof thinking === 'boolean') {
        thinkingParam = thinking;
      } else {
        // ThinkingLevel: convert to string or boolean
        // null -> false, others -> pass the level string
        thinkingParam = thinking === null ? false : thinking;
      }
    }
    await sendMessage(sessionId, content, thinkingParam, images);
  };

  const handleAbort = async () => {
    if (!sessionId) return;
    await abortGeneration(sessionId);
  };

  const handleAction = useCallback(async (action: import('../../types').Action) => {
    switch (action.action_type) {
      case 'copy':
        if (action.payload) {
          await navigator.clipboard.writeText(action.payload);
        }
        break;
      case 'retry':
        if (!sessionId) return;
        try {
          const parsed = action.payload ? (JSON.parse(action.payload) as { messageId?: string }) : {};
          const messageId = parsed.messageId;
          if (!messageId) return;
          await retryMessage(sessionId, messageId);
        } catch (e) {
          console.error('Failed to process retry action', e);
        }
        break;
	      case 'undo':
	        if (sessionId && action.payload) {
	          try {
	            const parsed = JSON.parse(action.payload) as { messageId?: string; content?: string };
            const messageId = parsed.messageId;
            if (!messageId) return;

            const allMessages = messagesRef.current;
            const targetIndex = allMessages.findIndex((m) => m.id === messageId);
            const resolvedUserMessage =
              targetIndex >= 0
                ? (() => {
                    const m = allMessages[targetIndex];
                    if (m.role === 'user') return m;
                    for (let i = targetIndex - 1; i >= 0; i--) {
                      if (allMessages[i].role === 'user') return allMessages[i];
                    }
                    return undefined;
                  })()
                : undefined;

	            const contentToRestore = resolvedUserMessage?.content ?? parsed.content ?? '';
	            const codeSnippetsToRestore =
	              resolvedUserMessage?.contentParts?.filter(
	                (p): p is CodeSnippetContentPart => p.type === 'code_snippet'
	              ) ?? [];
	            const partsToRestore =
	              resolvedUserMessage?.contentParts?.filter((p) => p.type !== 'text' && p.type !== 'code_snippet') ?? [];

	            undoToMessage(sessionId, messageId);
	            setSessionDraftCodeSnippets(sessionId, codeSnippetsToRestore);

	            if (inputRef.current) {
	              inputRef.current.setValue(contentToRestore);
	              inputRef.current.setContentParts(partsToRestore);
	              inputRef.current.focus();
            }
          } catch (e) {
            console.error("Failed to process undo action", e);
          }
        }
        break;
      case 'navigate':
        // For now, no router integrated in UI Store widely, just console or window.location?
        // App.tsx handles views via UI Store.
        // useUIStore.getState().setActiveView(...)
        // Need to import useUIStore.
        break;
      case 'link':
        if (action.payload) {
          await openUrl(action.payload);
        }
        break;
    }
  }, [openUrl, retryMessage, sessionId, undoToMessage]);

	  const handleAbortTool = useCallback(
	    (_callId: string) => {
	      if (!sessionId) return;
	      abortGeneration(sessionId).catch(console.error);
	    },
	    [abortGeneration, sessionId]
	  );

  const handleRetryTurn = useCallback(
    (assistantMessageId: string, turnId: string) => {
      if (!sessionId) return;
      retryTurn(sessionId, assistantMessageId, turnId).catch(console.error);
    },
    [retryTurn, sessionId]
  );

  const handleMessageListProfiler = useCallback(
    (
      _id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number,
      baseDuration: number
    ) => {
      markChatOpenProfile(`profiler:MessageList:${phase}`, {
        sessionId: sessionId ?? undefined,
        conversationId: conversationId || undefined,
        meta: {
          actualMs: Number(actualDuration.toFixed(1)),
          baseMs: Number(baseDuration.toFixed(1)),
        },
      });
    },
    [conversationId, sessionId]
  );

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      onPointerDownCapture={maybeAcknowledgeUnreadCompletion}
      onWheelCapture={maybeAcknowledgeUnreadCompletion}
      onKeyDownCapture={maybeAcknowledgeUnreadCompletion}
    >
      {(persistanceShellEnhance || Boolean(conversationId) || workspaceEnabled || (canExportChat && session)) && (
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <div className="flex min-w-0 items-center gap-2">
            {persistanceShellEnhance && (
              <button
                type="button"
                onClick={() => conversationId && setShowToolSessions(true)}
                className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                title="查看持久进程（跨任务 PTY 会话）"
                disabled={!conversationId}
              >
                <span>持久进程</span>
                <span className="rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {activeToolCount}
                </span>
              </button>
            )}
            {conversationId && (
              <button
                type="button"
                onClick={() => setShowAgentSessions(true)}
                className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                title="查看当前对话的子 Agent 会话"
              >
                <Bot size={14} />
                <span>子 Agent</span>
                <span className="rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {activeAgentSessionCount}
                </span>
              </button>
            )}

            <div className="flex min-w-0 items-center gap-1">
              {workspaceEnabled && (
                <div ref={workstudioMenuRef} className="relative flex min-w-0 items-center gap-1">
                  <WorkstudioSecurityModal
                    isOpen={workstudioSecurityOpen}
                    onClose={() => setWorkstudioSecurityOpen(false)}
                    workstudio={workstudio}
                  />

                  <button
                    type="button"
                    onClick={() => setWorkstudioMenuOpen((v) => !v)}
                    className="flex min-w-0 items-center gap-1 rounded border border-transparent px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                    title={workstudioLoading ? '加载中…' : workstudio?.mainFolder || 'Workstudio'}
                    disabled={!session?.conversationId}
                  >
                    <Folder size={14} className="shrink-0 text-gray-400" />
                    <span className="max-w-[360px] truncate">
                      {workstudioLoading ? '加载中…' : workstudio?.mainFolder ? workstudio.mainFolder : 'Workstudio'}
                    </span>
                    <ChevronDown
                      size={14}
                      className={workstudioMenuOpen ? 'shrink-0 rotate-180 transition-transform' : 'shrink-0 transition-transform'}
                    />
                  </button>

                  {workstudioMenuOpen && (
                    <div className="absolute left-0 top-full z-[200] mt-1 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                        onClick={() => {
                          setWorkstudioMenuOpen(false);
                          void openWorkstudioWindow();
                        }}
                      >
                        <Folder size={14} className="text-gray-500" />
                        <span>打开 Workstudio</span>
                      </button>

                      {showSetWorkstudioMainFolderMenu && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                          onClick={() => {
                            setWorkstudioMenuOpen(false);
                            void handleSetWorkstudioMainFolder();
                          }}
                        >
                          <Folder size={14} className="text-gray-500" />
                          <span>设置主目录…</span>
                        </button>
                      )}

                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                        onClick={() => {
                          setWorkstudioMenuOpen(false);
                          void handleOpenWorkstudioSecurity();
                        }}
                      >
                        <Shield size={14} className="text-gray-500" />
                        <span>编辑安全配置…</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => setOutlineOpen((v) => !v)}
                ref={outlineToggleButtonRef}
                className={[
                  'order-first flex items-center gap-1 rounded border border-transparent px-2 py-1 text-xs text-gray-600 hover:bg-gray-100',
                  'dark:text-gray-300 dark:hover:bg-gray-800',
                  outlineOpen ? 'bg-gray-100 dark:bg-gray-800' : '',
                ].join(' ')}
                title={outlineOpen ? '隐藏消息目录' : '显示消息目录'}
              >
                <ListOrdered size={14} className="shrink-0 text-gray-400" />
                <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {outlineItems.length}
                </span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {canExportChat && session && (
              <button
                type="button"
                disabled={exporting || !session.conversationId || session.messages.length === 0}
                onClick={handleExportChat}
                className="flex items-center gap-1.5 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                title={!session.conversationId ? '对话未绑定' : session.messages.length === 0 ? '暂无消息' : '导出对话为 .tauri.richtxt'}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>{exporting ? '导出中...' : '导出'}</span>
              </button>
            )}
          </div>
        </div>
      )}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          {chatWithScope && (
            <div className="border-b border-blue-100 bg-blue-50/70 px-4 py-3 text-xs dark:border-blue-900/40 dark:bg-blue-950/30">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 font-semibold text-blue-700 dark:text-blue-300">
                    <Code2 size={13} />
                    <span>Chat with 上下文</span>
                  </div>
                  <div className="mt-1 truncate text-gray-700 dark:text-gray-200">{chatWithScope.label}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                    <span className="rounded bg-white/80 px-1.5 py-0.5 dark:bg-gray-900/50">{chatWithScope.filePath}</span>
                    {chatWithScope.range && (
                      <span>
                        L{chatWithScope.range.startLine}:{chatWithScope.range.startColumn}
                        {' - '}
                        L{chatWithScope.range.endLine}:{chatWithScope.range.endColumn}
                      </span>
                    )}
                    {chatWithScope.languageId && <span>· {chatWithScope.languageId}</span>}
                  </div>
                </div>
                {session?.workstudioId && (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800/50 dark:bg-gray-900 dark:text-blue-300 dark:hover:bg-blue-900/20"
                    onClick={() => void openChatWithSource()}
                    title="定位到 Chat with 的代码选区"
                  >
                    <ExternalLink size={12} />
                    <span>定位源码</span>
                  </button>
                )}
              </div>
            </div>
          )}
          <React.Profiler id="MessageList" onRender={handleMessageListProfiler}>
            <MessageList
              ref={messageListRef}
              conversationId={conversationId}
              messages={messages}
              streamingBlocks={streamingBlocks}
              streamingTurns={streamingTurns}
              streamingAssistantMessageId={streamingAssistantMessageId}
              isGenerating={isGenerating}
              onAction={handleAction}
              onAbortTool={handleAbortTool}
              onRetryTurn={handleRetryTurn}
              onDropFiles={handleDropFilesToInput}
              onDropText={handleDropTextToInput}
            />
          </React.Profiler>
        </div>
        <div className="absolute inset-y-0 left-0 z-30">
          <div ref={outlinePanelRef} className="h-full">
            <ChatOutlinePanel
              items={outlineItems}
              selectedMessageId={selectedRequestMessageId}
              selectedFullText={selectedOutlineFullText}
              isOpen={outlineOpen}
              onToggle={() => setOutlineOpen((v) => !v)}
              onSelect={handleSelectOutline}
            />
          </div>
        </div>
      </div>
      {/* Conversation total token usage */}
      {showUsage && totalUsage && (
        <div className="flex justify-center px-4 py-1 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
          <span>
            对话总计: in:{totalUsage.promptTokens} out:{totalUsage.completionTokens} total:{totalUsage.totalTokens}
            {totalUsage.reasoningTokens ? ` (${totalUsage.reasoningTokens} reasoning)` : ''}
          </span>
        </div>
      )}
      {queuedMessages.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50/70 px-3 py-1.5 dark:border-amber-900/50 dark:bg-amber-900/10">
          <div className="mb-1 flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
              排队消息（{queuedMessages.length}）
            </div>
            <div className="text-[11px] text-amber-600/90 dark:text-amber-300/80">
              当前回复完成后将按顺序自动发送
            </div>
          </div>
          <div className="max-h-32 space-y-1 overflow-auto pr-1">
            {queuedMessages.map((item, index) => {
              const isEditing = editingQueueMessageId === item.id;
              const attachmentCount = item.images?.length ?? 0;
              const displayText = item.content.trim().length > 0 ? item.content : attachmentCount > 0 ? '（仅附件）' : '（空消息）';
              const canSave = editingQueueContent.trim().length > 0 || attachmentCount > 0;
              return (
                <div
                  key={item.id}
                  className="rounded border border-amber-200 bg-white/90 px-2 py-1.5 dark:border-amber-900/60 dark:bg-gray-900/80"
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-700 dark:bg-amber-900/50 dark:text-amber-200">
                      #{index + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <textarea
                          value={editingQueueContent}
                          onChange={(e) => setEditingQueueContent(e.target.value)}
                          rows={2}
                          className="w-full resize-y rounded border border-amber-200 bg-white px-2 py-1 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-amber-400 dark:border-amber-900/60 dark:bg-gray-950 dark:text-gray-100"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <div
                            className="min-w-0 flex-1 truncate text-xs text-gray-700 dark:text-gray-200"
                            title={displayText}
                          >
                            {displayText}
                          </div>
                          {(item.thinking !== undefined || attachmentCount > 0) && (
                            <div className="flex shrink-0 items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
                              {item.thinking !== undefined && (
                                <span className="rounded bg-amber-100/60 px-1 py-0.5 leading-none text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                                  thinking:{String(item.thinking)}
                                </span>
                              )}
                              {attachmentCount > 0 && (
                                <span className="rounded bg-gray-100/70 px-1 py-0.5 leading-none text-gray-700 dark:bg-gray-800/70 dark:text-gray-200">
                                  附件:{attachmentCount}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                      <button
                        type="button"
                        className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
                        disabled={index === 0}
                        title="上移"
                        onClick={() => sessionId && moveQueuedMessage(sessionId, item.id, 'up')}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
                        disabled={index === queuedMessages.length - 1}
                        title="下移"
                        onClick={() => sessionId && moveQueuedMessage(sessionId, item.id, 'down')}
                      >
                        <ArrowDown size={12} />
                      </button>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className="rounded p-1 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                            title="保存"
                            disabled={!canSave}
                            onClick={() => saveEditQueuedMessage(item.id)}
                          >
                            <Check size={12} />
                          </button>
                          <button
                            type="button"
                            className="rounded p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                            title="取消编辑"
                            onClick={cancelEditQueuedMessage}
                          >
                            <X size={12} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="rounded p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                          title="编辑"
                          onClick={() => beginEditQueuedMessage(item.id, item.content)}
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="rounded p-1 text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-900/20"
                        title="移除"
                        onClick={() => {
                          if (!sessionId) return;
                          if (editingQueueMessageId === item.id) cancelEditQueuedMessage();
                          removeQueuedMessage(sessionId, item.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <InputArea
        ref={inputRef}
        onSend={handleSend}
        onAbort={handleAbort}
        onCloneConversation={
          conversationId
            ? async () => {
                if (!sessionId) return;
                try {
                  await cloneConversation(sessionId);
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  console.error('cloneConversation failed:', err);
                  alert(`克隆失败：${message}`);
                }
              }
            : undefined
        }
        disabled={false}
        isGenerating={isGenerating}
        queuedCount={queuedMessages.length}
        runMode={session?.runMode ?? 'chat'}
        onRunModeChange={(mode) => {
          if (!sessionId) return;
          setSessionRunMode(sessionId, mode);
        }}
        agents={currentAgentForDisplay ? [currentAgentForDisplay] : []}
        currentAgentName={currentAgentForDisplay?.name || session?.agentName || ''}
        supportsThinking={supportsThinking}
        supportsVision={supportsVision}
        contextUsage={contextUsage}
        apiProtocol={apiProtocol}
        providerType={currentProviderType}
        value={draftContent}
        onValueChange={(value) => {
          if (!sessionId) return;
          setSessionDraftContent(sessionId, value);
        }}
        thinkingMode={thinkingMode}
        onThinkingModeChange={(value) => {
          if (!sessionId) return;
          setSessionThinkingMode(sessionId, value);
        }}
        useReasoningEffort={useReasoningEffort}
        modelOptions={getModelOptions()}
        currentModelRef={session?.modelRef || ''}
        onModelSelect={(modelRef) => {
          if (!sessionId) return;
          // 模型切换已支持跨协议适配：不再弹窗阻断，失败时仅在控制台记录。
          setSessionModel(sessionId, modelRef).catch(console.error);
        }}
        supportsWebSearch={supportsWebSearch}
        availableProviders={availableWebSearchProviders}
        selectedProvider={session?.webSearchProvider}
        onProviderSelect={(provider) => {
          if (!sessionId) return;
          useSessionStore.getState().setSessionWebSearchProvider(sessionId, provider);
        }}
		        webSearchDetails={webSearchDetails}
		        workstudio={workstudio ?? null}
		        workspaceMentions={session?.draftWorkspaceMentions ?? []}
		        onWorkspaceMentionsChange={(mentions) => {
		          if (!sessionId) return;
		          setSessionDraftWorkspaceMentions(sessionId, mentions);
		        }}
		        codeSnippets={session?.draftCodeSnippets ?? []}
		        onCodeSnippetsChange={(snips) => {
		          if (!sessionId) return;
		          setSessionDraftCodeSnippets(sessionId, snips);
		        }}
		      />
      {persistanceShellEnhance && conversationId && (
        <ToolSessionsPanel
          conversationId={conversationId}
          isOpen={showToolSessions}
          onClose={() => setShowToolSessions(false)}
        />
      )}
      {conversationId && (
        <AgentSessionsPanel
          conversationId={conversationId}
          isOpen={showAgentSessions}
          onClose={() => setShowAgentSessions(false)}
        />
      )}
    </div>
  );
};

export default ChatView;
