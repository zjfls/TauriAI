import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  ListTree,
  RefreshCw,
  X,
} from 'lucide-react';
import type { LspServerStatus, TerminalScope, Workstudio, WorkstudioUiState } from '../../types';
import { SHORTCUT_ACTIONS, detectShortcutPlatform, normalizeKeybindingString } from '../../shortcuts';
import {
  astDocumentSymbols,
  lspDetectServer,
  lspEnsureServer,
  lspNotify,
  lspRequest,
  lspShutdownLanguage,
  lspStatus,
} from '../../services';
import { useConfigStore } from '../../stores/configStore';
import { useTerminalSessionStore } from '../../stores/terminalSessionStore';
import { type WindowPane, useWindowLayoutStore } from '../../stores/windowLayoutStore';
import { useRemoteDragSplitPreview } from '../../hooks/useRemoteDragSplitPreview';
import { useDragGhostSession } from '../../hooks/useDragGhostSession';
import { focusMainWindow, getViewWindowParams } from '../../utils/viewWindow';
import { setupMonaco } from '../../utils/monaco';
import { attachMonacoLspBridge } from '../../utils/monacoLspBridge';
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

type NavLocation = {
  tabId: string;
  line?: number | null;
  column?: number | null;
};

type PaneNavHistory = {
  back: NavLocation[];
  forward: NavLocation[];
};

type OutlineRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

type OutlineItem = {
  id: string;
  name: string;
  kind: string;
  detail: string;
  range: OutlineRange;
  selectionLine: number;
  selectionColumn: number;
  children: OutlineItem[];
};

const DEFAULT_EDITOR_FONT_SIZE = 13;
const MIN_EDITOR_FONT_SIZE = 10;
const MAX_EDITOR_FONT_SIZE = 28;

const clampEditorFontSize = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_EDITOR_FONT_SIZE;
  const rounded = Math.round(value);
  return Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, rounded));
};

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
  pinnedWhileDragging?: boolean;
  onClick: () => void;
  onClose: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}> = ({ id, active, title, pinnedWhileDragging, onClick, onClose, onContextMenu }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const effectiveTransform = pinnedWhileDragging && isDragging ? null : transform;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(effectiveTransform),
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
      data-workstudio-tab-id={id}
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
  if (lower.endsWith('.lua')) return 'lua';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'shell';
  return 'plaintext';
};

const AUTO_DETECT_LSP_LANGUAGES = ['rust', 'python', 'cpp', 'c', 'lua'] as const;
const isAutoDetectableLspLanguage = (languageId: string) =>
  AUTO_DETECT_LSP_LANGUAGES.includes(languageId as (typeof AUTO_DETECT_LSP_LANGUAGES)[number]);
