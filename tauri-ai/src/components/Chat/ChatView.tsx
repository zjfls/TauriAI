/**
 * ChatView Component
 * Main chat interface composing MessageList and InputArea
 * Requirements: 2.3, 2.4, 4.1, 4.2, 4.3, 4.4
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { MessageList } from './MessageList';
import { InputArea, type InputAreaHandle } from './InputArea';
import { ToolSessionsPanel } from './ToolSessionsPanel';
import { countTokens } from '../../utils/tokenizer';
import { getApiProtocol } from '../../utils/apiUtils';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { TokenUsage, ContextUsageBreakdown, ContentPart, ThinkingMode, PtySessionInfo, Workstudio, Agent } from '../../types';
import { useToolSessionStore } from '../../stores/toolSessionStore';
import { openOrFocusViewWindow } from '../../utils/viewWindow';
import { ChevronDown } from 'lucide-react';

interface ChatViewProps {
  sessionId: string | null;
}

const EMPTY_PTY_SESSIONS: PtySessionInfo[] = [];

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const isSystemWorkstudioPath = (p: string) => normalizePath(p).includes('/.tauri-ai/workstudios/');

export const ChatView: React.FC<ChatViewProps> = ({ sessionId }) => {
  // Get session from SessionStore
  const {
    session,
    sendMessage,
    abortGeneration,
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
      setSessionModel: state.setSessionModel,
      undoToMessage: state.undoToMessage,
      setSessionRunMode: state.setSessionRunMode,
      setSessionThinkingMode: state.setSessionThinkingMode,
      setSessionDraftContent: state.setSessionDraftContent,
    }))
  );
  const [showToolSessions, setShowToolSessions] = useState(false);

  const inputRef = useRef<InputAreaHandle>(null);

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

  const { config, getProvider, getAgent, getModelOptions } = useConfigStore(
    useShallow((state) => ({
      config: state.config,
      getProvider: state.getProvider,
      getAgent: state.getAgent,
      getModelOptions: state.getModelOptions,
    }))
  );

  // Get current model's context length based on session's model or agent's default
  const currentModel = useMemo(() => {
    // Use session's modelRef, or fall back to agent's default modelRef
    const sessionModelRef = session?.modelRef;
    const agent = session ? getAgent(session.agentName) : null;
    const modelRef = sessionModelRef || agent?.modelRef;

    if (!modelRef) return null;

    const [providerName, modelName] = modelRef.split('/');
    const provider = getProvider(providerName);
    if (!provider) return null;

    return provider.models.find(m => m.name === modelName) || null;
  }, [config, session, getProvider, getAgent]);

  // Get provider type for current model (responses thinking levels differ by provider)
  const currentProviderType = useMemo(() => {
    const sessionModelRef = session?.modelRef;
    const agent = session ? getAgent(session.agentName) : null;
    const modelRef = sessionModelRef || agent?.modelRef;

    if (!modelRef) return undefined;

    const [providerName] = modelRef.split('/');
    return getProvider(providerName)?.type;
  }, [config, session, getProvider, getAgent]);

  // Check if current model supports thinking
  const supportsThinking = useMemo(() => {
    return currentModel?.capabilities?.thinking ?? false;
  }, [currentModel]);

  // Check if current model supports vision/images
  const supportsVision = useMemo(() => {
    return currentModel?.capabilities?.vision ?? false;
  }, [currentModel]);

  // Check if current model supports web search
  const supportsWebSearch = useMemo(() => {
    return currentModel?.capabilities?.webSearch ?? false;
  }, [currentModel]);

  const persistanceShellEnhance = useMemo(() => {
    if (!session) return false;
    const agent = getAgent(session.agentName);
    const toolsetName = agent?.toolset;
    if (!toolsetName) return false;
    const toolset = config?.tools?.toolsets?.find((t) => t.name === toolsetName);
    return Boolean(toolset?.persistanceShellEnhance);
  }, [session, getAgent, config]);

  // Check if current model uses reasoning_effort parameter
  const useReasoningEffort = useMemo(() => {
    return currentModel?.useReasoningEffort ?? false;
  }, [currentModel]);

  // Get API protocol type for thinking mode
  const apiProtocol = useMemo(() => {
    const sessionModelRef = session?.modelRef;
    const agent = session ? getAgent(session.agentName) : null;
    const modelRef = sessionModelRef || agent?.modelRef;

    if (!modelRef) return 'chat_completions';

    return getApiProtocol(modelRef, config?.providers || []);
  }, [session, getAgent, config]);

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
    if (!session) return false;
    const agent = getAgent(session.agentName);
    const agentType = agent?.type ?? 'chat';
    return agentType === 'tool' && (agent?.workspaceSupport ?? true);
  }, [session, getAgent]);

  const [workstudio, setWorkstudio] = useState<Workstudio | null>(null);
  const [workstudioLoading, setWorkstudioLoading] = useState(false);
  const [workstudioMenuOpen, setWorkstudioMenuOpen] = useState(false);
  const workstudioMenuRef = useRef<HTMLDivElement | null>(null);

  const currentAgentForDisplay = useMemo((): Agent | null => {
    if (!session) return null;
    return getAgent(session.agentName) ?? null;
  }, [session, getAgent]);

  useEffect(() => {
    if (!workspaceEnabled) {
      setWorkstudio(null);
      return;
    }
    const wsId = session?.workstudioId;
    const convId = session?.conversationId;
    if (!convId) return;

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

  const openWorkstudioWindow = useCallback((ws: Workstudio) => {
    void openOrFocusViewWindow('workstudio', `Workstudio: ${ws.mainFolder}`, {
      workstudioId: ws.id,
      label: `view-workstudio-${ws.id}`,
    });
  }, []);

  const ensureWorkstudio = useCallback(async (): Promise<Workstudio | null> => {
    let ws = workstudio;
    if (ws) return ws;
    if (!conversationId) return null;
    setWorkstudioLoading(true);
    try {
      ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
      setWorkstudio(ws);
      return ws;
    } catch {
      setWorkstudio(null);
      return null;
    } finally {
      setWorkstudioLoading(false);
    }
  }, [conversationId, workstudio]);

  const handleSetWorkstudioMainFolder = useCallback(async () => {
    const ws = await ensureWorkstudio();
    if (!ws) return;

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
      openWorkstudioWindow(updated);
    } catch (e) {
      console.error('set workstudio main folder failed:', e);
    } finally {
      setWorkstudioLoading(false);
    }
  }, [ensureWorkstudio, openWorkstudioWindow]);

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

  // Format prompt content (same as CHAT_FORMAT_PROMPT in backend)
  const FORMAT_PROMPT_CHAT = `

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
`;

  // Calculate context usage breakdown
  const contextUsage = useMemo((): ContextUsageBreakdown | null => {
    const contextLength = currentModel?.contextLength;
    if (!contextLength) return null;

    // Get system prompt and format type from session's agent
    const agent = session ? getAgent(session.agentName) : null;
    const userSystemPrompt = agent?.systemPrompt || '';
    const formatType = agent?.formatType || 'chat';

    // Calculate system prompt tokens (user's custom prompt) using accurate tokenizer
    const systemPromptTokens = countTokens(userSystemPrompt);

    // Calculate format prompt tokens based on format type
    let formatPromptTokens = 0;
    if (formatType === 'chat') {
      formatPromptTokens = countTokens(FORMAT_PROMPT_CHAT);
    } else if (formatType === 'plain') {
      formatPromptTokens = countTokens('\n\n请使用纯文本格式回复，不要使用 Markdown 或其他格式。');
    } else if (formatType === 'json') {
      formatPromptTokens = countTokens('\n\n请以 JSON 格式返回结果。');
    }
    // 'none' type has no format prompt

    // Base context usage (system prompt + format prompt, always present)
    const baseTokens = systemPromptTokens + formatPromptTokens;

    // Calculate message tokens
    let messageTokens = 0;
    let totalContextTokens = baseTokens;

    // Find the last message with usage data
    const lastMessageWithUsage = [...messages].reverse().find(m => m.usage);
    if (lastMessageWithUsage?.usage) {
      // promptTokens from API includes everything sent to the model
      totalContextTokens = lastMessageWithUsage.usage.promptTokens;
      // Message tokens = total - base prompts (approximate)
      messageTokens = Math.max(0, totalContextTokens - baseTokens);
    } else {
      // No usage data yet, estimate from message content using accurate tokenizer
      messageTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0);
      totalContextTokens = baseTokens + messageTokens;
    }

    const percentage = (totalContextTokens / contextLength) * 100;

    return {
      systemPrompt: systemPromptTokens,
      formatPrompt: formatPromptTokens,
      messages: messageTokens,
      tools: 0,  // Future: tool definitions
      mcp: 0,    // Future: MCP context
      total: totalContextTokens,
      limit: contextLength,
      percentage: Math.min(percentage, 100),
    };
  }, [currentModel, messages, session, getAgent]);

  // 消息加载由 setCurrentConversation 负责，这里不再调用 loadMessages
  // 这样创建新对话时不会触发 loadMessages，避免竞态条件

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

  const handleAction = async (action: import('../../types').Action) => {
    switch (action.action_type) {
      case 'copy':
        if (action.payload) {
          await navigator.clipboard.writeText(action.payload);
        }
        break;
      case 'retry':
        // For standard retry, we might need a message ID if payload is not enough context.
        // But here we rely on the component triggering it to pass context?
        // Wait, MessageToolbar triggers onAction(action).
        // Action payload doesn't necessarily have messageId.
        // We need to pass messageId TO the MessageToolbar or handle it in MessageItem wrapper.
        // Let's assume for MVP 'retry' action is context-aware via payload or we need to pass messageId.
        // Actually, the Store 'retry' takes `messageId`.
        // We need to know WHICH message triggered the action.
        // MessageItem knows the message. It passes `onAction`.
        // It should probably augment the action or we pass `(action, message)`?
        // Let's update `onAction` signature in MessageList/MessageItem to `(action, message)`.
        break;
      case 'undo':
        if (sessionId && action.payload) {
          try {
            const { messageId, content } = JSON.parse(action.payload);
            undoToMessage(sessionId, messageId);
            if (content && inputRef.current) {
              inputRef.current.setValue(content);
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
  };

  const handleAbortTool = useCallback(
    (_callId: string) => {
      if (!sessionId) return;
      abortGeneration(sessionId).catch(console.error);
    },
    [abortGeneration, sessionId]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {workspaceEnabled && (
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <div className="min-w-0">
            <div className="text-[11px] text-gray-400">工作区</div>
            <div
              className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100"
              title={workstudio?.mainFolder || ''}
            >
              {workstudioLoading
                ? '加载中...'
                : workstudio?.mainFolder
                  ? workstudio.mainFolder
                  : '(未绑定工作区)'}
            </div>
            {/* agent 已在输入框工具条展示，这里不重复显示 */}
          </div>
          <div ref={workstudioMenuRef} className="relative flex items-center">
            <button
              type="button"
              onClick={() => setWorkstudioMenuOpen((v) => !v)}
              disabled={workstudioLoading}
              className="flex items-center gap-1 rounded border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              title={workstudioLoading ? '加载中…' : 'Workstudio 菜单'}
            >
              <span>打开 Workstudio</span>
              <ChevronDown
                size={14}
                className={workstudioMenuOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
              />
            </button>

            {workstudioMenuOpen && (
              <div className="absolute right-0 top-full z-[120] mt-1 w-48 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
                {!workstudioLoading &&
                  (!workstudio?.mainFolder || isSystemWorkstudioPath(workstudio.mainFolder)) && (
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                      onClick={() => {
                        setWorkstudioMenuOpen(false);
                        void handleSetWorkstudioMainFolder();
                      }}
                    >
                      设置主目录…
                    </button>
                  )}

                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                  onClick={() => {
                    setWorkstudioMenuOpen(false);
                    void ensureWorkstudio().then((ws) => {
                      if (!ws) return;
                      openWorkstudioWindow(ws);
                    });
                  }}
                >
                  打开 Workstudio
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {persistanceShellEnhance && (
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
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
        </div>
      )}
      <MessageList
        messages={messages}
        streamingBlocks={streamingBlocks}
        streamingTurns={streamingTurns}
        isGenerating={isGenerating}
        onAction={handleAction}
        onAbortTool={handleAbortTool}
        onDropFiles={handleDropFilesToInput}
        onDropText={handleDropTextToInput}
      />
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
        webSearchEnabled={session?.webSearchEnabled ?? supportsWebSearch}
        onWebSearchToggle={(enabled) => {
          if (!sessionId) return;
          useSessionStore.getState().setSessionWebSearchEnabled(sessionId, enabled);
        }}
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
