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
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
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

        return <UnknownBlock key={block.id} data={block.data} />;
      })}
    </>
  );
};
