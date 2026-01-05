/**
 * MessageItem Component
 * Renders individual chat messages with proper styling
 * Requirements: 3.1, 3.2, 3.6
 */

import React, { useState } from 'react';
import { User, Bot, Copy, Check, RotateCcw } from 'lucide-react';
import type { Message } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageItemProps {
  message: Message;
  isStreaming?: boolean;
  onCopy: () => void;
  onRetry?: () => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isStreaming = false,
  onCopy,
  onRetry,
}) => {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    onCopy();
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`group flex gap-3 px-4 py-3 ${
        isUser ? 'flex-row-reverse' : 'flex-row'
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isUser
            ? 'bg-blue-500 text-white'
            : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
        }`}
      >
        {isUser ? <User size={18} /> : <Bot size={18} />}
      </div>

      {/* Message Content */}
      <div
        className={`relative max-w-[80%] rounded-2xl px-4 py-2 ${
          isUser
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100'
        }`}
      >
        {/* Model name label for assistant messages */}
        {isAssistant && message.meta?.model && (
          <div className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            {message.meta.model}
          </div>
        )}

        {/* Message content */}
        <div className={isUser ? 'text-white' : ''}>
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <MarkdownRenderer content={message.content} />
          )}
        </div>

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 dark:bg-gray-500" />
        )}

        {/* Action buttons - shown on hover */}
        {isHovered && !isStreaming && (
          <div
            className={`absolute -bottom-8 flex gap-1 ${
              isUser ? 'right-0' : 'left-0'
            }`}
          >
            <button
              onClick={handleCopy}
              className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              title="复制"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {isAssistant && onRetry && (
              <button
                onClick={onRetry}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                title="重试"
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageItem;
