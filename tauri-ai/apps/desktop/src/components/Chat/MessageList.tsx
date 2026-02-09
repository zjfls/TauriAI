/**
 * MessageList Component
 * Displays a scrollable list of messages with smart auto-scroll
 * Requirements: 2.3, 3.5
 */

import React, {
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Message, MessageBlock, Action, MessageTurn } from '../../types';
import { MessageItem } from './MessageItem';
import { MessageBlocks } from './MessageBlocks';
import { Bot, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { markChatOpenProfile } from '../../utils/chatOpenProfile';
import { isEditableElement } from '../../shortcuts';
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

export interface MessageListHandle {
  /** 定位到指定消息（必要时自动加载更早消息，并闪烁高亮定位） */
  scrollToMessage: (messageId: string) => void;
  /** 还原到“只渲染最近消息”的窗口（同时滚动到底部） */
  resetToRecent: () => void;
}

// Threshold in pixels to consider "at bottom"
const SCROLL_THRESHOLD = 50;

// 长对话在切换会话/渲染时会明显卡顿：默认只渲染最后 N 条，向上按需加载
const DEFAULT_VISIBLE_TURNS = 3;
const DEFAULT_VISIBLE_MESSAGES = DEFAULT_VISIBLE_TURNS * 2;
const LOAD_MORE_PAGE_SIZE = 15;
const LOAD_MORE_SCROLL_THRESHOLD = 80;
const USER_INTENT_WINDOW_MS = 250;
const SCROLL_NAV_HIDDEN_STORAGE_KEY = 'tauri-ai:chat:scroll_nav_hidden';

type PendingRestore =
  | { mode: 'bottom' }
  | { mode: 'scrollTop'; scrollTop: number }
  | { mode: 'anchor'; messageId: string; viewportTop: number; fallbackScrollTop: number }
  | null;

const MessageListInner = React.forwardRef<MessageListHandle, MessageListProps>(({
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
}, ref) => {
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
  const commitRafRef = useRef<number | null>(null);
  const pendingCommitRef = useRef<{ isAtBottom: boolean; userScrolledAway: boolean } | null>(null);
  const suppressAutoLoadMoreRef = useRef(false);
  const pendingNavAfterLoadMoreRef = useRef<null | { kind: 'prevMessage' }>(null);
  const pendingHighlightMessageIdRef = useRef<string | null>(null);

  // Track if user is at bottom (should auto-scroll)
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Track if user manually scrolled away
  const [userScrolledAway, setUserScrolledAway] = useState(false);

  const [scrollNavHidden, setScrollNavHidden] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SCROLL_NAV_HIDDEN_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SCROLL_NAV_HIDDEN_STORAGE_KEY, scrollNavHidden ? '1' : '0');
    } catch {
      // ignore
    }
  }, [scrollNavHidden]);

  useEffect(() => {
    const onShortcut = (event: Event) => {
      const e = event as CustomEvent<{ action?: string }>;
      if (e.detail?.action !== 'chat.toggleScrollNavigator') return;
      setScrollNavHidden((v) => !v);
    };
    window.addEventListener('tauri-ai:shortcut', onShortcut as EventListener);
    return () => window.removeEventListener('tauri-ai:shortcut', onShortcut as EventListener);
  }, []);

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

  const flashMessage = useCallback(
    (messageId: string) => {
      const el = findMessageElement(messageId);
      if (!el) return;

      const prevBoxShadow = el.style.boxShadow;
      const prevBorderRadius = el.style.borderRadius;

      el.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.45)';
      el.style.borderRadius = prevBorderRadius || '12px';

      window.setTimeout(() => {
        try {
          el.style.boxShadow = prevBoxShadow;
          el.style.borderRadius = prevBorderRadius;
        } catch {
          // ignore
        }
      }, 1200);
    },
    [findMessageElement]
  );

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

  const scheduleCommitViewState = useCallback(
    (next: { isAtBottom: boolean; userScrolledAway: boolean }) => {
      pendingCommitRef.current = next;
      if (commitRafRef.current !== null) return;
      commitRafRef.current = requestAnimationFrame(() => {
        commitRafRef.current = null;
        const container = containerRef.current;
        const pending = pendingCommitRef.current;
        pendingCommitRef.current = null;
        if (!container || !pending) return;
        commitViewState(container, pending);
      });
    },
    [commitViewState]
  );

  useEffect(() => {
    return () => {
      if (commitRafRef.current !== null) cancelAnimationFrame(commitRafRef.current);
      commitRafRef.current = null;
      pendingCommitRef.current = null;
    };
  }, []);

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
    const startedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    markChatOpenProfile('messageList:layoutEffect:init:start', {
      conversationId: conversationKey || undefined,
      meta: { totalMessages: messages.length },
    });

    loadMoreInFlightRef.current = false;
    pendingScrollAdjustRef.current = null;

    const forceToBottom = consumeConversationScrollToBottomOnce(conversationKey);
    const saved = forceToBottom ? undefined : getConversationViewState(conversationKey);
    try {
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
    } finally {
      const endedAt =
        typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      markChatOpenProfile('messageList:layoutEffect:init:done', {
        conversationId: conversationKey || undefined,
        meta: {
          durationMs: Number((endedAt - startedAt).toFixed(1)),
          usedSaved: Boolean(saved),
          forceToBottom,
          totalMessages: messages.length,
        },
      });
    }
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

    const startedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    markChatOpenProfile('messageList:layoutEffect:restore:start', {
      conversationId: conversationKey || undefined,
      meta: { mode: pending.mode, visibleCount, totalMessages: messages.length },
    });

    cancelRestoreCalibration();
    let anchorFound: boolean | undefined = undefined;

    try {
      if (pending.mode === 'bottom') {
        followOutputRef.current = true;
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      } else if (pending.mode === 'scrollTop') {
        followOutputRef.current = false;
        container.scrollTop = pending.scrollTop;
      } else {
        followOutputRef.current = false;
        const anchorEl = findMessageElement(pending.messageId);
        anchorFound = Boolean(anchorEl);
        if (anchorEl) {
          const containerTop = container.getBoundingClientRect().top;
          const currentTop = anchorEl.getBoundingClientRect().top - containerTop;
          container.scrollTop += currentTop - pending.viewportTop;
          startRestoreCalibration(pending.messageId, pending.viewportTop);
        } else {
          container.scrollTop = pending.fallbackScrollTop;
        }
      }
    } finally {
      pendingRestoreRef.current = null;

      if (pending.mode === 'anchor' && pendingHighlightMessageIdRef.current === pending.messageId) {
        pendingHighlightMessageIdRef.current = null;
        flashMessage(pending.messageId);
      }

      const endedAt =
        typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      markChatOpenProfile('messageList:layoutEffect:restore:done', {
        conversationId: conversationKey || undefined,
        meta: {
          mode: pending.mode,
          durationMs: Number((endedAt - startedAt).toFixed(1)),
          anchorFound,
          visibleCount,
          totalMessages: messages.length,
        },
      });
    }
  }, [cancelRestoreCalibration, conversationKey, findMessageElement, flashMessage, startRestoreCalibration, visibleCount]);

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

    startTransition(() => {
      setVisibleCount((current) => Math.min(messages.length, current + LOAD_MORE_PAGE_SIZE));
    });
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
      scheduleCommitViewState({ isAtBottom: effectiveAtBottom, userScrolledAway: nextUserScrolledAway });
    }

    if (container.scrollTop < LOAD_MORE_SCROLL_THRESHOLD && startIndex > 0) {
      if (suppressAutoLoadMoreRef.current) {
        suppressAutoLoadMoreRef.current = false;
      } else {
        loadMore();
      }
    }
  }, [
    checkIfAtBottom,
    isContainerUsableForPersist,
    loadMore,
    scheduleCommitViewState,
    startIndex,
    streamingBlocks,
    userScrolledAway,
  ]);

  // Keep latest view state in memory (for tab/session switching).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    scheduleCommitViewState({ isAtBottom, userScrolledAway });
  }, [scheduleCommitViewState, isAtBottom, userScrolledAway]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(
    (smooth = true) => {
      followOutputRef.current = true;
      // 回到底部时恢复“只渲染最近消息”的窗口，避免长对话导致渲染压力持续攀升
      setVisibleCount(DEFAULT_VISIBLE_MESSAGES);
      bottomRef.current?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'instant',
      });
      setUserScrolledAway(false);
      setIsAtBottom(true);

      const container = containerRef.current;
      if (container) {
        scheduleCommitViewState({ isAtBottom: true, userScrolledAway: false });
      }
    },
    [scheduleCommitViewState]
  );

  const scrollToTop = useCallback(
    (smooth = true) => {
      const container = containerRef.current;
      if (!container) return;
      suppressAutoLoadMoreRef.current = true;
      // 这是明确的用户导航意图：关闭跟随输出
      lastUserIntentTsRef.current = Date.now();
      followOutputRef.current = false;
      container.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });

      const nextUserScrolledAway = streamingBlocks !== null;
      setIsAtBottom(false);
      if (nextUserScrolledAway !== userScrolledAway) setUserScrolledAway(nextUserScrolledAway);
      scheduleCommitViewState({ isAtBottom: false, userScrolledAway: nextUserScrolledAway });
    },
    [scheduleCommitViewState, streamingBlocks, userScrolledAway]
  );

  const getRenderedMessageElements = useCallback((): HTMLElement[] => {
    const container = containerRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).filter((el) => Boolean(el.dataset.messageId));
  }, []);

  const getTopVisibleMessageIndex = useCallback((): number => {
    const container = containerRef.current;
    if (!container) return -1;
    const containerTop = container.getBoundingClientRect().top;
    const nodes = getRenderedMessageElements();
    if (nodes.length === 0) return -1;
    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      if (rect.bottom > containerTop + 1) return i;
    }
    return nodes.length - 1;
  }, [getRenderedMessageElements]);

  const scrollToRenderedMessageIndex = useCallback(
    (index: number, smooth = true) => {
      const container = containerRef.current;
      if (!container) return;
      const nodes = getRenderedMessageElements();
      const el = nodes[index];
      if (!el) return;

      const containerRect = container.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const delta = rect.top - containerRect.top;
      const targetTop = Math.max(0, container.scrollTop + delta - 8);
      if (Math.abs(targetTop - container.scrollTop) < 1) return;

      suppressAutoLoadMoreRef.current = true;
      lastUserIntentTsRef.current = Date.now();
      followOutputRef.current = false;
      container.scrollTo({ top: targetTop, behavior: smooth ? 'smooth' : 'auto' });
    },
    [getRenderedMessageElements]
  );

  const scrollToPreviousMessage = useCallback(() => {
    const current = getTopVisibleMessageIndex();
    if (current <= 0) {
      if (startIndex > 0) {
        pendingNavAfterLoadMoreRef.current = { kind: 'prevMessage' };
        loadMore();
        return;
      }
      scrollToTop(true);
      return;
    }
    scrollToRenderedMessageIndex(current - 1, true);
  }, [getTopVisibleMessageIndex, loadMore, scrollToRenderedMessageIndex, scrollToTop, startIndex]);

  const scrollToNextMessage = useCallback(() => {
    const current = getTopVisibleMessageIndex();
    const nodes = getRenderedMessageElements();
    if (nodes.length === 0) return;
    const next = Math.min(nodes.length - 1, Math.max(0, current) + 1);
    scrollToRenderedMessageIndex(next, true);
  }, [getRenderedMessageElements, getTopVisibleMessageIndex, scrollToRenderedMessageIndex]);

  const scrollToMessage = useCallback(
    (messageId: string) => {
      const container = containerRef.current;
      if (!container) return;

      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // 给目标消息留一点上下文，避免直接贴边
      const buffer = 2;
      const targetStartIndex = Math.max(0, idx - buffer);
      const neededVisibleCount = Math.min(
        messages.length,
        Math.max(DEFAULT_VISIBLE_MESSAGES, messages.length - targetStartIndex)
      );

      suppressAutoLoadMoreRef.current = true;
      lastUserIntentTsRef.current = Date.now();
      followOutputRef.current = false;
      setIsAtBottom(false);
      setUserScrolledAway(streamingBlocks !== null);

      const el = findMessageElement(messageId);
      if (el && neededVisibleCount === visibleCount) {
        const containerTop = container.getBoundingClientRect().top;
        const currentTop = el.getBoundingClientRect().top - containerTop;
        container.scrollTop += currentTop - 8;
        scheduleCommitViewState({ isAtBottom: false, userScrolledAway: streamingBlocks !== null });
        flashMessage(messageId);
        return;
      }

      pendingHighlightMessageIdRef.current = messageId;
      pendingRestoreRef.current = {
        mode: 'anchor',
        messageId,
        viewportTop: 8,
        fallbackScrollTop: container.scrollTop,
      };
      setVisibleCount(neededVisibleCount === visibleCount ? Math.min(messages.length, visibleCount + 1) : neededVisibleCount);
    },
    [
      findMessageElement,
      flashMessage,
      messages,
      scheduleCommitViewState,
      streamingBlocks,
      visibleCount,
    ]
  );

  const resetToRecent = useCallback(() => {
    followOutputRef.current = true;
    pendingRestoreRef.current = { mode: 'bottom' };
    setVisibleCount(DEFAULT_VISIBLE_MESSAGES);
    setUserScrolledAway(false);
    setIsAtBottom(true);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage,
      resetToRecent,
    }),
    [resetToRecent, scrollToMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditableElement(e.target)) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) {
          scrollToTop(true);
          return;
        }
        scrollToPreviousMessage();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) {
          scrollToBottom(true);
          return;
        }
        scrollToNextMessage();
      }
    },
    [scrollToBottom, scrollToNextMessage, scrollToPreviousMessage, scrollToTop]
  );

  // “上一条消息”在顶部时：先触发一次 loadMore，再在 DOM 更新后滚到新增的上一条
  useLayoutEffect(() => {
    const pending = pendingNavAfterLoadMoreRef.current;
    if (!pending) return;
    pendingNavAfterLoadMoreRef.current = null;

    if (pending.kind === 'prevMessage') {
      const current = getTopVisibleMessageIndex();
      if (current > 0) {
        scrollToRenderedMessageIndex(current - 1, true);
      }
    }
  }, [getTopVisibleMessageIndex, scrollToRenderedMessageIndex, visibleCount]);

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

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-label="聊天消息"
        className="h-full overflow-y-auto px-4 py-4 scrollbar-chat rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onPointerDownCapture={() => {
          try {
            containerRef.current?.focus();
          } catch {
            // ignore
          }
        }}
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
         <div className="group flex gap-3 py-3">
          {/* AI Avatar */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            <Bot size={18} />
          </div>

          {/* Streaming content */}
          <div className="relative w-fit min-w-[60%] max-w-[92%] rounded-2xl bg-white px-4 py-2 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
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
      </div>
      </div>

      {/* 快速滚动导航条（与当前 MessageList 绑定，避免多 Pane 下 fixed 定位错位） */}
      {!scrollNavHidden && (
        <div className="absolute right-1 top-1/2 z-20 -translate-y-1/2">
          <div className="flex flex-col gap-0.5 rounded-lg border border-gray-200/70 bg-white/60 p-0.5 shadow-sm backdrop-blur-md dark:border-gray-700/60 dark:bg-gray-950/35">
            <button
              type="button"
              onClick={() => scrollToTop(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800/60"
              title="到顶部（Alt+↑）"
              aria-label="到顶部"
            >
              <ChevronsUp size={16} />
            </button>
            <button
              type="button"
              onClick={scrollToPreviousMessage}
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800/60"
              title="上一条消息（↑）"
              aria-label="上一条消息"
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              onClick={scrollToNextMessage}
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800/60"
              title="下一条消息（↓）"
              aria-label="下一条消息"
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className={`flex h-8 w-8 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800/60 ${
                userScrolledAway && streamingBlocks !== null
                  ? 'bg-blue-50/80 text-blue-700 hover:bg-blue-100/80 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/30'
                  : ''
              }`}
              title="到底部（Alt+↓）"
              aria-label="到底部"
            >
              <ChevronsDown size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
MessageListInner.displayName = 'MessageListInner';

// Avoid re-rendering the full message list when ChatView updates unrelated state
// (e.g. context usage estimation, settings panel toggles).
// Message list is heavy due to Markdown parsing / syntax highlighting.
export const MessageList = React.memo(MessageListInner);
MessageList.displayName = 'MessageList';

export default MessageList;
