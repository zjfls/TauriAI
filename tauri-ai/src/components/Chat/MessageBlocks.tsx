/**
 * MessageBlocks
 *
 * 统一的“输出块”渲染入口：
 * - 同一套渲染逻辑同时用于：历史消息（assistant.blocks）与 streaming（run:event）。
 * - 后续新增 tool/websearch/多模态输出时，只需要：
 *   1) 在 sessionStore 里把对应 blockType 聚合成 blocks
 *   2) 在这里补上对应 block 的渲染组件
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Brain, Bug, ChevronDown, ChevronRight, Search, Wrench } from 'lucide-react';
import type { MessageBlock, MessageTurn } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AnsiText } from './AnsiText';
import { useConfigStore } from '../../stores/configStore';
import { DebugModal } from './DebugModal';
import type { AnsiColorMode, AnsiRenderMode } from '../../types';

interface ThinkingBlockProps {
  text: string;
  isStreaming?: boolean;
}

const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ text, isStreaming }) => {
  const [isExpanded, setIsExpanded] = useState(Boolean(isStreaming));

  if (!text) return null;

  return (
    <div className="mb-2 rounded-lg border border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-purple-700 hover:bg-purple-100 dark:text-purple-300 dark:hover:bg-purple-900/50"
      >
        <Brain size={16} className="shrink-0" />
        <span className="font-medium">{isStreaming ? '思考中...' : '思考过程'}</span>
        {isStreaming && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-purple-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-purple-200 px-3 py-2 text-sm text-purple-800 dark:border-purple-800 dark:text-purple-200">
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap">{text}</div>
        </div>
      )}
    </div>
  );
};

const UnknownBlock: React.FC<{ data: unknown }> = ({ data }) => {
  const text = useMemo(() => {
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  return (
    <div className="mb-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-200">
      <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">Unknown block</div>
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
};

const ToolCallBlock: React.FC<{ name: string; args: string; isStreaming?: boolean }> = ({
  name,
  args,
  isStreaming,
}) => {
  const [isExpanded, setIsExpanded] = useState(Boolean(isStreaming));

  const prettyArgs = useMemo(() => {
    if (!args) return '';
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }, [args]);

  const summary = useMemo(() => {
    if (!args) return '';
    try {
      const v = JSON.parse(args);
      if (!v || typeof v !== 'object') return '';
      if (name === 'exec_command' && typeof (v as any).cmd === 'string') return (v as any).cmd;
      if (name === 'shell_command' && typeof (v as any).command === 'string') return (v as any).command;
      return '';
    } catch {
      return '';
    }
  }, [args, name]);

  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-green-700 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/50"
      >
        <Wrench size={16} className="shrink-0" />
        <span className="font-medium">工具调用：{name || 'unknown'}</span>
        {summary ? (
          <span className="ml-2 max-w-[50%] truncate font-mono text-xs text-green-700/70 dark:text-green-200/70">
            {summary}
          </span>
        ) : null}
        {isStreaming && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-green-200 px-3 py-2 text-sm text-green-900 dark:border-green-800 dark:text-green-100">
          <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2">{prettyArgs}</pre>
        </div>
      )}
    </div>
  );
};

const ToolRunBlock: React.FC<{
  name: string;
  args: string;
  resultText?: string;
  callId?: string;
  isStreaming?: boolean;
  onAbortTool?: (callId: string) => void;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
}> = ({
  name,
  args,
  resultText,
  callId,
  isStreaming,
  onAbortTool,
  ansiRenderMode,
  ansiColorMode,
}) => {
  const [isExpanded, setIsExpanded] = useState(Boolean(isStreaming));
  const canAbort = Boolean(onAbortTool && callId && isStreaming);

  const prettyArgs = useMemo(() => {
    if (!args) return '';
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }, [args]);

  const summary = useMemo(() => {
    if (!args) return '';
    try {
      const v = JSON.parse(args);
      if (!v || typeof v !== 'object') return '';
      if (name === 'exec_command' && typeof (v as any).cmd === 'string') return (v as any).cmd;
      if (name === 'shell_command' && typeof (v as any).command === 'string') return (v as any).command;
      return '';
    } catch {
      return '';
    }
  }, [args, name]);

  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/30">
      <div className="flex items-center gap-2 px-3 py-2 text-left text-sm text-green-700 dark:text-green-300">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left hover:bg-green-100 dark:hover:bg-green-900/50"
        >
          <Wrench size={16} className="shrink-0" />
          <span className="font-medium">工具：{name || 'unknown'}</span>
          {summary ? (
            <span className="ml-2 max-w-[60%] truncate font-mono text-xs text-green-700/70 dark:text-green-200/70">
              {summary}
            </span>
          ) : null}
          {isStreaming ? (
            <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
          ) : null}
          <span className="ml-auto">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        {canAbort ? (
          <button
            type="button"
            onClick={() => callId && onAbortTool?.(callId)}
            className="rounded border border-green-300 px-2 py-0.5 text-[10px] font-medium text-green-700 hover:bg-green-100 dark:border-green-700 dark:text-green-200 dark:hover:bg-green-900/40"
            title="强制关闭当前工具（将终止本轮）"
          >
            强制关闭
          </button>
        ) : null}
      </div>

      {isExpanded ? (
        <div className="border-t border-green-200 px-3 py-2 dark:border-green-800">
          {prettyArgs ? (
            <>
              <div className="mb-1 text-xs font-medium text-green-700/80 dark:text-green-200/80">参数</div>
              <pre className="mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-green-900 dark:text-green-100">
                {prettyArgs}
              </pre>
            </>
          ) : null}

          {resultText ? (
            <>
              <div className="mb-1 text-xs font-medium text-green-700/80 dark:text-green-200/80">输出</div>
              <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-gray-800 dark:text-gray-100">
                <AnsiText text={resultText} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
              </pre>
            </>
          ) : (
            <div className="text-xs text-green-700/70 dark:text-green-200/70">等待工具输出…</div>
          )}
        </div>
      ) : null}
    </div>
  );
};

const ToolResultBlock: React.FC<{
  text: string;
  callId?: string;
  isStreaming?: boolean;
  onAbortTool?: (callId: string) => void;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
}> = ({ text, callId, isStreaming, onAbortTool, ansiRenderMode, ansiColorMode }) => {
  if (!text) return null;
  const canAbort = Boolean(onAbortTool && callId && isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(isStreaming));

  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-white px-3 py-2 text-sm text-gray-800 dark:border-green-800 dark:bg-gray-900/40 dark:text-gray-100">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-green-700 dark:text-green-300">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-green-50 dark:hover:bg-green-900/20"
        >
          <Wrench size={14} />
          <span>工具结果</span>
          <span className="ml-auto">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        {canAbort ? (
          <button
            type="button"
            onClick={() => callId && onAbortTool?.(callId)}
            className="rounded border border-green-300 px-2 py-0.5 text-[10px] font-medium text-green-700 hover:bg-green-100 dark:border-green-700 dark:text-green-200 dark:hover:bg-green-900/40"
            title="强制关闭当前工具（将终止本轮）"
          >
            强制关闭
          </button>
        ) : null}
      </div>
      {isExpanded ? (
        <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2">
          <AnsiText text={text} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
        </pre>
      ) : null}
    </div>
  );
};

const ErrorBlock: React.FC<{
  text: string;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
}> = ({ text, ansiRenderMode, ansiColorMode }) => {
  if (!text) return null;

  return (
    <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-100">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
        <AlertTriangle size={14} />
        <span>错误</span>
      </div>
      <pre className="whitespace-pre-wrap break-words">
        <AnsiText text={text} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
      </pre>
    </div>
  );
};

const WebSearchBlock: React.FC<{ status: string; action?: unknown; isStreaming?: boolean }> = ({
  status,
  action,
  isStreaming,
}) => {
  const [isExpanded, setIsExpanded] = useState(Boolean(isStreaming));

  const info = useMemo(() => {
    if (!action) return null;

    const safeParse = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return value;
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return value;
        }
      }
      return value;
    };

    const normalizeValue = (value: string, maxLength = 240) => {
      const trimmed = value.trim();
      if (trimmed.length <= maxLength) return trimmed;
      return `${trimmed.slice(0, maxLength)}...`;
    };

    const stringifyAction = (value: unknown) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    };

    const parsedAction = typeof action === 'string' ? safeParse(action) : action;
    const rawText = stringifyAction(parsedAction ?? action);

    if (!parsedAction || typeof parsedAction !== 'object') {
      const text = parsedAction == null ? '' : String(parsedAction);
      const extras = text ? [{ label: 'action', value: normalizeValue(text) }] : [];
      return {
        rawType: undefined,
        normalizedType: undefined,
        query: undefined,
        queries: undefined,
        url: undefined,
        pattern: undefined,
        sources: undefined,
        extras,
        rawText,
        hasCoreDetails: false,
        hasDetails: extras.length > 0,
      };
    }

    const a = parsedAction as any;

    const rawType = typeof a.type === 'string' ? a.type : undefined;
    const normalizedType = rawType === 'find_in_page' ? 'find' : rawType;

    const openPage = a.open_page ?? a.openPage ?? a.page;
    const findInPage = a.find_in_page ?? a.findInPage ?? a.find;

    const pickString = (...values: Array<unknown>) =>
      values.find((v) => typeof v === 'string') as string | undefined;
    const pickStringArray = (...values: Array<unknown>) => {
      const arr = values.find((v) => Array.isArray(v)) as Array<unknown> | undefined;
      return arr?.filter((q): q is string => typeof q === 'string');
    };

    const query = pickString(a.query, a.search_query, a.searchQuery);
    const queries = pickStringArray(a.queries, a.search_queries, a.searchQueries);
    const url = pickString(
      a.url,
      openPage?.url,
      findInPage?.url,
      a.page_url,
      a.pageUrl,
      a.href,
      a.link
    );
    const pattern = pickString(a.pattern, findInPage?.pattern, findInPage?.query, a.text);

    const sources = Array.isArray(a.sources)
      ? (a.sources as Array<{ url?: unknown }>)
        .map((s) => (typeof s?.url === 'string' ? s.url : null))
        .filter((u): u is string => typeof u === 'string')
      : undefined;

    const usedValues = new Set<string>();
    if (query) usedValues.add(query);
    if (queries?.length) queries.forEach((q) => usedValues.add(q));
    if (url) usedValues.add(url);
    if (pattern) usedValues.add(pattern);
    if (sources?.length) sources.forEach((s) => usedValues.add(s));

    const extras: Array<{ label: string; value: string }> = [];
    const extraSet = new Set<string>();
    const skipKeys = new Set([
      'type',
      'query',
      'search_query',
      'searchQuery',
      'queries',
      'search_queries',
      'searchQueries',
      'url',
      'page_url',
      'pageUrl',
      'pattern',
      'sources',
    ]);

    const addExtra = (label: string, value: string) => {
      if (!value) return;
      const normalized = normalizeValue(value);
      if (!normalized) return;
      if (usedValues.has(normalized)) return;
      const key = `${label}:${normalized}`;
      if (extraSet.has(key)) return;
      extraSet.add(key);
      extras.push({ label, value: normalized });
    };

    const collectExtras = (obj: unknown, prefix: string, depth: number) => {
      if (!obj || typeof obj !== 'object') return;
      if (depth > 2) return;
      if (Array.isArray(obj)) {
        if (!obj.length) return;
        const stringItems = obj.filter((v) => typeof v === 'string') as string[];
        if (stringItems.length) {
          addExtra(prefix || 'items', stringItems.map((v) => normalizeValue(v)).join(', '));
          return;
        }
        const urlItems = obj
          .map((v: any) => (v && typeof v === 'object' ? v.url : null))
          .filter((v: any) => typeof v === 'string') as string[];
        if (urlItems.length) {
          addExtra(`${prefix || 'items'}.url`, urlItems.slice(0, 5).map((v) => normalizeValue(v)).join(', '));
        }
        addExtra(`${prefix || 'items'}.count`, String(obj.length));
        return;
      }

      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (skipKeys.has(key)) continue;
        const label = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
          addExtra(label, value);
          continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          addExtra(label, String(value));
          continue;
        }
        if (Array.isArray(value)) {
          collectExtras(value, label, depth + 1);
          continue;
        }
        if (value && typeof value === 'object') {
          collectExtras(value, label, depth + 1);
        }
      }
    };

    collectExtras(a, '', 0);

    const hasCoreDetails = Boolean(
      (queries && queries.length) ||
      query ||
      url ||
      pattern ||
      (sources && sources.length)
    );
    const hasDetails = hasCoreDetails || extras.length > 0;

    return {
      rawType,
      normalizedType,
      query,
      queries,
      url,
      pattern,
      sources,
      extras,
      rawText,
      hasCoreDetails,
      hasDetails,
    };
  }, [action]);

  const queryItems =
    info && info.normalizedType === 'search'
      ? (info.queries?.length ? info.queries : info.query ? [info.query] : []).filter(
        (q): q is string => typeof q === 'string' && q.trim().length > 0
      )
      : [];

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'in_progress':
        return '准备中';
      case 'searching':
        return '搜索中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      default:
        return status || 'unknown';
    }
  }, [status]);

  return (
    <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/50"
      >
        <Search size={16} className="shrink-0" />
        <span className="font-medium">联网搜索：{statusLabel}</span>
        {isStreaming && status !== 'completed' && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-blue-200 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:text-blue-100">
          {!info ? (
            isStreaming ? (
              <div className="flex space-x-1 py-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.3s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.15s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500" />
              </div>
            ) : (
              <div className="text-xs text-blue-700 dark:text-blue-300">暂无可展示信息</div>
            )
          ) : null}

          {info && (
            <div className="space-y-2">
              {info.rawType && info.rawType !== 'search' && (
                <div className="text-xs text-blue-700 dark:text-blue-300">action: {info.rawType}</div>
              )}

              {info.normalizedType === 'search' && queryItems.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">queries</div>
                  <ul className="list-disc pl-5">
                    {queryItems.map((q) => (
                      <li key={q} className="break-words">
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(info.normalizedType === 'open_page' || info.normalizedType === 'find') && info.url && (
                <div className="break-words">
                  <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">url</span>
                  <span>{info.url}</span>
                </div>
              )}

              {info.normalizedType === 'find' && info.pattern && (
                <div className="break-words">
                  <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">pattern</span>
                  <span>{info.pattern}</span>
                </div>
              )}

              {info.sources?.length ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">sources</div>
                  <ul className="list-disc pl-5">
                    {info.sources.map((u: string) => (
                      <li key={u} className="break-words">
                        {u}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {info.extras?.length ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">其他字段</div>
                  <ul className="list-disc space-y-1 pl-5">
                    {info.extras.map((item) => (
                      <li key={`${item.label}:${item.value}`} className="break-words">
                        <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">
                          {item.label}
                        </span>
                        <span>{item.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!info.hasCoreDetails && info.rawText ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">原始数据</div>
                  <pre className="whitespace-pre-wrap break-words">{info.rawText}</pre>
                </div>
              ) : null}

              {!info.hasDetails && (
                <div className="text-xs text-blue-700 dark:text-blue-300">未找到可展示字段</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const MessageBlocks: React.FC<{
  blocks: MessageBlock[];
  isStreaming?: boolean;
  turns?: MessageTurn[];
  onAbortTool?: (callId: string) => void;
}> = ({ blocks, isStreaming, turns, onAbortTool }) => {
  if (!blocks || blocks.length === 0) return null;

  const { config } = useConfigStore();
  const debugMode = config?.general?.debugMode ?? false;
  const ansiRenderMode = config?.general?.ansiRenderMode;
  const ansiColorMode = config?.general?.ansiColorMode;
  const [activeDebugTurn, setActiveDebugTurn] = useState<MessageTurn | null>(null);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());

  const turnMetaById = useMemo(() => {
    const map = new Map<string, MessageTurn>();
    for (const t of turns || []) {
      map.set(t.turnId, t);
    }
    return map;
  }, [turns]);

  const distinctTurnIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of blocks) {
      if (b.turnId) set.add(b.turnId);
    }
    return set;
  }, [blocks]);
  const showTurnHeader = distinctTurnIds.size > 0;

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        turnId?: string;
        turnIndex?: number;
        blocks: MessageBlock[];
      }
    >();
    const order: string[] = [];

    for (const block of blocks) {
      const key = block.turnId || '__legacy__';
      const existing = map.get(key);
      if (!existing) {
        order.push(key);
        const meta = block.turnId ? turnMetaById.get(block.turnId) : undefined;
        map.set(key, {
          key,
          turnId: block.turnId,
          turnIndex: meta?.turnIndex ?? block.turnIndex,
          blocks: [block],
        });
        continue;
      }

      existing.blocks.push(block);
      if (existing.turnIndex === undefined) {
        const meta = existing.turnId ? turnMetaById.get(existing.turnId) : undefined;
        existing.turnIndex = meta?.turnIndex ?? block.turnIndex;
      }
    }

    const pairToolBlocks = (turnBlocks: MessageBlock[]): MessageBlock[] => {
      const toolResultsByCallId = new Map<string, MessageBlock[]>();
      for (const b of turnBlocks) {
        if (b.type !== 'tool_result') continue;
        const callId = b.callId || '';
        const list = toolResultsByCallId.get(callId) ?? [];
        list.push(b);
        toolResultsByCallId.set(callId, list);
      }

      const used = new Set<string>();
      const ordered: MessageBlock[] = [];

      for (const b of turnBlocks) {
        if (used.has(b.id)) continue;

        if (b.type === 'tool_call') {
          ordered.push(b);
          used.add(b.id);

          const callId = b.callId || '';
          const results = toolResultsByCallId.get(callId);
          const nextResult = results && results.length > 0 ? results.shift() : undefined;
          if (nextResult && !used.has(nextResult.id)) {
            ordered.push(nextResult);
            used.add(nextResult.id);
          }
          continue;
        }

        if (b.type === 'tool_result') {
          // 先跳过：稍后按剩余顺序追加，避免把结果挤到最前面
          continue;
        }

        ordered.push(b);
        used.add(b.id);
      }

      for (const b of turnBlocks) {
        if (b.type !== 'tool_result') continue;
        if (used.has(b.id)) continue;
        ordered.push(b);
        used.add(b.id);
      }

      return ordered;
    };

    return order.map((key) => {
      const g = map.get(key)!;
      return { ...g, blocks: pairToolBlocks(g.blocks) };
    });
  }, [blocks, turnMetaById]);

  const renderBlock = (block: MessageBlock) => {
    if (block.type === 'thinking') {
      return <ThinkingBlock text={block.text} isStreaming={isStreaming} />;
    }

    if (block.type === 'text') {
      const format = (block.format || 'markdown').toString();
      if (format === 'plain') {
        return <p className="whitespace-pre-wrap">{block.text}</p>;
      }
      if (format === 'json') {
        return (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
            {block.text}
          </pre>
        );
      }
      return <MarkdownRenderer content={block.text} />;
    }

    if (block.type === 'tool_call') {
      return (
        <ToolCallBlock name={block.name} args={block.arguments} isStreaming={isStreaming} />
      );
    }

    if (block.type === 'tool_result') {
      return (
        <ToolResultBlock
          text={block.text}
          callId={block.callId}
          isStreaming={isStreaming}
          onAbortTool={onAbortTool}
          ansiRenderMode={ansiRenderMode}
          ansiColorMode={ansiColorMode}
        />
      );
    }

    if (block.type === 'error') {
      return (
        <ErrorBlock
          text={block.text}
          ansiRenderMode={ansiRenderMode}
          ansiColorMode={ansiColorMode}
        />
      );
    }

    if (block.type === 'web_search') {
      return <WebSearchBlock status={block.status} action={block.action} isStreaming={isStreaming} />;
    }

    return <UnknownBlock data={block.data} />;
  };

  return (
    <>
      {groups.map((g, idx) => {
        const turnMeta = g.turnId ? turnMetaById.get(g.turnId) : undefined;
        const turnIndex = turnMeta?.turnIndex ?? g.turnIndex ?? idx + 1;
        const debugInfo = turnMeta?.debugInfo;
        // debugMode 只影响“采集”，不影响“查看历史里已经存在的 debug 数据”。
        const canOpenDebug = Boolean(debugInfo);
        const debugButtonDisabled = !debugInfo;
        const debugTitle = debugInfo
          ? '查看该轮请求/响应'
          : debugMode
            ? '该轮暂无调试数据'
            : '开启调试模式后可查看该轮请求/响应';
        const isCollapsed = Boolean(g.turnId && collapsedTurns.has(g.turnId));

        return (
          <div key={`${g.key}:${idx}`}>
            {showTurnHeader && g.turnId ? (
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="select-text text-[10px] font-mono text-gray-400 dark:text-gray-500"
                    title={g.turnId}
                  >
                    第 {turnIndex} 轮
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCollapsedTurns((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.turnId!)) next.delete(g.turnId!);
                        else next.add(g.turnId!);
                        return next;
                      });
                    }}
                    className="flex items-center gap-1 rounded bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-100 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:bg-gray-800"
                    title={isCollapsed ? '展开本轮' : '收起本轮'}
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span>{isCollapsed ? '展开' : '收起'}</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => canOpenDebug && setActiveDebugTurn(turnMeta || null)}
                  disabled={debugButtonDisabled}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${canOpenDebug
                    ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                    : 'cursor-not-allowed bg-gray-50 text-gray-300 dark:bg-gray-900/40 dark:text-gray-700'
                    }`}
                  title={debugTitle}
                >
                  <Bug size={12} />
                  <span>Debug</span>
                </button>
              </div>
            ) : null}

            {isCollapsed ? null : (
              g.blocks.map((block, blockIdx) => {
                if (block.type === 'tool_call') {
                  const next = g.blocks[blockIdx + 1];
                  if (next && next.type === 'tool_result' && next.callId === block.callId) {
                    return (
                      <ToolRunBlock
                        key={`${block.id}:${next.id}`}
                        name={block.name}
                        args={block.arguments}
                        resultText={next.text}
                        callId={block.callId}
                        isStreaming={isStreaming}
                        onAbortTool={onAbortTool}
                        ansiRenderMode={ansiRenderMode}
                        ansiColorMode={ansiColorMode}
                      />
                    );
                  }
                }

                if (block.type === 'tool_result') {
                  const prev = g.blocks[blockIdx - 1];
                  if (prev && prev.type === 'tool_call' && prev.callId === block.callId) {
                    return null;
                  }
                }

                return <React.Fragment key={block.id}>{renderBlock(block)}</React.Fragment>;
              })
            )}
          </div>
        );
      })}

      <DebugModal
        isOpen={!!activeDebugTurn}
        onClose={() => setActiveDebugTurn(null)}
        debugInfo={activeDebugTurn?.debugInfo || null}
        blocks={blocks}
        initialTurnId={activeDebugTurn?.turnId || null}
        messageRole="assistant"
      />
    </>
  );
};
