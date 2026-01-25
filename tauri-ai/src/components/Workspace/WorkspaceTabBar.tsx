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
import { Bot, ChevronDown, FileText, Loader2, Menu, MessageSquare, History, Settings, Plus, X } from 'lucide-react';
import type { Agent, AgentSession } from '../../types';
import { useDocumentStore } from '../../stores/documentStore';
import { useUIStore } from '../../stores/uiStore';
import {
  parseWorkspaceTabId,
  useWorkspaceTabStore,
  type WorkspaceTabId,
} from '../../stores/workspaceTabStore';
import { openViewWindow } from '../../utils/viewWindow';
import { WorkspaceTabContextMenu } from './WorkspaceTabContextMenu';

interface WorkspaceTabBarProps {
  sessions: AgentSession[];
  activeSessionId: string | null;
  agents: Agent[];
  onTabClick: (sessionId: string) => void;
  onTabClose: (sessionId: string) => Promise<void> | void;
  onNewSession: (agentName: string) => void | Promise<void>;
  onPopoutSession?: (sessionId: string) => void | Promise<void>;
}

interface TabRenderItem {
  id: WorkspaceTabId;
  kind: 'chat' | 'document';
  title: string;
  // For chat
  session?: AgentSession;
  // For document
  doc?: {
    id: string;
    title: string;
    path?: string;
  };
}

const TEAR_OFF_THRESHOLD_PX = 48;

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
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = ({ item, isActive, onSelect, onClose, onContextMenu }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const icon = item.kind === 'chat'
    ? (
        <div className="flex-shrink-0">
          {item.session?.isGenerating ? (
            <Loader2 size={14} className="animate-spin text-blue-500" />
          ) : (
            <Bot size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />
          )}
        </div>
      )
    : (
        <FileText size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />
      );

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
      className={[
        'group relative flex items-center gap-2 px-3 py-2 min-w-[120px] max-w-[220px]',
        'cursor-pointer select-none transition-colors duration-150 border-b-2',
        isActive
          ? 'bg-white dark:bg-gray-800 border-blue-500 text-gray-800 dark:text-white'
          : 'bg-gray-50 dark:bg-gray-900 border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200',
      ].join(' ')}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={item.title}
      {...attributes}
      {...listeners}
    >
      {icon}
      <span className="flex-1 text-sm font-medium truncate flex items-center gap-1">
        {item.title}
        {badge}
      </span>

      <button
        onClick={onClose}
        className={[
          'flex-shrink-0 p-0.5 rounded transition-colors',
          isActive
            ? 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            : 'opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300',
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
  activeSessionId,
  agents,
  onTabClick,
  onTabClose,
  onNewSession,
  onPopoutSession,
}) => {
  const tabBarRef = useRef<HTMLDivElement>(null);
  const newSessionButtonRef = useRef<HTMLButtonElement>(null);
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);

  const documents = useDocumentStore((s) => s.documents);
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
  const setActiveDocument = useDocumentStore((s) => s.setActiveDocument);
  const closeDocument = useDocumentStore((s) => s.closeDocument);

  const tabOrder = useWorkspaceTabStore((s) => s.tabOrder);
  const reorderTabs = useWorkspaceTabStore((s) => s.reorderTabs);
  const syncTabs = useWorkspaceTabStore((s) => s.syncTabs);

  const sessionsById = useMemo(() => {
    const map = new Map<string, AgentSession>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  // Keep workspace tab order consistent with current sessions/documents.
  useEffect(() => {
    syncTabs(
      sessions.map((s) => s.id),
      documents.map((d) => d.id)
    );
  }, [sessions, documents, syncTabs]);

  const items = useMemo((): TabRenderItem[] => {
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
      } else {
        const docId = parsed.documentId;
        const doc = docId ? documents.find((d) => d.id === docId) : undefined;
        if (!doc) continue;
        out.push({
          id,
          kind: 'document',
          title: doc.title,
          doc: { id: doc.id, title: doc.title, path: doc.path },
        });
      }
    }
    return out;
  }, [tabOrder, sessionsById, documents]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);

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
      } else {
        const conversationId = session.conversationId ?? undefined;
        openViewWindow('chat', session.title, conversationId ? { conversationId } : undefined);
        await onTabClose(session.id);
      }
      return;
    }

    const docId = parsed.documentId;
    const doc = docId ? documents.find((d) => d.id === docId) : undefined;
    if (!doc) return;
    if (!doc.path) return;
    openViewWindow('document', doc.title, { documentPath: doc.path });
    closeDocument(doc.id);
  };

  const closeTab = async (tabId: WorkspaceTabId) => {
    const parsed = parseWorkspaceTabId(tabId);
    if (parsed.kind === 'chat') {
      const sid = parsed.sessionId;
      if (!sid) return;
      await onTabClose(sid);
      return;
    }
    const did = parsed.documentId;
    if (!did) return;
    closeDocument(did);
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
    if (!dragStartRef.current) return;
    lastDragPointRef.current = {
      x: dragStartRef.current.x + e.delta.x,
      y: dragStartRef.current.y + e.delta.y,
    };
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    const activeId = e.active.id as WorkspaceTabId;
    const overId = e.over?.id as WorkspaceTabId | undefined;

    const rect = tabBarRef.current?.getBoundingClientRect();
    const p = lastDragPointRef.current;
    const shouldTearOff =
      Boolean(rect && p) &&
      Boolean(
        rect &&
          p &&
          (p.x < rect.left - TEAR_OFF_THRESHOLD_PX ||
            p.x > rect.right + TEAR_OFF_THRESHOLD_PX ||
            p.y < rect.top - TEAR_OFF_THRESHOLD_PX ||
            p.y > rect.bottom + TEAR_OFF_THRESHOLD_PX)
      );

    dragStartRef.current = null;
    lastDragPointRef.current = null;

    if (shouldTearOff) {
      await popoutTab(activeId);
      return;
    }

    if (overId && activeId !== overId) {
      reorderTabs(activeId, overId);
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
    if (item.kind === 'chat') {
      return activeView === 'chat' && item.session?.id === activeSessionId;
    }
    return activeView === 'document' && item.doc?.id === activeDocumentId;
  };

  const handleSelectTab = (item: TabRenderItem) => {
    if (item.kind === 'chat' && item.session) {
      onTabClick(item.session.id);
      setActiveView('chat');
      return;
    }
    if (item.kind === 'document' && item.doc) {
      setActiveDocument(item.doc.id);
      setActiveView('document');
    }
  };

  return (
    <div
      ref={tabBarRef}
      data-tauri-drag-region
      className="relative flex items-center bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
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

      {contextMenu && (
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
