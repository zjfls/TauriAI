/**
 * WorkspaceTabBar
 * A unified tab strip for chat sessions + opened documents, with:
 * - DnD reorder (dnd-kit)
 * - "tear-off" popout to a new window
 * - right-click context menu (close / close others / close left/right / open in new window)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bot, ChevronDown, FileText, Loader2, Menu, MessageSquare, History, Settings, Plus, X, Globe, Terminal } from 'lucide-react';
import type { Agent, AgentSession } from '../../types';
import { useDocumentStore } from '../../stores/documentStore';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWebTabStore } from '../../stores/webTabStore';
import { useTerminalTabStore } from '../../stores/terminalTabStore';
import { useWindowLayoutStore } from '../../stores/windowLayoutStore';
import {
  parseWorkspaceTabId,
  useWorkspaceTabStore,
  type WorkspaceTabId,
} from '../../stores/workspaceTabStore';
import { useDragGhostSession } from '../../hooks/useDragGhostSession';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { dockWorkspaceItemToWindow, findChatDockTargetAtCursor, openViewWindow } from '../../utils/viewWindow';
import { WorkspaceTabContextMenu } from './WorkspaceTabContextMenu';

interface WorkspaceTabBarProps {
  sessions: AgentSession[];
  agents: Agent[];
  onTabClick: (sessionId: string) => void;
  onTabClose: (sessionId: string) => Promise<void> | void;
  onNewSession: (agentName: string) => void | Promise<void>;
  onPopoutSession?: (sessionId: string) => void | Promise<void>;
  /** 是否在顶部栏展示 tabs（多 Pane 模式下应关闭，改为每个 Pane 自己的 `WindowPaneHeader` 承载 tabs） */
  showChatTabs?: boolean;
}

interface TabRenderItem {
  id: WorkspaceTabId;
  kind: 'chat' | 'document' | 'web' | 'terminal';
  title: string;
  // For chat
  session?: AgentSession;
  // For document
  doc?: {
    id: string;
    title: string;
    path?: string;
  };
  // For web/terminal
  webTab?: { id: string; title: string; url: string };
  terminalTab?: { id: string; title: string; workdir?: string | null };
}

const TEAR_OFF_THRESHOLD_PX = 48;
const TEAR_OFF_WINDOW_THRESHOLD_PX = 8;
const GHOST_ACTIVATE_THRESHOLD_PX = 2;

