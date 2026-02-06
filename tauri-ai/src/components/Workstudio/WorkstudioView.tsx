import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { cursorPosition } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  X,
} from 'lucide-react';
import type { TerminalScope, Workstudio, WorkstudioUiState } from '../../types';
import { SHORTCUT_ACTIONS, detectShortcutPlatform, normalizeKeybindingString } from '../../shortcuts';
import { useConfigStore } from '../../stores/configStore';
import { useTerminalSessionStore } from '../../stores/terminalSessionStore';
import { type WindowPane, useWindowLayoutStore } from '../../stores/windowLayoutStore';
import { useDragGhostSession } from '../../hooks/useDragGhostSession';
import { useRemoteDragSplitPreview } from '../../hooks/useRemoteDragSplitPreview';
import { getViewWindowParams, openViewWindow } from '../../utils/viewWindow';
import { setupMonaco } from '../../utils/monaco';
import { TerminalSurface, type TerminalSurfaceHandle } from '../Terminal/TerminalSurface';

type DirEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

type OpenFile = {
  id: string;
  title: string;
  path: string;
  kind: 'text' | 'image' | 'pdf' | 'binary';
  mime: string;
  size: number;
  content?: string;
  originalContent?: string;
  dirty?: boolean;
  dataUrl?: string; // for image preview
  base64?: string;  // raw bytes (for binary/pdf preview or external open)
};

const TEAR_OFF_THRESHOLD_PX = 48;
const TEAR_OFF_WINDOW_THRESHOLD_PX = 8;
const GHOST_ACTIVATE_THRESHOLD_PX = 2;

const paneDropId = (paneId: string) => `pane:${paneId}`;

const PaneDropZone: React.FC<{ paneId: string; children: React.ReactNode }> = ({ paneId, children }) => {
  const { setNodeRef } = useDroppable({ id: paneDropId(paneId) });
  return (
    <div ref={setNodeRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  );
};

const SortableTab: React.FC<{
  id: string;
  active: boolean;
  title: string;
  onClick: () => void;
  onClose: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}> = ({ id, active, title, onClick, onClose, onContextMenu }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={[
        'group flex items-center gap-2 rounded px-2 py-1 text-xs',
        active
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
      ].join(' ')}
      title={title}
      {...attributes}
      {...listeners}
    >
      <span className="max-w-[180px] truncate">{title}</span>
      <span
        className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        role="button"
        aria-label="close"
      >
        <X size={12} />
      </span>
    </button>
  );
};

const languageForPath = (path: string) => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.tauri.richtxt')) return 'markdown';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.c')) return 'c';
  if (
    lower.endsWith('.cc') ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.cxx') ||
    lower.endsWith('.h') ||
    lower.endsWith('.hh') ||
    lower.endsWith('.hpp') ||
    lower.endsWith('.hxx') ||
    lower.endsWith('.inl') ||
    lower.endsWith('.ipp') ||
    lower.endsWith('.ixx') ||
    lower.endsWith('.cppm')
  )
    return 'cpp';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'shell';
  return 'plaintext';
};

const basename = (p: string) => {
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length === 0 ? p : segments[segments.length - 1];
};

const UNTITLED_PREFIX = 'untitled:';
const isUntitledPath = (p: string) => p.startsWith(UNTITLED_PREFIX);

const nextUntitledRichTxtTitle = (files: OpenFile[]) => {
  const re = /^Untitled-(\d+)\.tauri\.richtxt$/i;
  let max = 0;
  for (const f of files) {
    const m = re.exec(f.title);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `Untitled-${max + 1}.tauri.richtxt`;
};

const utf8Size = (text: string) => new TextEncoder().encode(text).length;

const decodeBase64ToUtf8 = (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
};

const decodeBase64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

const normalizeFsPath = (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  let path = trimmed.replace(/\\/g, '/');

  let isUnc = false;
  let isAbs = false;
  let drive = '';

  if (/^[A-Za-z]:/.test(path)) {
    // Normalize drive letter case so comparisons are stable across sources
    // (e.g. Monaco URI may use lowercase drive while backend paths are uppercase).
    drive = path.slice(0, 2).toUpperCase();
    path = path.slice(2);
    if (path.startsWith('/')) {
      isAbs = true;
      path = path.slice(1);
    }
  } else if (path.startsWith('//')) {
    isUnc = true;
    isAbs = true;
    path = path.slice(2);
  } else if (path.startsWith('/')) {
    isAbs = true;
    path = path.slice(1);
  }

  const parts = path.split('/').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbs) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }

  const body = stack.join('/');
  if (isUnc) return body ? `//${body}` : '//';
  if (drive) return `${drive}${isAbs ? '/' : ''}${body}`.replace(/\/+$/, '');
  return `${isAbs ? '/' : ''}${body}`.replace(/\/+$/, '') || (isAbs ? '/' : '');
};

// Monaco 的 model key（Editor 的 `path` 属性）使用 URI 更可靠：
// - 直接传 Windows 路径（如 `C:/x`）可能会被 Uri.parse 当作 scheme，导致跳转/定位匹配失败
// - 统一转成 file:// URI 后，model.uri.fsPath / toString 都更稳定
const toMonacoModelPath = (fsPath: string) => {
  const normalized = normalizeFsPath(fsPath);
  if (!normalized) return fsPath;
  if (isUntitledPath(normalized)) return normalized;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)) return normalized;

  if (normalized.startsWith('//')) {
    // UNC: //server/share/path -> file://server/share/path
    const rest = normalized.slice(2);
    const [host, ...parts] = rest.split('/').filter(Boolean);
    const encoded = parts.map((p) => encodeURIComponent(p)).join('/');
    if (!host) return `file://${encoded ? `/${encoded}` : ''}`;
    return `file://${host}${encoded ? `/${encoded}` : ''}`;
  }

  if (/^[A-Za-z]:\//.test(normalized)) {
    // Windows drive: C:/path -> file:///C:/path
    const drive = normalized.slice(0, 2); // "C:"
    const rest = normalized.slice(2); // "/path..."
    const encoded = rest
      .split('/')
      .map((seg, idx) => (idx === 0 ? '' : encodeURIComponent(seg)))
      .join('/');
    return `file:///${drive}${encoded}`;
  }

  if (normalized.startsWith('/')) {
    // POSIX: /Users/x -> file:///Users/x
    const encoded = normalized
      .split('/')
      .map((seg, idx) => (idx === 0 ? '' : encodeURIComponent(seg)))
      .join('/');
    return `file://${encoded}`;
  }

  return normalized;
};

const fileKindFor = (path: string, mime: string): OpenFile['kind'] => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.mts') ||
    lower.endsWith('.cts') ||
    lower.endsWith('.json') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.rs') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.lock') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.css') ||
    lower.endsWith('.scss') ||
    lower.endsWith('.sass') ||
    lower.endsWith('.less') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.log') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.bash') ||
    lower.endsWith('.zsh')
  ) {
    return 'text';
  }
  return 'binary';
};

