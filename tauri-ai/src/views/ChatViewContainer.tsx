import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { AgentSession } from '../types';
import { ChatView } from '../components/Chat/ChatView';
import { PaneHeader } from '../components/Chat/PaneHeader';
import { useSessionStore, type SessionPane } from '../stores/sessionStore';
import { endChatOpenProfile, getActiveChatOpenProfile, markChatOpenProfile } from '../utils/chatOpenProfile';
import { findChatDockTargetAtCursor, openOrFocusConversationChatWindow } from '../utils/viewWindow';

const MemoChatView = React.memo(ChatView);
MemoChatView.displayName = 'MemoChatView';

const TEAR_OFF_THRESHOLD_PX = 48;

const ChatPane: React.FC<{
  pane: SessionPane;
  sessionsById: Map<string, AgentSession>;
  isFocused: boolean;
  canClosePane: boolean;
  onFocus: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onClosePane: () => void;
  registerLayerRef: (sessionId: string) => (el: HTMLDivElement | null) => void;
  registerPaneRootRef: (paneId: string) => (el: HTMLDivElement | null) => void;
  registerPaneBodyRef: (paneId: string) => (el: HTMLDivElement | null) => void;
}> = ({
  pane,
  sessionsById,
  isFocused,
  canClosePane,
  onFocus,
  onSelectSession,
  onCloseSession,
  onClosePane,
  registerLayerRef,
  registerPaneRootRef,
  registerPaneBodyRef,
}) => {
  const activeSessionId =
    pane.activeSessionId && pane.sessionIds.includes(pane.activeSessionId)
      ? pane.activeSessionId
      : pane.sessionIds[0] ?? null;

  return (
    <div
      ref={registerPaneRootRef(pane.id)}
      className={[
        'flex h-full min-w-0 flex-col overflow-hidden',
        'bg-gray-50 dark:bg-gray-900',
        isFocused ? 'outline outline-1 outline-blue-500/30' : 'outline outline-1 outline-transparent',
      ].join(' ')}
      style={{ flexGrow: pane.weight, flexBasis: 0 }}
      onPointerDownCapture={onFocus}
    >
      <PaneHeader
        paneId={pane.id}
        sessionIds={pane.sessionIds}
        activeSessionId={activeSessionId}
        sessionsById={sessionsById}
        isFocused={isFocused}
        canClosePane={canClosePane}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
        onClosePane={onClosePane}
      />

      <div ref={registerPaneBodyRef(pane.id)} className="relative flex-1 overflow-hidden">
        {pane.sessionIds.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">
            暂无会话
          </div>
        ) : (
          pane.sessionIds.map((sessionId) => (
            <div
              key={sessionId}
              ref={registerLayerRef(sessionId)}
              className={`absolute inset-0 ${sessionId === activeSessionId ? '' : 'invisible pointer-events-none'}`}
              aria-hidden={sessionId !== activeSessionId}
            >
              <MemoChatView sessionId={sessionId} autoFocus={isFocused && sessionId === activeSessionId} />
            </div>
          ))
        )}
      </div>
    </div>
  );
};

