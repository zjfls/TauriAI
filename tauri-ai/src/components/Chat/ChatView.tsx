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
import { Folder, ChevronDown, Shield } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { MessageList } from './MessageList';
import { InputArea, type InputAreaHandle } from './InputArea';
import { ToolSessionsPanel } from './ToolSessionsPanel';
import { estimateTokens, estimateTokensForTexts } from '../../utils/tokenizer';
import { getApiProtocol } from '../../utils/apiUtils';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { TokenUsage, ContextUsageBreakdown, ContextMessageGroups, ContentPart, ThinkingMode, PtySessionInfo, Workstudio, Agent, SkillEntry, SkillLoadOutcome, SandboxPolicy, SecurityPolicyConfig, Message, MessageBlock } from '../../types';
import { useToolSessionStore } from '../../stores/toolSessionStore';
import { endChatOpenProfile, getActiveChatOpenProfile, markChatOpenProfile } from '../../utils/chatOpenProfile';
import { openOrFocusViewWindow } from '../../utils/viewWindow';
import { WorkstudioSecurityModal } from './WorkstudioSecurityModal';
import type { WebSearchProvider } from './WebSearchToggle';

interface ChatViewProps {
  sessionId: string | null;
  /** 仅在“当前聚焦 Pane 的激活会话”里自动聚焦输入框（避免 keep-alive 多实例抢焦点） */
  autoFocus?: boolean;
}

const EMPTY_PTY_SESSIONS: PtySessionInfo[] = [];

