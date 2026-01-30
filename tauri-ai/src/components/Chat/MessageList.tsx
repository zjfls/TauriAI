/**
 * MessageList Component
 * Displays a scrollable list of messages with smart auto-scroll
 * Requirements: 2.3, 3.5
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, MessageBlock, Action, MessageTurn } from '../../types';
import { MessageItem } from './MessageItem';
import { MessageBlocks } from './MessageBlocks';
import { Bot, ArrowDown } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { markChatOpenProfile } from '../../utils/chatOpenProfile';
import {
  consumeConversationScrollToBottomOnce,
  getConversationViewState,
  setConversationViewState,
} from '../../utils/conversationViewState';

interface MessageListProps {
  /** 用于区分不同会话，切换时重置内部窗口/滚动状态 */
  conversationId?: string | null;
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

// 长对话在切换会话/渲染时会明显卡顿：默认只渲染最后 N 条，向上按需加载
const DEFAULT_VISIBLE_TURNS = 3;
const DEFAULT_VISIBLE_MESSAGES = DEFAULT_VISIBLE_TURNS * 2;
const LOAD_MORE_PAGE_SIZE = 40;
const LOAD_MORE_SCROLL_THRESHOLD = 80;

type PendingRestore = { mode: 'bottom' | 'scrollTop'; scrollTop: number } | null;

