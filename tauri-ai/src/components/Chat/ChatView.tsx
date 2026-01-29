/**
 * ChatView Component
 * Main chat interface composing MessageList and InputArea
 * Requirements: 2.3, 2.4, 4.1, 4.2, 4.3, 4.4
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { MessageList } from './MessageList';
import { InputArea, type InputAreaHandle } from './InputArea';
import { ToolSessionsPanel } from './ToolSessionsPanel';
import { countTokens } from '../../utils/tokenizer';
import { getApiProtocol } from '../../utils/apiUtils';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { TokenUsage, ContextUsageBreakdown, ContentPart, ThinkingMode, PtySessionInfo, Workstudio, Agent, SkillEntry, SkillLoadOutcome, SandboxPolicy, SecurityPolicyConfig, Message, MessageBlock } from '../../types';
import { useToolSessionStore } from '../../stores/toolSessionStore';
import { openOrFocusViewWindow } from '../../utils/viewWindow';
import { ChevronDown } from 'lucide-react';
import type { WebSearchProvider } from './WebSearchToggle';

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

  const agentForSession = useMemo(() => {
    return session ? getAgent(session.agentName) ?? null : null;
  }, [session, getAgent]);

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
    if (!session) return;
    if (session.webSearchProvider !== undefined) return;

    const preferred =
      (availableWebSearchProviders.includes('native') ? 'native' : availableWebSearchProviders[0]) ??
      null;
    useSessionStore.getState().setSessionWebSearchProvider(sessionId, preferred);
  }, [sessionId, session, supportsWebSearch, availableWebSearchProviders]);

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

  // Determine if export should be shown based on format type (richtext)
  const canExportChat = useMemo(() => {
    if (!session) return false;
    const agent = getAgent(session.agentName);
    // Only 'chat' format (richtext) supports export
    return agent?.formatType === 'chat';
  }, [session, getAgent]);

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
  }, [session?.workstudioId, session?.conversationId]);

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

### 文件引用（可点击跳转）
- 引用文件时请使用行内代码包裹，如：`path/to/file.ts`、`src/app.ts:42`、`b/server/index.js#L10`
- 可接受格式：
  - `路径:行` 或 `路径:行:列`（1-based）
  - `路径#L行` 或 `路径#L行C列`（1-based）
- 允许相对路径或绝对路径（Windows 示例：`C:\repo\project\main.rs:12:5`）
- 不要使用 `file://` / `vscode://` 等 URI；请直接输出可解析的文件路径
- 不要输出“范围行号”（例如 `:10-20`）；需要定位时给出起始行即可
`;

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
    const agent = session ? getAgent(session.agentName) : null;
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
            includeContents: true,
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
  }, [session, getAgent, workstudio?.mainFolder]);

  // Calculate context usage breakdown
  const contextUsage = useMemo((): ContextUsageBreakdown | null => {
    if (!session) return null;
    const contextLength = currentModel?.contextLength ?? 0;

    // Get system prompt and format type from session's agent
    const agent = getAgent(session.agentName);
    const userSystemPrompt = agent?.systemPrompt || '';
    const formatType = agent?.formatType || 'chat';

    // Calculate system prompt tokens (user's custom prompt) using accurate tokenizer
    const systemPromptTokens = countTokens(userSystemPrompt);

    // Calculate format prompt tokens based on format type
    let formatPromptTokens = 0;
    let formatPromptText = '';
    if (formatType !== 'none' && formatPromptTextFromBackend) {
      formatPromptText = formatPromptTextFromBackend;
      formatPromptTokens = countTokens(formatPromptTextFromBackend);
    } else if (formatType === 'chat') {
      formatPromptText = FORMAT_PROMPT_CHAT;
      formatPromptTokens = countTokens(FORMAT_PROMPT_CHAT);
    } else if (formatType === 'plain') {
      formatPromptText = '\n\n请使用纯文本格式回复，不要使用 Markdown 或其他格式。';
      formatPromptTokens = countTokens(formatPromptText);
    } else if (formatType === 'json') {
      formatPromptText = '\n\n请以 JSON 格式返回结果。';
      formatPromptTokens = countTokens(formatPromptText);
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
          lines.push('## Skills');
          lines.push(
            'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.'
          );
          lines.push('### Available skills');
          for (const skill of availableSkills) {
            const pathStr = skill.meta.path.replace(/\\/g, '/');
            lines.push(`- ${skill.meta.name}: ${skill.meta.description} (file: ${pathStr})`);
          }
          lines.push('### How to use skills');
          lines.push(
            '- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.'
          );
          lines.push(
            "- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned."
          );
          lines.push(
            "- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback."
          );
          lines.push('- How to use a skill (progressive disclosure):');
          lines.push('  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.');
          lines.push(
            "  2) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything."
          );
          lines.push('  3) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.');
          lines.push('  4) If `assets/` or templates exist, reuse them instead of recreating from scratch.');
          lines.push('- Coordination and sequencing:');
          lines.push(
            "  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them."
          );
          lines.push(
            "  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why."
          );
          lines.push('- Context hygiene:');
          lines.push('  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.');
          lines.push("  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.");
          lines.push('  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.');
          lines.push(
            "- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue."
          );
          skillsSectionText = lines.join('\n');

          const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
          const mentioned = availableSkills.filter((s) => lastUserText.includes(`$${s.meta.name}`));
          if (mentioned.length > 0) {
            skillsInjectedText = mentioned
              .map((s) => {
                const body = s.contents.endsWith('\n') ? s.contents : `${s.contents}\n`;
                return `<skill>\n<name>${s.meta.name}</name>\n<path>${s.meta.path}</path>\n${body}</skill>\n\n`;
              })
              .join('');
          }

          skillsTokens = countTokens(skillsSectionText) + countTokens(skillsInjectedText);
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
            mcpTokens = countTokens(mcpPromptText);
          }
        }
      }
    }

    // Base context usage (system prompt + format prompt + skills + mcp)
    const baseTokens = systemPromptTokens + formatPromptTokens + skillsTokens + mcpTokens;

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

    const percentage = contextLength > 0 ? (totalContextTokens / contextLength) * 100 : 0;

    return {
      systemPrompt: systemPromptTokens,
      formatPrompt: formatPromptTokens,
      skills: skillsTokens,
      messages: messageTokens,
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
  }, [currentModel, messages, session, getAgent, config, skillOutcome, workstudio?.mainFolder, formatPromptTextFromBackend]);

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
            const parsed = JSON.parse(action.payload) as { messageId?: string; content?: string };
            const messageId = parsed.messageId;
            if (!messageId) return;

            const targetIndex = messages.findIndex((m) => m.id === messageId);
            const resolvedUserMessage =
              targetIndex >= 0
                ? (() => {
                    const m = messages[targetIndex];
                    if (m.role === 'user') return m;
                    for (let i = targetIndex - 1; i >= 0; i--) {
                      if (messages[i].role === 'user') return messages[i];
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
      {/* Chat toolbar with export button */}
      {canExportChat && session && (
        <div className="flex items-center justify-end border-b border-gray-100 px-4 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <button
            type="button"
            disabled={exporting || !session.conversationId || session.messages.length === 0}
            onClick={handleExportChat}
            className="flex items-center gap-1.5 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            title={!session.conversationId ? '对话未绑定' : session.messages.length === 0 ? '暂无消息' : '导出对话为 .tauri.richtxt'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>{exporting ? '导出中...' : '导出'}</span>
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
