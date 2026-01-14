/**
 * MessageItem Component
 * Renders individual chat messages with proper styling
 * Requirements: 3.1, 3.2, 3.6
 */

import React, { useState } from 'react';
import { User, Bot } from 'lucide-react';
import type { Message, Action } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageToolbar } from './MessageToolbar';
import { buildMessageActions } from '../../utils/messageActionBuilder';

interface MessageItemProps {
  message: Message;
  isStreaming?: boolean;
  onAction: (action: Action) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isStreaming = false,
  onAction,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  // Build actions
  const actions = buildMessageActions(message);

  return (
    <div
      className={`group flex gap-3 px-4 py-3 ${isUser ? 'flex-row-reverse' : 'flex-row'
        }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isUser
          ? 'bg-blue-500 text-white'
          : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
          }`}
      >
        {isUser ? <User size={18} /> : <Bot size={18} />}
      </div>

      {/* Message Content */}
      <div
        className={`relative max-w-[80%] rounded-2xl px-4 py-2 ${isUser
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

        {/* Action buttons - always rendered for layout stability, visible on hover */}
        {!isStreaming && actions.length > 0 && (
          <div
            className={`mt-2 flex gap-1 transition-opacity ${
              isHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <MessageToolbar actions={actions} onAction={onAction} />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageItem;