const MessageListInner: React.FC<MessageListProps> = ({
  conversationId,
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

  const pendingRestoreRef = useRef<PendingRestore>(null);
  const lastUserAutoScrollRef = useRef<{ conversationKey: string; lastMessageId: string | null } | null>(null);

  // Track if user is at bottom (should auto-scroll)
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Track if user manually scrolled away
  const [userScrolledAway, setUserScrolledAway] = useState(false);

  // Windowed rendering for long histories
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_MESSAGES);
  const loadMoreInFlightRef = useRef(false);
  const pendingScrollAdjustRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const conversationKey = conversationId ?? messages[0]?.conversationId ?? '';

  useLayoutEffect(() => {
    loadMoreInFlightRef.current = false;
    pendingScrollAdjustRef.current = null;

    const forceToBottom = consumeConversationScrollToBottomOnce(conversationKey);
    const saved = forceToBottom ? undefined : getConversationViewState(conversationKey);
    if (saved) {
      const clampedStartIndex = Math.max(0, Math.min(messages.length, saved.startIndex));
      const nextVisibleCount = Math.min(
        messages.length,
        Math.max(DEFAULT_VISIBLE_MESSAGES, messages.length - clampedStartIndex)
      );
      setVisibleCount(nextVisibleCount);
      setIsAtBottom(saved.isAtBottom);
      setUserScrolledAway(saved.userScrolledAway);
      pendingRestoreRef.current = { mode: saved.isAtBottom ? 'bottom' : 'scrollTop', scrollTop: saved.scrollTop };
      return;
    }

    setVisibleCount(DEFAULT_VISIBLE_MESSAGES);
    setIsAtBottom(true);
    setUserScrolledAway(false);
    pendingRestoreRef.current = { mode: 'bottom', scrollTop: 0 };
  }, [conversationKey, messages.length]);

  // Handle “scroll to bottom” requests even when conversationKey doesn't change (e.g. clicking the same conversation in history).
  useLayoutEffect(() => {
    const hit = consumeConversationScrollToBottomOnce(conversationKey);
    if (!hit) return;
    setVisibleCount(DEFAULT_VISIBLE_MESSAGES);
    setIsAtBottom(true);
    setUserScrolledAway(false);
    pendingRestoreRef.current = { mode: 'bottom', scrollTop: 0 };
  });

  const startIndex = useMemo(() => Math.max(0, messages.length - visibleCount), [messages.length, visibleCount]);

  // Debug profiling: measure when the message list is actually committed for a given conversation.
  useEffect(() => {
    markChatOpenProfile('messageList:rendered(useEffect)', {
      conversationId: conversationKey || undefined,
      meta: { totalMessages: messages.length, startIndex, visibleCount },
    });
  }, [conversationKey, messages.length, startIndex, visibleCount]);
  const visibleMessages = useMemo(
    () => (startIndex > 0 ? messages.slice(startIndex) : messages),
    [messages, startIndex]
  );

  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    const container = containerRef.current;
    if (!pending || !container) return;

    if (pending.mode === 'bottom') {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    } else {
      container.scrollTop = pending.scrollTop;
    }

    pendingRestoreRef.current = null;
  }, [conversationKey, visibleCount]);

  const loadMore = useCallback(() => {
    if (startIndex === 0) return;
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;

    const container = containerRef.current;
    if (container) {
      pendingScrollAdjustRef.current = {
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
      };
    } else {
      pendingScrollAdjustRef.current = null;
    }

    setVisibleCount((current) => Math.min(messages.length, current + LOAD_MORE_PAGE_SIZE));
  }, [messages.length, startIndex]);

  useLayoutEffect(() => {
    const pending = pendingScrollAdjustRef.current;
    const container = containerRef.current;

    if (!pending || !container) {
      pendingScrollAdjustRef.current = null;
      loadMoreInFlightRef.current = false;
      return;
    }

    const newScrollHeight = container.scrollHeight;
    container.scrollTop = newScrollHeight - pending.prevScrollHeight + pending.prevScrollTop;
    pendingScrollAdjustRef.current = null;
    loadMoreInFlightRef.current = false;
  }, [visibleCount]);

  // Check if scroll position is at bottom
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
  }, []);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    const atBottom = checkIfAtBottom();
    setIsAtBottom(atBottom);

    // If user scrolls away from bottom during streaming, mark as manually scrolled
    let nextUserScrolledAway = userScrolledAway;
    if (!atBottom && streamingBlocks !== null) nextUserScrolledAway = true;

    // If user scrolls back to bottom, reset the flag
    if (atBottom) nextUserScrolledAway = false;

    if (nextUserScrolledAway !== userScrolledAway) {
      setUserScrolledAway(nextUserScrolledAway);
    }

    // 向上滚动接近顶部时自动加载更早的消息
    if (container) {
      setConversationViewState(conversationKey, {
        startIndex,
        visibleCount,
        scrollTop: container.scrollTop,
        isAtBottom: atBottom,
        userScrolledAway: nextUserScrolledAway,
      });
    }

    if (container && container.scrollTop < LOAD_MORE_SCROLL_THRESHOLD && startIndex > 0) {
      loadMore();
    }
  }, [checkIfAtBottom, conversationKey, loadMore, startIndex, streamingBlocks, userScrolledAway, visibleCount]);

  // Keep latest view state in memory (for tab/session switching).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setConversationViewState(conversationKey, {
      startIndex,
      visibleCount,
      scrollTop: container.scrollTop,
      isAtBottom,
      userScrolledAway,
    });
  }, [conversationKey, isAtBottom, startIndex, userScrolledAway, visibleCount]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(
    (smooth = true) => {
      bottomRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
      });
      setUserScrolledAway(false);
      setIsAtBottom(true);

      const container = containerRef.current;
      if (container) {
        setConversationViewState(conversationKey, {
          startIndex,
          visibleCount,
          scrollTop: container.scrollTop,
          isAtBottom: true,
          userScrolledAway: false,
        });
      }
    },
    [conversationKey, startIndex, visibleCount]
  );

  // Ensure last view state is captured on unmount (e.g., switching to settings view).
  useEffect(() => {
    return () => {
      const container = containerRef.current;
      if (!container) return;
      setConversationViewState(conversationKey, {
        startIndex,
        visibleCount,
        scrollTop: container.scrollTop,
        isAtBottom,
        userScrolledAway,
      });
    };
  }, [conversationKey, isAtBottom, startIndex, userScrolledAway, visibleCount]);

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
    const lastMessageId = lastMessage?.id ?? null;
    const prev = lastUserAutoScrollRef.current;

    // Switching conversations should NOT trigger auto-scroll.
    if (!prev || prev.conversationKey !== conversationKey) {
      lastUserAutoScrollRef.current = { conversationKey, lastMessageId };
      return;
    }

    if (lastMessage?.role === 'user' && lastMessageId && prev.lastMessageId !== lastMessageId) {
      scrollToBottom(false);
    }

    lastUserAutoScrollRef.current = { conversationKey, lastMessageId };
  }, [conversationKey, messages.length, scrollToBottom]);

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

      {/* Load more */}
      {startIndex > 0 && (
        <div className="flex justify-center pb-3">
          <button
            type="button"
            onClick={loadMore}
            className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            title="加载更早消息"
          >
            加载更早消息（剩余 {startIndex} 条）
          </button>
        </div>
      )}

      {/* Message list */}
      {visibleMessages.map((message) => (
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
              conversationId={conversationId ?? messages[0]?.conversationId}
              isStreaming
              isUserBrowsing={userScrolledAway}
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

// Avoid re-rendering the full message list when ChatView updates unrelated state
// (e.g. context usage estimation, settings panel toggles).
// Message list is heavy due to Markdown parsing / syntax highlighting.
export const MessageList = React.memo(MessageListInner);
MessageList.displayName = 'MessageList';

export default MessageList;
