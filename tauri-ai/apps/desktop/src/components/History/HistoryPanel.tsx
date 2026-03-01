/**
 * HistoryPanel Component
 * Displays conversation history list with selection, multi-select and batch deletion
 * Requirements: 7.3, 7.4, 8.1, 8.2, 8.3, 8.4
 */

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Edit2,
  FileText,
  Folder,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { useConversationStore } from '../../stores/conversationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { useUIStore } from '../../stores/uiStore';
import type { Conversation, Workstudio } from '../../types';
import {
  ensureConversationFileIndexes,
  type BindPreference,
  type ConversationFileIndexUpdate,
} from '../../services/conversationService';
import { markChatOpenProfile, setChatOpenProfileTarget, startChatOpenProfile } from '../../utils/chatOpenProfile';
import { collectOpenConversationIdsFromPresence, subscribeWindowPresenceChanges } from '../../utils/windowPresence';

const isTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
};

const basenameForDisplay = (p: string): string => {
  const normalized = p.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
};

/**
 * Format date for display
 * - Today: HH:mm
 * - Yesterday: 昨天 HH:mm
 * - Day before yesterday: 前天 HH:mm
 * - Within this year: MM-DD HH:mm
 * - Over a year: YYYY-MM-DD HH:mm
 */
const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  // Within 12 hours
  if (diff >= 0 && diff < 12 * 60 * 60 * 1000) {
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours}小时前`;
    return `${hours}小时${mins}分钟前`;
  }

  // Get time string in HH:mm format
  const timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Get start of today, yesterday, day before yesterday
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const dayBeforeYesterdayStart = new Date(todayStart.getTime() - 2 * 24 * 60 * 60 * 1000);

  if (date >= todayStart) {
    // Today but > 12 hours ago (unlikely given 12h check, but distinct logic)
    return timeStr;
  } else if (date >= yesterdayStart) {
    // Yesterday
    return `昨天 ${timeStr}`;
  } else if (date >= dayBeforeYesterdayStart) {
    // Day before yesterday
    return `前天 ${timeStr}`;
  } else if (date.getFullYear() === now.getFullYear()) {
    // Same year: MM-DD HH:mm
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${timeStr}`;
  } else {
    // Different year: YYYY-MM-DD HH:mm
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day} ${timeStr}`;
  }
};

const getNativeModifierState = (e: React.MouseEvent, key: 'Shift' | 'Control' | 'Meta') => {
  const native = e.nativeEvent as unknown as MouseEvent;
  if (native && typeof native.getModifierState === 'function') {
    return native.getModifierState(key);
  }
  return false;
};

type HistoryViewMode = 'timeline' | 'workspace';

const HISTORY_VIEW_MODE_KEY = 'tauri-ai:history:view_mode';
const HISTORY_BIND_PREF_KEY = 'tauri-ai:history:bind_preference';

const readLocalStorageString = (key: string, fallback: string): string => {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
};

const writeLocalStorageString = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

const parseDateMs = (raw?: string | null): number => {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
};

type WorkspaceTree = {
  id: string;
  rootPath: string;
  displayName: string;
  conversationsAtRoot: Conversation[];
  folders: Map<string, FolderTreeNode>;
  files: Map<string, FileTreeNode>;
  totalCount: number;
  latestUpdatedAtMs: number;
};

type FolderTreeNode = {
  relPath: string;
  name: string;
  conversations: Conversation[];
  folders: Map<string, FolderTreeNode>;
  files: Map<string, FileTreeNode>;
  totalCount: number;
  latestUpdatedAtMs: number;
};

type FileTreeNode = {
  relPath: string;
  name: string;
  conversations: Conversation[];
  latestUpdatedAtMs: number;
};

const splitRelPath = (relPath: string): string[] => {
  const s = (relPath ?? '').trim().replace(/\\/g, '/');
  return s.split('/').filter(Boolean);
};

const buildWorkspaceTrees = (
  conversations: Conversation[],
  workstudioMainFolderById: Record<string, string>,
  workstudioMainFolderHasRealContentById: Record<string, boolean>,
  searchQuery: string
): WorkspaceTree[] => {
  const q = searchQuery.trim().toLowerCase();
  const rankScore = (latestUpdatedAtMs: number, count: number): number => {
    // Prefer recency but give "many conversations" a moderate boost so frequently-used folders rank higher.
    // Cap the boost to avoid old, huge folders dominating forever.
    const safeLatest = Number.isFinite(latestUpdatedAtMs) ? latestUpdatedAtMs : 0;
    const c = Math.max(0, Math.floor(count));
    const boostDays = Math.min(8, Math.log2(c + 1)); // 0..8 days
    return safeLatest + boostDays * 24 * 60 * 60 * 1000;
  };

  const matchesQuery = (c: Conversation): boolean => {
    if (!q) return true;
    const title = (c.title ?? '').toLowerCase();
    const agent = (c.agentName ?? '').toLowerCase();
    const model = (c.modelRef ?? '').toLowerCase();
    const path = (c.primaryPath ?? '').toLowerCase();
    const ws = (c.workstudioId ? workstudioMainFolderById[c.workstudioId] ?? c.workstudioId : '').toLowerCase();
    const active = (c.activeFiles ?? []).some((p) => (p.path ?? '').toLowerCase().includes(q));
    return (
      title.includes(q) ||
      agent.includes(q) ||
      model.includes(q) ||
      path.includes(q) ||
      ws.includes(q) ||
      active
    );
  };

  const byRoot = new Map<string, WorkspaceTree>();

  const upsertWorkspace = (rootPath: string): WorkspaceTree => {
    const key = rootPath.trim() || '未关联工作区';
    const existing = byRoot.get(key);
    if (existing) return existing;

    const displayName = (() => {
      if (key === '未关联工作区') return key;
      return basenameForDisplay(key);
    })();

    const ws: WorkspaceTree = {
      id: key,
      rootPath: key,
      displayName,
      conversationsAtRoot: [],
      folders: new Map(),
      files: new Map(),
      totalCount: 0,
      latestUpdatedAtMs: 0,
    };
    byRoot.set(key, ws);
    return ws;
  };

  const getOrCreateFolder = (ws: WorkspaceTree, relPath: string): FolderTreeNode => {
    const parts = splitRelPath(relPath);
    let curMap = ws.folders;
    let curPath = '';
    let node: FolderTreeNode | null = null;

    for (const part of parts) {
      curPath = curPath ? `${curPath}/${part}` : part;
      let next = curMap.get(part);
      if (!next) {
        next = {
          relPath: curPath,
          name: part,
          conversations: [],
          folders: new Map(),
          files: new Map(),
          totalCount: 0,
          latestUpdatedAtMs: 0,
        };
        curMap.set(part, next);
      }
      node = next;
      curMap = next.folders;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return node!;
  };

  const getOrCreateFile = (ws: WorkspaceTree, relPath: string): FileTreeNode => {
    const parts = splitRelPath(relPath);
    const name = parts[parts.length - 1] || relPath;
    if (parts.length <= 1) {
      let f = ws.files.get(name);
      if (!f) {
        f = { relPath: relPath.replace(/\\/g, '/'), name, conversations: [], latestUpdatedAtMs: 0 };
        ws.files.set(name, f);
      }
      return f;
    }

    const folderPath = parts.slice(0, -1).join('/');
    const folder = getOrCreateFolder(ws, folderPath);
    let f = folder.files.get(name);
    if (!f) {
      f = { relPath: relPath.replace(/\\/g, '/'), name, conversations: [], latestUpdatedAtMs: 0 };
      folder.files.set(name, f);
    }
    return f;
  };

  const attachConversation = (ws: WorkspaceTree, c: Conversation) => {
    const kind = (c.primaryPathKind ?? '').toString();
    const rel = (c.primaryPath ?? '').trim();

    if (!rel || kind === 'workspace') {
      ws.conversationsAtRoot.push(c);
      return;
    }

    if (kind === 'file') {
      const fileNode = getOrCreateFile(ws, rel);
      fileNode.conversations.push(c);
      return;
    }

    // folder (default)
    const folderNode = getOrCreateFolder(ws, rel);
    folderNode.conversations.push(c);
  };

  for (const c of conversations) {
    if (!matchesQuery(c)) continue;
    const wsId = (c.workstudioId ?? '').trim();
    if (wsId) {
      if (workstudioMainFolderHasRealContentById[wsId] === false) {
        // 主文件夹只有 `.tauriai` 配置、没有其他内容：不在“文件夹视图”展示
        continue;
      }
    }
    const rootPath = wsId ? (workstudioMainFolderById[wsId] ?? wsId) : '未关联工作区';
    const ws = upsertWorkspace(rootPath);
    attachConversation(ws, c);
  }

  const computeCounts = (ws: WorkspaceTree) => {
    const toMs = (s: string | undefined): number => {
      if (!s) return 0;
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? ms : 0;
    };

    const convUsageMs = (c: Conversation): number => toMs(c.lastMessageAt ?? c.updatedAt);

    const computeFile = (f: FileTreeNode): { count: number; latestMs: number } => {
      let latestMs = 0;
      for (const c of f.conversations) {
        latestMs = Math.max(latestMs, convUsageMs(c));
      }
      f.latestUpdatedAtMs = latestMs;
      return { count: f.conversations.length, latestMs };
    };

    const folderCount = (node: FolderTreeNode): { count: number; latestMs: number } => {
      let count = node.conversations.length;
      let latestMs = 0;

      for (const c of node.conversations) {
        latestMs = Math.max(latestMs, convUsageMs(c));
      }

      for (const child of node.folders.values()) {
        const r = folderCount(child);
        count += r.count;
        latestMs = Math.max(latestMs, r.latestMs);
      }
      for (const f of node.files.values()) {
        const r = computeFile(f);
        count += r.count;
        latestMs = Math.max(latestMs, r.latestMs);
      }
      node.totalCount = count;
      node.latestUpdatedAtMs = latestMs;
      return { count, latestMs };
    };

    let total = ws.conversationsAtRoot.length;
    let latestMs = 0;
    for (const c of ws.conversationsAtRoot) {
      latestMs = Math.max(latestMs, convUsageMs(c));
    }
    for (const folder of ws.folders.values()) {
      const r = folderCount(folder);
      total += r.count;
      latestMs = Math.max(latestMs, r.latestMs);
    }
    for (const f of ws.files.values()) {
      const r = computeFile(f);
      total += r.count;
      latestMs = Math.max(latestMs, r.latestMs);
    }
    ws.totalCount = total;
    ws.latestUpdatedAtMs = latestMs;
  };

  const roots = Array.from(byRoot.values());
  for (const ws of roots) computeCounts(ws);

  roots.sort((a, b) => {
    if (a.rootPath === '未关联工作区') return 1;
    if (b.rootPath === '未关联工作区') return -1;
    const scoreA = rankScore(a.latestUpdatedAtMs, a.totalCount);
    const scoreB = rankScore(b.latestUpdatedAtMs, b.totalCount);
    return scoreB - scoreA || b.latestUpdatedAtMs - a.latestUpdatedAtMs || b.totalCount - a.totalCount || a.displayName.localeCompare(b.displayName, 'zh-CN');
  });

  return roots;
};

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  isOpen: boolean;
  isSelected: boolean;
  workstudioMainFolder?: string | null;
  onMouseDown?: (e: React.MouseEvent) => void;
  onSelect: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
}

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation,
  isActive,
  isOpen,
  isSelected,
  workstudioMainFolder,
  onMouseDown,
  onSelect,
  onDelete,
  onRename,
}) => {
  const { config } = useConfigStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title);
  const [showActions, setShowActions] = useState(false);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(conversation.title);
    setIsEditing(true);
  };

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editTitle.trim() && editTitle !== conversation.title) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(conversation.title);
    setIsEditing(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (editTitle.trim() && editTitle !== conversation.title) {
        onRename(editTitle.trim());
      }
      setIsEditing(false);
    } else if (e.key === 'Escape') {
      setEditTitle(conversation.title);
      setIsEditing(false);
    }
  };

  return (
    <div
      className={`
        group relative flex items-center gap-3 px-3 py-3 rounded-lg cursor-pointer
        transition-colors duration-150
        ${isSelected
          ? 'bg-blue-100 dark:bg-blue-900/50 border border-blue-300 dark:border-blue-700'
          : isActive
            ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent'
        }
      `}
      onMouseDown={onMouseDown}
      onClick={onSelect}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Checkbox for multi-select */}
      <div className={`
        flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center
        transition-colors
        ${isSelected
          ? 'bg-blue-500 border-blue-500 text-white'
          : 'border-gray-300 dark:border-gray-600'
        }
      `}>
        {isSelected && <Check size={12} />}
      </div>

      {/* Icon */}
      <div className={`
        flex-shrink-0 p-2 rounded-lg
        ${isActive
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-800 dark:text-blue-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
        }
      `}>
        <MessageSquare size={16} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
        ) : (
          <>
             <h3 className={`
               text-sm font-medium truncate
               ${isActive
                 ? 'text-blue-700 dark:text-blue-300'
                 : 'text-gray-800 dark:text-gray-200'
               }
             `}>
               {conversation.title}
             </h3>
             <div className="flex items-center gap-2 mt-0.5 flex-wrap">
               <span className="text-xs text-gray-500 dark:text-gray-400">
                 {formatDate(conversation.updatedAt)}
               </span>
               {typeof conversation.messageCount === 'number' && (
                 <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                   消息 {conversation.messageCount}
                 </span>
               )}
               {typeof conversation.turnCount === 'number' && (
                 <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                   Turn {conversation.turnCount}
                 </span>
               )}
                {isOpen && (
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded font-medium ${
                      isActive
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'
                    }`}
                  >
                    {isActive ? '当前' : '已打开'}
                  </span>
                )}
                {conversation.workstudioId && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 truncate max-w-[220px]"
                    title={
                      workstudioMainFolder?.trim()
                        ? `工作区：${workstudioMainFolder}`
                        : `工作区：${conversation.workstudioId}`
                    }
                  >
                    <Folder size={12} className="shrink-0" />
                    <span className="truncate">
                      {workstudioMainFolder?.trim() ? `工作区 ${basenameForDisplay(workstudioMainFolder)}` : '工作区'}
                    </span>
                  </span>
                )}
                {conversation.agentName && (
                  <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
                    {config?.agents?.find(a => a.name === conversation.agentName)?.displayName || conversation.agentName}
                  </span>
                )}
              {conversation.modelRef && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400 truncate max-w-[120px]" title={conversation.modelRef}>
                  {conversation.modelRef.split('/').pop()}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      {isEditing ? (
        <div className="flex items-center gap-1">
          <button
            onClick={handleSaveEdit}
            className="p-1.5 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30"
            title="保存"
          >
            <Check size={14} />
          </button>
          <button
            onClick={handleCancelEdit}
            className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
            title="取消"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        showActions && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleStartEdit}
              className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300"
              title="重命名"
            >
              <Edit2 size={14} />
            </button>
            <button
              onClick={handleDelete}
              className="p-1.5 rounded text-gray-500 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      )}
    </div>
  );
};

