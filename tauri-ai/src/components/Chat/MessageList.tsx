/**
 * MessageList Component
 * Displays a scrollable list of messages with smart auto-scroll
 * Requirements: 2.3, 3.5
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Message, MessageBlock, Action, MessageTurn } from '../../types';
import { MessageItem } from './MessageItem';
import { MessageBlocks } from './MessageBlocks';
import { Bot, ArrowDown } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';

interface MessageListProps {
  messages: Message[];
  streamingBlocks: MessageBlock[] | null;
  streamingTurns?: MessageTurn[];
  isGenerating: boolean;
  onAction: (action: Action) => void;
  onAbortTool?: (callId: string) => void;
  onRetryTurn?: (assistantMessageId: string, turnId: string) => void;
  /** 拖拽文件到聊天窗口时转发给输入框 */
  onDropFiles?: (files: FileList | File[]) => void;
  /** 拖拽纯文本/链接到聊天窗口时转发给输入框 */
  onDropText?: (text: string) => void;
}

// Threshold in pixels to consider "at bottom"
const SCROLL_THRESHOLD = 50;
const WIDE_VISUAL_FENCE_RE = /```(?:mermaid|plot|mafs|json\\s+mafs)\\b/i;

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingBlocks,
  streamingTurns,
  isGenerating: _isGenerating,
  onAction,
  onAbortTool,
  onRetryTurn,
  onDropFiles,
  onDropText,
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
    if (!atBottom && streamingBlocks !== null) {
      setUserScrolledAway(true);
    }

    // If user scrolls back to bottom, reset the flag
    if (atBottom) {
      setUserScrolledAway(false);
    }
  }, [checkIfAtBottom, streamingBlocks]);

  // Scroll to bottom function
  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'instant',
    });
    setUserScrolledAway(false);
    setIsAtBottom(true);
  }, []);

  // Auto-scroll only if user hasn't manually scrolled away
  useEffect(() => {
    if (!userScrolledAway && isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages, streamingBlocks, userScrolledAway, isAtBottom]);

  // Reset scroll state when streaming ends
  useEffect(() => {
    if (streamingBlocks === null) {
      setUserScrolledAway(false);
    }
  }, [streamingBlocks]);

  // Scroll to bottom when new user message is sent
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'user') {
      scrollToBottom(false);
    }
  }, [messages.length, scrollToBottom]);

  const extractFilesFromDataTransfer = useCallback((dataTransfer: DataTransfer): File[] => {
    if (dataTransfer.files && dataTransfer.files.length > 0) {
      return Array.from(dataTransfer.files);
    }

    const items = dataTransfer.items;
    if (!items || items.length === 0) return [];

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Prevent default to allow drop
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 在 Tauri 里，文件拖拽由 InputArea 统一监听 tauri://drag-drop 处理（避免重复添加）
      if (isTauri()) {
        const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
        if (text) onDropText?.(text);
        return;
      }

      const droppedFiles = extractFilesFromDataTransfer(e.dataTransfer);
      if (droppedFiles.length > 0) {
        onDropFiles?.(droppedFiles);
        return;
      }

      const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
      if (text) {
        onDropText?.(text);
      }
    },
    [extractFilesFromDataTransfer, onDropFiles, onDropText]
  );

  const streamingPreferWideBubble =
    streamingBlocks?.some((b) => b.type === 'text' && WIDE_VISUAL_FENCE_RE.test(b.text)) ?? false;
  const streamingBubbleWidthClass = streamingPreferWideBubble ? 'w-full max-w-[92%]' : 'max-w-[80%]';

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Empty state */}
      {messages.length === 0 && streamingBlocks === null && (
        <div className="flex h-full flex-col items-center justify-center text-gray-400">
          <Bot size={48} className="mb-4" />
          <p className="text-lg">开始新对话</p>
          <p className="text-sm">在下方输入消息开始聊天</p>
        </div>
      )}

      {/* Message list */}
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onAction={onAction} onAbortTool={onAbortTool} onRetryTurn={onRetryTurn} />
      ))}

       {/* Streaming message */}
       {streamingBlocks !== null && (
         <div className="group flex gap-3 px-4 py-3">
          {/* AI Avatar */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            <Bot size={18} />
          </div>

          {/* Streaming content */}
          <div
            className={`relative ${streamingBubbleWidthClass} rounded-2xl bg-white px-4 py-2 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100`}
          >
            <MessageBlocks
              blocks={streamingBlocks}
              conversationId={messages[0]?.conversationId}
              isStreaming
              turns={streamingTurns}
              onAbortTool={onAbortTool}
            />
            {/* Blinking cursor */}
            <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 dark:bg-gray-500" />
          </div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />

      {/* Scroll to bottom button - shown when user scrolled away */}
      {userScrolledAway && streamingBlocks !== null && (
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
