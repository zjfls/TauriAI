import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { AgentSession } from '../types';
import { ChatView } from '../components/Chat/ChatView';
import { DocumentView } from '../components/Documents/DocumentView';
import { TerminalTabView } from '../components/Terminal/TerminalTabView';
import { WebTabView } from '../components/Web/WebTabView';
import { WorkspacePaneHeader } from '../components/Workspace/WorkspacePaneHeader';
import { useDocumentStore } from '../stores/documentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTerminalTabStore } from '../stores/terminalTabStore';
import { useWebTabStore } from '../stores/webTabStore';
import { type WorkspacePane, useWorkspaceLayoutStore } from '../stores/workspaceLayoutStore';
import { chatTabId, parseWorkspaceTabId, type WorkspaceTabId } from '../stores/workspaceTabStore';
import { useDragGhostSession } from '../hooks/useDragGhostSession';
import { endChatOpenProfile, getActiveChatOpenProfile, markChatOpenProfile } from '../utils/chatOpenProfile';
import {
  closeCurrentWindow,
  dockWorkspaceItemToWindow,
  findChatDockTargetAtCursor,
  getViewWindowParams,
  openOrFocusConversationChatWindow,
  openViewWindow,
} from '../utils/viewWindow';

const MemoChatView = React.memo(ChatView);
MemoChatView.displayName = 'MemoChatView';

const TEAR_OFF_THRESHOLD_PX = 48;
// VS Code 风格：只要鼠标确实拖到了“窗体之外”，就应当支持把 tab 脱离为新窗口/停靠到其它窗口。
// 这里用更小的阈值做“窗外”判定，避免用户必须把鼠标拖得很远才触发。
const TEAR_OFF_WINDOW_THRESHOLD_PX = 8;

type SplitPreview = {
  paneId: string;
  direction: 'left' | 'right';
  rect: DOMRect;
};

