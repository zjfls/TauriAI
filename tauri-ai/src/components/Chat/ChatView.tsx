/**
 * ChatView Component
 * Main chat interface composing MessageList and InputArea
 * Requirements: 2.3, 2.4, 4.1, 4.2, 4.3, 4.4
 */

import React, { useMemo, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { MessageList } from './MessageList';
import { InputArea, type InputAreaHandle } from './InputArea';
import { countTokens } from '../../utils/tokenizer';
import { getApiProtocol } from '../../utils/apiUtils';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { TokenUsage, ContextUsageBreakdown, ContentPart, ThinkingMode } from '../../types';

interface ChatViewProps {
  sessionId: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({ sessionId }) => {
  // Get session from SessionStore
  const session = useSessionStore((state) =>
    sessionId ? state.sessions.get(sessionId) : undefined
  );
  const sendMessage = useSessionStore((state) => state.sendMessage);
  const abortGeneration = useSessionStore((state) => state.abortGeneration);
  const setSessionAgent = useSessionStore((state) => state.setSessionAgent);
  const setSessionModel = useSessionStore((state) => state.setSessionModel);
  const undoToMessage = useSessionStore((state) => state.undoToMessage);
  const setSessionThinkingMode = useSessionStore((state) => state.setSessionThinkingMode);
  const setSessionDraftContent = useSessionStore((state) => state.setSessionDraftContent);

  const inputRef = useRef<InputAreaHandle>(null);

  // Extract session state with defaults for when no session exists
  const messages = session?.messages ?? [];
  const streamingBlocks = session?.streamingBlocks ?? null;
  const isGenerating = session?.isGenerating ?? false;

  const { config, getProvider, getAgent, getModelOptions } = useConfigStore();

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

  // Check if current model supports thinking
  const supportsThinking = useMemo(() => {
    return currentModel?.capabilities?.thinking ?? false;
  }, [currentModel]);

  // Check if current model supports vision/images
  const supportsVision = useMemo(() => {
    return currentModel?.capabilities?.vision ?? false;
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MessageList
        messages={messages}
        streamingBlocks={streamingBlocks}
        isGenerating={isGenerating}
        onAction={handleAction}
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
        supportsThinking={supportsThinking}
        supportsVision={supportsVision}
        contextUsage={contextUsage}
        apiProtocol={apiProtocol}
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
        agents={config?.agents || []}
        currentAgentName={session?.agentName || ''}
        onAgentSelect={(agentName) => sessionId && setSessionAgent(sessionId, agentName)}
        modelOptions={getModelOptions()}
        currentModelRef={session?.modelRef || ''}
        onModelSelect={async (modelRef) => {
          if (!sessionId) return;
          try {
            await setSessionModel(sessionId, modelRef);
          } catch (error) {
            // Show error for API type incompatibility
            alert((error as Error).message || '无法切换模型');
          }
        }}
      />
    </div>
  );
};

export default ChatView;
