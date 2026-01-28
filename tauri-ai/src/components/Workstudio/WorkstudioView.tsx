import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  X,
} from 'lucide-react';
import type { Workstudio, WorkstudioUiState } from '../../types';
import { getViewWindowParams } from '../../utils/viewWindow';
import { setupMonaco } from '../../utils/monaco';

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

type EditorGroup = {
  id: string;
  openFileIds: string[];
  activeFileId: string | null;
  weight: number;
};

const pruneEmptyGroups = (groups: EditorGroup[]) => {
  if (groups.length <= 1) return groups;
  const kept = groups.filter((g) => g.openFileIds.length > 0);
  return kept.length > 0 ? kept : [groups[0]!];
};

const redistributeWeightOnRemove = (groups: EditorGroup[], removedIndex: number, removedWeight: number) => {
  if (groups.length === 0) return groups;
  const targetIndex = Math.min(removedIndex, groups.length - 1);
  const target = groups[targetIndex];
  if (!target) return groups;
  const out = [...groups];
  out[targetIndex] = { ...target, weight: (target.weight || 1) + removedWeight };
  return out;
};

const normalizeGroupWeights = (groups: EditorGroup[]) => {
  const sum = groups.reduce((acc, g) => acc + (g.weight || 1), 0);
  if (sum <= 0) return groups.map((g) => ({ ...g, weight: 1 }));
  return groups.map((g) => ({ ...g, weight: (g.weight || 1) / sum }));
};

const tabKey = (groupId: string, fileId: string) => `tab:${groupId}:${fileId}`;
const parseTabKey = (id: string): { groupId: string; fileId: string } | null => {
  if (!id.startsWith('tab:')) return null;
  const rest = id.slice('tab:'.length);
  const first = rest.indexOf(':');
  if (first <= 0) return null;
  const groupId = rest.slice(0, first);
  const fileId = rest.slice(first + 1);
  if (!groupId || !fileId) return null;
  return { groupId, fileId };
};

const dropKey = (groupId: string) => `drop:${groupId}`;
const splitDropKey = (groupId: string) => `split:${groupId}`;

const GroupDropZone: React.FC<{ groupId: string; children: React.ReactNode }> = ({ groupId, children }) => {
  const { setNodeRef } = useDroppable({ id: dropKey(groupId) });
  return (
    <div ref={setNodeRef} className="min-w-0">
      {children}
    </div>
  );
};

const SplitDropButton: React.FC<{ groupId: string; onClick: () => void }> = ({ groupId, onClick }) => {
  const { setNodeRef, isOver } = useDroppable({ id: splitDropKey(groupId) });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={[
        'rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800',
        isOver ? 'bg-blue-100 dark:bg-blue-900/30' : '',
      ].join(' ')}
      onClick={onClick}
      title="向右拆分（也可把标签拖到这里形成分屏）"
    >
      拆分
    </button>
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
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
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

const decodeBase64ToUtf8 = (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
};

const decodeBase64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

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
    lower.endsWith('.json') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.rs') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.css') ||
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
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  if (c === p) return false;
  return c.startsWith(`${p}/`);
};