interface ConversationRowProps {
  conversation: Conversation;
  isActive: boolean;
  isOpen: boolean;
  depth?: number;
  workstudioMainFolder?: string | null;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
}

const ConversationRow: React.FC<ConversationRowProps> = ({
  conversation,
  isActive,
  isOpen,
  depth = 0,
  workstudioMainFolder,
  onOpen,
  onDelete,
  onRename,
}) => {
  const { config } = useConfigStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title);
  const [showActions, setShowActions] = useState(false);

  useEffect(() => {
    if (!isEditing) setEditTitle(conversation.title);
  }, [conversation.title, isEditing]);

  const commitRename = () => {
    const next = editTitle.trim();
    if (next && next !== conversation.title) {
      onRename(next);
    }
    setIsEditing(false);
  };

  return (
    <div
      className={[
        'group flex items-center gap-2 rounded-md border border-transparent px-2 py-2',
        'hover:bg-gray-50 dark:hover:bg-gray-800/60',
        isActive ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800' : '',
      ].join(' ')}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onClick={() => {
        if (isEditing) return;
        onOpen();
      }}
    >
      <MessageSquare size={16} className={isActive ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400'} />

      <div className="min-w-0 flex-1">
        {isEditing ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditTitle(conversation.title);
                setIsEditing(false);
              }
            }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded border border-blue-300 bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:border-blue-700"
            autoFocus
          />
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
              {conversation.title}
            </span>
            {isOpen && (
              <span
                className={`inline-flex items-center px-1.5 py-0.5 text-[11px] rounded font-medium ${
                  isActive
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'
                }`}
              >
                {isActive ? '当前' : '已打开'}
              </span>
            )}
          </div>
        )}

        {!isEditing && (
          <div className="mt-0.5 flex items-center gap-2 flex-wrap text-xs text-gray-500 dark:text-gray-400">
            <span>{formatDate(conversation.updatedAt)}</span>
            {typeof conversation.messageCount === 'number' && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                消息 {conversation.messageCount}
              </span>
            )}
            {typeof conversation.turnCount === 'number' && conversation.turnCount > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                Turn {conversation.turnCount}
              </span>
            )}
            {workstudioMainFolder && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 truncate max-w-[260px]"
                title={`工作区：${workstudioMainFolder}`}
              >
                <Folder size={12} className="shrink-0" />
                <span className="truncate">工作区 {basenameForDisplay(workstudioMainFolder)}</span>
              </span>
            )}
            {conversation.agentName && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
                {config?.agents?.find((a) => a.name === conversation.agentName)?.displayName || conversation.agentName}
              </span>
            )}
            {conversation.modelRef && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400 truncate max-w-[140px]"
                title={conversation.modelRef}
              >
                {conversation.modelRef.split('/').pop()}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {isEditing ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              commitRename();
            }}
            className="p-1.5 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30"
            title="保存"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditTitle(conversation.title);
              setIsEditing(false);
            }}
            className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
            title="取消"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        showActions && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditTitle(conversation.title);
                setIsEditing(true);
              }}
              className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300"
              title="重命名"
            >
              <Edit2 size={14} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="p-1.5 rounded text-gray-500 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      )}
    </div>
  );
};

