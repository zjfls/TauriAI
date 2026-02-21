import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
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
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  ListTree,
  MessageSquare,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  CodeSnippetContentPart,
  Conversation,
  LspServerStatus,
  MessageBlock,
  MessageTurn,
  RunEventPayload,
  TerminalScope,
  Workstudio,
  WorkstudioSymbolAnalysis,
  WorkstudioUiState,
} from '../../types';
import { SHORTCUT_ACTIONS, detectShortcutPlatform, normalizeKeybindingString } from '../../shortcuts';
import {
  astDocumentSymbols,
  codeIndexRequestDocumentSymbols,
  codeIndexSummary,
  codeIndexStartWorkspaceScan,
  deleteWorkstudioSymbolAnalysis,
  getMessages,
  getWorkstudioSymbolAnalysis,
  saveWorkstudioSymbolAnalysis,
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
import { MarkdownRenderer } from '../Chat/MarkdownRenderer';
import { MessageBlocks } from '../Chat/MessageBlocks';
import { setupMonaco } from '../../utils/monaco';
import { attachMonacoLspBridge } from '../../utils/monacoLspBridge';
import { attachMonacoAiCompletionBridge } from '../../utils/monacoAiCompletionBridge';
import { TerminalSurface, type TerminalSurfaceHandle } from '../Terminal/TerminalSurface';
import { DeferredMarkdown } from '../Chat/DeferredMarkdown';

type DirEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

type OpenFile = {
  id: string;
  title: string;
  path: string;
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'markdown';
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

type InlineChatSelection = {
  filePath: string;
  languageId: string;
  text: string;
  range: OutlineRange;
  label: string;
};

type WorkstudioAiBubbleKind = 'inline_chat' | 'symbol_analysis' | 'agent_run';

// Streaming state machine for AI Bubbles
// idle → queued → connecting → thinking → streaming → tool_calling → done / error
type WorkstudioAiBubbleStatus =
  | 'idle'
  | 'queued'
  | 'connecting'
  | 'thinking'
  | 'streaming'
  | 'tool_calling'
  | 'done'
  | 'error';

type WorkstudioToolCallEntry = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
};

type WorkstudioSymbolAnalysisMeta = {
  workstudioId: string;
  languageId: string;
  filePath: string;
  symbolKey: string;
  symbolName: string;
  symbolKind: string;
  selectionLine: number;
  selectionColumn: number;
  range: OutlineRange;
};

type WorkstudioAiBubble = {
  id: string;
  kind: WorkstudioAiBubbleKind;
  name: string;
  subtitle: string;
  /** Original prompt shown to the AI (collapsible for user) */
  prompt: string;
  status: WorkstudioAiBubbleStatus;
  /** Streamed text content (updated in real-time) */
  answer?: string;
  /** Streamed thinking / reasoning content (collapsible) */
  thinking?: string;
  /** Tool calls made during the run */
  toolCalls?: WorkstudioToolCallEntry[];
  /** When driven by `run_task`, this is the backing conversation id */
  conversationId?: string;
  assistantMessageId?: string;
  /** Unified blocks (same schema as ChatView) */
  blocks?: MessageBlock[];
  turns?: MessageTurn[];
  /** Name of the agent that produced this bubble */
  agentName?: string;
  /** Optional meta for persisting symbol analysis results */
  analysisMeta?: WorkstudioSymbolAnalysisMeta;
  /** Snapshot code snippet for symbol analysis (avoids relying on editor state later) */
  analysisCode?: string;
  error?: string;
  modelRef?: string;
  latencyMs?: number;
  startedAtMs?: number;
  createdAt: string;
};

type OutlineItem = {
  id: string;
  key: string;
  name: string;
  kind: string;
  detail: string;
  range: OutlineRange;
  selectionLine: number;
  selectionColumn: number;
  children: OutlineItem[];
};

type OutlineFileViewState = {
  collapsedKeys: string[];
  activeKey?: string;
  recentKeys: string[];
  scrollTop?: number;
  updatedAtMs: number;
};

const DEFAULT_EDITOR_FONT_SIZE = 13;
const MIN_EDITOR_FONT_SIZE = 10;
const MAX_EDITOR_FONT_SIZE = 28;
const OUTLINE_RECENT_KEY_LIMIT = 64;
const OUTLINE_FILE_STATE_LIMIT = 120;
const OUTLINE_COLLAPSED_KEY_LIMIT = 512;

// Code Index（落盘缓存）优先级：数值越大越优先。
// 与后端约定保持一致（index_manager.rs），但前端不强依赖具体实现细节。
const CODE_INDEX_PRIORITY_USER = 120;
const CODE_INDEX_PRIORITY_OPEN_FILE = 80;
const CODE_INDEX_PRIORITY_SAVE_FILE = 60;
const CODE_INDEX_PRIORITY_BACKGROUND = 10;

type LspIndexBrief = {
  languageId: string;
  completedAtMs: number;
  durationMs?: number;
  lastProgress?: string;
  commandLine?: string;
  hadError?: boolean;
};

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

const toErrorMessage = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const maybeError = (err as { error?: unknown }).error;
    if (typeof maybeError === 'string' && maybeError.trim()) return maybeError.trim();
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.trim()) return maybe.trim();
  }
  try {
    const s = JSON.stringify(err);
    return typeof s === 'string' && s.trim() ? s : String(err);
  } catch {
    return String(err);
  }
};

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
};

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

const normalizeOutlineKind = (kind: string): string =>
  String(kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') || 'symbol';

const OUTLINE_CONTAINER_KINDS = new Set<string>([
  'class',
  'struct',
  'interface',
  'enum',
  'trait',
  'impl',
  'module',
  'namespace',
  'package',
  'object',
]);
const OUTLINE_CALLABLE_KINDS = new Set<string>(['method', 'function', 'constructor', 'operator']);
const OUTLINE_VALUE_KINDS = new Set<string>([
  'property',
  'field',
  'variable',
  'constant',
  'enum_member',
  'parameter',
  'type_param',
]);

const outlineKindRank = (kind: string): number => {
  const normalized = normalizeOutlineKind(kind);
  if (OUTLINE_CONTAINER_KINDS.has(normalized)) return 0;
  if (OUTLINE_CALLABLE_KINDS.has(normalized)) return 1;
  if (OUTLINE_VALUE_KINDS.has(normalized)) return 2;
  return 3;
};

const compareOutlinePosition = (a: OutlineItem, b: OutlineItem): number => {
  if (a.selectionLine !== b.selectionLine) return a.selectionLine - b.selectionLine;
  if (a.selectionColumn !== b.selectionColumn) return a.selectionColumn - b.selectionColumn;
  if (a.range.endLine !== b.range.endLine) return b.range.endLine - a.range.endLine;
  if (a.range.endColumn !== b.range.endColumn) return b.range.endColumn - a.range.endColumn;
  const kindDiff = outlineKindRank(a.kind) - outlineKindRank(b.kind);
  if (kindDiff !== 0) return kindDiff;
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) return nameDiff;
  return a.detail.localeCompare(b.detail);
};

const outlineRangeContains = (parent: OutlineItem, child: OutlineItem): boolean => {
  const startsBefore =
    parent.range.startLine < child.range.startLine ||
    (parent.range.startLine === child.range.startLine &&
      parent.range.startColumn <= child.range.startColumn);
  const endsAfter =
    parent.range.endLine > child.range.endLine ||
    (parent.range.endLine === child.range.endLine &&
      parent.range.endColumn >= child.range.endColumn);
  const sameRange =
    parent.range.startLine === child.range.startLine &&
    parent.range.startColumn === child.range.startColumn &&
    parent.range.endLine === child.range.endLine &&
    parent.range.endColumn === child.range.endColumn;
  return startsBefore && endsAfter && !sameRange;
};

const outlineCanContain = (parent: OutlineItem, child: OutlineItem): boolean => {
  const parentKind = normalizeOutlineKind(parent.kind);
  const childKind = normalizeOutlineKind(child.kind);
  if (OUTLINE_VALUE_KINDS.has(parentKind)) return false;
  if (OUTLINE_CALLABLE_KINDS.has(parentKind)) {
    return OUTLINE_VALUE_KINDS.has(childKind) || OUTLINE_CALLABLE_KINDS.has(childKind) || childKind === 'symbol';
  }
  if (OUTLINE_CONTAINER_KINDS.has(parentKind)) return true;
  return true;
};

const flattenOutlineItems = (items: OutlineItem[]): OutlineItem[] => {
  const out: OutlineItem[] = [];
  const walk = (nodes: OutlineItem[]) => {
    for (const node of nodes) {
      out.push({ ...node, children: [] });
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(items);
  return out;
};

const describeWorkstudioAiBubbleStatus = (status: WorkstudioAiBubbleStatus): string => {
  switch (status) {
    case 'queued':
      return '排队中…';
    case 'connecting':
      return '连接中…';
    case 'thinking':
      return '正在思考…';
    case 'tool_calling':
      return '调用工具…';
    case 'streaming':
      return '生成中…';
    case 'done':
      return '完成，点击查看';
    case 'error':
      return '失败，点击查看';
    case 'idle':
    default:
      return '请求中…';
  }
};

const buildOutlineHierarchy = (flatItems: OutlineItem[]): OutlineItem[] => {
  const nodes = flatItems.map((node) => ({ ...node, children: [] as OutlineItem[] }));
  nodes.sort(compareOutlinePosition);

  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];

  for (const node of nodes) {
    while (stack.length > 0 && !outlineRangeContains(stack[stack.length - 1]!, node)) {
      stack.pop();
    }

    let parent: OutlineItem | null = null;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const candidate = stack[index]!;
      if (!outlineRangeContains(candidate, node)) continue;
      if (!outlineCanContain(candidate, node)) continue;
      parent = candidate;
      break;
    }

    if (parent) parent.children.push(node);
    else roots.push(node);

    stack.push(node);
  }

  return roots;
};

const sortOutlineTree = (items: OutlineItem[]): void => {
  items.sort(compareOutlinePosition);
  for (const item of items) {
    if (item.children.length > 0) sortOutlineTree(item.children);
  }
};

const assignOutlineStableKeys = (items: OutlineItem[]): OutlineItem[] => {
  const seen = new Map<string, number>();
  const walk = (nodes: OutlineItem[]): OutlineItem[] =>
    nodes.map((node) => {
      const base = `${normalizeOutlineKind(node.kind)}:${node.name}:${node.selectionLine}:${node.selectionColumn}:${node.range.endLine}:${node.range.endColumn}`;
      const nextCount = (seen.get(base) ?? 0) + 1;
      seen.set(base, nextCount);
      const key = nextCount === 1 ? base : `${base}#${nextCount}`;
      return {
        ...node,
        id: key,
        key,
        children: walk(node.children),
      };
    });
  return walk(items);
};

const normalizeOutlineItems = (items: OutlineItem[]): OutlineItem[] => {
  if (items.length === 0) return [];
  const flat = flattenOutlineItems(items);
  if (flat.length === 0) return [];
  const tree = buildOutlineHierarchy(flat);
  sortOutlineTree(tree);
  return assignOutlineStableKeys(tree);
};

const collectOutlineKeys = (items: OutlineItem[]): Set<string> => {
  const keys = new Set<string>();
  const walk = (nodes: OutlineItem[]) => {
    for (const node of nodes) {
      keys.add(node.key);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(items);
  return keys;
};

const collectOutlineCollapsibleKeys = (items: OutlineItem[]): string[] => {
  const keys: string[] = [];
  const walk = (nodes: OutlineItem[]) => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        keys.push(node.key);
        walk(node.children);
      }
    }
  };
  walk(items);
  return keys;
};

const trimOutlineRecentKeys = (keys: string[]): string[] => {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = String(raw ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
    if (unique.length >= OUTLINE_RECENT_KEY_LIMIT) break;
  }
  return unique;
};

const trimOutlineCollapsedKeys = (keys: string[]): string[] => {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = String(raw ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
    if (unique.length >= OUTLINE_COLLAPSED_KEY_LIMIT) break;
  }
  return unique;
};

const normalizeOutlineFileViewState = (raw: any): OutlineFileViewState => {
  const collapsedKeys = Array.isArray(raw?.collapsedKeys)
    ? trimOutlineCollapsedKeys(raw.collapsedKeys)
    : [];
  const activeKeyRaw = String(raw?.activeKey ?? '').trim();
  const recentKeys = Array.isArray(raw?.recentKeys) ? trimOutlineRecentKeys(raw.recentKeys) : [];
  const scrollTop =
    typeof raw?.scrollTop === 'number' && Number.isFinite(raw.scrollTop) && raw.scrollTop >= 0
      ? Math.floor(raw.scrollTop)
      : undefined;
  const updatedAtMs =
    typeof raw?.updatedAtMs === 'number' && Number.isFinite(raw.updatedAtMs)
      ? Math.floor(raw.updatedAtMs)
      : Date.now();
  return {
    collapsedKeys,
    activeKey: activeKeyRaw || undefined,
    recentKeys,
    scrollTop,
    updatedAtMs,
  };
};

const normalizeOutlineFileStateMap = (raw: any): Record<string, OutlineFileViewState> => {
  if (!raw || typeof raw !== 'object') return {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return {};
  const normalized: Array<[string, OutlineFileViewState]> = [];
  for (const [filePathRaw, value] of entries) {
    const filePath = normalizeFsPath(String(filePathRaw ?? '').trim());
    if (!filePath) continue;
    normalized.push([filePath, normalizeOutlineFileViewState(value)]);
  }
  normalized.sort((a, b) => (b[1].updatedAtMs ?? 0) - (a[1].updatedAtMs ?? 0));
  return Object.fromEntries(normalized.slice(0, OUTLINE_FILE_STATE_LIMIT));
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
      key: id,
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
      key: `si:${index}:${name}:${range.startLine}:${range.startColumn}`,
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
    const flat = result
      .map((node, index) => fromSymbolInformation(node, index))
      .filter(Boolean) as OutlineItem[];
    return normalizeOutlineItems(flat);
  }

  const tree = result
    .map((node, index) => fromDocumentSymbol(node, 'ds', index))
    .filter(Boolean) as OutlineItem[];
  return normalizeOutlineItems(tree);
};

