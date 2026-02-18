import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, FileText, Globe, Loader2, TerminalSquare, X } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { AgentSession } from '../../types';
import { useConversationStore } from '../../stores/conversationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { parseWorkspaceTabId, type WorkspaceTabId } from '../../stores/workspaceTabStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useWebTabStore } from '../../stores/webTabStore';
import { useTerminalTabStore } from '../../stores/terminalTabStore';
import { WindowPaneTabContextMenu } from './WindowPaneTabContextMenu';
import {
  dockWorkspaceItemToWindow,
  listChatWindows,
  openOrFocusConversationChatWindow,
  openViewWindow,
  type ChatDockPlacement,
  type ChatWindowInfo,
} from '../../utils/viewWindow';

interface WindowPaneHeaderProps {
  paneId: string;
  tabIds: WorkspaceTabId[];
  activeTabId: WorkspaceTabId | null;
  /** 当指针离开 tab strip 时，固定被拖拽 tab 的位置（由 ghost window 跟随鼠标）。 */
  pinnedTabId?: WorkspaceTabId | null;
  sessionsById: Map<string, AgentSession>;
  isFocused: boolean;
  canClosePane: boolean;
  registerTabStripRef?: (paneId: string) => (el: HTMLDivElement | null) => void;
  onSelectTab: (tabId: WorkspaceTabId) => void;
  onCloseTab: (tabId: WorkspaceTabId) => void | Promise<void>;
  onClosePane: () => void;
}

type TabViewModel =
  | {
      id: WorkspaceTabId;
      kind: 'chat';
      title: string;
      session: AgentSession;
    }
  | {
      id: WorkspaceTabId;
      kind: 'document';
      title: string;
      documentId: string;
      path?: string;
    }
  | {
      id: WorkspaceTabId;
      kind: 'web';
      title: string;
      webTabId: string;
      url: string;
    }
  | {
      id: WorkspaceTabId;
      kind: 'terminal';
      title: string;
      terminalTabId: string;
      workdir?: string | null;
    };

type SortableTabProps = {
  tab: TabViewModel;
  isActive: boolean;
  pinnedWhileDragging?: boolean;
  onSelect: (tabId: WorkspaceTabId) => void;
  onContextMenu: (tabId: WorkspaceTabId, event: React.MouseEvent<HTMLDivElement>) => void;
};

const SortableTabBase: React.FC<SortableTabProps> = ({
  tab,
  isActive,
  pinnedWhileDragging,
  onSelect,
  onContextMenu,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(tab.title);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isRenaming) return;
    setDraftTitle(tab.title);
  }, [isRenaming, tab.title]);

  useEffect(() => {
    if (!isRenaming) return;
    const id = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [isRenaming]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    disabled: isRenaming,
  });

  const effectiveTransform = pinnedWhileDragging && isDragging ? null : transform;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(effectiveTransform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const icon = (() => {
    if (tab.kind === 'chat') {
      return tab.session.isGenerating ? (
        <Loader2 size={14} className="animate-spin text-blue-500" />
      ) : (
        <Bot size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />
      );
    }
    if (tab.kind === 'document') return <FileText size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />;
    if (tab.kind === 'web') return <Globe size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />;
    return <TerminalSquare size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />;
  })();

  const commitRename = useCallback(async () => {
    const next = draftTitle.trim();
    setIsRenaming(false);

    if (tab.kind !== 'chat') return;
    if (!next) return;
    if (next === tab.title) return;

    const conversationId = tab.session.conversationId;
    if (!conversationId) {
      useSessionStore.getState().setSessionTitle(tab.session.id, next);
      return;
    }

    const store = useConversationStore.getState();
    store.clearError();
    await store.updateConversationTitle(conversationId, next);
    const err = useConversationStore.getState().error;
    if (err) {
      alert(`重命名失败：${err}`);
    }
  }, [draftTitle, tab]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-workspace-tab-id={tab.id}
      onClick={() => onSelect(tab.id)}
      onContextMenu={(event) => onContextMenu(tab.id, event)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(tab.id);
        }
      }}
      className={[
        'group relative flex items-center gap-2 px-3 py-2 min-w-[140px] max-w-[320px] select-none',
        'border-b-2 transition-colors cursor-pointer',
        isActive
          ? 'border-blue-500 text-gray-900 dark:text-gray-50 bg-white dark:bg-gray-900'
          : 'border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
      ].join(' ')}
      title={tab.title}
      {...attributes}
      {...listeners}
    >
      <span className="flex-shrink-0">{icon}</span>

      {isRenaming && tab.kind === 'chat' ? (
        <input
          ref={renameInputRef}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraftTitle(tab.title);
              setIsRenaming(false);
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={[
            'flex-1 min-w-0 pr-2 text-sm font-medium',
            'rounded border border-blue-300 bg-white/80 px-1 py-0.5',
            'outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900/80 dark:border-blue-700',
          ].join(' ')}
        />
      ) : (
        <span
          className={[
            'flex-1 min-w-0 truncate text-sm font-medium',
            'pr-2',
          ].join(' ')}
          onDoubleClick={(e) => {
            if (tab.kind !== 'chat') return;
            e.preventDefault();
            e.stopPropagation();
            setDraftTitle(tab.title);
            setIsRenaming(true);
          }}
        >
          {tab.title}
        </span>
      )}

      {tab.kind === 'chat' && tab.session.apiType === 'responses' ? (
        <span className="flex-shrink-0 text-[10px] text-gray-400">R</span>
      ) : null}
    </div>
  );
};