export const WorkstudioView: React.FC = () => {
  const { workstudioId } = getViewWindowParams();
  const editorByGroupRef = useRef(
    new Map<string, import('monaco-editor').editor.IStandaloneCodeEditor>()
  );
  const filePaletteInputRef = useRef<HTMLInputElement | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState<number | null>(null);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalFitRef = useRef<FitAddon | null>(null);

  const [ws, setWs] = useState<Workstudio | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsLoading, setWsLoading] = useState(false);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [entriesByDir, setEntriesByDir] = useState<Record<string, DirEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [groups, setGroups] = useState<EditorGroup[]>(() => [
    { id: 'g-0', openFileIds: [], activeFileId: null, weight: 1 },
  ]);
  const [focusedGroupId, setFocusedGroupId] = useState<string>('g-0');
  const [contextMenu, setContextMenu] = useState<
    | { visible: true; x: number; y: number; kind: 'root'; folder: string }
    | { visible: true; x: number; y: number; kind: 'blank' }
    | null
  >(null);
  const [tabMenu, setTabMenu] = useState<
    | { visible: true; x: number; y: number; path: string }
    | null
  >(null);

  const [filePaletteOpen, setFilePaletteOpen] = useState(false);
  const [filePaletteQuery, setFilePaletteQuery] = useState('');
  const [filePaletteResults, setFilePaletteResults] = useState<string[]>([]);
  const [filePaletteIndex, setFilePaletteIndex] = useState(0);

  const saveStateTimerRef = useRef<number | null>(null);
  const groupRowRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{
    dragging: boolean;
    index: number;
    startX: number;
    startLeft: number;
    startRight: number;
    containerWidth: number;
  } | null>(null);

  const focusedGroup = useMemo(
    () => groups.find((g) => g.id === focusedGroupId) ?? groups[0],
    [groups, focusedGroupId]
  );

  // Monaco 编辑器在 flex 布局变化（拆分/关闭组/拖拽/分屏比例调整）时偶发不会自动重算尺寸，
  // 导致右侧出现“白色死区”。这里在布局相关状态变化后，强制触发一次 layout。
  useEffect(() => {
    const aliveGroupIds = new Set(groups.map((g) => g.id));
    for (const key of editorByGroupRef.current.keys()) {
      if (!aliveGroupIds.has(key)) {
        editorByGroupRef.current.delete(key);
      }
    }

    let raf2: number | null = null;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        for (const [groupId, editor] of editorByGroupRef.current.entries()) {
          if (!aliveGroupIds.has(groupId)) continue;
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
  }, [groups, terminalOpen]);
  const rootFolders = useMemo(() => {
    if (!ws) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of ws.folders) {
      const nf = normalizePath(f);
      if (!nf || seen.has(nf)) continue;
      seen.add(nf);
      out.push(f);
    }
    const isSystem = (p: string) => normalizePath(p).includes('/.tauri-ai/workstudios/');
    const hasUserRoot = out.some((f) => !isSystem(f));
    const pruned = hasUserRoot ? out.filter((f) => !isSystem(f)) : out;
    // Hide roots nested under the main folder (redundant).
    return pruned.filter((f) => f === ws.mainFolder || !isSubpath(f, ws.mainFolder));
  }, [ws]);

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
    async (path: string) => {
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setGroups((prev) =>
          prev.map((g) => {
            if (g.id !== focusedGroupId) return g;
            const nextIds = g.openFileIds.includes(existing.id)
              ? g.openFileIds
              : [...g.openFileIds, existing.id];
            return { ...g, openFileIds: nextIds, activeFileId: existing.id };
          })
        );
        return;
      }
      const file = await invoke<{ filename: string; mime: string; base64: string; size: number }>(
        'read_local_file_base64',
        { path }
      );
      const id = path;
      const kind = fileKindFor(path, file.mime);
      const content = kind === 'text' ? decodeBase64ToUtf8(file.base64) : undefined;
      const next: OpenFile = {
        id,
        title: file.filename,
        path,
        kind,
        mime: file.mime,
        size: file.size,
        content,
        originalContent: content,
        dirty: false,
        dataUrl: kind === 'image' ? `data:${file.mime};base64,${file.base64}` : undefined,
        base64: file.base64,
      };
      setOpenFiles((prev) => [...prev, next]);
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== focusedGroupId) return g;
          return { ...g, openFileIds: [...g.openFileIds, id], activeFileId: id };
        })
      );
    },
    [openFiles, focusedGroupId]
  );

  const closeFileInGroup = useCallback((groupId: string, fileId: string) => {
    setGroups((prev) => {
      const nextGroupsPre = prev.map((g) => {
        if (g.id !== groupId) return g;
        const nextIds = g.openFileIds.filter((id) => id !== fileId);
        const nextActive = g.activeFileId === fileId ? nextIds[0] ?? null : g.activeFileId;
        return { ...g, openFileIds: nextIds, activeFileId: nextActive };
      });

      const removedIndex = nextGroupsPre.findIndex((g) => g.id === groupId);
      const removedWeight =
        removedIndex >= 0 && nextGroupsPre[removedIndex]?.openFileIds.length === 0
          ? nextGroupsPre[removedIndex]!.weight || 1
          : 0;
      let nextGroups = pruneEmptyGroups(nextGroupsPre);
      if (removedWeight > 0 && nextGroups.length < nextGroupsPre.length) {
        nextGroups = redistributeWeightOnRemove(nextGroups, removedIndex, removedWeight);
      }
      nextGroups = normalizeGroupWeights(nextGroups);

      setOpenFiles((prevFiles) => {
        const stillUsed = nextGroups.some((g) => g.openFileIds.includes(fileId));
        return stillUsed ? prevFiles : prevFiles.filter((f) => f.id !== fileId);
      });

      // Keep focus on existing group.
      if (!nextGroups.some((g) => g.id === focusedGroupId)) {
        setFocusedGroupId(nextGroups[0]?.id ?? 'g-0');
      }
      return nextGroups;
    });
  }, [focusedGroupId]);

  const splitGroupToRight = useCallback((groupId: string, fileId?: string) => {
    const newId = `g-${Date.now()}`;
    setGroups((prev) => {
      const idx = prev.findIndex((g) => g.id === groupId);
      if (idx < 0) return prev;
      const source = prev[idx]!;
      const sourceWeight = source.weight || 1;
      const leftWeight = Math.max(0.2, sourceWeight / 2);
      const rightWeight = Math.max(0.2, sourceWeight - leftWeight);
      const nextSource = { ...source, weight: leftWeight };
      const next: EditorGroup = {
        id: newId,
        openFileIds: fileId ? [fileId] : source.activeFileId ? [source.activeFileId] : [],
        activeFileId: fileId ?? source.activeFileId ?? null,
        weight: rightWeight,
      };
      const out = [...prev];
      out[idx] = nextSource;
      out.splice(idx + 1, 0, next);
      return out;
    });
    setFocusedGroupId(newId);
  }, []);

  const startResize = useCallback(
    (index: number, startClientX: number) => {
      const container = groupRowRef.current;
      if (!container) return;
      const left = groups[index];
      const right = groups[index + 1];
      if (!left || !right) return;
      const rect = container.getBoundingClientRect();
      resizeRef.current = {
        dragging: true,
        index,
        startX: startClientX,
        startLeft: left.weight || 1,
        startRight: right.weight || 1,
        containerWidth: rect.width || 1,
      };
    },
    [groups]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current?.dragging) return;
      const { index, startX, startLeft, startRight, containerWidth } = resizeRef.current;
      const dx = e.clientX - startX;
      const delta = dx / containerWidth;
      const min = 0.1;
      let leftW = startLeft + delta;
      let rightW = startRight - delta;
      if (leftW < min) {
        rightW -= min - leftW;
        leftW = min;
      }
      if (rightW < min) {
        leftW -= min - rightW;
        rightW = min;
      }
      setGroups((prev) => {
        if (!prev[index] || !prev[index + 1]) return prev;
        const out = [...prev];
        out[index] = { ...out[index]!, weight: leftW };
        out[index + 1] = { ...out[index + 1]!, weight: rightW };
        return normalizeGroupWeights(out);
      });
    };
    const onUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current.dragging = false;
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const saveFile = useCallback(
    async (fileId: string, editor: import('monaco-editor').editor.IStandaloneCodeEditor | null) => {
      const file = openFiles.find((f) => f.id === fileId);
      if (!file) return;
      if (file.kind !== 'text') return;
      const latest = editor?.getValue() ?? file.content ?? '';
      await invoke('write_local_text_file', { path: file.path, content: latest });
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.id === file.id ? { ...f, content: latest, originalContent: latest, dirty: false } : f
        )
      );
    },
    [openFiles]
  );

  const saveFocusedFile = useCallback(async () => {
    const fileId = focusedGroup?.activeFileId ?? null;
    if (!fileId) return;
    const editor = focusedGroup ? editorByGroupRef.current.get(focusedGroup.id) ?? null : null;
    await saveFile(fileId, editor);
  }, [focusedGroup, saveFile]);

  const ensureTerminalSession = useCallback(async () => {
    if (!ws) return null;
    if (terminalSessionId) return terminalSessionId;
    const sid = await invoke<number>('workstudio_terminal_create', {
      workstudioId: ws.id,
      workdir: ws.mainFolder,
    });
    setTerminalSessionId(sid);
    return sid;
  }, [ws, terminalSessionId]);

  const closeTerminalSession = useCallback(async () => {
    if (!ws) return;
    if (!terminalSessionId) return;
    try {
      await invoke('workstudio_terminal_close', { workstudioId: ws.id, sessionId: terminalSessionId });
    } finally {
      setTerminalSessionId(null);
      terminalRef.current?.reset();
    }
  }, [ws, terminalSessionId]);

  useEffect(() => {
    if (!ws) return;
    if (!terminalContainerRef.current) return;
    if (terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 3000,
      convertEol: true,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: document.documentElement.classList.contains('dark')
        ? { background: '#0b0f19', foreground: '#e5e7eb' }
        : { background: '#ffffff', foreground: '#111827' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalContainerRef.current);
    fit.fit();
    term.focus();

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener('resize', onResize);

    terminalRef.current = term;
    terminalFitRef.current = fit;

    const disposeData = term.onData((data) => {
      if (!ws) return;
      void ensureTerminalSession().then((sid) => {
        if (!sid) return;
        return invoke('workstudio_terminal_write', { workstudioId: ws.id, sessionId: sid, chars: data });
      });
    });

    return () => {
      disposeData.dispose();
      window.removeEventListener('resize', onResize);
      term.dispose();
      terminalRef.current = null;
      terminalFitRef.current = null;
    };
  }, [ws, ensureTerminalSession]);

  useEffect(() => {
    if (!terminalOpen) return;
    if (!ws) return;
    void ensureTerminalSession().then(() => {
      // Let layout settle (panel height -> fit)
      window.setTimeout(() => {
        try {
          terminalFitRef.current?.fit();
          terminalRef.current?.focus();
        } catch {
          // ignore
        }
      }, 30);
    });
  }, [terminalOpen, ws, ensureTerminalSession]);

  useEffect(() => {
    if (!terminalOpen) return;
    if (!ws) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const sid = await ensureTerminalSession();
        if (!sid) return;
        const base64 = await invoke<string>('workstudio_terminal_read_base64', {
          workstudioId: ws.id,
          sessionId: sid,
          timeoutMs: 80,
          maxBytes: 64 * 1024,
        });
        if (cancelled) return;
        if (!base64) return;
        const bytes = decodeBase64ToBytes(base64);
        terminalRef.current?.write(bytes);
      } catch {
        // ignore
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 250);
      }
    };

    timer = window.setTimeout(tick, 50);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [terminalOpen, ws, ensureTerminalSession]);

  const handleEditorMountForGroup = useCallback(
    (groupId: string): OnMount =>
      (editor, monaco) => {
        setupMonaco(monaco);
        editorByGroupRef.current.set(groupId, editor);

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void saveFocusedFile();
        });
        editor.onDidFocusEditorWidget(() => setFocusedGroupId(groupId));
      },
    [saveFocusedFile]
  );

  const editorTheme = useMemo(() => {
    return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const moveTab = useCallback(
    (fromGroupId: string, toGroupId: string, fileId: string, toIndex?: number) => {
      setGroups((prev) => {
        const fromIdx = prev.findIndex((g) => g.id === fromGroupId);
        const toIdx = prev.findIndex((g) => g.id === toGroupId);
        if (fromIdx < 0 || toIdx < 0) return prev;
        const from = prev[fromIdx]!;
        const to = prev[toIdx]!;
        const nextFromIds = from.openFileIds.filter((id) => id !== fileId);
        const nextToIds = to.openFileIds.includes(fileId)
          ? to.openFileIds
          : (() => {
              const insertAt = typeof toIndex === 'number' ? Math.max(0, Math.min(toIndex, to.openFileIds.length)) : to.openFileIds.length;
              const out = [...to.openFileIds];
              out.splice(insertAt, 0, fileId);
              return out;
            })();
        const nextFromActive = from.activeFileId === fileId ? nextFromIds[0] ?? null : from.activeFileId;
        const nextToActive = fileId;
        let out = [...prev];
        out[fromIdx] = { ...from, openFileIds: nextFromIds, activeFileId: nextFromActive };
        out[toIdx] = { ...to, openFileIds: nextToIds, activeFileId: nextToActive };

        // Auto-close empty groups (except keep one).
        const removedWeight =
          out[fromIdx]?.openFileIds.length === 0 && out.length > 1 ? out[fromIdx]!.weight || 1 : 0;
        const removedIndex = fromIdx;
        out = pruneEmptyGroups(out);
        if (removedWeight > 0 && out.length < prev.length) {
          out = redistributeWeightOnRemove(out, removedIndex, removedWeight);
        }
        out = normalizeGroupWeights(out);
        return out;
      });
      setFocusedGroupId(toGroupId);
    },
    []
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const active = String(event.active.id);
      const over = event.over ? String(event.over.id) : null;
      const a = parseTabKey(active);
      if (!a || !over) return;

      if (over.startsWith('tab:')) {
        const b = parseTabKey(over);
        if (!b) return;
        if (a.groupId === b.groupId) {
          setGroups((prev) =>
            prev.map((g) => {
              if (g.id !== a.groupId) return g;
              const oldIndex = g.openFileIds.indexOf(a.fileId);
              const newIndex = g.openFileIds.indexOf(b.fileId);
              if (oldIndex < 0 || newIndex < 0) return g;
              return { ...g, openFileIds: arrayMove(g.openFileIds, oldIndex, newIndex) };
            })
          );
          return;
        }
        const toIndex = groups.find((g) => g.id === b.groupId)?.openFileIds.indexOf(b.fileId);
        moveTab(a.groupId, b.groupId, a.fileId, typeof toIndex === 'number' && toIndex >= 0 ? toIndex : undefined);
        return;
      }

      if (over.startsWith('drop:')) {
        const toGroupId = over.slice('drop:'.length);
        if (toGroupId) moveTab(a.groupId, toGroupId, a.fileId);
        return;
      }

      if (over.startsWith('split:')) {
        const toGroupId = over.slice('split:'.length);
        // Create a new group to the right of toGroupId with this tab
        // (also remove from its original group)
        setGroups((prev) => {
          const nextPre = prev.map((g) => {
            if (g.id !== a.groupId) return g;
            const nextIds = g.openFileIds.filter((id) => id !== a.fileId);
            const nextActive = g.activeFileId === a.fileId ? nextIds[0] ?? null : g.activeFileId;
            return { ...g, openFileIds: nextIds, activeFileId: nextActive };
          });
          const removedIndex = nextPre.findIndex((g) => g.id === a.groupId);
          const removedWeight =
            removedIndex >= 0 && nextPre[removedIndex]?.openFileIds.length === 0 ? nextPre[removedIndex]!.weight || 1 : 0;
          let next = pruneEmptyGroups(nextPre);
          if (removedWeight > 0 && next.length < nextPre.length) {
            next = redistributeWeightOnRemove(next, removedIndex, removedWeight);
          }
          return normalizeGroupWeights(next);
        });
        splitGroupToRight(toGroupId, a.fileId);
      }
    },
    [groups, moveTab, splitGroupToRight]
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

  // Cmd/Ctrl+P: file search palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'p') {
        e.preventDefault();
        setFilePaletteOpen(true);
        window.setTimeout(() => filePaletteInputRef.current?.focus(), 0);
      }
      if (key === 'escape') {
        setFilePaletteOpen(false);
        setFilePaletteQuery('');
        setFilePaletteResults([]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
    let cancelled = false;
    (async () => {
      try {
        const state = await invoke<WorkstudioUiState | null>('get_workstudio_ui_state', {
          workstudioId: ws.id,
        });
        if (cancelled) return;
        if (!state) return;

        const legacyPaths = Array.isArray(state.openFiles) ? state.openFiles : [];
        const groupsFromState = Array.isArray(state.groups) ? state.groups : [];
        const paths = groupsFromState.length
          ? Array.from(new Set(groupsFromState.flatMap((g) => g.openFiles ?? [])))
          : legacyPaths;
        if (paths.length === 0) return;

        const results = await Promise.all(
          paths.map(async (path) => {
            try {
              const file = await invoke<{ filename: string; mime: string; base64: string; size: number }>(
                'read_local_file_base64',
                { path }
              );
              const id = path;
              const kind = fileKindFor(path, file.mime);
              const content = kind === 'text' ? decodeBase64ToUtf8(file.base64) : undefined;
              const next: OpenFile = {
                id,
                title: file.filename,
                path,
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

        setOpenFiles((prev) => {
          const byPath = new Map(prev.map((f) => [f.path, f] as const));
          for (const f of files) {
            if (!byPath.has(f.path)) byPath.set(f.path, f);
          }
          return Array.from(byPath.values());
        });

        if (groupsFromState.length) {
          const nextGroups: EditorGroup[] = groupsFromState
            .map((g, idx) => {
              const openIds = (g.openFiles ?? []).filter((p) => files.some((f) => f.id === p));
              const active = g.activeFile && openIds.includes(g.activeFile) ? g.activeFile : openIds[0] ?? null;
              const weight = typeof g.weight === 'number' && Number.isFinite(g.weight) ? g.weight : 1;
              return { id: `g-${idx}`, openFileIds: openIds, activeFileId: active, weight };
            })
            .filter((g) => g.openFileIds.length > 0);

          if (nextGroups.length) {
            setGroups(normalizeGroupWeights(nextGroups));
            const idx = typeof state.focusedGroupIndex === 'number' ? state.focusedGroupIndex : 0;
            setFocusedGroupId(nextGroups[Math.min(Math.max(0, idx), nextGroups.length - 1)]!.id);
          } else {
            setGroups([{ id: 'g-0', openFileIds: files.map((f) => f.id), activeFileId: files[0].id, weight: 1 }]);
            setFocusedGroupId('g-0');
          }
        } else if (state.splitOpen && (state.activeRightFile || state.activeLeftFile)) {
          const openIds = files.map((f) => f.id);
          const leftActive = state.activeLeftFile && openIds.includes(state.activeLeftFile) ? state.activeLeftFile : openIds[0] ?? null;
          const rightActive = state.activeRightFile && openIds.includes(state.activeRightFile) ? state.activeRightFile : openIds[0] ?? null;
          setGroups([
            { id: 'g-0', openFileIds: openIds, activeFileId: leftActive, weight: 1 },
            { id: 'g-1', openFileIds: openIds, activeFileId: rightActive, weight: 1 },
          ]);
          setFocusedGroupId('g-0');
        } else {
          setGroups([{ id: 'g-0', openFileIds: files.map((f) => f.id), activeFileId: state.activeLeftFile ?? files[0].id, weight: 1 }]);
          setFocusedGroupId('g-0');
        }

        if (Array.isArray(state.expandedDirs) && state.expandedDirs.length) {
          const nextExpanded = new Set(state.expandedDirs);
          setExpandedDirs(nextExpanded);
          for (const dir of nextExpanded) {
            void listDir(dir);
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    if (saveStateTimerRef.current) window.clearTimeout(saveStateTimerRef.current);
    saveStateTimerRef.current = window.setTimeout(() => {
      const state: WorkstudioUiState = {
        openFiles: openFiles.map((f) => f.path),
        groups: groups.map((g) => ({
          openFiles: g.openFileIds,
          activeFile: g.activeFileId ?? undefined,
          weight: g.weight,
        })),
        focusedGroupIndex: Math.max(0, groups.findIndex((g) => g.id === focusedGroupId)),
        expandedDirs: Array.from(expandedDirs),
      };
      void invoke('set_workstudio_ui_state', { workstudioId: ws.id, state }).catch(() => {});
    }, 500);
    return () => {
      if (saveStateTimerRef.current) window.clearTimeout(saveStateTimerRef.current);
    };
  }, [ws, openFiles, groups, focusedGroupId, expandedDirs]);

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
    let unlisten: (() => void) | null = null;
    void listen('menu:open_file', async () => {
      try {
        await openFileFromDialog();
      } catch (error) {
        console.error('Workstudio open file failed:', error);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      unlisten?.();
    };
  }, [openFileFromDialog]);

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
                const isActive = openFiles.some((f) => f.path === entry.path);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    data-ws-node="1"
                    onClick={() => void openFileAtPath(entry.path)}
                    className={[
                      'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs',
                      isActive
                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
                    ].join(' ')}
                    style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                    title={entry.path}
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
              编辑组: {groups.length}{' '}
              <span className="text-gray-400">
                （聚焦 {Math.max(1, groups.findIndex((g) => g.id === focusedGroupId) + 1)}）
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

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <div ref={groupRowRef} className="flex min-h-0 flex-1 flex-row overflow-hidden">
            {groups.map((group, idx) => {
              const groupActive = group.activeFileId
                ? openFiles.find((f) => f.id === group.activeFileId) ?? null
                : null;
              const isFocused = group.id === focusedGroupId;
              const sortableItems = group.openFileIds.map((fileId) => tabKey(group.id, fileId));
              return (
                <React.Fragment key={group.id}>
                  {idx > 0 && (
                    <div
                      className="w-1 cursor-col-resize bg-transparent hover:bg-blue-200/60 dark:hover:bg-blue-900/40"
                      onMouseDown={(e) => startResize(idx - 1, e.clientX)}
                      title="拖拽调整分屏比例"
                    />
                  )}
                  <div
                    className={[
                      'flex min-w-0 flex-col overflow-hidden',
                      isFocused ? 'bg-blue-50/30 dark:bg-blue-950/10' : '',
                    ].join(' ')}
                    style={{ flexGrow: group.weight, flexBasis: 0 }}
                    onMouseDown={() => setFocusedGroupId(group.id)}
                  >
                    <GroupDropZone groupId={group.id}>
                      <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 py-1 dark:border-gray-800 dark:bg-gray-950">
                        <SortableContext items={sortableItems} strategy={horizontalListSortingStrategy}>
                          {group.openFileIds.length === 0 ? (
                            <div className="px-2 py-1 text-xs text-gray-400">未打开文件</div>
                          ) : (
                            group.openFileIds.map((fileId) => {
                              const file = openFiles.find((f) => f.id === fileId);
                              if (!file) return null;
                              const active = file.id === group.activeFileId;
                              const title = `${file.title}${file.dirty ? ' *' : ''}`;
                              return (
                                <SortableTab
                                  key={`${group.id}:${file.id}`}
                                  id={tabKey(group.id, file.id)}
                                  active={active}
                                  title={title}
                                  onClick={() => {
                                    setGroups((prev) =>
                                      prev.map((g) =>
                                        g.id === group.id ? { ...g, activeFileId: file.id } : g
                                      )
                                    );
                                    setFocusedGroupId(group.id);
                                  }}
                                  onClose={() => closeFileInGroup(group.id, file.id)}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setTabMenu({ visible: true, x: e.clientX, y: e.clientY, path: file.path });
                                  }}
                                />
                              );
                            })
                          )}
                        </SortableContext>

                        <div className="ml-auto flex items-center gap-2 px-1">
                          <SplitDropButton
                            groupId={group.id}
                            onClick={() => splitGroupToRight(group.id, group.activeFileId ?? undefined)}
                          />
                      <button
                        type="button"
                        disabled={groups.length <= 1}
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                        onClick={() => {
                          setGroups((prev) => {
                            const removedIndex = prev.findIndex((g) => g.id === group.id);
                            if (removedIndex < 0) return prev;

                            const removedWeight = prev[removedIndex]?.weight || 1;
                            let nextGroups = prev.filter((g) => g.id !== group.id);
                            if (!nextGroups.length) {
                              nextGroups = [
                                { id: 'g-0', openFileIds: [], activeFileId: null, weight: 1 },
                              ];
                            } else {
                              nextGroups = redistributeWeightOnRemove(
                                nextGroups,
                                removedIndex,
                                removedWeight
                              );
                              nextGroups = normalizeGroupWeights(nextGroups);
                            }

                            setOpenFiles((prevFiles) => {
                              const used = new Set(nextGroups.flatMap((g) => g.openFileIds));
                              return prevFiles.filter((f) => used.has(f.id));
                            });

                            const fallback =
                              nextGroups[Math.min(removedIndex, nextGroups.length - 1)]?.id ??
                              nextGroups[0]?.id ??
                              'g-0';
                            setFocusedGroupId((curr) => {
                              if (curr === group.id) return fallback;
                              return nextGroups.some((g) => g.id === curr) ? curr : fallback;
                            });

                            return nextGroups;
                          });
                        }}
                        title="关闭编辑组"
                      >
                        关闭组
                      </button>
                        </div>
                      </div>
                    </GroupDropZone>

                  <div className="min-h-0 flex-1">
                    {groupActive ? (
                      groupActive.kind === 'text' ? (
                        <Editor
                          path={groupActive.path}
                          language={languageForPath(groupActive.path)}
                          value={groupActive.content ?? ''}
                          onMount={handleEditorMountForGroup(group.id)}
                          onChange={(value) => {
                            const nextValue = value ?? '';
                            setOpenFiles((prev) =>
                              prev.map((file) =>
                                file.id === groupActive.id
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
                                {groupActive.title}
                              </div>
                              <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                {groupActive.kind} · {groupActive.mime} · {groupActive.size} bytes
                              </div>
                            </div>
                            <button
                              type="button"
                              className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                              onClick={() => void openPath(groupActive.path)}
                              title="在系统默认应用中打开"
                            >
                              在系统中打开
                            </button>
                          </div>

                          {groupActive.kind === 'image' && groupActive.dataUrl ? (
                            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
                              <img
                                src={groupActive.dataUrl}
                                alt={groupActive.title}
                                className="max-h-[70vh] max-w-full rounded"
                              />
                            </div>
                          ) : groupActive.kind === 'pdf' && groupActive.base64 ? (
                            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
                              <iframe
                                title={groupActive.title}
                                className="h-full w-full"
                                src={`data:application/pdf;base64,${groupActive.base64}`}
                              />
                            </div>
                          ) : (
                            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200">
                              <div className="font-medium">二进制预览（前 256 bytes）</div>
                              <div className="mt-2 font-mono break-words">
                                {groupActive.base64
                                  ? bytesToHexPreview(decodeBase64ToBytes(groupActive.base64), 256)
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
                  </div>
                </React.Fragment>
              );
            })}
          </div>
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
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">快捷键：Ctrl/Cmd + P</div>
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
                onClick={() => void ensureTerminalSession()}
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
                className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                onClick={() => setTerminalOpen(false)}
                title="关闭面板"
              >
                关闭
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <div ref={terminalContainerRef} className="h-full w-full" />
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
                const p = tabMenu.path;
                setTabMenu(null);
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