const astSymbolsToOutline = (symbols: any, parentKey = 'ast'): OutlineItem[] => {
  if (!Array.isArray(symbols)) return [];
  const tree = symbols
    .map((node: any, index: number) => {
      const name = String(node?.name ?? '').trim();
      if (!name) return null;
      const range = toOutlineRangeFromLsp(node?.range ?? null);
      const selection = toOutlineRangeFromLsp(node?.selectionRange ?? node?.range ?? null);
      const id = `${parentKey}:${index}:${name}:${selection.startLine}:${selection.startColumn}`;
      const children = astSymbolsToOutline(node?.children ?? [], id);
      return {
        id,
        key: id,
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
  return normalizeOutlineItems(tree);
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
  const aiCompletionBridgeRef = useRef<{ dispose: () => void } | null>(null);
  const aiCompletionBridgeWorkstudioIdRef = useRef<string | null>(null);
  const explorerContainerRef = useRef<HTMLDivElement | null>(null);
  const outlineContainerRef = useRef<HTMLDivElement | null>(null);
  const outlineScrollSaveTimerRef = useRef<number | null>(null);
  const openFilesRef = useRef<OpenFile[]>([]);
  const openingPathsRef = useRef<Set<string>>(new Set());
  const filePaletteInputRef = useRef<HTMLInputElement | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalSurfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const [inlineChatComposer, setInlineChatComposer] = useState<{
    open: boolean;
    selection: InlineChatSelection | null;
    question: string;
  }>({ open: false, selection: null, question: '' });
  const openInlineChatComposer = useCallback((selection: InlineChatSelection) => {
    setInlineChatComposer({ open: true, selection, question: '' });
  }, []);
  const closeInlineChatComposer = useCallback(() => {
    setInlineChatComposer((prev) => ({ ...prev, open: false }));
  }, []);
  const [aiBubbles, setAiBubbles] = useState<WorkstudioAiBubble[]>([]);
  const aiBubblesRef = useRef<WorkstudioAiBubble[]>([]);
  const activeSymbolAnalysisKeysRef = useRef<Set<string>>(new Set());
  const symbolAnalysisKeyByConversationIdRef = useRef<Map<string, string>>(new Map());
  const symbolAnalysisConversationIdByBubbleIdRef = useRef<Map<string, string>>(new Map());
  const symbolAnalysisBubbleIdByConversationIdRef = useRef<Map<string, string>>(new Map());
  const cancelledSymbolAnalysisBubbleIdsRef = useRef<Set<string>>(new Set());
  const scheduleSymbolAnalysisRunsRef = useRef<(() => void) | null>(null);
  const symbolAnalysisRoundRobinCursorRef = useRef<number>(0);
  const startingSymbolAnalysisBubbleIdsRef = useRef<Set<string>>(new Set());
  const trackedRunConversationsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    aiBubblesRef.current = aiBubbles;
  }, [aiBubbles]);
  const symbolAnalysisQueuedCount = useMemo(
    () => aiBubbles.filter((b) => b.kind === 'symbol_analysis' && b.status === 'queued').length,
    [aiBubbles]
  );
  const symbolAnalysisActiveCount = useMemo(() => {
    const ACTIVE: WorkstudioAiBubbleStatus[] = ['connecting', 'thinking', 'streaming', 'tool_calling'];
    return aiBubbles.filter((b) => b.kind === 'symbol_analysis' && ACTIVE.includes(b.status)).length;
  }, [aiBubbles]);
  const [aiViewerId, setAiViewerId] = useState<string | null>(null);
  const aiViewer = useMemo(() => {
    if (!aiViewerId) return null;
    return aiBubbles.find((b) => b.id === aiViewerId) ?? null;
  }, [aiBubbles, aiViewerId]);
  const openAiViewer = useCallback((id: string) => setAiViewerId(id), []);
  const closeAiViewer = useCallback(() => {
    if (!aiViewerId) return;
    const bubble = aiBubblesRef.current.find((b) => b.id === aiViewerId) ?? null;
    const ACTIVE_STATUSES: WorkstudioAiBubbleStatus[] = [
      'queued',
      'connecting',
      'thinking',
      'streaming',
      'tool_calling',
    ];
    const isActive = bubble ? ACTIVE_STATUSES.includes(bubble.status) : false;
    if (isActive) {
      // 生成中：只关闭查看窗口，不移除气泡（避免丢失进度/落盘逻辑）。
      setAiViewerId(null);
      return;
    }

    if (bubble?.conversationId) {
      trackedRunConversationsRef.current.delete(bubble.conversationId);
    }
    setAiBubbles((prev) => prev.filter((b) => b.id !== aiViewerId));
    setAiViewerId(null);
  }, [aiViewerId]);

  // ── workstudio:agent:event listener ─────────────────────────────────
  // Listens to streaming events from `workstudio_run_agent_stream` and
  // drives the Bubble state machine in real-time.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Lazily import listen to avoid crashing in non-Tauri environments
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        // `listen` is already imported at the top of this file
        unlisten = await listen<{
          type: string;
          run_id: string;
          delta?: string;
          answer_md?: string;
          model_ref?: string;
          latency_ms?: number;
          message?: string;
          id?: string;
          name?: string;
          arguments?: string;
        }>('workstudio:agent:event', (ev) => {
          const { type: evType, run_id } = ev.payload;
          setAiBubbles((prev) => prev.map((b) => {
            if (b.id !== run_id) return b;
            switch (evType) {
              case 'text_delta':
                return {
                  ...b,
                  status: 'streaming' as WorkstudioAiBubbleStatus,
                  answer: (b.answer ?? '') + (ev.payload.delta ?? ''),
                };
              case 'thinking_delta':
                return {
                  ...b,
                  status: 'thinking' as WorkstudioAiBubbleStatus,
                  thinking: (b.thinking ?? '') + (ev.payload.delta ?? ''),
                };
              case 'tool_call': {
                const entry: WorkstudioToolCallEntry = {
                  id: ev.payload.id ?? crypto.randomUUID(),
                  name: ev.payload.name ?? '',
                  arguments: ev.payload.arguments ?? '',
                };
                return {
                  ...b,
                  status: 'tool_calling' as WorkstudioAiBubbleStatus,
                  toolCalls: [...(b.toolCalls ?? []), entry],
                };
              }
              case 'done':
                return {
                  ...b,
                  status: 'done' as WorkstudioAiBubbleStatus,
                  answer: ev.payload.answer_md ?? b.answer,
                  modelRef: ev.payload.model_ref ?? b.modelRef,
                  latencyMs: ev.payload.latency_ms ?? b.latencyMs,
                };
              case 'error':
                return {
                  ...b,
                  status: 'error' as WorkstudioAiBubbleStatus,
                  error: ev.payload.message ?? 'Unknown error',
                };
              default:
                return b;
            }
          }));
        });
      } catch {
        // Not in Tauri or listen failed — ignore
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  const chatWithAgentRef = useConfigStore((s) => s.config?.codeIntelligence?.aiCompletion?.chatWithAgentRef);

  const submitInlineChat = useCallback(async () => {
    const selection = inlineChatComposer.selection;
    const question = inlineChatComposer.question.trim();
    if (!selection || !question) return;

    const id = crypto.randomUUID();
    const name = question.length > 28 ? `${question.slice(0, 28)}…` : question;
    const createdAt = new Date().toISOString();
    const bubble: WorkstudioAiBubble = {
      id,
      kind: 'inline_chat',
      name,
      subtitle: selection.label,
      prompt: question,
      status: 'connecting',
      createdAt,
    };
    setAiBubbles((prev) => [...prev, bubble]);
    closeInlineChatComposer();

    try {
      if (!isTauri()) throw new Error('Not running in Tauri');
      // Use streaming agent command — events handled by the workstudio:agent:event listener.
      // The 'InlineChat' agent is a default coding agent for inline Q&A.
      const runId = await invoke<string>('workstudio_run_agent_stream', {
        args: {
          workstudioId: workstudioId ?? '',
          agentName: chatWithAgentRef || '__system_chat_with',
          languageId: selection.languageId,
          filePath: selection.filePath,
          code: selection.text,
          userInput: question,
        },
      });
      // Rename bubble id to run_id so the listener can correlate events
      setAiBubbles((prev) =>
        prev.map((b) => (b.id === id ? { ...b, id: runId } : b))
      );
      setAiViewerId((prev) => (prev === id ? runId : prev));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAiBubbles((prev) =>
        prev.map((b) => (b.id === id ? { ...b, status: 'error', error: message } : b))
      );
    }
  }, [closeInlineChatComposer, inlineChatComposer.question, inlineChatComposer.selection, chatWithAgentRef, workstudioId]);

  const terminalScope: TerminalScope | null = useMemo(() => {
    if (!workstudioId) return null;
    return { kind: 'workstudio', id: workstudioId };
  }, [workstudioId]);
  const terminalSessionId = useTerminalSessionStore((s) => (terminalScope ? s.getSessionId(terminalScope) : null));

  const keyboardShortcuts = useConfigStore((s) => s.config?.general?.keyboardShortcuts);
  const codeIntelligenceConfig = useConfigStore((s) => s.config?.codeIntelligence);

  // 某些 Monaco 选项（如 suggest/wordBasedSuggestions）在 React wrapper 下更新不一定稳定，
  // 这里显式对已挂载的 editor 实例执行 updateOptions，确保设置切换立即生效。
  useEffect(() => {
    const enabled = codeIntelligenceConfig?.monacoWordSuggestionsEnabled !== false;
    for (const editor of editorByPaneRef.current.values()) {
      try {
        editor.updateOptions({
          suggest: { showWords: enabled },
          wordBasedSuggestions: enabled ? 'matchingDocuments' : 'off',
          wordBasedSuggestionsOnlySameLanguage: true,
        });
      } catch (err) {
        console.warn('[Workstudio] updateOptions failed:', err);
      }
    }
  }, [codeIntelligenceConfig?.monacoWordSuggestionsEnabled]);

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
  const loadWorkstudioSeqRef = useRef(0);

  useEffect(() => {
    // Workstudio 切换时清理“符号分析的运行中映射/取消标记”，避免跨工作区误伤。
    symbolAnalysisConversationIdByBubbleIdRef.current.clear();
    symbolAnalysisBubbleIdByConversationIdRef.current.clear();
    cancelledSymbolAnalysisBubbleIdsRef.current.clear();
  }, [ws?.id]);

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
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
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
    | { visible: true; x: number; y: number; kind: 'folder'; folder: string }
    | { visible: true; x: number; y: number; kind: 'file'; file: string }
    | { visible: true; x: number; y: number; kind: 'blank' }
    | null
  >(null);
  const [tabMenu, setTabMenu] = useState<
    | { visible: true; x: number; y: number; paneId: string; fileId: string; path: string }
    | null
  >(null);
  const [outlineMenu, setOutlineMenu] = useState<
    | {
      visible: true;
      x: number;
      y: number;
      filePath: string;
      languageId: string;
      item: OutlineItem;
      analysis: WorkstudioSymbolAnalysis | null | undefined;
    }
    | null
  >(null);
  const [symbolAnalysisCache, setSymbolAnalysisCache] = useState<Record<string, WorkstudioSymbolAnalysis | null>>({});
  const symbolAnalysisCacheRef = useRef<Record<string, WorkstudioSymbolAnalysis | null>>({});
  useEffect(() => {
    symbolAnalysisCacheRef.current = symbolAnalysisCache;
  }, [symbolAnalysisCache]);
  useEffect(() => {
    // Workstudio 切换时清空缓存，避免跨工作区误命中。
    setSymbolAnalysisCache({});
  }, [ws?.id]);

  // ── run:event listener（run_task）─────────────────────────────────
  // 说明：
  // - Workstudio 的“符号分析/分析类/分析函数/分析变量”等，应复用 ChatView 的统一事件流：
  //   `run_task` → `run:event`（ReAct / 工具调用 / 审批 / 输出 blocks）
  // - 这里做一个轻量的 blocks 聚合器（类似 sessionStore），用于驱动右下角气泡的实时进度展示。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isTauri()) return;

    const STREAM_UI_UPDATE_FPS = 20;
    const STREAM_UI_UPDATE_INTERVAL_MS = Math.round(1000 / STREAM_UI_UPDATE_FPS);

    type PendingStreamChunks = {
      // key: uiBlockId（turnId:blockId）
      blocks: Map<
        string,
        {
          blockType: string;
          format?: string;
          turnId: string;
          turnIndex?: number;
          chunks: string[];
        }
      >;
    };

    const pendingByConversationId = new Map<string, PendingStreamChunks>();
    const turnIndexByConversationId = new Map<string, Map<string, number>>();
    const savedSymbolAnalysisByConversationId = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const getOrCreateTurnIndexMap = (conversationId: string): Map<string, number> => {
      const existing = turnIndexByConversationId.get(conversationId);
      if (existing) return existing;
      const created = new Map<string, number>();
      turnIndexByConversationId.set(conversationId, created);
      return created;
    };

    const setTurnIndex = (conversationId: string, turnId: string, turnIndex: number) => {
      getOrCreateTurnIndexMap(conversationId).set(turnId, turnIndex);
    };

    const getTurnIndex = (conversationId: string, turnId: string): number | undefined => {
      return turnIndexByConversationId.get(conversationId)?.get(turnId);
    };

    const getOrCreatePendingChunks = (conversationId: string): PendingStreamChunks => {
      const existing = pendingByConversationId.get(conversationId);
      if (existing) return existing;
      const created: PendingStreamChunks = { blocks: new Map() };
      pendingByConversationId.set(conversationId, created);
      return created;
    };

    const parseJson = (text: string): any | null => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

	    const extractSuffixId = (prefix: string, id: string): string => {
	      const idx = id.lastIndexOf(prefix);
	      return idx === -1 ? id : id.slice(idx + prefix.length);
	    };

	    // Some providers/gateways incorrectly send "delta" as the full content-so-far.
	    // If we blindly append, the Workstudio AI viewer will show duplicated intermediate snapshots.
	    const mergeStreamingTextDelta = (prevText: string, nextDelta: string): string => {
	      if (!nextDelta) return prevText;
	      if (!prevText) return nextDelta;

	      if (nextDelta.startsWith(prevText)) {
	        return nextDelta;
	      }
	      if (prevText.endsWith(nextDelta)) {
	        return prevText;
	      }
	      const maxOverlap = Math.min(prevText.length, nextDelta.length);
	      for (let k = maxOverlap; k >= 1; k--) {
	        if (prevText.slice(prevText.length - k) === nextDelta.slice(0, k)) {
	          return prevText + nextDelta.slice(k);
	        }
	      }
	      return prevText + nextDelta;
	    };

	    // Some block types are emitted as full JSON snapshots; for these we should not concat deltas.
	    const isSnapshotBlockType = (blockType: string) => {
	      return blockType === 'web_search' || blockType === 'tool_call' || blockType === 'approval';
	    };

    const upsertBlock = (
      blocks: MessageBlock[],
      blockId: string,
      blockType: string,
      format: string | undefined,
      turnId: string,
      turnIndex: number | undefined,
      delta: string
    ): MessageBlock[] => {
      const idx = blocks.findIndex((b) => b.id === blockId);

      const createBlock = (): MessageBlock => {
        if (blockType === 'thinking') {
          return { id: blockId, type: 'thinking', turnId, turnIndex, text: delta };
        }
        if (blockType === 'status') {
          return { id: blockId, type: 'status', turnId, turnIndex, text: delta };
        }
        if (blockType === 'text') {
          return { id: blockId, type: 'text', format: format || 'markdown', turnId, turnIndex, text: delta };
        }
        if (blockType === 'tool_result') {
          return {
            id: blockId,
            type: 'tool_result',
            callId: extractSuffixId('tool_result:', blockId),
            turnId,
            turnIndex,
            text: delta,
          };
        }
        if (blockType === 'error') {
          return { id: blockId, type: 'error', turnId, turnIndex, text: delta };
        }
        if (blockType === 'tool_call') {
          const v = parseJson(delta);
          if (v && typeof v === 'object') {
            const callId = typeof v.id === 'string' ? v.id : extractSuffixId('tool_call:', blockId);
            const name = typeof v.name === 'string' ? v.name : '';
            const args = typeof v.arguments === 'string' ? v.arguments : '';
            const meta = (v as any).meta;
            return { id: blockId, type: 'tool_call', callId, name, arguments: args, meta, turnId, turnIndex };
          }
        }
        if (blockType === 'approval') {
          const v = parseJson(delta);
          if (v && typeof v === 'object') {
            const requestId = typeof v.request_id === 'string' ? v.request_id : extractSuffixId('approval:', blockId);
            const callId = typeof v.call_id === 'string' ? v.call_id : requestId;
            const toolName = typeof v.tool_name === 'string' ? v.tool_name : '';
            const args = typeof v.arguments === 'string' ? v.arguments : '';
            const status = typeof v.status === 'string' ? v.status : 'unknown';
            const securityPolicy =
              typeof (v as any).security_policy === 'string' ? (v as any).security_policy : undefined;
            const escalated = typeof v.escalated === 'boolean' ? v.escalated : undefined;
            const reason = typeof v.reason === 'string' ? v.reason : undefined;
            return {
              id: blockId,
              type: 'approval',
              requestId,
              callId,
              toolName,
              arguments: args,
              status,
              securityPolicy,
              escalated,
              reason,
              turnId,
              turnIndex,
            };
          }
        }
        if (blockType === 'web_search') {
          const v = parseJson(delta);
          if (v && typeof v === 'object') {
            const callId = typeof v.id === 'string' ? v.id : extractSuffixId('web_search:', blockId);
            const status = typeof v.status === 'string' ? v.status : 'unknown';
            const action = v.action;
            return { id: blockId, type: 'web_search', callId, status, action, turnId, turnIndex };
          }
        }
        return { id: blockId, type: 'unknown', turnId, turnIndex, data: { blockType, format, text: delta } };
      };

      if (idx === -1) {
        return [...blocks, createBlock()];
      }

	      const current = blocks[idx];
	      const next: MessageBlock = (() => {
	        if (current.type === 'thinking' && blockType === 'thinking') {
	          return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
	        }
	        if (current.type === 'status' && blockType === 'status') {
	          return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
	        }
	        if (current.type === 'text' && blockType === 'text') {
	          return {
	            ...current,
	            turnIndex: current.turnIndex ?? turnIndex,
	            text: mergeStreamingTextDelta(current.text, delta),
	            format: current.format || format || 'markdown',
	          };
	        }
	        if (current.type === 'tool_result' && blockType === 'tool_result') {
	          return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
	        }
	        if (current.type === 'error' && blockType === 'error') {
	          return { ...current, turnIndex: current.turnIndex ?? turnIndex, text: mergeStreamingTextDelta(current.text, delta) };
	        }
        if (current.type === 'tool_call' && blockType === 'tool_call') {
          // Snapshot update: overwrite
          return createBlock();
        }
        if (current.type === 'approval' && blockType === 'approval') {
          // Snapshot update: overwrite
          return createBlock();
        }
        if (current.type === 'web_search' && blockType === 'web_search') {
          // Snapshot update: overwrite
          return createBlock();
        }
        if (current.type === 'unknown') {
          // If we now recognize the blockType, upgrade it to a typed block; otherwise append text.
          if (
            blockType === 'text' ||
            blockType === 'thinking' ||
            blockType === 'status' ||
            blockType === 'tool_call' ||
            blockType === 'tool_result' ||
            blockType === 'web_search' ||
            blockType === 'error' ||
            blockType === 'approval'
          ) {
            return createBlock();
          }

          const data = current.data as any;
          const prevText = typeof data?.text === 'string' ? data.text : '';
          return {
            ...current,
            turnIndex: current.turnIndex ?? turnIndex,
            data: {
              ...(typeof data === 'object' && data ? data : {}),
              blockType,
              format,
              text: prevText + delta,
            },
          };
        }

        // Type changed: replace block with the new type
        return createBlock();
      })();

      if (next === current) return blocks;
      const copy = blocks.slice();
      copy[idx] = next;
      return copy;
    };

    const flushPending = () => {
      if (pendingByConversationId.size === 0) return;

      const snapshot = Array.from(pendingByConversationId.entries());
      const snapshotMap = new Map(snapshot);
      const appliedConversationIds = new Set<string>();

	      setAiBubbles((prev) => {
	        let updated = false;
	        const next = prev.map((b) => {
	          const conversationId =
	            (b.conversationId ?? '').trim() ||
	            (b.kind === 'symbol_analysis'
	              ? String(symbolAnalysisConversationIdByBubbleIdRef.current.get(b.id) ?? '').trim()
	              : '');
	          if (!conversationId) return b;
	          const chunks = snapshotMap.get(conversationId);
	          if (!chunks || chunks.blocks.size === 0) return b;

          // Streaming already ended/aborted: drop buffered tokens to avoid resurrecting UI
          if (b.status === 'done' || b.status === 'error') {
            appliedConversationIds.add(conversationId);
            return b;
          }

          let nextBlocks = b.blocks ?? [];
          for (const [uiBlockId, entry] of chunks.blocks.entries()) {
            const mergedDelta =
              entry.chunks.length > 0
                ? isSnapshotBlockType(entry.blockType)
                  ? entry.chunks[entry.chunks.length - 1]
                  : entry.chunks.join('')
                : '';
            if (!mergedDelta) continue;
            nextBlocks = upsertBlock(
              nextBlocks,
              uiBlockId,
              entry.blockType,
              entry.format,
              entry.turnId,
              entry.turnIndex,
              mergedDelta
            );
          }

	          if (nextBlocks !== b.blocks) {
	            appliedConversationIds.add(conversationId);
	            updated = true;
	            return {
	              ...b,
	              conversationId,
	              blocks: nextBlocks,
	            };
	          }
          appliedConversationIds.add(conversationId);
          return b;
        });

        return updated ? next : prev;
      });

      // 仅清理已成功应用（或被丢弃）的 conversation；避免“conversation 还没绑定到 bubble”时丢 token。
      for (const cid of appliedConversationIds) {
        pendingByConversationId.delete(cid);
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPending();
        if (pendingByConversationId.size > 0) scheduleFlush();
      }, STREAM_UI_UPDATE_INTERVAL_MS);
    };

    const queueBlockDelta = (
      conversationId: string,
      turnId: string,
      blockId: string,
      blockType: string,
      format: string | undefined,
      delta: string
    ) => {
      const chunks = getOrCreatePendingChunks(conversationId);
      const uiBlockId = `${turnId}:${blockId}`;
      const entry = chunks.blocks.get(uiBlockId);
      if (entry) {
        entry.chunks.push(delta);
        scheduleFlush();
        return;
      }

      chunks.blocks.set(uiBlockId, {
        blockType,
        format,
        turnId,
        turnIndex: getTurnIndex(conversationId, turnId),
        chunks: [delta],
      });
      scheduleFlush();
    };

    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<RunEventPayload>('run:event', (event) => {
          const payload = event.payload;
          const conversationId = (payload.conversationId ?? '').trim();
          if (!conversationId) return;

          // 只处理 Workstudio 主动发起的 run_task（避免被主窗口聊天流拖慢）。
          if (!trackedRunConversationsRef.current.has(conversationId)) return;
          const mappedBubbleId = symbolAnalysisBubbleIdByConversationIdRef.current.get(conversationId) ?? null;

          if (payload.type === 'turn_started') {
            setTurnIndex(conversationId, payload.turnId, payload.turnIndex);
            setAiBubbles((prev) =>
              prev.map((b) => {
                const matches =
                  (b.conversationId ?? '').trim() === conversationId || (mappedBubbleId && b.id === mappedBubbleId);
                if (!matches) return b;
                const bound = (b.conversationId ?? '').trim() === conversationId ? b : { ...b, conversationId };
                const turns = bound.turns ? bound.turns.slice() : [];
                const idx = turns.findIndex((t) => t.turnId === payload.turnId);
                const nextTurn: MessageTurn = {
                  turnId: payload.turnId,
                  turnIndex: payload.turnIndex,
                  status: turns[idx]?.status,
                  debugInfo: turns[idx]?.debugInfo,
                  usage: turns[idx]?.usage,
                  model: turns[idx]?.model,
                };
                if (idx === -1) turns.push(nextTurn);
                else turns[idx] = nextTurn;
                return { ...bound, turns };
              })
            );
            return;
          }

          if (payload.type === 'turn_phase_started') {
            const status =
              payload.phase === 'think'
                ? ('thinking' as WorkstudioAiBubbleStatus)
                : payload.phase === 'act'
                  ? ('tool_calling' as WorkstudioAiBubbleStatus)
                  : ('streaming' as WorkstudioAiBubbleStatus);
            setAiBubbles((prev) =>
              prev.map((b) => {
                const matches =
                  (b.conversationId ?? '').trim() === conversationId || (mappedBubbleId && b.id === mappedBubbleId);
                if (!matches) return b;
                const bound = (b.conversationId ?? '').trim() === conversationId ? b : { ...b, conversationId };
                return { ...bound, status };
              })
            );
            return;
          }

          if (payload.type === 'turn_finished') {
            if (typeof payload.turnIndex === 'number') {
              setTurnIndex(conversationId, payload.turnId, payload.turnIndex);
            }

            setAiBubbles((prev) =>
              prev.map((b) => {
                const matches =
                  (b.conversationId ?? '').trim() === conversationId || (mappedBubbleId && b.id === mappedBubbleId);
                if (!matches) return b;
                const bound = (b.conversationId ?? '').trim() === conversationId ? b : { ...b, conversationId };
                const turns = bound.turns ? bound.turns.slice() : [];
                const idx = turns.findIndex((t) => t.turnId === payload.turnId);
                const nextTurn: MessageTurn = {
                  turnId: payload.turnId,
                  turnIndex: payload.turnIndex ?? turns[idx]?.turnIndex ?? 0,
                  status: payload.status,
                  debugInfo: payload.debugInfo ?? turns[idx]?.debugInfo,
                  usage: payload.usage ?? turns[idx]?.usage,
                  model: payload.model ?? turns[idx]?.model,
                };
                if (idx === -1) turns.push(nextTurn);
                else turns[idx] = nextTurn;
                return { ...bound, turns };
              })
            );
            return;
          }

          if (payload.type === 'block_delta') {
            queueBlockDelta(
              conversationId,
              payload.turnId,
              payload.blockId,
              payload.blockType,
              payload.format ?? undefined,
              payload.delta
            );
            return;
          }

		          if (payload.type === 'done') {
		            // 收尾前先 flush，避免最后一批 token 被节流队列丢弃
		            flushPending();

		            const doneAtMs = Date.now();
		            const bubbleForSave =
		              aiBubblesRef.current.find((b) => (b.conversationId ?? '').trim() === conversationId) ??
		              (mappedBubbleId ? aiBubblesRef.current.find((b) => b.id === mappedBubbleId) ?? null : null);
		            const latencyMs = bubbleForSave?.startedAtMs ? Math.max(0, doneAtMs - bubbleForSave.startedAtMs) : undefined;
		            const isAbortedByUser = bubbleForSave?.status === 'error' && bubbleForSave.error === '已中止';
		            if (isAbortedByUser && bubbleForSave?.kind === 'symbol_analysis') {
		              cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleForSave.id);
	            }

		            if (!isAbortedByUser) {
		              setAiBubbles((prev) => {
		                const next = prev.map((b) => {
		                  const matches =
		                    (b.conversationId ?? '').trim() === conversationId || (mappedBubbleId && b.id === mappedBubbleId);
		                  if (!matches) return b;
		                  const bound = (b.conversationId ?? '').trim() === conversationId ? b : { ...b, conversationId };
		                  const blocks = bound.blocks ?? [];
		                  const hasAnyTextBlock = blocks.some((blk) => blk.type === 'text');
		                  const nextBlocks = hasAnyTextBlock
		                    ? blocks
		                    : [
		                      ...blocks,
	                      {
	                        id: `${payload.turnId}:assistant_text:final`,
	                        type: 'text',
	                        format: payload.format ?? 'markdown',
	                        text: payload.fullContent ?? '',
	                        turnId: payload.turnId,
	                        turnIndex: getTurnIndex(conversationId, payload.turnId),
		                      } as MessageBlock,
		                    ];

		                  return {
		                    ...bound,
		                    status: 'done' as WorkstudioAiBubbleStatus,
		                    assistantMessageId: payload.assistantMessageId ?? bound.assistantMessageId,
		                    blocks: nextBlocks,
		                    latencyMs,
		                    modelRef: bound.modelRef || payload.model || undefined,
		                  };
		                });
		                aiBubblesRef.current = next;
		                return next;
		              });
	            }

	            // 符号分析：把最终结果落盘到 workstudio_symbol_analyses，并刷新右键菜单/缓存。
	            if (!isAbortedByUser && !savedSymbolAnalysisByConversationId.has(conversationId) && bubbleForSave?.analysisMeta) {
	              savedSymbolAnalysisByConversationId.add(conversationId);
	              void (async () => {
	                try {
	                  const meta = bubbleForSave.analysisMeta!;
                  const res = await saveWorkstudioSymbolAnalysis({
                    ...meta,
                    answerMd: payload.fullContent ?? '',
                    modelRef: bubbleForSave.modelRef,
                    latencyMs,
                  });

                  const cacheKey = `${meta.workstudioId}::${normalizeFsPath(meta.filePath)}::${meta.symbolKey}`;
                  setSymbolAnalysisCache((prev) => ({ ...prev, [cacheKey]: res }));

                  setOutlineMenu((prev) => {
                    if (!prev) return prev;
                    if (prev.filePath !== meta.filePath) return prev;
                    if (prev.item.key !== meta.symbolKey) return prev;
                    return { ...prev, analysis: res };
                  });
                } catch (err) {
                  console.warn('[Workstudio][Outline] saveWorkstudioSymbolAnalysis failed:', err);
                }
              })();
            }

            // 释放“该符号正在分析中/队列中”的锁，允许后续重新分析。
            {
              const analysisKey = symbolAnalysisKeyByConversationIdRef.current.get(conversationId);
              if (analysisKey) {
                activeSymbolAnalysisKeysRef.current.delete(analysisKey);
                symbolAnalysisKeyByConversationIdRef.current.delete(conversationId);
              } else if (bubbleForSave?.analysisMeta) {
                const meta = bubbleForSave.analysisMeta;
                const fallbackKey = `${meta.workstudioId}::${normalizeFsPath(meta.filePath)}::${meta.symbolKey}`;
                activeSymbolAnalysisKeysRef.current.delete(fallbackKey);
              }
		            }

		            // 结束后清理缓冲与追踪标记（避免残留定时 flush）。
		            {
		              const bubbleId = bubbleForSave?.id ?? mappedBubbleId;
		              if (bubbleId) {
		                symbolAnalysisConversationIdByBubbleIdRef.current.delete(bubbleId);
		              }
		            }
		            symbolAnalysisBubbleIdByConversationIdRef.current.delete(conversationId);
		            pendingByConversationId.delete(conversationId);
		            turnIndexByConversationId.delete(conversationId);
		            trackedRunConversationsRef.current.delete(conversationId);
		            scheduleSymbolAnalysisRunsRef.current?.();
		            return;
		          }

		          if (payload.type === 'error') {
		            flushPending();
		            const bubbleForCancel =
		              aiBubblesRef.current.find((b) => (b.conversationId ?? '').trim() === conversationId) ??
		              (mappedBubbleId ? aiBubblesRef.current.find((b) => b.id === mappedBubbleId) ?? null : null);
		            const isAbortedByUser = bubbleForCancel?.status === 'error' && bubbleForCancel.error === '已中止';
		            if (isAbortedByUser && bubbleForCancel?.kind === 'symbol_analysis') {
		              cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleForCancel.id);
		            }
		            const errorMessage = isAbortedByUser ? '已中止' : payload.error || 'Unknown error';
		            setAiBubbles((prev) => {
		              const next = prev.map((b) => {
		                const matches =
		                  (b.conversationId ?? '').trim() === conversationId || (mappedBubbleId && b.id === mappedBubbleId);
		                if (!matches) return b;
		                const bound = (b.conversationId ?? '').trim() === conversationId ? b : { ...b, conversationId };
		                return {
		                  ...bound,
		                  status: 'error' as WorkstudioAiBubbleStatus,
		                  error: errorMessage,
		                };
		              });
		              aiBubblesRef.current = next;
		              return next;
		            });
	            {
	              const analysisKey = symbolAnalysisKeyByConversationIdRef.current.get(conversationId);
	              if (analysisKey) {
	                activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	                symbolAnalysisKeyByConversationIdRef.current.delete(conversationId);
	              } else {
	                const bubble =
	                  aiBubblesRef.current.find((b) => (b.conversationId ?? '').trim() === conversationId) ??
	                  (mappedBubbleId ? aiBubblesRef.current.find((b) => b.id === mappedBubbleId) ?? null : null);
	                if (bubble?.analysisMeta) {
	                  const meta = bubble.analysisMeta;
	                  const fallbackKey = `${meta.workstudioId}::${normalizeFsPath(meta.filePath)}::${meta.symbolKey}`;
	                  activeSymbolAnalysisKeysRef.current.delete(fallbackKey);
	                }
	              }
	            }
	            {
	              const bubbleId = bubbleForCancel?.id ?? mappedBubbleId;
	              if (bubbleId) {
	                symbolAnalysisConversationIdByBubbleIdRef.current.delete(bubbleId);
	              }
	            }
	            symbolAnalysisBubbleIdByConversationIdRef.current.delete(conversationId);
	            pendingByConversationId.delete(conversationId);
	            turnIndexByConversationId.delete(conversationId);
	            trackedRunConversationsRef.current.delete(conversationId);
	            scheduleSymbolAnalysisRunsRef.current?.();
	          }
        });
      } catch {
        // ignore
      }
    })();

    return () => {
      unlisten?.();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingByConversationId.clear();
      turnIndexByConversationId.clear();
      savedSymbolAnalysisByConversationId.clear();
      symbolAnalysisKeyByConversationIdRef.current.clear();
    };
  }, []);
  const lspStatusButtonRef = useRef<HTMLButtonElement | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [leftSidebarTab, setLeftSidebarTab] = useState<'explorer' | 'outline'>('explorer');



  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const outlineItemsRef = useRef<OutlineItem[]>([]);
  useEffect(() => {
    outlineItemsRef.current = outlineItems;
  }, [outlineItems]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [outlineSource, setOutlineSource] = useState<'lsp' | 'ast' | 'none'>('none');
  const outlineSourceRef = useRef<'lsp' | 'ast' | 'none'>('none');
  useEffect(() => {
    outlineSourceRef.current = outlineSource;
  }, [outlineSource]);
  const [outlineActiveKey, setOutlineActiveKey] = useState<string | null>(null);
  const [outlineCollapsedKeys, setOutlineCollapsedKeys] = useState<Set<string>>(() => new Set());
  const [outlineFileStateByPath, setOutlineFileStateByPath] = useState<Record<string, OutlineFileViewState>>({});
  const outlineFileStateByPathRef = useRef<Record<string, OutlineFileViewState>>(outlineFileStateByPath);
  useEffect(() => {
    outlineFileStateByPathRef.current = outlineFileStateByPath;
  }, [outlineFileStateByPath]);
  const [outlineRefreshSeq, setOutlineRefreshSeq] = useState(0);
  const outlineRequestSeqRef = useRef(0);
  const codeIndexScanStartedRef = useRef<Set<string>>(new Set());
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
  const [lspIndexBriefs, setLspIndexBriefs] = useState<LspIndexBrief[]>([]);
  const prevLspStateByLangRef = useRef<Record<string, string>>({});
  const lspIndexStartAtMsByLangRef = useRef<Record<string, number>>({});
  const lspIndexLastProgressByLangRef = useRef<Record<string, string>>({});

  const [codeIndexBrief, setCodeIndexBrief] = useState<Awaited<ReturnType<typeof codeIndexSummary>> | null>(null);
  const [codeIndexBriefError, setCodeIndexBriefError] = useState<string | null>(null);

  const [filePaletteOpen, setFilePaletteOpen] = useState(false);
  const [filePaletteQuery, setFilePaletteQuery] = useState('');
  const [filePaletteResults, setFilePaletteResults] = useState<string[]>([]);
  const [filePaletteIndex, setFilePaletteIndex] = useState(0);
  const [filePaletteError, setFilePaletteError] = useState<string | null>(null);

  const saveStateTimerRef = useRef<number | null>(null);
  const paneRowRef = useRef<HTMLDivElement | null>(null);
  const paneRootRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneTabStripRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const paneBodyResizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
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
  const activeOutlineFilePath = useMemo(
    () => (activeTextFileInFocusedPane ? normalizeFsPath(activeTextFileInFocusedPane.path) : null),
    [activeTextFileInFocusedPane]
  );
  const activeOutlineFilePathRef = useRef<string | null>(activeOutlineFilePath);
  useEffect(() => {
    activeOutlineFilePathRef.current = activeOutlineFilePath;
  }, [activeOutlineFilePath]);

  const updateOutlineFileViewState = useCallback(
    (filePathRaw: string, updater: (prev: OutlineFileViewState) => OutlineFileViewState) => {
      const filePath = normalizeFsPath(String(filePathRaw ?? '').trim());
      if (!filePath) return;
      setOutlineFileStateByPath((prevMap) => {
        const prev = prevMap[filePath] ?? {
          collapsedKeys: [],
          recentKeys: [],
          updatedAtMs: Date.now(),
        };
        const next = normalizeOutlineFileViewState({
          ...updater(prev),
          updatedAtMs: Date.now(),
        });
        const merged = { ...prevMap, [filePath]: next };
        const sorted = Object.entries(merged).sort(
          (a, b) => (b[1].updatedAtMs ?? 0) - (a[1].updatedAtMs ?? 0)
        );
        return Object.fromEntries(sorted.slice(0, OUTLINE_FILE_STATE_LIMIT));
      });
    },
    []
  );

  const persistOutlineCollapsedSet = useCallback(
    (filePath: string | null, collapsed: Set<string>) => {
      if (!filePath) return;
      const collapsedKeys = trimOutlineCollapsedKeys(Array.from(collapsed));
      updateOutlineFileViewState(filePath, (prev) => ({
        ...prev,
        collapsedKeys,
      }));
    },
    [updateOutlineFileViewState]
  );

  const markOutlineVisited = useCallback(
    (filePath: string | null, outlineKey: string) => {
      if (!filePath) return;
      const key = String(outlineKey ?? '').trim();
      if (!key) return;
      updateOutlineFileViewState(filePath, (prev) => ({
        ...prev,
        activeKey: key,
        recentKeys: trimOutlineRecentKeys([key, ...(prev.recentKeys ?? [])]),
      }));
    },
    [updateOutlineFileViewState]
  );

  const handleOutlineScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const filePath = activeOutlineFilePath;
      if (!filePath) return;
      const scrollTop = Math.max(0, Math.floor(event.currentTarget.scrollTop));
      if (outlineScrollSaveTimerRef.current) {
        window.clearTimeout(outlineScrollSaveTimerRef.current);
      }
      outlineScrollSaveTimerRef.current = window.setTimeout(() => {
        outlineScrollSaveTimerRef.current = null;
        updateOutlineFileViewState(filePath, (prev) => ({
          ...prev,
          scrollTop,
        }));
      }, 120);
    },
    [activeOutlineFilePath, updateOutlineFileViewState]
  );

  useEffect(() => {
    setExplorerSelectedFilePath(activeFilePathInFocusedPane);
  }, [activeFilePathInFocusedPane]);

  // Code Index（落盘缓存）：
  // - 用户切换到某个文件时，把该文件的索引任务提到高优先级
  // - 目的是：大项目后台扫描很慢时，用户正在看的文件永远最优先
  useEffect(() => {
    if (!isTauri()) return;
    const wsId = ws?.id ?? null;
    const file = activeTextFileInFocusedPane;
    if (!wsId || !file) return;

    const normalizedPath = normalizeFsPath(file.path);
    if (!normalizedPath || isUntitledPath(normalizedPath)) return;
    const indexable = ['rust', 'typescript', 'javascript', 'python', 'c', 'cpp', 'lua'].includes(activeTextLanguageId);
    if (!indexable) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await codeIndexRequestDocumentSymbols({
          workstudioId: wsId,
          filePath: normalizedPath,
          languageId: activeTextLanguageId,
          priority: CODE_INDEX_PRIORITY_OPEN_FILE,
          force: false,
        });
        if (cancelled) return;

        // 仅作为“快速恢复”的缓存：如果当前已经使用 LSP 且有内容，就不要用缓存覆盖。
        if (outlineSourceRef.current === 'lsp' && outlineItemsRef.current.length > 0) return;

        const cached = res?.cached ?? null;
        const symbols = cached?.symbols ?? null;
        if (!symbols) return;

        const nextItems = astSymbolsToOutline(symbols as any);
        if (nextItems.length === 0) return;

        const allKeys = collectOutlineKeys(nextItems);
        const collapsibleKeys = collectOutlineCollapsibleKeys(nextItems);
        const collapsibleKeySet = new Set(collapsibleKeys);
        const persistedViewState = outlineFileStateByPathRef.current[normalizedPath];
        const persistedCollapsed = Array.isArray(persistedViewState?.collapsedKeys)
          ? persistedViewState.collapsedKeys.filter((key) => collapsibleKeySet.has(key))
          : collapsibleKeys;
        const collapsedSet = new Set(persistedCollapsed);
        const persistedActiveKey = String(persistedViewState?.activeKey ?? '').trim();
        const restoredActiveKey = persistedActiveKey && allKeys.has(persistedActiveKey) ? persistedActiveKey : null;

        setOutlineItems(nextItems);
        setOutlineSource('ast');
        setOutlineCollapsedKeys(collapsedSet);
        setOutlineActiveKey((prev) => {
          if (restoredActiveKey) return restoredActiveKey;
          return prev && allKeys.has(prev) ? prev : null;
        });
        setOutlineError(null);
        setOutlineLoading(Boolean(cached?.isStale || res?.queued));
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ws?.id, activeTextFileInFocusedPane?.id, activeTextLanguageId]);

  useEffect(() => {
    setOutlineActiveKey(null);
    setOutlineCollapsedKeys(new Set());
    setOutlineItems([]);
    setOutlineSource('none');
    setOutlineError(null);
    setOutlineLoading(true);
  }, [activeTextFileInFocusedPane?.id]);

  useEffect(() => {
    if (outlineOpen) return;
    if (leftSidebarTab !== 'explorer') {
      setLeftSidebarTab('explorer');
    }
  }, [leftSidebarTab, outlineOpen]);

  // 背景扫描（低优先级）：
  // - 只在用户打开 Outline 时启动一次（每个 workstudio 一次）
  // - 避免大项目“全量索引”抢占用户正在看的文件：真正的高优先级由上面的 open-file effect 提升
  useEffect(() => {
    if (!isTauri()) return;
    if (!outlineOpen) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;
    if (codeIndexScanStartedRef.current.has(wsId)) return;
    codeIndexScanStartedRef.current.add(wsId);

    const timer = window.setTimeout(() => {
      void codeIndexStartWorkspaceScan({
        workstudioId: wsId,
        priority: CODE_INDEX_PRIORITY_BACKGROUND,
      }).catch(() => {});
    }, 900);

    return () => window.clearTimeout(timer);
  }, [outlineOpen, ws?.id]);

  useEffect(() => {
    return () => {
      if (outlineScrollSaveTimerRef.current) {
        window.clearTimeout(outlineScrollSaveTimerRef.current);
        outlineScrollSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!outlineOpen) return;
    if (outlineLoading) return;
    const filePath = activeOutlineFilePath;
    if (!filePath) return;
    const top = outlineFileStateByPath[filePath]?.scrollTop;
    if (typeof top !== 'number' || !Number.isFinite(top)) return;
    let rafId = 0;
    rafId = window.requestAnimationFrame(() => {
      const container = outlineContainerRef.current;
      if (!container) return;
      container.scrollTop = Math.max(0, Math.floor(top));
    });
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [activeOutlineFilePath, outlineFileStateByPath, outlineItems.length, outlineLoading, outlineOpen]);

  useEffect(() => {
    if (!outlineOpen) return;
    if (!isTauri()) {
      setOutlineItems([]);
      setOutlineSource('none');
      setOutlineError(null);
      setOutlineLoading(false);
      setOutlineCollapsedKeys(new Set());
      return;
    }

    const wsId = ws?.id ?? null;
    const activeFile = activeTextFileInFocusedPane;
    const outlineFilePath = activeFile ? normalizeFsPath(activeFile.path) : null;
    if (!wsId || !activeFile || !outlineFilePath) {
      setOutlineItems([]);
      setOutlineSource('none');
      setOutlineError(null);
      setOutlineLoading(false);
      setOutlineCollapsedKeys(new Set());
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
        if (nextItems.length === 0 && outlineItemsRef.current.length > 0) {
          // 已经有缓存/旧结果时，不要用空结果覆盖（避免“有内容 -> 变空”的闪烁）。
          setOutlineError(lspError);
          setOutlineLoading(false);
          return;
        }
        const allKeys = collectOutlineKeys(nextItems);
        const collapsibleKeys = collectOutlineCollapsibleKeys(nextItems);
        const collapsibleKeySet = new Set(collapsibleKeys);
        const persistedViewState = outlineFileStateByPathRef.current[outlineFilePath];
        const persistedCollapsed = Array.isArray(persistedViewState?.collapsedKeys)
          ? persistedViewState.collapsedKeys.filter((key) => collapsibleKeySet.has(key))
          : collapsibleKeys;
        const collapsedSet = new Set(persistedCollapsed);
        const persistedActiveKey = String(persistedViewState?.activeKey ?? '').trim();
        const restoredActiveKey = persistedActiveKey && allKeys.has(persistedActiveKey) ? persistedActiveKey : null;

        setOutlineItems(nextItems);
        setOutlineSource(nextSource);
        setOutlineCollapsedKeys(collapsedSet);
        setOutlineActiveKey((prev) => {
          if (restoredActiveKey) return restoredActiveKey;
          return prev && allKeys.has(prev) ? prev : null;
        });
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
    const candidates = [ws.mainFolder, ...(ws.folders ?? [])].filter((p) => p && p.trim().length > 0);
    for (const f of candidates) {
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
    const seq = (loadWorkstudioSeqRef.current += 1);
    setWsError(null);
    setWsLoading(true);
    try {
      const result = await withTimeout(
        invoke<Workstudio | null>('get_workstudio', { workstudioId: id }),
        10_000,
        '加载 Workstudio 超时（后端可能被长时间阻塞）。请稍后重试或重启应用。'
      );
      if (seq !== loadWorkstudioSeqRef.current) return;
      if (!result) {
        setWs(null);
        setWsError('Workstudio 不存在或已损坏');
        return;
      }
      setWs(result);
    } catch (error) {
      if (seq !== loadWorkstudioSeqRef.current) return;
      setWs(null);
      setWsError(toErrorMessage(error));
    } finally {
      if (seq !== loadWorkstudioSeqRef.current) return;
      setWsLoading(false);
    }
  }, []);

  const listDir = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => ({ ...prev, [dirPath]: true }));
    setDirErrors((prev) => {
      if (!prev[dirPath]) return prev;
      const next = { ...prev };
      delete next[dirPath];
      return next;
    });
    try {
      const entries = await invoke<DirEntry[]>('list_local_directory', { path: dirPath });
      setEntriesByDir((prev) => ({ ...prev, [dirPath]: entries }));
    } catch (error) {
      const msg = toErrorMessage(error);
      const isNotFound = (() => {
        const s = (msg ?? '').toLowerCase();
        return s.includes('os error 2') || s.includes('no such file or directory');
      })();

      if (isNotFound) {
        // Common case: restored stale expandedDirs after repo structure changed or folder was deleted.
        // Do not spam console.error (it may be intercepted into a modal). Just auto-collapse and forget it.
        setExpandedDirs((prev) => {
          if (!prev.has(dirPath)) return prev;
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
        setEntriesByDir((prev) => {
          if (!prev[dirPath]) return prev;
          const next = { ...prev };
          delete next[dirPath];
          return next;
        });
        setDirErrors((prev) => {
          if (!prev[dirPath]) return prev;
          const next = { ...prev };
          delete next[dirPath];
          return next;
        });
        return;
      }

      setDirErrors((prev) => ({ ...prev, [dirPath]: msg }));
      setEntriesByDir((prev) => ({ ...prev, [dirPath]: [] }));
    } finally {
      setLoadingDirs((prev) => ({ ...prev, [dirPath]: false }));
    }
  }, []);

  const toggleDir = useCallback(
    async (dirPath: string) => {
      const isExpanded = expandedDirsRef.current.has(dirPath);
      const willExpand = !isExpanded;
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });

      if (willExpand && (!entriesByDir[dirPath] || dirErrors[dirPath])) {
        await listDir(dirPath);
      }
    },
    [dirErrors, entriesByDir, listDir]
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
  const triggerSuggest = useCallback(
    (opts?: { requireTextFocus?: boolean }) =>
      runFocusedEditorAction('editor.action.triggerSuggest', opts),
    [runFocusedEditorAction]
  );

  const toggleOutlineCollapsed = useCallback(
    (item: OutlineItem) => {
      if (item.children.length === 0) return;
      setOutlineCollapsedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        persistOutlineCollapsedSet(activeOutlineFilePath, next);
        return next;
      });
    },
    [activeOutlineFilePath, persistOutlineCollapsedSet]
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

      const selectionStartLine = clampOutlineLine(item.range.startLine);
      const selectionStartColumn = clampOutlineColumn(item.range.startColumn);
      const endLine = Math.max(selectionStartLine, clampOutlineLine(item.range.endLine));
      const endColumn = Math.max(selectionStartColumn, clampOutlineColumn(item.range.endColumn));

      const revealLine = clampOutlineLine(item.selectionLine);
      const revealColumn = clampOutlineColumn(item.selectionColumn);

      const prevLocation =
        suppressNavRecordDepthRef.current === 0 ? getCurrentNavLocationForPane(paneId) : null;
      const targetLocation: NavLocation = { tabId, line: revealLine, column: revealColumn };
      if (prevLocation && isMeaningfulNavTransition(prevLocation, targetLocation)) {
        commitNavBackEntry(paneId, prevLocation);
      }

      setFocusedPane(paneId);
      editor.focus();
      editor.setSelection({
        startLineNumber: selectionStartLine,
        startColumn: selectionStartColumn,
        endLineNumber: endLine,
        endColumn,
      });
      // 仍然将视区滚动到函数名那一行
      editor.revealPositionInCenter({ lineNumber: revealLine, column: revealColumn });
      setOutlineActiveKey(item.key);
      markOutlineVisited(activeOutlineFilePath, item.key);
    },
    [
      activeOutlineFilePath,
      commitNavBackEntry,
      getCurrentNavLocationForPane,
      isMeaningfulNavTransition,
      markOutlineVisited,
      resolvedFocusedPaneId,
      setFocusedPane,
    ]
  );

  const makeSymbolAnalysisCacheKey = useCallback(
    (filePathRaw: string, symbolKey: string) => {
      const fp = normalizeFsPath(String(filePathRaw ?? '').trim());
      return `${workstudioId ?? ''}::${fp}::${symbolKey}`;
    },
    [workstudioId]
  );

  const ensureSymbolAnalysis = useCallback(
    async (filePath: string, symbolKey: string): Promise<WorkstudioSymbolAnalysis | null> => {
      if (!workstudioId) return null;
      const cacheKey = makeSymbolAnalysisCacheKey(filePath, symbolKey);
      const cache = symbolAnalysisCacheRef.current;
      if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) {
        return cache[cacheKey] ?? null;
      }

      try {
        const res = await getWorkstudioSymbolAnalysis({ workstudioId, filePath, symbolKey });
        setSymbolAnalysisCache((prev) => ({ ...prev, [cacheKey]: res }));
        return res;
      } catch (err) {
        console.warn('[Workstudio][Outline] getWorkstudioSymbolAnalysis failed:', err);
        setSymbolAnalysisCache((prev) => ({ ...prev, [cacheKey]: null }));
        return null;
      }
    },
    [makeSymbolAnalysisCacheKey, workstudioId]
  );

  const outlineAnalysisActionLabel = useCallback((kindRaw: string): string => {
    const kind = normalizeOutlineKind(kindRaw);
    if (OUTLINE_CALLABLE_KINDS.has(kind)) return '分析函数';
    if (OUTLINE_VALUE_KINDS.has(kind)) return '分析变量';
    if (kind === 'class') return '分析类';
    if (OUTLINE_CONTAINER_KINDS.has(kind)) return '分析结构';
    return '分析符号';
  }, []);

  const outlineAnalysisPromptPreview = useCallback((kindRaw: string): string => {
    const kind = normalizeOutlineKind(kindRaw);
    if (OUTLINE_CALLABLE_KINDS.has(kind)) return '请分析该函数/方法，并尽可能给出潜在调用链与风险点。';
    if (OUTLINE_VALUE_KINDS.has(kind)) return '请分析该变量/字段的含义、生命周期与常见误用。';
    if (OUTLINE_CONTAINER_KINDS.has(kind)) return '请分析该类型/容器符号的职责、关键成员与设计风险。';
    return '请分析该符号在模块中的角色、用途与潜在问题。';
  }, []);

  const getActiveSymbolAnalysisStatus = useCallback(
    (filePathRaw: string, symbolKeyRaw: string): WorkstudioAiBubbleStatus | null => {
      const wsId = String(workstudioId ?? '').trim();
      const filePath = normalizeFsPath(String(filePathRaw ?? '').trim());
      const symbolKey = String(symbolKeyRaw ?? '').trim();
      if (!wsId || !filePath || !symbolKey) return null;

      const ACTIVE_STATUSES: WorkstudioAiBubbleStatus[] = ['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'];
      for (const b of aiBubbles) {
        if (b.kind !== 'symbol_analysis') continue;
        if (!ACTIVE_STATUSES.includes(b.status)) continue;
        const meta = b.analysisMeta;
        if (!meta) continue;
        if (String(meta.workstudioId ?? '').trim() !== wsId) continue;
        if (normalizeFsPath(meta.filePath) !== filePath) continue;
        if (String(meta.symbolKey ?? '').trim() !== symbolKey) continue;
        return b.status;
      }
      return null;
    },
    [aiBubbles, workstudioId]
  );

  const extractTextFromOutlineRange = useCallback((content: string, range: OutlineRange): string => {
    if (!content) return '';
    const lines = content.split(/\r?\n/);
    const startLineIdx = Math.max(0, Math.min(lines.length - 1, Math.floor(range.startLine - 1)));
    const endLineIdx = Math.max(0, Math.min(lines.length - 1, Math.floor(range.endLine - 1)));
    if (endLineIdx < startLineIdx) return '';

    const slice = lines.slice(startLineIdx, endLineIdx + 1);
    const startColIdx = Math.max(0, Math.floor(range.startColumn - 1));
    const endColIdx = Math.max(0, Math.floor(range.endColumn - 1));

    if (slice.length === 1) {
      const line = slice[0] ?? '';
      const a = Math.min(startColIdx, line.length);
      const b = Math.min(Math.max(a, endColIdx), line.length);
      slice[0] = line.slice(a, b);
      return slice.join('\n');
    }

    // first line: trim left
    slice[0] = (slice[0] ?? '').slice(startColIdx);
    // last line: trim right
    const lastIdx = slice.length - 1;
    slice[lastIdx] = (slice[lastIdx] ?? '').slice(0, endColIdx);
    return slice.join('\n');
  }, []);

  const buildSymbolAnalysisAgentPool = useCallback(() => {
    const clampConcurrency = (v: unknown, fallback: number) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(1, Math.min(64, Math.floor(n)));
    };

    const cfgStore = useConfigStore.getState();
    const settings = cfgStore.config?.codeIntelligence?.symbolAnalysis ?? null;

    const defaultAgentName = String(settings?.agentRef ?? '').trim() || '__system_symbol_analysis';
    const poolByAgentName = new Map<string, number>();
    poolByAgentName.set(defaultAgentName, clampConcurrency(settings?.concurrency, 2));

    for (const row of settings?.additionalAgents ?? []) {
      const agentName = String(row?.agentRef ?? '').trim();
      if (!agentName) continue;
      const concurrency = clampConcurrency(row?.concurrency, 1);
      poolByAgentName.set(agentName, (poolByAgentName.get(agentName) ?? 0) + concurrency);
    }

    return Array.from(poolByAgentName.entries()).map(([agentName, concurrency]) => ({
      agentName,
      concurrency,
    }));
  }, []);

	  const startQueuedSymbolAnalysis = useCallback(
	    async (bubbleId: string, agentNameRaw: string) => {
	      if (!workstudioId) return;

	      const bubble = aiBubblesRef.current.find((b) => b.id === bubbleId) ?? null;
	      if (!bubble || bubble.kind !== 'symbol_analysis') return;
	      if (bubble.status !== 'queued') return;

	      // 用户可能在 queued 阶段就点击了“中止”，此时直接标记并释放锁。
	      if (cancelledSymbolAnalysisBubbleIdsRef.current.has(bubbleId)) {
	        cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	        const metaForKey = bubble.analysisMeta ?? null;
	        if (metaForKey) {
	          const analysisKey = makeSymbolAnalysisCacheKey(metaForKey.filePath, metaForKey.symbolKey);
	          activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	        }
	        setAiBubbles((prev) => {
		          const next = prev.map((b) =>
		            b.id === bubbleId ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: '已中止' } : b
		          );
		          aiBubblesRef.current = next;
		          return next;
		        });
	        return;
	      }

	      const meta = bubble.analysisMeta ?? null;
	      const code = String(bubble.analysisCode ?? '').trim();
	      if (!meta || !code) {
	        if (meta) {
          const analysisKey = makeSymbolAnalysisCacheKey(meta.filePath, meta.symbolKey);
          activeSymbolAnalysisKeysRef.current.delete(analysisKey);
        }
        setAiBubbles((prev) => {
	          const next = prev.map((b) =>
	            b.id === bubbleId
	              ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: '缺少符号分析的必要信息，无法启动任务' }
	              : b
	          );
	          aiBubblesRef.current = next;
	          return next;
	        });
        return;
      }

      if (startingSymbolAnalysisBubbleIdsRef.current.has(bubbleId)) return;
      startingSymbolAnalysisBubbleIdsRef.current.add(bubbleId);

	      const cfgStore = useConfigStore.getState();
	      const agentName = String(agentNameRaw ?? '').trim() || '__system_symbol_analysis';
	      const agent = cfgStore.getAgent(agentName);
	      const modelRef = agent?.modelRef || cfgStore.getCurrentModelRef?.() || '';
	      const analysisKey = makeSymbolAnalysisCacheKey(meta.filePath, meta.symbolKey);

	      // 先把 UI 状态切到“连接中”，避免 schedule 被重复触发导致重复启动。
	      setAiBubbles((prev) => {
	        const next = prev.map((b) =>
	          b.id === bubbleId
	            ? {
	              ...b,
	              status: 'connecting' as WorkstudioAiBubbleStatus,
	              startedAtMs: Date.now(),
	              agentName,
	              modelRef: modelRef || b.modelRef,
	              error: undefined,
	            }
	            : b
	        );
	        aiBubblesRef.current = next;
	        return next;
	      });

	      if (cancelledSymbolAnalysisBubbleIdsRef.current.has(bubbleId)) {
	        cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	        activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	        setAiBubbles((prev) => {
	          const next = prev.map((b) =>
	            b.id === bubbleId ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: '已中止' } : b
	          );
	          aiBubblesRef.current = next;
	          return next;
	        });
	        startingSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	        return;
	      }

	      let trackedConversationId: string | null = null;
	      try {
	        // 确保任何“刚改完的 agent/toolset”先落盘，否则后端读取到旧配置会导致工具缺失。
	        await cfgStore.flushConfigSaves?.();

	        const actionLabel = outlineAnalysisActionLabel(meta.symbolKind);
	        const convTitleRaw = `${actionLabel}:${meta.symbolName}`;
	        const convTitle = convTitleRaw.length > 64 ? `${convTitleRaw.slice(0, 64)}…` : convTitleRaw;
	        const conversation = await invoke<Conversation>('create_conversation', { title: convTitle });
	        trackedRunConversationsRef.current.add(conversation.id);
	        trackedConversationId = conversation.id;
	        symbolAnalysisKeyByConversationIdRef.current.set(conversation.id, analysisKey);
	        symbolAnalysisConversationIdByBubbleIdRef.current.set(bubbleId, conversation.id);
	        symbolAnalysisBubbleIdByConversationIdRef.current.set(conversation.id, bubbleId);

	        // 若用户在创建会话期间点击了“中止”，则不再继续启动 run_task。
	        if (cancelledSymbolAnalysisBubbleIdsRef.current.has(bubbleId)) {
	          cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	          trackedRunConversationsRef.current.delete(conversation.id);
	          symbolAnalysisKeyByConversationIdRef.current.delete(conversation.id);
	          symbolAnalysisConversationIdByBubbleIdRef.current.delete(bubbleId);
	          symbolAnalysisBubbleIdByConversationIdRef.current.delete(conversation.id);
	          activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	          setAiBubbles((prev) => {
	            const next = prev.map((b) =>
	              b.id === bubbleId ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: '已中止' } : b
	            );
		            aiBubblesRef.current = next;
		            return next;
		          });
	          return;
	        }

	        // 尽早把 conversationId 绑定到 bubble，避免“事件流先到但 bubble 还没绑定 conversationId”导致 UI 卡在 connecting。
	        setAiBubbles((prev) => {
	          const next = prev.map((b) =>
	            b.id === bubbleId
	              ? {
	                  ...b,
	                  conversationId: conversation.id,
	                  agentName,
	                  modelRef: modelRef || b.modelRef,
	                }
	              : b
	          );
	          aiBubblesRef.current = next;
	          return next;
	        });

	        // 绑定到当前 workstudio，确保工具默认 workdir/工作区提示词可用。
	        await invoke('update_conversation_metadata', {
	          conversationId: conversation.id,
	          agentName,
          modelRef: modelRef || undefined,
          runMode: 'chat',
	          thinkingMode: false,
	          workstudioId,
	        }).catch(() => { });

	        if (cancelledSymbolAnalysisBubbleIdsRef.current.has(bubbleId)) {
	          cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	          trackedRunConversationsRef.current.delete(conversation.id);
	          symbolAnalysisKeyByConversationIdRef.current.delete(conversation.id);
	          symbolAnalysisConversationIdByBubbleIdRef.current.delete(bubbleId);
	          symbolAnalysisBubbleIdByConversationIdRef.current.delete(conversation.id);
	          activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	          setAiBubbles((prev) => {
	            const next = prev.map((b) =>
	              b.id === bubbleId ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: '已中止' } : b
		            );
		            aiBubblesRef.current = next;
		            return next;
		          });
		          return;
		        }

	        const userMessageId = crypto.randomUUID();
	        const relPath = (() => {
	          const main = normalizeFsPath(ws?.mainFolder ?? '');
	          const fp = normalizeFsPath(meta.filePath);
          if (main && fp.startsWith(main)) {
            const trimmed = fp.slice(main.length).replace(/^\/+/, '');
            return trimmed || basename(fp);
          }
          return fp;
        })();

        const userContent = [
          `${bubble.prompt || outlineAnalysisPromptPreview(meta.symbolKind)}`,
          '',
          `languageId: ${meta.languageId}`,
          `filePath: ${relPath}`,
          `symbol: ${meta.symbolName} (${meta.symbolKind})`,
          `location: ${meta.selectionLine}:${meta.selectionColumn}`,
          '',
          '你可以在需要时调用工具（read_file / list_dir / rg / web_search）来补齐上下文，但不要修改文件。',
	          '',
	          `\`\`\`${meta.languageId || 'text'}\n${code}\n\`\`\``,
	        ].join('\n');

	        await invoke('run_task', {
	          conversationId: conversation.id,
	          messageId: userMessageId,
	          content: userContent,
          agentName,
          modelRef: modelRef || undefined,
          runMode: 'chat',
	          thinking: false,
	          debugMode: cfgStore.config?.general?.debugMode ?? false,
	        });

	        // 兜底：某些情况下 run:event 可能丢失/被过滤（或 bubble 尚未绑定 conversationId），导致 UI 永久停留在 connecting。
	        // 但 run_task 已返回，说明后端已完成并落库；此处从 DB 拉取最后一条 assistant 消息来恢复 UI + 结果落盘。
	        try {
	          const bubbleAfterRun = aiBubblesRef.current.find((b) => b.id === bubbleId) ?? null;
	          const ACTIVE_STATUSES: WorkstudioAiBubbleStatus[] = ['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'];
	          const shouldRecover = bubbleAfterRun ? ACTIVE_STATUSES.includes(bubbleAfterRun.status) : true;
		          if (shouldRecover) {
		            const msgs = await getMessages(conversation.id, 30);
		            const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant') ?? null;
		            const answerMdFromContent = String(lastAssistant?.content ?? '').trim();
		            const answerMdFromBlocks = (() => {
		              const blocks = lastAssistant?.blocks ?? [];
		              const parts: string[] = [];
		              for (const blk of blocks) {
		                const anyBlk = blk as any;
		                if (anyBlk && anyBlk.type === 'text' && typeof anyBlk.text === 'string') {
		                  const t = String(anyBlk.text ?? '').trimEnd();
		                  if (t) parts.push(t);
		                }
		              }
		              return parts.join('\n').trim();
		            })();
		            const answerMd = answerMdFromContent || answerMdFromBlocks;

	            const blocks: MessageBlock[] = (() => {
	              const fromHistory = lastAssistant?.blocks ?? [];
	              if (fromHistory.length > 0) return fromHistory;
	              if (!answerMd) return [];
	              return [
	                {
	                  id: `${lastAssistant?.id ?? conversation.id}:assistant_text:final`,
	                  type: 'text',
	                  format: 'markdown',
	                  text: answerMd,
	                } as MessageBlock,
	              ];
	            })();

	            if (lastAssistant && (answerMd || blocks.length > 0)) {
	              const doneAtMs = Date.now();
	              const startedAtMs = bubbleAfterRun?.startedAtMs;
	              const latencyMs =
	                typeof startedAtMs === 'number' ? Math.max(0, doneAtMs - startedAtMs) : undefined;

	              setAiBubbles((prev) => {
	                const next = prev.map((b) =>
	                  b.id === bubbleId
	                    ? {
	                        ...b,
	                        conversationId: conversation.id,
	                        status: 'done' as WorkstudioAiBubbleStatus,
		                        assistantMessageId: lastAssistant.id,
		                        blocks: blocks.length > 0 ? blocks : b.blocks,
		                        turns: lastAssistant.turns ?? b.turns,
		                        modelRef: b.modelRef || lastAssistant.meta?.model || undefined,
		                        latencyMs: b.latencyMs ?? latencyMs,
		                      }
	                    : b
	                );
	                aiBubblesRef.current = next;
	                return next;
	              });

		              if (answerMd && meta) {
		                const res = await saveWorkstudioSymbolAnalysis({
		                  ...meta,
		                  answerMd,
	                  modelRef: bubbleAfterRun?.modelRef,
	                  latencyMs,
	                });
	                const cacheKey = `${meta.workstudioId}::${normalizeFsPath(meta.filePath)}::${meta.symbolKey}`;
	                setSymbolAnalysisCache((prev) => ({ ...prev, [cacheKey]: res }));
	                setOutlineMenu((prev) => {
	                  if (!prev) return prev;
	                  if (prev.filePath !== meta.filePath) return prev;
	                  if (prev.item.key !== meta.symbolKey) return prev;
	                  return { ...prev, analysis: res };
	                });
	              }
	            }

	            // 资源回收（幂等）：即便 run:event 未触发 done/error，也确保不会占用 pool 或残留锁。
	            trackedRunConversationsRef.current.delete(conversation.id);
	            symbolAnalysisKeyByConversationIdRef.current.delete(conversation.id);
	            symbolAnalysisConversationIdByBubbleIdRef.current.delete(bubbleId);
	            symbolAnalysisBubbleIdByConversationIdRef.current.delete(conversation.id);
	            activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	            scheduleSymbolAnalysisRunsRef.current?.();
	          }
	        } catch (err) {
	          console.warn('[Workstudio][Outline] recover run_task result failed:', err);
	        }
	      } catch (err) {
	        if (trackedConversationId) {
	          trackedRunConversationsRef.current.delete(trackedConversationId);
	          symbolAnalysisKeyByConversationIdRef.current.delete(trackedConversationId);
	          symbolAnalysisBubbleIdByConversationIdRef.current.delete(trackedConversationId);
	        }
	        activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	        symbolAnalysisConversationIdByBubbleIdRef.current.delete(bubbleId);
	        // 反查并清理 conversation -> bubble 映射（如果已创建会话但 trackedConversationId 未命中）。
	        for (const [cid, bid] of symbolAnalysisBubbleIdByConversationIdRef.current.entries()) {
	          if (bid === bubbleId) {
	            symbolAnalysisBubbleIdByConversationIdRef.current.delete(cid);
	            break;
	          }
	        }
	        cancelledSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	        const message = err instanceof Error ? err.message : String(err);
	        setAiBubbles((prev) => {
	          const next = prev.map((b) =>
		            b.id === bubbleId ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: message } : b
		          );
		          aiBubblesRef.current = next;
		          return next;
		        });
	      } finally {
	        startingSymbolAnalysisBubbleIdsRef.current.delete(bubbleId);
	      }
    },
    [
      makeSymbolAnalysisCacheKey,
      outlineAnalysisActionLabel,
      outlineAnalysisPromptPreview,
      workstudioId,
      ws?.mainFolder,
    ]
  );

  const scheduleSymbolAnalysisRuns = useCallback(() => {
    if (!workstudioId) return;

    const settings = useConfigStore.getState().config?.codeIntelligence?.symbolAnalysis;
    const enabled = settings?.enabled !== false;
    if (!enabled) {
      const queued = aiBubblesRef.current.filter((b) => b.kind === 'symbol_analysis' && b.status === 'queued');
      if (queued.length > 0) {
        for (const b of queued) {
          const meta = b.analysisMeta;
          if (!meta) continue;
          const analysisKey = makeSymbolAnalysisCacheKey(meta.filePath, meta.symbolKey);
          activeSymbolAnalysisKeysRef.current.delete(analysisKey);
        }
        setAiBubbles((prev) =>
          prev.map((b) =>
            b.kind === 'symbol_analysis' && b.status === 'queued'
              ? { ...b, status: 'error', error: '符号分析已关闭：请在设置中启用后再试' }
              : b
          )
        );
      }
      return;
    }

    const pool = buildSymbolAnalysisAgentPool();
    if (pool.length === 0) return;

    const RUNNING_STATUSES: WorkstudioAiBubbleStatus[] = ['connecting', 'thinking', 'streaming', 'tool_calling'];
    const activeCountByAgentName = new Map<string, number>();
    for (const b of aiBubblesRef.current) {
      if (b.kind !== 'symbol_analysis') continue;
      if (!RUNNING_STATUSES.includes(b.status)) continue;
      const agentName = String(b.agentName ?? '').trim();
      if (!agentName) continue;
      activeCountByAgentName.set(agentName, (activeCountByAgentName.get(agentName) ?? 0) + 1);
    }

    const queued = aiBubblesRef.current.filter((b) => b.kind === 'symbol_analysis' && b.status === 'queued');
    if (queued.length === 0) return;

    const freeSlots = pool.map((p) => p.concurrency - (activeCountByAgentName.get(p.agentName) ?? 0));
    const hasAnyFreeSlot = freeSlots.some((v) => v > 0);
    if (!hasAnyFreeSlot) return;

    let cursor = symbolAnalysisRoundRobinCursorRef.current % pool.length;
    let queueIdx = 0;

    while (queueIdx < queued.length) {
      let agentIdx = -1;
      for (let i = 0; i < pool.length; i++) {
        const idx = (cursor + i) % pool.length;
        if ((freeSlots[idx] ?? 0) > 0) {
          agentIdx = idx;
          break;
        }
      }
      if (agentIdx === -1) break;

      const bubble = queued[queueIdx]!;
      queueIdx += 1;

      if (startingSymbolAnalysisBubbleIdsRef.current.has(bubble.id)) continue;
      // 必要信息校验留给 startQueuedSymbolAnalysis 处理（它会标记 error 并释放锁）。

      freeSlots[agentIdx] = (freeSlots[agentIdx] ?? 0) - 1;
      cursor = (agentIdx + 1) % pool.length;
      void startQueuedSymbolAnalysis(bubble.id, pool[agentIdx]!.agentName);
    }

    symbolAnalysisRoundRobinCursorRef.current = cursor;
  }, [buildSymbolAnalysisAgentPool, makeSymbolAnalysisCacheKey, startQueuedSymbolAnalysis, workstudioId]);

  useEffect(() => {
    scheduleSymbolAnalysisRunsRef.current = scheduleSymbolAnalysisRuns;
  }, [scheduleSymbolAnalysisRuns]);

  useEffect(() => {
    scheduleSymbolAnalysisRuns();
  }, [codeIntelligenceConfig?.symbolAnalysis, scheduleSymbolAnalysisRuns]);

  // 调度触发：当队列数量变化、或活跃任务数量变化时，尝试拉起新的 queued 任务。
  // 依赖 queued/active 的“计数”，避免 streaming token 导致每次渲染都触发调度。
  useEffect(() => {
    if (!workstudioId) return;
    if (symbolAnalysisQueuedCount <= 0) return;
    scheduleSymbolAnalysisRuns();
  }, [scheduleSymbolAnalysisRuns, symbolAnalysisActiveCount, symbolAnalysisQueuedCount, workstudioId]);

  const runOutlineSymbolAnalysis = useCallback(
    async (filePath: string, languageId: string, item: OutlineItem) => {
      if (!workstudioId) return;
      const enabled = useConfigStore.getState().config?.codeIntelligence?.symbolAnalysis?.enabled !== false;
      if (!enabled) {
        throw new Error('符号分析已关闭：请在“设置 -> 代码智能 -> 符号分析”中启用');
      }

      const file = activeTextFileInFocusedPane;
      if (!file || file.path !== filePath) {
        throw new Error('当前焦点文件已变化，请重新打开 Outline 并再试一次');
      }

      const analysisKey = makeSymbolAnalysisCacheKey(filePath, item.key);
      if (activeSymbolAnalysisKeysRef.current.has(analysisKey)) {
        throw new Error('该符号正在分析中（或已在队列中），请稍后再试');
      }

      const content = String(file.content ?? '');
      const maxChars = 12_000;
      let code = extractTextFromOutlineRange(content, item.range).trim();
      if (!code) {
        // fallback: selection line
        const lines = content.split(/\r?\n/);
        const idx = Math.max(0, Math.min(lines.length - 1, item.selectionLine - 1));
        code = String(lines[idx] ?? '').trim();
      }
      if (!code) {
        throw new Error('无法提取符号代码：请确认文件已加载且 Outline range 正常');
      }
      if (code.length > maxChars) {
        code = `${code.slice(0, maxChars)}\n…（已截断）`;
      }

      const symbolKind = normalizeOutlineKind(item.kind);
      const actionLabel = outlineAnalysisActionLabel(symbolKind);
      const promptPreview = outlineAnalysisPromptPreview(symbolKind);
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const displayName = `${actionLabel}：${item.name}`;
      const name = displayName.length > 32 ? `${displayName.slice(0, 32)}…` : displayName;
      const subtitle = `${basename(filePath)}:${item.selectionLine}:${item.selectionColumn}`;

      const bubble: WorkstudioAiBubble = {
        id,
        kind: 'symbol_analysis',
        name,
        subtitle,
        prompt: promptPreview,
        status: 'queued',
        createdAt,
        analysisMeta: {
          workstudioId,
          languageId,
          filePath,
          symbolKey: item.key,
          symbolName: item.name,
          symbolKind,
          selectionLine: item.selectionLine,
          selectionColumn: item.selectionColumn,
          range: item.range,
        },
        analysisCode: code,
      };
      activeSymbolAnalysisKeysRef.current.add(analysisKey);
      setAiBubbles((prev) => [...prev, bubble]);
    },
    [
      activeTextFileInFocusedPane,
      extractTextFromOutlineRange,
      outlineAnalysisActionLabel,
      outlineAnalysisPromptPreview,
      makeSymbolAnalysisCacheKey,
      workstudioId,
    ]
  );

  const runOutlineAnalyzeAll = useCallback(async () => {
    if (!workstudioId) return;
    const settings = useConfigStore.getState().config?.codeIntelligence?.symbolAnalysis ?? null;
    if (settings?.enabled !== true) {
      showNavToast('符号分析已关闭：请先在设置中启用');
      return;
    }

    const file = activeTextFileInFocusedPane;
    if (!file || file.kind !== 'text') {
      showNavToast('当前无可解析的文本文件');
      return;
    }
    if (outlineItems.length === 0) {
      showNavToast('Outline 为空：没有可解析的符号');
      return;
    }

    const bulkExcludeVariables = settings?.bulkExcludeVariables !== false;
    const flat = flattenOutlineItems(outlineItems);
    const targets = flat.filter((item) => {
      const kind = normalizeOutlineKind(item.kind);
      if (bulkExcludeVariables && OUTLINE_VALUE_KINDS.has(kind)) return false;
      return true;
    });

    if (targets.length === 0) {
      showNavToast(bulkExcludeVariables ? '没有可解析的符号（已跳过变量/字段）' : '没有可解析的符号');
      return;
    }

    const prompt = [
      `将对当前文件的 ${targets.length} 个符号执行“全部解析”${bulkExcludeVariables ? '（已跳过变量/字段）' : ''}。`,
      '',
      '这会发起大量模型请求，可能耗时较长并产生费用。',
      '继续？',
    ].join('\n');
    if (!confirm(prompt)) return;

    const filePath = file.path;
    const languageId = activeTextLanguageId || languageForPath(filePath);
    let enqueued = 0;

    for (let i = 0; i < targets.length; i++) {
      const item = targets[i]!;
      try {
        await runOutlineSymbolAnalysis(filePath, languageId, item);
        enqueued += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 文件切换时，避免继续批量入队。
        if (message.includes('当前焦点文件已变化')) {
          showNavToast('文件已切换：已停止批量解析');
          break;
        }
        // 其它错误（例如已在队列中）跳过即可。
      }

      // 避免一次性入队过多导致 UI 卡顿
      if (i > 0 && i % 24 === 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    showNavToast(`已加入解析队列：${enqueued}/${targets.length}`);
  }, [activeTextFileInFocusedPane, activeTextLanguageId, outlineItems, runOutlineSymbolAnalysis, showNavToast, workstudioId]);

  const toWorkstudioRelativePath = useCallback(
    (absFilePath: string) => {
      const main = normalizeFsPath(ws?.mainFolder ?? '');
      const fp = normalizeFsPath(absFilePath);
      if (main && fp.startsWith(main)) {
        const trimmed = fp.slice(main.length).replace(/^\/+/, '');
        return trimmed || basename(fp);
      }
      return fp;
    },
    [ws?.mainFolder]
  );

  const buildWorkstudioSymbolAnalysisRichTextDoc = useCallback(
    (
      analysis: Pick<
        WorkstudioSymbolAnalysis,
        | 'id'
        | 'filePath'
        | 'selectionLine'
        | 'selectionColumn'
        | 'symbolName'
        | 'languageId'
        | 'symbolKind'
        | 'modelRef'
        | 'latencyMs'
        | 'updatedAt'
        | 'answerMd'
      >
    ): string => {
      const generatedAt = new Date().toISOString();
      const relPath = toWorkstudioRelativePath(analysis.filePath);
      const fileRef = `${relPath}#L${analysis.selectionLine}C${analysis.selectionColumn}`;

      const lines: string[] = [];
      lines.push(
        `<!-- tauri.richtxt v1 | kind=workstudio_symbol_analysis | generatedAt=${generatedAt} | analysisId=${analysis.id} -->`
      );
      lines.push('');
      lines.push(`# 符号分析：${analysis.symbolName}`);
      lines.push('');
      lines.push(`- 生成时间：\`${generatedAt}\``);
      lines.push(`- 位置：\`${fileRef}\``);
      lines.push(`- 语言：\`${analysis.languageId}\``);
      lines.push(`- 类型：\`${analysis.symbolKind}\``);
      if (analysis.modelRef) lines.push(`- 模型：\`${analysis.modelRef}\``);
      if (typeof analysis.latencyMs === 'number') lines.push(`- 延迟：\`${analysis.latencyMs}ms\``);
      lines.push(`- 更新时间：\`${analysis.updatedAt}\``);
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push((analysis.answerMd ?? '').trim());
      lines.push('');
      return lines.join('\n').trim() + '\n';
    },
    [toWorkstudioRelativePath]
  );

  const openVirtualRichTextFile = useCallback((title: string, content: string) => {
    const id = crypto.randomUUID();
    const tabTitle = title.length > 48 ? `${title.slice(0, 48)}…` : title;
    const virtualPath = `__analysis__/${id}.tauri.richtxt`;

    setOpenFiles((prev) => {
      if (prev.some((f) => f.id === id)) return prev;
      const newFile: OpenFile = {
        id,
        title: tabTitle,
        path: virtualPath,
        kind: 'markdown',
        mime: 'text/markdown',
        size: new TextEncoder().encode(content).length,
        content,
      };
      return [...prev, newFile];
    });

    useWindowLayoutStore.getState().openTabInFocusedPane(id);
  }, []);


  const viewOutlineSymbolAnalysis = useCallback(
    async (filePath: string, item: OutlineItem) => {
      if (!workstudioId) return;
      const res = await ensureSymbolAnalysis(filePath, item.key);
      if (!res) {
        showNavToast('暂无已保存的分析结果');
        return;
      }

      const nameBase = `查看分析：${item.name}`;
      const name = nameBase.length > 32 ? `${nameBase.slice(0, 32)}…` : nameBase;
      const content = buildWorkstudioSymbolAnalysisRichTextDoc(res);
      openVirtualRichTextFile(name, content);
    },
    [
      buildWorkstudioSymbolAnalysisRichTextDoc,
      ensureSymbolAnalysis,
      openVirtualRichTextFile,
      showNavToast,
      workstudioId,
    ]
  );

  const deleteOutlineSymbolAnalysis = useCallback(
    async (filePath: string, item: OutlineItem) => {
      if (!workstudioId) return;
      const ok = window.confirm(`确定删除该符号的分析结果吗？\n\n${basename(filePath)} · ${item.name}`);
      if (!ok) return;

      await deleteWorkstudioSymbolAnalysis({ workstudioId, filePath, symbolKey: item.key });
      const cacheKey = makeSymbolAnalysisCacheKey(filePath, item.key);
      setSymbolAnalysisCache((prev) => ({ ...prev, [cacheKey]: null }));
      setOutlineMenu((prev) => {
        if (!prev) return prev;
        if (prev.filePath !== filePath) return prev;
        if (prev.item.key !== item.key) return prev;
        return { ...prev, analysis: null };
      });
      showNavToast('已删除分析结果');
    },
    [deleteWorkstudioSymbolAnalysis, makeSymbolAnalysisCacheKey, showNavToast, workstudioId]
  );

  const openOutlineItemMenu = useCallback(
    (e: React.MouseEvent, item: OutlineItem) => {
      e.preventDefault();
      e.stopPropagation();
      const filePath = activeTextFileInFocusedPane?.path ?? '';
      if (!filePath) return;
      const languageId = languageForPath(filePath);

      const cacheKey = makeSymbolAnalysisCacheKey(filePath, item.key);
      const cache = symbolAnalysisCacheRef.current;
      const analysis = Object.prototype.hasOwnProperty.call(cache, cacheKey) ? cache[cacheKey] : undefined;

      setOutlineMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        filePath,
        languageId,
        item,
        analysis,
      });

      if (analysis === undefined) {
        void ensureSymbolAnalysis(filePath, item.key).then((res) => {
          setOutlineMenu((prev) => {
            if (!prev) return prev;
            if (prev.filePath !== filePath) return prev;
            if (prev.item.key !== item.key) return prev;
            return { ...prev, analysis: res };
          });
        });
      }
    },
    [activeTextFileInFocusedPane?.path, ensureSymbolAnalysis, makeSymbolAnalysisCacheKey]
  );

  const renderOutlineNodes = (nodes: OutlineItem[], depth = 0): React.ReactNode =>
    nodes.map((item) => {
      const active = outlineActiveKey === item.key;
      const filePath = activeTextFileInFocusedPane?.path ?? '';
      const analysisCacheKey = filePath ? makeSymbolAnalysisCacheKey(filePath, item.key) : '';
      const hasAnalysis = analysisCacheKey
        ? Boolean(symbolAnalysisCache[analysisCacheKey])
        : false;
      const hasChildren = item.children.length > 0;
      const collapsed = hasChildren && outlineCollapsedKeys.has(item.key);
      return (
        <React.Fragment key={item.id}>
          <div className="flex items-center gap-1" style={{ paddingLeft: 6 + depth * 14 }}>
            {hasChildren ? (
              <button
                type="button"
                className="rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                title={collapsed ? '展开' : '折叠'}
                onClick={() => toggleOutlineCollapsed(item)}
              >
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
            ) : (
              <span className="inline-block h-4 w-4" />
            )}
            <button
              type="button"
              className={[
                'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs',
                active
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
              ].join(' ')}
              title={`${item.name} · ${item.kind} · ${item.selectionLine}:${item.selectionColumn}`}
              onClick={() => jumpToOutlineItem(item)}
              onContextMenu={(e) => openOutlineItemMenu(e, item)}
            >
              <span
                className={[
                  'min-w-0 flex-1 truncate font-medium',
                  hasAnalysis && !active ? 'text-emerald-700 dark:text-emerald-300' : '',
                ].join(' ')}
                title={hasAnalysis ? '已保存分析结果' : undefined}
              >
                {item.name}
              </span>
              <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {item.kind}
              </span>
            </button>
          </div>
          {hasChildren && !collapsed ? renderOutlineNodes(item.children, depth + 1) : null}
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
      .catch(() => { });
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

  const formatPathForChatRef = useCallback(
    (absPathRaw: string, kind: 'file' | 'folder') => {
      const absPath = normalizeFsPath(String(absPathRaw ?? '').trim());
      if (!absPath) return '';

      const rootsRaw = rootFoldersRef.current;
      let bestRoot: string | null = null;
      for (const raw of rootsRaw) {
        const norm = normalizeFsPath(raw);
        if (!norm) continue;
        if (absPath === norm || absPath.startsWith(`${norm}/`)) {
          if (!bestRoot || norm.length > bestRoot.length) bestRoot = norm;
        }
      }

      let refPath = absPath;
      if (bestRoot) {
        const rel = absPath.slice(bestRoot.length).replace(/^\/+/, '');
        refPath = rel || basename(absPath);
      }
      if (kind === 'folder' && refPath && !refPath.endsWith('/')) {
        refPath += '/';
      }
      return `\`${refPath}\``;
    },
    []
  );

  const addPathToMainChat = useCallback(
    async (absPathRaw: string, kind: 'file' | 'folder') => {
      const refText = formatPathForChatRef(absPathRaw, kind);
      if (!refText) return;

      // 保底：先复制到剪贴板（即使主窗口未打开也可手动粘贴）。
      try {
        await navigator.clipboard.writeText(refText);
      } catch {
        // ignore
      }

      if (!isTauri()) return;

      // 尝试把引用直接追加到主窗口聊天输入框（如果主窗口存在）。
      await focusMainWindow();
      const mainWin = await WebviewWindow.getByLabel('main').catch(() => null);
      if (!mainWin) return;
      await mainWin.emit('chat:insert_text', { text: refText }).catch(() => { });
    },
    [formatPathForChatRef]
  );

  const formatPathForSnippetLabel = useCallback(
    (absPathRaw: string) => {
      const token = formatPathForChatRef(absPathRaw, 'file');
      if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) return token.slice(1, -1);
      return token;
    },
    [formatPathForChatRef]
  );

  const addCodeSnippetToMainChat = useCallback(
    async (token: string, snippet: CodeSnippetContentPart) => {
      const label = String(snippet?.label ?? '').trim();
      const code = String(snippet?.text ?? '');
      if (!label || !code) return;

      // 保底：复制到剪贴板（主窗口不存在/未响应时用户仍可粘贴）。
      const fenceLang = String(snippet.languageId ?? '').trim();
      const fallback = `${label}\n\`\`\`${fenceLang}\n${code}\n\`\`\``;
      try {
        await navigator.clipboard.writeText(fallback);
      } catch {
        // ignore
      }

      if (!isTauri()) return;
      await focusMainWindow();
      const mainWin = await WebviewWindow.getByLabel('main').catch(() => null);
      if (!mainWin) return;
      await mainWin.emit('chat:insert_code_snippet', { token, snippet }).catch(() => { });
    },
    [focusMainWindow]
  );

  const deleteExplorerFile = useCallback(
    async (absPathRaw: string) => {
      const absPath = normalizeFsPath(String(absPathRaw ?? '').trim());
      if (!absPath) return;
      if (!ws) return;

      const ok = window.confirm(`确定要删除该文件吗？\n\n${absPath}`);
      if (!ok) return;

      try {
        await invoke('delete_local_path', {
          args: { path: absPath, allowedRoots: rootFoldersRef.current },
        });
      } catch (error) {
        console.error('delete_local_path failed:', error);
        return;
      }

      // 如果该文件已在 editor 中打开，删除后需要关闭 tab，避免出现“保存/写回”到已不存在文件。
      const toClose = openFilesRef.current
        .filter((f) => normalizeFsPath(f.path) === absPath)
        .map((f) => f.id);
      for (const id of toClose) closeFileTab(id);

      setExplorerSelectedFilePath((prev) => (prev === absPath ? null : prev));

      const parent = absPath.split('/').slice(0, -1).join('/');
      if (parent) {
        void listDir(parent);
      }
    },
    [closeFileTab, listDir, ws]
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
          try {
            const wsId = ws?.id ?? null;
            const languageId = languageForPath(normalizedPath);
            const indexable = ['rust', 'typescript', 'javascript', 'python', 'c', 'cpp', 'lua'].includes(languageId);
            if (wsId && indexable && !isUntitledPath(normalizedPath)) {
              void codeIndexRequestDocumentSymbols({
                workstudioId: wsId,
                filePath: normalizedPath,
                languageId,
                priority: CODE_INDEX_PRIORITY_SAVE_FILE,
                force: true,
              }).catch(() => {});
            }
          } catch {
            // ignore
          }

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

        // Best-effort: 写回磁盘后，刷新落盘索引缓存（用于重启快速恢复 Outline）
        try {
          const wsId = ws?.id ?? null;
          const normalizedPath = normalizeFsPath(file.path);
          const languageId = languageForPath(normalizedPath);
          const indexable = ['rust', 'typescript', 'javascript', 'python', 'c', 'cpp', 'lua'].includes(languageId);
          if (wsId && indexable && normalizedPath && !isUntitledPath(normalizedPath)) {
            void codeIndexRequestDocumentSymbols({
              workstudioId: wsId,
              filePath: normalizedPath,
              languageId,
              priority: CODE_INDEX_PRIORITY_SAVE_FILE,
              force: true,
            }).catch(() => {});
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

  // 初始化 Monaco <-> Bridge（仅在 Tauri 桌面端）。
  // - 在 Workstudio 首次挂载 editor 时拿到 monaco 实例
  // - 当 ws.id 就绪后，启动 LSP Bridge / AI Completion Bridge（注册 provider + opener + 文档同步）
  useEffect(() => {
    return () => {
      lspBridgeRef.current?.dispose();
      lspBridgeRef.current = null;
      lspBridgeWorkstudioIdRef.current = null;
      aiCompletionBridgeRef.current?.dispose();
      aiCompletionBridgeRef.current = null;
      aiCompletionBridgeWorkstudioIdRef.current = null;
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
    if (aiCompletionBridgeWorkstudioIdRef.current && aiCompletionBridgeWorkstudioIdRef.current !== wsId) {
      aiCompletionBridgeRef.current?.dispose();
      aiCompletionBridgeRef.current = null;
      aiCompletionBridgeWorkstudioIdRef.current = null;
    }

    if (!monaco || !wsId) return;
    const hasLspBridge = lspBridgeWorkstudioIdRef.current === wsId;
    const hasAiCompletionBridge = aiCompletionBridgeWorkstudioIdRef.current === wsId;
    if (hasLspBridge && hasAiCompletionBridge) return;

    if (!hasLspBridge) {
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

    if (!hasAiCompletionBridge) {
      aiCompletionBridgeRef.current?.dispose();
      aiCompletionBridgeRef.current = attachMonacoAiCompletionBridge({
        monaco,
        workstudioId: wsId,
        getConfig: () => useConfigStore.getState().config?.codeIntelligence,
      });
      aiCompletionBridgeWorkstudioIdRef.current = wsId;
    }
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
        if (wsId && aiCompletionBridgeWorkstudioIdRef.current !== wsId) {
          aiCompletionBridgeRef.current?.dispose();
          aiCompletionBridgeRef.current = attachMonacoAiCompletionBridge({
            monaco,
            workstudioId: wsId,
            getConfig: () => useConfigStore.getState().config?.codeIntelligence,
          });
          aiCompletionBridgeWorkstudioIdRef.current = wsId;
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

        const snapshotSelection = (): {
          filePath: string;
          languageId: string;
          text: string;
          range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
          labelPath: string;
        } | null => {
          const filePath = readActiveTabId();
          if (!filePath || filePath.startsWith(UNTITLED_PREFIX)) return null;
          const model = editor.getModel();
          if (!model) return null;
          const sel = editor.getSelection();
          if (!sel || sel.isEmpty()) return null;
          const text = model.getValueInRange(sel);
          if (!String(text ?? '').trim()) return null;
          const start = sel.getStartPosition();
          const end = sel.getEndPosition();
          const range = {
            startLine: start.lineNumber,
            startColumn: start.column,
            endLine: end.lineNumber,
            endColumn: end.column,
          };
          const languageId = String(model.getLanguageId?.() ?? '').trim() || 'plaintext';
          const labelPath = formatPathForSnippetLabel(filePath);
          return { filePath, languageId, text, range, labelPath };
        };

        // Monaco editor context menu actions (selection-based)
        editor.addAction({
          id: 'tauri-ai.addSelectionToChat',
          label: 'Add to chat',
          precondition: 'editorHasSelection',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 1.41,
          run: async () => {
            const snap = snapshotSelection();
            if (!snap) return;
            const id = crypto.randomUUID();
            const token = `@{snippet:${id}}`;
            const label = `片段 ${snap.labelPath}:${snap.range.startLine}-${snap.range.endLine}`;
            const snippet: CodeSnippetContentPart = {
              type: 'code_snippet',
              id,
              label,
              text: snap.text,
              languageId: snap.languageId,
              filePath: snap.filePath,
              range: snap.range,
            };
            await addCodeSnippetToMainChat(token, snippet);
          },
        });

        editor.addAction({
          id: 'tauri-ai.chatWithSelection',
          label: 'Chat with…',
          precondition: 'editorHasSelection',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 1.42,
          run: async () => {
            const snap = snapshotSelection();
            if (!snap) return;
            // Placeholder: the full bubble UI is implemented below; here we only open the composer.
            openInlineChatComposer({
              filePath: snap.filePath,
              languageId: snap.languageId,
              text: snap.text,
              range: snap.range,
              label: `选中 ${snap.labelPath}:${snap.range.startLine}-${snap.range.endLine}`,
            });
          },
        });

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
    [
      addCodeSnippetToMainChat,
      commitNavBackEntry,
      formatPathForSnippetLabel,
      isMeaningfulNavTransition,
      lspAutoConfigStatus,
      openInlineChatComposer,
      openLinkTarget,
      saveFile,
      ws?.id,
    ]
  );

  const relayoutAllEditors = useCallback(() => {
    for (const editor of editorByPaneRef.current.values()) {
      try {
        editor.layout();
      } catch {
        // ignore
      }
    }
  }, []);

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

  const editorLayoutKey = useMemo(() => {
    return `${outlineOpen ? '1' : '0'}|${resolvedPanes
      .map((pane) => `${pane.id}:${pane.weight}:${pane.activeTabId ?? ''}:${pane.tabIds.join(',')}`)
      .join('|')}`;
  }, [outlineOpen, resolvedPanes]);

  useEffect(() => {
    let rafId1 = 0;
    let rafId2 = 0;
    rafId1 = window.requestAnimationFrame(() => {
      relayoutAllEditors();
      rafId2 = window.requestAnimationFrame(() => {
        relayoutAllEditors();
      });
    });
    return () => {
      if (rafId1) window.cancelAnimationFrame(rafId1);
      if (rafId2) window.cancelAnimationFrame(rafId2);
    };
  }, [editorLayoutKey, relayoutAllEditors]);

  useEffect(() => {
    const onResize = () => {
      relayoutAllEditors();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [relayoutAllEditors]);

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

  // 记录“索引开始时间”（基于是否存在 $/progress token），用于索引完成后的简报。
  useEffect(() => {
    const byLang = lspProgress ?? {};
    for (const [lang, byToken] of Object.entries(byLang)) {
      const tokens = Object.keys(byToken ?? {});
      if (tokens.length === 0) continue;
      if (!lspIndexStartAtMsByLangRef.current[lang]) {
        const items = Object.values(byToken ?? {});
        const minUpdatedAt = items.reduce((acc, it) => Math.min(acc, it?.updatedAtMs ?? Date.now()), Date.now());
        lspIndexStartAtMsByLangRef.current[lang] = minUpdatedAt;
      }
      const text = getLanguageProgressText(lang);
      if (text) lspIndexLastProgressByLangRef.current[lang] = text;
    }
  }, [getLanguageProgressText, lspProgress]);

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

  const refreshCodeIndexBrief = useCallback(async () => {
    if (!isTauri()) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;
    try {
      const res = await codeIndexSummary(wsId);
      setCodeIndexBrief(res);
      setCodeIndexBriefError(null);
    } catch (e) {
      setCodeIndexBrief(null);
      setCodeIndexBriefError(e instanceof Error ? e.message : String(e));
    }
  }, [ws?.id]);

  // 当 LSP 从“索引中”切换到“就绪”时，生成一次简报（用于判断“上一次索引是否完成/是否明显复用缓存”）。
  useEffect(() => {
    const wsId = ws?.id ?? null;
    if (!wsId) return;
    if (!isTauri()) return;

    const enabled = new Set(enabledLspLanguageIds);
    const prevMap = prevLspStateByLangRef.current;

    for (const lang of enabledLspLanguageIds) {
      const desc = describeLspLanguage(lang);
      const nextState = desc.state;
      const prevState = prevMap[lang];
      prevMap[lang] = nextState;

      if (prevState === 'indexing' && nextState === 'ready') {
        const completedAtMs = Date.now();
        const startAt = lspIndexStartAtMsByLangRef.current[lang];
        const durationMs = startAt ? Math.max(0, completedAtMs - startAt) : undefined;
        delete lspIndexStartAtMsByLangRef.current[lang];

        const lastProgress = lspIndexLastProgressByLangRef.current[lang];
        delete lspIndexLastProgressByLangRef.current[lang];

        const st = lspStatusByLanguageId.get(lang) ?? null;
        const commandLine = st?.command ? [st.command, ...((st.args ?? []) as any[])].join(' ') : undefined;

        setLspIndexBriefs((prev) => {
          const next: LspIndexBrief[] = [
            {
              languageId: lang,
              completedAtMs,
              durationMs,
              lastProgress,
              commandLine,
              hadError: Boolean(desc.lastError),
            },
            ...prev,
          ];
          return next.slice(0, 24);
        });
      }
    }

    // 清理已不再启用的语言状态缓存，避免 Workstudio 切换时“串台”。
    for (const key of Object.keys(prevMap)) {
      if (!enabled.has(key)) delete prevMap[key];
    }
  }, [describeLspLanguage, enabledLspLanguageIds, lspStatusByLanguageId, ws?.id]);

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
      const observers = paneBodyResizeObserversRef.current;
      const oldObserver = observers.get(paneId) ?? null;
      if (oldObserver) {
        oldObserver.disconnect();
        observers.delete(paneId);
      }

      if (!el) {
        map.delete(paneId);
        return;
      }

      map.set(paneId, el);

      if (typeof ResizeObserver !== 'undefined') {
        try {
          const observer = new ResizeObserver(() => {
            const editor = editorByPaneRef.current.get(paneId) ?? null;
            if (!editor) return;
            try {
              editor.layout({ width: el.clientWidth, height: el.clientHeight });
            } catch {
              try {
                editor.layout();
              } catch {
                // ignore
              }
            }
          });
          observer.observe(el);
          observers.set(paneId, observer);
        } catch {
          // ignore
        }
      }

      window.requestAnimationFrame(() => {
        const editor = editorByPaneRef.current.get(paneId) ?? null;
        if (!editor) return;
        try {
          editor.layout({ width: el.clientWidth, height: el.clientHeight });
        } catch {
          try {
            editor.layout();
          } catch {
            // ignore
          }
        }
      });
    },
    []
  );

  useEffect(() => {
    return () => {
      for (const observer of paneBodyResizeObserversRef.current.values()) {
        try {
          observer.disconnect();
        } catch {
          // ignore
        }
      }
      paneBodyResizeObserversRef.current.clear();
    };
  }, []);

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
      if (action === 'workstudio.triggerSuggest') {
        void triggerSuggest();
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
    triggerSuggest,
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
      setFilePaletteIndex(0);
      setFilePaletteError(null);
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
      setFilePaletteError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void invoke<string[]>('workstudio_find_files', {
        args: { workstudioId: ws.id, query: q, limit: 200 },
      })
        .then((res) => {
          setFilePaletteResults(res);
          setFilePaletteIndex(0);
          setFilePaletteError(null);
        })
        .catch((error) => {
          const msg = toErrorMessage(error);
          console.error('workstudio_find_files failed:', { workstudioId: ws.id, query: q, error });
          setFilePaletteResults([]);
          setFilePaletteIndex(0);
          setFilePaletteError(msg);
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
    setOutlineOpen(true);
    setLeftSidebarTab('explorer');
    setOutlineCollapsedKeys(new Set());
    setOutlineActiveKey(null);
    setOutlineFileStateByPath({});
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

        if (typeof state.outline?.open === 'boolean') {
          setOutlineOpen(state.outline.open);
        }
        setOutlineFileStateByPath(normalizeOutlineFileStateMap(state.outline?.files));

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
      const outlineFiles = normalizeOutlineFileStateMap(outlineFileStateByPath);
      const hasOutlineFiles = Object.keys(outlineFiles).length > 0;
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
        ...(!outlineOpen || hasOutlineFiles
          ? {
            outline: {
              ...(outlineOpen ? {} : { open: false }),
              ...(hasOutlineFiles ? { files: outlineFiles } : {}),
            },
          }
          : {}),
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
      void invoke('set_workstudio_ui_state', { workstudioId: ws.id, state }).catch(() => { });
    }, 500);
    return () => {
      if (saveStateTimerRef.current) window.clearTimeout(saveStateTimerRef.current);
    };
  }, [
    ws,
    openFiles,
    resolvedPanes,
    resolvedFocusedPaneId,
    expandedDirs,
    editorFontSize,
    outlineOpen,
    outlineFileStateByPath,
    wsEnabledLspLanguageIds,
  ]);

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

  // Code Index 事件（后端后台扫描/写入缓存）-> 让 Outline 可以“增量更新”，且重启后快速恢复。
  useEffect(() => {
    if (!isTauri()) return;
    const wsId = ws?.id ?? null;
    if (!wsId) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;
    void listen('code-index:event', (event) => {
      const payload = (event as any)?.payload as any;
      if (!payload) return;
      if (payload.workstudioId !== wsId) return;
      const type = String(payload.type ?? '').trim();
      if (!type) return;

      // 扫描完成 -> 刷新简报（用于判断“上一次索引落盘是否成功”）
      if (type === 'progress') {
        const phase = String(payload.phase ?? '').trim();
        const message = String(payload.message ?? '').trim();
        const done = typeof payload.done === 'number' ? payload.done : null;
        const total = typeof payload.total === 'number' ? payload.total : null;
        if (phase === 'scan' && (message.includes('索引扫描完成') || (done === 1 && total === 1))) {
          void refreshCodeIndexBrief();
        }
        return;
      }

      if (type !== 'document_symbols_updated') return;

      const filePath = normalizeFsPath(String(payload.filePath ?? '').trim());
      if (!filePath) return;
      const activePath = activeOutlineFilePathRef.current;
      if (!activePath || normalizeFsPath(activePath) !== filePath) return;

      // 如果当前已经用 LSP 成功生成过 Outline，就不要被 AST 缓存覆盖。
      if (outlineSourceRef.current === 'lsp' && outlineItemsRef.current.length > 0) return;

      const symbols = payload.symbols ?? null;
      if (!symbols) return;

      let nextItems: OutlineItem[] = [];
      try {
        nextItems = astSymbolsToOutline(symbols as any);
      } catch {
        return;
      }
      if (nextItems.length === 0) return;

      const allKeys = collectOutlineKeys(nextItems);
      const collapsibleKeys = collectOutlineCollapsibleKeys(nextItems);
      const collapsibleKeySet = new Set(collapsibleKeys);
      const persistedViewState = outlineFileStateByPathRef.current[filePath];
      const persistedCollapsed = Array.isArray(persistedViewState?.collapsedKeys)
        ? persistedViewState.collapsedKeys.filter((key) => collapsibleKeySet.has(key))
        : collapsibleKeys;
      const collapsedSet = new Set(persistedCollapsed);
      const persistedActiveKey = String(persistedViewState?.activeKey ?? '').trim();
      const restoredActiveKey = persistedActiveKey && allKeys.has(persistedActiveKey) ? persistedActiveKey : null;

      setOutlineItems(nextItems);
      setOutlineSource('ast');
      setOutlineCollapsedKeys(collapsedSet);
      setOutlineActiveKey((prev) => {
        if (restoredActiveKey) return restoredActiveKey;
        return prev && allKeys.has(prev) ? prev : null;
      });
      setOutlineError(null);
      setOutlineLoading(false);
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((e) => {
        console.warn('[Workstudio][CodeIndex] listen code-index:event failed:', e);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshCodeIndexBrief, ws?.id]);

  // 打开“代码智能”面板时，拉取一次索引落盘简报（DB meta + 统计）。
  useEffect(() => {
    if (!lspMenu) return;
    void refreshCodeIndexBrief();
  }, [lspMenu, refreshCodeIndexBrief]);

  useEffect(() => {
    if (!contextMenu && !tabMenu && !lspMenu && !outlineMenu) return;
    const onDown = () => {
      setContextMenu(null);
      setTabMenu(null);
      setLspMenu(null);
      setOutlineMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [contextMenu, lspMenu, outlineMenu, tabMenu]);

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
      .catch(() => { });

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
      .catch(() => { });

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
            e.preventDefault();
            e.stopPropagation();
            setContextMenu(
              isRoot
                ? { visible: true, x: e.clientX, y: e.clientY, kind: 'root', folder: dirPath }
                : { visible: true, x: e.clientX, y: e.clientY, kind: 'folder', folder: dirPath }
            );
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
                className={[
                  'px-2 py-1 text-[11px]',
                  dirErrors[dirPath] ? 'text-red-600 dark:text-red-300' : 'text-gray-400',
                ].join(' ')}
                style={{ paddingLeft: 8 + (depth + 1) * 14 }}
              >
                {dirErrors[dirPath] ? dirErrors[dirPath] : '(空)'}
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, kind: 'file', file: entry.path });
                    }}
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
      {aiBubbles.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[210] flex max-w-[360px] flex-col items-end gap-2">
	          {aiBubbles.map((b) => {
	            const ACTIVE_STATUSES: WorkstudioAiBubbleStatus[] = ['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'];
	            const isActive = ACTIVE_STATUSES.includes(b.status);
	            return (
	              <button
	                key={b.id}
	                type="button"
	                onClick={() => {
	                  const isTerminalState = b.status === 'done' || b.status === 'error';
	                  if (b.kind === 'symbol_analysis' && isTerminalState) {
	                    void (async () => {
	                      try {
	                        const meta = b.analysisMeta ?? null;
	                        if (!meta) {
	                          throw new Error('缺少符号分析元信息，无法打开结果');
	                        }

	                        let loaded: WorkstudioSymbolAnalysis | null = null;
	                        try {
	                          loaded = await ensureSymbolAnalysis(meta.filePath, meta.symbolKey);
	                        } catch {
	                          loaded = null;
	                        }

	                        const answerFromBlocks = (() => {
	                          const blocks = b.blocks ?? [];
	                          const textBlocks = blocks.filter((blk) => blk.type === 'text');
	                          if (textBlocks.length === 0) return null;
	                          const finalBlock =
	                            textBlocks.find((blk) => String(blk.id ?? '').endsWith(':assistant_text:final')) ??
	                            textBlocks[textBlocks.length - 1] ??
	                            null;
	                          return typeof finalBlock?.text === 'string' ? finalBlock.text : null;
	                        })();

	                        const answerMd =
	                          loaded?.answerMd ??
	                          answerFromBlocks ??
	                          (b.status === 'error'
	                            ? `**错误**\n\n\`\`\`text\n${b.error || '未知错误'}\n\`\`\`\n`
	                            : '');

	                        if (!answerMd.trim()) {
	                          showNavToast('暂无可打开的分析内容');
	                          openAiViewer(b.id);
	                          return;
	                        }

	                        const docInput: Pick<
	                          WorkstudioSymbolAnalysis,
	                          | 'id'
	                          | 'filePath'
	                          | 'selectionLine'
	                          | 'selectionColumn'
	                          | 'symbolName'
	                          | 'languageId'
	                          | 'symbolKind'
	                          | 'modelRef'
	                          | 'latencyMs'
	                          | 'updatedAt'
	                          | 'answerMd'
	                        > = loaded ?? {
	                          id: crypto.randomUUID(),
	                          filePath: meta.filePath,
	                          languageId: meta.languageId,
	                          symbolName: meta.symbolName,
	                          symbolKind: meta.symbolKind,
	                          selectionLine: meta.selectionLine,
	                          selectionColumn: meta.selectionColumn,
	                          answerMd,
	                          modelRef: b.modelRef,
	                          latencyMs: b.latencyMs,
	                          updatedAt: new Date().toISOString(),
	                        };

	                        const content = buildWorkstudioSymbolAnalysisRichTextDoc(docInput);
	                        openVirtualRichTextFile(`分析：${meta.symbolName}`, content);

	                        // 打开后移除气泡，避免堆积（分析结果可随时通过 Outline -> 查看分析 再次打开）
	                        if (aiViewerId === b.id) setAiViewerId(null);
	                        setAiBubbles((prev) => prev.filter((x) => x.id !== b.id));
	                      } catch (err) {
	                        const message = err instanceof Error ? err.message : String(err);
	                        showNavToast(message);
	                        openAiViewer(b.id);
	                      }
	                    })();
	                    return;
	                  }

	                  openAiViewer(b.id);
	                }}
	                className={[
	                  'flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left shadow-sm',
	                  'bg-white/95 hover:bg-white disabled:opacity-70 dark:bg-gray-950/90 dark:hover:bg-gray-950',
	                  'border-gray-200 dark:border-gray-800',
                  'cursor-pointer',
                ].join(' ')}
                title={b.subtitle}
              >
                <span className="shrink-0">
                  {isActive && <Loader2 size={14} className="animate-spin text-gray-500" />}
                  {b.status === 'done' && <CheckCircle2 size={14} className="text-emerald-600 dark:text-emerald-300" />}
                  {b.status === 'error' && <AlertTriangle size={14} className="text-red-600 dark:text-red-300" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">
                    {b.name}
                  </div>
	                  <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">
	                    {describeWorkstudioAiBubbleStatus(b.status)}
	                  </div>
	                </div>
	                {b.kind === 'symbol_analysis' ? (
	                  <ListTree size={14} className="shrink-0 opacity-60" />
	                ) : (
                  <MessageSquare size={14} className="shrink-0 opacity-60" />
                )}
              </button>
            );
          })}

        </div>
      )}

      {inlineChatComposer.open && inlineChatComposer.selection && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Chat with</div>
                <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">
                  {inlineChatComposer.selection.label}
                </div>
              </div>
              <button
                type="button"
                className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                onClick={closeInlineChatComposer}
                title="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">选中代码</div>
              <pre className="max-h-40 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-800 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                {(() => {
                  const raw = inlineChatComposer.selection?.text ?? '';
                  const limit = 2200;
                  return raw.length > limit ? `${raw.slice(0, limit)}\n…（已截断）` : raw;
                })()}
              </pre>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">你的问题</div>
              <textarea
                value={inlineChatComposer.question}
                onChange={(e) => setInlineChatComposer((prev) => ({ ...prev, question: e.target.value }))}
                rows={3}
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500/40 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                placeholder="例如：这段代码为什么会这样设计？可能的 bug 在哪？"
              />
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-200 dark:hover:bg-gray-900/40"
                onClick={closeInlineChatComposer}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={!inlineChatComposer.question.trim()}
                onClick={() => void submitInlineChat()}
              >
                发送
              </button>
            </div>
          </div>
        </div>
      )}

      {aiViewer && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/35 p-4">
          <div className="flex w-full max-w-3xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950" style={{ maxHeight: '85vh' }}>
            {/* Header */}
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 p-4 dark:border-gray-800">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {aiViewer.name}
                </div>
                <div className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-gray-500 dark:text-gray-400">
                  <span>{aiViewer.subtitle}</span>
                  {aiViewer.agentName && <span className="rounded bg-blue-50 px-1 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">{aiViewer.agentName}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Abort button for active bubbles */}
                {['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'].includes(aiViewer.status) && (
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                    onClick={() => {
                      if (!isTauri()) return;
                      const bubbleId = aiViewer.id;

	                      if (aiViewer.kind === 'symbol_analysis') {
	                        // 符号分析使用 run_task/run:event：优先用 conversationId 走 abort_run。
	                        // 注意：queued/connecting 阶段可能还在 startQueuedSymbolAnalysis 里，这里用一个 cancel 标记让启动流程尽快退出。
	                        if (aiViewer.status === 'queued' || aiViewer.status === 'connecting') {
	                          cancelledSymbolAnalysisBubbleIdsRef.current.add(bubbleId);
	                        }

	                        const convIdDirect = (aiViewer.conversationId ?? '').trim();
	                        const convIdFromMap = String(
	                          symbolAnalysisConversationIdByBubbleIdRef.current.get(bubbleId) ?? ''
	                        ).trim();
	                        const convId = convIdDirect || convIdFromMap;

	                        if (convId) {
	                          void invoke('abort_run', { conversationId: convId }).catch(() => {});
	                        }

	                        const bubble = aiBubblesRef.current.find((b) => b.id === bubbleId) ?? null;
	                        // 立即本地清理“该符号正在分析中/队列中”的锁与 UI 状态：
	                        // - 不能依赖 run:event 的 done/error（取消时可能丢事件或被过滤），否则会出现“取消后无法再次分析”的卡死。
	                        if (bubble?.analysisMeta) {
	                          const analysisKey = makeSymbolAnalysisCacheKey(
	                            bubble.analysisMeta.filePath,
	                            bubble.analysisMeta.symbolKey
	                          );
	                          activeSymbolAnalysisKeysRef.current.delete(analysisKey);
	                        }

	                        setAiBubbles((prev) => {
		                          const next = prev.map((b) =>
		                            b.id === bubbleId
		                              ? { ...b, status: 'error' as WorkstudioAiBubbleStatus, error: '已中止' }
	                              : b
	                          );
	                          aiBubblesRef.current = next;
	                          return next;
	                        });
	                        scheduleSymbolAnalysisRunsRef.current?.();
	                        return;
	                      }

                      const convId = (aiViewer.conversationId ?? '').trim();
                      if (convId) void invoke('abort_run', { conversationId: convId }).catch(() => {});
                      else void invoke('workstudio_abort_agent', { runId: aiViewer.id }).catch(() => {});
                    }}
                  >
                    中止
                  </button>
                )}
                <button
                  type="button"
                  className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  onClick={closeAiViewer}
                  title="关闭并移除气泡"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
              {/* Prompt */}
              <details open={false}>
                <summary className="cursor-pointer select-none text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                  {aiViewer.kind === 'symbol_analysis' ? '分析指令' : '问题'}
                </summary>
                <div className="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                  {aiViewer.prompt}
                </div>
              </details>

              {/* run_task bubbles：复用 ChatView 的 blocks 渲染（含工具/审批/多 turn） */}
              {aiViewer.conversationId ? (
                <div>
                  <div className="mb-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">
	                    {aiViewer.kind === 'symbol_analysis' ? '分析结果' : '回答'}
	                    {['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'].includes(aiViewer.status) && (
	                      <span className="ml-1.5 inline-flex items-center gap-1 text-blue-500">
	                        <Loader2 size={10} className="animate-spin" />
	                        {describeWorkstudioAiBubbleStatus(aiViewer.status)}
	                      </span>
	                    )}
	                  </div>

                  {aiViewer.status === 'error' && (!aiViewer.blocks || aiViewer.blocks.length === 0) ? (
                    <pre className="whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-red-700 dark:border-gray-800 dark:bg-gray-950 dark:text-red-300">
                      {aiViewer.error || '未知错误'}
                    </pre>
                  ) : aiViewer.blocks && aiViewer.blocks.length > 0 ? (
                    <MessageBlocks
                      blocks={aiViewer.blocks}
                      conversationId={aiViewer.conversationId}
                      isStreaming={['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'].includes(aiViewer.status)}
                      messageSource="live"
                      turns={aiViewer.turns}
                      assistantMessageId={aiViewer.assistantMessageId}
                    />
                  ) : (
                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
                      暂无输出…
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Thinking (collapsible) */}
                  {aiViewer.thinking && (
                    <details open={false}>
                      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-purple-600 dark:text-purple-400 hover:text-purple-700">
                        <Loader2 size={11} className={['animate-spin', aiViewer.status === 'thinking' ? '' : 'hidden'].join(' ')} />
                        思考过程 ({aiViewer.thinking.length} 字符)
                      </summary>
                      <div className="mt-1 rounded-lg bg-purple-50/50 px-3 py-2 text-[12px] text-purple-900 dark:bg-purple-900/10 dark:text-purple-200 border border-purple-100 dark:border-purple-800/30 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                        {aiViewer.thinking}
                      </div>
                    </details>
                  )}

                  {/* Tool calls */}
                  {aiViewer.toolCalls && aiViewer.toolCalls.length > 0 && (
                    <details open={aiViewer.status === 'tool_calling'}>
                      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        <Loader2 size={11} className={['animate-spin', aiViewer.status === 'tool_calling' ? '' : 'hidden'].join(' ')} />
                        工具调用 ({aiViewer.toolCalls.length})
                      </summary>
                      <div className="mt-1 space-y-1.5">
                        {aiViewer.toolCalls.map((tc) => (
                          <div key={tc.id} className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-800/30 dark:bg-amber-900/10 px-3 py-2">
                            <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">{tc.name}</div>
                            <pre className="mt-0.5 text-[11px] text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words opacity-80">{tc.arguments}</pre>
                            {tc.result && (
                              <pre className="mt-1 border-t border-amber-200 dark:border-amber-800/30 pt-1 text-[11px] text-green-800 dark:text-green-300 whitespace-pre-wrap break-words">{tc.result}</pre>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Main answer */}
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">
	                      {aiViewer.kind === 'symbol_analysis' ? '分析结果' : '回答'}
	                      {['queued', 'connecting', 'thinking', 'streaming', 'tool_calling'].includes(aiViewer.status) && (
	                        <span className="ml-1.5 inline-flex items-center gap-1 text-blue-500">
	                          <Loader2 size={10} className="animate-spin" />
	                          {describeWorkstudioAiBubbleStatus(aiViewer.status)}
	                        </span>
	                      )}
	                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-950">
                      {aiViewer.status === 'error' ? (
                        <pre className="whitespace-pre-wrap break-words text-xs text-red-700 dark:text-red-300">
                          {aiViewer.error || '未知错误'}
                        </pre>
                      ) : (
                        <DeferredMarkdown content={aiViewer.answer || ''} conversationId={null} minDelayMs={120} />
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-gray-100 px-4 py-2 dark:border-gray-800">
              <div className="truncate text-[11px] text-gray-400 dark:text-gray-500">
                {aiViewer.modelRef && <span>model: {aiViewer.modelRef}</span>}
                {aiViewer.latencyMs && <span>  ·  {aiViewer.latencyMs}ms</span>}
              </div>
              <button
                type="button"
                className="rounded px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                onClick={closeAiViewer}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-[300px] flex-shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
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

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
              <button
                type="button"
                className={[
                  'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide',
                  leftSidebarTab === 'explorer' || !outlineOpen
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                    : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
                ].join(' ')}
                onClick={() => setLeftSidebarTab('explorer')}
              >
                Explorer
              </button>
              {outlineOpen && (
                <button
                  type="button"
                  className={[
                    'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide',
                    leftSidebarTab === 'outline'
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                      : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
                  ].join(' ')}
                  onClick={() => setLeftSidebarTab('outline')}
                >
                  Outline{outlineItemCount > 0 ? `(${outlineItemCount})` : ''}
                </button>
              )}
            </div>

            {(!outlineOpen || leftSidebarTab === 'explorer') && (
              <div
                className="min-h-0 flex-1 overflow-auto px-2 py-2"
                ref={explorerContainerRef}
                onContextMenu={(e) => {
                  const target = e.target as HTMLElement | null;
                  e.preventDefault();
                  if (target && target.closest('[data-ws-node="1"]')) return;
                  setContextMenu({ visible: true, x: e.clientX, y: e.clientY, kind: 'blank' });
                }}
              >

                <div className="space-y-1">
                  {rootFolders.map((folder) =>
                    renderDirNode(folder, 0, { isRoot: true, isMainRoot: folder === ws.mainFolder })
                  )}
                </div>
              </div>
            )}

            {outlineOpen && leftSidebarTab === 'outline' && (
              <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-gray-950">
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
                    className="rounded border border-gray-200 px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                    disabled={
                      !codeIntelligenceConfig?.symbolAnalysis?.enabled ||
                      !activeTextFileInFocusedPane ||
                      outlineItems.length === 0 ||
                      outlineLoading
                    }
                    onClick={() => void runOutlineAnalyzeAll()}
                    title={
                      !codeIntelligenceConfig?.symbolAnalysis?.enabled
                        ? '请先在“设置 -> 代码智能 -> 符号分析”中启用'
                        : outlineItems.length === 0
                          ? 'Outline 为空：没有可解析的符号'
                          : `批量解析当前文件的全部符号（${
                            codeIntelligenceConfig?.symbolAnalysis?.bulkExcludeVariables !== false ? '跳过变量/字段' : '包含变量/字段'
                          }）`
                    }
                  >
                    全部解析
                  </button>
                  <button
                    type="button"
                    className="rounded border border-gray-200 p-1 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    onClick={() => {
                      setOutlineRefreshSeq((v) => v + 1);
                      if (!isTauri()) return;
                      const wsId = ws?.id ?? null;
                      const file = activeTextFileInFocusedPane;
                      if (!wsId || !file) return;
                      const normalizedPath = normalizeFsPath(file.path);
                      if (!normalizedPath || isUntitledPath(normalizedPath)) return;
                      const indexable = ['rust', 'typescript', 'javascript', 'python', 'c', 'cpp', 'lua'].includes(
                        activeTextLanguageId
                      );
                      if (!indexable) return;
                      setOutlineLoading(true);
                      void codeIndexRequestDocumentSymbols({
                        workstudioId: wsId,
                        filePath: normalizedPath,
                        languageId: activeTextLanguageId,
                        priority: CODE_INDEX_PRIORITY_USER,
                        force: true,
                      }).catch(() => {});
                    }}
                    title="刷新 Outline"
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
                <div
                  className="min-h-0 flex-1 overflow-auto px-2 py-2"
                  ref={outlineContainerRef}
                  onScroll={handleOutlineScroll}
                >
                  {!activeTextFileInFocusedPane ? (
                    <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
                      打开文本文件后可查看函数、属性与符号结构。
                    </div>
                  ) : (
                    <>
                      {outlineItems.length > 0 ? (
                        <div className="space-y-1">
                          {outlineLoading && (
                            <div className="px-2 pb-1 text-[11px] text-gray-500 dark:text-gray-400">
                              更新中...
                            </div>
                          )}
                          {outlineError && (
                            <div className="px-2 pb-1 text-[11px] text-red-600 dark:text-red-300">
                              {outlineError}
                            </div>
                          )}
                          <div className="space-y-0.5">
                            {renderOutlineNodes(outlineItems)}
                          </div>
                        </div>
                      ) : outlineLoading ? (
                        <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
                          生成 Outline 中...
                        </div>
                      ) : outlineError ? (
                        <div className="px-2 py-2 text-xs text-red-600 dark:text-red-300">
                          {outlineError}
                        </div>
                      ) : (
                        <div className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
                          未检测到可展示的符号。
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
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
                onClick={() => {
                  setOutlineOpen((prev) => {
                    const next = !prev;
                    setLeftSidebarTab(next ? 'outline' : 'explorer');
                    return next;
                  });
                }}
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
                <div ref={paneRowRef} className="flex h-full min-h-0 w-full flex-row overflow-hidden">
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

                            <div ref={registerPaneBodyRef(pane.id)} className="min-h-0 flex-1 overflow-hidden">
                              {activeFile ? (
                                activeFile.kind === 'text' ? (
                                  <div className="h-full min-h-0 w-full" onWheelCapture={onEditorWheelCapture}>
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
                                        if (typeof value !== 'string') return;
                                        const nextValue = value;
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
                                        suggest: {
                                          showWords: codeIntelligenceConfig?.monacoWordSuggestionsEnabled !== false,
                                        },
                                        wordBasedSuggestions:
                                          codeIntelligenceConfig?.monacoWordSuggestionsEnabled === false
                                            ? 'off'
                                            : 'matchingDocuments',
                                        wordBasedSuggestionsOnlySameLanguage: true,
                                        inlineSuggest: { enabled: true },
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
                                ) : activeFile.kind === 'markdown' ? (
                                  <div className="h-full min-h-0 w-full overflow-auto bg-white p-6 dark:bg-gray-950">
                                    <div className="mx-auto max-w-4xl">
                                      <MarkdownRenderer content={activeFile.content ?? ''} workstudioId={workstudioId ?? undefined} />
                                    </div>
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
                                          src={`data:application/pdf;base64,${activeFile.base64}#page=1&view=FitH`}
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

          </div>

        </div>
      </div>

      {filePaletteOpen && (
        <div className="fixed inset-0 z-[210]">
          <div
            className="absolute inset-0 bg-black/25 backdrop-blur-[1px]"
            onClick={() => {
              setFilePaletteOpen(false);
              setFilePaletteQuery('');
              setFilePaletteResults([]);
              setFilePaletteIndex(0);
              setFilePaletteError(null);
            }}
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
                    setFilePaletteIndex(0);
                    setFilePaletteError(null);
                    void openFileAtPath(picked);
                  }
                }}
              />

              <div className="mt-3 max-h-[55vh] overflow-auto rounded-xl border border-gray-200 dark:border-gray-700">
                {filePaletteError ? (
                  <div className="px-3 py-3 text-sm text-red-600 dark:text-red-300 whitespace-pre-wrap break-words">
                    {filePaletteError}
                  </div>
                ) : filePaletteResults.length === 0 ? (
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
                        setFilePaletteIndex(0);
                        setFilePaletteError(null);
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
	                    <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
	                      <div className="flex items-center justify-between gap-2">
	                        <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">索引简报</div>
	                        <button
	                          type="button"
	                          className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
	                          onClick={() => void refreshCodeIndexBrief()}
	                          title="重新拉取本地落盘索引状态"
	                        >
	                          刷新
	                        </button>
	                      </div>

	                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
	                        用于判断上一次“本地索引缓存”是否落盘成功（与 rust-analyzer 自身缓存不同）。
	                      </div>

	                      {codeIndexBriefError ? (
	                        <div className="mt-1 text-[11px] text-red-700 dark:text-red-200 whitespace-pre-wrap break-words">
	                          读取索引缓存简报失败：{codeIndexBriefError}
	                        </div>
	                      ) : codeIndexBrief ? (
	                        <div className="mt-2 space-y-1 text-[11px] text-gray-700 dark:text-gray-200">
	                          <div className="flex items-center justify-between gap-2">
	                            <div className="min-w-0 truncate">
	                              DB：<span className="font-mono">{codeIndexBrief.dbPath}</span>
	                            </div>
	                            <div className="flex flex-shrink-0 items-center gap-2 text-gray-500 dark:text-gray-400">
	                              <span>symbols={codeIndexBrief.fileSymbolsCount}</span>
	                              <span>
	                                {codeIndexBrief.shouldSkipFullScan ? '可跳过全量扫描' : '可能触发全量扫描'}
	                              </span>
	                            </div>
	                          </div>
	                          <div className="text-gray-500 dark:text-gray-400">
	                            上次扫描完成：
	                            {codeIndexBrief.fullScanCompletedAtMs
	                              ? new Date(codeIndexBrief.fullScanCompletedAtMs).toLocaleString()
	                              : '（未记录）'}
	                            {codeIndexBrief.fullScanCompletedAtMs
	                              ? ` · roots=${codeIndexBrief.sameRoots ? '一致' : '变化'} · fresh=${
	                                  codeIndexBrief.isFresh ? '是' : '否'
	                                }`
	                              : ''}
	                          </div>
	                        </div>
	                      ) : (
	                        <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">（尚未生成简报）</div>
	                      )}

	                      {lspIndexBriefs.length > 0 && (
	                        <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-800">
	                          <div className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">
	                            LSP 最近完成索引
	                          </div>
	                          <div className="mt-1 space-y-1">
	                            {lspIndexBriefs.slice(0, 3).map((b) => (
	                              <div key={`lsp-brief:${b.languageId}:${b.completedAtMs}`} className="text-[11px] text-gray-600 dark:text-gray-300">
	                                <span className="font-mono">{b.languageId}</span> ·{' '}
	                                {new Date(b.completedAtMs).toLocaleTimeString()}
	                                {typeof b.durationMs === 'number' ? ` · ${Math.round(b.durationMs / 1000)}s` : ''}
	                                {b.hadError ? ' · 有错误' : ''}
	                                {b.lastProgress ? ` · ${b.lastProgress}` : ''}
	                              </div>
	                            ))}
	                          </div>
	                          <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
	                            说明：LSP “索引完成”表示已就绪可用；是否复用 rust-analyzer 内部落盘缓存，本应用无法直接确认（可用重启耗时对比判断）。
	                          </div>
	                        </div>
	                      )}
	                    </div>

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

      {outlineMenu && (
        <div
          className="fixed z-[205] min-w-[220px] rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ left: outlineMenu.x, top: outlineMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
	            const busyStatus = getActiveSymbolAnalysisStatus(outlineMenu.filePath, outlineMenu.item.key);
	            const isBusy = Boolean(busyStatus);
	            const actionLabel = outlineMenu.analysis ? '重新分析' : outlineAnalysisActionLabel(outlineMenu.item.kind);
	            const statusTag = (() => {
	              switch (busyStatus) {
	                case 'queued':
	                  return '（排队中）';
	                case 'connecting':
	                  return '（连接中）';
	                case 'thinking':
	                  return '（思考中）';
	                case 'tool_calling':
	                  return '（调用工具）';
	                case 'streaming':
	                  return '（生成中）';
	                default:
	                  return '';
	              }
	            })();

	            return (
	              <>
	          <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 truncate" title={outlineMenu.item.name}>
	            {outlineMenu.item.name}
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {normalizeOutlineKind(outlineMenu.item.kind)}
            </span>
          </div>
          <div className="py-1 text-sm">
            <button
              type="button"
              disabled={isBusy}
              title={isBusy ? '该符号正在分析中（或在队列中），请等待完成后再试' : undefined}
              className={[
                'w-full px-3 py-2 text-left',
                isBusy
                  ? 'cursor-not-allowed text-gray-400 dark:text-gray-600'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
              ].join(' ')}
              onClick={() => {
                const menu = outlineMenu;
                const hasExisting = Boolean(menu.analysis);
                if (hasExisting) {
                  const ok = confirm('已存在分析结果，确定重新分析并覆盖吗？');
                  if (!ok) return;
                }
                setOutlineMenu(null);
                void (async () => {
                  try {
                    await runOutlineSymbolAnalysis(menu.filePath, menu.languageId, menu.item);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    showNavToast(msg);
                  }
                })();
              }}
            >
              <span>{actionLabel}</span>
              <span className="text-gray-400">：</span>
              <span
                className={outlineMenu.analysis ? 'text-emerald-700 dark:text-emerald-300' : ''}
              >
                {outlineMenu.item.name}
              </span>
              {statusTag ? <span className="ml-2 text-xs text-gray-400 dark:text-gray-600">{statusTag}</span> : null}
            </button>

            {outlineMenu.analysis === undefined ? (
              <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">加载分析状态中…</div>
            ) : outlineMenu.analysis ? (
              <>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                  onClick={() => {
                    const menu = outlineMenu;
                    setOutlineMenu(null);
                    void viewOutlineSymbolAnalysis(menu.filePath, menu.item);
                  }}
                >
                  查看分析
                </button>
                <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-red-600 hover:bg-gray-100 dark:text-red-400 dark:hover:bg-gray-800"
                  onClick={() => {
                    const menu = outlineMenu;
                    setOutlineMenu(null);
                    void deleteOutlineSymbolAnalysis(menu.filePath, menu.item);
                  }}
                >
                  删除分析
                </button>
              </>
            ) : (
              <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">尚无分析结果</div>
            )}
          </div>
              </>
            );
          })()}
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

          {contextMenu.kind === 'folder' && (
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
                  void toggleDir(folder);
                }}
              >
                {expandedDirs.has(contextMenu.folder) ? '折叠' : '展开'}
              </button>
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
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const folder = contextMenu.folder;
                  setContextMenu(null);
                  void navigator.clipboard.writeText(folder);
                }}
              >
                复制路径
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const folder = contextMenu.folder;
                  setContextMenu(null);
                  void addPathToMainChat(folder, 'folder');
                }}
              >
                加入到 Chat
              </button>
            </div>
          )}

          {contextMenu.kind === 'file' && (
            <div className="py-1 text-sm">
              <div
                className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 truncate"
                title={contextMenu.file}
              >
                {contextMenu.file}
              </div>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const file = contextMenu.file;
                  setContextMenu(null);
                  void openFileAtPath(file);
                }}
              >
                打开
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const file = contextMenu.file;
                  setContextMenu(null);
                  void revealItemInDir(file);
                }}
              >
                在系统中打开所在文件夹
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const file = contextMenu.file;
                  setContextMenu(null);
                  void navigator.clipboard.writeText(file);
                }}
              >
                复制路径
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                onClick={() => {
                  const file = contextMenu.file;
                  setContextMenu(null);
                  void addPathToMainChat(file, 'file');
                }}
              >
                加入到 Chat
              </button>
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-red-600 hover:bg-gray-100 dark:text-red-400 dark:hover:bg-gray-800"
                onClick={() => {
                  const file = contextMenu.file;
                  setContextMenu(null);
                  void deleteExplorerFile(file);
                }}
              >
                删除文件
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