const AgentSelector: React.FC<{
  agents: Agent[];
  onSelect: (agentName: string) => void;
  onClose: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}> = ({ agents, onSelect, onClose, buttonRef }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });

  useEffect(() => {
    const updatePosition = () => {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setPosition({
          top: rect.bottom + 4,
          right: window.innerWidth - rect.right,
        });
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [buttonRef]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (agents.length === 0) {
    return (
      <div
        ref={dropdownRef}
        className="fixed w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-[100]"
        style={{ top: `${position.top}px`, right: `${position.right}px` }}
      >
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
          暂无配置的智能体，请先在设置中添加智能体
        </div>
      </div>
    );
  }

  return (
    <div
      ref={dropdownRef}
      className="fixed w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-[100] max-h-80 overflow-auto"
      style={{ top: `${position.top}px`, right: `${position.right}px` }}
    >
      <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
        选择智能体
      </div>
      {agents.map((agent) => (
        <button
          key={agent.name}
          onClick={() => {
            onSelect(agent.name);
            onClose();
          }}
          className="flex flex-col w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <span className="text-sm font-medium text-gray-800 dark:text-white">
            {agent.displayName}
          </span>
          {agent.description && (
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {agent.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};

const SortableWorkspaceTab: React.FC<{
  item: TabRenderItem;
  isActive: boolean;
  titleOverride?: string | null;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = ({ item, isActive, titleOverride, onSelect, onClose, onContextMenu }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const icon = (() => {
    if (item.kind === 'chat') {
      return (
        <div className="flex-shrink-0">
          {item.session?.isGenerating ? (
            <Loader2 size={14} className="animate-spin text-blue-500" />
          ) : (
            <Bot size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />
          )}
        </div>
      );
    }
    if (item.kind === 'web') {
      return <Globe size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />;
    }
    if (item.kind === 'terminal') {
      return <Terminal size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />;
    }
    return <FileText size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />;
  })();

  const badge =
    item.kind === 'chat' && item.session?.apiType === 'responses' ? (
      <span
        className="text-xs px-1 rounded bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-300"
        title="Responses API"
      >
        R
      </span>
    ) : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-workspace-tab-id={item.id}
      className={[
        'group relative flex items-center gap-2 px-3 py-2 min-w-[140px] max-w-[320px]',
        'cursor-pointer select-none transition-colors duration-150 border-b-2',
        isActive
          ? 'bg-white dark:bg-gray-800 border-blue-500 text-gray-800 dark:text-white'
          : 'bg-gray-50 dark:bg-gray-900 border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200',
      ].join(' ')}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={titleOverride ?? item.title}
      {...attributes}
      {...listeners}
    >
      {icon}
      <span className="flex-1 min-w-0 text-sm font-medium truncate flex items-center gap-1">
        {item.title}
        {badge}
      </span>

      <button
        onClick={onClose}
        className={[
          'flex-shrink-0 p-0.5 rounded transition-colors',
          isActive
            ? 'inline-flex hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            : 'hidden group-hover:inline-flex hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300',
        ].join(' ')}
        title="关闭标签"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export const WorkspaceTabBar: React.FC<WorkspaceTabBarProps> = ({
  sessions,
  agents,
  onTabClick,
  onTabClose,
  onNewSession,
  onPopoutSession,
  showChatTabs = true,
}) => {
  const tabBarRef = useRef<HTMLDivElement>(null);
  const newSessionButtonRef = useRef<HTMLButtonElement>(null);
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);

  const documents = useDocumentStore((s) => s.documents);
  const setActiveDocument = useDocumentStore((s) => s.setActiveDocument);
  const closeDocument = useDocumentStore((s) => s.closeDocument);

  const webTabs = useWebTabStore((s) => s.tabs);
  const setActiveWebTab = useWebTabStore((s) => s.setActiveWebTab);
  const closeWebTab = useWebTabStore((s) => s.closeWebTab);

  const terminalTabs = useTerminalTabStore((s) => s.tabs);
  const setActiveTerminalTab = useTerminalTabStore((s) => s.setActiveTerminalTab);
  const closeTerminalTab = useTerminalTabStore((s) => s.closeTerminalTab);

  const tabOrder = useWorkspaceTabStore((s) => s.tabOrder);
  const reorderTabs = useWorkspaceTabStore((s) => s.reorderTabs);
  const syncTabs = useWorkspaceTabStore((s) => s.syncTabs);

  const sessionsById = useMemo(() => {
    const map = new Map<string, AgentSession>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const workspacePanes = useWindowLayoutStore((s) => s.panes);
  const workspaceFocusedPaneId = useWindowLayoutStore((s) => s.focusedPaneId);

  const activeWorkspaceTabId = useMemo(() => {
    const panes = workspacePanes ?? [];
    if (panes.length === 0) return null;
    const focused = workspaceFocusedPaneId ? panes.find((p) => p.id === workspaceFocusedPaneId) : null;
    const pane = focused ?? panes[0] ?? null;
    return pane?.activeTabId ?? null;
  }, [workspaceFocusedPaneId, workspacePanes]);

  // Keep workspace tab order consistent with current sessions/documents.
  useEffect(() => {
    syncTabs(
      sessions.map((s) => s.id),
      documents.map((d) => d.id),
      webTabs.map((t) => t.id),
      terminalTabs.map((t) => t.id)
    );
  }, [sessions, documents, webTabs, terminalTabs, syncTabs]);

  const items = useMemo((): TabRenderItem[] => {
    // Multi-pane 模式下：每个 Pane 自己有 `WindowPaneHeader` 承载 tab
    // 这里仅保留右侧的 View 菜单与“新建会话”入口，避免顶部再出现重复的 tab 条。
    if (!showChatTabs) return [];
    const out: TabRenderItem[] = [];
    for (const id of tabOrder) {
      const parsed = parseWorkspaceTabId(id);
      if (parsed.kind === 'chat') {
        const session = parsed.sessionId ? sessionsById.get(parsed.sessionId) : undefined;
        if (!session) continue;
        out.push({
          id,
          kind: 'chat',
          title: session.title,
          session,
        });
      } else if (parsed.kind === 'document') {
        const docId = parsed.documentId;
        const doc = docId ? documents.find((d) => d.id === docId) : undefined;
        if (!doc) continue;
        out.push({
          id,
          kind: 'document',
          title: doc.title,
          doc: { id: doc.id, title: doc.title, path: doc.path },
        });
      } else if (parsed.kind === 'web') {
        const wid = parsed.webTabId;
        const tab = wid ? webTabs.find((t) => t.id === wid) : undefined;
        if (!tab) continue;
        out.push({
          id,
          kind: 'web',
          title: tab.title,
          webTab: { id: tab.id, title: tab.title, url: tab.url },
        });
      } else {
        const tid = parsed.terminalTabId;
        const tab = tid ? terminalTabs.find((t) => t.id === tid) : undefined;
        if (!tab) continue;
        out.push({
          id,
          kind: 'terminal',
          title: tab.title,
          terminalTab: { id: tab.id, title: tab.title, workdir: tab.workdir ?? null },
        });
      }
    }
    return out;
  }, [tabOrder, sessionsById, documents, showChatTabs, webTabs, terminalTabs]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const {
    start: startDragGhost,
    moveByClientPoint: moveDragGhostByClientPoint,
    stop: stopDragGhost,
  } = useDragGhostSession({ pollIntervalMs: 32 });

  const [activeDragTabId, setActiveDragTabId] = useState<WorkspaceTabId | null>(null);
  const dragGhostActiveRef = useRef(false);
  const dragGhostBaseTitleRef = useRef<string>('');
  const dragCancelledByEscapeRef = useRef(false);

  useEffect(() => {
    if (!activeDragTabId) return;
    dragCancelledByEscapeRef.current = false;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      dragCancelledByEscapeRef.current = true;
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeDragTabId]);

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);

  const resolveDragGhostTitle = (tabId: WorkspaceTabId): string => {
    const item = items.find((i) => i.id === tabId) ?? null;
    if (item?.title) return item.title;
    const parsed = parseWorkspaceTabId(tabId);
    if (parsed.kind === 'chat') return '会话';
    if (parsed.kind === 'document') return '文档';
    if (parsed.kind === 'web') return '网页';
    return '终端';
  };

  const isCursorOutsideCurrentWindow = async (thresholdPx: number): Promise<boolean> => {
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
  };

  const tearOffTab = async (tabId: WorkspaceTabId) => {
    const parsed = parseWorkspaceTabId(tabId);
    if (parsed.kind === 'chat' && parsed.sessionId) {
      const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
      if (dockTarget) {
        try {
          await useSessionStore
            .getState()
            .dockSessionToWindow(parsed.sessionId, dockTarget.targetLabel, dockTarget.placement);
          return;
        } catch (err) {
          console.warn('Failed to dock chat tab via drag-drop, fallback to popout:', err);
        }
      }
    }

    if (parsed.kind === 'document') {
      const docId = parsed.documentId;
      const doc = docId ? documents.find((d) => d.id === docId) : undefined;
      if (doc?.path) {
        const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
        if (dockTarget) {
          try {
            const item = { kind: 'document' as const, title: doc.title, documentPath: doc.path };
            await dockWorkspaceItemToWindow(item, dockTarget.targetLabel, dockTarget.placement);
            useWindowLayoutStore.getState().closeTabInLayout(tabId);
            closeDocument(doc.id);
            return;
          } catch (err) {
            console.warn('Failed to dock document tab via drag-drop, fallback to popout:', err);
          }
        }
      }
    }

    if (parsed.kind === 'web') {
      const wid = parsed.webTabId;
      const tab = wid ? webTabs.find((t) => t.id === wid) : undefined;
      if (tab) {
        const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
        if (dockTarget) {
          try {
            const item = { kind: 'web' as const, title: tab.title, webUrl: tab.url };
            await dockWorkspaceItemToWindow(item, dockTarget.targetLabel, dockTarget.placement);
            useWindowLayoutStore.getState().closeTabInLayout(tabId);
            closeWebTab(tab.id);
            return;
          } catch (err) {
            console.warn('Failed to dock web tab via drag-drop, fallback to popout:', err);
          }
        }
      }
    }

    if (parsed.kind === 'terminal') {
      const tid = parsed.terminalTabId;
      const tab = tid ? terminalTabs.find((t) => t.id === tid) : undefined;
      if (tab) {
        const dockTarget = await findChatDockTargetAtCursor().catch(() => null);
        if (dockTarget) {
          try {
            const item = { kind: 'terminal' as const, title: tab.title, terminalWorkdir: tab.workdir ?? undefined };
            await dockWorkspaceItemToWindow(item, dockTarget.targetLabel, dockTarget.placement);
            useWindowLayoutStore.getState().closeTabInLayout(tabId);
            await closeTerminalTab(tab.id);
            return;
          } catch (err) {
            console.warn('Failed to dock terminal tab via drag-drop, fallback to popout:', err);
          }
        }
      }
    }

    await popoutTab(tabId);
  };

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    position: { x: number; y: number };
    targetId: WorkspaceTabId;
  } | null>(null);

  const closeContextMenu = () => setContextMenu(null);

  const popoutTab = async (tabId: WorkspaceTabId) => {
    const parsed = parseWorkspaceTabId(tabId);
    if (parsed.kind === 'chat') {
      const session = parsed.sessionId ? sessionsById.get(parsed.sessionId) : undefined;
      if (!session) return;
      if (onPopoutSession) {
        await onPopoutSession(session.id);
        useWindowLayoutStore.getState().closeTabInLayout(tabId);
      } else {
        const conversationId = session.conversationId ?? undefined;
        openViewWindow(
          'chat',
          session.title,
          conversationId
            ? { conversationId, runMode: session.runMode, agentName: session.agentName }
            : undefined
        );
        useWindowLayoutStore.getState().closeTabInLayout(tabId);
        await onTabClose(session.id);
      }
      return;
    }

    if (parsed.kind === 'document') {
      const docId = parsed.documentId;
      const doc = docId ? documents.find((d) => d.id === docId) : undefined;
      if (!doc) return;
      if (!doc.path) return;
      try {
        const item = { kind: 'document' as const, title: doc.title, documentPath: doc.path };
        const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const win = openViewWindow('chat', doc.title, { label, noDefaultSession: true });
        await dockWorkspaceItemToWindow(item, win, 'tab');
        useWindowLayoutStore.getState().closeTabInLayout(tabId);
        closeDocument(doc.id);
      } catch (err) {
        console.error('Failed to popout document tab:', err);
        alert('当前环境不支持打开新窗口');
      }
      return;
    }

    if (parsed.kind === 'web') {
      const wid = parsed.webTabId;
      const tab = wid ? webTabs.find((t) => t.id === wid) : undefined;
      if (!tab) return;
      try {
        const item = { kind: 'web' as const, title: tab.title, webUrl: tab.url };
        const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const win = openViewWindow('chat', tab.title || '网页', { label, noDefaultSession: true });
        await dockWorkspaceItemToWindow(item, win, 'tab');
        useWindowLayoutStore.getState().closeTabInLayout(tabId);
        closeWebTab(tab.id);
      } catch (err) {
        console.error('Failed to popout web tab:', err);
        alert('当前环境不支持打开新窗口');
      }
      return;
    }

    if (parsed.kind === 'terminal') {
      const tid = parsed.terminalTabId;
      const tab = tid ? terminalTabs.find((t) => t.id === tid) : undefined;
      if (!tab) return;
      try {
        const item = { kind: 'terminal' as const, title: tab.title, terminalWorkdir: tab.workdir ?? undefined };
        const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const win = openViewWindow('chat', tab.title || '终端', { label, noDefaultSession: true });
        await dockWorkspaceItemToWindow(item, win, 'tab');
        useWindowLayoutStore.getState().closeTabInLayout(tabId);
        await closeTerminalTab(tab.id);
      } catch (err) {
        console.error('Failed to popout terminal tab:', err);
        alert('当前环境不支持打开新窗口');
      }
    }
  };

  const closeTab = async (tabId: WorkspaceTabId) => {
    useWindowLayoutStore.getState().closeTabInLayout(tabId);
    const parsed = parseWorkspaceTabId(tabId);
    if (parsed.kind === 'chat') {
      const sid = parsed.sessionId;
      if (!sid) return;
      await onTabClose(sid);
      return;
    }
    if (parsed.kind === 'document') {
      const did = parsed.documentId;
      if (!did) return;
      closeDocument(did);
      return;
    }
    if (parsed.kind === 'web') {
      const wid = parsed.webTabId;
      if (!wid) return;
      closeWebTab(wid);
      return;
    }
    const tid = parsed.terminalTabId;
    if (!tid) return;
    await closeTerminalTab(tid);
  };

  const closeOtherTabs = async (keepId: WorkspaceTabId) => {
    for (const t of tabOrder) {
      if (t === keepId) continue;
      // eslint-disable-next-line no-await-in-loop
      await closeTab(t);
    }
  };

  const closeTabsToLeft = async (targetId: WorkspaceTabId) => {
    const idx = tabOrder.indexOf(targetId);
    if (idx <= 0) return;
    for (const t of tabOrder.slice(0, idx)) {
      // eslint-disable-next-line no-await-in-loop
      await closeTab(t);
    }
  };

  const closeTabsToRight = async (targetId: WorkspaceTabId) => {
    const idx = tabOrder.indexOf(targetId);
    if (idx < 0 || idx >= tabOrder.length - 1) return;
    for (const t of tabOrder.slice(idx + 1)) {
      // eslint-disable-next-line no-await-in-loop
      await closeTab(t);
    }
  };

  const handleDragStart = (e: DragStartEvent) => {
    const activeId = String(e.active.id) as WorkspaceTabId;
    setActiveDragTabId(activeId);

    dragGhostActiveRef.current = false;
    dragGhostBaseTitleRef.current = resolveDragGhostTitle(activeId);

    const ev = e.activatorEvent as MouseEvent | PointerEvent | null;
    if (ev && 'clientX' in ev) {
      dragStartRef.current = { x: ev.clientX, y: ev.clientY };
      lastDragPointRef.current = { x: ev.clientX, y: ev.clientY };
    } else {
      dragStartRef.current = null;
      lastDragPointRef.current = null;
    }
  };

  const handleDragMove = (e: DragMoveEvent) => {
    const start = dragStartRef.current;
    if (!start) return;
    const point = {
      x: start.x + e.delta.x,
      y: start.y + e.delta.y,
    };
    lastDragPointRef.current = point;

    const rect = tabBarRef.current?.getBoundingClientRect() ?? null;
    const outsideTabBar =
      !rect ||
      point.x < rect.left - GHOST_ACTIVATE_THRESHOLD_PX ||
      point.x > rect.right + GHOST_ACTIVATE_THRESHOLD_PX ||
      point.y < rect.top - GHOST_ACTIVATE_THRESHOLD_PX ||
      point.y > rect.bottom + GHOST_ACTIVATE_THRESHOLD_PX;

    if (outsideTabBar) {
      if (!dragGhostActiveRef.current) {
        dragGhostActiveRef.current = true;
        const base = dragGhostBaseTitleRef.current || 'Tab';
        const escapeAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const tabEl = tabBarRef.current
          ? ((activeDragTabId
              ? tabBarRef.current.querySelector(`[data-workspace-tab-id="${escapeAttr(activeDragTabId)}"]`)
              : null) as HTMLElement | null)
          : null;
        const tabRect = tabEl ? tabEl.getBoundingClientRect() : null;
        startDragGhost(base, tabRect ? { anchorRect: tabRect, clientPoint: point } : { clientPoint: point });
      }
      moveDragGhostByClientPoint(point);
    } else if (dragGhostActiveRef.current) {
      dragGhostActiveRef.current = false;
      stopDragGhost();
    }
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    const activeId = e.active.id as WorkspaceTabId;
    const overId = e.over?.id as WorkspaceTabId | undefined;

    const rect = tabBarRef.current?.getBoundingClientRect();
    const p = lastDragPointRef.current;
    const shouldTearOffByClientPoint =
      Boolean(rect && p) &&
      Boolean(
        rect &&
          p &&
          (p.x < rect.left - TEAR_OFF_THRESHOLD_PX ||
            p.x > rect.right + TEAR_OFF_THRESHOLD_PX ||
            p.y < rect.top - TEAR_OFF_THRESHOLD_PX ||
            p.y > rect.bottom + TEAR_OFF_THRESHOLD_PX)
      );

    // VS Code 风格兜底：拖拽离开窗口后可能无法持续收到 pointer move 更新，
    // 这时 `client point` 会停在窗内，导致无法触发 tear-off。
    const outsideWindow = shouldTearOffByClientPoint
      ? false
      : await isCursorOutsideCurrentWindow(TEAR_OFF_WINDOW_THRESHOLD_PX);
    const shouldTearOff = shouldTearOffByClientPoint || outsideWindow;

    dragStartRef.current = null;
    lastDragPointRef.current = null;
    setActiveDragTabId(null);
    dragGhostActiveRef.current = false;
    dragGhostBaseTitleRef.current = '';
    stopDragGhost();

    if (shouldTearOff) {
      await tearOffTab(activeId);
      return;
    }

    if (overId && activeId !== overId) {
      reorderTabs(activeId, overId);
    }
  };

  const handleDragCancel = async (e: DragCancelEvent) => {
    const activeId = e.active.id as WorkspaceTabId;
    const start = dragStartRef.current;
    const point = lastDragPointRef.current;

    dragStartRef.current = null;
    lastDragPointRef.current = null;
    setActiveDragTabId(null);
    dragGhostActiveRef.current = false;
    dragGhostBaseTitleRef.current = '';
    stopDragGhost();

    // Esc 取消：不触发“拖出窗口”逻辑
    if (dragCancelledByEscapeRef.current) return;

    const movedDist = start && point ? Math.hypot(point.x - start.x, point.y - start.y) : 0;
    const lostFocus = typeof document !== 'undefined' ? !document.hasFocus() : false;
    const outsideWindow = await isCursorOutsideCurrentWindow(TEAR_OFF_WINDOW_THRESHOLD_PX);

    // 参考 VS Code：拖拽到窗口外导致 cancel 时，仍然视作“tear-off”。
    // 同时加一个移动距离门槛，避免偶发 cancel 误触。
    if (outsideWindow || (lostFocus && movedDist >= 24)) {
      await tearOffTab(activeId);
    }
  };

  const handleNewSessionClick = () => {
    if (agents.length === 0) {
      setShowAgentSelector(true);
      return;
    }
    if (agents.length === 1) {
      onNewSession(agents[0].name);
      return;
    }
    setShowAgentSelector((v) => !v);
  };

  useEffect(() => {
    if (!showViewMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!viewMenuRef.current) return;
      if (viewMenuRef.current.contains(e.target as Node)) return;
      setShowViewMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showViewMenu]);

  const isTabActive = (item: TabRenderItem) => {
    if (activeView !== 'chat') return false;
    return activeWorkspaceTabId === item.id;
  };

  const activateWorkspaceTab = (tabId: WorkspaceTabId) => {
    const layout = useWindowLayoutStore.getState();
    const existing = (layout.panes ?? []).find((p) => p.tabIds.includes(tabId)) ?? null;
    if (existing) {
      layout.setFocusedPane(existing.id);
      layout.setActiveTabInPane(existing.id, tabId);
      return;
    }
    layout.openTabInFocusedPane(tabId);
  };

  const handleSelectTab = (item: TabRenderItem) => {
    setActiveView('chat');
    activateWorkspaceTab(item.id);

    if (item.kind === 'chat' && item.session) {
      onTabClick(item.session.id);
      return;
    }
    if (item.kind === 'document' && item.doc) {
      setActiveDocument(item.doc.id);
      return;
    }
    if (item.kind === 'web' && item.webTab) {
      setActiveWebTab(item.webTab.id);
      return;
    }
    if (item.kind === 'terminal' && item.terminalTab) {
      setActiveTerminalTab(item.terminalTab.id);
    }
  };

  return (
    <div
      ref={tabBarRef}
      data-tauri-drag-region
      className="relative flex items-center bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700"
    >
      {showChatTabs ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={items.map((i) => i.id)} strategy={horizontalListSortingStrategy}>
            <div
              className="flex-1 flex items-center overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
              style={{ scrollbarWidth: 'thin' }}
            >
              {items.map((item) => (
                <SortableWorkspaceTab
                  key={item.id}
                  item={item}
                  isActive={isTabActive(item)}
                  onSelect={() => handleSelectTab(item)}
                  onClose={(e) => {
                    e.stopPropagation();
                    void closeTab(item.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      visible: true,
                      position: { x: e.clientX, y: e.clientY },
                      targetId: item.id,
                    });
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="flex-1" />
      )}

      {/* New session button */}
      <div className="relative flex-shrink-0 px-2 flex items-center gap-2">
        {/* View menu (replaces left sidebar) */}
        <div className="relative" ref={viewMenuRef}>
          <button
            type="button"
            onClick={() => setShowViewMenu((v) => !v)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            title="视图"
          >
            <Menu size={16} />
          </button>

          {showViewMenu && (
            <div className="absolute right-0 top-[calc(100%+6px)] w-40 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 z-[120] overflow-hidden">
              {[
                { id: 'chat' as const, label: '聊天', icon: <MessageSquare size={14} /> },
                { id: 'history' as const, label: '历史', icon: <History size={14} /> },
                { id: 'settings' as const, label: '设置', icon: <Settings size={14} /> },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveView(item.id);
                    setShowViewMenu(false);
                  }}
                  className={[
                    'flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                    activeView === item.id
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700',
                  ].join(' ')}
                >
                  <span className="text-gray-500 dark:text-gray-300">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          ref={newSessionButtonRef}
          onClick={handleNewSessionClick}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          title="新建会话"
        >
          <Plus size={16} />
          {agents.length > 1 && (
            <ChevronDown
              size={12}
              className={`transition-transform ${showAgentSelector ? 'rotate-180' : ''}`}
            />
          )}
        </button>

        {showAgentSelector && (
          <AgentSelector
            agents={agents}
            onSelect={(agentName) => onNewSession(agentName)}
            onClose={() => setShowAgentSelector(false)}
            buttonRef={newSessionButtonRef}
          />
        )}
      </div>

      {showChatTabs && contextMenu && (
        <WorkspaceTabContextMenu
          visible={contextMenu.visible}
          position={contextMenu.position}
          tabOrder={tabOrder}
          targetId={contextMenu.targetId}
          canOpenInNewWindow={(() => {
            const parsed = parseWorkspaceTabId(contextMenu.targetId);
            if (parsed.kind === 'chat') return true;
            const did = parsed.documentId;
            const doc = did ? documents.find((d) => d.id === did) : undefined;
            return Boolean(doc?.path);
          })()}
          onClose={closeContextMenu}
          onOpenInNewWindow={() => void popoutTab(contextMenu.targetId)}
          onCloseCurrent={() => void closeTab(contextMenu.targetId)}
          onCloseOthers={() => void closeOtherTabs(contextMenu.targetId)}
          onCloseToLeft={() => void closeTabsToLeft(contextMenu.targetId)}
          onCloseToRight={() => void closeTabsToRight(contextMenu.targetId)}
        />
      )}
    </div>
  );
};

export default WorkspaceTabBar;