const WorkspaceTreeBody: React.FC<{
  ws: WorkspaceTree;
  treeExpanded: Set<string>;
  toggleExpanded: (id: string) => void;
  openConversationIds: Set<string>;
  currentConversationId: string | null;
  onOpenConversation: (conversation: Conversation) => void | Promise<void>;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
}> = ({
  ws,
  treeExpanded,
  toggleExpanded,
  openConversationIds,
  currentConversationId,
  onOpenConversation,
  onDeleteConversation,
  onRenameConversation,
}) => {
  const rankScore = (latestUpdatedAtMs: number, count: number): number => {
    const safeLatest = Number.isFinite(latestUpdatedAtMs) ? latestUpdatedAtMs : 0;
    const c = Math.max(0, Math.floor(count));
    const boostDays = Math.min(8, Math.log2(c + 1));
    return safeLatest + boostDays * 24 * 60 * 60 * 1000;
  };

  const sortedFolders = useMemo(
    () =>
      Array.from(ws.folders.values()).sort((a, b) => {
        const scoreA = rankScore(a.latestUpdatedAtMs, a.totalCount);
        const scoreB = rankScore(b.latestUpdatedAtMs, b.totalCount);
        return scoreB - scoreA || b.latestUpdatedAtMs - a.latestUpdatedAtMs || b.totalCount - a.totalCount || a.name.localeCompare(b.name, 'zh-CN');
      }),
    [ws.folders]
  );
  const sortedFiles = useMemo(
    () =>
      Array.from(ws.files.values()).sort((a, b) => {
        const scoreA = rankScore(a.latestUpdatedAtMs, a.conversations.length);
        const scoreB = rankScore(b.latestUpdatedAtMs, b.conversations.length);
        return (
          scoreB - scoreA ||
          b.latestUpdatedAtMs - a.latestUpdatedAtMs ||
          b.conversations.length - a.conversations.length ||
          a.name.localeCompare(b.name, 'zh-CN')
        );
      }),
    [ws.files]
  );

  const renderFileNode = useCallback(
    (file: FileTreeNode, depth: number) => {
      const nodeId = `ws|${ws.rootPath}|f|${file.relPath}`;
      const expanded = treeExpanded.has(nodeId);
      return (
        <div key={nodeId} className="space-y-1">
          <button
            type="button"
            onClick={() => toggleExpanded(nodeId)}
            className={[
              'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left',
              'hover:bg-gray-50 dark:hover:bg-gray-800/60',
              expanded ? 'bg-gray-50 dark:bg-gray-800/40' : '',
            ].join(' ')}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            title={file.relPath}
          >
            {expanded ? (
              <ChevronDown size={16} className="text-gray-400" />
            ) : (
              <ChevronRight size={16} className="text-gray-400" />
            )}
            <FileText size={16} className="text-gray-500 dark:text-gray-300" />
            <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-100">
              {file.name}
            </span>
            <span className="ml-auto inline-flex items-center px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">
              {file.conversations.length}
            </span>
          </button>

          {expanded ? (
            <div className="space-y-1">
              {file.conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  isActive={c.id === currentConversationId}
                  isOpen={openConversationIds.has(c.id)}
                  depth={depth + 1}
                  workstudioMainFolder={null}
                  onOpen={() => void onOpenConversation(c)}
                  onDelete={() => onDeleteConversation(c.id)}
                  onRename={(title) => onRenameConversation(c.id, title)}
                />
              ))}
            </div>
          ) : null}
        </div>
      );
    },
    [
      currentConversationId,
      onDeleteConversation,
      onOpenConversation,
      onRenameConversation,
      openConversationIds,
      toggleExpanded,
      treeExpanded,
      ws.rootPath,
    ]
  );

  const renderFolderNode = useCallback(
    (folder: FolderTreeNode, depth: number) => {
      const nodeId = `ws|${ws.rootPath}|d|${folder.relPath}`;
      const expanded = treeExpanded.has(nodeId);
      const childFolders = Array.from(folder.folders.values()).sort((a, b) => {
        const scoreA = rankScore(a.latestUpdatedAtMs, a.totalCount);
        const scoreB = rankScore(b.latestUpdatedAtMs, b.totalCount);
        return scoreB - scoreA || b.latestUpdatedAtMs - a.latestUpdatedAtMs || b.totalCount - a.totalCount || a.name.localeCompare(b.name, 'zh-CN');
      });
      const childFiles = Array.from(folder.files.values()).sort((a, b) => {
        const scoreA = rankScore(a.latestUpdatedAtMs, a.conversations.length);
        const scoreB = rankScore(b.latestUpdatedAtMs, b.conversations.length);
        return (
          scoreB - scoreA ||
          b.latestUpdatedAtMs - a.latestUpdatedAtMs ||
          b.conversations.length - a.conversations.length ||
          a.name.localeCompare(b.name, 'zh-CN')
        );
      });

      return (
        <div key={nodeId} className="space-y-1">
          <button
            type="button"
            onClick={() => toggleExpanded(nodeId)}
            className={[
              'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left',
              'hover:bg-gray-50 dark:hover:bg-gray-800/60',
              expanded ? 'bg-gray-50 dark:bg-gray-800/40' : '',
            ].join(' ')}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            title={folder.relPath}
          >
            {expanded ? (
              <ChevronDown size={16} className="text-gray-400" />
            ) : (
              <ChevronRight size={16} className="text-gray-400" />
            )}
            <Folder size={16} className="text-indigo-500 dark:text-indigo-300" />
            <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-100">
              {folder.name}
            </span>
            <span className="ml-auto inline-flex items-center px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">
              {folder.totalCount}
            </span>
          </button>

          {expanded ? (
            <div className="space-y-1">
              {folder.conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  isActive={c.id === currentConversationId}
                  isOpen={openConversationIds.has(c.id)}
                  depth={depth + 1}
                  workstudioMainFolder={null}
                  onOpen={() => void onOpenConversation(c)}
                  onDelete={() => onDeleteConversation(c.id)}
                  onRename={(title) => onRenameConversation(c.id, title)}
                />
              ))}
              {childFolders.map((child) => renderFolderNode(child, depth + 1))}
              {childFiles.map((child) => renderFileNode(child, depth + 1))}
            </div>
          ) : null}
        </div>
      );
    },
    [
      currentConversationId,
      onDeleteConversation,
      onOpenConversation,
      onRenameConversation,
      openConversationIds,
      renderFileNode,
      toggleExpanded,
      treeExpanded,
      ws.rootPath,
    ]
  );

  return (
    <div className="space-y-1">
      {ws.conversationsAtRoot.map((c) => (
        <ConversationRow
          key={c.id}
          conversation={c}
          isActive={c.id === currentConversationId}
          isOpen={openConversationIds.has(c.id)}
          depth={1}
          workstudioMainFolder={null}
          onOpen={() => void onOpenConversation(c)}
          onDelete={() => onDeleteConversation(c.id)}
          onRename={(title) => onRenameConversation(c.id, title)}
        />
      ))}
      {sortedFolders.map((folder) => renderFolderNode(folder, 1))}
      {sortedFiles.map((file) => renderFileNode(file, 1))}
    </div>
  );
};