const WorkspacePaneView: React.FC<{
  pane: WorkspacePane;
  sessionsById: Map<string, AgentSession>;
  isFocused: boolean;
  canClosePane: boolean;
  onFocus: () => void;
  onSelectTab: (tabId: WorkspaceTabId) => void;
  onCloseTab: (tabId: WorkspaceTabId) => void;
  onClosePane: () => void;
  registerLayerRef: (tabId: WorkspaceTabId) => (el: HTMLDivElement | null) => void;
  registerPaneRootRef: (paneId: string) => (el: HTMLDivElement | null) => void;
  registerPaneBodyRef: (paneId: string) => (el: HTMLDivElement | null) => void;
}> = ({
  pane,
  sessionsById,
  isFocused,
  canClosePane,
  onFocus,
  onSelectTab,
  onCloseTab,
  onClosePane,
  registerLayerRef,
  registerPaneRootRef,
  registerPaneBodyRef,
}) => {
  const activeTabId =
    pane.activeTabId && pane.tabIds.includes(pane.activeTabId) ? pane.activeTabId : pane.tabIds[0] ?? null;

  useEffect(() => {
    // 当 pane 内没有任何可渲染的 tab 时（例如关闭/拖走了最后一个 tab），自动销毁该 pane。
    if (pane.tabIds.length > 0) return;
    if (!canClosePane) return;
    onClosePane();
  }, [canClosePane, onClosePane, pane.tabIds.length]);

  const renderTab = (tabId: WorkspaceTabId) => {
    const parsed = parseWorkspaceTabId(tabId);
    if (parsed.kind === 'chat') {
      const sid = parsed.sessionId;
      if (!sid) return null;
      return <MemoChatView sessionId={sid} autoFocus={isFocused && tabId === activeTabId} />;
    }
    if (parsed.kind === 'document') {
      const did = parsed.documentId;
      if (!did) return null;
      return <DocumentView documentId={did} />;
    }
    if (parsed.kind === 'web') {
      const wid = parsed.webTabId;
      if (!wid) return null;
      return <WebTabView webTabId={wid} />;
    }
    const tid = parsed.terminalTabId;
    if (!tid) return null;
    return <TerminalTabView terminalTabId={tid} isActive={isFocused && tabId === activeTabId} />;
  };

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
      <WorkspacePaneHeader
        paneId={pane.id}
        tabIds={pane.tabIds}
        activeTabId={activeTabId}
        sessionsById={sessionsById}
        isFocused={isFocused}
        canClosePane={canClosePane}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onClosePane={onClosePane}
      />

      <div ref={registerPaneBodyRef(pane.id)} className="relative flex-1 overflow-hidden">
        {pane.tabIds.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">暂无标签</div>
        ) : (
          pane.tabIds.map((tabId) => (
            <div
              key={tabId}
              ref={registerLayerRef(tabId)}
              className={`absolute inset-0 ${tabId === activeTabId ? '' : 'invisible pointer-events-none'}`}
              aria-hidden={tabId !== activeTabId}
            >
              {renderTab(tabId)}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

const ChatViewContainerInner: React.FC = () => {
  const panes = useWorkspaceLayoutStore((state) => state.panes);
  const focusedPaneId = useWorkspaceLayoutStore((state) => state.focusedPaneId);
  const setFocusedPane = useWorkspaceLayoutStore((state) => state.setFocusedPane);
  const setActiveTabInPane = useWorkspaceLayoutStore((state) => state.setActiveTabInPane);
  const closePaneAndMerge = useWorkspaceLayoutStore((state) => state.closePaneAndMerge);
  const reorderTabInPane = useWorkspaceLayoutStore((state) => state.reorderTabInPane);
  const moveTabToPane = useWorkspaceLayoutStore((state) => state.moveTabToPane);
  const splitTabToNewPane = useWorkspaceLayoutStore((state) => state.splitTabToNewPane);
  const setPaneWeights = useWorkspaceLayoutStore((state) => state.setPaneWeights);
  const saveLayout = useWorkspaceLayoutStore((state) => state.saveLayout);
  const closeTabInLayout = useWorkspaceLayoutStore((state) => state.closeTabInLayout);
  const replaceLayout = useWorkspaceLayoutStore((state) => state.replaceLayout);

  const sessionsMap = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessionsHydrated = useSessionStore((state) => state.hydrated);
  const switchSession = useSessionStore((state) => state.switchSession);
  const closeSession = useSessionStore((state) => state.closeSession);

  const documents = useDocumentStore((s) => s.documents);
  const closeDocument = useDocumentStore((s) => s.closeDocument);
  const setActiveDocument = useDocumentStore((s) => s.setActiveDocument);

  const webTabs = useWebTabStore((s) => s.tabs);
  const closeWebTab = useWebTabStore((s) => s.closeWebTab);
  const setActiveWebTab = useWebTabStore((s) => s.setActiveWebTab);

  const terminalTabs = useTerminalTabStore((s) => s.tabs);
  const closeTerminalTab = useTerminalTabStore((s) => s.closeTerminalTab);
  const setActiveTerminalTab = useTerminalTabStore((s) => s.setActiveTerminalTab);

  const layerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneRootRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const profileScheduledRef = useRef<string | null>(null);
  const fallbackPaneIdRef = useRef<string>(crypto.randomUUID());

  const sessionsById = useMemo(() => sessionsMap, [sessionsMap]);

  const validTabIds = useMemo(() => {
    const set = new Set<WorkspaceTabId>();
    for (const sid of sessionsMap.keys()) set.add(chatTabId(sid));
    for (const d of documents) set.add(`doc:${d.id}` as WorkspaceTabId);
    for (const w of webTabs) set.add(`web:${w.id}` as WorkspaceTabId);
    for (const t of terminalTabs) set.add(`term:${t.id}` as WorkspaceTabId);
    return set;
  }, [documents, panes, sessionsMap, terminalTabs, webTabs]);

  const resolvedPanes = useMemo((): WorkspacePane[] => {
    const base =
      panes.length > 0
        ? panes
        : [
            {
              id: fallbackPaneIdRef.current,
              tabIds: [],
              activeTabId: null,
              weight: 1,
            } satisfies WorkspacePane,
          ];

    const assigned = new Set<WorkspaceTabId>();
    const cleaned: WorkspacePane[] = base.map((p) => {
      const filtered: WorkspaceTabId[] = [];
      for (const tid of p.tabIds) {
        if (!validTabIds.has(tid)) continue;
        if (assigned.has(tid)) continue;
        assigned.add(tid);
        filtered.push(tid);
      }
      const active = p.activeTabId && filtered.includes(p.activeTabId) ? p.activeTabId : filtered[0] ?? null;
      return {
        ...p,
        tabIds: filtered,
        activeTabId: active,
        weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
      };
    });

    const nonEmpty = cleaned.filter((p) => p.tabIds.length > 0);
    if (nonEmpty.length > 0) return nonEmpty;

    if (sessionsMap.size > 0) {
      const ids = Array.from(sessionsMap.keys());
      const tabs = ids.map((sid) => chatTabId(sid));
      const preferred = (() => {
        const profile = getActiveChatOpenProfile();
        const fromProfile = profile?.sessionId ? chatTabId(profile.sessionId) : null;
        if (fromProfile && validTabIds.has(fromProfile)) return fromProfile;
        if (activeSessionId) return chatTabId(activeSessionId);
        return tabs[0] ?? null;
      })();

      return [
        {
          id: fallbackPaneIdRef.current,
          tabIds: tabs,
          activeTabId: preferred,
          weight: 1,
        },
      ];
    }

    return [
      {
        id: fallbackPaneIdRef.current,
        tabIds: [],
        activeTabId: null,
        weight: 1,
      },
    ];
  }, [activeSessionId, panes, sessionsMap, validTabIds]);

  // Standalone "popout" window: when it becomes empty (all tabs closed), close the window itself.
  // 说明：这类窗口通常通过“拖拽/弹出”产生，用完即走：
  // - `noDefaultSession=1`：文档/网页/终端等 workspace 容器窗口
  // - `conversationId!=null`：对话专用窗口（从主窗口拖出/弹出）
  const { standalone: isStandaloneWindow, noDefaultSession, conversationId } = useMemo(() => getViewWindowParams(), []);
  const shouldCloseOnEmpty = Boolean(noDefaultSession || conversationId);
  const hasEverHadTabsRef = useRef(false);
  const hasAnyTabsNow = useMemo(() => resolvedPanes.some((p) => p.tabIds.length > 0), [resolvedPanes]);

  useEffect(() => {
    if (hasAnyTabsNow) hasEverHadTabsRef.current = true;
  }, [hasAnyTabsNow]);

  useEffect(() => {
    if (!isStandaloneWindow) return;
    if (!shouldCloseOnEmpty) return;
    if (!hasEverHadTabsRef.current) return;
    if (hasAnyTabsNow) return;
    void closeCurrentWindow().catch(() => {});
  }, [hasAnyTabsNow, isStandaloneWindow, shouldCloseOnEmpty]);

  const resolvedFocusedPaneId = useMemo(() => {
    if (focusedPaneId && resolvedPanes.some((p) => p.id === focusedPaneId)) return focusedPaneId;
    return resolvedPanes[0]?.id ?? null;
  }, [focusedPaneId, resolvedPanes]);

  useEffect(() => {
    if (!sessionsHydrated) return;
    if (!resolvedFocusedPaneId) return;
    if (focusedPaneId === resolvedFocusedPaneId) return;
    setFocusedPane(resolvedFocusedPaneId);
  }, [focusedPaneId, resolvedFocusedPaneId, sessionsHydrated, setFocusedPane]);

  const resolvedLayoutKey = useMemo(() => {
    return `${resolvedFocusedPaneId ?? ''}|${resolvedPanes
      .map((p) => `${p.id}:${p.activeTabId ?? ''}:${p.tabIds.join(',')}:${p.weight}`)
      .join('|')}`;
  }, [resolvedFocusedPaneId, resolvedPanes]);
  const storedLayoutKey = useMemo(() => {
    return `${focusedPaneId ?? ''}|${panes.map((p) => `${p.id}:${p.activeTabId ?? ''}:${p.tabIds.join(',')}:${p.weight}`).join('|')}`;
  }, [focusedPaneId, panes]);
  useEffect(() => {
    if (!sessionsHydrated) return;
    if (!resolvedFocusedPaneId) return;
    if (resolvedLayoutKey === storedLayoutKey) return;
    replaceLayout({ panes: resolvedPanes, focusedPaneId: resolvedFocusedPaneId });
  }, [replaceLayout, resolvedFocusedPaneId, resolvedLayoutKey, resolvedPanes, sessionsHydrated, storedLayoutKey]);

  const visibleTabKey = useMemo(() => resolvedPanes.map((p) => p.activeTabId ?? '').join('|'), [resolvedPanes]);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLElement)) return;
    const visible = new Set<string>();
    for (const p of resolvedPanes) {
      if (p.activeTabId) visible.add(p.activeTabId);
    }
    for (const [tabId, el] of layerRefs.current) {
      if (visible.has(tabId)) continue;
      if (el.contains(active)) {
        active.blur();
        break;
      }
    }
  }, [visibleTabKey, resolvedPanes]);

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
    (tabId: WorkspaceTabId) => (el: HTMLDivElement | null) => {
      const map = layerRefs.current;
      if (el) map.set(tabId, el);
      else map.delete(tabId);
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

  const tabToPaneId = useMemo(() => {
    const map = new Map<WorkspaceTabId, string>();
    for (const p of resolvedPanes) {
      for (const tid of p.tabIds) map.set(tid, p.id);
    }
    return map;
  }, [resolvedPanes]);

  const paneById = useMemo(() => {
    const map = new Map<string, WorkspacePane>();
    for (const p of resolvedPanes) map.set(p.id, p);
    return map;
  }, [resolvedPanes]);

  const computeSplitPreview = useCallback((point: { x: number; y: number }): SplitPreview | null => {
    const entries = Array.from(paneBodyRefs.current.entries());
    for (const [paneId, el] of entries) {
      const rect = el.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) continue;
      const width = rect.width;
      if (!Number.isFinite(width) || width <= 0) continue;
      // 分屏触发区不要太“像素级”：降低拖到边缘才能分屏的门槛。
      // 这里用“固定最小值 + 按宽度比例 + 上限”做一个更宽松的边缘判定区。
      const edge = Math.max(56, Math.min(140, Math.round(rect.width * 0.18)));
      const distLeft = point.x - rect.left;
      const distRight = rect.right - point.x;
      if (distLeft <= edge) {
        const half: DOMRect = new DOMRect(rect.left, rect.top, rect.width / 2, rect.height);
        return { paneId, direction: 'left', rect: half };
      }
      if (distRight <= edge) {
        const half: DOMRect = new DOMRect(rect.left + rect.width / 2, rect.top, rect.width / 2, rect.height);
        return { paneId, direction: 'right', rect: half };
      }
    }
    return null;
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { start: startDragGhost, stop: stopDragGhost, extend: extendDragGhost } = useDragGhostSession({
    thresholdPx: TEAR_OFF_WINDOW_THRESHOLD_PX,
    pollIntervalMs: 32,
  });

  const resolveDragGhostTitle = useCallback(
    (tabId: WorkspaceTabId): string => {
      const parsed = parseWorkspaceTabId(tabId);
      if (parsed.kind === 'chat') {
        return parsed.sessionId ? sessionsById.get(parsed.sessionId)?.title ?? '会话' : '会话';
      }
      if (parsed.kind === 'document') {
        return parsed.documentId ? documents.find((d) => d.id === parsed.documentId)?.title ?? '文档' : '文档';
      }
      if (parsed.kind === 'web') {
        return parsed.webTabId ? webTabs.find((t) => t.id === parsed.webTabId)?.title ?? '网页' : '网页';
      }
      return parsed.terminalTabId ? terminalTabs.find((t) => t.id === parsed.terminalTabId)?.title ?? '终端' : '终端';
    },
    [documents, sessionsById, terminalTabs, webTabs]
  );

  const [activeDragTabId, setActiveDragTabId] = useState<WorkspaceTabId | null>(null);
  const [splitPreview, setSplitPreview] = useState<SplitPreview | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragCancelledByEscapeRef = useRef(false);
  const [resizeOverlay, setResizeOverlay] = useState<{ x: number; ratio: number } | null>(null);

  useEffect(() => {
    if (!activeDragTabId) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      dragCancelledByEscapeRef.current = true;
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeDragTabId]);

  const isCursorOutsideCurrentWindow = useCallback(async (thresholdPx: number): Promise<boolean> => {
    try {
      const [cursor, pos, size] = await Promise.all([
        cursorPosition().catch(() => null),
        getCurrentWebviewWindow().outerPosition().catch(() => null),
        getCurrentWebviewWindow().outerSize().catch(() => null),
      ]);
      if (!cursor || !pos || !size) return false;
      const left = pos.x - thresholdPx;
      const top = pos.y - thresholdPx;
      const right = pos.x + size.width + thresholdPx;
      const bottom = pos.y + size.height + thresholdPx;
      return cursor.x < left || cursor.x > right || cursor.y < top || cursor.y > bottom;
    } catch {
      return false;
    }
  }, []);

  const tearOffTabToNewWindow = useCallback(
    (tabId: WorkspaceTabId) => {
      const parsed = parseWorkspaceTabId(tabId);
      if (parsed.kind === 'chat') {
        const session = parsed.sessionId ? sessionsById.get(parsed.sessionId) : undefined;
        if (!session?.conversationId) return;
        if (session.isGenerating) {
          alert('流式生成中，暂不支持脱离到新窗口');
          return;
        }

        void (async () => {
          const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
          if (dockTarget) {
            try {
              await useSessionStore
                .getState()
                .dockSessionToWindow(parsed.sessionId!, dockTarget.targetLabel, dockTarget.placement);
              closeTabInLayout(tabId);
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
              closeTabInLayout(tabId);
              void closeSession(parsed.sessionId!);
              return;
            }
            win.once('tauri://created', () => {
              void win.setFocus().catch(() => {});
              closeTabInLayout(tabId);
              void closeSession(parsed.sessionId!);
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

      if (parsed.kind === 'document') {
        const doc = parsed.documentId ? documents.find((d) => d.id === parsed.documentId) : undefined;
        if (!doc?.path) {
          alert('该文档尚未保存到文件，暂不支持在新窗口打开');
          return;
        }
        const documentPath = doc.path;
        void (async () => {
          const item = { kind: 'document' as const, title: doc.title, documentPath };

          const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
          if (dockTarget) {
            try {
              await dockWorkspaceItemToWindow(item, dockTarget.targetLabel, dockTarget.placement);
              closeTabInLayout(tabId);
              closeDocument(doc.id);
              return;
            } catch (err) {
              console.warn('Failed to dock document tab via drag-drop, fallback to popout:', err);
            }
          }

          try {
            const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const win = openViewWindow('chat', doc.title, { label, noDefaultSession: true });
            await dockWorkspaceItemToWindow(item, win, 'tab');
            closeTabInLayout(tabId);
            closeDocument(doc.id);
          } catch (err) {
            console.error('Failed to popout document tab:', err);
            alert('当前环境不支持打开新窗口');
          }
        })();
        return;
      }

      if (parsed.kind === 'web') {
        const tab = parsed.webTabId ? webTabs.find((t) => t.id === parsed.webTabId) : undefined;
        if (!tab) return;
        void (async () => {
          const item = { kind: 'web' as const, title: tab.title, webUrl: tab.url };

          const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
          if (dockTarget) {
            try {
              await dockWorkspaceItemToWindow(item, dockTarget.targetLabel, dockTarget.placement);
              closeTabInLayout(tabId);
              closeWebTab(tab.id);
              return;
            } catch (err) {
              console.warn('Failed to dock web tab via drag-drop, fallback to popout:', err);
            }
          }

          try {
            const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const win = openViewWindow('chat', tab.title || '网页', { label, noDefaultSession: true });
            await dockWorkspaceItemToWindow(item, win, 'tab');
            closeTabInLayout(tabId);
            closeWebTab(tab.id);
          } catch (err) {
            console.error('Failed to popout web tab:', err);
            alert('当前环境不支持打开新窗口');
          }
        })();
        return;
      }

      const tab = parsed.terminalTabId ? terminalTabs.find((t) => t.id === parsed.terminalTabId) : undefined;
      if (!tab) return;
      void (async () => {
        const item = { kind: 'terminal' as const, title: tab.title, terminalWorkdir: tab.workdir ?? undefined };

        const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
        if (dockTarget) {
          try {
            await dockWorkspaceItemToWindow(item, dockTarget.targetLabel, dockTarget.placement);
            closeTabInLayout(tabId);
            void closeTerminalTab(tab.id);
            return;
          } catch (err) {
            console.warn('Failed to dock terminal tab via drag-drop, fallback to popout:', err);
          }
        }

        try {
          const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const win = openViewWindow('chat', tab.title || '终端', { label, noDefaultSession: true });
          await dockWorkspaceItemToWindow(item, win, 'tab');
          closeTabInLayout(tabId);
          void closeTerminalTab(tab.id);
        } catch (err) {
          console.error('Failed to popout terminal tab:', err);
          alert('当前环境不支持打开新窗口');
        }
      })();
    },
    [
      closeDocument,
      closeSession,
      closeTabInLayout,
      closeTerminalTab,
      closeWebTab,
      dockWorkspaceItemToWindow,
      documents,
      findChatDockTargetAtCursor,
      openOrFocusConversationChatWindow,
      openViewWindow,
      sessionsById,
      terminalTabs,
      webTabs,
    ]
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const activeId = String(e.active.id) as WorkspaceTabId;
    setActiveDragTabId(activeId);
    setSplitPreview(null);
    dragCancelledByEscapeRef.current = false;
    startDragGhost(resolveDragGhostTitle(activeId));

    const ev = e.activatorEvent as MouseEvent | PointerEvent | TouchEvent | null;
    if (ev && 'clientX' in ev) {
      dragStartRef.current = { x: ev.clientX, y: ev.clientY };
      lastDragPointRef.current = { x: ev.clientX, y: ev.clientY };
    } else {
      dragStartRef.current = null;
      lastDragPointRef.current = null;
    }
  }, [resolveDragGhostTitle, startDragGhost]);

  const handleDragMove = useCallback(
    (e: DragMoveEvent) => {
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
    },
    [computeSplitPreview]
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const activeId = String(e.active.id) as WorkspaceTabId;
      const overIdRaw = e.over?.id;
      const point = lastDragPointRef.current;

      dragStartRef.current = null;
      lastDragPointRef.current = null;

      const preview = point ? computeSplitPreview(point) : null;
      if (preview) {
        splitTabToNewPane(activeId, preview.direction, preview.paneId);
        setActiveDragTabId(null);
        setSplitPreview(null);
        stopDragGhost();
        return;
      }

      const rect = containerRef.current?.getBoundingClientRect();
      const shouldTearOffByClientPoint =
        Boolean(rect && point) &&
        Boolean(
          rect &&
            point &&
            (point.x < rect.left - TEAR_OFF_THRESHOLD_PX ||
              point.x > rect.right + TEAR_OFF_THRESHOLD_PX ||
              point.y < rect.top - TEAR_OFF_THRESHOLD_PX ||
              point.y > rect.bottom + TEAR_OFF_THRESHOLD_PX)
        );

      // 先把拖拽 UI 收起，避免异步判断期间 overlay 悬挂
      setActiveDragTabId(null);
      setSplitPreview(null);
      stopDragGhost();

      if (shouldTearOffByClientPoint) {
        tearOffTabToNewWindow(activeId);
        return;
      }

      // 有些平台/环境下，拖拽离开窗口后 pointer move 事件不再更新，
      // 导致 `client point` 仍停留在窗内，进而无法触发 tear-off。
      // 参考 VS Code：在 drag end 时用“真实鼠标位置 vs 当前窗体”做一次兜底判断。
      void (async () => {
        const outsideWindow = await isCursorOutsideCurrentWindow(TEAR_OFF_WINDOW_THRESHOLD_PX);
        if (outsideWindow) {
          tearOffTabToNewWindow(activeId);
          return;
        }

        if (!overIdRaw) return;

        const overId = String(overIdRaw) as WorkspaceTabId | string;
        const fromPaneId = tabToPaneId.get(activeId) ?? null;

        if (overId.startsWith('pane:')) {
          const toPaneId = overId.slice('pane:'.length);
          moveTabToPane(activeId, toPaneId);
          return;
        }

        const toPaneId = tabToPaneId.get(overId as WorkspaceTabId) ?? null;
        if (!toPaneId) return;

        if (fromPaneId && fromPaneId === toPaneId) {
          reorderTabInPane(toPaneId, activeId, overId as WorkspaceTabId);
          return;
        }

        const targetPane = paneById.get(toPaneId);
        const index = targetPane ? targetPane.tabIds.indexOf(overId as WorkspaceTabId) : -1;
        moveTabToPane(activeId, toPaneId, index >= 0 ? index : undefined);
      })();
    },
    [
      computeSplitPreview,
      isCursorOutsideCurrentWindow,
      moveTabToPane,
      paneById,
      reorderTabInPane,
      splitTabToNewPane,
      stopDragGhost,
      tabToPaneId,
      tearOffTabToNewWindow,
    ]
  );

  const handleDragCancel = useCallback(
    (e: DragCancelEvent) => {
      const activeId = String(e.active.id) as WorkspaceTabId;
      const start = dragStartRef.current;
      const point = lastDragPointRef.current;

      dragStartRef.current = null;
      lastDragPointRef.current = null;

      setActiveDragTabId(null);
      setSplitPreview(null);

      // 重要：拖拽离开窗口/进入其它应用时，dnd-kit 往往会触发 cancel，导致 DOM overlay 立刻消失。
      // 这里保持短时间的“窗外幽灵 tab”显示，让用户仍能看到拖拽对象。
      if (!dragCancelledByEscapeRef.current) {
        extendDragGhost(1200);
      } else {
        stopDragGhost();
      }

      void (async () => {
        // Esc 取消：不触发“拖出窗口”逻辑
        if (dragCancelledByEscapeRef.current) return;

        const preview = point ? computeSplitPreview(point) : null;
        if (preview) {
          splitTabToNewPane(activeId, preview.direction, preview.paneId);
          return;
        }

        const rect = containerRef.current?.getBoundingClientRect();
        const outsideContainer =
          Boolean(rect && point) &&
          Boolean(
            rect &&
              point &&
              (point.x < rect.left - TEAR_OFF_THRESHOLD_PX ||
                point.x > rect.right + TEAR_OFF_THRESHOLD_PX ||
                point.y < rect.top - TEAR_OFF_THRESHOLD_PX ||
                point.y > rect.bottom + TEAR_OFF_THRESHOLD_PX)
          );

        const movedDist = start && point ? Math.hypot(point.x - start.x, point.y - start.y) : 0;
        const lostFocus = typeof document !== 'undefined' ? !document.hasFocus() : false;
        const outsideWindow = await isCursorOutsideCurrentWindow(TEAR_OFF_WINDOW_THRESHOLD_PX);

        // 兼容：把 Tab 拖到其他应用窗口（可能导致 DnD cancel），依然要按“拖出窗体”处理。
        // 要求：确实发生了拖拽（移动距离够大），且出现了“明显外部”信号（失焦/游标在窗外/point 已在窗外）。
        const shouldTearOffOnCancel = movedDist >= 24 && (outsideContainer || lostFocus || outsideWindow);

        if (shouldTearOffOnCancel) {
          tearOffTabToNewWindow(activeId);
        }
      })();
    },
    [computeSplitPreview, extendDragGhost, isCursorOutsideCurrentWindow, splitTabToNewPane, stopDragGhost, tearOffTabToNewWindow]
  );

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
        saveLayout();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [paneById, saveLayout, setPaneWeights]
  );

  const canClosePane = resolvedPanes.length > 1;

  const closeTab = useCallback(
    (tabId: WorkspaceTabId) => {
      const parsed = parseWorkspaceTabId(tabId);
      closeTabInLayout(tabId);
      if (parsed.kind === 'chat') {
        if (parsed.sessionId) void closeSession(parsed.sessionId);
        return;
      }
      if (parsed.kind === 'document') {
        if (parsed.documentId) closeDocument(parsed.documentId);
        return;
      }
      if (parsed.kind === 'web') {
        if (parsed.webTabId) closeWebTab(parsed.webTabId);
        return;
      }
      if (parsed.terminalTabId) void closeTerminalTab(parsed.terminalTabId);
    },
    [closeDocument, closeSession, closeTabInLayout, closeTerminalTab, closeWebTab]
  );

  const selectTab = useCallback(
    (paneId: string, tabId: WorkspaceTabId) => {
      const parsed = parseWorkspaceTabId(tabId);
      if (parsed.kind === 'chat' && parsed.sessionId) {
        switchSession(parsed.sessionId);
      } else if (parsed.kind === 'document' && parsed.documentId) {
        setActiveDocument(parsed.documentId);
      } else if (parsed.kind === 'web' && parsed.webTabId) {
        setActiveWebTab(parsed.webTabId);
      } else if (parsed.kind === 'terminal' && parsed.terminalTabId) {
        setActiveTerminalTab(parsed.terminalTabId);
      }
      setActiveTabInPane(paneId, tabId);
    },
    [setActiveDocument, setActiveTabInPane, setActiveTerminalTab, setActiveWebTab, switchSession]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div ref={containerRef} className="flex h-full w-full overflow-hidden">
        {resolvedPanes.map((pane, idx) => {
          const next = resolvedPanes[idx + 1];
          return (
            <React.Fragment key={pane.id}>
              <WorkspacePaneView
                pane={pane}
                sessionsById={sessionsById}
                isFocused={pane.id === resolvedFocusedPaneId}
                canClosePane={canClosePane}
                onFocus={() => {
                  if (!resolvedFocusedPaneId || pane.id !== resolvedFocusedPaneId) {
                    setFocusedPane(pane.id);
                  }
                }}
                onSelectTab={(tabId) => selectTab(pane.id, tabId)}
                onCloseTab={(tabId) => closeTab(tabId)}
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
        {activeDragTabId ? (
          <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
            {(() => {
              const parsed = parseWorkspaceTabId(activeDragTabId);
              if (parsed.kind === 'chat') {
                return parsed.sessionId ? sessionsById.get(parsed.sessionId)?.title ?? '会话' : '会话';
              }
              if (parsed.kind === 'document') {
                return parsed.documentId ? documents.find((d) => d.id === parsed.documentId)?.title ?? '文档' : '文档';
              }
              if (parsed.kind === 'web') {
                return parsed.webTabId ? webTabs.find((t) => t.id === parsed.webTabId)?.title ?? '网页' : '网页';
              }
              return parsed.terminalTabId
                ? terminalTabs.find((t) => t.id === parsed.terminalTabId)?.title ?? '终端'
                : '终端';
            })()}
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

// 避免主视图切换（activeView 改变）导致 ChatViewContainer 重渲染
export const ChatViewContainer = React.memo(ChatViewContainerInner);
ChatViewContainer.displayName = 'ChatViewContainer';