const AUTO_DETECT_LSP_FILE_QUERIES: Record<string, string[]> = {
  rust: ['.rs', 'cargo.toml'],
  python: ['.py', 'pyproject.toml', 'requirements.txt'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.ixx', '.cppm'],
  c: ['.c'],
  lua: ['.lua'],
};

const escapeCssSelectorValue = (value: string): string => {
  const cssAny = (globalThis as any).CSS;
  if (cssAny && typeof cssAny.escape === 'function') return cssAny.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

const basename = (p: string) => {
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length === 0 ? p : segments[segments.length - 1];
};

const isAutoDetectMatchForLanguage = (languageId: string, filePath: string): boolean => {
  const lower = String(filePath ?? '').toLowerCase();
  if (!lower) return false;
  const name = basename(lower);
  switch (languageId) {
    case 'rust':
      return lower.endsWith('.rs') || name === 'cargo.toml';
    case 'python':
      return (
        lower.endsWith('.py') ||
        name === 'pyproject.toml' ||
        name === 'requirements.txt' ||
        name === 'setup.py'
      );
    case 'cpp':
      return (
        lower.endsWith('.cc') ||
        lower.endsWith('.cpp') ||
        lower.endsWith('.cxx') ||
        lower.endsWith('.hpp') ||
        lower.endsWith('.hh') ||
        lower.endsWith('.hxx') ||
        lower.endsWith('.ixx') ||
        lower.endsWith('.cppm')
      );
    case 'c':
      return lower.endsWith('.c');
    case 'lua':
      return lower.endsWith('.lua');
    default:
      return false;
  }
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

const isAbsoluteFsPath = (input: string) => {
  const p = normalizeFsPath(input);
  if (!p) return false;
  if (/^[A-Za-z]:\//.test(p)) return true;
  if (p.startsWith('//')) return true;
  return p.startsWith('/');
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

const clampOutlineLine = (line: number) => Math.max(1, Number.isFinite(line) ? Math.floor(line) : 1);
const clampOutlineColumn = (column: number) => Math.max(1, Number.isFinite(column) ? Math.floor(column) : 1);

const toOutlineRangeFromLsp = (range: any): OutlineRange => {
  const startLine = clampOutlineLine(Number(range?.start?.line ?? 0) + 1);
  const startColumn = clampOutlineColumn(Number(range?.start?.character ?? 0) + 1);
  const endLine = clampOutlineLine(Number(range?.end?.line ?? range?.start?.line ?? 0) + 1);
  const endColumn = clampOutlineColumn(Number(range?.end?.character ?? range?.start?.character ?? 0) + 1);
  return { startLine, startColumn, endLine, endColumn };
};

const lspSymbolKindToLabel = (kind: any): string => {
  const k = Number(kind ?? 0);
  switch (k) {
    case 5: return 'class';
    case 6: return 'method';
    case 7: return 'property';
    case 8: return 'field';
    case 9: return 'constructor';
    case 10: return 'enum';
    case 11: return 'interface';
    case 12: return 'function';
    case 13: return 'variable';
    case 14: return 'constant';
    case 22: return 'enum_member';
    case 23: return 'struct';
    case 25: return 'operator';
    case 26: return 'type_param';
    default: return 'symbol';
  }
};

const lspDocumentSymbolsToOutline = (result: any): OutlineItem[] => {
  if (!Array.isArray(result)) return [];

  const fromDocumentSymbol = (node: any, parentKey: string, index: number): OutlineItem | null => {
    const name = String(node?.name ?? '').trim();
    const rangeRaw = node?.range;
    if (!name || !rangeRaw) return null;
    const range = toOutlineRangeFromLsp(rangeRaw);
    const selectionRaw = node?.selectionRange ?? rangeRaw;
    const selection = toOutlineRangeFromLsp(selectionRaw);
    const id = `${parentKey}:${index}:${name}:${selection.startLine}:${selection.startColumn}`;
    const childrenRaw = Array.isArray(node?.children) ? node.children : [];
    const children = childrenRaw
      .map((child: any, childIdx: number) => fromDocumentSymbol(child, id, childIdx))
      .filter(Boolean) as OutlineItem[];
    return {
      id,
      name,
      kind: lspSymbolKindToLabel(node?.kind),
      detail: typeof node?.detail === 'string' ? node.detail : '',
      range,
      selectionLine: selection.startLine,
      selectionColumn: selection.startColumn,
      children,
    };
  };

  const fromSymbolInformation = (node: any, index: number): OutlineItem | null => {
    const name = String(node?.name ?? '').trim();
    const rangeRaw = node?.location?.range;
    if (!name || !rangeRaw) return null;
    const range = toOutlineRangeFromLsp(rangeRaw);
    return {
      id: `si:${index}:${name}:${range.startLine}:${range.startColumn}`,
      name,
      kind: lspSymbolKindToLabel(node?.kind),
      detail: '',
      range,
      selectionLine: range.startLine,
      selectionColumn: range.startColumn,
      children: [],
    };
  };

  const looksLikeSymbolInformation = result.some((item) => item && typeof item === 'object' && 'location' in item);
  if (looksLikeSymbolInformation) {
    return result
      .map((node, index) => fromSymbolInformation(node, index))
      .filter(Boolean) as OutlineItem[];
  }

  return result
    .map((node, index) => fromDocumentSymbol(node, 'ds', index))
    .filter(Boolean) as OutlineItem[];
};

const astSymbolsToOutline = (symbols: any, parentKey = 'ast'): OutlineItem[] => {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((node: any, index: number) => {
      const name = String(node?.name ?? '').trim();
      if (!name) return null;
      const range = toOutlineRangeFromLsp(node?.range ?? null);
      const selection = toOutlineRangeFromLsp(node?.selectionRange ?? node?.range ?? null);
      const id = `${parentKey}:${index}:${name}:${selection.startLine}:${selection.startColumn}`;
      const children = astSymbolsToOutline(node?.children ?? [], id);
      return {
        id,
        name,
        kind: String(node?.kind ?? 'symbol').trim() || 'symbol',
        detail: '',
        range,
        selectionLine: selection.startLine,
        selectionColumn: selection.startColumn,
        children,
      } as OutlineItem;
    })
    .filter(Boolean) as OutlineItem[];
};

const countOutlineItems = (items: OutlineItem[]): number => {
  let total = 0;
  const walk = (nodes: OutlineItem[]) => {
    for (const node of nodes) {
      total += 1;
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(items);
  return total;
};

export const WorkstudioView: React.FC<{ workstudioId?: string | null }> = ({ workstudioId: workstudioIdProp }) => {
  const { workstudioId: workstudioIdFromUrl, filePath, line, column, endLine, endColumn, standalone } = getViewWindowParams();
  const workstudioId = (workstudioIdProp ?? workstudioIdFromUrl ?? '').trim() || null;
  const isStandaloneWorkstudioWindow = Boolean(standalone);
  const editorByPaneRef = useRef(
    new Map<string, import('monaco-editor').editor.IStandaloneCodeEditor>()
  );
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const lspBridgeRef = useRef<{ dispose: () => void } | null>(null);
  const lspBridgeWorkstudioIdRef = useRef<string | null>(null);
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
  const codeIntelligenceConfig = useConfigStore((s) => s.config?.codeIntelligence);
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const backToMainShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'workstudio.backToMain');
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['workstudio.backToMain']
        : keyboardShortcuts?.windows?.['workstudio.backToMain'];
    const raw =
      userRaw ??
      (shortcutPlatform === 'mac' ? def?.defaultMac : def?.defaultWindows) ??
      (shortcutPlatform === 'mac' ? 'Cmd+Shift+M' : 'Ctrl+Shift+M');
    return (
      normalizeKeybindingString(String(raw || ''), shortcutPlatform) ??
      (shortcutPlatform === 'mac' ? 'Cmd+Shift+M' : 'Ctrl+Shift+M')
    );
  }, [keyboardShortcuts, shortcutPlatform]);
  const fileSearchShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'workstudio.fileSearch');
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['workstudio.fileSearch']
        : keyboardShortcuts?.windows?.['workstudio.fileSearch'];
    const raw = userRaw ?? (shortcutPlatform === 'mac' ? def?.defaultMac : def?.defaultWindows) ?? (shortcutPlatform === 'mac' ? 'Cmd+P' : 'Ctrl+P');
    return normalizeKeybindingString(String(raw || ''), shortcutPlatform) ?? (shortcutPlatform === 'mac' ? 'Cmd+P' : 'Ctrl+P');
  }, [keyboardShortcuts, shortcutPlatform]);
  const navigateBackShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'workstudio.navigateBack');
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['workstudio.navigateBack']
        : keyboardShortcuts?.windows?.['workstudio.navigateBack'];
    const raw = userRaw ?? (shortcutPlatform === 'mac' ? def?.defaultMac : def?.defaultWindows) ?? (shortcutPlatform === 'mac' ? 'Ctrl+-' : 'Alt+Left');
    return normalizeKeybindingString(String(raw || ''), shortcutPlatform) ?? (shortcutPlatform === 'mac' ? 'Ctrl+-' : 'Alt+Left');
  }, [keyboardShortcuts, shortcutPlatform]);
  const navigateForwardShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'workstudio.navigateForward');
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['workstudio.navigateForward']
        : keyboardShortcuts?.windows?.['workstudio.navigateForward'];
    const raw = userRaw ?? (shortcutPlatform === 'mac' ? def?.defaultMac : def?.defaultWindows) ?? (shortcutPlatform === 'mac' ? 'Ctrl+Shift+-' : 'Alt+Right');
    return normalizeKeybindingString(String(raw || ''), shortcutPlatform) ?? (shortcutPlatform === 'mac' ? 'Ctrl+Shift+-' : 'Alt+Right');
  }, [keyboardShortcuts, shortcutPlatform]);

  const navHistoryRef = useRef<Map<string, PaneNavHistory>>(new Map());
  const lastNavLocationRef = useRef<Map<string, NavLocation>>(new Map());
  const pendingNavRecordRef = useRef<Map<string, NavLocation>>(new Map());
  const suppressNavRecordDepthRef = useRef(0);
  const [navEpoch, setNavEpoch] = useState(0);

  const [navToast, setNavToast] = useState<string | null>(null);
  const navToastTimerRef = useRef<number | null>(null);
  const showNavToast = useCallback((message: string) => {
    setNavToast(message);
    if (navToastTimerRef.current) {
      window.clearTimeout(navToastTimerRef.current);
    }
    navToastTimerRef.current = window.setTimeout(() => {
      navToastTimerRef.current = null;
      setNavToast(null);
    }, 1400);
  }, []);

  useEffect(() => {
    return () => {
      if (navToastTimerRef.current) {
        window.clearTimeout(navToastTimerRef.current);
        navToastTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // 切换 Workstudio 时清空浏览历史，避免跨项目串联。
    navHistoryRef.current.clear();
    lastNavLocationRef.current.clear();
    pendingNavRecordRef.current.clear();
    setNavEpoch((v) => v + 1);
  }, [workstudioId]);

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
  const [editorFontSize, setEditorFontSize] = useState<number>(DEFAULT_EDITOR_FONT_SIZE);
  const editorFontSizeRef = useRef<number>(DEFAULT_EDITOR_FONT_SIZE);
  useEffect(() => {
    editorFontSizeRef.current = editorFontSize;
  }, [editorFontSize]);

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
  const lspStatusButtonRef = useRef<HTMLButtonElement | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [outlineSource, setOutlineSource] = useState<'lsp' | 'ast' | 'none'>('none');
  const [outlineActiveId, setOutlineActiveId] = useState<string | null>(null);
  const [outlineRefreshSeq, setOutlineRefreshSeq] = useState(0);
  const outlineRequestSeqRef = useRef(0);
  const [lspMenu, setLspMenu] = useState<
    | { visible: true; x: number; y: number }
    | null
  >(null);
  // Workstudio-scoped language filter for code intelligence:
  // - null: 自动（按项目文件检测）
  // - string[]: 手动指定启用语言
  const [wsEnabledLspLanguageIds, setWsEnabledLspLanguageIds] = useState<string[] | null>(null);
  const [projectScannedLspLanguageIds, setProjectScannedLspLanguageIds] = useState<string[]>([]);
  const openedAutoDetectableLspLanguageIds = useMemo(() => {
    const set = new Set<string>();
    for (const file of openFiles) {
      const lang = languageForPath(file.path);
      if (!isAutoDetectableLspLanguage(lang)) continue;
      set.add(lang);
    }
    const out = Array.from(set);
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }, [openFiles]);
  const projectAutoDetectedLspLanguageIds = useMemo(() => {
    const set = new Set<string>();
    for (const lang of projectScannedLspLanguageIds) {
      const normalized = String(lang ?? '').trim();
      if (!normalized) continue;
      set.add(normalized);
    }
    for (const lang of openedAutoDetectableLspLanguageIds) {
      const normalized = String(lang ?? '').trim();
      if (!normalized) continue;
      set.add(normalized);
    }
    const out = Array.from(set);
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }, [openedAutoDetectableLspLanguageIds, projectScannedLspLanguageIds]);
  const projectAutoDetectedLspLanguageFingerprint = useMemo(
    () => projectAutoDetectedLspLanguageIds.join('|'),
    [projectAutoDetectedLspLanguageIds]
  );

  const wsEnabledLspLanguageSetRef = useRef<Set<string> | null>(null);
  const projectAutoDetectedLspLanguageSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (wsEnabledLspLanguageIds === null) {
      wsEnabledLspLanguageSetRef.current = null;
      return;
    }
    wsEnabledLspLanguageSetRef.current = new Set(
      wsEnabledLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x))
    );
  }, [wsEnabledLspLanguageIds]);
  useEffect(() => {
    projectAutoDetectedLspLanguageSetRef.current = new Set(
      projectAutoDetectedLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x))
    );
  }, [projectAutoDetectedLspLanguageIds]);

  const isLspLanguageEnabledForWorkstudio = useCallback((languageId: string) => {
    const lang = String(languageId ?? '').trim();
    if (!lang) return false;
    const set = wsEnabledLspLanguageSetRef.current;
    if (!set) return projectAutoDetectedLspLanguageSetRef.current.has(lang); // auto
    return set.has(lang);
  }, []);
  const [lspStatuses, setLspStatuses] = useState<LspServerStatus[]>([]);
  const [lspEnsureErrors, setLspEnsureErrors] = useState<Record<string, string>>({});
  const lspEnsureErrorsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    lspEnsureErrorsRef.current = lspEnsureErrors;
  }, [lspEnsureErrors]);

  const isLspLanguageEnabledForBridge = useCallback(
    (languageId: string) => {
      const lang = String(languageId ?? '').trim();
      if (!lang) return false;
      if (!isLspLanguageEnabledForWorkstudio(lang)) return false;
      const err = lspEnsureErrorsRef.current?.[lang];
      if (err) return false;
      return true;
    },
    [isLspLanguageEnabledForWorkstudio]
  );

  const ensuredLspLangRef = useRef<Set<string>>(new Set());
  const [lspProgress, setLspProgress] = useState<
    Record<
      string,
      Record<
        string,
        {
          title: string;
          message?: string;
          percentage?: number;
          updatedAtMs: number;
        }
      >
    >
  >({});
  const [lspLogs, setLspLogs] = useState<Record<string, string[]>>({});
  const [lspLogExpanded, setLspLogExpanded] = useState<Record<string, boolean>>({});
  const [lspExited, setLspExited] = useState<Record<string, { code?: number | null; signal?: number | null; timestampMs: number }>>({});
  const [lspListenerReadyWsId, setLspListenerReadyWsId] = useState<string | null>(null);
  const [lspAutoConfigStatus, setLspAutoConfigStatus] = useState<'idle' | 'running' | 'done'>('idle');

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

  const activeTextFileInFocusedPane = useMemo(() => {
    const activeId = focusedPane?.activeTabId ?? null;
    if (!activeId) return null;
    const file = openFiles.find((f) => f.id === activeId) ?? null;
    if (!file || file.kind !== 'text') return null;
    return file;
  }, [focusedPane?.activeTabId, openFiles]);

  const activeTextLanguageId = useMemo(
    () => (activeTextFileInFocusedPane ? languageForPath(activeTextFileInFocusedPane.path) : ''),
    [activeTextFileInFocusedPane]
  );

  const outlineItemCount = useMemo(() => countOutlineItems(outlineItems), [outlineItems]);
  const outlineSourceLabel = outlineSource === 'lsp' ? 'LSP' : outlineSource === 'ast' ? 'AST' : '';

  useEffect(() => {
    setExplorerSelectedFilePath(activeFilePathInFocusedPane);
  }, [activeFilePathInFocusedPane]);

  useEffect(() => {
    setOutlineActiveId(null);
  }, [activeTextFileInFocusedPane?.id]);

  useEffect(() => {
    if (!outlineOpen) return;
    if (!isTauri()) {
      setOutlineItems([]);
      setOutlineSource('none');
      setOutlineError(null);
      setOutlineLoading(false);
      return;
    }

    const wsId = ws?.id ?? null;
    const activeFile = activeTextFileInFocusedPane;
    if (!wsId || !activeFile) {
      setOutlineItems([]);
      setOutlineSource('none');
      setOutlineError(null);
      setOutlineLoading(false);
      return;
    }

    let cancelled = false;
    const reqSeq = ++outlineRequestSeqRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        setOutlineLoading(true);
        setOutlineError(null);

        const languageId = activeTextLanguageId;
        const uri = toMonacoModelPath(activeFile.path);
        const canTryLsp = Boolean(
          codeIntelligenceConfig?.enabled &&
          isLspLanguageEnabledForBridge(languageId) &&
          uri.startsWith('file://')
        );

        let nextItems: OutlineItem[] = [];
        let nextSource: 'lsp' | 'ast' | 'none' = 'none';
        let lspError: string | null = null;

        if (canTryLsp) {
          try {
            const result = await lspRequest<any>({
              workstudioId: wsId,
              languageId,
              method: 'textDocument/documentSymbol',
              params: {
                textDocument: { uri },
              },
              timeoutMs: 8000,
            });
            const fromLsp = lspDocumentSymbolsToOutline(result);
            if (fromLsp.length > 0) {
              nextItems = fromLsp;
              nextSource = 'lsp';
            }
          } catch (e) {
            lspError = String(e);
          }
        }

        if (nextItems.length === 0) {
          try {
            const fromAst = astSymbolsToOutline(
              await astDocumentSymbols({
                languageId,
                text: activeFile.content ?? '',
              })
            );
            if (fromAst.length > 0) {
              nextItems = fromAst;
              nextSource = 'ast';
            }
          } catch {
            // ignore AST fallback errors (unsupported language is expected for many files)
          }
        }

        if (cancelled || reqSeq !== outlineRequestSeqRef.current) return;
        setOutlineItems(nextItems);
        setOutlineSource(nextSource);
        setOutlineActiveId((prev) => (prev && nextItems.some((item) => item.id === prev) ? prev : null));
        setOutlineError(nextItems.length === 0 ? lspError : null);
        setOutlineLoading(false);
      })();
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    outlineOpen,
    ws?.id,
    activeTextFileInFocusedPane?.id,
    activeTextFileInFocusedPane?.content,
    activeTextLanguageId,
    codeIntelligenceConfig?.enabled,
    isLspLanguageEnabledForBridge,
    outlineRefreshSeq,
  ]);

  // Monaco 编辑器在 flex 布局变化（拆分/关闭 Pane/拖拽/分屏比例调整）时偶发不会自动重算尺寸，
  // 导致右侧出现“白色死区”。这里在布局相关状态变化后，强制触发一次 layout。
  useEffect(() => {
    const alivePaneIds = new Set(resolvedPanes.map((p) => p.id));
    for (const key of editorByPaneRef.current.keys()) {
      if (!alivePaneIds.has(key)) {
        editorByPaneRef.current.delete(key);
      }
    }
    let navChanged = false;
    for (const key of navHistoryRef.current.keys()) {
      if (!alivePaneIds.has(key)) {
        navHistoryRef.current.delete(key);
        navChanged = true;
      }
    }
    if (navChanged) {
      setNavEpoch((v) => v + 1);
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

  const getPaneNavHistory = useCallback((paneId: string): PaneNavHistory => {
    const existing = navHistoryRef.current.get(paneId);
    if (existing) return existing;
    const next: PaneNavHistory = { back: [], forward: [] };
    navHistoryRef.current.set(paneId, next);
    return next;
  }, [navHistoryRef]);

  const isSameNavLocation = useCallback((a: NavLocation, b: NavLocation): boolean => {
    return (
      a.tabId === b.tabId &&
      (a.line ?? null) === (b.line ?? null) &&
      (a.column ?? null) === (b.column ?? null)
    );
  }, []);

  const isMeaningfulNavTransition = useCallback((from: NavLocation, to: NavLocation): boolean => {
    if (from.tabId !== to.tabId) return true;
    const toLine = typeof to.line === 'number' ? to.line : null;
    const toColumn = typeof to.column === 'number' ? to.column : null;
    if (toLine === null) return false;
    const fromLine = typeof from.line === 'number' ? from.line : null;
    const fromColumn = typeof from.column === 'number' ? from.column : null;
    if (fromLine !== toLine) return true;
    if (toColumn !== null && fromColumn !== toColumn) return true;
    return false;
  }, []);

  const getCurrentNavLocationForPane = useCallback((paneId: string): NavLocation | null => {
    const state = useWindowLayoutStore.getState();
    const pane = state.panes.find((p) => p.id === paneId) ?? null;
    if (!pane) return null;
    const activeId =
      pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
        ? pane.activeTabId
        : pane.tabIds[0] ?? null;
    if (!activeId) return null;

    const editor = editorByPaneRef.current.get(paneId) ?? null;
    if (!editor) return { tabId: activeId };
    try {
      const pos = editor.getPosition();
      if (!pos) return { tabId: activeId };
      return { tabId: activeId, line: pos.lineNumber, column: pos.column };
    } catch {
      return { tabId: activeId };
    }
  }, [editorByPaneRef]);

  const commitNavBackEntry = useCallback((paneId: string, prev: NavLocation) => {
    const history = getPaneNavHistory(paneId);
    const last = history.back[history.back.length - 1] ?? null;
    if (!last || !isSameNavLocation(last, prev)) {
      history.back.push(prev);
      const max = 200;
      if (history.back.length > max) history.back.splice(0, history.back.length - max);
    }
    // 正常导航会清空 forward 栈（浏览器/编辑器通用约定）
    if (history.forward.length > 0) history.forward = [];
    setNavEpoch((v) => v + 1);
  }, [getPaneNavHistory, isSameNavLocation]);

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

      const prevLocation =
        suppressNavRecordDepthRef.current === 0 && targetPaneId
          ? getCurrentNavLocationForPane(targetPaneId)
          : null;
      const targetLocation: NavLocation = { tabId: normalizedPath };
      const shouldRecord = Boolean(prevLocation && isMeaningfulNavTransition(prevLocation, targetLocation));

      if (targetPaneId) {
        state.setFocusedPane(targetPaneId);
      }

      const existing = openFilesRef.current.find((f) => f.id === normalizedPath);
      if (existing) {
        state.openTabInFocusedPane(existing.id);
        if (shouldRecord && prevLocation) commitNavBackEntry(targetPaneId, prevLocation);
        return existing.id;
      }

      if (openingPathsRef.current.has(normalizedPath)) {
        // 如果同一路径正在打开中，也要确保它成为当前 Pane 的 active，
        // 否则“跳转到行”逻辑可能因为 activeTabId 还没切换而一直失败。
        state.openTabInFocusedPane(normalizedPath);
        if (shouldRecord && prevLocation) commitNavBackEntry(targetPaneId, prevLocation);
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
        if (shouldRecord && prevLocation) commitNavBackEntry(targetPaneId, prevLocation);
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
  const isOpenFileDebugEnabled = () => {
    try {
      return window.localStorage.getItem('tauri-ai:debug:open_file') === '1';
    } catch {
      return false;
    }
  };

  const isOpenFileDebugVerboseEnabled = () => {
    try {
      return window.localStorage.getItem('tauri-ai:debug:open_file:verbose') === '1';
    } catch {
      return false;
    }
  };

  const dbg = useCallback(
    (msg: string, meta?: Record<string, unknown>) => {
      if (!isOpenFileDebugEnabled()) return;
      // 默认只保留关键链路日志；想看全量（包括 event:* 等）可开启 verbose。
      if (
        !isOpenFileDebugVerboseEnabled() &&
        !(
          msg.startsWith('openLinkTarget:') ||
          msg.startsWith('applySelection:') ||
          msg.startsWith('applyWithWait:') ||
          msg.startsWith('revealFileInExplorer:')
        )
      ) {
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[open_file][WorkstudioView][${new Date().toISOString()}] ${msg}`, meta ?? {});
    },
    []
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

    // 仅在“同一文件内跳转到指定行”时记录历史（跨文件跳转由 openFileAtPath 记录，避免重复入栈）。
    const prevLocationForHistory =
      suppressNavRecordDepthRef.current === 0 ? getCurrentNavLocationForPane(paneId) : null;
    const targetLocationForHistory: NavLocation = {
      tabId: resolved,
      line: typeof target.line === 'number' ? target.line : null,
      column: typeof target.column === 'number' ? target.column : null,
    };
    const shouldRecordSameFileJump = Boolean(
      prevLocationForHistory &&
        prevLocationForHistory.tabId === targetLocationForHistory.tabId &&
        isMeaningfulNavTransition(prevLocationForHistory, targetLocationForHistory)
    );

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const applySelection = (openedFileId: string | null, expectedPath: string): boolean => {
      if (openLinkSeqRef.current !== seq) return true;

      const rawLine = typeof target.line === 'number' ? target.line : null;
      if (!rawLine) return true;

      const pane = useWindowLayoutStore.getState().panes.find((p) => p.id === paneId) ?? null;
      if (openedFileId && (!pane || pane.activeTabId !== openedFileId)) {
        dbg('applySelection:wait_active_tab', {
          seq,
          paneId,
          openedFileId,
          activeTabId: pane?.activeTabId ?? null,
          tabIds: pane?.tabIds ?? null,
          expectedPath,
        });
        return false;
      }

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
        if (!matches) {
          dbg('applySelection:wait_model_match', {
            seq,
            paneId,
            openedFileId,
            expectedPath,
            expectedFsPath,
            expectedModelKey,
            modelPathRaw,
            modelPath,
            modelKey,
          });
          return false;
        }
      } catch {
        // ignore
      }

      if (openedFileId) {
        const file = openFilesRef.current.find((f) => f.id === openedFileId) ?? null;
        if (!file) return false;
        if (file.kind !== 'text') return true;
        // If Monaco's model is not fully hydrated yet (common right after opening a file),
        // it may temporarily report a very small line count (often 1) and we'd clamp the
        // selection to the top, causing "open file works but jump-to-line doesn't".
        //
        // To avoid this, use the already-loaded file content as a readiness hint:
        // - When the requested line exists in the content, wait until the model has enough lines.
        // - When the requested line is beyond EOF, allow clamping to end-of-file immediately.
        try {
          const content = file.content ?? '';
          if (content && rawLine > 1) {
            let expectedLineCount = 1;
            for (let i = 0; i < content.length; i++) {
              if (content.charCodeAt(i) === 10) expectedLineCount += 1;
            }
            // Only wait when the requested position should be reachable.
            if (expectedLineCount >= rawLine) {
              const modelLineCount = model.getLineCount();
              if (modelLineCount > 0 && modelLineCount < rawLine) {
                dbg('applySelection:wait_model_hydrate', {
                  seq,
                  paneId,
                  openedFileId,
                  expectedPath,
                  rawLine,
                  modelLineCount,
                  expectedLineCount,
                });
                return false;
              }
            }
          }
        } catch {
          // ignore: best-effort readiness check
        }
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
        const timeoutMs = 8000;

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
            if (typeof target.line === 'number' && target.line > 0) {
              setOpenFromLinkError(`定位到行超时（${timeoutMs}ms）：${target.filePath}:${target.line}`);
            }
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
      if (openLinkSeqRef.current === seq && shouldRecordSameFileJump && prevLocationForHistory) {
        commitNavBackEntry(paneId, prevLocationForHistory);
      }
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

  const canNavigateBack = useMemo(() => {
    const paneId = resolvedFocusedPaneId;
    if (!paneId) return false;
    const history = navHistoryRef.current.get(paneId) ?? null;
    return Boolean(history && history.back.length > 0);
  }, [navEpoch, navHistoryRef, resolvedFocusedPaneId]);

  const canNavigateForward = useMemo(() => {
    const paneId = resolvedFocusedPaneId;
    if (!paneId) return false;
    const history = navHistoryRef.current.get(paneId) ?? null;
    return Boolean(history && history.forward.length > 0);
  }, [navEpoch, navHistoryRef, resolvedFocusedPaneId]);

  const navigateToLocation = useCallback(async (location: NavLocation, opts?: { paneId?: string | null }) => {
    const state = useWindowLayoutStore.getState();
    const paneIdFromCaller = opts?.paneId ?? state.focusedPaneId;
    const paneId =
      paneIdFromCaller && state.panes.some((p) => p.id === paneIdFromCaller)
        ? paneIdFromCaller
        : (state.panes[0]?.id ?? fallbackPaneIdRef.current);

    const tabId = (location.tabId ?? '').trim();
    if (!tabId) return;

    if (isUntitledPath(tabId)) {
      // 仅在“未保存文档”场景下使用：best-effort 激活 tab 并恢复光标。
      state.setFocusedPane(paneId);
      state.openTabInFocusedPane(tabId);

      const rawLine = typeof location.line === 'number' ? location.line : null;
      if (rawLine && rawLine > 0) {
        const startAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const timeoutMs = 800;
        while (true) {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          if (now - startAt > timeoutMs) break;
          const editor = editorByPaneRef.current.get(paneId) ?? null;
          if (!editor) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
            continue;
          }
          try {
            const model = editor.getModel();
            if (!model) break;
            const lineNumber = Math.max(1, Math.min(rawLine, model.getLineCount()));
            const column = typeof location.column === 'number' ? location.column : 1;
            editor.setPosition({ lineNumber, column });
            editor.revealLineInCenter(lineNumber);
            break;
          } catch {
            break;
          }
        }
      }
      return;
    }

    await openLinkTarget(
      {
        filePath: tabId,
        line: typeof location.line === 'number' ? location.line : null,
        column: typeof location.column === 'number' ? location.column : null,
      },
      { paneId }
    );
  }, [openLinkTarget]);

  const navigateBack = useCallback(async () => {
    const state = useWindowLayoutStore.getState();
    const paneId =
      (state.focusedPaneId && state.panes.some((p) => p.id === state.focusedPaneId) ? state.focusedPaneId : null) ??
      resolvedFocusedPaneId ??
      (state.panes[0]?.id ?? fallbackPaneIdRef.current);
    if (!paneId) return;

    const history = navHistoryRef.current.get(paneId) ?? null;
    if (!history || history.back.length === 0) {
      showNavToast('没有可后退的记录');
      return;
    }

    const current = getCurrentNavLocationForPane(paneId);
    const target = history.back.pop()!;

    if (current) {
      const last = history.forward[history.forward.length - 1] ?? null;
      if (!last || !isSameNavLocation(last, current)) {
        history.forward.push(current);
        const max = 200;
        if (history.forward.length > max) history.forward.splice(0, history.forward.length - max);
      }
    }

    setNavEpoch((v) => v + 1);

    suppressNavRecordDepthRef.current += 1;
    try {
      await navigateToLocation(target, { paneId });
    } finally {
      window.setTimeout(() => {
        suppressNavRecordDepthRef.current = Math.max(0, suppressNavRecordDepthRef.current - 1);
      }, 120);
    }
  }, [getCurrentNavLocationForPane, isSameNavLocation, navigateToLocation, resolvedFocusedPaneId, showNavToast]);

  const navigateForward = useCallback(async () => {
    const state = useWindowLayoutStore.getState();
    const paneId =
      (state.focusedPaneId && state.panes.some((p) => p.id === state.focusedPaneId) ? state.focusedPaneId : null) ??
      resolvedFocusedPaneId ??
      (state.panes[0]?.id ?? fallbackPaneIdRef.current);
    if (!paneId) return;

    const history = navHistoryRef.current.get(paneId) ?? null;
    if (!history || history.forward.length === 0) {
      showNavToast('没有可前进的记录');
      return;
    }

    const current = getCurrentNavLocationForPane(paneId);
    const target = history.forward.pop()!;

    if (current) {
      const last = history.back[history.back.length - 1] ?? null;
      if (!last || !isSameNavLocation(last, current)) {
        history.back.push(current);
        const max = 200;
        if (history.back.length > max) history.back.splice(0, history.back.length - max);
      }
    }

    setNavEpoch((v) => v + 1);

    suppressNavRecordDepthRef.current += 1;
    try {
      await navigateToLocation(target, { paneId });
    } finally {
      window.setTimeout(() => {
        suppressNavRecordDepthRef.current = Math.max(0, suppressNavRecordDepthRef.current - 1);
      }, 120);
    }
  }, [getCurrentNavLocationForPane, isSameNavLocation, navigateToLocation, resolvedFocusedPaneId, showNavToast]);

  const runFocusedEditorAction = useCallback(
    async (actionId: string, opts?: { requireTextFocus?: boolean; recordNavBeforeRun?: boolean }) => {
      const requireTextFocus = opts?.requireTextFocus ?? true;
      const recordNavBeforeRun = opts?.recordNavBeforeRun ?? false;
      const state = useWindowLayoutStore.getState();
      const paneId =
        (state.focusedPaneId && state.panes.some((p) => p.id === state.focusedPaneId) ? state.focusedPaneId : null) ??
        resolvedFocusedPaneId ??
        (state.panes[0]?.id ?? fallbackPaneIdRef.current);
      if (!paneId) return false;

      const editor = editorByPaneRef.current.get(paneId) ?? null;
      if (!editor) {
        console.warn('[Workstudio] editor not ready for action:', { paneId, actionId });
        return false;
      }
      if (requireTextFocus && !editor.hasTextFocus()) return false;
      // 菜单触发时 editor 可能暂时失焦；主动聚焦可提升稳定性。
      editor.focus();

      if (recordNavBeforeRun && suppressNavRecordDepthRef.current === 0) {
        const prev = getCurrentNavLocationForPane(paneId);
        if (prev) {
          pendingNavRecordRef.current.set(paneId, prev);
          window.setTimeout(() => {
            if (pendingNavRecordRef.current.get(paneId) === prev) {
              pendingNavRecordRef.current.delete(paneId);
            }
          }, 1200);
        }
      }

      const action = editor.getAction(actionId);
      if (!action) {
        console.warn('[Workstudio] monaco action not found:', { actionId });
        return false;
      }
      try {
        await action.run();
        return true;
      } catch (err) {
        console.error('[Workstudio] monaco action failed:', { actionId, err });
        return false;
      }
    },
    [getCurrentNavLocationForPane, resolvedFocusedPaneId]
  );

  const goToDefinition = useCallback(
    (opts?: { requireTextFocus?: boolean }) =>
      runFocusedEditorAction('editor.action.revealDefinition', { ...opts, recordNavBeforeRun: true }),
    [runFocusedEditorAction]
  );
  const goToTypeDefinition = useCallback(
    (opts?: { requireTextFocus?: boolean }) =>
      runFocusedEditorAction('editor.action.revealTypeDefinition', { ...opts, recordNavBeforeRun: true }),
    [runFocusedEditorAction]
  );
  const goToReferences = useCallback(
    (opts?: { requireTextFocus?: boolean }) =>
      runFocusedEditorAction('editor.action.goToReferences', { ...opts, recordNavBeforeRun: true }),
    [runFocusedEditorAction]
  );
  const peekDefinition = useCallback(
    (opts?: { requireTextFocus?: boolean }) =>
      runFocusedEditorAction('editor.action.peekDefinition', { ...opts, recordNavBeforeRun: true }),
    [runFocusedEditorAction]
  );

  const jumpToOutlineItem = useCallback(
    (item: OutlineItem) => {
      const state = useWindowLayoutStore.getState();
      const paneId =
        (state.focusedPaneId && state.panes.some((p) => p.id === state.focusedPaneId) ? state.focusedPaneId : null) ??
        resolvedFocusedPaneId ??
        (state.panes[0]?.id ?? fallbackPaneIdRef.current);
      if (!paneId) return;

      const pane = state.panes.find((p) => p.id === paneId) ?? null;
      const tabId =
        pane?.activeTabId && pane.tabIds.includes(pane.activeTabId)
          ? pane.activeTabId
          : pane?.tabIds[0] ?? null;
      if (!tabId) return;

      const editor = editorByPaneRef.current.get(paneId) ?? null;
      if (!editor) return;

      const line = clampOutlineLine(item.selectionLine);
      const column = clampOutlineColumn(item.selectionColumn);
      const endLine = Math.max(line, clampOutlineLine(item.range.endLine));
      const endColumn = Math.max(column, clampOutlineColumn(item.range.endColumn));

      const prevLocation =
        suppressNavRecordDepthRef.current === 0 ? getCurrentNavLocationForPane(paneId) : null;
      const targetLocation: NavLocation = { tabId, line, column };
      if (prevLocation && isMeaningfulNavTransition(prevLocation, targetLocation)) {
        commitNavBackEntry(paneId, prevLocation);
      }

      setFocusedPane(paneId);
      editor.focus();
      editor.setSelection({
        startLineNumber: line,
        startColumn: column,
        endLineNumber: endLine,
        endColumn,
      });
      editor.revealPositionInCenter({ lineNumber: line, column });
      setOutlineActiveId(item.id);
    },
    [commitNavBackEntry, getCurrentNavLocationForPane, isMeaningfulNavTransition, resolvedFocusedPaneId, setFocusedPane]
  );

  const renderOutlineNodes = (nodes: OutlineItem[], depth = 0): React.ReactNode =>
    nodes.map((item) => {
      const active = outlineActiveId === item.id;
      return (
        <React.Fragment key={item.id}>
          <button
            type="button"
            className={[
              'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
              active
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
            ].join(' ')}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={`${item.name} · ${item.kind} · ${item.selectionLine}:${item.selectionColumn}`}
            onClick={() => jumpToOutlineItem(item)}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {item.kind}
            </span>
          </button>
          {item.children.length > 0 ? renderOutlineNodes(item.children, depth + 1) : null}
        </React.Fragment>
      );
    });

  const activateTabInPane = useCallback((paneId: string, tabId: string) => {
    const prevLocation = suppressNavRecordDepthRef.current === 0 ? getCurrentNavLocationForPane(paneId) : null;
    const targetLocation: NavLocation = { tabId };
    const shouldRecord = Boolean(prevLocation && isMeaningfulNavTransition(prevLocation, targetLocation));

    setActiveTabInPane(paneId, tabId);
    if (shouldRecord && prevLocation) commitNavBackEntry(paneId, prevLocation);
  }, [commitNavBackEntry, getCurrentNavLocationForPane, isMeaningfulNavTransition, setActiveTabInPane]);

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

        // Best-effort: 通知 LSP didSave（部分 server 会在保存后重新计算诊断/索引）
        try {
          const wsId = ws?.id ?? null;
          const cfg = useConfigStore.getState().config?.codeIntelligence ?? null;
          const model = editor?.getModel() ?? null;
          const uri = (model as any)?.uri?.toString?.() ? String((model as any).uri.toString()) : '';
          const languageId = typeof model?.getLanguageId === 'function' ? model.getLanguageId() : '';
          const hasServer = Boolean(
            cfg?.enabled &&
              languageId &&
              (cfg.lspServers ?? []).some((s) => s.enabled && s.languageId === languageId && String(s.command || '').trim())
          );
          if (wsId && uri && uri.startsWith('file://') && hasServer) {
            await lspNotify({
              workstudioId: wsId,
              languageId,
              method: 'textDocument/didSave',
              params: { textDocument: { uri }, text: latest },
            });
          }
        } catch {
          // ignore
        }
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

  // 初始化 Monaco <-> LSP Bridge（仅在 Tauri 桌面端）。
  // - 在 Workstudio 首次挂载 editor 时拿到 monaco 实例
  // - 当 ws.id 就绪后，启动 LSP Bridge（注册 provider + editor opener + 文档同步）
  useEffect(() => {
    return () => {
      lspBridgeRef.current?.dispose();
      lspBridgeRef.current = null;
      lspBridgeWorkstudioIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    const wsId = ws?.id ?? null;
    // Switching workstudio: dispose immediately (do not keep old listeners/processes around).
    if (lspBridgeWorkstudioIdRef.current && lspBridgeWorkstudioIdRef.current !== wsId) {
      lspBridgeRef.current?.dispose();
      lspBridgeRef.current = null;
      lspBridgeWorkstudioIdRef.current = null;
    }

    if (!monaco || !wsId) return;
    if (lspBridgeWorkstudioIdRef.current === wsId) return;

    lspBridgeRef.current?.dispose();
    lspBridgeRef.current = attachMonacoLspBridge({
      monaco,
      workstudioId: wsId,
      openFile: async (t) => {
        await openLinkTarget(t);
      },
      getConfig: () => useConfigStore.getState().config?.codeIntelligence,
      isLanguageEnabled: isLspLanguageEnabledForBridge,
    });
    lspBridgeWorkstudioIdRef.current = wsId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ws?.id,
    lspAutoConfigStatus,
    openLinkTarget,
    codeIntelligenceConfig?.enabled,
    codeIntelligenceConfig?.lspServers?.length,
    isLspLanguageEnabledForBridge,
  ]);

  const handleEditorMountForPane = useCallback(
    (paneId: string): OnMount =>
      (editor, monaco) => {
        setupMonaco(monaco);
        editorByPaneRef.current.set(paneId, editor);
        monacoRef.current = monaco as any;

        // 如果 ws 已经就绪，尽早 attach（否则由 useEffect 在 ws.id 就绪后再 attach）
        const wsId = ws?.id ?? null;
        if (wsId && lspBridgeWorkstudioIdRef.current !== wsId) {
          lspBridgeRef.current?.dispose();
          lspBridgeRef.current = attachMonacoLspBridge({
            monaco,
            workstudioId: wsId,
            openFile: async (t) => {
              await openLinkTarget(t);
            },
            getConfig: () => useConfigStore.getState().config?.codeIntelligence,
            isLanguageEnabled: isLspLanguageEnabledForBridge,
          });
          lspBridgeWorkstudioIdRef.current = wsId;
        }

        editor.onDidDispose(() => {
          editorByPaneRef.current.delete(paneId);
          lastNavLocationRef.current.delete(paneId);
          pendingNavRecordRef.current.delete(paneId);
        });

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          const fileId = useWindowLayoutStore.getState().panes.find((p) => p.id === paneId)?.activeTabId ?? null;
          if (!fileId) return;
          void saveFile(fileId, editor);
        });
        editor.onDidFocusEditorWidget(() => useWindowLayoutStore.getState().setFocusedPane(paneId));

        const readActiveTabId = (): string | null => {
          const state = useWindowLayoutStore.getState();
          const pane = state.panes.find((p) => p.id === paneId) ?? null;
          if (!pane) return null;
          const active =
            pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
              ? pane.activeTabId
              : pane.tabIds[0] ?? null;
          return active ?? null;
        };

        const snapshotCurrentLocation = (): NavLocation | null => {
          const tabId = readActiveTabId();
          if (!tabId) return null;
          try {
            const pos = editor.getPosition();
            if (!pos) return { tabId };
            return { tabId, line: pos.lineNumber, column: pos.column };
          } catch {
            return { tabId };
          }
        };

        const init = snapshotCurrentLocation();
        if (init) {
          lastNavLocationRef.current.set(paneId, init);
        }

        // 记录“代码导航类”跳转（例如 F12 转到定义）产生的程序化光标移动。
        // 只在 source=api 或者存在 pendingNavRecord 时记入历史，避免箭头键移动污染浏览栈。
        editor.onDidChangeCursorPosition((ev) => {
          const tabId = readActiveTabId();
          if (!tabId) return;
          const next: NavLocation = { tabId, line: ev.position.lineNumber, column: ev.position.column };
          const prev = lastNavLocationRef.current.get(paneId) ?? next;
          lastNavLocationRef.current.set(paneId, next);

          if (suppressNavRecordDepthRef.current > 0) return;

          const pendingPrev = pendingNavRecordRef.current.get(paneId) ?? null;
          if (pendingPrev) {
            pendingNavRecordRef.current.delete(paneId);
            if (isMeaningfulNavTransition(pendingPrev, next)) {
              commitNavBackEntry(paneId, pendingPrev);
            }
            return;
          }

          if (ev.source !== 'api') return;
          if (!isMeaningfulNavTransition(prev, next)) return;
          commitNavBackEntry(paneId, prev);
        });
      },
    [commitNavBackEntry, isMeaningfulNavTransition, lspAutoConfigStatus, openLinkTarget, saveFile, ws?.id]
  );

  useEffect(() => {
    // Ensure existing editors are updated immediately when font size changes.
    for (const editor of editorByPaneRef.current.values()) {
      try {
        editor.updateOptions({ fontSize: editorFontSize });
        editor.layout();
      } catch {
        // ignore
      }
    }
  }, [editorFontSize]);

  const editorTheme = useMemo(() => {
    return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
  }, []);

  const lspStatusByLanguageId = useMemo(() => {
    const map = new Map<string, LspServerStatus>();
    for (const s of lspStatuses) {
      const lang = String(s?.languageId ?? '').trim();
      if (!lang) continue;
      map.set(lang, s);
    }
    return map;
  }, [lspStatuses]);

  const lspMenuServers = useMemo(() => {
    const cfg = codeIntelligenceConfig ?? null;
    const servers = Array.isArray(cfg?.lspServers) ? cfg!.lspServers : [];
    const out = servers
      .map((s) => ({
        languageId: String(s.languageId || '').trim(),
        enabled: Boolean(s.enabled),
        command: String(s.command || '').trim(),
        args: Array.isArray(s.args) ? s.args.map((x) => String(x)) : [],
      }))
      .filter((s) => Boolean(s.languageId));
    out.sort((a, b) => a.languageId.localeCompare(b.languageId));
    return out;
  }, [codeIntelligenceConfig?.lspServers]);

  const lspConfigFingerprint = useMemo(() => {
    const cfg = codeIntelligenceConfig ?? null;
    if (!cfg?.enabled) return '';
    const servers = Array.isArray(cfg.lspServers) ? cfg.lspServers : [];
    const parts = servers
      .filter((s) => Boolean(s?.enabled))
      .map((s) => {
        const lang = String(s?.languageId ?? '').trim();
        const cmd = String(s?.command ?? '').trim();
        const args = Array.isArray(s?.args) ? s.args.map((x) => String(x)).join(' ') : '';
        return `${lang}:${cmd}:${args}`;
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return parts.join('|');
  }, [codeIntelligenceConfig?.enabled, codeIntelligenceConfig?.lspServers]);

  // 当用户通过“设置 -> 一键配置”把 command 修复为绝对路径时，自动解除对应语言的错误阻塞。
  useEffect(() => {
    if (!isTauri()) return;
    if (!codeIntelligenceConfig?.enabled) return;
    const servers = Array.isArray(codeIntelligenceConfig?.lspServers) ? codeIntelligenceConfig!.lspServers : [];
    const resolvedLanguages = servers
      .map((s) => ({
        languageId: String(s.languageId || '').trim(),
        command: String(s.command || '').trim(),
        enabled: Boolean(s.enabled),
      }))
      .filter((s) => s.enabled && s.languageId && s.command && isAbsoluteFsPath(s.command))
      .map((s) => s.languageId);
    if (resolvedLanguages.length === 0) return;
    setLspEnsureErrors((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const lang of resolvedLanguages) {
        if (!next[lang]) continue;
        delete next[lang];
        changed = true;
      }
      if (!changed) return prev;
      return next;
    });
  }, [codeIntelligenceConfig?.enabled, lspConfigFingerprint]);

  const configuredLspLanguageIds = useMemo(() => {
    const out = lspMenuServers.map((s) => s.languageId).filter((x) => Boolean(x));
    out.sort((a, b) => a.localeCompare(b));
    return Array.from(new Set(out));
  }, [lspMenuServers]);
  const configuredAutoDetectableLspLanguageIds = useMemo(
    () => configuredLspLanguageIds.filter((lang) => isAutoDetectableLspLanguage(lang)),
    [configuredLspLanguageIds]
  );
  const configuredAutoDetectableLspLanguageFingerprint = useMemo(
    () => configuredAutoDetectableLspLanguageIds.join('|'),
    [configuredAutoDetectableLspLanguageIds]
  );

  // 自动模式：根据当前项目文件判断需要启用的语言，避免把全局所有语言都在该工作区启动。
  useEffect(() => {
    const wsId = ws?.id ?? null;
    if (!isTauri() || !wsId || !codeIntelligenceConfig?.enabled) {
      setProjectScannedLspLanguageIds([]);
      return;
    }
    if (configuredAutoDetectableLspLanguageIds.length === 0) {
      setProjectScannedLspLanguageIds([]);
      return;
    }

    let disposed = false;
    void (async () => {
      const found = new Set<string>();
      for (const lang of configuredAutoDetectableLspLanguageIds) {
        if (disposed) return;
        const queries = AUTO_DETECT_LSP_FILE_QUERIES[lang] ?? [];
        if (queries.length === 0) continue;
        for (const query of queries) {
          if (disposed) return;
          try {
            const matches = await invoke<string[]>('workstudio_find_files', {
              args: { workstudioId: wsId, query, limit: 80 },
            });
            if (Array.isArray(matches) && matches.some((path) => isAutoDetectMatchForLanguage(lang, path))) {
              found.add(lang);
              break;
            }
          } catch {
            // ignore
          }
        }
      }
      if (disposed) return;
      const out = Array.from(found);
      out.sort((a, b) => a.localeCompare(b));
      setProjectScannedLspLanguageIds(out);
    })();

    return () => {
      disposed = true;
    };
  }, [ws?.id, codeIntelligenceConfig?.enabled, configuredAutoDetectableLspLanguageFingerprint]);
  const autoSelectedLspLanguageIds = useMemo(() => {
    const allow = new Set(projectAutoDetectedLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)));
    return configuredLspLanguageIds.filter((lang) => allow.has(lang));
  }, [configuredLspLanguageIds, projectAutoDetectedLspLanguageIds]);

  const wsSelectedLspLanguageIds = useMemo(() => {
    if (wsEnabledLspLanguageIds === null) return autoSelectedLspLanguageIds;
    const allow = new Set(wsEnabledLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)));
    return configuredLspLanguageIds.filter((lang) => allow.has(lang));
  }, [autoSelectedLspLanguageIds, configuredLspLanguageIds, wsEnabledLspLanguageIds]);
  const wsSelectedLspLanguageIdSet = useMemo(() => new Set(wsSelectedLspLanguageIds), [wsSelectedLspLanguageIds]);

  const globallyEnabledLspLanguageIds = useMemo(() => {
    const cfg = codeIntelligenceConfig ?? null;
    if (!cfg?.enabled) return [];
    const servers = Array.isArray(cfg.lspServers) ? cfg.lspServers : [];
    const out: string[] = [];
    for (const s of servers) {
      const lang = String(s.languageId || '').trim();
      const cmd = String(s.command || '').trim();
      if (!s.enabled || !lang || !cmd) continue;
      out.push(lang);
    }
    const uniq = Array.from(new Set(out));
    uniq.sort((a, b) => a.localeCompare(b));
    return uniq;
  }, [codeIntelligenceConfig?.enabled, codeIntelligenceConfig?.lspServers]);

  const enabledLspLanguageIds = useMemo(() => {
    if (wsEnabledLspLanguageIds === null) {
      const allow = new Set(projectAutoDetectedLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)));
      return globallyEnabledLspLanguageIds.filter((lang) => allow.has(lang));
    }
    const allow = new Set(wsEnabledLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)));
    return globallyEnabledLspLanguageIds.filter((lang) => allow.has(lang));
  }, [globallyEnabledLspLanguageIds, projectAutoDetectedLspLanguageIds, wsEnabledLspLanguageIds]);

  const getLanguageProgressText = useCallback(
    (languageId: string) => {
      const items = Object.values(lspProgress[languageId] ?? {});
      if (items.length === 0) return null;
      items.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
      const top = items[0] ?? null;
      if (!top) return null;
      const pct = typeof top.percentage === 'number' ? `${Math.max(0, Math.min(100, Math.round(top.percentage)))}%` : '';
      const detail = [top.title, top.message].filter(Boolean).join(' - ');
      return pct ? `${detail}（${pct}）` : detail;
    },
    [lspProgress]
  );

  const describeLspLanguage = useCallback(
    (languageId: string) => {
      const st = lspStatusByLanguageId.get(languageId) ?? null;
      const started = Boolean(st?.started);
      const initialized = Boolean(st?.initialized);
      const ensureError = lspEnsureErrors[languageId] ?? null;
      const lastError = ensureError || st?.lastError || null;
      const hasProgress = Object.keys(lspProgress[languageId] ?? {}).length > 0;

      const state: 'error' | 'not_started' | 'starting' | 'indexing' | 'ready' = lastError
        ? 'error'
        : !started
          ? 'not_started'
          : !initialized
            ? 'starting'
            : hasProgress
              ? 'indexing'
              : 'ready';

      const progressText = getLanguageProgressText(languageId);
      const exited = lspExited[languageId] ?? null;
      const exitedText = exited
        ? `已退出（code=${exited.code ?? 'null'} signal=${exited.signal ?? 'null'}）`
        : null;

      const label =
        state === 'error'
          ? '错误'
          : state === 'not_started'
            ? '未启动'
            : state === 'starting'
              ? '启动中'
              : state === 'indexing'
                ? '索引中'
                : '就绪';

      const dotClass =
        state === 'error'
          ? 'bg-red-500'
          : state === 'indexing' || state === 'starting'
            ? 'bg-yellow-500'
            : state === 'ready'
              ? 'bg-green-500'
              : 'bg-gray-400';

      return {
        state,
        label,
        dotClass,
        started,
        initialized,
        command: st?.command ?? undefined,
        args: st?.args ?? undefined,
        lastError,
        progressText,
        exitedText,
      };
    },
    [getLanguageProgressText, lspEnsureErrors, lspExited, lspProgress, lspStatusByLanguageId]
  );

  const lspSummary = useMemo(() => {
    if (!isTauri()) {
      return { label: '代码智能：仅桌面端', dotClass: 'bg-gray-400', title: '仅 Tauri 桌面端支持 LSP' };
    }
    if (!codeIntelligenceConfig?.enabled) {
      return { label: '代码智能：关闭', dotClass: 'bg-gray-400', title: '设置 -> Code Intelligence 中开启' };
    }
    if (globallyEnabledLspLanguageIds.length === 0) {
      return { label: '代码智能：未配置', dotClass: 'bg-yellow-500', title: '未找到已启用的 LSP server 配置' };
    }
    if (enabledLspLanguageIds.length === 0) {
      return { label: '代码智能：未启用语言', dotClass: 'bg-gray-400', title: '在代码智能面板中为该工作区选择语言' };
    }

    const states = enabledLspLanguageIds.map((lang) => describeLspLanguage(lang).state);
    const hasError = states.includes('error');
    const hasNotStarted = states.includes('not_started');
    const hasStarting = states.includes('starting');
    const hasIndexing = states.includes('indexing');

    if (hasError) return { label: '代码智能：错误', dotClass: 'bg-red-500', title: 'LSP 出错（点击查看详情）' };
    if (hasNotStarted) return { label: '代码智能：未启动', dotClass: 'bg-gray-400', title: '点击查看/启动 LSP' };
    if (hasStarting) return { label: '代码智能：启动中', dotClass: 'bg-yellow-500', title: 'LSP 正在初始化' };
    if (hasIndexing) {
      const detail = enabledLspLanguageIds.map((lang) => getLanguageProgressText(lang)).find(Boolean) ?? null;
      return { label: '代码智能：索引中', dotClass: 'bg-yellow-500', title: detail ?? '语言服务器正在索引' };
    }
    return { label: '代码智能：就绪', dotClass: 'bg-green-500', title: '语言服务器已就绪' };
  }, [codeIntelligenceConfig?.enabled, describeLspLanguage, enabledLspLanguageIds, getLanguageProgressText, globallyEnabledLspLanguageIds.length]);

  const ensureLspForLanguage = useCallback(
    async (languageId: string) => {
      if (!isTauri()) return;
      const wsId = ws?.id ?? null;
      if (!wsId) return;
      const lang = String(languageId ?? '').trim();
      if (!lang) return;
      if (!isLspLanguageEnabledForWorkstudio(lang)) {
        showNavToast(`未启用语言：${lang}`);
        return;
      }

      setLspEnsureErrors((prev) => {
        if (!prev[lang]) return prev;
        const next = { ...prev };
        delete next[lang];
        return next;
      });

      ensuredLspLangRef.current.add(lang);
      try {
        await lspEnsureServer({ workstudioId: wsId, languageId: lang });
        const res = await lspStatus(wsId);
        setLspStatuses(res);
      } catch (e) {
        ensuredLspLangRef.current.delete(lang);
        setLspEnsureErrors((prev) => ({
          ...prev,
          [lang]: e instanceof Error ? e.message : String(e),
        }));
      }
    },
    [isLspLanguageEnabledForWorkstudio, showNavToast, ws?.id]
  );

  const restartLspBridge = useCallback(async () => {
    if (!isTauri()) return;
    const monaco = monacoRef.current;
    const wsId = ws?.id ?? null;
    if (!monaco || !wsId) return;

    ensuredLspLangRef.current = new Set();
    setLspEnsureErrors({});
    setLspProgress({});
    setLspLogs({});
    setLspExited({});

    lspBridgeRef.current?.dispose();
    lspBridgeRef.current = attachMonacoLspBridge({
      monaco,
      workstudioId: wsId,
      openFile: async (t) => {
        await openLinkTarget(t);
      },
      getConfig: () => useConfigStore.getState().config?.codeIntelligence,
      isLanguageEnabled: isLspLanguageEnabledForBridge,
    });
    lspBridgeWorkstudioIdRef.current = wsId;

    // Best-effort: immediately re-ensure servers so status/progress can be seen early.
    const cfg = useConfigStore.getState().config?.codeIntelligence ?? null;
    if (cfg?.enabled) {
      const servers = Array.isArray(cfg.lspServers) ? cfg.lspServers : [];
      for (const s of servers) {
        const languageId = String(s.languageId || '').trim();
        const command = String(s.command || '').trim();
        if (!s.enabled || !languageId || !command) continue;
        if (!isLspLanguageEnabledForWorkstudio(languageId)) continue;
        void ensureLspForLanguage(languageId);
      }
    }
  }, [ensureLspForLanguage, isLspLanguageEnabledForWorkstudio, isLspLanguageEnabledForBridge, openLinkTarget, ws?.id]);

  const copyTextToClipboard = useCallback(
    async (text: string, okMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showNavToast(okMessage);
      } catch (e) {
        console.error('[Workstudio] clipboard write failed:', e);
        showNavToast('复制失败（请检查剪贴板权限）');
      }
    },
    [showNavToast]
  );

  const copyLspLogsForLanguage = useCallback(
    async (languageId: string) => {
      const lang = String(languageId ?? '').trim();
      if (!lang) return;
      const logs = lspLogs[lang] ?? [];
      if (logs.length === 0) {
        showNavToast(`暂无日志：${lang}`);
        return;
      }
      await copyTextToClipboard(logs.join('\n'), `已复制日志：${lang}`);
    },
    [copyTextToClipboard, lspLogs, showNavToast]
  );

  const copyAllLspLogs = useCallback(async () => {
    const langs = Object.keys(lspLogs).sort((a, b) => a.localeCompare(b));
    if (langs.length === 0) {
      showNavToast('暂无 LSP 日志');
      return;
    }
    const parts: string[] = [];
    for (const lang of langs) {
      const logs = lspLogs[lang] ?? [];
      if (logs.length === 0) continue;
      parts.push(`### ${lang}`);
      parts.push(...logs);
      parts.push('');
    }
    const text = parts.join('\n').trim();
    if (!text) {
      showNavToast('暂无 LSP 日志');
      return;
    }
    await copyTextToClipboard(text, '已复制 LSP 日志');
  }, [copyTextToClipboard, lspLogs, showNavToast]);

  const toggleWorkstudioLspLanguage = useCallback(
    (languageId: string) => {
      const lang = String(languageId ?? '').trim();
      if (!lang) return;
      setWsEnabledLspLanguageIds((prev) => {
        const base = prev === null ? configuredLspLanguageIds : prev;
        const set = new Set(base.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)));
        if (set.has(lang)) set.delete(lang);
        else set.add(lang);
        const out = Array.from(set);
        out.sort((a, b) => a.localeCompare(b));
        return out;
      });
    },
    [configuredLspLanguageIds]
  );

  const restoreWorkstudioLspLanguageAuto = useCallback(() => {
    setWsEnabledLspLanguageIds(null);
    showNavToast('已恢复自动语言（按项目文件自动启用）');
  }, [showNavToast]);

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

  const paneTabSelectionFingerprint = useMemo(
    () =>
      resolvedPanes
        .map((pane) => `${pane.id}:${pane.activeTabId ?? ''}:${pane.tabIds.join(',')}`)
        .join('|'),
    [resolvedPanes]
  );

  const scrollActiveTabIntoView = useCallback(() => {
    for (const pane of resolvedPanes) {
      const activeTabId =
        pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
          ? pane.activeTabId
          : pane.tabIds[0] ?? null;
      if (!activeTabId) continue;
      const stripEl = paneTabStripRefs.current.get(pane.id);
      if (!stripEl) continue;
      const selector = `[data-workstudio-tab-id="${escapeCssSelectorValue(activeTabId)}"]`;
      const tabEl = stripEl.querySelector(selector) as HTMLElement | null;
      if (!tabEl) continue;
      const stripRect = stripEl.getBoundingClientRect();
      const tabRect = tabEl.getBoundingClientRect();
      const outLeft = tabRect.left < stripRect.left + 2;
      const outRight = tabRect.right > stripRect.right - 2;
      if (!outLeft && !outRight) continue;
      try {
        tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      } catch {
        // ignore
      }
    }
  }, [resolvedPanes]);

  useEffect(() => {
    let disposed = false;
    let attempts = 8;
    const tick = () => {
      if (disposed) return;
      scrollActiveTabIntoView();
      let hasMissingDom = false;
      for (const pane of resolvedPanes) {
        const activeTabId =
          pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
            ? pane.activeTabId
            : pane.tabIds[0] ?? null;
        if (!activeTabId) continue;
        const stripEl = paneTabStripRefs.current.get(pane.id);
        if (!stripEl) {
          hasMissingDom = true;
          continue;
        }
        const selector = `[data-workstudio-tab-id="${escapeCssSelectorValue(activeTabId)}"]`;
        if (!stripEl.querySelector(selector)) hasMissingDom = true;
      }
      attempts -= 1;
      if (hasMissingDom && attempts > 0) {
        window.setTimeout(tick, 60);
      }
    };
    window.requestAnimationFrame(tick);
    return () => {
      disposed = true;
    };
  }, [paneTabSelectionFingerprint, resolvedPanes, scrollActiveTabIntoView]);

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
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragCancelledByEscapeRef = useRef(false);
  const dragGhostActiveRef = useRef(false);
  const [pinActiveTabWhileDragging, setPinActiveTabWhileDragging] = useState(false);
  const [splitPreview, setSplitPreview] = useState<SplitPreview | null>(null);
  const [remoteSplitPreview, setRemoteSplitPreview] = useState<SplitPreview | null>(null);

  const dragGhost = useDragGhostSession({ pollIntervalMs: 16 });

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

  const computeSplitPreview = useCallback((point: { x: number; y: number }): SplitPreview | null => {
    for (const [paneId, el] of paneBodyRefs.current) {
      const rect = el.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right) continue;
      if (point.y < rect.top || point.y > rect.bottom) continue;

      // 可分屏的边缘区域：加宽 50%，提升可用性
      const edge = Math.max(56, Math.min(210, Math.round(rect.width * 0.27)));
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

  const getTabStripPaneAtPoint = useCallback((point: { x: number; y: number }): string | null => {
    for (const [paneId, el] of paneTabStripRefs.current) {
      const rect = el.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right) continue;
      if (point.y < rect.top || point.y > rect.bottom) continue;
      return paneId;
    }
    return null;
  }, []);

  const computeTabStripInsertIndex = useCallback(
    (paneId: string, point: { x: number; y: number }, activeId: string): number | null => {
      const pane = paneById.get(paneId);
      if (!pane) return null;

      const stripEl = paneTabStripRefs.current.get(paneId);
      if (!stripEl) return null;

      const candidates = pane.tabIds.filter((id) => id !== activeId);
      if (candidates.length === 0) return 0;

      const rectById = new Map<string, DOMRect>();
      const nodes = Array.from(stripEl.querySelectorAll('[data-workstudio-tab-id]')) as HTMLElement[];
      for (const el of nodes) {
        const id = el.getAttribute('data-workstudio-tab-id');
        if (!id) continue;
        rectById.set(id, el.getBoundingClientRect());
      }

      const centers: number[] = [];
      for (const id of candidates) {
        const rect = rectById.get(id);
        if (!rect) continue;
        centers.push(rect.left + rect.width / 2);
      }
      if (centers.length === 0) return candidates.length;
      centers.sort((a, b) => a - b);

      for (let i = 0; i < centers.length; i++) {
        if (point.x < centers[i]!) return i;
      }
      return centers.length;
    },
    [paneById]
  );

  // 仅当指针在 tab strip 区域时才参与“tab 排序”的碰撞检测。
  // 这样可以避免在编辑器区域拖动时，tab 顺序被 dnd-kit 的排序预览/落点影响。
  const collisionDetection = useCallback(
    (args: any) => {
      const p = args?.pointerCoordinates as { x: number; y: number } | null | undefined;
      if (!p) return closestCenter(args);

      const inTabStrip = Boolean(getTabStripPaneAtPoint(p));
      if (inTabStrip) {
        const droppableContainers = (args?.droppableContainers ?? []).filter(
          (c: any) => !String(c?.id ?? '').startsWith('pane:')
        );
        return closestCenter({
          ...args,
          droppableContainers,
          collisionRect: {
            left: p.x,
            right: p.x,
            top: p.y,
            bottom: p.y,
            width: 0,
            height: 0,
          },
        });
      }

      const droppableContainers = (args?.droppableContainers ?? []).filter((c: any) =>
        String(c?.id ?? '').startsWith('pane:')
      );
      return closestCenter({ ...args, droppableContainers });
    },
    [getTabStripPaneAtPoint]
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const activeId = String(e.active.id);
    setActiveDragTabId(activeId);
    setSplitPreview(null);
    dragCancelledByEscapeRef.current = false;
    dragGhostActiveRef.current = false;
    setPinActiveTabWhileDragging(false);

    const ev = e.activatorEvent as MouseEvent | PointerEvent | TouchEvent | null;
    if (ev && 'clientX' in ev) {
      dragStartRef.current = { x: ev.clientX, y: ev.clientY };
      lastDragPointRef.current = { x: ev.clientX, y: ev.clientY };
    } else {
      dragStartRef.current = null;
      lastDragPointRef.current = null;
    }

    // Workstudio：拖拽开始就显示 ghost window（不做 tear-off / 不新建窗口）
    const point = dragStartRef.current;
    if (point && isTauri()) {
      const title = openFilesRef.current.find((f) => f.id === activeId)?.title ?? basename(activeId);
      const escapeAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const tabEl = document.querySelector(
        `[data-workstudio-tab-id="${escapeAttr(activeId)}"]`
      ) as HTMLElement | null;
      const tabRect = tabEl?.getBoundingClientRect() ?? null;
      dragGhostActiveRef.current = true;
      dragGhost.start(title, tabRect ? { anchorRect: tabRect, clientPoint: point } : { clientPoint: point });
      dragGhost.moveByClientPoint(point);
    }
  }, []);

  const handleDragMove = useCallback(
    (e: DragMoveEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const point = { x: start.x + e.delta.x, y: start.y + e.delta.y };
      lastDragPointRef.current = point;

      if (dragGhostActiveRef.current) dragGhost.moveByClientPoint(point);

      // 指针不在任何 tab strip 时：固定“被拖拽的 tab”停在 tab 栏位置（ghost 负责跟随）
      const tabStripPaneId = getTabStripPaneAtPoint(point);
      setPinActiveTabWhileDragging((prev) => {
        const next = !tabStripPaneId;
        return prev === next ? prev : next;
      });

      const next = computeSplitPreview(point);
      setSplitPreview((prev) => {
        if (!next && !prev) return prev;
        if (!next) return null;
        if (prev && prev.paneId === next.paneId && prev.direction === next.direction) return prev;
        return next;
      });
    },
    [computeSplitPreview, dragGhost, getTabStripPaneAtPoint]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const active = String(event.active.id);
      const over = event.over ? String(event.over.id) : null;

      const point = lastDragPointRef.current;

      dragStartRef.current = null;
      lastDragPointRef.current = null;
      setPinActiveTabWhileDragging(false);
      if (dragGhostActiveRef.current) {
        dragGhostActiveRef.current = false;
        dragGhost.stop();
      }

      const preview = point ? computeSplitPreview(point) : null;
      if (preview) {
        splitTabToNewPane(active, preview.direction, preview.paneId);
        setActiveDragTabId(null);
        setSplitPreview(null);
        return;
      }

      // 收起拖拽 UI（Workstudio 不支持拖拽 tear-off / ghost window）
      setActiveDragTabId(null);
      setSplitPreview(null);

      if (!over) return;

      const fromPaneId = tabToPaneId.get(active) ?? null;
      const tabStripPaneId = point ? getTabStripPaneAtPoint(point) : null;
      if (point && tabStripPaneId) {
        const insertIndex = computeTabStripInsertIndex(tabStripPaneId, point, active);
        if (typeof insertIndex === 'number' && Number.isFinite(insertIndex)) {
          const pane = paneById.get(tabStripPaneId) ?? null;
          if (fromPaneId && fromPaneId === tabStripPaneId && pane && pane.tabIds.length > 0) {
            const desiredIndex = Math.max(0, Math.min(pane.tabIds.length - 1, insertIndex));
            const overId = pane.tabIds[desiredIndex];
            if (overId) reorderTabInPane(tabStripPaneId, active, overId);
          } else {
            moveTabToPane(active, tabStripPaneId, insertIndex);
          }
          return;
        }
      }

      // 1) drop 到 pane 区域：只在跨 pane 时才移动，避免同 pane 下“拖到编辑区”导致顺序变化
      if (over.startsWith('pane:')) {
        const toPaneId = over.slice('pane:'.length);
        if (!toPaneId) return;
        if (!fromPaneId || fromPaneId !== toPaneId) {
          moveTabToPane(active, toPaneId);
        }
        return;
      }

      // 2) drop 到某个 tab：仅当指针在 tab strip 内时才允许“改顺序”
      const toPaneId = tabToPaneId.get(over) ?? null;
      if (!toPaneId) return;

      const isDroppingInTargetTabStrip = tabStripPaneId === toPaneId;

      if (fromPaneId && fromPaneId === toPaneId) {
        if (isDroppingInTargetTabStrip) {
          reorderTabInPane(toPaneId, active, over);
        }
        return;
      }

      // 移动到另一个 pane：在 tab strip 上 drop 才按具体 index 插入，否则追加到末尾
      if (isDroppingInTargetTabStrip) {
        const targetPane = paneById.get(toPaneId);
        const index = targetPane ? targetPane.tabIds.indexOf(over) : -1;
        moveTabToPane(active, toPaneId, index >= 0 ? index : undefined);
        return;
      }

      moveTabToPane(active, toPaneId);
    },
    [
      computeTabStripInsertIndex,
      computeSplitPreview,
      dragGhost,
      getTabStripPaneAtPoint,
      moveTabToPane,
      paneById,
      reorderTabInPane,
      splitTabToNewPane,
      tabToPaneId,
    ]
  );

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      const active = String(event.active.id);
      const point = lastDragPointRef.current;

      dragStartRef.current = null;
      lastDragPointRef.current = null;

      setActiveDragTabId(null);
      setSplitPreview(null);
      setPinActiveTabWhileDragging(false);
      if (dragGhostActiveRef.current) {
        dragGhostActiveRef.current = false;
        dragGhost.stop();
      }

      // Esc 取消：不做任何额外动作
      if (dragCancelledByEscapeRef.current) return;

      const preview = point ? computeSplitPreview(point) : null;
      if (preview) {
        splitTabToNewPane(active, preview.direction, preview.paneId);
      }
    },
    [computeSplitPreview, dragGhost, splitTabToNewPane]
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

  const returnToMainWindow = useCallback(async () => {
    const ok = await focusMainWindow();
    if (!ok) {
      showNavToast('未找到主窗口');
    }
  }, [showNavToast]);

  const setEditorFontSizeFromUser = useCallback(
    (nextFontSize: number) => {
      const next = clampEditorFontSize(nextFontSize);
      if (next === editorFontSizeRef.current) return;
      setEditorFontSize(next);
      showNavToast(`字体：${next}px`);
    },
    [showNavToast]
  );

  const zoomInEditorFont = useCallback(() => {
    setEditorFontSizeFromUser(editorFontSizeRef.current + 1);
  }, [setEditorFontSizeFromUser]);

  const zoomOutEditorFont = useCallback(() => {
    setEditorFontSizeFromUser(editorFontSizeRef.current - 1);
  }, [setEditorFontSizeFromUser]);

  const resetEditorFont = useCallback(() => {
    setEditorFontSizeFromUser(DEFAULT_EDITOR_FONT_SIZE);
  }, [setEditorFontSizeFromUser]);

  const onEditorWheelCapture = useCallback(
    (e: React.WheelEvent) => {
      // Ctrl/Cmd + Wheel: zoom editor font size (like VS Code / browsers).
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) zoomInEditorFont();
      if (e.deltaY > 0) zoomOutEditorFont();
    },
    [zoomInEditorFont, zoomOutEditorFont]
  );

  // Workstudio 文件搜索（由全局快捷键系统分发：tauri-ai:shortcut）
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const e = event as CustomEvent<{ action?: string }>;
      const action = e.detail?.action;
      if (action === 'workstudio.backToMain') {
        if (!isStandaloneWorkstudioWindow) return;
        void returnToMainWindow();
        return;
      }
      if (action === 'workstudio.fileSearch') {
        setFilePaletteOpen(true);
        window.setTimeout(() => filePaletteInputRef.current?.focus(), 0);
        return;
      }
      if (action === 'workstudio.navigateBack') {
        void navigateBack();
        return;
      }
      if (action === 'workstudio.navigateForward') {
        void navigateForward();
        return;
      }
      if (action === 'workstudio.goToDefinition') {
        void goToDefinition();
        return;
      }
      if (action === 'workstudio.goToTypeDefinition') {
        void goToTypeDefinition();
        return;
      }
      if (action === 'workstudio.goToReferences') {
        void goToReferences();
        return;
      }
      if (action === 'workstudio.peekDefinition') {
        void peekDefinition();
        return;
      }
      if (action === 'workstudio.fontZoomIn') {
        zoomInEditorFont();
        return;
      }
      if (action === 'workstudio.fontZoomOut') {
        zoomOutEditorFont();
        return;
      }
      if (action === 'workstudio.fontZoomReset') {
        resetEditorFont();
      }
    };
    window.addEventListener('tauri-ai:shortcut', onShortcut as EventListener);
    return () => window.removeEventListener('tauri-ai:shortcut', onShortcut as EventListener);
  }, [
    goToDefinition,
    goToReferences,
    goToTypeDefinition,
    isStandaloneWorkstudioWindow,
    navigateBack,
    navigateForward,
    peekDefinition,
    resetEditorFont,
    returnToMainWindow,
    zoomInEditorFont,
    zoomOutEditorFont,
  ]);

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

  // Esc: close LSP status menu
  useEffect(() => {
    if (!lspMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setLspMenu(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lspMenu]);

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
    setWsEnabledLspLanguageIds(null);
    setEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
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

        // Restore workstudio-scoped LSP language filter (optional)
        const rawEnabled = state.codeIntelligence?.enabledLanguageIds;
        if (Array.isArray(rawEnabled)) {
          const cleaned = Array.from(
            new Set(rawEnabled.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)))
          );
          cleaned.sort((a, b) => a.localeCompare(b));
          setWsEnabledLspLanguageIds(cleaned);
        }

        const rawFontSize = state.editorFontSize;
        if (typeof rawFontSize === 'number' && Number.isFinite(rawFontSize)) {
          setEditorFontSize(clampEditorFontSize(rawFontSize));
        }

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
        ...(editorFontSize === DEFAULT_EDITOR_FONT_SIZE ? {} : { editorFontSize }),
        ...(wsEnabledLspLanguageIds === null
          ? {}
          : {
              codeIntelligence: {
                enabledLanguageIds: Array.from(
                  new Set(wsEnabledLspLanguageIds.map((x) => String(x ?? '').trim()).filter((x) => Boolean(x)))
                ).sort((a, b) => a.localeCompare(b)),
              },
            }),
      };
      void invoke('set_workstudio_ui_state', { workstudioId: ws.id, state }).catch(() => {});
    }, 500);
    return () => {
      if (saveStateTimerRef.current) window.clearTimeout(saveStateTimerRef.current);
    };
  }, [ws, openFiles, resolvedPanes, resolvedFocusedPaneId, expandedDirs, editorFontSize, wsEnabledLspLanguageIds]);

  useEffect(() => {
    if (!ws) return;
    void listDir(ws.mainFolder);
  }, [ws, listDir]);

  // LSP UI states: reset when switching workstudio
  useEffect(() => {
    ensuredLspLangRef.current = new Set();
    setLspStatuses([]);
    setLspEnsureErrors({});
    setLspProgress({});
    setLspLogs({});
    setLspLogExpanded({});
    setLspExited({});
    setLspListenerReadyWsId(null);
    setLspAutoConfigStatus('idle');
  }, [ws?.id]);

  // Auto-config LSP（产品级兜底）：
  // - 当 command 为空/非绝对路径时，尝试探测并写回绝对路径，避免依赖 PATH。
  // - 优先修复已有配置；当配置为空时，尝试自动创建常见语言（rust/python/cpp/c/lua）。
  // - 失败仅记录，不阻塞其它语言。
  useEffect(() => {
    if (!isTauri()) return;
    if (!uiStateRestored) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;
    if (lspAutoConfigStatus !== 'idle') return;

    const cfg = codeIntelligenceConfig ?? null;
    if (!cfg) {
      // 等待配置加载完成（避免误判为“未开启”导致后续不再尝试自动配置）。
      return;
    }
    if (!cfg.enabled) {
      setLspAutoConfigStatus('done');
      return;
    }

    const servers = Array.isArray(cfg.lspServers) ? cfg.lspServers : [];
    const shouldAutoForCommand = (command: string) => {
      const cmd = String(command || '').trim();
      return !cmd || !isAbsoluteFsPath(cmd);
    };
    const existingEnabledLangSet = new Set(
      servers
        .filter((s) => Boolean(s.enabled))
        .map((s) => String(s.languageId || '').trim())
        .filter((lang) => Boolean(lang))
    );
    const candidateLangs = servers.length === 0
      ? [...AUTO_DETECT_LSP_LANGUAGES]
      : Array.from(
          new Set(
            servers
              .map((s) => ({
                enabled: Boolean(s.enabled),
                languageId: String(s.languageId || '').trim(),
                command: String(s.command || '').trim(),
              }))
              .filter((s) => s.enabled && s.languageId && isAutoDetectableLspLanguage(s.languageId) && shouldAutoForCommand(s.command))
              .map((s) => s.languageId)
          )
        );
    if (candidateLangs.length === 0) {
      setLspAutoConfigStatus('done');
      return;
    }

    setLspAutoConfigStatus('running');
    void (async () => {
      try {
        console.info('[Workstudio][LSP] auto-config: start', { workstudioId: wsId, languages: candidateLangs });
        const detected = new Map<string, { command: string; args: string[] }>();
        const failed = new Map<string, string>();

        for (const languageId of candidateLangs) {
          try {
            const res = await lspDetectServer({ languageId });
            const foundCmd = String(res?.command || '').trim();
            if (!foundCmd) {
              failed.set(languageId, '未找到可执行文件（返回 command 为空）');
              continue;
            }
            const recommendedArgs = Array.isArray(res?.args)
              ? res.args.map((x) => String(x || '').trim()).filter(Boolean)
              : [];
            detected.set(languageId, { command: foundCmd, args: recommendedArgs });
          } catch (e) {
            failed.set(languageId, e instanceof Error ? e.message : String(e));
          }
        }

        if (detected.size === 0) {
          console.warn('[Workstudio][LSP] auto-config: no language resolved', {
            workstudioId: wsId,
            failed: Object.fromEntries(failed),
          });
          const shouldShowError = servers.length > 0;
          if (shouldShowError && failed.size > 0) {
            setLspEnsureErrors((prev) => {
              const next = { ...prev };
              for (const [lang, msg] of failed.entries()) {
                if (!existingEnabledLangSet.has(lang)) continue;
                next[lang] = `自动配置失败：${msg}`;
              }
              return next;
            });
          }
          return;
        }

        console.info('[Workstudio][LSP] auto-config: resolved', {
          workstudioId: wsId,
          detected: Array.from(detected.keys()),
          failed: Object.fromEntries(failed),
        });

        const currentConfig = useConfigStore.getState().config;
        if (!currentConfig) {
          throw new Error('配置未加载完成');
        }

        const currentCi = currentConfig.codeIntelligence ?? { enabled: true, lspServers: [] };
        const currentServers = Array.isArray(currentCi.lspServers) ? currentCi.lspServers : [];
        const nextServers = currentServers.slice();
        const patchedLangs = new Set<string>();

        for (let idx = 0; idx < nextServers.length; idx += 1) {
          const server = nextServers[idx];
          const lang = String(server.languageId || '').trim();
          if (!lang || !detected.has(lang)) continue;
          if (!server.enabled) continue;
          if (!shouldAutoForCommand(server.command || '')) continue;
          const found = detected.get(lang)!;
          const existingArgs = Array.isArray(server.args) ? server.args : [];
          const nextArgs = existingArgs.length === 0 && found.args.length > 0 ? found.args : existingArgs;
          nextServers[idx] = {
            ...server,
            enabled: true,
            command: found.command,
            args: nextArgs,
          };
          patchedLangs.add(lang);
        }

        if (currentServers.length === 0) {
          for (const [lang, found] of detected.entries()) {
            if (patchedLangs.has(lang)) continue;
            nextServers.push({
              languageId: lang,
              enabled: true,
              command: found.command,
              args: found.args,
              env: {},
              initializationOptions: {},
              settings: {},
            });
            patchedLangs.add(lang);
          }
        }

        useConfigStore.getState().saveConfigDebounced(
          {
            ...currentConfig,
            codeIntelligence: { ...currentCi, enabled: true, lspServers: nextServers },
          },
          0
        );

        setLspEnsureErrors((prev) => {
          const next = { ...prev };
          for (const lang of patchedLangs) {
            if (next[lang]) delete next[lang];
          }
          for (const [lang, msg] of failed.entries()) {
            if (!existingEnabledLangSet.has(lang)) continue;
            next[lang] = `自动配置失败：${msg}`;
          }
          return next;
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Workstudio][LSP] auto-config: failed', { workstudioId: wsId, msg });
      } finally {
        setLspAutoConfigStatus('done');
      }
    })();
  }, [uiStateRestored, ws?.id, lspAutoConfigStatus, codeIntelligenceConfig?.enabled, codeIntelligenceConfig?.lspServers?.length]);

  // Auto-start LSP servers (best-effort) so 启动/索引/就绪状态可见。
  useEffect(() => {
    if (!isTauri()) return;
    if (!uiStateRestored) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;
    if (lspListenerReadyWsId !== wsId) return;
    if (lspAutoConfigStatus !== 'done') return;
    const cfg = useConfigStore.getState().config?.codeIntelligence ?? null;
    if (!cfg?.enabled) return;

    const servers = Array.isArray(cfg.lspServers) ? cfg.lspServers : [];
    for (const s of servers) {
      const languageId = String(s.languageId || '').trim();
      const command = String(s.command || '').trim();
      if (!s.enabled || !languageId || !command) continue;
      if (!isLspLanguageEnabledForWorkstudio(languageId)) continue;
      if (lspEnsureErrorsRef.current?.[languageId]) continue;
      if (ensuredLspLangRef.current.has(languageId)) continue;
      ensuredLspLangRef.current.add(languageId);

      void lspEnsureServer({ workstudioId: wsId, languageId }).catch((e) => {
        ensuredLspLangRef.current.delete(languageId);
        setLspEnsureErrors((prev) => ({
          ...prev,
          [languageId]: e instanceof Error ? e.message : String(e),
        }));
      });
    }
  }, [
    ws?.id,
    uiStateRestored,
    lspListenerReadyWsId,
    lspAutoConfigStatus,
    wsEnabledLspLanguageIds,
    projectAutoDetectedLspLanguageFingerprint,
    codeIntelligenceConfig?.enabled,
    lspConfigFingerprint,
    isLspLanguageEnabledForWorkstudio,
  ]);

  // 当 workstudio 语言筛选/全局配置变化导致“有效启用语言”减少时，主动 shutdown 对应 LSP 进程，避免后台残留。
  const prevEnabledLspLanguageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    prevEnabledLspLanguageIdsRef.current = new Set();
  }, [ws?.id]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!uiStateRestored) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;

    const prev = prevEnabledLspLanguageIdsRef.current;
    const next = new Set(enabledLspLanguageIds);
    prevEnabledLspLanguageIdsRef.current = next;

    const removed: string[] = [];
    for (const lang of prev) {
      if (!next.has(lang)) removed.push(lang);
    }
    if (removed.length === 0) return;

    for (const lang of removed) {
      ensuredLspLangRef.current.delete(lang);
      void lspShutdownLanguage(wsId, lang).catch((e) => {
        console.warn('[Workstudio][LSP] shutdown language failed:', { workstudioId: wsId, languageId: lang, e });
      });
      setLspEnsureErrors((prevErr) => {
        if (!prevErr[lang]) return prevErr;
        const nextErr = { ...prevErr };
        delete nextErr[lang];
        return nextErr;
      });
      setLspProgress((prevProg) => {
        if (!prevProg[lang]) return prevProg;
        const nextProg = { ...prevProg };
        delete nextProg[lang];
        return nextProg;
      });
      setLspExited((prevExited) => {
        if (!prevExited[lang]) return prevExited;
        const nextExited = { ...prevExited };
        delete nextExited[lang];
        return nextExited;
      });
    }
  }, [enabledLspLanguageIds, isLspLanguageEnabledForWorkstudio, uiStateRestored, ws?.id]);

  // Poll LSP server runtime status (started/initialized/lastError).
  useEffect(() => {
    if (!isTauri()) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;

    let disposed = false;
    const tick = async () => {
      try {
        const cfg = useConfigStore.getState().config?.codeIntelligence ?? null;
        if (!cfg?.enabled) {
          if (!disposed) setLspStatuses([]);
          return;
        }
        const res = await lspStatus(wsId);
        if (disposed) return;
        setLspStatuses(res);
      } catch {
        // ignore
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void tick();
    }, 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [ws?.id]);

  // Listen to server->client notifications to surface progress/logs.
  useEffect(() => {
    if (!isTauri()) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;

    setLspListenerReadyWsId(null);
    let disposed = false;
    let unlisten: null | (() => void) = null;
    void listen('lsp:event', (event) => {
      const payload = (event as any)?.payload as any;
      if (!payload) return;
      if (payload.workstudioId !== wsId) return;

      const languageId = String(payload.languageId || 'unknown');
      const now = typeof payload.timestampMs === 'number' ? payload.timestampMs : Date.now();

      const pushLog = (line: string) => {
        const text = String(line || '').trim();
        if (!text) return;
        setLspLogs((prev) => {
          const next = { ...prev };
          const list = [...(next[languageId] ?? []), text];
          if (list.length > 240) list.splice(0, list.length - 240);
          next[languageId] = list;
          return next;
        });
      };

      if (payload.type === 'stderr') {
        pushLog(`[stderr] ${String(payload.line ?? '')}`);
        return;
      }

      if (payload.type === 'exited') {
        setLspExited((prev) => ({
          ...prev,
          [languageId]: { code: payload.code ?? null, signal: payload.signal ?? null, timestampMs: now },
        }));
        setLspProgress((prev) => {
          const next = { ...prev };
          if (next[languageId]) delete next[languageId];
          return next;
        });
        pushLog(`[exited] code=${payload.code ?? 'null'} signal=${payload.signal ?? 'null'}`);
        return;
      }

      if (payload.type !== 'notification') return;

      const method = String(payload.method || '').trim();
      const params = payload.params ?? null;
      if (!method) return;

      if (method === '$/progress') {
        const tokenRaw = (params as any)?.token;
        const token = tokenRaw === null || tokenRaw === undefined ? '' : String(tokenRaw);
        const value = (params as any)?.value ?? null;
        const kind = String(value?.kind ?? '').trim();
        if (!token || !kind) return;

        if (kind === 'end') {
          setLspProgress((prev) => {
            const next = { ...prev };
            const byToken = { ...(next[languageId] ?? {}) };
            if (byToken[token]) delete byToken[token];
            next[languageId] = byToken;
            return next;
          });
          return;
        }

        const title = String(value?.title ?? '').trim() || 'Progress';
        const message = String(value?.message ?? '').trim() || undefined;
        const percentage =
          typeof value?.percentage === 'number' && Number.isFinite(value.percentage) ? value.percentage : undefined;
        setLspProgress((prev) => {
          const next = { ...prev };
          const byToken = { ...(next[languageId] ?? {}) };
          byToken[token] = { title, message, percentage, updatedAtMs: now };
          next[languageId] = byToken;
          return next;
        });
        return;
      }

      if (method === 'window/logMessage' || method === 'window/showMessage') {
        const msg = String((params as any)?.message ?? '').trim();
        if (!msg) return;
        pushLog(`[${method}] ${msg}`);
        return;
      }

      if (method.startsWith('rust-analyzer/')) {
        pushLog(`[${method}] ${JSON.stringify(params)}`);
        return;
      }

      // Best-effort: do not spam logs for every notification (publishDiagnostics is handled by Monaco bridge).
      if (method === 'textDocument/publishDiagnostics') return;
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
        setLspListenerReadyWsId(wsId);
      })
      .catch((e) => {
        console.warn('[Workstudio][LSP] listen lsp:event failed:', e);
        if (!disposed) setLspListenerReadyWsId(wsId);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ws?.id]);

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
    if (!contextMenu && !tabMenu && !lspMenu) return;
    const onDown = () => {
      setContextMenu(null);
      setTabMenu(null);
      setLspMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [contextMenu, lspMenu, tabMenu]);

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
      {navToast && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[200]">
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
            {navToast}
          </div>
        </div>
      )}
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
	            <div className="flex min-w-0 items-center gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!canNavigateBack}
                    onClick={() => void navigateBack()}
                    title={`后退（${navigateBackShortcutLabel}）`}
                    aria-label="后退"
                    className="rounded border border-gray-200 p-1 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-900/40"
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={!canNavigateForward}
                    onClick={() => void navigateForward()}
                    title={`前进（${navigateForwardShortcutLabel}）`}
                    aria-label="前进"
                    className="rounded border border-gray-200 p-1 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-900/40"
                  >
                    <ArrowRight size={14} />
                  </button>
                </div>

	            <div className="min-w-0 text-xs text-gray-600 dark:text-gray-300">
	              窗格: {resolvedPanes.length}{' '}
	              <span className="text-gray-400">
	                （聚焦 {Math.max(1, resolvedPanes.findIndex((p) => p.id === resolvedFocusedPaneId) + 1)}）
	              </span>
	            </div>
              </div>
		            <div className="flex items-center gap-2">
                {isStandaloneWorkstudioWindow && (
                  <button
                    type="button"
                    className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    onClick={() => void returnToMainWindow()}
                    title={`返回主窗口（${backToMainShortcutLabel}）`}
                  >
                    返回主窗口
                  </button>
                )}
                <button
                  ref={lspStatusButtonRef}
                  type="button"
                  className="inline-flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  onClick={() => {
                    const btn = lspStatusButtonRef.current;
                    if (!btn) return;
                    if (lspMenu) {
                      setLspMenu(null);
                      return;
                    }
                    const rect = btn.getBoundingClientRect();
                    const menuWidth = 480;
                    const x = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
                    setLspMenu({ visible: true, x, y: rect.bottom + 4 });
                  }}
                  title={lspSummary.title}
                >
                  <span className={['h-2 w-2 rounded-full', lspSummary.dotClass].join(' ')} />
                  <span className="whitespace-nowrap">{lspSummary.label}</span>
                  <ChevronDown size={12} className="opacity-70" />
                </button>
                <button
                  type="button"
                  className={[
                    'inline-flex items-center gap-2 rounded border px-2 py-1 text-xs',
                    outlineOpen
                      ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-200 dark:hover:bg-blue-900/40'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800',
                  ].join(' ')}
                  onClick={() => setOutlineOpen((v) => !v)}
                  title={outlineOpen ? '隐藏 Outline' : '显示 Outline'}
                >
                  <ListTree size={12} />
                  <span className="whitespace-nowrap">Outline{outlineItemCount > 0 ? `(${outlineItemCount})` : ''}</span>
                </button>
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

		          <div className="flex min-h-0 flex-1 overflow-hidden">
		            <div className="min-w-0 flex-1 overflow-hidden">
		          <DndContext
		            sensors={sensors}
		            collisionDetection={collisionDetection}
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
	                                    pinnedWhileDragging={pinActiveTabWhileDragging && activeDragTabId === file.id}
	                                    onClick={() => activateTabInPane(pane.id, file.id)}
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
	                              <div className="h-full w-full" onWheelCapture={onEditorWheelCapture}>
	                                <Editor
	                                  path={toMonacoModelPath(activeFile.path)}
	                                  language={languageForPath(activeFile.path)}
	                                  value={activeFile.content ?? ''}
	                                  // Configure MonacoEnvironment workers before the editor initializes.
	                                  // Otherwise Monaco may route TS/JS language-service requests to the simple editor worker,
	                                  // leading to errors like: "Missing requestHandler or method: getQuickInfoAtPosition".
	                                  beforeMount={setupMonaco}
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
	                                    codeLens: false,
	                                    fontSize: editorFontSize,
	                                    fontFamily:
	                                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	                                    lineNumbers: 'on',
	                                    wordWrap: 'on',
	                                    renderWhitespace: 'selection',
	                                    automaticLayout: true,
	                                    scrollBeyondLastLine: false,
	                                  }}
	                                />
	                              </div>
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

	            {!isTauri() && (
	              <DragOverlay>
	                {activeDragTabId ? (
	                  <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
	                    {openFiles.find((f) => f.id === activeDragTabId)?.title ?? basename(activeDragTabId)}
	                  </div>
	                ) : null}
	              </DragOverlay>
	            )}

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

		            {outlineOpen && (
		              <div className="flex w-[300px] flex-shrink-0 flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
		                <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
		                  <div className="min-w-0 flex-1">
		                    <div className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">
		                      Outline
		                    </div>
		                    <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">
		                      {activeTextFileInFocusedPane
		                        ? `${basename(activeTextFileInFocusedPane.path)}${outlineSourceLabel ? ` · ${outlineSourceLabel}` : ''}`
		                        : '当前无文本文件'}
		                    </div>
		                  </div>
		                  <button
		                    type="button"
		                    className="rounded border border-gray-200 p-1 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
		                    onClick={() => setOutlineRefreshSeq((v) => v + 1)}
		                    title="刷新 Outline"
		                  >
		                    <RefreshCw size={12} />
		                  </button>
		                </div>
		                <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
		                  {!activeTextFileInFocusedPane ? (
		                    <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
		                      打开文本文件后可查看函数、属性与符号结构。
		                    </div>
		                  ) : outlineLoading ? (
		                    <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
		                      生成 Outline 中...
		                    </div>
		                  ) : outlineError ? (
		                    <div className="px-2 py-2 text-xs text-red-600 dark:text-red-300">
		                      {outlineError}
		                    </div>
		                  ) : outlineItems.length === 0 ? (
		                    <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
		                      未检测到可展示的符号。
		                    </div>
		                  ) : (
		                    <div className="space-y-0.5">
		                      {renderOutlineNodes(outlineItems)}
		                    </div>
		                  )}
		                </div>
		              </div>
		            )}
		          </div>

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

      {lspMenu && (
        <div
          className="fixed z-[220] w-[480px] max-w-[92vw] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ left: lspMenu.x, top: lspMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">代码智能</div>
              <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400" title="LSP: rust-analyzer / pylsp / clangd / lua-language-server 等">
                LSP 状态与进度（多语言索引/就绪）
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <button
                type="button"
                className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => void restartLspBridge()}
                title="重启 Monaco-LSP Bridge（会重启所有 LSP 进程）"
              >
                重启
              </button>
              <button
                type="button"
                className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => void copyAllLspLogs()}
                title="复制所有语言的 LSP 输出日志"
              >
                复制日志
              </button>
              <button
                type="button"
                className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => setLspLogs({})}
                title="清空 LSP 日志"
              >
                清空日志
              </button>
              <button
                type="button"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                onClick={() => setLspMenu(null)}
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="max-h-[70vh] overflow-auto px-3 py-3">
            {!isTauri() ? (
              <div className="text-sm text-gray-600 dark:text-gray-300">仅桌面端支持 LSP。</div>
            ) : (
              <div className="space-y-3">
                {!codeIntelligenceConfig?.enabled && (
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    代码智能已关闭：在 设置 → Code Intelligence 中开启。
                  </div>
                )}

                {lspMenuServers.length === 0 ? (
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    未配置 LSP server：在 设置 → Code Intelligence 中添加 rust-analyzer / pylsp / clangd / lua-language-server 等。
                  </div>
                ) : (
                  <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                        本工作区启用语言
                      </div>
                      {wsEnabledLspLanguageIds !== null && (
                        <button
                          type="button"
                          className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                          onClick={restoreWorkstudioLspLanguageAuto}
                          title="恢复自动：按项目文件自动启用语言"
                        >
                          恢复自动
                        </button>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      {configuredLspLanguageIds.map((lang) => (
                        <label
                          key={`ws:lsp:lang:${lang}`}
                          className="inline-flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-700 dark:border-gray-700 dark:text-gray-200"
                        >
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-blue-600"
                            checked={wsSelectedLspLanguageIdSet.has(lang)}
                            onChange={() => toggleWorkstudioLspLanguage(lang)}
                          />
                          <span className="font-mono">{lang}</span>
                        </label>
                      ))}
                    </div>

                    <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                      {wsEnabledLspLanguageIds === null ? '当前：自动（按项目文件检测）' : '当前：自定义（仅启用勾选语言）'}
                    </div>
                  </div>
                )}

                {codeIntelligenceConfig?.enabled && lspMenuServers.length > 0 && (
                  <>
                    {wsSelectedLspLanguageIds.length === 0 ? (
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        本工作区未启用任何语言：请在上方勾选需要的语言。
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {lspMenuServers
                          .filter((s) => wsSelectedLspLanguageIdSet.has(s.languageId))
                          .map((s) => {
                            const lang = s.languageId;
                            const desc = describeLspLanguage(lang);
                            const configuredOk = s.enabled && Boolean(s.command);
                            const effectiveDot = configuredOk ? desc.dotClass : s.enabled ? 'bg-red-500' : 'bg-gray-400';
                            const statusText = !s.enabled
                              ? '已禁用'
                              : !s.command
                                ? '命令为空'
                                : desc.label;

                            const cmdLine = s.command ? [s.command, ...(s.args ?? [])].join(' ') : '（未配置命令）';
                            const logs = lspLogs[lang] ?? [];
                            const expanded = Boolean(lspLogExpanded[lang]);
                            const lastLogs = logs.slice(-3);

                            return (
                              <div
                                key={`${lang}:${cmdLine}`}
                                className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className={['h-2 w-2 rounded-full', effectiveDot].join(' ')} />
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                                            {lang}
                                          </span>
                                          <span className="text-[11px] text-gray-500 dark:text-gray-400">
                                            {statusText}
                                          </span>
                                        </div>
                                        <div
                                          className="mt-0.5 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400"
                                          title={cmdLine}
                                        >
                                          {cmdLine}
                                        </div>
                                      </div>
                                    </div>

                                    {configuredOk && desc.progressText && (
                                      <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-300">
                                        进度：{desc.progressText}
                                      </div>
                                    )}

                                    {desc.exitedText && (
                                      <div className="mt-1 text-[11px] text-orange-700 dark:text-orange-200">
                                        {desc.exitedText}
                                      </div>
                                    )}

                                    {desc.lastError && (
                                      <div className="mt-1 text-[11px] text-red-700 dark:text-red-200">
                                        错误：{desc.lastError}
                                      </div>
                                    )}

                                    {!expanded && lastLogs.length > 0 && (
                                      <div className="mt-1 space-y-0.5 rounded bg-gray-50 px-2 py-1 font-mono text-[10px] text-gray-700 dark:bg-gray-950 dark:text-gray-300">
                                        {lastLogs.map((line, idx) => (
                                          <div key={`${lang}:log:${idx}`} className="truncate" title={line}>
                                            {line}
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {expanded && logs.length > 0 && (
                                      <div className="mt-1 max-h-[220px] overflow-auto rounded bg-gray-50 px-2 py-1 font-mono text-[10px] text-gray-700 dark:bg-gray-950 dark:text-gray-300 whitespace-pre-wrap break-words">
                                        {logs.map((line, idx) => (
                                          <div key={`${lang}:log:full:${idx}`} className="whitespace-pre-wrap break-words">
                                            {line}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex flex-shrink-0 items-center gap-1">
                                    <button
                                      type="button"
                                      className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                                      disabled={logs.length === 0}
                                      onClick={() => void copyLspLogsForLanguage(lang)}
                                      title="复制该语言日志"
                                    >
                                      复制
                                    </button>
                                    {logs.length > 0 && (
                                      <button
                                        type="button"
                                        className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                                        onClick={() =>
                                          setLspLogExpanded((prev) => ({
                                            ...prev,
                                            [lang]: !Boolean(prev[lang]),
                                          }))
                                        }
                                        title={expanded ? '收起日志' : '展开日志'}
                                      >
                                        {expanded ? '收起' : '展开'}
                                      </button>
                                    )}
                                    {s.enabled && (
                                      <button
                                        type="button"
                                        className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                                        disabled={!s.command}
                                        onClick={() => void ensureLspForLanguage(lang)}
                                        title={!s.command ? '请先在设置中填写启动命令' : '启动/初始化该语言的 LSP'}
                                      >
                                        启动
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}

                        <div className="pt-1 text-[11px] text-gray-500 dark:text-gray-400">
                          提示：某些语言服务器首次索引可能需要一段时间；索引进度会通过 <code>$/progress</code> 显示在这里。
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
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