export const ChatView: React.FC<ChatViewProps> = ({ sessionId, autoFocus = false }) => {
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
	    setSessionRunMode,
	    setSessionThinkingMode,
	    setSessionDraftContent,
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
	      setSessionRunMode: state.setSessionRunMode,
	      setSessionThinkingMode: state.setSessionThinkingMode,
	      setSessionDraftContent: state.setSessionDraftContent,
	    }))
	  );
  const [showToolSessions, setShowToolSessions] = useState(false);

  const inputRef = useRef<InputAreaHandle>(null);
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
  const streamingBlocks = session?.streamingBlocks ?? null;
  const streamingTurns = session?.streamingTurns ? Array.from(session.streamingTurns.values()) : undefined;
  const isGenerating = session?.isGenerating ?? false;
  const conversationId = session?.conversationId ?? '';
  const agentName = session?.agentName ?? null;

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  const workspaceEnabled = useMemo(() => {
    if (!agentName) return false;
    const agent = getAgent(agentName);
    const agentType = agent?.type ?? 'chat';
    return agentType === 'tool' && (agent?.workspaceSupport ?? true);
  }, [agentName, getAgent]);

  const [workstudio, setWorkstudio] = useState<Workstudio | null>(null);
  const [workstudioLoading, setWorkstudioLoading] = useState(false);
  const [workstudioMenuOpen, setWorkstudioMenuOpen] = useState(false);
  const [workstudioSecurityOpen, setWorkstudioSecurityOpen] = useState(false);
  const workstudioMenuRef = useRef<HTMLDivElement | null>(null);

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
    await openOrFocusViewWindow('workstudio', `Workstudio: ${ws.mainFolder}`, {
      workstudioId: ws.id,
      label: `view-workstudio-${ws.id}`,
    });
  }, [ensureWorkstudio]);

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
      await openOrFocusViewWindow('workstudio', `Workstudio: ${updated.mainFolder}`, {
        workstudioId: updated.id,
        label: `view-workstudio-${updated.id}`,
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
  }, [conversationId, isGenerating, refreshToolSessions, persistanceShellEnhance]);

  // Format prompt fallback: 真正的格式提示词以 `src-tauri/src/prompts.rs` 为准。
  // 这里不再复制完整内容，避免前后端漂移；非 Tauri 环境下仅用于 UI 估算/展示的兜底。
  const FORMAT_PROMPT_CHAT = '';
  /*

## 输出格式规范

### 基础格式（Markdown）
- 标题：# ## ###
- 列表：- 或 1. 2. 3.
- 强调：**粗体** *斜体* ~~删除线~~
- 代码：\`行内代码\` 或用三个反引号包裹代码块
- 链接：[文本](url)
- 引用：> 引用内容

### 表格（GFM格式，前后空行，单|分隔）
| A | B |
|---|---|
| 1 | 2 |

### 数学公式（LaTeX）
- 行内公式用单个 $ 包裹，如 $E = mc^2$
- 块级公式用 $$ 包裹，前后需空行

### 图表（Mermaid）
使用 mermaid 作为语言标记的代码块，支持 flowchart、sequence、gantt 等图表类型。

### 特殊元素（HTML 标签）
- 折叠内容：<details><summary>标题</summary>内容</details>
- 键盘按键：<kbd>Ctrl</kbd>
- 高亮文本：<mark>重点</mark>
- 上下标：H<sub>2</sub>O、x<sup>2</sup>

### 文件引用（可点击跳转）
- 引用文件时请使用行内代码包裹，如：`path/to/file.ts`、`src/app.ts:42`、`b/server/index.js#L10`
- 可接受格式：
  - `路径:行` 或 `路径:行:列`（1-based）
  - `路径#L行` 或 `路径#L行C列`（1-based）
- 允许相对路径或绝对路径（Windows 示例：`C:\repo\project\main.rs:12:5`）
- 优先使用相对主工作区根目录的相对路径（包含子目录），避免只写文件名（例如避免 `events.rs:96`）
- 不要使用 `file://` / `vscode://` 等 URI；请直接输出可解析的文件路径
- 支持“范围行号”用于选中（例如 `:10-20` / `#L10-L20`）；只需定位时优先给出起始行即可
  */

  // MCP resource helper prompt (same as MCP_RESOURCE_TOOL_PROMPT in backend)
  const MCP_RESOURCE_TOOL_PROMPT = `

## MCP (Model Context Protocol)

If MCP tools are available in the current tool list, you can use them to fetch additional context:

- \`list_mcp_resources\`: Lists resources provided by MCP servers.
- \`list_mcp_resource_templates\`: Lists parameterized resource templates.
- \`read_mcp_resource\`: Reads a specific resource from an MCP server.

Guidelines:
- Prefer MCP resources over web search when the information is available via MCP.
- Use \`list_mcp_resources\` / \`list_mcp_resource_templates\` to discover what's available before reading.
`;

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
    } else if (formatType === 'chat') {
      formatPromptText = FORMAT_PROMPT_CHAT;
      formatPromptTokens = estimateTokens(FORMAT_PROMPT_CHAT);
    } else if (formatType === 'plain') {
      formatPromptText = '\n\n请使用纯文本格式回复，不要使用 Markdown 或其他格式。';
      formatPromptTokens = estimateTokens(formatPromptText);
    } else if (formatType === 'json') {
      formatPromptText = '\n\n请以 JSON 格式返回结果。';
      formatPromptTokens = estimateTokens(formatPromptText);
    }
    // 'none' type has no format prompt

    // Skills tokens (Codex-like):
    // - Always inject the skills list/how-to section when a skill set is bound
    // - Only inject SKILL.md bodies when the user explicitly mentions "$skill-name"
    let skillsSectionText = '';
    let skillsInjectedText = '';
    let skillsTokens = 0;

    const skillSetName = agent?.skillSet;
    if (skillSetName && config?.skills?.sets?.length && skillOutcome?.skills?.length) {
      const set = config.skills.sets.find((s) => s.name === skillSetName);
      if (set && (set.enabled ?? true)) {
        const disabledGlobal = new Set(config.skills.disabledSkills ?? []);
        const disabledSet = new Set(set.disabledSkills ?? []);
        const setSkills = set.skills ?? [];
        const enabledNames =
          setSkills.length === 0 && set.name === '标准skill集'
            ? skillOutcome.skills
                .map((s) => s.meta.name)
                .filter((n) => !disabledGlobal.has(n) && !disabledSet.has(n))
            : setSkills.filter((n) => !disabledGlobal.has(n) && !disabledSet.has(n));
        const byName = new Map(skillOutcome.skills.map((s) => [s.meta.name, s]));
        const availableSkills = enabledNames.map((n) => byName.get(n)).filter(Boolean) as SkillEntry[];

        if (availableSkills.length > 0) {
          const lines: string[] = [];
          lines.push('## 技能（Skills）');
          lines.push(
            'Skill 是一组“可复用的本地指令”，存放在 `SKILL.md` 文件中。下面是本次会话可用的技能列表；每条包含名称、描述与文件路径，便于你打开查看完整说明。'
          );
          lines.push('### 可用技能');
          for (const skill of availableSkills) {
            const pathStr = skill.meta.path.replace(/\\/g, '/');
            lines.push(`- ${skill.meta.name}：${skill.meta.description}（文件：${pathStr}）`);
          }
          lines.push('### 使用规则');
          lines.push(
            '- 发现：以上列表是本次会话可用的技能（名称 + 描述 + 文件路径）。技能正文存放在对应路径下。'
          );
          lines.push(
            '- 触发规则：如果用户点名某个技能（用 `$SkillName` 或直接写技能名），或任务明显匹配上方技能描述，则本轮必须使用该技能；多次提及则同时使用；除非再次被提及，否则不要跨轮沿用技能。'
          );
          lines.push(
            '- 缺失/不可读：如果被点名的技能不在列表里或其路径无法读取，请简短说明，并用最佳替代方案继续。'
          );
          lines.push('- 如何使用技能（渐进式展开）：');
          lines.push('  1) 决定要用某个技能后，先打开它的 `SKILL.md`，只阅读到足以执行流程为止。');
          lines.push(
            '  2) 如果 `SKILL.md` 指向了额外目录（如 `references/`），只加载本次请求需要的具体文件，不要一次性全部加载。'
          );
          lines.push('  3) 如果有 `scripts/`，优先运行或修改脚本，而不是在聊天里手敲大段代码。');
          lines.push('  4) 如果有 `assets/` 或模板，优先复用，不要从零重造。');
          lines.push('- 协调与顺序：');
          lines.push(
            '  - 如果多个技能都适用，选择能覆盖需求的最小集合，并说明使用顺序。'
          );
          lines.push(
            '  - 简短说明你使用了哪些技能以及原因（一句话即可）；如果跳过了明显的技能，也要说明原因。'
          );
          lines.push('- 上下文卫生：');
          lines.push('  - 控制上下文体积：长内容尽量总结；只在需要时加载额外文件。');
          lines.push('  - 避免深度追引用：优先只打开 `SKILL.md` 直接链接的文件，除非遇到阻塞。');
          lines.push('  - 如存在多种变体（框架/提供商/领域），只选择最相关的参考文件，并说明选择理由。');
          lines.push(
            '- 安全与兜底：如果某个技能无法干净应用（缺文件/指令不清等），说明问题，选用次优方案继续推进。'
          );
          skillsSectionText = lines.join('\n');

          let lastUserText = '';
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role === 'user') {
              lastUserText = m.content || '';
              break;
            }
          }
          const mentioned = availableSkills.filter((s) => lastUserText.includes(`$${s.meta.name}`));
          if (mentioned.length > 0) {
            skillsInjectedText = mentioned
              .map((s) => {
                const body = s.contents.endsWith('\n') ? s.contents : `${s.contents}\n`;
                return `<skill>\n<name>${s.meta.name}</name>\n<path>${s.meta.path}</path>\n${body}</skill>\n\n`;
              })
              .join('');
          }

          skillsTokens = estimateTokens(skillsSectionText) + estimateTokens(skillsInjectedText);
        }
      }
    }

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
            mcpPromptText = MCP_RESOURCE_TOOL_PROMPT.trim();
            mcpTokens = estimateTokens(mcpPromptText);
          }
        }
      }
    }

    // Base context usage (system prompt + format prompt + skills + mcp)
    const baseTokens = systemPromptTokens + formatPromptTokens + skillsTokens + mcpTokens;

    // Calculate message tokens
    let messageTokens = 0;
    let totalContextTokens = baseTokens;

    // Find the last message with usage data (avoid copying/reversing large arrays)
    let lastMessageWithUsage: Message | null = null;
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 80; i--) {
      const m = messages[i];
      if (m?.usage) {
        lastMessageWithUsage = m;
        break;
      }
    }
    if (lastMessageWithUsage?.usage) {
      // promptTokens from API includes everything sent to the model
      totalContextTokens = lastMessageWithUsage.usage.promptTokens;
      // Message tokens = total - base prompts (approximate)
      messageTokens = Math.max(0, totalContextTokens - baseTokens);
    } else {
      // No usage data yet, estimate from messages that will actually be included in the next request.
      const used = contextMessageGroups.used;
      const contentTexts = used.map((m) => m.content).filter(Boolean);
      messageTokens = estimateTokensForTexts(contentTexts);
      if (contextMessageGroups.includeThinking) {
        const thinkingTexts = used
          .map((m) => m.thinking)
          .filter((t): t is string => Boolean(t && t.trim()));
        messageTokens += estimateTokensForTexts(thinkingTexts);
      }
      totalContextTokens = baseTokens + messageTokens;
    }

    const percentage = contextLength > 0 ? (totalContextTokens / contextLength) * 100 : 0;

    return {
      systemPrompt: systemPromptTokens,
      formatPrompt: formatPromptTokens,
      skills: skillsTokens,
      messages: messageTokens,
      messageGroups: contextMessageGroups,
      tools: 0,  // Future: tool definitions
      mcp: mcpTokens,
      systemPromptText: userSystemPrompt || undefined,
      formatPromptText: formatPromptText || undefined,
      skillsSectionText: skillsSectionText || undefined,
      skillsInjectedText: skillsInjectedText || undefined,
      mcpPromptText: mcpPromptText || undefined,
      total: totalContextTokens,
      limit: contextLength,
      percentage: Math.min(percentage, 100),
    };
  }, [currentModel, messages, session, getAgent, config, skillOutcome, workstudio?.mainFolder, formatPromptTextFromBackend, contextMessageGroups]);

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
            const partsToRestore =
              resolvedUserMessage?.contentParts?.filter((p) => p.type !== 'text') ?? [];

            undoToMessage(sessionId, messageId);

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
    <div className="flex h-full flex-col overflow-hidden">
      {(persistanceShellEnhance || workspaceEnabled || (canExportChat && session)) && (
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
	      <React.Profiler id="MessageList" onRender={handleMessageListProfiler}>
	        <MessageList
	          conversationId={conversationId}
	          messages={messages}
	          streamingBlocks={streamingBlocks}
	          streamingTurns={streamingTurns}
	          isGenerating={isGenerating}
	          onAction={handleAction}
	          onAbortTool={handleAbortTool}
	          onRetryTurn={handleRetryTurn}
	          onDropFiles={handleDropFilesToInput}
	          onDropText={handleDropTextToInput}
	        />
	      </React.Profiler>
      {/* Conversation total token usage */}
      {showUsage && totalUsage && (
        <div className="flex justify-center px-4 py-1 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
          <span>
            对话总计: in:{totalUsage.promptTokens} out:{totalUsage.completionTokens} total:{totalUsage.totalTokens}
            {totalUsage.reasoningTokens ? ` (${totalUsage.reasoningTokens} reasoning)` : ''}
          </span>
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
      />
      {persistanceShellEnhance && conversationId && (
        <ToolSessionsPanel
          conversationId={conversationId}
          isOpen={showToolSessions}
          onClose={() => setShowToolSessions(false)}
        />
      )}
    </div>
  );
};

export default ChatView;