export const HistoryPanel: React.FC = () => {
  const {
    conversations,
    currentConversationId,
    deleteConversation,
    updateConversationTitle,
  } = useConversationStore();

  const { openHistoricalConversation, createSession } = useSessionStore();
  const { config } = useConfigStore();
  const { setActiveView } = useUIStore();

  const [viewMode, setViewMode] = useState<HistoryViewMode>(() => {
    const raw = readLocalStorageString(HISTORY_VIEW_MODE_KEY, 'timeline');
    return raw === 'workspace' ? 'workspace' : 'timeline';
  });

  useEffect(() => {
    writeLocalStorageString(HISTORY_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  const [bindPreference, setBindPreference] = useState<BindPreference>(() => {
    const raw = readLocalStorageString(HISTORY_BIND_PREF_KEY, 'file');
    return raw === 'folder' ? 'folder' : 'file';
  });

  useEffect(() => {
    writeLocalStorageString(HISTORY_BIND_PREF_KEY, bindPreference);
  }, [bindPreference]);

  const [searchQuery, setSearchQuery] = useState('');
  useEffect(() => {
    // 避免过滤/切换视图导致“已选择项”与可见列表错位
    setSelectedIds(new Set());
    setLastSelectedIndex(null);
  }, [searchQuery, viewMode]);

  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setTreeExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [indexing, setIndexing] = useState<{
    running: boolean;
    done: number;
    total: number;
    error: string | null;
  }>({ running: false, done: 0, total: 0, error: null });

  const indexRunIdRef = useRef(0);

  const applyFileIndexUpdates = useCallback((updates: ConversationFileIndexUpdate[]) => {
    if (!updates.length) return;
    const byId = new Map<string, ConversationFileIndexUpdate>();
    for (const u of updates) byId.set(u.conversationId, u);

    useConversationStore.setState((state) => ({
      conversations: state.conversations.map((c) => {
        const u = byId.get(c.id);
        if (!u) return c;
        return {
          ...c,
          primaryPath: u.primaryPath ?? undefined,
          primaryPathKind: u.primaryPathKind ?? undefined,
          primaryPathPref: u.primaryPathPref ?? undefined,
          activeFiles: u.activeFiles ?? undefined,
          activeFilesUpdatedAt: u.activeFilesUpdatedAt ?? undefined,
        };
      }),
    }));
  }, []);

  const runEnsureFileIndexes = useCallback(
    async (conversationIds: string[], opts?: { force?: boolean; maxMessages?: number }) => {
      if (!isTauriRuntime()) {
        setIndexing({ running: false, done: 0, total: 0, error: '当前环境不支持刷新索引（需要 Tauri 运行时）' });
        return;
      }

      const ids = Array.from(new Set(conversationIds.map((v) => v.trim()).filter(Boolean)));
      if (ids.length === 0) {
        setIndexing({ running: false, done: 0, total: 0, error: null });
        return;
      }

      indexRunIdRef.current += 1;
      const runId = indexRunIdRef.current;
      const batchSize = 20;

      setIndexing({ running: true, done: 0, total: ids.length, error: null });

      try {
        for (let i = 0; i < ids.length; i += batchSize) {
          if (indexRunIdRef.current !== runId) return;

          const batch = ids.slice(i, i + batchSize);
          const updates = await ensureConversationFileIndexes(batch, {
            preference: bindPreference,
            maxMessages: opts?.maxMessages ?? 200,
            force: opts?.force ?? false,
          });

          if (indexRunIdRef.current !== runId) return;
          applyFileIndexUpdates(updates);

          const done = Math.min(ids.length, i + batch.length);
          setIndexing((prev) => ({ ...prev, done }));
        }

        if (indexRunIdRef.current !== runId) return;
        setIndexing({ running: false, done: ids.length, total: ids.length, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (indexRunIdRef.current !== runId) return;
        setIndexing((prev) => ({ ...prev, running: false, error: message }));
      }
    },
    [applyFileIndexUpdates, bindPreference]
  );

  const autoIndexIds = useMemo(() => {
    if (viewMode !== 'workspace') return [];

    return conversations
      .filter((c) => {
        const wsId = (c.workstudioId ?? '').trim();
        if (!wsId) return false;

        if (!c.activeFilesUpdatedAt) return true;

        const kind = (c.primaryPathKind ?? '').toString();
        if (!kind) return true;
        if ((kind === 'file' || kind === 'folder') && !(c.primaryPath ?? '').trim()) return true;

        if ((c.primaryPathPref ?? '').toString() !== bindPreference) return true;

        const lastMs = parseDateMs(c.lastMessageAt);
        const indexMs = parseDateMs(c.activeFilesUpdatedAt);
        if (lastMs && indexMs && lastMs > indexMs) return true;

        return false;
      })
      .map((c) => c.id);
  }, [bindPreference, conversations, viewMode]);

  useEffect(() => {
    if (viewMode !== 'workspace') return;
    if (!isTauriRuntime()) return;
    if (indexing.running) return;

    if (autoIndexIds.length === 0) {
      setIndexing((prev) => {
        if (prev.running) return prev;
        if (prev.done === 0 && prev.total === 0 && prev.error === null) return prev;
        return { running: false, done: 0, total: 0, error: null };
      });
      return;
    }

    void runEnsureFileIndexes(autoIndexIds, { force: false });
  }, [autoIndexIds, indexing.running, runEnsureFileIndexes, viewMode]);

  useEffect(() => {
    if (viewMode === 'workspace') return;
    // 切走 workspace 视图时，取消后续批处理回写（避免在时间线视图里刷屏）
    indexRunIdRef.current += 1;
    setIndexing((prev) => (prev.running ? { ...prev, running: false } : prev));
  }, [viewMode]);

  // 当前窗口 session 中打开的 conversation（用于列表“已打开”标记）
  const localOpenConversationIds = useSessionStore(
    useShallow((state) => {
      const ids = new Set<string>();
      for (const s of state.sessions.values()) {
        if (s.conversationId) ids.add(s.conversationId);
      }
      return Array.from(ids).sort();
    })
  );

  // 其他窗口打开的 conversation（来自 localStorage presence 广播）
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => {
    const unsub = subscribeWindowPresenceChanges(() => setPresenceTick((v) => v + 1));
    return () => unsub();
  }, []);

  const openConversationIds = useMemo(() => {
    const remote = collectOpenConversationIdsFromPresence();
    for (const cid of localOpenConversationIds) remote.add(cid);
    return remote;
  }, [localOpenConversationIds, presenceTick]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);

  const [workstudioMainFolderById, setWorkstudioMainFolderById] = useState<Record<string, string>>({});
  const [workstudioMainFolderHasRealContentById, setWorkstudioMainFolderHasRealContentById] = useState<
    Record<string, boolean>
  >({});
  const [workstudioMainFolderFetchFailures, setWorkstudioMainFolderFetchFailures] = useState<
    Record<string, { attempts: number; lastErrorAtMs: number }>
  >({});
  const [workstudioMainFolderRetryTick, setWorkstudioMainFolderRetryTick] = useState(0);

  const workstudioIdsKey = useMemo(() => {
    const uniqueIds = new Set<string>();
    for (const c of conversations) {
      const id = (c.workstudioId ?? '').trim();
      if (id) uniqueIds.add(id);
    }
    const ids = Array.from(uniqueIds).sort();
    return ids.join('|');
  }, [conversations]);

  const workstudioIdsSorted = useMemo(() => {
    if (!workstudioIdsKey) return [];
    return workstudioIdsKey.split('|').filter(Boolean);
  }, [workstudioIdsKey]);

  useEffect(() => {
    const now = Date.now();

    const backoffMsForAttempts = (attempts: number): number => {
      // 1s, 2s, 4s ... up to 30s
      const base = 1000 * Math.pow(2, Math.max(0, attempts - 1));
      return Math.min(30_000, Math.max(1000, base));
    };

    const unresolved = workstudioIdsSorted.filter((id) => !(id in workstudioMainFolderById));
    if (unresolved.length === 0) return;

    const missing = unresolved.filter((id) => {
      const failure = workstudioMainFolderFetchFailures[id];
      if (!failure) return true;
      const backoffMs = backoffMsForAttempts(failure.attempts);
      return now - failure.lastErrorAtMs >= backoffMs;
    });

    let cancelled = false;
    let retryTimer: number | null = null;

    const scheduleRetryIfNeeded = (nextFailures: Record<string, { attempts: number; lastErrorAtMs: number }>) => {
      // If we still have unresolved workstudio ids, schedule the next retry at the earliest backoff expiry.
      let nextAtMs: number | null = null;
      for (const id of workstudioIdsSorted) {
        if (id in workstudioMainFolderById) continue;
        const failure = nextFailures[id];
        if (!failure) continue;
        const backoffMs = backoffMsForAttempts(failure.attempts);
        const candidate = failure.lastErrorAtMs + backoffMs;
        nextAtMs = nextAtMs === null ? candidate : Math.min(nextAtMs, candidate);
      }
      if (nextAtMs === null) return;
      const delayMs = Math.max(250, nextAtMs - Date.now());
      retryTimer = window.setTimeout(() => setWorkstudioMainFolderRetryTick((v) => v + 1), delayMs);
    };

    if (missing.length === 0) {
      // All unresolved ids are in backoff cooldown. Schedule the next retry at the earliest expiry.
      scheduleRetryIfNeeded(workstudioMainFolderFetchFailures);
      return () => {
        cancelled = true;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
      };
    }

    const mapLimit = async <T,>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
      const concurrency = Math.max(1, Math.floor(limit));
      let idx = 0;
      const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (idx < items.length) {
          const cur = idx++;
          await fn(items[cur]!);
        }
      });
      await Promise.all(runners);
    };

    (async () => {
      const updates: Record<string, string> = {};
      const failureUpdates: Record<string, { attempts: number; lastErrorAtMs: number }> = {};

      if (!isTauriRuntime()) {
        for (const id of missing) updates[id] = id;
        if (!cancelled) setWorkstudioMainFolderById((prev) => ({ ...prev, ...updates }));
        return;
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await mapLimit(missing, 6, async (id) => {
          try {
            const ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId: id });
            const mainFolder =
              (ws?.mainFolder ?? '').trim() || ((ws?.folders?.[0] ?? '') as string).trim() || '';
            if (mainFolder) {
              updates[id] = mainFolder;
            } else {
              // Workstudio not found or missing folder info: fall back to id (resolved) to avoid endless retries.
              updates[id] = id;
            }
          } catch (error) {
            const prev = workstudioMainFolderFetchFailures[id];
            const attempts = (prev?.attempts ?? 0) + 1;
            failureUpdates[id] = { attempts, lastErrorAtMs: Date.now() };
            console.warn('Failed to resolve workstudio main folder:', id, error);
          }
        });
      } catch {
        // If the runtime import fails, avoid caching UUIDs as the final "main folder".
        // Record failures so we can retry later.
        for (const id of missing) {
          const prev = workstudioMainFolderFetchFailures[id];
          const attempts = (prev?.attempts ?? 0) + 1;
          failureUpdates[id] = { attempts, lastErrorAtMs: Date.now() };
        }
      }

      if (cancelled) return;

      if (Object.keys(updates).length > 0) {
        setWorkstudioMainFolderById((prev) => ({ ...prev, ...updates }));
      }
      if (Object.keys(failureUpdates).length > 0) {
        const nextFailures = { ...workstudioMainFolderFetchFailures, ...failureUpdates };
        setWorkstudioMainFolderFetchFailures(nextFailures);
        scheduleRetryIfNeeded(nextFailures);
      } else {
        // Successful run: clear resolved ids from failure cache to prevent stale backoff scheduling.
        if (Object.keys(workstudioMainFolderFetchFailures).length > 0) {
          let changed = false;
          const next: Record<string, { attempts: number; lastErrorAtMs: number }> = { ...workstudioMainFolderFetchFailures };
          for (const id of missing) {
            if (id in updates && id in next) {
              delete next[id];
              changed = true;
            }
          }
          if (changed) setWorkstudioMainFolderFetchFailures(next);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [workstudioIdsKey, workstudioMainFolderById, workstudioMainFolderFetchFailures, workstudioMainFolderRetryTick]);

  // Hide workstudio roots that only contain `.tauriai/` config (no real project content).
  useEffect(() => {
    if (!workstudioIdsKey) return;

    const idsToCheck = workstudioIdsSorted.filter((id) => {
      if (id in workstudioMainFolderHasRealContentById) return false;
      const mainFolder = (workstudioMainFolderById[id] ?? '').trim();
      if (!mainFolder) return false;
      return true;
    });
    if (idsToCheck.length === 0) return;

    let cancelled = false;

    const mapLimit = async <T,>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
      const concurrency = Math.max(1, Math.floor(limit));
      let idx = 0;
      const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (idx < items.length) {
          const cur = idx++;
          await fn(items[cur]!);
        }
      });
      await Promise.all(runners);
    };

    (async () => {
      const updates: Record<string, boolean> = {};

      if (!isTauriRuntime()) {
        for (const id of idsToCheck) updates[id] = true;
        if (!cancelled) setWorkstudioMainFolderHasRealContentById((prev) => ({ ...prev, ...updates }));
        return;
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await mapLimit(idsToCheck, 6, async (id) => {
          try {
            const has = await invoke<boolean>('workstudio_main_folder_has_real_content', { workstudioId: id });
            updates[id] = Boolean(has);
          } catch (error) {
            // Be conservative: if we can't check (permission / transient), keep it visible.
            updates[id] = true;
            console.warn('Failed to check workstudio main folder content:', id, error);
          }
        });
      } catch (error) {
        // If runtime import fails, keep visible and avoid filtering.
        for (const id of idsToCheck) updates[id] = true;
        console.warn('Failed to import tauri invoke for content check:', error);
      }

      if (!cancelled) setWorkstudioMainFolderHasRealContentById((prev) => ({ ...prev, ...updates }));
    })();

    return () => {
      cancelled = true;
    };
  }, [workstudioIdsKey, workstudioIdsSorted, workstudioMainFolderById, workstudioMainFolderHasRealContentById]);

  const timelineConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const title = (c.title ?? '').toLowerCase();
      const agent = (c.agentName ?? '').toLowerCase();
      const model = (c.modelRef ?? '').toLowerCase();
      const ws = (c.workstudioId ? workstudioMainFolderById[c.workstudioId] ?? c.workstudioId : '').toLowerCase();
      const primary = (c.primaryPath ?? '').toLowerCase();
      const active = (c.activeFiles ?? []).some((p) => (p.path ?? '').toLowerCase().includes(q));
      return title.includes(q) || agent.includes(q) || model.includes(q) || ws.includes(q) || primary.includes(q) || active;
    });
  }, [conversations, searchQuery, workstudioMainFolderById]);

  const workspaceTrees = useMemo(() => {
    return buildWorkspaceTrees(
      timelineConversations,
      workstudioMainFolderById,
      workstudioMainFolderHasRealContentById,
      ''
    );
  }, [timelineConversations, workstudioMainFolderById, workstudioMainFolderHasRealContentById]);

  useEffect(() => {
    if (viewMode !== 'workspace') return;
    setTreeExpanded((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set(prev);

      const rootKeyForConversation = (c: Conversation): string => {
        const wsId = (c.workstudioId ?? '').trim();
        if (!wsId) return '未关联工作区';
        return (workstudioMainFolderById[wsId] ?? wsId).trim() || wsId;
      };

      const expandPathFolders = (rootPath: string, relPath: string) => {
        let cur = '';
        for (const part of splitRelPath(relPath)) {
          cur = cur ? `${cur}/${part}` : part;
          next.add(`ws|${rootPath}|d|${cur}`);
        }
      };

      const current = currentConversationId
        ? conversations.find((c) => c.id === currentConversationId) ?? null
        : null;

      if (current) {
        const rootPath = rootKeyForConversation(current);
        next.add(`ws|${rootPath}`);

        const kind = (current.primaryPathKind ?? '').toString();
        const rel = (current.primaryPath ?? '').trim();
        if (rel) {
          if (kind === 'folder') {
            expandPathFolders(rootPath, rel);
          } else if (kind === 'file') {
            const parts = splitRelPath(rel);
            if (parts.length > 1) {
              expandPathFolders(rootPath, parts.slice(0, -1).join('/'));
            }
            next.add(`ws|${rootPath}|f|${rel.replace(/\\/g, '/')}`);
          }
        }
        return next;
      }

      if (workspaceTrees.length === 1) {
        next.add(`ws|${workspaceTrees[0].rootPath}`);
        return next;
      }

      if (workspaceTrees.length > 0) {
        next.add(`ws|${workspaceTrees[0].rootPath}`);
      }
      return next;
    });
  }, [conversations, currentConversationId, viewMode, workspaceTrees, workstudioMainFolderById]);

  const modifierSnapshotRef = useRef<{ ctrl: boolean; shift: boolean } | null>(null);

  const handleItemMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, textarea, a')) {
      return;
    }
    modifierSnapshotRef.current = {
      ctrl: e.ctrlKey || e.metaKey || getNativeModifierState(e, 'Control') || getNativeModifierState(e, 'Meta'),
      shift: e.shiftKey || getNativeModifierState(e, 'Shift'),
    };
  }, []);

  // Handle item click with Ctrl/Shift multi-select
  const handleItemClick = useCallback(async (e: React.MouseEvent, conversation: Conversation, index: number) => {
    const snapshot = modifierSnapshotRef.current;
    modifierSnapshotRef.current = null;

    const isCtrlPressed = snapshot?.ctrl ?? (e.ctrlKey || e.metaKey || getNativeModifierState(e, 'Control') || getNativeModifierState(e, 'Meta'));
    const isShiftPressed = snapshot?.shift ?? (e.shiftKey || getNativeModifierState(e, 'Shift'));

    if (isCtrlPressed) {
      e.preventDefault();
      // Ctrl+Click: Toggle single item
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(conversation.id)) {
          newSet.delete(conversation.id);
        } else {
          newSet.add(conversation.id);
        }
        return newSet;
      });
      setLastSelectedIndex(index);
    } else if (isShiftPressed) {
      e.preventDefault();
      if (lastSelectedIndex === null) {
        // Shift+Click without anchor: select current item only.
        setSelectedIds(new Set([conversation.id]));
        setLastSelectedIndex(index);
        return;
      }
      // Shift+Click: Range select
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeIds = timelineConversations.slice(start, end + 1).map(c => c.id);
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        rangeIds.forEach(id => newSet.add(id));
        return newSet;
      });
    } else {
      // Normal click: Open historical conversation in a new session
      // Requirements: 8.1, 8.2, 8.3, 8.4
      setSelectedIds(new Set());
      setLastSelectedIndex(index);
      try {
        const profileId = startChatOpenProfile({
          source: 'history_panel:open_conversation',
          conversationId: conversation.id,
          meta: { title: conversation.title, index },
        });
        markChatOpenProfile('history_panel:openHistoricalConversation:start', { profileId: profileId || undefined, conversationId: conversation.id });
        const sessionId = await openHistoricalConversation(conversation.id);
        setChatOpenProfileTarget({ sessionId }, profileId ?? undefined);
        markChatOpenProfile('history_panel:openHistoricalConversation:done', { profileId: profileId || undefined, conversationId: conversation.id, meta: { sessionId } });
        setActiveView('chat');
        markChatOpenProfile('history_panel:setActiveView(chat)', { profileId: profileId || undefined, conversationId: conversation.id });
      } catch (error) {
        console.error('Failed to open historical conversation:', error);
      }
    }
  }, [lastSelectedIndex, openHistoricalConversation, setActiveView, timelineConversations]);

  const handleDeleteConversation = async (id: string) => {
    if (deleteConfirmId === id) {
      await deleteConversation(id);
      setDeleteConfirmId(null);
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    } else {
      setDeleteConfirmId(id);
      setTimeout(() => setDeleteConfirmId(null), 3000);
    }
  };

  const handleBatchDelete = async () => {
    if (!showBatchDeleteConfirm) {
      setShowBatchDeleteConfirm(true);
      setTimeout(() => setShowBatchDeleteConfirm(false), 3000);
      return;
    }

    // Delete all selected
    for (const id of selectedIds) {
      await deleteConversation(id);
    }
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  };

  const handleRenameConversation = async (id: string, newTitle: string) => {
    await updateConversationTitle(id, newTitle);
  };

  const handleNewConversation = async () => {
    try {
      // Use default agent to create new session
      const defaultAgentName = config?.defaultAgent || config?.agents?.[0]?.name || '';
      if (!defaultAgentName) {
        console.error('No agent configured');
        return;
      }
      await createSession(defaultAgentName);
      setActiveView('chat');
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  };

  const handleSelectAll = () => {
    const visibleIds = timelineConversations.map((c) => c.id);
    if (visibleIds.length === 0) {
      setSelectedIds(new Set());
      return;
    }
    const allVisibleSelected = visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleIds));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setActiveView('chat')}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            <ArrowLeft size={16} />
            返回聊天
          </button>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white truncate">
            对话历史
          </h2>
        </div>
        <button
          onClick={handleNewConversation}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
        >
          <Plus size={16} />
          新对话
        </button>
      </div>

      {/* View / Filter Toolbar */}
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
              <button
                type="button"
                onClick={() => setViewMode('timeline')}
                className={[
                  'flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-md transition-colors',
                  viewMode === 'timeline'
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-50'
                    : 'text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700',
                ].join(' ')}
              >
                <MessageSquare size={14} />
                时间线
              </button>
              <button
                type="button"
                onClick={() => setViewMode('workspace')}
                className={[
                  'flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-md transition-colors',
                  viewMode === 'workspace'
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-50'
                    : 'text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700',
                ].join(' ')}
              >
                <Folder size={14} />
                文件夹
              </button>
            </div>

            {indexing.running ? (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                索引中 {indexing.done}/{indexing.total}
              </span>
            ) : null}
          </div>

          <div className="flex flex-1 items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[220px]">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="搜索标题 / 工作区 / 文件路径…"
                className="w-full pl-8 pr-8 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
              />
              {searchQuery.trim() ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
                  title="清除"
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <select
                value={bindPreference}
                onChange={(e) => setBindPreference(e.target.value === 'folder' ? 'folder' : 'file')}
                className="h-9 px-2.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100"
                title="绑定优先级"
              >
                <option value="file">文件优先</option>
                <option value="folder">文件夹优先</option>
              </select>

              <button
                type="button"
                onClick={() => {
                  const ids = useConversationStore.getState().conversations.map((c) => c.id);
                  void runEnsureFileIndexes(ids, { force: false });
                }}
                disabled={!isTauriRuntime() || indexing.running || conversations.length === 0}
                className={[
                  'flex items-center gap-1.5 h-9 px-3 text-sm font-medium rounded-lg transition-colors',
                  !isTauriRuntime() || conversations.length === 0
                    ? 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600 cursor-not-allowed'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
                ].join(' ')}
                title={!isTauriRuntime() ? '当前环境不支持刷新索引（需要 Tauri）' : '刷新对话文件索引'}
              >
                <RefreshCw size={14} className={indexing.running ? 'animate-spin' : ''} />
                刷新索引
              </button>
            </div>
          </div>
        </div>

        {indexing.error ? (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
            {indexing.error}
          </div>
        ) : null}
      </div>

      {viewMode === 'timeline' ? (
        <>
          {/* Multi-select toolbar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between px-4 py-2 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-3">
                <span className="text-sm text-blue-700 dark:text-blue-300">
                  已选择 {selectedIds.size} 项
                </span>
                <button
                  onClick={handleSelectAll}
                  className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
                >
                  {selectedIds.size === timelineConversations.length ? '取消全选' : '全选'}
                </button>
                <button
                  onClick={handleClearSelection}
                  className="text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  清除选择
                </button>
              </div>
              <button
                onClick={handleBatchDelete}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${showBatchDeleteConfirm
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
                  }`}
              >
                <Trash2 size={14} />
                {showBatchDeleteConfirm ? '确认删除' : '批量删除'}
              </button>
            </div>
          )}

          {/* Help text */}
          {timelineConversations.length > 0 && selectedIds.size === 0 && (
            <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
              提示：Ctrl+点击多选，Shift+点击范围选择
            </div>
          )}

          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {timelineConversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <div className="p-4 rounded-full bg-gray-100 dark:bg-gray-800 mb-4">
                  <MessageSquare size={32} className="text-gray-400" />
                </div>
                <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                  暂无对话记录
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  开始一个新对话来与 AI 交流
                </p>
                <button
                  onClick={handleNewConversation}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                >
                  <Plus size={16} />
                  开始新对话
                </button>
              </div>
            ) : (
              timelineConversations.map((conversation, index) => (
                <ConversationItem
                  key={conversation.id}
                  conversation={conversation}
                  isActive={conversation.id === currentConversationId}
                  isOpen={openConversationIds.has(conversation.id)}
                  isSelected={selectedIds.has(conversation.id)}
                  workstudioMainFolder={
                    conversation.workstudioId ? workstudioMainFolderById[conversation.workstudioId] ?? null : null
                  }
                  onMouseDown={handleItemMouseDown}
                  onSelect={(e) => handleItemClick(e, conversation, index)}
                  onDelete={() => handleDeleteConversation(conversation.id)}
                  onRename={(newTitle) => handleRenameConversation(conversation.id, newTitle)}
                />
              ))
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {timelineConversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="p-4 rounded-full bg-gray-100 dark:bg-gray-800 mb-4">
                <Folder size={32} className="text-gray-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                暂无对话记录
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                开始一个新对话来与 AI 交流
              </p>
              <button
                onClick={handleNewConversation}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              >
                <Plus size={16} />
                开始新对话
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {workspaceTrees.map((ws) => {
                const wsNodeId = `ws|${ws.rootPath}`;
                const wsExpanded = treeExpanded.has(wsNodeId);
                return (
                  <div key={wsNodeId} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(wsNodeId)}
                      className={[
                        'w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left',
                        'hover:bg-gray-50 dark:hover:bg-gray-800/60',
                        wsExpanded ? 'bg-gray-50 dark:bg-gray-800/40' : '',
                      ].join(' ')}
                      title={ws.rootPath}
                    >
                      {wsExpanded ? (
                        <ChevronDown size={16} className="text-gray-400" />
                      ) : (
                        <ChevronRight size={16} className="text-gray-400" />
                      )}
                      <Folder size={16} className="text-indigo-600 dark:text-indigo-300" />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
                        {ws.displayName}
                      </span>
                      {ws.rootPath !== ws.displayName ? (
                        <span className="hidden md:inline min-w-0 truncate text-xs text-gray-500 dark:text-gray-400 max-w-[380px]">
                          {ws.rootPath}
                        </span>
                      ) : null}
                      <span className="ml-auto inline-flex items-center px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                        {ws.totalCount}
                      </span>
                    </button>

                    {wsExpanded ? (
                      <WorkspaceTreeBody
                        ws={ws}
                        treeExpanded={treeExpanded}
                        toggleExpanded={toggleExpanded}
                        openConversationIds={openConversationIds}
                        currentConversationId={currentConversationId}
                        onOpenConversation={async (c) => {
                          try {
                            await openHistoricalConversation(c.id);
                            setActiveView('chat');
                          } catch (err) {
                            console.error('Failed to open historical conversation:', err);
                          }
                        }}
                        onDeleteConversation={(id) => void handleDeleteConversation(id)}
                        onRenameConversation={(id, title) => void handleRenameConversation(id, title)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Delete Confirmation Toast */}
      {deleteConfirmId && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 px-4 py-2 bg-red-600 text-white text-sm rounded-lg shadow-lg">
          再次点击删除按钮确认删除
        </div>
      )}
    </div>
  );
};

export default HistoryPanel;