const bytesToHexPreview = (bytes: Uint8Array, max: number) => {
  const len = Math.min(bytes.length, max);
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    parts.push(bytes[i]!.toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
};

const isSubpath = (child: string, parent: string) => {
  const c = normalizeFsPath(child);
  const p = normalizeFsPath(parent);
  if (!c || !p) return false;
  if (c === p) return false;
  return c.startsWith(`${p}/`);
};

export const WorkstudioView: React.FC<{ workstudioId?: string | null }> = ({ workstudioId: workstudioIdProp }) => {
  const { workstudioId: workstudioIdFromUrl, filePath, line, column, endLine, endColumn } = getViewWindowParams();
  const workstudioId = (workstudioIdProp ?? workstudioIdFromUrl ?? '').trim() || null;
  const editorByPaneRef = useRef(
    new Map<string, import('monaco-editor').editor.IStandaloneCodeEditor>()
  );
  const explorerContainerRef = useRef<HTMLDivElement | null>(null);
  const openFilesRef = useRef<OpenFile[]>([]);
  const openingPathsRef = useRef<Set<string>>(new Set());
  const filePaletteInputRef = useRef<HTMLInputElement | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalSurfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const terminalScope: TerminalScope | null = useMemo(() => {
    if (!workstudioId) return null;
    return { kind: 'workstudio', id: workstudioId };
  }, [workstudioId]);
  const terminalSessionId = useTerminalSessionStore((s) => (terminalScope ? s.getSessionId(terminalScope) : null));

  const keyboardShortcuts = useConfigStore((s) => s.config?.general?.keyboardShortcuts);
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const fileSearchShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'workstudio.fileSearch');
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['workstudio.fileSearch']
        : keyboardShortcuts?.windows?.['workstudio.fileSearch'];
    const raw = userRaw ?? (shortcutPlatform === 'mac' ? def?.defaultMac : def?.defaultWindows) ?? (shortcutPlatform === 'mac' ? 'Cmd+P' : 'Ctrl+P');
    return normalizeKeybindingString(String(raw || ''), shortcutPlatform) ?? (shortcutPlatform === 'mac' ? 'Cmd+P' : 'Ctrl+P');
  }, [keyboardShortcuts, shortcutPlatform]);

  const [ws, setWs] = useState<Workstudio | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsLoading, setWsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const shouldShowOpenMainFolderAction = useMemo(() => {
    if (!ws) return false;
    // 仅在“系统默认工作区”（~/.tauri-ai/workstudios/<id>）时显示“打开文件夹为主工作区”入口：
    // - 用户一旦手动设置主目录（主目录不再是系统默认目录），该入口就隐藏，减少干扰。
    const main = normalizeFsPath(ws.mainFolder).toLowerCase();
    const suffix = `/.tauri-ai/workstudios/${ws.id}`.toLowerCase();
    return main.endsWith(suffix);
  }, [ws]);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [entriesByDir, setEntriesByDir] = useState<Record<string, DirEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  useEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);
  const entriesByDirRef = useRef<Record<string, DirEntry[]>>(entriesByDir);
  useEffect(() => {
    entriesByDirRef.current = entriesByDir;
  }, [entriesByDir]);
  const loadingDirsRef = useRef<Record<string, boolean>>(loadingDirs);
  useEffect(() => {
    loadingDirsRef.current = loadingDirs;
  }, [loadingDirs]);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  const [explorerSelectedFilePath, setExplorerSelectedFilePath] = useState<string | null>(null);
  const [uiStateRestored, setUiStateRestored] = useState(false);

  const panes = useWindowLayoutStore((s) => s.panes);
  const focusedPaneId = useWindowLayoutStore((s) => s.focusedPaneId);
  const setFocusedPane = useWindowLayoutStore((s) => s.setFocusedPane);
  const setActiveTabInPane = useWindowLayoutStore((s) => s.setActiveTabInPane);
  const closePaneAndMerge = useWindowLayoutStore((s) => s.closePaneAndMerge);
  const reorderTabInPane = useWindowLayoutStore((s) => s.reorderTabInPane);
  const moveTabToPane = useWindowLayoutStore((s) => s.moveTabToPane);
  const splitTabToNewPane = useWindowLayoutStore((s) => s.splitTabToNewPane);
  const setPaneWeights = useWindowLayoutStore((s) => s.setPaneWeights);
  const closeTabInLayout = useWindowLayoutStore((s) => s.closeTabInLayout);
  const replaceLayout = useWindowLayoutStore((s) => s.replaceLayout);
  const fallbackPaneIdRef = useRef<string>(crypto.randomUUID());

  const [contextMenu, setContextMenu] = useState<
    | { visible: true; x: number; y: number; kind: 'root'; folder: string }
    | { visible: true; x: number; y: number; kind: 'blank' }
    | null
  >(null);
  const [tabMenu, setTabMenu] = useState<
    | { visible: true; x: number; y: number; paneId: string; fileId: string; path: string }
    | null
  >(null);

  const [filePaletteOpen, setFilePaletteOpen] = useState(false);
  const [filePaletteQuery, setFilePaletteQuery] = useState('');
  const [filePaletteResults, setFilePaletteResults] = useState<string[]>([]);
  const [filePaletteIndex, setFilePaletteIndex] = useState(0);

  const saveStateTimerRef = useRef<number | null>(null);
  const paneRowRef = useRef<HTMLDivElement | null>(null);
  const paneRootRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneTabStripRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const resizeRef = useRef<{
    dragging: boolean;
    leftPaneId: string;
    rightPaneId: string;
    startX: number;
    startLeftWidth: number;
    totalWidth: number;
    groupWeight: number;
    prevUserSelect: string;
    prevCursor: string;
  } | null>(null);

  const validFileIds = useMemo(() => new Set(openFiles.map((f) => f.id)), [openFiles]);

  const resolvedPanes = useMemo((): WindowPane[] => {
    const base: WindowPane[] =
      panes.length > 0
        ? panes
        : [
            {
              id: fallbackPaneIdRef.current,
              tabIds: [],
              activeTabId: null,
              weight: 1,
            } satisfies WindowPane,
          ];

    const assigned = new Set<string>();
    const cleaned: WindowPane[] = base.map((p) => {
      const filtered: string[] = [];
      for (const tid of p.tabIds) {
        if (!validFileIds.has(tid)) continue;
        if (assigned.has(tid)) continue;
        assigned.add(tid);
        filtered.push(tid);
      }
      const rawActive = typeof p.activeTabId === 'string' ? p.activeTabId : null;
      const active = rawActive && filtered.includes(rawActive) ? rawActive : filtered[0] ?? null;
      return {
        ...p,
        tabIds: filtered,
        activeTabId: active,
        weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
      };
    });

    const nonEmpty = cleaned.filter((p) => p.tabIds.length > 0);
    if (nonEmpty.length > 0) return nonEmpty;

    if (openFiles.length > 0) {
      const tabs = openFiles.map((f) => f.id);
      return [
        {
          id: fallbackPaneIdRef.current,
          tabIds: tabs,
          activeTabId: tabs[0] ?? null,
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
  }, [openFiles, panes, validFileIds]);

  const resolvedFocusedPaneId = useMemo(() => {
    if (focusedPaneId && resolvedPanes.some((p) => p.id === focusedPaneId)) return focusedPaneId;
    return resolvedPanes[0]?.id ?? null;
  }, [focusedPaneId, resolvedPanes]);

  useEffect(() => {
    if (!uiStateRestored) return;
    if (!resolvedFocusedPaneId) return;
    if (focusedPaneId === resolvedFocusedPaneId) return;
    setFocusedPane(resolvedFocusedPaneId);
  }, [focusedPaneId, resolvedFocusedPaneId, setFocusedPane, uiStateRestored]);

  const resolvedLayoutKey = useMemo(() => {
    return `${resolvedFocusedPaneId ?? ''}|${resolvedPanes
      .map((p) => `${p.id}:${p.activeTabId ?? ''}:${p.tabIds.join(',')}:${p.weight}`)
      .join('|')}`;
  }, [resolvedFocusedPaneId, resolvedPanes]);

  const storedLayoutKey = useMemo(() => {
    return `${focusedPaneId ?? ''}|${panes.map((p) => `${p.id}:${p.activeTabId ?? ''}:${p.tabIds.join(',')}:${p.weight}`).join('|')}`;
  }, [focusedPaneId, panes]);

  useEffect(() => {
    if (!uiStateRestored) return;
    if (!resolvedFocusedPaneId) return;
    if (resolvedLayoutKey === storedLayoutKey) return;
    replaceLayout({ panes: resolvedPanes, focusedPaneId: resolvedFocusedPaneId });
  }, [replaceLayout, resolvedFocusedPaneId, resolvedLayoutKey, resolvedPanes, storedLayoutKey, uiStateRestored]);

  const focusedPane = useMemo(
    () => resolvedPanes.find((p) => p.id === resolvedFocusedPaneId) ?? resolvedPanes[0] ?? null,
    [resolvedFocusedPaneId, resolvedPanes]
  );

  const activeFilePathInFocusedPane = useMemo(() => {
    const activeId = focusedPane?.activeTabId ?? null;
    if (!activeId) return null;
    const raw = openFiles.find((f) => f.id === activeId)?.path ?? null;
    return raw ? normalizeFsPath(raw) : null;
  }, [focusedPane?.activeTabId, openFiles]);

  useEffect(() => {
    setExplorerSelectedFilePath(activeFilePathInFocusedPane);
  }, [activeFilePathInFocusedPane]);

  // Monaco 编辑器在 flex 布局变化（拆分/关闭 Pane/拖拽/分屏比例调整）时偶发不会自动重算尺寸，
  // 导致右侧出现“白色死区”。这里在布局相关状态变化后，强制触发一次 layout。
  useEffect(() => {
    const alivePaneIds = new Set(resolvedPanes.map((p) => p.id));
    for (const key of editorByPaneRef.current.keys()) {
      if (!alivePaneIds.has(key)) {
        editorByPaneRef.current.delete(key);
      }
    }

    let raf2: number | null = null;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        for (const [paneId, editor] of editorByPaneRef.current.entries()) {
          if (!alivePaneIds.has(paneId)) continue;
          try {
            editor.layout();
          } catch {
            // ignore
          }
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [resolvedPanes, terminalOpen]);
  const rootFolders = useMemo(() => {
    if (!ws) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of ws.folders) {
      const nf = normalizeFsPath(f);
      if (!nf || seen.has(nf)) continue;
      seen.add(nf);
      out.push(f);
    }
    const isSystem = (p: string) => normalizeFsPath(p).includes('/.tauri-ai/workstudios/');
    const hasUserRoot = out.some((f) => !isSystem(f));
    const pruned = hasUserRoot ? out.filter((f) => !isSystem(f)) : out;
    // Hide roots nested under the main folder (redundant).
    return pruned.filter((f) => f === ws.mainFolder || !isSubpath(f, ws.mainFolder));
  }, [ws]);
  const rootFoldersRef = useRef<string[]>(rootFolders);
  useEffect(() => {
    rootFoldersRef.current = rootFolders;
  }, [rootFolders]);

  const loadWorkstudio = useCallback(async (id: string) => {
    setWsError(null);
    setWsLoading(true);
    try {
      const result = await invoke<Workstudio | null>('get_workstudio', { workstudioId: id });
      if (!result) {
        setWs(null);
        setWsError('Workstudio 不存在或已损坏');
        return;
      }
      setWs(result);
    } catch (error) {
      setWs(null);
      setWsError(error instanceof Error ? error.message : String(error));
    } finally {
      setWsLoading(false);
    }
  }, []);

  const listDir = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => ({ ...prev, [dirPath]: true }));
    try {
      const entries = await invoke<DirEntry[]>('list_local_directory', { path: dirPath });
      setEntriesByDir((prev) => ({ ...prev, [dirPath]: entries }));
    } catch {
      setEntriesByDir((prev) => ({ ...prev, [dirPath]: [] }));
    } finally {
      setLoadingDirs((prev) => ({ ...prev, [dirPath]: false }));
    }
  }, []);

  const toggleDir = useCallback(
    async (dirPath: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });

      if (!entriesByDir[dirPath]) {
        await listDir(dirPath);
      }
    },
    [entriesByDir, listDir]
  );

  const openFileAtPath = useCallback(
    async (path: string, opts?: { paneId?: string | null }): Promise<string | null> => {
      const normalizedPath = normalizeFsPath(path);
      if (!normalizedPath) return null;
      setExplorerSelectedFilePath(normalizedPath);
      const state = useWindowLayoutStore.getState();
      const requestedPaneId = opts?.paneId ?? state.focusedPaneId;
      const targetPaneId =
        requestedPaneId && state.panes.some((p) => p.id === requestedPaneId)
          ? requestedPaneId
          : (state.panes[0]?.id ?? fallbackPaneIdRef.current);

      if (targetPaneId) {
        state.setFocusedPane(targetPaneId);
      }

      const existing = openFilesRef.current.find((f) => f.id === normalizedPath);
      if (existing) {
        state.openTabInFocusedPane(existing.id);
        return existing.id;
      }

      if (openingPathsRef.current.has(normalizedPath)) {
        // 如果同一路径正在打开中，也要确保它成为当前 Pane 的 active，
        // 否则“跳转到行”逻辑可能因为 activeTabId 还没切换而一直失败。
        state.openTabInFocusedPane(normalizedPath);
        return normalizedPath;
      }
      openingPathsRef.current.add(normalizedPath);
      try {
        const file = await invoke<{ filename: string; mime: string; base64: string; size: number }>(
          'read_local_file_base64',
          { path: normalizedPath }
        );
        const id = normalizedPath;
        const kind = fileKindFor(normalizedPath, file.mime);
        const content = kind === 'text' ? decodeBase64ToUtf8(file.base64) : undefined;
        const next: OpenFile = {
          id,
          title: file.filename,
          path: normalizedPath,
          kind,
          mime: file.mime,
          size: file.size,
          content,
          originalContent: content,
          dirty: false,
          dataUrl: kind === 'image' ? `data:${file.mime};base64,${file.base64}` : undefined,
          base64: file.base64,
        };
        setOpenFiles((prev) => (prev.some((f) => f.id === id) ? prev : [...prev, next]));
        state.openTabInFocusedPane(id);
        return id;
      } finally {
        openingPathsRef.current.delete(normalizedPath);
      }
    },
    []
  );

  type LinkTarget = {
    workstudioId?: string | null;
    mainFolder?: string | null;
    filePath: string;
    line?: number | null;
    column?: number | null;
    endLine?: number | null;
    endColumn?: number | null;
  };

  const openLinkSeqRef = useRef(0);
  const openedFromUrlRef = useRef(false);
  const [openFromLinkError, setOpenFromLinkError] = useState<string | null>(null);
  // 如果在 Workstudio UI state 尚未恢复完成时收到了 open_file 事件，先暂存，待就绪后再执行。
  const pendingOpenLinkRef = useRef<LinkTarget | null>(null);

  // Debug logs for the "click file link -> open in Workstudio" pipeline.
  // Enable with: localStorage.setItem('tauri-ai:debug:open_file','1')
  const dbgEnabled = useMemo(() => {
    try {
      return window.localStorage.getItem('tauri-ai:debug:open_file') === '1';
    } catch {
      return false;
    }
  }, []);

  const dbg = useCallback(
    (msg: string, meta?: Record<string, unknown>) => {
      if (!dbgEnabled) return;
      // eslint-disable-next-line no-console
      console.log(`[open_file][WorkstudioView][${new Date().toISOString()}] ${msg}`, meta ?? {});
    },
    [dbgEnabled]
  );

  const revealFileInExplorer = useCallback(
    async (absFilePath: string, seq: number) => {
      if (!ws) return;
      const normalizedFile = normalizeFsPath(absFilePath);
      if (!normalizedFile) return;

      const rootsRaw = rootFoldersRef.current;
      let bestRoot: { raw: string; norm: string } | null = null;
      for (const raw of rootsRaw) {
        const norm = normalizeFsPath(raw);
        if (!norm) continue;
        if (normalizedFile === norm || normalizedFile.startsWith(`${norm}/`)) {
          if (!bestRoot || norm.length > bestRoot.norm.length) {
            bestRoot = { raw, norm };
          }
        }
      }

      // If the file is not under any declared root, fall back to main folder.
      const rootNorm = bestRoot?.norm ?? normalizeFsPath(ws.mainFolder);
      if (!rootNorm) return;

      const parentDir = (() => {
        const parts = normalizedFile.split('/');
        if (parts.length <= 1) return rootNorm;
        return parts.slice(0, -1).join('/') || rootNorm;
      })();

      const dirsToExpand: string[] = [];
      dirsToExpand.push(rootNorm);

      if (parentDir !== rootNorm && parentDir.startsWith(`${rootNorm}/`)) {
        const rel = parentDir.slice(rootNorm.length).replace(/^\/+/, '');
        if (rel) {
          let cur = rootNorm;
          for (const seg of rel.split('/')) {
            if (!seg) continue;
            cur = `${cur}/${seg}`;
            dirsToExpand.push(cur);
          }
        }
      }

      // Expand dirs in UI state.
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        // Best-effort: include the raw root path too, in case it differs from normalized form.
        if (bestRoot?.raw) next.add(bestRoot.raw);
        next.add(rootNorm);
        for (const d of dirsToExpand) next.add(d);
        return next;
      });

      // Ensure directory entries are loaded so the selected file is visible.
      const dirsToList = (() => {
        const out: string[] = [];
        if (bestRoot?.raw && bestRoot.raw !== rootNorm) out.push(bestRoot.raw);
        out.push(...dirsToExpand);
        return out;
      })();

      for (const d of dirsToList) {
        if (openLinkSeqRef.current !== seq) return;
        const already = entriesByDirRef.current[d];
        if (already) continue;
        if (loadingDirsRef.current[d]) continue;
        try {
          await listDir(d);
        } catch {
          // ignore: best-effort reveal
        }
      }

      // Scroll the file node into view (best-effort).
      const escapeCss = (value: string): string => {
        const cssAny = (globalThis as any).CSS;
        if (cssAny && typeof cssAny.escape === 'function') return cssAny.escape(value);
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      };

      let attempts = 20;
      const tick = () => {
        if (openLinkSeqRef.current !== seq) return;
        const container = explorerContainerRef.current;
        if (!container) return;

        const selector = `[title="${escapeCss(normalizedFile)}"]`;
        const el = container.querySelector(selector) as HTMLElement | null;
        if (el) {
          try {
            el.scrollIntoView({ block: 'nearest' });
          } catch {
            // ignore
          }
          return;
        }

        attempts -= 1;
        if (attempts <= 0) return;
        window.setTimeout(tick, 80);
      };
      window.requestAnimationFrame(() => tick());
    },
    [listDir, ws]
  );

  const openLinkTarget = useCallback(async (target: LinkTarget, opts?: { paneId?: string | null }) => {
    const seq = openLinkSeqRef.current + 1;
    openLinkSeqRef.current = seq;
    const state = useWindowLayoutStore.getState();
    const paneIdFromCaller = opts?.paneId ?? state.focusedPaneId;
    const paneId =
      paneIdFromCaller && state.panes.some((p) => p.id === paneIdFromCaller)
        ? paneIdFromCaller
        : (state.panes[0]?.id ?? fallbackPaneIdRef.current);

    const targetPath = target.filePath;
    if (!targetPath) return;

    dbg('openLinkTarget:begin', {
      seq,
      workstudioId: workstudioId ?? null,
      wsId: ws?.id ?? null,
      uiStateRestored,
      paneId,
      target,
      visibility: typeof document !== 'undefined' ? document.visibilityState : null,
    });

    if (!ws || !uiStateRestored) {
      pendingOpenLinkRef.current = target;
      dbg('openLinkTarget:queued(pendingOpenLinkRef)', { seq, reason: !ws ? 'missing_ws' : 'uiStateNotRestored' });
      return;
    }

    const normalizedTargetPath = normalizeFsPath(targetPath);
    const isAbs =
      /^[A-Za-z]:\//.test(normalizedTargetPath) ||
      normalizedTargetPath.startsWith('/') ||
      normalizedTargetPath.startsWith('//');
    if (!isAbs && !ws?.mainFolder) return;

    const resolved = (() => {
      if (isAbs) return normalizedTargetPath;
      const base = normalizeFsPath(ws?.mainFolder ?? '');
      if (!base) return null;

      let rel = targetPath.replace(/[\\/]+/g, '/');
      rel = rel.replace(/^\.\/+/, '').replace(/^\/+/, '');
      if (rel.startsWith('a/') || rel.startsWith('b/')) rel = rel.slice(2);

      const wsBaseName = basename(base);
      if (wsBaseName && rel.toLowerCase().startsWith(`${wsBaseName.toLowerCase()}/`)) {
        rel = rel.slice(wsBaseName.length + 1);
      }

      return normalizeFsPath(`${base}/${rel}`);
    })();
    if (!resolved) return;

    dbg('openLinkTarget:resolved', { seq, resolved, isAbs, mainFolder: ws?.mainFolder ?? null });

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const applySelection = (openedFileId: string | null, expectedPath: string): boolean => {
      if (openLinkSeqRef.current !== seq) return true;

      const rawLine = typeof target.line === 'number' ? target.line : null;
      if (!rawLine) return true;

      const pane = useWindowLayoutStore.getState().panes.find((p) => p.id === paneId) ?? null;
      if (openedFileId && (!pane || pane.activeTabId !== openedFileId)) return false;

      const editor = editorByPaneRef.current.get(paneId);
      if (!editor) {
        dbg('applySelection:no_editor', { seq, paneId, openedFileId, expectedPath });
        return false;
      }
      const model = editor.getModel();
      if (!model) {
        dbg('applySelection:no_model', { seq, paneId, openedFileId, expectedPath });
        return false;
      }

      try {
        const modelUri: any = (model as any).uri;
        const modelPathRaw: string =
          (typeof modelUri?.fsPath === 'string' && modelUri.fsPath) ||
          (typeof modelUri?.path === 'string' && modelUri.path) ||
          '';
        const modelPath = normalizeFsPath(modelPathRaw);
        const expectedFsPath = normalizeFsPath(expectedPath);
        const expectedModelKey = toMonacoModelPath(expectedFsPath);
        const modelKey = typeof modelUri?.toString === 'function' ? String(modelUri.toString()) : '';
        const matches =
          (expectedFsPath && modelPath && modelPath === expectedFsPath) ||
          (expectedModelKey && modelKey && modelKey === expectedModelKey);
        if (!matches) return false;
      } catch {
        // ignore
      }

      if (openedFileId) {
        const file = openFilesRef.current.find((f) => f.id === openedFileId) ?? null;
        if (!file) return false;
        if (file.kind !== 'text') return true;
      }

      try {
        const lineCount = model.getLineCount();
        if (lineCount <= 0) return false;

        const clampLine = (n: number) => Math.min(Math.max(1, n), lineCount);
        const clampCol = (lineNumber: number, col: number) => {
          const max = model.getLineMaxColumn(lineNumber);
          return Math.min(Math.max(1, col), max);
        };

        const rawEndLine = typeof target.endLine === 'number' ? target.endLine : null;
        const rawEndColumn = typeof target.endColumn === 'number' ? target.endColumn : null;

        const startLineNumber = clampLine(rawLine);
        const startColumn = clampCol(
          startLineNumber,
          typeof target.column === 'number' ? target.column : 1
        );

        // 单点/范围跳转共用同一套 selection + reveal 逻辑，避免两个分支出现行为漂移。
        const endLineNumber =
          rawEndLine === null && rawEndColumn === null ? startLineNumber : clampLine(rawEndLine ?? startLineNumber);
        const endColumn =
          rawEndLine === null && rawEndColumn === null
            ? startColumn
            : clampCol(
                endLineNumber,
                typeof rawEndColumn === 'number' ? rawEndColumn : model.getLineMaxColumn(endLineNumber)
              );

        const sel = (() => {
          if (endLineNumber < startLineNumber) {
            return {
              startLineNumber: endLineNumber,
              startColumn: endColumn,
              endLineNumber: startLineNumber,
              endColumn: startColumn,
            };
          }
          if (endLineNumber === startLineNumber && endColumn < startColumn) {
            return {
              startLineNumber,
              startColumn: endColumn,
              endLineNumber,
              endColumn: startColumn,
            };
          }
          return {
            startLineNumber,
            startColumn,
            endLineNumber,
            endColumn,
          };
        })();

        editor.setSelection(sel);
        editor.revealRangeInCenter(sel);
        editor.focus();
        dbg('applySelection:ok', { seq, paneId, openedFileId, expectedPath, sel });
        return true;
      } catch {
        dbg('applySelection:exception', { seq, paneId, openedFileId, expectedPath });
        return false;
      }
    };

    const applyWithWait = async (openedFileId: string | null, expectedPath: string) => {
      const startAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const timeoutMs = 2600;

      // VS Code-like：在跳转时把目标 Pane 设为聚焦（确保 editor mount / focus 链路稳定）
      if (useWindowLayoutStore.getState().focusedPaneId !== paneId) {
        useWindowLayoutStore.getState().setFocusedPane(paneId);
      }

      while (openLinkSeqRef.current === seq) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - startAt > timeoutMs) {
          dbg('applyWithWait:timeout', {
            seq,
            paneId,
            openedFileId,
            expectedPath,
            timeoutMs,
            visibility: typeof document !== 'undefined' ? document.visibilityState : null,
          });
          return;
        }
        const done = applySelection(openedFileId, expectedPath);
        if (done) return;
        // 等待 React commit + Monaco model ready
        // - 20ms：比 rAF 更宽松，避免主线程忙时错过帧
        // - 也避免 setTimeout(0) 过于频繁造成额外压力
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
      }
    };

    setOpenFromLinkError(null);
    try {
      const openedId = await openFileAtPath(resolved, { paneId });
      dbg('openLinkTarget:file_opened', { seq, openedId, resolved, paneId });
      void revealFileInExplorer(resolved, seq);
      await applyWithWait(openedId, resolved);
      dbg('openLinkTarget:done', { seq, openedId, resolved, paneId });
      return;
    } catch (error) {
      dbg('openLinkTarget:primary_error', { seq, error: String(error), resolved, paneId, isAbs });
      try {
        if (!ws?.id || isAbs) throw error;

        const needle = targetPath.replace(/[\\/]+/g, '/');
        const basenameOnly = needle.split('/').pop() ?? needle;
        const candidates = await invoke<string[]>('workstudio_find_files', {
          args: { workstudioId: ws.id, query: basenameOnly, limit: 50 },
        });

        const pickBest = () => {
          if (!Array.isArray(candidates) || candidates.length === 0) return null;
          if (needle.includes('/')) {
            const tail = `/${needle}`.toLowerCase();
            const exactTail = candidates.find((p) => p.replace(/[\\/]+/g, '/').toLowerCase().endsWith(tail));
            if (exactTail) return exactTail;
          }
          const byBase = candidates.find((p) => {
            const base = p.replace(/[\\/]+/g, '/').split('/').pop() ?? '';
            return base.toLowerCase() === basenameOnly.toLowerCase();
          });
          return byBase ?? candidates[0] ?? null;
        };

        const best = pickBest();
        if (!best) throw error;

        const openedId = await openFileAtPath(best, { paneId });
        dbg('openLinkTarget:fallback_file_opened', { seq, openedId, best, paneId });
        void revealFileInExplorer(best, seq);
        await applyWithWait(openedId, normalizeFsPath(best));
        dbg('openLinkTarget:fallback_done', { seq, openedId, best, paneId });
        return;
      } catch (fallbackError) {
        console.error('open file from link failed:', fallbackError);
        dbg('openLinkTarget:failed', { seq, error: String(fallbackError) });
        setOpenFromLinkError(
          typeof fallbackError === 'string'
            ? fallbackError
            : (fallbackError as any)?.message ?? '打开文件失败'
        );
      }
    }
  }, [dbg, openFileAtPath, revealFileInExplorer, uiStateRestored, workstudioId, ws]);

  // 在 Workstudio UI state 恢复完成后，处理之前暂存的 open_file 请求（只保留最后一次）。
  useEffect(() => {
    if (!ws) return;
    if (!uiStateRestored) return;
    const pending = pendingOpenLinkRef.current;
    if (!pending) return;
    pendingOpenLinkRef.current = null;
    void openLinkTarget(pending);
  }, [openLinkTarget, uiStateRestored, ws]);

  useEffect(() => {
    if (!uiStateRestored) return;
    if (!filePath || openedFromUrlRef.current) return;

    const normalized = normalizeFsPath(filePath);
    const isAbs = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//');
    // If it's a relative path, wait until we have ws.mainFolder to resolve it.
    if (!isAbs && !ws?.mainFolder) return;
    openedFromUrlRef.current = true;
    void openLinkTarget({ filePath, line, column, endLine, endColumn });
  }, [uiStateRestored, filePath, line, column, endLine, endColumn, ws?.mainFolder, openLinkTarget]);

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    void listen('workstudio:open_file', (event) => {
      const payload = (event as any).payload as LinkTarget | null | undefined;
      if (!payload?.filePath) return;
      void (async () => {
        const incomingId = (payload.workstudioId ?? '').trim();
        const currentId = (workstudioId ?? '').trim();

        if (incomingId && currentId && incomingId !== currentId) {
          const currentMainFolderFromState = normalizeFsPath(ws?.mainFolder ?? '');
          const incomingMainFolderFromPayload = normalizeFsPath((payload.mainFolder ?? '').trim());

          let currentMainFolder = currentMainFolderFromState;
          let incomingMainFolder = incomingMainFolderFromPayload;

          if (!incomingMainFolder) {
            try {
              const other = await invoke<Workstudio | null>('get_workstudio', { workstudioId: incomingId });
              incomingMainFolder = normalizeFsPath(other?.mainFolder ?? '');
            } catch {
              incomingMainFolder = '';
            }
          }

          if (!currentMainFolder) {
            try {
              const cur = await invoke<Workstudio | null>('get_workstudio', { workstudioId: currentId });
              currentMainFolder = normalizeFsPath(cur?.mainFolder ?? '');
            } catch {
              currentMainFolder = '';
            }
          }

          const matchesByFolder = Boolean(currentMainFolder && incomingMainFolder && currentMainFolder === incomingMainFolder);

          if (!matchesByFolder) {
            dbg('event:workstudio:open_file:ignored(workstudioId_mismatch)', {
              workstudioId: workstudioId ?? null,
              incomingWorkstudioId: payload.workstudioId ?? null,
              currentMainFolder: currentMainFolder || null,
              incomingMainFolder: incomingMainFolder || null,
              incomingMainFolderFromPayload: incomingMainFolderFromPayload || null,
              payload,
              visibility: typeof document !== 'undefined' ? document.visibilityState : null,
            });
            return;
          }

          dbg('event:workstudio:open_file:accept(mainFolder_match)', {
            workstudioId: workstudioId ?? null,
            incomingWorkstudioId: payload.workstudioId ?? null,
            currentMainFolder: currentMainFolder || null,
            incomingMainFolder: incomingMainFolder || null,
            incomingMainFolderFromPayload: incomingMainFolderFromPayload || null,
          });
        }

        dbg('event:workstudio:open_file', {
          workstudioId: workstudioId ?? null,
          payload,
          visibility: typeof document !== 'undefined' ? document.visibilityState : null,
        });
        void openLinkTarget(payload);
      })();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [dbg, openLinkTarget, workstudioId, ws?.mainFolder]);

  const closeFileTab = useCallback(
    (fileId: string) => {
      closeTabInLayout(fileId);
      setOpenFiles((prevFiles) => {
        const used = new Set(useWindowLayoutStore.getState().panes.flatMap((p) => p.tabIds));
        return used.has(fileId) ? prevFiles : prevFiles.filter((f) => f.id !== fileId);
      });
    },
    [closeTabInLayout]
  );

  const startResize = useCallback(
    (leftPaneId: string, rightPaneId: string, startClientX: number) => {
      const leftEl = paneRootRefs.current.get(leftPaneId);
      const rightEl = paneRootRefs.current.get(rightPaneId);
      if (!leftEl || !rightEl) return;
      const state = useWindowLayoutStore.getState();
      const left = state.panes.find((p) => p.id === leftPaneId) ?? null;
      const right = state.panes.find((p) => p.id === rightPaneId) ?? null;
      if (!left || !right) return;
      const leftRect = leftEl.getBoundingClientRect();
      const rightRect = rightEl.getBoundingClientRect();
      const totalWidth = leftRect.width + rightRect.width;
      if (!Number.isFinite(totalWidth) || totalWidth <= 0) return;
      const startLeftWidth = leftRect.width;
      const groupWeight = (left.weight || 1) + (right.weight || 1);
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      resizeRef.current = {
        dragging: true,
        leftPaneId,
        rightPaneId,
        startX: startClientX,
        startLeftWidth,
        totalWidth,
        groupWeight,
        prevUserSelect,
        prevCursor,
      };
    },
    []
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current?.dragging) return;
      const { leftPaneId, rightPaneId, startX, startLeftWidth, totalWidth, groupWeight } = resizeRef.current;
      const dx = e.clientX - startX;

      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
      const ratio = clamp((startLeftWidth + dx) / totalWidth, 0.2, 0.8);
      const leftW = groupWeight * ratio;
      const rightW = groupWeight - leftW;

      setPaneWeights([
        { paneId: leftPaneId, weight: leftW },
        { paneId: rightPaneId, weight: rightW },
      ]);
    };
    const onUp = () => {
      if (!resizeRef.current) return;
      document.body.style.userSelect = resizeRef.current.prevUserSelect;
      document.body.style.cursor = resizeRef.current.prevCursor;
      useWindowLayoutStore.getState().saveLayout();
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setPaneWeights]);

  const saveFile = useCallback(
    async (fileId: string, editor: import('monaco-editor').editor.IStandaloneCodeEditor | null) => {
      const file = openFilesRef.current.find((f) => f.id === fileId);
      if (!file) return;
      if (file.kind !== 'text') return;
      const latest = editor?.getValue() ?? file.content ?? '';
      setSaveError(null);
      try {
        const isRichTxt = file.title.toLowerCase().endsWith('.tauri.richtxt');

        if (isUntitledPath(file.id) || isUntitledPath(file.path)) {
          const suggested = ws?.mainFolder ? `${ws.mainFolder}/${file.title}` : file.title;
          const picked = await saveDialog({
            title: '保存文件',
            defaultPath: suggested,
          });
          if (!picked) return;

          const nextPath =
            isRichTxt && !picked.toLowerCase().endsWith('.tauri.richtxt') ? `${picked}.tauri.richtxt` : picked;
          const normalizedPath = normalizeFsPath(nextPath);
          if (!normalizedPath) return;

          await invoke('write_local_text_file', { path: normalizedPath, content: latest });

          setOpenFiles((prev) => {
            const existing = prev.find((f) => f.id === normalizedPath);
            const nextTitle = basename(normalizedPath);

            if (existing) {
              return prev
                .filter((f) => f.id !== file.id)
                .map((f) =>
                  f.id === normalizedPath
                    ? {
                        ...f,
                        title: nextTitle,
                        path: normalizedPath,
                        kind: 'text',
                        mime: 'text/plain',
                        size: utf8Size(latest),
                        content: latest,
                        originalContent: latest,
                        dirty: false,
                      }
                    : f
                );
            }

            return prev.map((f) =>
              f.id === file.id
                ? {
                    ...f,
                    id: normalizedPath,
                    title: nextTitle,
                    path: normalizedPath,
                    kind: 'text',
                    mime: 'text/plain',
                    size: utf8Size(latest),
                    content: latest,
                    originalContent: latest,
                    dirty: false,
                  }
                : f
            );
          });

          const layout = useWindowLayoutStore.getState();
          const nextPanes = layout.panes.map((p) => {
            const replaced = p.tabIds.map((id) => (id === file.id ? normalizedPath : id));
            const deduped = Array.from(new Set(replaced));
            const active = p.activeTabId === file.id ? normalizedPath : p.activeTabId;
            const nextActive = active && deduped.includes(active) ? active : deduped[0] ?? null;
            return { ...p, tabIds: deduped, activeTabId: nextActive };
          });
          layout.replaceLayout({ panes: nextPanes, focusedPaneId: layout.focusedPaneId });

          return;
        }

        await invoke('write_local_text_file', { path: file.path, content: latest });
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.id === file.id
              ? { ...f, content: latest, originalContent: latest, dirty: false, size: utf8Size(latest) }
              : f
          )
        );
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    },
    [ws]
  );

  const createUntitledRichTxt = useCallback(() => {
    const title = nextUntitledRichTxtTitle(openFilesRef.current);
    const id = `${UNTITLED_PREFIX}${title}`;
    const content = '<!-- tauri.richtxt v1 -->\n\n# 新建文档\n\n';

    const next: OpenFile = {
      id,
      title,
      path: id,
      kind: 'text',
      mime: 'text/plain',
      size: utf8Size(content),
      content,
      originalContent: '',
      dirty: true,
    };

    setOpenFiles((prev) => (prev.some((f) => f.id === id) ? prev : [...prev, next]));
    useWindowLayoutStore.getState().openTabInFocusedPane(id);
  }, []);

  const connectTerminal = useCallback(async () => {
    if (!terminalScope) return;
    await terminalSurfaceRef.current?.connect();
    terminalSurfaceRef.current?.focus();
  }, [terminalScope]);

  const closeTerminalSession = useCallback(async () => {
    if (!terminalScope) return;
    await terminalSurfaceRef.current?.disconnect();
    terminalSurfaceRef.current?.reset();
  }, [terminalScope]);

  const handleEditorMountForPane = useCallback(
    (paneId: string): OnMount =>
      (editor, monaco) => {
        setupMonaco(monaco);
        editorByPaneRef.current.set(paneId, editor);

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          const fileId = useWindowLayoutStore.getState().panes.find((p) => p.id === paneId)?.activeTabId ?? null;
          if (!fileId) return;
          void saveFile(fileId, editor);
        });
        editor.onDidFocusEditorWidget(() => useWindowLayoutStore.getState().setFocusedPane(paneId));
      },
    [saveFile]
  );

  const editorTheme = useMemo(() => {
    return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const registerPaneRootRef = useCallback(
    (paneId: string) => (el: HTMLDivElement | null) => {
      const map = paneRootRefs.current;
      if (el) map.set(paneId, el);
      else map.delete(paneId);
    },
    []
  );

  const registerPaneTabStripRef = useCallback(
    (paneId: string) => (el: HTMLDivElement | null) => {
      const map = paneTabStripRefs.current;
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

  type SplitPreview = {
    paneId: string;
    direction: 'left' | 'right';
    rect: { left: number; top: number; width: number; height: number };
  };

  const [activeDragTabId, setActiveDragTabId] = useState<string | null>(null);
  const {
    start: startDragGhost,
    moveByClientPoint: moveDragGhostByClientPoint,
    stop: stopDragGhost,
  } = useDragGhostSession({ pollIntervalMs: 32 });
  const dragGhostActiveRef = useRef(false);
  const [isDragGhostActive, setIsDragGhostActive] = useState(false);
  const dragGhostBaseTitleRef = useRef<string>('');
  const dragOriginTabStripRectRef = useRef<DOMRect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragCancelledByEscapeRef = useRef(false);
  const [splitPreview, setSplitPreview] = useState<SplitPreview | null>(null);
  const [remoteSplitPreview, setRemoteSplitPreview] = useState<SplitPreview | null>(null);

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

  const tabToPaneId = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of resolvedPanes) {
      for (const tid of p.tabIds) map.set(tid, p.id);
    }
    return map;
  }, [resolvedPanes]);

  const paneById = useMemo(() => {
    const map = new Map<string, WindowPane>();
    for (const p of resolvedPanes) map.set(p.id, p);
    return map;
  }, [resolvedPanes]);

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
    (fileId: string) => {
      const normalized = normalizeFsPath(fileId);
      if (!normalized) return;
      if (!workstudioId) return;

      const file = openFilesRef.current.find((f) => f.id === normalized) ?? null;
      const title = file?.title || basename(normalized) || 'Workstudio';

      void (async () => {
        try {
          const [cursor, size] = await Promise.all([
            cursorPosition().catch(() => null),
            getCurrentWebviewWindow().outerSize().catch(() => null),
          ]);

          const width = Math.max(720, Math.floor(size?.width ?? 1100));
          const height = Math.max(520, Math.floor(size?.height ?? 740));

          const bounds =
            cursor
              ? {
                  x: Math.floor(cursor.x - width * 0.25),
                  y: Math.floor(cursor.y - 24),
                  width,
                  height,
                }
              : { width, height };

          const label = `view-workstudio-${workstudioId}-tearoff-${Date.now()}-${Math.random()
            .toString(16)
            .slice(2)}`;
          const win = openViewWindow('workstudio', title, {
            label,
            workstudioId,
            noDefaultSession: true,
            filePath: normalized,
            window: bounds,
          });

          win.once('tauri://created', () => {
            void win.setFocus().catch(() => {});
            closeFileTab(normalized);
          });
          win.once('tauri://error', (err) => {
            console.error('Failed to tear off workstudio tab:', (err as any)?.payload ?? err);
            alert('打开新窗口失败，请检查窗口权限/配置');
          });
        } catch (err) {
          console.error('Failed to tear off workstudio tab:', err);
          alert('当前环境不支持打开新窗口');
        }
      })();
    },
    [closeFileTab, workstudioId]
  );

  const computeSplitPreview = useCallback((point: { x: number; y: number }): SplitPreview | null => {
    for (const [paneId, el] of paneBodyRefs.current) {
      const rect = el.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right) continue;
      if (point.y < rect.top || point.y > rect.bottom) continue;

      const edge = Math.max(56, Math.min(140, Math.round(rect.width * 0.18)));
      if (rect.width > 0 && point.x <= rect.left + edge) {
        return {
          paneId,
          direction: 'left',
          rect: { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height },
        };
      }
      if (rect.width > 0 && point.x >= rect.right - edge) {
        return {
          paneId,
          direction: 'right',
          rect: { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height },
        };
      }
    }
    return null;
  }, []);

  useRemoteDragSplitPreview<SplitPreview>({
    enabled: !activeDragTabId,
    computePreview: computeSplitPreview,
    onPreview: (p) => setRemoteSplitPreview(p),
  });

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const activeId = String(e.active.id);
    setActiveDragTabId(activeId);
    setSplitPreview(null);
    dragCancelledByEscapeRef.current = false;

    const file = openFilesRef.current.find((f) => f.id === activeId) ?? null;
    const title = file?.title || basename(activeId) || '文件';
    dragGhostActiveRef.current = false;
    setIsDragGhostActive(false);
    dragGhostBaseTitleRef.current = title;
    const fromPaneId = tabToPaneId.get(activeId) ?? null;
    const stripEl = fromPaneId ? paneTabStripRefs.current.get(fromPaneId) : null;
    dragOriginTabStripRectRef.current = stripEl ? stripEl.getBoundingClientRect() : null;

    const ev = e.activatorEvent as MouseEvent | PointerEvent | TouchEvent | null;
    if (ev && 'clientX' in ev) {
      dragStartRef.current = { x: ev.clientX, y: ev.clientY };
      lastDragPointRef.current = { x: ev.clientX, y: ev.clientY };
    } else {
      dragStartRef.current = null;
      lastDragPointRef.current = null;
    }
  }, [tabToPaneId]);

  const handleDragMove = useCallback(
    (e: DragMoveEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const point = { x: start.x + e.delta.x, y: start.y + e.delta.y };
      lastDragPointRef.current = point;

      const rect = dragOriginTabStripRectRef.current;
      const outsideTabStrip =
        !rect ||
        point.x < rect.left - GHOST_ACTIVATE_THRESHOLD_PX ||
        point.x > rect.right + GHOST_ACTIVATE_THRESHOLD_PX ||
        point.y < rect.top - GHOST_ACTIVATE_THRESHOLD_PX ||
        point.y > rect.bottom + GHOST_ACTIVATE_THRESHOLD_PX;

      if (outsideTabStrip) {
        if (!dragGhostActiveRef.current) {
          dragGhostActiveRef.current = true;
          setIsDragGhostActive(true);
          const base = dragGhostBaseTitleRef.current || 'File';

          const fromPaneId = tabToPaneId.get(activeDragTabId ?? '') ?? null;
          const stripEl = fromPaneId ? paneTabStripRefs.current.get(fromPaneId) : null;
          const escapeAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const tabEl =
            stripEl && activeDragTabId
              ? (stripEl.querySelector(`[data-workspace-tab-id="${escapeAttr(activeDragTabId)}"]`) as HTMLElement | null)
              : null;
          const tabRect = tabEl ? tabEl.getBoundingClientRect() : null;

          startDragGhost(base, tabRect ? { anchorRect: tabRect, clientPoint: point } : { clientPoint: point });
        }
        moveDragGhostByClientPoint(point);
      } else if (dragGhostActiveRef.current) {
        dragGhostActiveRef.current = false;
        setIsDragGhostActive(false);
        stopDragGhost();
      }

      const next = computeSplitPreview(point);
      setSplitPreview((prev) => {
        if (!next && !prev) return prev;
        if (!next) return null;
        if (prev && prev.paneId === next.paneId && prev.direction === next.direction) return prev;
        return next;
      });
    },
    [activeDragTabId, computeSplitPreview, moveDragGhostByClientPoint, startDragGhost, stopDragGhost, tabToPaneId]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const active = String(event.active.id);
      const over = event.over ? String(event.over.id) : null;

      const point = lastDragPointRef.current;
      dragStartRef.current = null;
      lastDragPointRef.current = null;

      const preview = point ? computeSplitPreview(point) : null;
      if (preview) {
        splitTabToNewPane(active, preview.direction, preview.paneId);
        setActiveDragTabId(null);
        setSplitPreview(null);
        dragGhostActiveRef.current = false;
        setIsDragGhostActive(false);
        dragGhostBaseTitleRef.current = '';
        dragOriginTabStripRectRef.current = null;
        stopDragGhost();
        return;
      }

      const shouldTearOffByClientPoint =
        Boolean(point) &&
        Boolean(
          point &&
            (point.x < -TEAR_OFF_THRESHOLD_PX ||
              point.x > window.innerWidth + TEAR_OFF_THRESHOLD_PX ||
              point.y < -TEAR_OFF_THRESHOLD_PX ||
              point.y > window.innerHeight + TEAR_OFF_THRESHOLD_PX)
        );

      // 先把拖拽 UI 收起，避免异步判断期间 overlay 悬挂
      setActiveDragTabId(null);
      setSplitPreview(null);
      dragGhostActiveRef.current = false;
      setIsDragGhostActive(false);
      dragGhostBaseTitleRef.current = '';
      dragOriginTabStripRectRef.current = null;
      stopDragGhost();

      if (shouldTearOffByClientPoint) {
        tearOffTabToNewWindow(active);
        return;
      }

      // 某些平台/环境下，拖拽离开窗口后 pointer move 事件不再更新，
      // 导致 `client point` 仍停留在窗内，进而无法触发 tear-off。
      void (async () => {
        const outsideWindow = await isCursorOutsideCurrentWindow(TEAR_OFF_WINDOW_THRESHOLD_PX);
        if (outsideWindow) {
          tearOffTabToNewWindow(active);
          return;
        }

        if (!over) return;

        if (over.startsWith('pane:')) {
          const toPaneId = over.slice('pane:'.length);
          moveTabToPane(active, toPaneId);
          return;
        }

        const toPaneId = tabToPaneId.get(over) ?? null;
        if (!toPaneId) return;

        const fromPaneId = tabToPaneId.get(active) ?? null;
        if (fromPaneId && fromPaneId === toPaneId) {
          reorderTabInPane(toPaneId, active, over);
          return;
        }

        const targetPane = paneById.get(toPaneId);
        const index = targetPane ? targetPane.tabIds.indexOf(over) : -1;
        moveTabToPane(active, toPaneId, index >= 0 ? index : undefined);
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
    (event: DragCancelEvent) => {
      const active = String(event.active.id);
      const start = dragStartRef.current;
      const point = lastDragPointRef.current;

      dragStartRef.current = null;
      lastDragPointRef.current = null;

      setActiveDragTabId(null);
      setSplitPreview(null);

      dragGhostActiveRef.current = false;
      setIsDragGhostActive(false);
      dragGhostBaseTitleRef.current = '';
      dragOriginTabStripRectRef.current = null;
      stopDragGhost();

      void (async () => {
        // Esc 取消：不触发“拖出窗口”逻辑
        if (dragCancelledByEscapeRef.current) return;

        const preview = point ? computeSplitPreview(point) : null;
        if (preview) {
          splitTabToNewPane(active, preview.direction, preview.paneId);
          return;
        }

        const movedDist = start && point ? Math.hypot(point.x - start.x, point.y - start.y) : 0;
        const lostFocus = typeof document !== 'undefined' ? !document.hasFocus() : false;
        const outsideWindow = await isCursorOutsideCurrentWindow(TEAR_OFF_WINDOW_THRESHOLD_PX);

        // 兼容：把 Tab 拖到其他应用窗口（可能导致 DnD cancel），依然要按“拖出窗体”处理。
        // 要求：确实发生了拖拽（移动距离够大），且出现了“明显外部”信号（失焦/游标在窗外）。
        const shouldTearOffOnCancel = movedDist >= 24 && (lostFocus || outsideWindow);
        if (shouldTearOffOnCancel) {
          tearOffTabToNewWindow(active);
        }
      })();
    },
    [
      computeSplitPreview,
      isCursorOutsideCurrentWindow,
      splitTabToNewPane,
      stopDragGhost,
      tearOffTabToNewWindow,
    ]
  );

  const addFolder = useCallback(async () => {
    if (!ws) return;
    const selected = await openDialog({ title: '添加工作文件夹', multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    try {
      const updated = await invoke<Workstudio>('add_workstudio_folder', {
        workstudioId: ws.id,
        folder: selected,
        setAsMain: false,
      });
      setWs(updated);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.add(updated.mainFolder);
        return next;
      });
      void listDir(updated.mainFolder);
    } catch (error) {
      console.error('add_workstudio_folder failed:', error);
    }
  }, [ws, listDir]);

  const openMainFolder = useCallback(async () => {
    if (!ws) return;
    const selected = await openDialog({ title: '打开文件夹为主工作区', multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    try {
      const updated = await invoke<Workstudio>('add_workstudio_folder', {
        workstudioId: ws.id,
        folder: selected,
        setAsMain: true,
      });
      setWs(updated);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.add(updated.mainFolder);
        return next;
      });
      void listDir(updated.mainFolder);
    } catch (error) {
      console.error('open main folder failed:', error);
    }
  }, [ws, listDir]);

  const openFileFromDialog = useCallback(async () => {
    const selected = await openDialog({ title: '打开文件', multiple: false, directory: false });
    if (!selected || Array.isArray(selected)) return;
    await openFileAtPath(selected);
  }, [openFileAtPath]);

  // Workstudio 文件搜索（由全局快捷键系统分发：tauri-ai:shortcut）
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const e = event as CustomEvent<{ action?: string }>;
      if (e.detail?.action !== 'workstudio.fileSearch') return;
      setFilePaletteOpen(true);
      window.setTimeout(() => filePaletteInputRef.current?.focus(), 0);
    };
    window.addEventListener('tauri-ai:shortcut', onShortcut as EventListener);
    return () => window.removeEventListener('tauri-ai:shortcut', onShortcut as EventListener);
  }, []);

  // Esc: close palette (local behavior)
  useEffect(() => {
    if (!filePaletteOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setFilePaletteOpen(false);
      setFilePaletteQuery('');
      setFilePaletteResults([]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filePaletteOpen]);

  useEffect(() => {
    if (!filePaletteOpen) return;
    if (!ws) return;
    const q = filePaletteQuery.trim();
    if (!q) {
      setFilePaletteResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void invoke<string[]>('workstudio_find_files', {
        args: { workstudioId: ws.id, query: q, limit: 200 },
      })
        .then((res) => {
          setFilePaletteResults(res);
          setFilePaletteIndex(0);
        })
        .catch(() => {
          setFilePaletteResults([]);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [filePaletteOpen, filePaletteQuery, ws]);

  useEffect(() => {
    if (!workstudioId) return;
    void loadWorkstudio(workstudioId);
  }, [workstudioId, loadWorkstudio]);

  useEffect(() => {
    if (!ws) return;
    setUiStateRestored(false);
    setOpenFiles([]);
    replaceLayout({
      panes: [
        {
          id: fallbackPaneIdRef.current,
          tabIds: [],
          activeTabId: null,
          weight: 1,
        },
      ],
      focusedPaneId: fallbackPaneIdRef.current,
    });
    let cancelled = false;
    (async () => {
      try {
        const state = await invoke<WorkstudioUiState | null>('get_workstudio_ui_state', {
          workstudioId: ws.id,
        });
        if (cancelled) return;
        if (!state) return;

        const legacyPaths = Array.isArray(state.openFiles)
          ? state.openFiles.map((p) => normalizeFsPath(String(p))).filter((p) => Boolean(p))
          : [];

        const panesFromState = Array.isArray(state.panes) ? state.panes : [];
        const panePaths = panesFromState
          .flatMap((p) => (Array.isArray(p.tabIds) ? p.tabIds : []))
          .map((p) => normalizeFsPath(String(p)))
          .filter((p) => Boolean(p));

        const groupsFromState = Array.isArray(state.groups) ? state.groups : [];
        const groupPaths = groupsFromState
          .flatMap((g) => (Array.isArray(g.openFiles) ? g.openFiles : []))
          .map((p) => normalizeFsPath(String(p)))
          .filter((p) => Boolean(p));

        const paths = panesFromState.length
          ? Array.from(new Set(panePaths))
          : groupsFromState.length
            ? Array.from(new Set(groupPaths))
            : legacyPaths;
        if (paths.length === 0) {
          replaceLayout({
            panes: [
              {
                id: fallbackPaneIdRef.current,
                tabIds: [],
                activeTabId: null,
                weight: 1,
              },
            ],
            focusedPaneId: fallbackPaneIdRef.current,
          });
          return;
        }

        const results = await Promise.all(
          paths.map(async (path) => {
            try {
              const file = await invoke<{ filename: string; mime: string; base64: string; size: number }>(
                'read_local_file_base64',
                { path }
              );
              const normalizedPath = normalizeFsPath(path);
              const id = normalizedPath;
              const kind = fileKindFor(normalizedPath, file.mime);
              const content = kind === 'text' ? decodeBase64ToUtf8(file.base64) : undefined;
              const next: OpenFile = {
                id,
                title: file.filename,
                path: normalizedPath,
                kind,
                mime: file.mime,
                size: file.size,
                content,
                originalContent: content,
                dirty: false,
                dataUrl: kind === 'image' ? `data:${file.mime};base64,${file.base64}` : undefined,
                base64: file.base64,
              };
              return next;
            } catch {
              return null;
            }
          })
        );

        const files = results.filter((v): v is OpenFile => Boolean(v));
        if (files.length === 0) return;

        setOpenFiles(files);

        const fileIdSet = new Set(files.map((f) => f.id));
        const assigned = new Set<string>();
        const appendUnique = (ids: string[]) => {
          const out: string[] = [];
          for (const id of ids) {
            if (!fileIdSet.has(id)) continue;
            if (assigned.has(id)) continue;
            assigned.add(id);
            out.push(id);
          }
          return out;
        };

        const nextPanes: WindowPane[] = (() => {
          if (panesFromState.length) {
            return panesFromState
              .map((p, idx) => {
                const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : `p-${idx}`;
                const tabIds = appendUnique(
                  (Array.isArray(p.tabIds) ? p.tabIds : [])
                    .map((v) => normalizeFsPath(String(v)))
                    .filter((v) => Boolean(v))
                );
                const rawActive = typeof p.activeTabId === 'string' ? normalizeFsPath(p.activeTabId) : null;
                const activeTabId = rawActive && tabIds.includes(rawActive) ? rawActive : tabIds[0] ?? null;
                const weight = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 1;
                return { id, tabIds, activeTabId, weight };
              })
              .filter((p) => p.tabIds.length > 0);
          }

          if (groupsFromState.length) {
            return groupsFromState
              .map((g, idx) => {
                const id = `p-${idx}`;
                const tabIds = appendUnique(
                  (Array.isArray(g.openFiles) ? g.openFiles : [])
                    .map((v) => normalizeFsPath(String(v)))
                    .filter((v) => Boolean(v))
                );
                const rawActive = typeof g.activeFile === 'string' ? normalizeFsPath(g.activeFile) : null;
                const activeTabId = rawActive && tabIds.includes(rawActive) ? rawActive : tabIds[0] ?? null;
                const weight = typeof g.weight === 'number' && Number.isFinite(g.weight) ? g.weight : 1;
                return { id, tabIds, activeTabId, weight };
              })
              .filter((p) => p.tabIds.length > 0);
          }

          if (state.splitOpen && (state.activeRightFile || state.activeLeftFile)) {
            const leftFromState = typeof state.activeLeftFile === 'string' ? normalizeFsPath(state.activeLeftFile) : null;
            const rightFromState = typeof state.activeRightFile === 'string' ? normalizeFsPath(state.activeRightFile) : null;
            const left = leftFromState && fileIdSet.has(leftFromState) ? leftFromState : files[0]!.id;
            const right = rightFromState && fileIdSet.has(rightFromState) ? rightFromState : files[0]!.id;
            const leftIds = appendUnique([left]);
            const rightIds = appendUnique(right && right !== left ? [right] : []);
            const out: WindowPane[] = [];
            if (leftIds.length) out.push({ id: 'p-0', tabIds: leftIds, activeTabId: leftIds[0] ?? null, weight: 1 });
            if (rightIds.length) out.push({ id: 'p-1', tabIds: rightIds, activeTabId: rightIds[0] ?? null, weight: 1 });
            return out;
          }

          const all = appendUnique(files.map((f) => f.id));
          return [
            {
              id: 'p-0',
              tabIds: all,
              activeTabId: all[0] ?? null,
              weight: 1,
            },
          ];
        })();

        const focused = (() => {
          const fromState = typeof state.focusedPaneId === 'string' ? state.focusedPaneId : null;
          if (fromState && nextPanes.some((p) => p.id === fromState)) return fromState;
          if (typeof state.focusedGroupIndex === 'number') {
            const idx = Math.max(0, Math.min(nextPanes.length - 1, state.focusedGroupIndex));
            return nextPanes[idx]?.id ?? nextPanes[0]?.id ?? null;
          }
          return nextPanes[0]?.id ?? null;
        })();

        replaceLayout({
          panes: nextPanes.length
            ? nextPanes
            : [
                {
                  id: fallbackPaneIdRef.current,
                  tabIds: [],
                  activeTabId: null,
                  weight: 1,
                },
              ],
          focusedPaneId: focused ?? fallbackPaneIdRef.current,
        });

        if (Array.isArray(state.expandedDirs) && state.expandedDirs.length) {
          const nextExpanded = new Set(state.expandedDirs);
          setExpandedDirs(nextExpanded);
          for (const dir of nextExpanded) {
            void listDir(dir);
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setUiStateRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replaceLayout, ws]);

  useEffect(() => {
    if (!ws) return;
    if (saveStateTimerRef.current) window.clearTimeout(saveStateTimerRef.current);
    saveStateTimerRef.current = window.setTimeout(() => {
      const persistedOpenFiles = openFiles.filter((f) => !isUntitledPath(f.path));
      const state: WorkstudioUiState = {
        openFiles: Array.from(new Set(persistedOpenFiles.map((f) => f.path))),
        panes: resolvedPanes
          .map((p) => ({
            id: p.id,
            tabIds: Array.from(new Set(p.tabIds.filter((id) => !isUntitledPath(id)))),
            activeTabId: p.activeTabId && !isUntitledPath(p.activeTabId) ? p.activeTabId : undefined,
            weight: p.weight,
          }))
          .filter((p) => p.tabIds.length > 0),
        focusedPaneId: resolvedFocusedPaneId ?? undefined,
        expandedDirs: Array.from(expandedDirs),
      };
      void invoke('set_workstudio_ui_state', { workstudioId: ws.id, state }).catch(() => {});
    }, 500);
    return () => {
      if (saveStateTimerRef.current) window.clearTimeout(saveStateTimerRef.current);
    };
  }, [ws, openFiles, resolvedPanes, resolvedFocusedPaneId, expandedDirs]);

  useEffect(() => {
    if (!ws) return;
    void listDir(ws.mainFolder);
  }, [ws, listDir]);

  // Best-effort auto refresh (polling) for expanded directories.
  // This avoids a manual "refresh" button while keeping the UI responsive to changes.
  useEffect(() => {
    if (!ws) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      for (const dir of expandedDirs) {
        if (!entriesByDir[dir]) continue;
        if (loadingDirs[dir]) continue;
        void listDir(dir);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [ws, expandedDirs, entriesByDir, loadingDirs, listDir]);

  useEffect(() => {
    if (!contextMenu && !tabMenu) return;
    const onDown = () => {
      setContextMenu(null);
      setTabMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [contextMenu, tabMenu]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen('menu:open_file', async () => {
      try {
        await openFileFromDialog();
      } catch (error) {
        console.error('Workstudio open file failed:', error);
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openFileFromDialog]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen('menu:new_richtxt', () => {
      try {
        createUntitledRichTxt();
      } catch (error) {
        console.error('Workstudio new .tauri.richtxt failed:', error);
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [createUntitledRichTxt]);

  const renderDirNode = (dirPath: string, depth: number, opts?: { isRoot?: boolean; isMainRoot?: boolean }) => {
    const expanded = expandedDirs.has(dirPath);
    const entries = entriesByDir[dirPath] ?? [];
    const isLoading = loadingDirs[dirPath];
    const isRoot = Boolean(opts?.isRoot);
    const isMainRoot = Boolean(opts?.isMainRoot);

    return (
      <div key={dirPath}>
        <button
          type="button"
          data-ws-node="1"
          onClick={() => void toggleDir(dirPath)}
          onContextMenu={(e) => {
            if (!isRoot) return;
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ visible: true, x: e.clientX, y: e.clientY, kind: 'root', folder: dirPath });
          }}
          className={[
            'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs',
            isMainRoot
              ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-200 dark:hover:bg-blue-900/40'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
          ].join(' ')}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={dirPath}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span className="truncate">{basename(dirPath)}</span>
          {isLoading && <span className="ml-auto text-[10px] text-gray-400">...</span>}
        </button>

        {expanded && (
          <div>
            {entries.length === 0 && !isLoading ? (
              <div
                className="px-2 py-1 text-[11px] text-gray-400"
                style={{ paddingLeft: 8 + (depth + 1) * 14 }}
              >
                (空)
              </div>
            ) : (
              entries.map((entry) => {
                if (entry.isDir) {
                  return renderDirNode(entry.path, depth + 1);
                }
                const normalizedEntryPath = normalizeFsPath(entry.path);
                const isActive =
                  Boolean(normalizedEntryPath) && explorerSelectedFilePath === normalizedEntryPath;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    data-ws-node="1"
                    onClick={() => void openFileAtPath(entry.path)}
                    className={[
                      'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs',
                      isActive
                        ? 'bg-blue-200/70 text-blue-900 ring-1 ring-blue-300/60 dark:bg-blue-900/60 dark:text-blue-100 dark:ring-blue-700/60'
                        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
                    ].join(' ')}
                    style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                    title={normalizedEntryPath || entry.path}
                  >
                    <FileText size={13} />
                    <span className="truncate">{entry.name}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  };

  if (!workstudioId) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
        未指定 workstudioId
      </div>
    );
  }

  if (wsLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
        加载 Workstudio...
      </div>
    );
  }

  if (wsError) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 p-6 text-sm text-red-600 dark:bg-gray-900 dark:text-red-300">
        {wsError}
      </div>
    );
  }

  if (!ws) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
        Workstudio 未加载
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
	      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-[280px] flex-shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-800">
            <div className="min-w-0">
              <div className="truncate text-[11px] text-gray-500 dark:text-gray-400" title={ws.mainFolder}>
                主工作区:{' '}
                <span className="font-semibold text-blue-700 dark:text-blue-200">
                  {basename(ws.mainFolder)}
                </span>
              </div>
            </div>
          </div>

          <div
            className="flex-1 overflow-auto px-2 py-2"
            ref={explorerContainerRef}
            onContextMenu={(e) => {
              const target = e.target as HTMLElement | null;
              if (target && target.closest('[data-ws-node="1"]')) return;
              e.preventDefault();
              setContextMenu({ visible: true, x: e.clientX, y: e.clientY, kind: 'blank' });
            }}
          >
            <div className="space-y-1">
              {rootFolders.map((folder) =>
                renderDirNode(folder, 0, { isRoot: true, isMainRoot: folder === ws.mainFolder })
              )}
            </div>
          </div>
        </div>

	        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
	          <div className="flex items-center justify-between border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-950">
	            <div className="min-w-0 text-xs text-gray-600 dark:text-gray-300">
	              窗格: {resolvedPanes.length}{' '}
	              <span className="text-gray-400">
	                （聚焦 {Math.max(1, resolvedPanes.findIndex((p) => p.id === resolvedFocusedPaneId) + 1)}）
	              </span>
	            </div>
	            <div className="flex items-center gap-2">
	              <button
	                type="button"
	                className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
	                onClick={() => setTerminalOpen((v) => !v)}
	                title="终端"
	              >
	                {terminalOpen ? '关闭终端' : '终端'}
	              </button>
	            </div>
	          </div>
	          {saveError && (
	            <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
	              保存失败：{saveError}
	            </div>
	          )}
	          {openFromLinkError && (
	            <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
	              打开链接文件失败：{openFromLinkError}
	            </div>
	          )}

	          <DndContext
	            sensors={sensors}
	            collisionDetection={closestCenter}
	            onDragStart={handleDragStart}
	            onDragMove={handleDragMove}
	            onDragEnd={handleDragEnd}
	            onDragCancel={handleDragCancel}
	          >
	            <div ref={paneRowRef} className="flex min-h-0 flex-1 flex-row overflow-hidden">
	              {resolvedPanes.map((pane, idx) => {
	                const activeFileId =
	                  pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
	                    ? pane.activeTabId
	                    : pane.tabIds[0] ?? null;
	                const activeFile = activeFileId ? openFiles.find((f) => f.id === activeFileId) ?? null : null;
	                const isFocused = pane.id === resolvedFocusedPaneId;
	                const leftPaneId = idx > 0 ? resolvedPanes[idx - 1]!.id : null;
	                return (
	                  <React.Fragment key={pane.id}>
	                    {idx > 0 && leftPaneId && (
	                      <div
	                        className="w-1 cursor-col-resize bg-transparent hover:bg-blue-200/60 dark:hover:bg-blue-900/40"
	                        onMouseDown={(e) => startResize(leftPaneId, pane.id, e.clientX)}
	                        title="拖拽调整分屏比例"
	                      />
	                    )}
	                    <div
	                      ref={registerPaneRootRef(pane.id)}
	                      className={[
	                        'flex min-w-0 flex-col overflow-hidden',
	                        isFocused ? 'bg-blue-50/30 dark:bg-blue-950/10' : '',
	                      ].join(' ')}
	                      style={{ flexGrow: pane.weight, flexBasis: 0 }}
	                      onPointerDownCapture={() => setFocusedPane(pane.id)}
	                    >
	                      <PaneDropZone paneId={pane.id}>
	                        <div
	                          ref={registerPaneTabStripRef(pane.id)}
	                          className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 py-1 dark:border-gray-800 dark:bg-gray-950"
	                        >
	                          <SortableContext items={pane.tabIds} strategy={horizontalListSortingStrategy}>
	                            {pane.tabIds.length === 0 ? (
	                              <div className="px-2 py-1 text-xs text-gray-400">未打开文件</div>
	                            ) : (
	                              pane.tabIds.map((fileId) => {
	                                const file = openFiles.find((f) => f.id === fileId);
	                                if (!file) return null;
	                                const active = file.id === activeFileId;
	                                const title = `${file.title}${file.dirty ? ' *' : ''}`;
	                                return (
	                                  <SortableTab
	                                    key={`${pane.id}:${file.id}`}
	                                    id={file.id}
	                                    active={active}
	                                    title={title}
	                                    onClick={() => setActiveTabInPane(pane.id, file.id)}
	                                    onClose={() => closeFileTab(file.id)}
	                                    onContextMenu={(e) => {
	                                      e.preventDefault();
	                                      e.stopPropagation();
	                                      setTabMenu({
	                                        visible: true,
	                                        x: e.clientX,
	                                        y: e.clientY,
	                                        paneId: pane.id,
	                                        fileId: file.id,
	                                        path: file.path,
	                                      });
	                                    }}
	                                  />
	                                );
	                              })
	                            )}
	                          </SortableContext>

	                          <div className="ml-auto flex items-center gap-2 px-1">
	                            <button
	                              type="button"
	                              disabled={resolvedPanes.length <= 1}
	                              className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
	                              onClick={() => closePaneAndMerge(pane.id)}
	                              title="关闭窗格"
	                            >
	                              关闭窗格
	                            </button>
	                          </div>
	                        </div>

	                        <div ref={registerPaneBodyRef(pane.id)} className="min-h-0 flex-1">
	                          {activeFile ? (
	                            activeFile.kind === 'text' ? (
	                              <Editor
	                                path={toMonacoModelPath(activeFile.path)}
	                                language={languageForPath(activeFile.path)}
	                                value={activeFile.content ?? ''}
	                                onMount={handleEditorMountForPane(pane.id)}
	                                onChange={(value) => {
	                                  const nextValue = value ?? '';
	                                  setOpenFiles((prev) =>
	                                    prev.map((file) =>
	                                      file.id === activeFile.id
	                                        ? {
	                                            ...file,
	                                            content: nextValue,
	                                            dirty: nextValue !== (file.originalContent ?? ''),
	                                          }
	                                        : file
	                                    )
	                                  );
	                                }}
	                                theme={editorTheme}
	                                options={{
	                                  minimap: { enabled: false },
	                                  fontSize: 13,
	                                  fontFamily:
	                                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	                                  lineNumbers: 'on',
	                                  wordWrap: 'on',
	                                  renderWhitespace: 'selection',
	                                  automaticLayout: true,
	                                  scrollBeyondLastLine: false,
	                                }}
	                              />
	                            ) : (
	                              <div className="flex h-full flex-col gap-3 p-4">
	                                <div className="flex items-center justify-between">
	                                  <div className="min-w-0">
	                                    <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
	                                      {activeFile.title}
	                                    </div>
	                                    <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
	                                      {activeFile.kind} · {activeFile.mime} · {activeFile.size} bytes
	                                    </div>
	                                  </div>
	                                  <button
	                                    type="button"
	                                    className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
	                                    onClick={() => void openPath(activeFile.path)}
	                                    title="在系统默认应用中打开"
	                                  >
	                                    在系统中打开
	                                  </button>
	                                </div>

	                                {activeFile.kind === 'image' && activeFile.dataUrl ? (
	                                  <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
	                                    <img
	                                      src={activeFile.dataUrl}
	                                      alt={activeFile.title}
	                                      className="max-h-[70vh] max-w-full rounded"
	                                    />
	                                  </div>
	                                ) : activeFile.kind === 'pdf' && activeFile.base64 ? (
	                                  <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
	                                    <iframe
	                                      title={activeFile.title}
	                                      className="h-full w-full"
	                                      src={`data:application/pdf;base64,${activeFile.base64}`}
	                                    />
	                                  </div>
	                                ) : (
	                                  <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200">
	                                    <div className="font-medium">二进制预览（前 256 bytes）</div>
	                                    <div className="mt-2 font-mono break-words">
	                                      {activeFile.base64
	                                        ? bytesToHexPreview(decodeBase64ToBytes(activeFile.base64), 256)
	                                        : '(无数据)'}
	                                    </div>
	                                  </div>
	                                )}
	                              </div>
	                            )
	                          ) : (
	                            <div className="flex h-full items-center justify-center text-sm text-gray-400">
	                              在左侧 Explorer 里选择一个文件
	                            </div>
	                          )}
	                        </div>
	                      </PaneDropZone>
	                    </div>
	                  </React.Fragment>
	                );
	              })}
	            </div>

	            <DragOverlay>
	              {!isDragGhostActive && activeDragTabId ? (
	                <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
	                  {openFiles.find((f) => f.id === activeDragTabId)?.title ?? basename(activeDragTabId)}
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

	            {!splitPreview && remoteSplitPreview && (
	              <div
	                className="pointer-events-none fixed z-[235]"
	                style={{
	                  left: `${remoteSplitPreview.rect.left}px`,
	                  top: `${remoteSplitPreview.rect.top}px`,
	                  width: `${remoteSplitPreview.rect.width}px`,
	                  height: `${remoteSplitPreview.rect.height}px`,
	                }}
	              >
	                <div className="h-full w-full rounded bg-blue-500/10 outline outline-2 outline-blue-500/40" />
	                <div className="absolute left-2 top-2 rounded bg-blue-600 px-2 py-1 text-xs text-white shadow">
	                  {remoteSplitPreview.direction === 'left' ? '分屏到左侧' : '分屏到右侧'}
	                </div>
	              </div>
	            )}
	          </DndContext>

	        </div>
      </div>

      {filePaletteOpen && (
        <div className="fixed inset-0 z-[210]">
          <div
            className="absolute inset-0 bg-black/25 backdrop-blur-[1px]"
            onClick={() => setFilePaletteOpen(false)}
          />
          <div className="absolute left-1/2 top-16 w-[720px] max-w-[92vw] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">搜索文件</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">快捷键：{fileSearchShortcutLabel}</div>
            </div>
            <div className="p-4">
              <input
                ref={filePaletteInputRef}
                value={filePaletteQuery}
                onChange={(e) => setFilePaletteQuery(e.target.value)}
                placeholder="输入文件名或路径片段..."
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setFilePaletteOpen(false);
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setFilePaletteIndex((i) => Math.min(i + 1, Math.max(0, filePaletteResults.length - 1)));
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setFilePaletteIndex((i) => Math.max(0, i - 1));
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const picked = filePaletteResults[filePaletteIndex];
                    if (!picked) return;
                    setFilePaletteOpen(false);
                    setFilePaletteQuery('');
                    setFilePaletteResults([]);
                    void openFileAtPath(picked);
                  }
                }}
              />

              <div className="mt-3 max-h-[55vh] overflow-auto rounded-xl border border-gray-200 dark:border-gray-700">
                {filePaletteResults.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {filePaletteQuery.trim() ? '未找到匹配文件' : '输入关键字开始搜索'}
                  </div>
                ) : (
                  filePaletteResults.map((p, idx) => (
                    <button
                      key={p}
                      type="button"
                      className={[
                        'w-full px-3 py-2 text-left text-sm',
                        idx === filePaletteIndex
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                          : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800',
                      ].join(' ')}
                      onMouseEnter={() => setFilePaletteIndex(idx)}
                      onClick={() => {
                        setFilePaletteOpen(false);
                        setFilePaletteQuery('');
                        setFilePaletteResults([]);
                        void openFileAtPath(p);
                      }}
                      title={p}
                    >
                      <div className="truncate font-mono text-[12px]">{basename(p)}</div>
                      <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">
                        {p}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-[200] min-w-[180px] rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.kind === 'blank' && (
            <div className="py-1 text-sm">
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  setContextMenu(null);
                  void openFileFromDialog();
                }}
              >
                打开文件...
              </button>
              {shouldShowOpenMainFolderAction && (
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                  onClick={() => {
                    setContextMenu(null);
                    void openMainFolder();
                  }}
                >
                  打开文件夹为主工作区...
                </button>
              )}
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  setContextMenu(null);
                  void addFolder();
                }}
              >
                添加工作区文件夹...
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  setContextMenu(null);
                  void revealItemInDir(ws.mainFolder);
                }}
              >
                在系统中打开主工作区
              </button>
            </div>
          )}

          {contextMenu.kind === 'root' && (
            <div className="py-1 text-sm">
              <div
                className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 truncate"
                title={contextMenu.folder}
              >
                {contextMenu.folder}
              </div>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const folder = contextMenu.folder;
                  setContextMenu(null);
                  void revealItemInDir(folder);
                }}
              >
                在系统中打开
              </button>
              <button
                type="button"
                disabled={contextMenu.folder === ws.mainFolder}
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={async () => {
                  const folder = contextMenu.folder;
                  setContextMenu(null);
                  try {
                    const updated = await invoke<Workstudio>('set_workstudio_main_folder', {
                      workstudioId: ws.id,
                      folder,
                    });
                    setWs(updated);
                    setExpandedDirs((prev) => {
                      const next = new Set(prev);
                      next.add(updated.mainFolder);
                      return next;
                    });
                  } catch (error) {
                    console.error('set_workstudio_main_folder failed:', error);
                  }
                }}
              >
                设为主工作区
              </button>
              <button
                type="button"
                disabled={rootFolders.length <= 1}
                className="w-full px-3 py-2 text-left text-red-600 hover:bg-gray-100 disabled:opacity-50 dark:text-red-400 dark:hover:bg-gray-800"
                onClick={async () => {
                  const folder = contextMenu.folder;
                  setContextMenu(null);
                  try {
                    const updated = await invoke<Workstudio>('remove_workstudio_folder', {
                      workstudioId: ws.id,
                      folder,
                    });
                    setWs(updated);
                    setExpandedDirs((prev) => {
                      const next = new Set(prev);
                      next.delete(folder);
                      return next;
                    });
                  } catch (error) {
                    console.error('remove_workstudio_folder failed:', error);
                  }
                }}
              >
                从工作区移除
              </button>
            </div>
          )}
        </div>
      )}

      {ws && (
        <div
          className={[
            'flex flex-shrink-0 flex-col border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950',
            terminalOpen ? 'h-[260px]' : 'h-0 overflow-hidden',
          ].join(' ')}
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs text-gray-700 dark:border-gray-800 dark:text-gray-200">
            <div className="font-medium">Terminal</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                onClick={() => void connectTerminal()}
                disabled={!terminalOpen}
                title="初始化/重新连接"
              >
                连接
              </button>
              <button
                type="button"
                className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                onClick={() => void closeTerminalSession()}
                disabled={!terminalOpen || !terminalSessionId}
                title="结束终端会话"
              >
                结束会话
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                onClick={() => setTerminalOpen(false)}
                title="关闭面板"
                aria-label="关闭面板"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {terminalScope ? (
              <TerminalSurface
                ref={terminalSurfaceRef}
                scope={terminalScope}
                workdir={ws.mainFolder}
                isActive={terminalOpen}
                autoConnect
                className="h-full w-full bg-white dark:bg-gray-950"
                closeOnUnmount={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-gray-500 dark:text-gray-400">
                终端未就绪
              </div>
            )}
          </div>
        </div>
      )}

	      {tabMenu && (
	        <div
	          className="fixed z-[220] min-w-[220px] rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
	          style={{ left: tabMenu.x, top: tabMenu.y }}
	          onMouseDown={(e) => e.stopPropagation()}
	        >
	          <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 truncate" title={tabMenu.path}>
	            {tabMenu.path}
	          </div>
	          <div className="py-1 text-sm">
	            <button
	              type="button"
	              className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
	              onClick={() => {
	                const menu = tabMenu;
	                setTabMenu(null);
	                const pane = paneById.get(menu.paneId);
	                if (!pane) return;
	                const toClose = pane.tabIds.filter((id) => id !== menu.fileId);
	                for (const fid of toClose) closeFileTab(fid);
	              }}
	            >
	              关闭其他
	            </button>
	            <button
	              type="button"
	              className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
	              onClick={() => {
	                const menu = tabMenu;
	                setTabMenu(null);
	                const pane = paneById.get(menu.paneId);
	                if (!pane) return;
	                const idx = pane.tabIds.indexOf(menu.fileId);
	                if (idx <= 0) return;
	                const toClose = pane.tabIds.slice(0, idx);
	                for (const fid of toClose) closeFileTab(fid);
	              }}
	            >
	              关闭左侧
	            </button>
	            <button
	              type="button"
	              className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
	              onClick={() => {
	                const menu = tabMenu;
	                setTabMenu(null);
	                const pane = paneById.get(menu.paneId);
	                if (!pane) return;
	                const idx = pane.tabIds.indexOf(menu.fileId);
	                if (idx < 0 || idx >= pane.tabIds.length - 1) return;
	                const toClose = pane.tabIds.slice(idx + 1);
	                for (const fid of toClose) closeFileTab(fid);
	              }}
	            >
	              关闭右侧
	            </button>
	            <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
	            <button
	              type="button"
	              disabled={isUntitledPath(tabMenu.path)}
	              className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-800"
	              onClick={() => {
	                const p = tabMenu.path;
	                setTabMenu(null);
	                if (isUntitledPath(p)) return;
	                void revealItemInDir(p);
	              }}
	            >
	              在系统中打开所在文件夹
	            </button>
	            <button
	              type="button"
	              className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
	              onClick={() => {
                const p = tabMenu.path;
                setTabMenu(null);
                void navigator.clipboard.writeText(p);
              }}
	            >
	              复制路径
	            </button>
	          </div>
	        </div>
	      )}
    </div>
  );
};

export default WorkstudioView;
