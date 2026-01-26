/**
 * DebugModal Component
 * Displays raw HTTP request/response information in a structured format
 */

import React, { useEffect, useMemo, useState } from 'react';
import { X, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import type { DebugInfo, MessageBlock, MessageTurn, AnsiColorMode, AnsiRenderMode } from '../../types';
import { useConfigStore } from '../../stores/configStore';
import { AnsiText } from './AnsiText';

interface DebugModalProps {
  isOpen: boolean;
  onClose: () => void;
  debugInfo: DebugInfo | null;
  turns?: MessageTurn[] | null;
  blocks?: MessageBlock[] | null;
  initialTurnId?: string | null;
  messageRole: 'user' | 'assistant' | 'error';
}

interface CollapsibleSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultExpanded = true,
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-gray-800 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {title}
      </button>
      {isExpanded && (
        <div className="p-4 bg-white dark:bg-gray-900">{children}</div>
      )}
    </div>
  );
};

interface JsonViewerProps {
  data: unknown;
  label?: string;
}

interface TextViewerProps {
  text: string;
  label?: string;
  maxHeightClassName?: string;
  containerClassName?: string;
  renderAnsi?: boolean;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
}

type SseUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
};

// Check if response body contains SSE info
interface SseResponseBody {
  _sseInfo?: {
    chunkCount: number;
    note: string;
  };
  content?: string;
  thinking?: string | null;
  tool_calls?: unknown;
  usage?: SseUsage | null;
}

const isSseResponseBody = (data: unknown): data is SseResponseBody => {
  return typeof data === 'object' && data !== null && '_sseInfo' in data;
};

const JsonViewer: React.FC<JsonViewerProps> = ({ data, label }) => {
  const [copied, setCopied] = useState(false);
  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </div>
      )}
      <div className="relative group">
        <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-64 text-gray-800 dark:text-gray-200">
          {jsonString}
        </pre>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
};

const TextViewer: React.FC<TextViewerProps> = ({
  text,
  label,
  maxHeightClassName = 'max-h-64',
  containerClassName = 'bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  renderAnsi = false,
  ansiRenderMode,
  ansiColorMode,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </div>
      )}
      <div className="relative group">
        <pre
          className={`text-xs p-3 rounded-lg overflow-auto ${maxHeightClassName} whitespace-pre-wrap ${containerClassName}`}
        >
          {renderAnsi ? (
            <AnsiText text={text} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
          ) : (
            text
          )}
        </pre>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
};

// Component to display SSE response in a more readable format
interface SseResponseViewerProps {
  data: SseResponseBody;
}

