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
import { Bot, ArrowDown, Brain, ChevronDown, ChevronRight } from 'lucide-react';
import type { Action } from '../../types';

interface MessageListProps {
  messages: Message[];
  streamingContent: string | null;
  streamingThinking: string | null;
  isGenerating: boolean;
  onAction: (action: Action) => void;
}

// Threshold in pixels to consider "at bottom"
const SCROLL_THRESHOLD = 50;

// Streaming thinking block component
const StreamingThinkingBlock: React.FC<{ thinking: string }> = ({ thinking }) => {
  const [isExpanded, setIsExpanded] = useState(true); // Default expanded during streaming

  return (
    <div className="mb-2 rounded-lg border border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-purple-700 hover:bg-purple-100 dark:text-purple-300 dark:hover:bg-purple-900/50"
      >
        <Brain size={16} className="shrink-0" />
        <span className="font-medium">思考中...</span>
        <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-purple-500" />
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-purple-200 px-3 py-2 text-sm text-purple-800 dark:border-purple-800 dark:text-purple-200">
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap">
            {thinking}
          </div>
        </div>
      )}
    </div>
  );
};

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingContent,
  streamingThinking,
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
            {/* Streaming thinking block */}
            {streamingThinking && (
              <StreamingThinkingBlock thinking={streamingThinking} />
            )}
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
          className="fixed bottom-38 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg transition-all hover:bg-blue-600"
          title="滚动到底部"
        >
          <ArrowDown size={20} />
        </button>
      )}
    </div>
  );
};

export default MessageList;
