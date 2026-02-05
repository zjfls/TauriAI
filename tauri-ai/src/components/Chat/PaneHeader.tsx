import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Dock, ExternalLink, Loader2, X } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { AgentSession } from '../../types';
import { useConversationStore } from '../../stores/conversationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { listChatWindows, openOrFocusConversationChatWindow, type ChatDockPlacement, type ChatWindowInfo } from '../../utils/viewWindow';

interface PaneHeaderProps {
  paneId: string;
  sessionIds: string[];
  activeSessionId: string | null;
  sessionsById: Map<string, AgentSession>;
  isFocused: boolean;
  canClosePane: boolean;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onClosePane: () => void;
}

const SortableTab: React.FC<{
  session: AgentSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onOpenDockMenu: (session: AgentSession, anchorEl: HTMLElement) => void;
}> = ({ session, isActive, onSelect, onClose, onOpenDockMenu }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        'group relative flex items-center gap-2 px-3 py-2 min-w-[140px] max-w-[320px] select-none',
        'border-b-2 transition-colors cursor-pointer',
        isActive
          ? 'border-blue-500 text-gray-900 dark:text-gray-50 bg-white dark:bg-gray-900'
          : 'border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
      ].join(' ')}
      title={session.title}
      {...attributes}
      {...listeners}
    >
      <span className="flex-shrink-0">
        {session.isGenerating ? (
          <Loader2 size={14} className="animate-spin text-blue-500" />
        ) : (
          <Bot size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />
        )}
      </span>

      <span className="flex-1 min-w-0 truncate pr-20 text-sm font-medium">{session.title}</span>

      {session.apiType === 'responses' ? <span className="flex-shrink-0 text-[10px] text-gray-400">R</span> : null}

      <div
        className={[
          'absolute right-2 top-1/2 -translate-y-1/2',
          'flex items-center gap-1 rounded bg-white/80 p-0.5 shadow-sm',
          'dark:bg-gray-900/80',
          'opacity-0 pointer-events-none transition-opacity',
          'group-hover:opacity-100 group-hover:pointer-events-auto',
          'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
        ].join(' ')}
      >
        <button
          type="button"
          className={[
            'rounded p-0.5 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800',
            'disabled:cursor-not-allowed disabled:text-gray-300 dark:disabled:text-gray-600 disabled:hover:bg-transparent',
          ].join(' ')}
          disabled={session.isGenerating || !session.conversationId}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (session.isGenerating) {
              alert('流式生成中，暂不支持停靠');
              return;
            }
            if (!session.conversationId) {
              alert('对话尚未初始化，无法停靠');
              return;
            }
            onOpenDockMenu(session, e.currentTarget as HTMLElement);
          }}
          title="停靠到其他窗口"
        >
          <Dock size={14} />
        </button>
        <button
          type="button"
          className={[
            'rounded p-0.5 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800',
            'disabled:cursor-not-allowed disabled:text-gray-300 dark:disabled:text-gray-600 disabled:hover:bg-transparent',
          ].join(' ')}
          disabled={session.isGenerating || !session.conversationId}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void (async () => {
              if (session.isGenerating) {
                alert('流式生成中，暂不支持脱离到新窗口');
                return;
              }
              if (!session.conversationId) {
                alert('对话尚未初始化，无法脱离到新窗口');
                return;
              }
              try {
                const { win, isExisting } = await openOrFocusConversationChatWindow(session.conversationId, session.title, {
                  runMode: session.runMode,
                  agentName: session.agentName,
                });
                if (isExisting) {
                  onClose();
                  return;
                }
                win.once('tauri://created', () => {
                  void win.setFocus().catch(() => {});
                  onClose();
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
          }}
          title="脱离到新窗口"
        >
          <ExternalLink size={14} />
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="关闭标签"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export const PaneHeader: React.FC<PaneHeaderProps> = ({
  paneId,
  sessionIds,
  activeSessionId,
  sessionsById,
  isFocused,
  canClosePane,
  onSelectSession,
  onCloseSession,
  onClosePane,
}) => {
  const conversations = useConversationStore((state) => state.conversations);
  const conversationTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) {
      map.set(c.id, c.title);
    }
    return map;
  }, [conversations]);

  const items = useMemo(() => {
    return sessionIds
      .map((id) => sessionsById.get(id))
      .filter((s): s is AgentSession => Boolean(s));
  }, [sessionIds, sessionsById]);

  type DockMenuState = {
    sessionId: string;
    x: number;
    y: number;
  };

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
    } finally {
      setDockLoading(false);
    }
  }, []);

  const handleDock = useCallback(async (targetLabel: string, placement: ChatDockPlacement) => {
    const selected = dockMenu?.sessionId;
    if (!selected) return;
    setDockMenu(null);
    try {
      await useSessionStore.getState().dockSessionToWindow(selected, targetLabel, placement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`停靠失败：${message}`);
    }
  }, [dockMenu?.sessionId]);

  const { setNodeRef: setTabListRef } = useDroppable({
    id: `pane:${paneId}`,
  });

  return (
    <div
      className={[
        'flex items-center gap-1 border-b border-gray-200 dark:border-gray-800',
        'bg-white/70 dark:bg-gray-900/50 backdrop-blur',
        'relative z-30',
      ].join(' ')}
    >
      <div
        ref={setTabListRef}
        className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
      >
        <SortableContext items={sessionIds} strategy={horizontalListSortingStrategy}>
          {items.map((s) => (
            <SortableTab
              key={s.id}
              session={s}
              isActive={s.id === activeSessionId}
              onSelect={() => onSelectSession(s.id)}
              onClose={() => onCloseSession(s.id)}
              onOpenDockMenu={openDockMenu}
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
            <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">当前没有其他聊天窗口</div>
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
                        onClick={() => handleDock(w.label, 'tab')}
                        title="作为标签页停靠"
                      >
                        标签
                      </button>
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                        onClick={() => handleDock(w.label, 'split-left')}
                        title="分屏到左侧"
                      >
                        左
                      </button>
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                        onClick={() => handleDock(w.label, 'split-right')}
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
    </div>
  );
};
