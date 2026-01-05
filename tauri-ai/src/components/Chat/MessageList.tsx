/**
 * MessageList Component
 * Displays a scrollable list of messages with auto-scroll
 * Requirements: 2.3, 3.5
 */

import React, { useEffect, useRef } from 'react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Bot } from 'lucide-react';

interface MessageListProps {
  messages: Message[];
  streamingContent: string | null;
  isGenerating: boolean;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingContent,
  isGenerating: _isGenerating,
}) => {
  // Note: isGenerating is available for future use (e.g., loading indicators)
  void _isGenerating;
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or streaming content updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleCopy = () => {
    // Copy feedback handled in MessageItem
  };

  const handleRetry = (messageId: string) => {
    // TODO: Implement retry functionality
    console.log('Retry message:', messageId);
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      {/* Empty state */}
      {messages.length === 0 && !streamingContent && (
        <div className="flex h-full flex-col items-center justify-center text-gray-400">
          <Bot size={48} className="mb-4" />
          <p className="text-lg">开始新对话</p>
          <p className="text-sm">在下方输入消息开始聊天</p>
        </div>
      )}

      {/* Message list */}
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          onCopy={handleCopy}
          onRetry={
            message.role === 'assistant'
              ? () => handleRetry(message.id)
              : undefined
          }
        />
      ))}

      {/* Streaming message */}
      {streamingContent !== null && (
        <div className="group flex gap-3 px-4 py-3">
          {/* AI Avatar */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            <Bot size={18} />
          </div>

          {/* Streaming content */}
          <div className="relative max-w-[80%] rounded-2xl bg-white px-4 py-2 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
            {streamingContent ? (
              <MarkdownRenderer content={streamingContent} />
            ) : null}
            {/* Blinking cursor */}
            <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 dark:bg-gray-500" />
          </div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
};

export default MessageList;