const ChatViewContainerInner: React.FC = () => {
  const panes = useSessionStore((state) => state.panes);
  const focusedPaneId = useSessionStore((state) => state.focusedPaneId);
  const sessionsMap = useSessionStore((state) => state.sessions);

  const setFocusedPane = useSessionStore((state) => state.setFocusedPane);
  const switchSession = useSessionStore((state) => state.switchSession);
  const closeSession = useSessionStore((state) => state.closeSession);
  const closePaneAndMerge = useSessionStore((state) => state.closePaneAndMerge);
  const reorderSessionInPane = useSessionStore((state) => state.reorderSessionInPane);
  const moveSessionToPane = useSessionStore((state) => state.moveSessionToPane);
  const splitSessionToNewPane = useSessionStore((state) => state.splitSessionToNewPane);
  const setPaneWeights = useSessionStore((state) => state.setPaneWeights);
  const saveSessionState = useSessionStore((state) => state.saveSessionState);

  const layerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneRootRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const profileScheduledRef = useRef<string | null>(null);
  const fallbackPaneIdRef = useRef<string>(crypto.randomUUID());

  // 防御：历史状态/异常操作可能导致出现“空 Pane / 引用不存在 session 的 Pane”残留，
  // 从而在右侧留下空白列。这里在渲染层面过滤掉这类 Pane（只要存在至少一个有效 Pane）。
  const resolvedPanes = useMemo(() => {
    const base =
      panes.length > 0
        ? panes
        : [
            {
              id: fallbackPaneIdRef.current,
              sessionIds: [],
              activeSessionId: null,
              weight: 1,
            },
          ];

    // 注意：不能把空 pane 直接过滤掉，否则把唯一 tab 拖到分屏时（尤其是独立窗口），
    // 会留下「空 pane + 新 pane」，渲染层过滤空 pane 会导致看起来像“无法分屏”。
    const assigned = new Set<string>();
    const next: SessionPane[] = base.map((p) => {
      const sessionIds = (p.sessionIds ?? []).filter((sid) => {
        if (!sessionsMap.has(sid)) return false;
        if (assigned.has(sid)) return false;
        assigned.add(sid);
        return true;
      });

      const activeSessionId =
        p.activeSessionId && sessionIds.includes(p.activeSessionId) ? p.activeSessionId : sessionIds[0] ?? null;

      return {
        ...p,
        sessionIds,
        activeSessionId,
        weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
      };
    });

    // 兜底：如果存在未归属的 session，把它们补到第一个 pane，避免“有 session 但界面没有任何 tab”。
    const unassigned: string[] = [];
    for (const sid of sessionsMap.keys()) {
      if (!assigned.has(sid)) unassigned.push(sid);
    }
    if (unassigned.length > 0) {
      const first = next[0] ?? {
        id: fallbackPaneIdRef.current,
        sessionIds: [],
        activeSessionId: null,
        weight: 1,
      };
      const mergedIds = [...first.sessionIds, ...unassigned];
      next[0] = {
        ...first,
        sessionIds: mergedIds,
        activeSessionId: first.activeSessionId ?? unassigned[0] ?? null,
        weight: Number.isFinite(first.weight) && first.weight > 0 ? first.weight : 1,
      };
    }

    return next.length > 0 ? next : base;
  }, [panes, sessionsMap]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, AgentSession>();
    for (const s of sessionsMap.values()) map.set(s.id, s);
    return map;
  }, [sessionsMap]);

  const hasAnySession = sessionsMap.size > 0;

  const resolvedFocusedPaneId = useMemo(() => {
    if (focusedPaneId && resolvedPanes.some((p) => p.id === focusedPaneId)) return focusedPaneId;
    return resolvedPanes[0]?.id ?? null;
  }, [focusedPaneId, resolvedPanes]);

  // 容错：恢复状态异常时（有 sessions，但没有 focusedPaneId），自动聚焦第一个 pane。
  useEffect(() => {
    if (!hasAnySession) return;
    if (!resolvedFocusedPaneId) return;
    if (focusedPaneId === resolvedFocusedPaneId) return;
    setFocusedPane(resolvedFocusedPaneId);
  }, [focusedPaneId, hasAnySession, resolvedFocusedPaneId, setFocusedPane]);

  // 切换/隐藏 tab 时，如果焦点仍在不可见层里，主动 blur，避免键盘输入落到不可见输入框。
  const visibleSessionKey = useMemo(() => {
    return resolvedPanes.map((p) => p.activeSessionId ?? '').join('|');
  }, [resolvedPanes]);

  useEffect(() => {
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLElement)) return;
    const visible = new Set<string>();
    for (const p of resolvedPanes) {
      if (p.activeSessionId) visible.add(p.activeSessionId);
    }
    for (const [sessionId, el] of layerRefs.current) {
      if (visible.has(sessionId)) continue;
      if (el.contains(active)) {
        active.blur();
        break;
      }
    }
  }, [visibleSessionKey, resolvedPanes]);

  // Debug profiling: 标记“切换后 DOM 已完成 commit（但尚未 paint）”的时点
  const globalActiveSessionId = useSessionStore((state) => state.activeSessionId);
  useLayoutEffect(() => {
    if (!globalActiveSessionId) return;

    const profile = getActiveChatOpenProfile();
    if (!profile || profile.ended) return;

    const activeSession = useSessionStore.getState().sessions.get(globalActiveSessionId);
    const conversationId = activeSession?.conversationId ?? undefined;

    const matches =
      (profile.sessionId ? profile.sessionId === globalActiveSessionId : false) ||
      (conversationId && profile.conversationId ? profile.conversationId === conversationId : false);
    if (!matches) return;

    markChatOpenProfile('chatViewContainer:layout_effect', {
      profileId: profile.id,
      sessionId: globalActiveSessionId,
      conversationId,
      meta: { keepAlive: true, panes: resolvedPanes.length },
    });
  }, [globalActiveSessionId, resolvedPanes.length]);

  // Debug profiling: keep-alive 模式下补齐“完成绘制”的时点
  useEffect(() => {
    if (!globalActiveSessionId) return;

    const profile = getActiveChatOpenProfile();
    if (!profile || profile.ended) return;

    const activeSession = useSessionStore.getState().sessions.get(globalActiveSessionId);
    const conversationId = activeSession?.conversationId ?? undefined;

    const matches =
      (profile.sessionId ? profile.sessionId === globalActiveSessionId : false) ||
      (conversationId && profile.conversationId ? profile.conversationId === conversationId : false);
    if (!matches) return;

    if (profileScheduledRef.current === profile.id) return;
    profileScheduledRef.current = profile.id;

    markChatOpenProfile('chatViewContainer:active_changed', {
      profileId: profile.id,
      sessionId: globalActiveSessionId,
      conversationId,
      meta: { keepAlive: true, panes: resolvedPanes.length },
    });

    requestAnimationFrame(() => {
      markChatOpenProfile('chatViewContainer:raf1', { profileId: profile.id, sessionId: globalActiveSessionId, conversationId });
      requestAnimationFrame(() => {
        markChatOpenProfile('chatViewContainer:raf2', { profileId: profile.id, sessionId: globalActiveSessionId, conversationId });
        requestAnimationFrame(() => {
          endChatOpenProfile('chatViewContainer:painted', { profileId: profile.id, sessionId: globalActiveSessionId, conversationId });
        });
      });
    });
  }, [globalActiveSessionId, resolvedPanes.length]);

  const registerLayerRef = useCallback(
    (sessionId: string) => (el: HTMLDivElement | null) => {
      const map = layerRefs.current;
      if (el) map.set(sessionId, el);
      else map.delete(sessionId);
    },
    []
  );

  const registerPaneRootRef = useCallback(
    (paneId: string) => (el: HTMLDivElement | null) => {
      const map = paneRootRefs.current;
      if (el) map.set(paneId, el);
      else map.delete(paneId);
    },
    []
  );

  const registerPaneBodyRef = useCallback(
    (paneId: string) => (el: HTMLDivElement | null) => {
      const map = paneBodyRefs.current;
      if (el) map.set(paneId, el);
      else map.delete(paneId);
    },
    []
  );

  const sessionToPaneId = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of resolvedPanes) {
      for (const sid of p.sessionIds) map.set(sid, p.id);
    }
    return map;
  }, [resolvedPanes]);

  const paneById = useMemo(() => {
    const map = new Map<string, SessionPane>();
    for (const p of resolvedPanes) map.set(p.id, p);
    return map;
  }, [resolvedPanes]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  type SplitPreview = {
    paneId: string;
    direction: 'left' | 'right';
    rect: { left: number; top: number; width: number; height: number };
  };

  const [activeDragSessionId, setActiveDragSessionId] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const [splitPreview, setSplitPreview] = useState<SplitPreview | null>(null);

  const [resizeOverlay, setResizeOverlay] = useState<{ x: number; ratio: number } | null>(null);

  const computeSplitPreview = useCallback((point: { x: number; y: number }): SplitPreview | null => {
    for (const [paneId, el] of paneBodyRefs.current) {
      const rect = el.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right) continue;
      if (point.y < rect.top || point.y > rect.bottom) continue;

      const edge = rect.width * 0.25;
      if (rect.width > 120 && point.x <= rect.left + edge) {
        return {
          paneId,
          direction: 'left',
          rect: { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height },
        };
      }
      if (rect.width > 120 && point.x >= rect.right - edge) {
        return {
          paneId,
          direction: 'right',
          rect: { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height },
        };
      }
    }
    return null;
  }, []);

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const activeId = String(e.active.id);
    setActiveDragSessionId(activeId);
    setSplitPreview(null);

    const ev = e.activatorEvent as MouseEvent | PointerEvent | TouchEvent | null;
    if (ev && 'clientX' in ev) {
      dragStartRef.current = { x: ev.clientX, y: ev.clientY };
      lastDragPointRef.current = { x: ev.clientX, y: ev.clientY };
    } else {
      dragStartRef.current = null;
      lastDragPointRef.current = null;
    }
  }, []);

  const handleDragMove = useCallback((e: DragMoveEvent) => {
    const start = dragStartRef.current;
    if (!start) return;
    const point = { x: start.x + e.delta.x, y: start.y + e.delta.y };
    lastDragPointRef.current = point;
    const next = computeSplitPreview(point);
    setSplitPreview((prev) => {
      if (!next && !prev) return prev;
      if (!next) return null;
      if (prev && prev.paneId === next.paneId && prev.direction === next.direction) return prev;
      return next;
    });
  }, [computeSplitPreview]);

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const point = lastDragPointRef.current;

    dragStartRef.current = null;
    lastDragPointRef.current = null;

    const preview = point ? computeSplitPreview(point) : null;
    if (preview) {
      splitSessionToNewPane(activeId, preview.direction, preview.paneId);
      setActiveDragSessionId(null);
      setSplitPreview(null);
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    const shouldTearOff =
      Boolean(rect && point) &&
      Boolean(
        rect &&
          point &&
          (point.x < rect.left - TEAR_OFF_THRESHOLD_PX ||
            point.x > rect.right + TEAR_OFF_THRESHOLD_PX ||
            point.y < rect.top - TEAR_OFF_THRESHOLD_PX ||
            point.y > rect.bottom + TEAR_OFF_THRESHOLD_PX)
      );

    if (shouldTearOff) {
      const session = sessionsById.get(activeId);
      setActiveDragSessionId(null);
      setSplitPreview(null);

      if (!session?.conversationId) return;
      if (session.isGenerating) {
        alert('流式生成中，暂不支持脱离到新窗口');
        return;
      }

      void (async () => {
        const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
        if (dockTarget) {
          try {
            await useSessionStore.getState().dockSessionToWindow(activeId, dockTarget.targetLabel, dockTarget.placement);
            return;
          } catch (err) {
            console.warn('Failed to dock chat window via drag-drop, fallback to popout:', err);
          }
        }

        try {
          const { win, isExisting } = await openOrFocusConversationChatWindow(session.conversationId!, session.title, {
            runMode: session.runMode,
            agentName: session.agentName,
          });
          if (isExisting) {
            void closeSession(activeId);
            return;
          }
          win.once('tauri://created', () => {
            void win.setFocus().catch(() => {});
            void closeSession(activeId);
          });
          win.once('tauri://error', (err) => {
            console.error('Failed to popout chat window:', (err as any)?.payload ?? err);
            alert('打开新窗口失败，请检查窗口权限/配置');
          });
        } catch (err) {
          console.error('Failed to popout chat window:', err);
          alert('当前环境不支持打开新窗口');
        }
      })();
      return;
    }

    const overIdRaw = e.over?.id;
    if (!overIdRaw) {
      setActiveDragSessionId(null);
      setSplitPreview(null);
      return;
    }

    const overId = String(overIdRaw);
    const fromPaneId = sessionToPaneId.get(activeId) ?? null;

    if (overId.startsWith('pane:')) {
      const toPaneId = overId.slice('pane:'.length);
      moveSessionToPane(activeId, toPaneId);
      setActiveDragSessionId(null);
      setSplitPreview(null);
      return;
    }

    const toPaneId = sessionToPaneId.get(overId) ?? null;
    if (!toPaneId) {
      setActiveDragSessionId(null);
      setSplitPreview(null);
      return;
    }

    if (fromPaneId && fromPaneId === toPaneId) {
      reorderSessionInPane(toPaneId, activeId, overId);
    } else {
      const targetPane = paneById.get(toPaneId);
      const index = targetPane ? targetPane.sessionIds.indexOf(overId) : -1;
      moveSessionToPane(activeId, toPaneId, index >= 0 ? index : undefined);
    }

    setActiveDragSessionId(null);
    setSplitPreview(null);
  }, [closeSession, computeSplitPreview, moveSessionToPane, paneById, reorderSessionInPane, sessionToPaneId, sessionsById, splitSessionToNewPane]);

  const startResize = useCallback(
    (leftPaneId: string, rightPaneId: string, startEv: React.MouseEvent) => {
      startEv.preventDefault();
      startEv.stopPropagation();

      const leftEl = paneRootRefs.current.get(leftPaneId);
      const rightEl = paneRootRefs.current.get(rightPaneId);
      if (!leftEl || !rightEl) return;

      const leftRect = leftEl.getBoundingClientRect();
      const rightRect = rightEl.getBoundingClientRect();
      const total = leftRect.width + rightRect.width;
      if (!Number.isFinite(total) || total <= 0) return;

      const leftPane = paneById.get(leftPaneId);
      const rightPane = paneById.get(rightPaneId);
      const groupWeight = (leftPane?.weight ?? 1) + (rightPane?.weight ?? 1);
      const startX = startEv.clientX;

      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const ratio = clamp((leftRect.width + delta) / total, 0.2, 0.8);
        const leftWeight = groupWeight * ratio;
        const rightWeight = groupWeight - leftWeight;
        setPaneWeights([
          { paneId: leftPaneId, weight: leftWeight },
          { paneId: rightPaneId, weight: rightWeight },
        ]);
        setResizeOverlay({ x: ev.clientX, ratio });
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setResizeOverlay(null);
        void saveSessionState();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [paneById, saveSessionState, setPaneWeights]
  );

  if (!hasAnySession) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <p className="text-lg mb-2">暂无活动会话</p>
          <p className="text-sm">点击上方 “+” 按钮创建新会话</p>
        </div>
      </div>
    );
  }

  const canClosePane = resolvedPanes.length > 1;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
    >
      <div ref={containerRef} className="flex h-full w-full overflow-hidden">
        {resolvedPanes.map((pane, idx) => {
          const next = resolvedPanes[idx + 1];
          return (
            <React.Fragment key={pane.id}>
              <ChatPane
                pane={pane}
                sessionsById={sessionsById}
                isFocused={pane.id === resolvedFocusedPaneId}
                canClosePane={canClosePane}
                onFocus={() => {
                  if (!resolvedFocusedPaneId || pane.id !== resolvedFocusedPaneId) {
                    setFocusedPane(pane.id);
                  }
                }}
                onSelectSession={(sessionId) => {
                  switchSession(sessionId);
                }}
                onCloseSession={(sessionId) => {
                  void closeSession(sessionId);
                }}
                onClosePane={() => closePaneAndMerge(pane.id)}
                registerLayerRef={registerLayerRef}
                registerPaneRootRef={registerPaneRootRef}
                registerPaneBodyRef={registerPaneBodyRef}
              />

              {next && (
                <div
                  className="relative w-1 flex-shrink-0 cursor-col-resize bg-gray-200/70 hover:bg-blue-400/60 dark:bg-gray-800 dark:hover:bg-blue-500/40"
                  onMouseDown={(e) => startResize(pane.id, next.id, e)}
                  title="拖拽调整分屏宽度"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      <DragOverlay>
        {activeDragSessionId ? (
          <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
            {sessionsById.get(activeDragSessionId)?.title ?? '会话'}
          </div>
        ) : null}
      </DragOverlay>

      {splitPreview && (
        <div
          className="pointer-events-none fixed z-[240]"
          style={{
            left: `${splitPreview.rect.left}px`,
            top: `${splitPreview.rect.top}px`,
            width: `${splitPreview.rect.width}px`,
            height: `${splitPreview.rect.height}px`,
          }}
        >
          <div className="h-full w-full rounded bg-blue-500/10 outline outline-2 outline-blue-500/40" />
          <div className="absolute left-2 top-2 rounded bg-blue-600 px-2 py-1 text-xs text-white shadow">
            {splitPreview.direction === 'left' ? '分屏到左侧' : '分屏到右侧'}
          </div>
        </div>
      )}

      {resizeOverlay && (
        <div
          className="pointer-events-none fixed z-[260] -translate-x-1/2"
          style={{ left: `${resizeOverlay.x}px`, top: '10px' }}
        >
          <div className="rounded bg-gray-900/80 px-2 py-1 text-xs text-white shadow">
            {Math.round(resizeOverlay.ratio * 100)}%
          </div>
        </div>
      )}
    </DndContext>
  );
};

// 避免主视图切换（activeView 改变）导致 ChatViewContainer 重渲染。
export const ChatViewContainer = React.memo(ChatViewContainerInner);
ChatViewContainer.displayName = 'ChatViewContainer';
