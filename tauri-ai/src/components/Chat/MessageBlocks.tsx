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
import { Brain, ChevronDown, ChevronRight, Search, Wrench } from 'lucide-react';
import type { MessageBlock } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';

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

  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-green-700 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/50"
      >
        <Wrench size={16} className="shrink-0" />
        <span className="font-medium">工具调用：{name || 'unknown'}</span>
        {isStreaming && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-green-200 px-3 py-2 text-sm text-green-900 dark:border-green-800 dark:text-green-100">
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{prettyArgs}</pre>
        </div>
      )}
    </div>
  );
};

const ToolResultBlock: React.FC<{ text: string }> = ({ text }) => {
  if (!text) return null;
  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-white px-3 py-2 text-sm text-gray-800 dark:border-green-800 dark:bg-gray-900/40 dark:text-gray-100">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-green-700 dark:text-green-300">
        <Wrench size={14} />
        <span>工具结果</span>
      </div>
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
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
    if (!action || typeof action !== 'object') return null;
    const a = action as any;
    const type = typeof a.type === 'string' ? a.type : undefined;
    const query = typeof a.query === 'string' ? a.query : undefined;
    const queries = Array.isArray(a.queries) ? a.queries.filter((q: any) => typeof q === 'string') : undefined;
    const url = typeof a.url === 'string' ? a.url : undefined;
    const pattern = typeof a.pattern === 'string' ? a.pattern : undefined;
    const sources = Array.isArray(a.sources)
      ? a.sources
          .map((s: any) => (typeof s?.url === 'string' ? s.url : null))
          .filter((u: any) => typeof u === 'string')
      : undefined;

    return { type, query, queries, url, pattern, sources };
  }, [action]);

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
          {!info && <pre className="whitespace-pre-wrap break-words">{JSON.stringify(action, null, 2)}</pre>}

          {info && (
            <div className="space-y-2">
              {info.type && (
                <div className="text-xs text-blue-700 dark:text-blue-300">action: {info.type}</div>
              )}

              {info.type === 'search' && (info.queries?.length || info.query) && (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">queries</div>
                  <ul className="list-disc pl-5">
                    {(info.queries?.length ? info.queries : [info.query]).filter(Boolean).map((q: string) => (
                      <li key={q as string} className="break-words">
                        {q as string}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(info.type === 'open_page' || info.type === 'find') && info.url && (
                <div className="break-words">
                  <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">url</span>
                  <span>{info.url}</span>
                </div>
              )}

              {info.type === 'find' && info.pattern && (
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
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const MessageBlocks: React.FC<{ blocks: MessageBlock[]; isStreaming?: boolean }> = ({
  blocks,
  isStreaming,
}) => {
  if (!blocks || blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block) => {
        if (block.type === 'thinking') {
          return <ThinkingBlock key={block.id} text={block.text} isStreaming={isStreaming} />;
        }

        if (block.type === 'text') {
          const format = (block.format || 'markdown').toString();
          if (format === 'plain') {
            return (
              <p key={block.id} className="whitespace-pre-wrap">
                {block.text}
              </p>
            );
          }
          if (format === 'json') {
            return (
              <pre
                key={block.id}
                className="whitespace-pre-wrap break-words rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-900/40 dark:text-gray-100"
              >
                {block.text}
              </pre>
            );
          }
          return <MarkdownRenderer key={block.id} content={block.text} />;
        }

        if (block.type === 'tool_call') {
          return <ToolCallBlock key={block.id} name={block.name} args={block.arguments} isStreaming={isStreaming} />;
        }

        if (block.type === 'tool_result') {
          return <ToolResultBlock key={block.id} text={block.text} />;
        }

        if (block.type === 'web_search') {
          return <WebSearchBlock key={block.id} status={block.status} action={block.action} isStreaming={isStreaming} />;
        }

        return <UnknownBlock key={block.id} data={block.data} />;
      })}
    </>
  );
};