const SseResponseViewer: React.FC<SseResponseViewerProps> = ({ data }) => {
  const [copied, setCopied] = useState(false);
  const usage: SseUsage | null = data.usage ?? null;

  const handleCopyContent = async () => {
    await navigator.clipboard.writeText(data.content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderUsageBlock: () => any = () => {
    if (!usage) {
      return (
        <div className="p-3 bg-yellow-50 dark:bg-yellow-900/30 rounded-lg">
          <div className="text-xs text-yellow-700 dark:text-yellow-300">
            ⚠️ 服务方未返回 Token 用量信息
          </div>
        </div>
      );
    }

    return (
      <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
        <div className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-2">Token 用量</div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-gray-500 dark:text-gray-400">输入: </span>
            <span className="text-gray-800 dark:text-gray-200">{usage.prompt_tokens}</span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">输出: </span>
            <span className="text-gray-800 dark:text-gray-200">{usage.completion_tokens}</span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">总计: </span>
            <span className="text-gray-800 dark:text-gray-200">{usage.total_tokens}</span>
          </div>
          {usage.cached_tokens && (
            <div>
              <span className="text-gray-500 dark:text-gray-400">缓存: </span>
              <span className="text-gray-800 dark:text-gray-200">{usage.cached_tokens}</span>
            </div>
          )}
          {usage.reasoning_tokens && (
            <div>
              <span className="text-gray-500 dark:text-gray-400">推理: </span>
              <span className="text-gray-800 dark:text-gray-200">{usage.reasoning_tokens}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* SSE Info Badge */}
      <div className="flex items-center gap-2">
        <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded text-xs font-medium">
          SSE Stream
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {data._sseInfo?.chunkCount} chunks
        </span>
      </div>

      {/* Usage Stats */}
      {renderUsageBlock()}

      {/* Thinking Content */}
      {data.thinking && (
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">思考内容</div>
          <pre className="text-xs bg-purple-50 dark:bg-purple-900/30 p-3 rounded-lg overflow-auto max-h-32 text-purple-800 dark:text-purple-200 whitespace-pre-wrap">
            {data.thinking}
          </pre>
        </div>
      )}

      {/* Tool Calls */}
      {data.tool_calls && (
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">工具调用</div>
          <JsonViewer data={data.tool_calls} />
        </div>
      )}

      {/* Main Content */}
      <div className="relative">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">响应内容</div>
        <div className="relative group">
          <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-64 text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
            {data.content || '(空)'}
          </pre>
          <button
            onClick={handleCopyContent}
            className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
            title="复制内容"
          >
            {copied ? (
              <Check size={14} className="text-green-500" />
            ) : (
              <Copy size={14} className="text-gray-500 dark:text-gray-400" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

interface HeadersViewerProps {
  headers: Record<string, string>;
}

const HeadersViewer: React.FC<HeadersViewerProps> = ({ headers }) => {
  // Mask sensitive headers
  const maskedHeaders = { ...headers };
  if (maskedHeaders['Authorization']) {
    const auth = maskedHeaders['Authorization'];
    if (auth.startsWith('Bearer ')) {
      maskedHeaders['Authorization'] = `Bearer ${auth.slice(7, 15)}...`;
    }
  }

  return (
    <div className="space-y-1">
      {Object.entries(maskedHeaders).map(([key, value]) => (
        <div key={key} className="flex text-xs">
          <span className="font-medium text-gray-600 dark:text-gray-400 w-40 shrink-0">
            {key}:
          </span>
          <span className="text-gray-800 dark:text-gray-200 break-all">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
};

export const DebugModal: React.FC<DebugModalProps> = ({
  isOpen,
  onClose,
  debugInfo,
  turns,
  blocks,
  initialTurnId,
  messageRole,
}) => {
  const { config } = useConfigStore();
  const ansiRenderMode = config?.general?.ansiRenderMode;
  const ansiColorMode = config?.general?.ansiColorMode;

  const sortedTurns = useMemo(
    () => (turns ?? []).slice().sort((a, b) => a.turnIndex - b.turnIndex),
    [turns]
  );
  const [activeTurnId, setActiveTurnId] = useState<string | null>(
    sortedTurns.length > 0
      ? (initialTurnId && sortedTurns.some((t) => t.turnId === initialTurnId)
        ? initialTurnId
        : sortedTurns[0].turnId)
      : (initialTurnId ?? null)
  );

  useEffect(() => {
    if (!isOpen) return;
    if (sortedTurns.length === 0) return;
    if (!activeTurnId || !sortedTurns.some((t) => t.turnId === activeTurnId)) {
      setActiveTurnId(sortedTurns[0].turnId);
    }
  }, [sortedTurns, activeTurnId, isOpen]);

  const activeTurn = activeTurnId
    ? sortedTurns.find((t) => t.turnId === activeTurnId) ?? null
    : null;
  const effectiveDebugInfo = activeTurn?.debugInfo ?? debugInfo;
  const effectiveBlocks = useMemo(() => {
    const allBlocks = blocks ?? [];
    if (allBlocks.length === 0) return [];
    if (!activeTurnId) return allBlocks;

    const byTurn = allBlocks.filter((b) => b.turnId === activeTurnId);
    if (byTurn.length > 0) return byTurn;

    const legacy = allBlocks.filter((b) => !b.turnId);
    return legacy.length > 0 ? legacy : allBlocks;
  }, [blocks, activeTurnId]);

  const thinkingText = useMemo(() => {
    const chunks = effectiveBlocks
      .filter((b): b is Extract<MessageBlock, { type: 'thinking' }> => b.type === 'thinking')
      .map((b) => b.text)
      .filter((t) => typeof t === 'string' && t.trim().length > 0);
    return chunks.length > 0 ? chunks.join('\n\n') : null;
  }, [effectiveBlocks]);

  const toolCalls = useMemo(
    () =>
      effectiveBlocks.filter(
        (b): b is Extract<MessageBlock, { type: 'tool_call' }> => b.type === 'tool_call'
      ),
    [effectiveBlocks]
  );
  const toolResults = useMemo(
    () =>
      effectiveBlocks.filter(
        (b): b is Extract<MessageBlock, { type: 'tool_result' }> => b.type === 'tool_result'
      ),
    [effectiveBlocks]
  );
  const webSearchBlocks = useMemo(
    () =>
      effectiveBlocks.filter(
        (b): b is Extract<MessageBlock, { type: 'web_search' }> => b.type === 'web_search'
      ),
    [effectiveBlocks]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-3xl max-h-[80vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            调试信息 - {messageRole === 'user' ? '请求' : messageRole === 'error' ? '错误' : '响应'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[calc(80vh-80px)] overflow-hidden">
          {/* Turn selector (multi-turn tasks) */}
          {sortedTurns.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {sortedTurns.map((t) => {
                const isActive = t.turnId === activeTurnId;
                const status = t.status || 'success';
                const statusClass =
                  status === 'success'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                    : status === 'aborted'
                      ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                      : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';

                return (
                  <button
                    key={t.turnId}
                    onClick={() => setActiveTurnId(t.turnId)}
                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                    title={t.model ? `model: ${t.model}` : undefined}
                  >
                    <span>Turn {t.turnIndex}</span>
                    <span className={`rounded px-2 py-0.5 ${statusClass}`}>{status}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="overflow-auto max-h-[calc(80vh-80px-72px)] space-y-4 pr-1">
          {thinkingText && (
            <CollapsibleSection title="思考过程" defaultExpanded={false}>
              <TextViewer
                text={thinkingText}
                containerClassName="bg-purple-50 dark:bg-purple-900/30 text-purple-800 dark:text-purple-200"
                maxHeightClassName="max-h-64"
              />
            </CollapsibleSection>
          )}

          {(toolCalls.length > 0 || webSearchBlocks.length > 0) && (
            <CollapsibleSection title="工具调用" defaultExpanded={false}>
              <div className="space-y-3">
                {toolCalls.map((call) => {
                  let prettyArgs: string = call.arguments;
                  try {
                    prettyArgs = JSON.stringify(JSON.parse(call.arguments), null, 2);
                  } catch {
                    // keep raw
                  }
                  return (
                    <div
                      key={call.id}
                      className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/30"
                    >
                      <div className="mb-2 text-xs font-medium text-green-800 dark:text-green-200">
                        {call.name} <span className="opacity-70">({call.callId})</span>
                      </div>
                      <TextViewer
                        text={prettyArgs}
                        maxHeightClassName="max-h-48"
                        containerClassName="bg-white/60 dark:bg-black/20 text-green-900 dark:text-green-100"
                      />
                    </div>
                  );
                })}

                {webSearchBlocks.map((b) => (
                  <div
                    key={b.id}
                    className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/30"
                  >
                    <div className="mb-2 text-xs font-medium text-blue-800 dark:text-blue-200">
                      web_search <span className="opacity-70">({b.callId})</span>
                    </div>
                    <JsonViewer
                      data={{
                        status: b.status,
                        action: b.action,
                      }}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {toolResults.length > 0 && (
            <CollapsibleSection title="工具输出" defaultExpanded={false}>
              <div className="space-y-3">
                {toolResults.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/40"
                  >
                    <div className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
                      call_id: <span className="font-mono">{r.callId}</span>
                    </div>
                    <TextViewer
                      text={r.text}
                      maxHeightClassName="max-h-64"
                      renderAnsi
                      ansiRenderMode={ansiRenderMode}
                      ansiColorMode={ansiColorMode}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {!effectiveDebugInfo ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <p>暂无调试信息</p>
              <p className="text-sm mt-2">请确保已开启调试模式并重新发送消息</p>
            </div>
          ) : (
            <>
              {/* Request Section */}
              {effectiveDebugInfo.request && (
                <CollapsibleSection title="HTTP 请求">
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded font-medium">
                        {effectiveDebugInfo.request.method}
                      </span>
                      <span className="text-gray-800 dark:text-gray-200 break-all">
                        {effectiveDebugInfo.request.url}
                      </span>
                    </div>

                    <CollapsibleSection title="请求头" defaultExpanded={false}>
                      <HeadersViewer headers={effectiveDebugInfo.request.headers} />
                    </CollapsibleSection>

                    <CollapsibleSection title="请求体">
                      <JsonViewer data={effectiveDebugInfo.request.body} />
                    </CollapsibleSection>
                  </div>
                </CollapsibleSection>
              )}

              {/* Response Section */}
              {effectiveDebugInfo.response && (
                <CollapsibleSection title="HTTP 响应">
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={`px-2 py-1 rounded font-medium ${
                          effectiveDebugInfo.response.status >= 200 &&
                          effectiveDebugInfo.response.status < 300
                            ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                            : 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {effectiveDebugInfo.response.status}
                      </span>
                    </div>

                    {Object.keys(effectiveDebugInfo.response.headers).length > 0 && (
                      <CollapsibleSection title="响应头" defaultExpanded={false}>
                        <HeadersViewer headers={effectiveDebugInfo.response.headers} />
                      </CollapsibleSection>
                    )}

                    <CollapsibleSection title="响应体">
                      {isSseResponseBody(effectiveDebugInfo.response.body) ? (
                        <SseResponseViewer data={effectiveDebugInfo.response.body} />
                      ) : (
                        <JsonViewer data={effectiveDebugInfo.response.body} />
                      )}
                    </CollapsibleSection>
                  </div>
                </CollapsibleSection>
              )}
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DebugModal;
