/**
 * MessageList Component
 * Displays a scrollable list of messages with smart auto-scroll
 * Requirements: 2.3, 3.5
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';
import { ErrorBubble } from './ErrorBubble';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Bot, ArrowDown } from 'lucide-react';
import type { Action } from '../../types';

interface MessageListProps {
  messages: Message[];
  streamingContent: string | null;
  isGenerating: boolean;
  onAction: (action: Action) => void;
}

// Threshold in pixels to consider "at bottom"
const SCROLL_THRESHOLD = 50;

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingContent,
  isGenerating: _isGenerating,
  onAction,
}) => {
  void _isGenerating;
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  
  // Track if user is at bottom (should auto-scroll)
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Track if user manually scrolled away
  const [userScrolledAway, setUserScrolledAway] = useState(false);

  // Check if scroll position is at bottom
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
  }, []);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const atBottom = checkIfAtBottom();
    setIsAtBottom(atBottom);
    
    // If user scrolls away from bottom during streaming, mark as manually scrolled
    if (!atBottom && streamingContent !== null) {
      setUserScrolledAway(true);
    }
    
    // If user scrolls back to bottom, reset the flag
    if (atBottom) {
      setUserScrolledAway(false);
    }
  }, [checkIfAtBottom, streamingContent]);

  // Scroll to bottom function
  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({ 
      behavior: smooth ? 'smooth' : 'instant' 
    });
    setUserScrolledAway(false);
    setIsAtBottom(true);
  }, []);

  // Auto-scroll only if user hasn't manually scrolled away
  useEffect(() => {
    if (!userScrolledAway && isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages, streamingContent, userScrolledAway, isAtBottom]);

  // Reset scroll state when starting a new message
  useEffect(() => {
    if (streamingContent === null) {
      // Streaming ended, check position
      setUserScrolledAway(false);
    }
  }, [streamingContent]);

  // Scroll to bottom when new user message is sent
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'user') {
      scrollToBottom(false);
    }
  }, [messages.length, scrollToBottom]);



  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
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
      {messages.map((message) => {
        if (message.role === 'error') {
          return (
            <ErrorBubble
              key={message.id}
              message={message}
              onAction={onAction}
            />
          );
        }
        return (
          <MessageItem
            key={message.id}
            message={message}
            onAction={onAction}
          />
        );
      })}

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

      {/* Scroll to bottom button - shown when user scrolled away */}
      {userScrolledAway && streamingContent !== null && (
        <button
          onClick={() => scrollToBottom()}
          className="fixed bottom-24 right-8 flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg transition-all hover:bg-blue-600"
          title="滚动到底部"
        >
          <ArrowDown size={20} />
        </button>
      )}
    </div>
  );
};

export default MessageList;
