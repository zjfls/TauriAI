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
  type ConversationViewState,
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
const DEFAULT_VISIBLE_TURNS = 1;
const DEFAULT_VISIBLE_MESSAGES = DEFAULT_VISIBLE_TURNS * 2;
const LOAD_MORE_PAGE_SIZE = 40;
const LOAD_MORE_SCROLL_THRESHOLD = 80;
const USER_INTENT_WINDOW_MS = 250;

type PendingRestore =
  | { mode: 'bottom' }
  | { mode: 'scrollTop'; scrollTop: number }
  | { mode: 'anchor'; messageId: string; viewportTop: number; fallbackScrollTop: number }
  | null;

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
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const pendingRestoreRef = useRef<PendingRestore>(null);
  const restoreCalibrationRef = useRef<{ cancel: () => void } | null>(null);
  const lastUserAutoScrollRef = useRef<{ conversationKey: string; lastMessageId: string | null } | null>(null);
  const lastGoodViewStateRef = useRef<{ conversationKey: string; state: ConversationViewState } | null>(null);
  // 用户意图：是否跟随输出保持贴底（不要依赖 isAtBottom 的 state，避免时序抖动）
  const followOutputRef = useRef(true);
  const lastUserIntentTsRef = useRef(0);

  // Track if user is at bottom (should auto-scroll)
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Track if user manually scrolled away
  const [userScrolledAway, setUserScrolledAway] = useState(false);

  // Windowed rendering for long histories
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_MESSAGES);
  const loadMoreInFlightRef = useRef(false);
  const pendingScrollAdjustRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const conversationKey = conversationId ?? messages[0]?.conversationId ?? '';

  const isContainerUsableForPersist = useCallback((container: HTMLDivElement): boolean => {
    if (!container.isConnected) return false;
    if (container.getClientRects().length === 0) return false;
    const rect = container.getBoundingClientRect();
    if (rect.height < 16 || rect.width < 16) return false;
    return true;
  }, []);

  const findMessageElement = useCallback((messageId: string): HTMLElement | null => {
    const container = containerRef.current;
    if (!container) return null;
    const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const el of Array.from(nodes)) {
      if (el.dataset.messageId === messageId) return el;
    }
    return null;
  }, []);

  const getAnchorSnapshot = useCallback((): { messageId: string; viewportTop: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const containerTop = container.getBoundingClientRect().top;
    const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const el of Array.from(nodes)) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerTop + 1) {
        const messageId = el.dataset.messageId;
        if (messageId) {
          return { messageId, viewportTop: rect.top - containerTop };
        }
      }
    }
    return null;
  }, []);

  const commitViewState = useCallback(
    (container: HTMLDivElement, next: { isAtBottom: boolean; userScrolledAway: boolean }) => {
      if (!conversationKey) return;
      if (!isContainerUsableForPersist(container)) return;
      if (container.scrollHeight <= container.clientHeight + 1) return;

      // 若用户意图是“跟随输出”，即使短暂不在物理底部（内容变高），也应视为“在底部”以保证恢复与持久化正确。
      const effectiveIsAtBottom = followOutputRef.current ? true : next.isAtBottom;
      const normalizedUserScrolledAway = effectiveIsAtBottom ? false : next.userScrolledAway;
      const anchor = effectiveIsAtBottom ? null : getAnchorSnapshot();
      const nextStartIndex = Math.max(0, messages.length - visibleCount);
      const state: ConversationViewState = {
        startIndex: nextStartIndex,
        visibleCount,
        scrollTop: container.scrollTop,
        isAtBottom: effectiveIsAtBottom,
        userScrolledAway: normalizedUserScrolledAway,
        anchorMessageId: anchor?.messageId,
        anchorViewportTop: anchor?.viewportTop,
      };

      lastGoodViewStateRef.current = { conversationKey, state };
      setConversationViewState(conversationKey, state);
    },
    [conversationKey, getAnchorSnapshot, isContainerUsableForPersist, messages.length, visibleCount]
  );

  const cancelRestoreCalibration = useCallback(() => {
    restoreCalibrationRef.current?.cancel();
    restoreCalibrationRef.current = null;
  }, []);

  const startRestoreCalibration = useCallback(
    (messageId: string, viewportTop: number) => {
      const container = containerRef.current;
      if (!container) return;

      cancelRestoreCalibration();

      let stopped = false;
      let rafId: number | null = null;
      let stableFrames = 0;
      let lastScrollHeight = container.scrollHeight;
      const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const maxDurationMs = 1200;
      const stableRequiredFrames = 8;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        container.removeEventListener('wheel', onUserIntent);
        container.removeEventListener('touchstart', onUserIntent);
        container.removeEventListener('pointerdown', onUserIntent);
        window.removeEventListener('keydown', onUserIntent, true);
      };

      const onUserIntent = () => stop();

      container.addEventListener('wheel', onUserIntent, { passive: true });
      container.addEventListener('touchstart', onUserIntent, { passive: true });
      container.addEventListener('pointerdown', onUserIntent);
      window.addEventListener('keydown', onUserIntent, true);

      const tick = () => {
        if (stopped) return;

        const anchorEl = findMessageElement(messageId);
        if (!anchorEl) {
          stop();
          return;
        }

        const containerTop = container.getBoundingClientRect().top;
        const currentTop = anchorEl.getBoundingClientRect().top - containerTop;
        const delta = currentTop - viewportTop;
        if (Math.abs(delta) > 0.5) {
          container.scrollTop += delta;
        }

        const scrollHeight = container.scrollHeight;
        const heightStable = Math.abs(scrollHeight - lastScrollHeight) < 1;
        lastScrollHeight = scrollHeight;

        const deltaStable = Math.abs(delta) <= 0.5;
        stableFrames = deltaStable && heightStable ? stableFrames + 1 : 0;

        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (stableFrames >= stableRequiredFrames || nowMs - startMs >= maxDurationMs) {
          stop();
          return;
        }

        rafId = requestAnimationFrame(tick);
      };

      rafId = requestAnimationFrame(tick);
      restoreCalibrationRef.current = { cancel: stop };
    },
    [cancelRestoreCalibration, findMessageElement]
  );

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
      followOutputRef.current = saved.isAtBottom;
      if (saved.isAtBottom) {
        pendingRestoreRef.current = { mode: 'bottom' };
      } else if (saved.anchorMessageId && typeof saved.anchorViewportTop === 'number') {
        pendingRestoreRef.current = {
          mode: 'anchor',
          messageId: saved.anchorMessageId,
          viewportTop: saved.anchorViewportTop,
          fallbackScrollTop: saved.scrollTop,
        };
      } else {
        pendingRestoreRef.current = { mode: 'scrollTop', scrollTop: saved.scrollTop };
      }
      return;
    }

    setVisibleCount(DEFAULT_VISIBLE_MESSAGES);
    setIsAtBottom(true);
    setUserScrolledAway(false);
    followOutputRef.current = true;
    pendingRestoreRef.current = { mode: 'bottom' };
  }, [conversationKey, messages.length]);

  // Handle “scroll to bottom” requests even when conversationKey doesn't change (e.g. clicking the same conversation in history).
  useLayoutEffect(() => {
    const hit = consumeConversationScrollToBottomOnce(conversationKey);
    if (!hit) return;
    setVisibleCount(DEFAULT_VISIBLE_MESSAGES);
    setIsAtBottom(true);
    setUserScrolledAway(false);
    followOutputRef.current = true;
    pendingRestoreRef.current = { mode: 'bottom' };
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

    cancelRestoreCalibration();

    if (pending.mode === 'bottom') {
      followOutputRef.current = true;
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    } else if (pending.mode === 'scrollTop') {
      followOutputRef.current = false;
      container.scrollTop = pending.scrollTop;
    } else {
      followOutputRef.current = false;
      const anchorEl = findMessageElement(pending.messageId);
      if (anchorEl) {
        const containerTop = container.getBoundingClientRect().top;
        const currentTop = anchorEl.getBoundingClientRect().top - containerTop;
        container.scrollTop += currentTop - pending.viewportTop;
        startRestoreCalibration(pending.messageId, pending.viewportTop);
      } else {
        container.scrollTop = pending.fallbackScrollTop;
      }
    }

    pendingRestoreRef.current = null;
  }, [cancelRestoreCalibration, conversationKey, findMessageElement, startRestoreCalibration, visibleCount]);

  useEffect(() => cancelRestoreCalibration, [cancelRestoreCalibration]);

  // 记录“用户意图滚动”（wheel/拖拽滚动条/触屏等），用于区分“布局变化导致的非用户滚动”。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const mark = () => {
      lastUserIntentTsRef.current = Date.now();
    };

    const onPointerDown = (event: PointerEvent) => {
      // 只把“拖拽滚动条/点滚动条区域”视为滚动意图；避免点击选中文本等误触关闭贴底。
      const scrollbarWidth = container.offsetWidth - container.clientWidth;
      if (scrollbarWidth <= 0) return;
      const rect = container.getBoundingClientRect();
      if (event.clientX >= rect.right - scrollbarWidth - 2) {
        mark();
      }
    };

    container.addEventListener('wheel', mark, { passive: true });
    container.addEventListener('touchstart', mark, { passive: true });
    container.addEventListener('pointerdown', onPointerDown);

    return () => {
      container.removeEventListener('wheel', mark);
      container.removeEventListener('touchstart', mark);
      container.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

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
    if (!container) return;
    if (!isContainerUsableForPersist(container)) return;

    // Avoid overwriting saved scroll state when the container is being torn down / has no overflow.
    const hasOverflow = container.scrollHeight > container.clientHeight + 1;
    const physicalAtBottom = hasOverflow ? checkIfAtBottom() : true;
    const now = Date.now();
    const userIntentActive = now - lastUserIntentTsRef.current <= USER_INTENT_WINDOW_MS;

    // 只有“用户意图滚动离开底部”时才关闭跟随；内容变高导致的距离变化不应关闭跟随。
    let nextFollowOutput = followOutputRef.current;
    if (physicalAtBottom) nextFollowOutput = true;
    else if (userIntentActive) nextFollowOutput = false;
    followOutputRef.current = nextFollowOutput;

    // UI/persist 视角：若仍在跟随输出，则视为“在底部”（后续会被 ResizeObserver 补偿）。
    const effectiveAtBottom = nextFollowOutput ? true : physicalAtBottom;
    setIsAtBottom(effectiveAtBottom);

    // If user scrolls away from bottom during streaming, mark as manually scrolled
    let nextUserScrolledAway = userScrolledAway;
    if (!effectiveAtBottom && streamingBlocks !== null && userIntentActive) nextUserScrolledAway = true;

    // If user scrolls back to bottom, reset the flag
    if (effectiveAtBottom) nextUserScrolledAway = false;

    if (nextUserScrolledAway !== userScrolledAway) {
      setUserScrolledAway(nextUserScrolledAway);
    }

    // 向上滚动接近顶部时自动加载更早的消息
    if (hasOverflow) {
      commitViewState(container, { isAtBottom: effectiveAtBottom, userScrolledAway: nextUserScrolledAway });
    }

    if (container.scrollTop < LOAD_MORE_SCROLL_THRESHOLD && startIndex > 0) {
      loadMore();
    }
  }, [
    checkIfAtBottom,
    commitViewState,
    isContainerUsableForPersist,
    loadMore,
    startIndex,
    streamingBlocks,
    userScrolledAway,
  ]);

  // Keep latest view state in memory (for tab/session switching).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    commitViewState(container, { isAtBottom, userScrolledAway });
  }, [commitViewState, isAtBottom, userScrolledAway]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(
    (smooth = true) => {
      followOutputRef.current = true;
      bottomRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
      });
      setUserScrolledAway(false);
      setIsAtBottom(true);

      const container = containerRef.current;
      if (container) {
        commitViewState(container, { isAtBottom: true, userScrolledAway: false });
      }
    },
    [commitViewState]
  );

  // Note: avoid persisting on unmount by reading `container.scrollTop`, because the DOM might
  // already be detached/relayouted (can incorrectly report 0 and overwrite the last good state).
  // Still, ensure we never lose the last known-good state due to teardown-induced scroll events.
  useEffect(() => {
    return () => {
      const last = lastGoodViewStateRef.current;
      if (!last) return;
      setConversationViewState(last.conversationKey, last.state);
    };
  }, []);

  // 内容高度可能在 streaming 结束后继续增长（Markdown/图片/代码高亮等），需要在“跟随输出”时保持贴底。
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (typeof ResizeObserver === 'undefined') return;

    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (!followOutputRef.current) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        if (!container.isConnected) return;

        const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceToBottom <= SCROLL_THRESHOLD) return;

        // 直接写 scrollTop 更可靠：即使元素暂时不可见，回到聊天时也能保持贴底。
        container.scrollTop = container.scrollHeight;
      });
    });

    ro.observe(content);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Auto-scroll only if user is following output
  useEffect(() => {
    if (followOutputRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages, streamingBlocks]);

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
      <div ref={contentRef} className="min-h-full">
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
    </div>
  );
};

// Avoid re-rendering the full message list when ChatView updates unrelated state
// (e.g. context usage estimation, settings panel toggles).
// Message list is heavy due to Markdown parsing / syntax highlighting.
export const MessageList = React.memo(MessageListInner);
MessageList.displayName = 'MessageList';

export default MessageList;