const SortableTab = React.memo(
  SortableTabBase,
  (prev, next) =>
    prev.tab === next.tab &&
    prev.isActive === next.isActive &&
    prev.pinnedWhileDragging === next.pinnedWhileDragging &&
    prev.onSelect === next.onSelect &&
    prev.onContextMenu === next.onContextMenu
);
SortableTab.displayName = 'SortableTab';

export const WindowPaneHeader: React.FC<WindowPaneHeaderProps> = ({
  paneId,
  tabIds,
  activeTabId,
  pinnedTabId,
  sessionsById,
  isFocused,
  canClosePane,
  registerTabStripRef,
  onSelectTab,
  onCloseTab,
  onClosePane,
}) => {
  const documents = useDocumentStore((s) => s.documents);
  const webTabs = useWebTabStore((s) => s.tabs);
  const terminalTabs = useTerminalTabStore((s) => s.tabs);

  const conversations = useConversationStore((state) => state.conversations);
  const conversationTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) map.set(c.id, c.title);
    return map;
  }, [conversations]);

  const items = useMemo((): TabViewModel[] => {
    const out: TabViewModel[] = [];
    for (const id of tabIds) {
      const parsed = parseWorkspaceTabId(id);
      if (parsed.kind === 'chat') {
        const sid = parsed.sessionId;
        const session = sid ? sessionsById.get(sid) : undefined;
        if (!session) continue;
        out.push({ id, kind: 'chat', title: session.title, session });
        continue;
      }
      if (parsed.kind === 'document') {
        const did = parsed.documentId;
        const doc = did ? documents.find((d) => d.id === did) : undefined;
        if (!doc) continue;
        out.push({ id, kind: 'document', title: doc.title, documentId: doc.id, path: doc.path });
        continue;
      }
      if (parsed.kind === 'web') {
        const wid = parsed.webTabId;
        const tab = wid ? webTabs.find((t) => t.id === wid) : undefined;
        if (!tab) continue;
        out.push({ id, kind: 'web', title: tab.title, webTabId: tab.id, url: tab.url });
        continue;
      }
      const tid = parsed.terminalTabId;
      const tab = tid ? terminalTabs.find((t) => t.id === tid) : undefined;
      if (!tab) continue;
      out.push({ id, kind: 'terminal', title: tab.title, terminalTabId: tab.id, workdir: tab.workdir ?? null });
    }
    return out;
  }, [documents, sessionsById, tabIds, terminalTabs, webTabs]);

  type DockMenuState = { sessionId: string; x: number; y: number };

  const [dockMenu, setDockMenu] = useState<DockMenuState | null>(null);
  const [dockTargets, setDockTargets] = useState<ChatWindowInfo[]>([]);
  const [dockLoading, setDockLoading] = useState(false);
  const dockMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dockMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = dockMenuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setDockMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDockMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [dockMenu]);

  const openDockMenu = useCallback(async (session: AgentSession, anchorEl: HTMLElement) => {
    const rect = anchorEl.getBoundingClientRect();
    const menuWidth = 320;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    const top = Math.min(window.innerHeight - 8, rect.bottom + 6);

    setDockMenu((cur) => {
      if (cur?.sessionId === session.id) return null;
      return { sessionId: session.id, x: left, y: top };
    });

    setDockLoading(true);
    try {
      const currentLabel = (() => {
        try {
          return getCurrentWebviewWindow().label;
        } catch {
          return null;
        }
      })();
      const windows = await listChatWindows();
      setDockTargets(currentLabel ? windows.filter((w) => w.label !== currentLabel) : windows);
    } catch (err) {
      console.error('Failed to list chat windows for docking:', err);
      setDockTargets([]);
    } finally {
      setDockLoading(false);
    }
  }, []);

  const handleDock = useCallback(
    async (targetLabel: string, placement: ChatDockPlacement) => {
      const selected = dockMenu?.sessionId;
      if (!selected) return;
      setDockMenu(null);
      try {
        await useSessionStore.getState().dockSessionToWindow(selected, targetLabel, placement);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        alert(`停靠失败：${message}`);
      }
    },
    [dockMenu?.sessionId]
  );

  const { setNodeRef: setTabListRef } = useDroppable({ id: `pane:${paneId}` });
  const tabStripRef = registerTabStripRef ? registerTabStripRef(paneId) : undefined;

  const [tabContextMenu, setTabContextMenu] = useState<{
    visible: boolean;
    position: { x: number; y: number };
    targetId: WorkspaceTabId;
    anchorEl: HTMLElement | null;
  } | null>(null);

  const closeTabContextMenu = () => setTabContextMenu(null);

  const handleSelectTab = useCallback(
    (tabId: WorkspaceTabId) => {
      onSelectTab(tabId);
    },
    [onSelectTab]
  );

  const handleOpenTabContextMenu = useCallback(
    (tabId: WorkspaceTabId, event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setTabContextMenu({
        visible: true,
        position: { x: event.clientX, y: event.clientY },
        targetId: tabId,
        anchorEl: event.currentTarget,
      });
    },
    []
  );

  const tabContextTarget = useMemo(() => {
    if (!tabContextMenu) return null;
    return items.find((t) => t.id === tabContextMenu.targetId) ?? null;
  }, [items, tabContextMenu?.targetId]);

  const canDockContextTarget = Boolean(
    tabContextTarget?.kind === 'chat' &&
      !tabContextTarget.session.isGenerating &&
      Boolean(tabContextTarget.session.conversationId)
  );

  const canOpenContextTargetInNewWindow = (() => {
    if (!tabContextTarget) return false;
    if (tabContextTarget.kind === 'chat') {
      return !tabContextTarget.session.isGenerating && Boolean(tabContextTarget.session.conversationId);
    }
    if (tabContextTarget.kind === 'document') return Boolean(tabContextTarget.path);
    return true;
  })();

  const handleDockContextTarget = useCallback(() => {
    if (!tabContextTarget || tabContextTarget.kind !== 'chat') return;
    const anchor = tabContextMenu?.anchorEl;
    if (!anchor) return;
    void openDockMenu(tabContextTarget.session, anchor);
  }, [openDockMenu, tabContextMenu?.anchorEl, tabContextTarget]);

  const closeTabsInCurrentPane = useCallback(
    async (ids: WorkspaceTabId[]) => {
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve(onCloseTab(id));
      }
    },
    [onCloseTab]
  );

  const popoutTab = useCallback(
    async (tabId: WorkspaceTabId) => {
      const target = items.find((t) => t.id === tabId) ?? null;
      if (!target) return;

      const canPopout = (() => {
        if (target.kind === 'chat') return !target.session.isGenerating && Boolean(target.session.conversationId);
        if (target.kind === 'document') return Boolean(target.path);
        return true;
      })();

      if (!canPopout) {
        if (target.kind === 'document') {
          alert('该文档尚未保存到文件，暂不支持在新窗口打开');
        }
        return;
      }

      if (target.kind === 'chat') {
        if (!target.session.conversationId) return;
        try {
          const { win, isExisting } = await openOrFocusConversationChatWindow(
            target.session.conversationId,
            target.session.title,
            {
              runMode: target.session.runMode,
              agentName: target.session.agentName,
            }
          );
          if (isExisting) {
            await Promise.resolve(onCloseTab(target.id));
            return;
          }
          win.once('tauri://created', () => {
            void win.setFocus().catch(() => {});
            void onCloseTab(target.id);
          });
          win.once('tauri://error', (err) => {
            console.error('Failed to popout chat window:', (err as any)?.payload ?? err);
            alert('打开新窗口失败，请检查窗口权限/配置');
          });
        } catch (err) {
          console.error('Failed to popout chat window:', err);
          alert('当前环境不支持打开新窗口');
        }
        return;
      }

      if (target.kind === 'document') {
        if (!target.path) return;
        try {
          const item = { kind: 'document' as const, title: target.title, documentPath: target.path };
          const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const win = openViewWindow('chat', target.title, { label, noDefaultSession: true });
          await dockWorkspaceItemToWindow(item, win, 'tab');
          await Promise.resolve(onCloseTab(target.id));
        } catch (err) {
          console.error('Failed to popout document tab:', err);
          alert('当前环境不支持打开新窗口');
        }
        return;
      }

      if (target.kind === 'web') {
        try {
          const item = { kind: 'web' as const, title: target.title, webUrl: target.url };
          const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const win = openViewWindow('chat', target.title || '网页', { label, noDefaultSession: true });
          await dockWorkspaceItemToWindow(item, win, 'tab');
          await Promise.resolve(onCloseTab(target.id));
        } catch (err) {
          console.error('Failed to popout web tab:', err);
          alert('当前环境不支持打开新窗口');
        }
        return;
      }

      try {
        const item = { kind: 'terminal' as const, title: target.title, terminalWorkdir: target.workdir ?? undefined };
        const label = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const win = openViewWindow('chat', target.title || '终端', { label, noDefaultSession: true });
        await dockWorkspaceItemToWindow(item, win, 'tab');
        await Promise.resolve(onCloseTab(target.id));
      } catch (err) {
        console.error('Failed to popout terminal tab:', err);
        alert('当前环境不支持打开新窗口');
      }
    },
    [items, onCloseTab]
  );

  return (
    <div
      className={[
        'flex items-center gap-1 border-b border-gray-200 dark:border-gray-800',
        'bg-white/70 dark:bg-gray-900/50 backdrop-blur',
        'relative z-30',
      ].join(' ')}
    >
      <div
        ref={(el) => {
          setTabListRef(el);
          tabStripRef?.(el);
        }}
        className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          {items.map((t) => (
            <SortableTab
              key={t.id}
              tab={t}
              isActive={t.id === activeTabId}
              pinnedWhileDragging={Boolean(pinnedTabId && pinnedTabId === t.id)}
              onSelect={handleSelectTab}
              onContextMenu={handleOpenTabContextMenu}
            />
          ))}
        </SortableContext>
      </div>

      {canClosePane && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClosePane();
          }}
          className={[
            'flex-shrink-0 mx-1 rounded p-1.5',
            'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
            isFocused ? 'opacity-100' : 'opacity-80',
          ].join(' ')}
          title="关闭分屏（合并到相邻 Pane）"
          aria-label="关闭分屏（合并到相邻 Pane）"
        >
          <X size={16} />
        </button>
      )}

      {dockMenu && (
        <div
          ref={dockMenuRef}
          className="fixed z-[1000] w-80 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ left: `${dockMenu.x}px`, top: `${dockMenu.y}px` }}
        >
          <div className="border-b border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
            停靠到…
          </div>
          {dockLoading ? (
            <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">加载窗口列表…</div>
          ) : dockTargets.length === 0 ? (
            <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">当前没有其它聊天窗口</div>
          ) : (
            <div className="max-h-64 overflow-auto">
              {dockTargets.map((w) => {
                const title =
                  w.kind === 'main'
                    ? '主窗口'
                    : w.conversationId
                      ? conversationTitleById.get(w.conversationId) || `聊天窗口：${w.conversationId.slice(0, 8)}`
                      : '聊天窗口';

                return (
                  <div
                    key={w.label}
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-gray-800 dark:text-gray-100">{title}</div>
                      <div className="truncate text-[11px] text-gray-400">{w.label}</div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                        onClick={() => void handleDock(w.label, 'tab')}
                        title="作为标签页停靠"
                      >
                        标签
                      </button>
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                        onClick={() => void handleDock(w.label, 'split-left')}
                        title="分屏到左侧"
                      >
                        左
                      </button>
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                        onClick={() => void handleDock(w.label, 'split-right')}
                        title="分屏到右侧"
                      >
                        右
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tabContextMenu && (
        <WindowPaneTabContextMenu
          visible={tabContextMenu.visible}
          position={tabContextMenu.position}
          tabIds={tabIds}
          targetId={tabContextMenu.targetId}
          canDockToOtherWindow={canDockContextTarget}
          onDockToOtherWindow={tabContextTarget?.kind === 'chat' ? handleDockContextTarget : undefined}
          canOpenInNewWindow={canOpenContextTargetInNewWindow}
          onOpenInNewWindow={() => void popoutTab(tabContextMenu.targetId)}
          onCloseCurrent={() => void onCloseTab(tabContextMenu.targetId)}
          onCloseOthers={() => {
            const keep = tabContextMenu.targetId;
            void closeTabsInCurrentPane(tabIds.filter((id) => id !== keep));
          }}
          onCloseToLeft={() => {
            const idx = tabIds.indexOf(tabContextMenu.targetId);
            if (idx <= 0) return;
            void closeTabsInCurrentPane(tabIds.slice(0, idx));
          }}
          onCloseToRight={() => {
            const idx = tabIds.indexOf(tabContextMenu.targetId);
            if (idx < 0 || idx >= tabIds.length - 1) return;
            void closeTabsInCurrentPane(tabIds.slice(idx + 1));
          }}
          onClose={closeTabContextMenu}
        />
      )}
    </div>
  );
};

export default WindowPaneHeader;
