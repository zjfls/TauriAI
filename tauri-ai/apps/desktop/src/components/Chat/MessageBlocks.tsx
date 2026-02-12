/**
 * MessageBlocks
 *
 * 统一的“输出块”渲染入口：
 * - 同一套渲染逻辑同时用于：历史消息（assistant.blocks）与 streaming（run:event）。
 * - 后续新增 tool/websearch/多模态输出时，只需要：
 *   1) 在 sessionStore 里把对应 blockType 聚合成 blocks
 *   2) 在这里补上对应 block 的渲染组件
 */

 import React, { useEffect, useMemo, useRef, useState } from 'react';
 import { AlertTriangle, Brain, Bug, ChevronDown, ChevronRight, RefreshCw, Search, Wrench } from 'lucide-react';
 import { invoke, isTauri } from '@tauri-apps/api/core';
 import type {
   AnsiColorMode,
   AnsiRenderMode,
   MessageBlock,
   MessageSource,
   MessageTurn,
   Workstudio,
   WorkstudioSecurityConfig,
 } from '../../types';
import { DeferredMarkdown } from './DeferredMarkdown';
import { AnsiText } from './AnsiText';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { DebugModal } from './DebugModal';

const TOOL_SUMMARY_MAX_CHARS = 220;
const TOOL_SUMMARY_SCAN_MAX_CHARS = 30_000;
const TOOL_SUMMARY_EXTRACT_VALUE_MAX_CHARS = 2_000;

const normalizeToolSummary = (value: string): string => {
  const oneLine = value.replace(/\r\n/g, '\n').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TOOL_SUMMARY_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, TOOL_SUMMARY_MAX_CHARS - 1)}…`;
};

const extractJsonStringField = (raw: string, key: string): string | null => {
  if (!raw) return null;
  if (!key) return null;

  const haystack = raw.length > TOOL_SUMMARY_SCAN_MAX_CHARS ? raw.slice(0, TOOL_SUMMARY_SCAN_MAX_CHARS) : raw;
  const needle = `"${key}"`;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    let j = idx - 1;
    while (j >= 0 && /\s/.test(haystack[j])) j--;
    if (j < 0 || haystack[j] === '{' || haystack[j] === ',') break;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  if (idx === -1) return null;

  let i = idx + needle.length;
  while (i < haystack.length && /\s/.test(haystack[i])) i++;
  if (haystack[i] !== ':') return null;
  i++;
  while (i < haystack.length && /\s/.test(haystack[i])) i++;
  if (haystack[i] !== '"') return null;
  i++;

  let out = '';
  let escaped = false;
  while (i < haystack.length) {
    const ch = haystack[i++];
    if (escaped) {
      escaped = false;
      switch (ch) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = haystack.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
          } else {
            out += 'u';
          }
          break;
        }
        default:
          out += ch;
          break;
      }
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      break;
    } else {
      out += ch;
    }

    if (out.length >= TOOL_SUMMARY_EXTRACT_VALUE_MAX_CHARS) {
      out += '…';
      break;
    }
  }

  return out;
};

const extractApplyPatchOps = (rawArgs: string): string[] => {
  if (!rawArgs) return [];
  const haystack = rawArgs.length > TOOL_SUMMARY_SCAN_MAX_CHARS ? rawArgs.slice(0, TOOL_SUMMARY_SCAN_MAX_CHARS) : rawArgs;
  const ops: string[] = [];
  const re = /\*\*\*\s+(Update|Add|Delete)\s+File:\s*([^\r\n\\]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    const action = (m[1] || '').trim();
    const path = (m[2] || '').trim();
    if (!action || !path) continue;
    ops.push(`${action} ${path}`);
    if (ops.length >= 3) break;
  }
  return ops;
};

const extractToolSummary = (toolName: string, rawArgs: string, parsedArgs: unknown | null): string => {
  const tool = (toolName || '').trim();
  if (!tool) return '';

  const raw = rawArgs || '';
  const obj = parsedArgs && typeof parsedArgs === 'object' ? (parsedArgs as any) : null;
  const getObjString = (key: string): string | null => (obj && typeof obj[key] === 'string' ? obj[key] : null);
  const getRawString = (key: string): string | null => extractJsonStringField(raw, key);

  switch (tool) {
    case 'shell_command': {
      const command = getObjString('command') ?? getRawString('command');
      return command ? normalizeToolSummary(command) : '';
    }
    case 'exec_command':
    case 'exec_command_persistent': {
      const cmd = getObjString('cmd') ?? getRawString('cmd');
      return cmd ? normalizeToolSummary(cmd) : '';
    }
    case 'write_stdin':
    case 'write_stdin_persistent': {
      const chars = getObjString('chars') ?? getRawString('chars');
      return chars ? normalizeToolSummary(chars) : '';
    }
    case 'read_file': {
      const filePath =
        getObjString('file_path') ?? getRawString('file_path') ?? getObjString('path') ?? getRawString('path');
      return filePath ? normalizeToolSummary(filePath) : '';
    }
    case 'list_dir': {
      const dirPath = getObjString('dir_path') ?? getRawString('dir_path') ?? getObjString('path') ?? getRawString('path');
      return dirPath ? normalizeToolSummary(dirPath) : '';
    }
    case 'rg': {
      const pattern = getObjString('pattern') ?? getRawString('pattern');
      const include = getObjString('include') ?? getRawString('include');
      const path = getObjString('path') ?? getRawString('path');
      const parts: string[] = [];
      if (pattern) parts.push(pattern);
      if (include) parts.push(`include=${include}`);
      if (path) parts.push(`path=${path}`);
      return parts.length > 0 ? normalizeToolSummary(parts.join(' ')) : '';
    }
    case 'apply_patch': {
      const ops = extractApplyPatchOps(raw);
      if (ops.length > 0) return normalizeToolSummary(`apply_patch: ${ops.join(', ')}`);
      return 'apply_patch';
    }
    case 'view_image': {
      const path = getObjString('path') ?? getRawString('path');
      return path ? normalizeToolSummary(path) : '';
    }
    case 'web_search': {
      const query = getObjString('query') ?? getRawString('query');
      return query ? normalizeToolSummary(query) : '';
    }
    default:
      return '';
  }
};

type ToolRunStatusKind = 'running' | 'success' | 'error' | 'denied' | 'aborted';

const detectToolRunStatus = (resultText?: string): { kind: ToolRunStatusKind; badge?: string } => {
  if (!resultText) return { kind: 'running' };
  const trimmed = resultText.trimStart();

  if (trimmed.startsWith('TOOL_DENIED:')) return { kind: 'denied', badge: '已拒绝' };
  if (trimmed.startsWith('TOOL_ABORTED:')) return { kind: 'aborted', badge: '已终止' };
  if (trimmed.startsWith('TOOL_RESULT_MISSING:')) return { kind: 'error', badge: '结果缺失' };
  if (trimmed.startsWith('TOOL_ERROR:')) return { kind: 'error', badge: '失败' };

  const exitCodeFromSuffix = (() => {
    // shell_command: non-zero exit code is appended as: "\n[exit_code=1]"
    const m = trimmed.match(/\[exit_code=(-?\d+)\]\s*$/);
    if (!m) return null;
    const code = Number(m[1]);
    return Number.isFinite(code) ? code : null;
  })();
  if (typeof exitCodeFromSuffix === 'number' && exitCodeFromSuffix !== 0) {
    return { kind: 'error', badge: `exit_code=${exitCodeFromSuffix}` };
  }

  const exitCodeFromJson = (() => {
    // exec_command / write_stdin: JSON string with { exit_code: number|null, ... }
    if (trimmed.length > 200_000) return null;
    const t = trimmed.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return null;
    try {
      const parsed = JSON.parse(t) as any;
      const raw = parsed && typeof parsed === 'object' ? (parsed.exit_code ?? parsed.exitCode) : null;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
      return null;
    } catch {
      return null;
    }
  })();
  if (typeof exitCodeFromJson === 'number' && exitCodeFromJson !== 0) {
    return { kind: 'error', badge: `exit_code=${exitCodeFromJson}` };
  }

  return { kind: 'success' };
};

	type ApplyPatchToolMeta = {
	  applyPatch?: {
	    baseDir?: string;
	    git?: {
	      repoRoot?: string;
	      workTree?: string;
	      repoPrefix?: string | null;
	      ghostBefore?: string | null;
	      ghostAfter?: string | null;
	      affectedPaths?: string[];
      createdPaths?: string[];
      snapshotErrorBefore?: string;
      snapshotErrorAfter?: string;
      error?: string;
    };
  };
};

type GitDiffCommitsResponse = {
  repoRoot: string;
  from: string;
  to: string;
  summary: { filesChanged: number; insertions: number; deletions: number };
  files: Array<{
    path: string;
    oldPath?: string;
    status: string;
    added?: number;
    deleted?: number;
    isBinary?: boolean;
  }>;
  diff: string;
};

type TaskPatchSummaryGroup = {
  key: string;
  repoRoot: string;
  workTree: string;
  ghostBefore: string;
  ghostAfter: string;
  affectedPaths: string[];
  createdPaths: string[];
};

const buildTaskPatchSummaryGroups = (blocks: MessageBlock[]): TaskPatchSummaryGroup[] => {
  const groups = new Map<string, TaskPatchSummaryGroup>();
  for (const b of blocks) {
    if (!b || (b as any).type !== 'tool_call') continue;
    const toolName = (b as any).name;
    if (toolName !== 'apply_patch') continue;

    const meta = ((b as any).meta ?? null) as ApplyPatchToolMeta | null;
    const git = meta?.applyPatch?.git;
    const repoRoot = typeof git?.repoRoot === 'string' ? git.repoRoot : '';
    const workTree = typeof git?.workTree === 'string' ? git.workTree : '';
    const ghostBefore = typeof git?.ghostBefore === 'string' ? git.ghostBefore : '';
    const ghostAfter = typeof git?.ghostAfter === 'string' ? git.ghostAfter : '';
    const baseDir = typeof meta?.applyPatch?.baseDir === 'string' ? meta.applyPatch.baseDir : '';

    const affectedPaths = Array.isArray(git?.affectedPaths)
      ? git!.affectedPaths!.filter((s) => typeof s === 'string' && s.trim() !== '')
      : [];
    const createdPaths = Array.isArray(git?.createdPaths)
      ? git!.createdPaths!.filter((s) => typeof s === 'string' && s.trim() !== '')
      : [];

    if (!repoRoot || !ghostBefore || affectedPaths.length === 0) continue;

    const effectiveWorkTree = workTree || repoRoot || baseDir || '';
    const key = `${repoRoot}@@${effectiveWorkTree}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        repoRoot,
        workTree: effectiveWorkTree,
        ghostBefore,
        ghostAfter: ghostAfter || '',
        affectedPaths: [...affectedPaths],
        createdPaths: [...createdPaths],
      });
      continue;
    }

    // Keep the earliest ghostBefore; update ghostAfter to the latest non-empty snapshot.
    if (ghostAfter) existing.ghostAfter = ghostAfter;
    existing.affectedPaths.push(...affectedPaths);
    existing.createdPaths.push(...createdPaths);
  }

  const out = Array.from(groups.values());
  for (const g of out) {
    g.affectedPaths = Array.from(new Set(g.affectedPaths)).sort();
    g.createdPaths = Array.from(new Set(g.createdPaths)).sort();
  }
  return out;
};

const splitDiffByFile = (diffText: string): Map<string, string> => {
  const out = new Map<string, string>();
  if (!diffText) return out;
  const lines = diffText.split('\n');
  let currentPath: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (!currentPath) return;
    out.set(currentPath, buf.join('\n'));
  };

  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+)\s+b\/(.+)$/);
    if (m) {
      flush();
      currentPath = m[2] || m[1] || null;
      buf = [line];
      continue;
    }
    if (currentPath) buf.push(line);
  }
  flush();
  return out;
};

const DiffViewer: React.FC<{ text: string; wrap: boolean }> = ({ text, wrap }) => {
  const MAX_RICH_CHARS = 400_000;
  const MAX_RICH_LINES = 4000;
  const useRich = useMemo(() => {
    if (!text) return false;
    if (text.length > MAX_RICH_CHARS) return false;
    const lines = text.split('\n');
    if (lines.length > MAX_RICH_LINES) return false;
    return true;
  }, [text]);

  const lines = useMemo(() => (useRich ? text.split('\n') : []), [text, useRich]);
  const cls = `max-h-[520px] overflow-auto rounded border bg-white p-2 text-xs font-mono text-gray-800 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-100 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`;

  if (!useRich) {
    return (
      <pre className={cls}>
        {text || '（无 diff 输出）'}
      </pre>
    );
  }

  const lineClass = (line: string): string => {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index') || line.startsWith('rename from') || line.startsWith('rename to')) {
      return 'text-gray-500 dark:text-gray-400';
    }
    if (line.startsWith('@@')) return 'text-blue-700 dark:text-blue-300';
    if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-600 dark:text-gray-300';
    if (line.startsWith('+')) return 'text-green-700 dark:text-green-300';
    if (line.startsWith('-')) return 'text-red-700 dark:text-red-300';
    return 'text-gray-800 dark:text-gray-100';
  };

  return (
    <pre className={cls}>
      {lines.map((line, idx) => (
        <span key={idx} className={lineClass(line)}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
};

const ApplyPatchToolRunBlock: React.FC<{
  name: string;
  args: string;
  resultText?: string;
  callId?: string;
  toolMeta?: unknown;
  isStreaming?: boolean;
  onAbortTool?: (callId: string) => void;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}> = ({
  name,
  args,
  resultText,
  callId,
  toolMeta,
  isStreaming,
  onAbortTool,
  ansiRenderMode,
  ansiColorMode,
  defaultExpanded,
  autoCollapseEnabled,
  autoCollapseSeq,
}) => {
  const toolStatus = useMemo(() => detectToolRunStatus(resultText), [resultText]);
  const tone = useMemo(() => {
    switch (toolStatus.kind) {
      case 'error':
        return {
          container: 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20',
          headerText: 'text-red-700 dark:text-red-300',
          hoverBg: 'hover:bg-red-100 dark:hover:bg-red-900/30',
          summaryText: 'text-red-700/70 dark:text-red-200/70',
          pulse: 'bg-red-500',
          badge: 'border border-red-200 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200',
          detailBorder: 'border-red-200 dark:border-red-800',
          detailLabel: 'text-red-700/80 dark:text-red-200/80',
        };
      case 'denied':
        return {
          container: 'border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-900/20',
          headerText: 'text-orange-800 dark:text-orange-300',
          hoverBg: 'hover:bg-orange-100 dark:hover:bg-orange-900/30',
          summaryText: 'text-orange-700/70 dark:text-orange-200/70',
          pulse: 'bg-orange-500',
          badge: 'border border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
          detailBorder: 'border-orange-200 dark:border-orange-800',
          detailLabel: 'text-orange-700/80 dark:text-orange-200/80',
        };
      case 'aborted':
        return {
          container: 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20',
          headerText: 'text-yellow-800 dark:text-yellow-300',
          hoverBg: 'hover:bg-yellow-100 dark:hover:bg-yellow-900/30',
          summaryText: 'text-yellow-700/70 dark:text-yellow-200/70',
          pulse: 'bg-yellow-500',
          badge: 'border border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
          detailBorder: 'border-yellow-200 dark:border-yellow-800',
          detailLabel: 'text-yellow-700/80 dark:text-yellow-200/80',
        };
      case 'running':
      case 'success':
      default:
        return {
          container: 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/30',
          headerText: 'text-green-700 dark:text-green-300',
          hoverBg: 'hover:bg-green-100 dark:hover:bg-green-900/50',
          summaryText: 'text-green-700/70 dark:text-green-200/70',
          pulse: 'bg-green-500',
          badge: 'border border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200',
          detailBorder: 'border-green-200 dark:border-green-800',
          detailLabel: 'text-green-700/80 dark:text-green-200/80',
        };
    }
  }, [toolStatus.kind]);

  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));
  const canAbort = Boolean(onAbortTool && callId && isStreaming);

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  const parsedArgs = useMemo(() => {
    if (!isExpanded) return null;
    if (!args) return null;
    if (args.length > 200_000) return null;
    try {
      return JSON.parse(args) as unknown;
    } catch {
      return null;
    }
  }, [args, isExpanded]);

  const prettyArgs = useMemo(() => {
    if (!isExpanded) return '';
    if (!args) return '';
    if (!parsedArgs) return args;
    try {
      return JSON.stringify(parsedArgs, null, 2);
    } catch {
      return args;
    }
  }, [args, isExpanded, parsedArgs]);

  const summary = useMemo(() => extractToolSummary(name, args, parsedArgs), [name, args, parsedArgs]);

	const meta = toolMeta as ApplyPatchToolMeta | null;
	const git = meta?.applyPatch?.git;
	const repoRoot = typeof git?.repoRoot === 'string' ? git.repoRoot : '';
	const workTree = typeof git?.workTree === 'string' ? git.workTree : '';
	const ghostBefore = typeof git?.ghostBefore === 'string' ? git.ghostBefore : '';
	const ghostAfter = typeof git?.ghostAfter === 'string' ? git.ghostAfter : '';
	const affectedPaths = Array.isArray(git?.affectedPaths) ? git!.affectedPaths!.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
	const createdPaths = Array.isArray(git?.createdPaths) ? git!.createdPaths!.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
	const gitError = typeof git?.error === 'string' ? git.error : '';
	const snapshotErrBefore = typeof git?.snapshotErrorBefore === 'string' ? git.snapshotErrorBefore : '';
	const snapshotErrAfter = typeof git?.snapshotErrorAfter === 'string' ? git.snapshotErrorAfter : '';

	const effectiveWorkTree = workTree || repoRoot || meta?.applyPatch?.baseDir || '';
	const canUndo = Boolean(isTauri() && repoRoot && ghostBefore && affectedPaths.length > 0);
	const canGitDiff = Boolean(isTauri() && repoRoot && ghostBefore && affectedPaths.length > 0);
	const [activeView, setActiveView] = useState<'git' | 'tool'>('git');

	const [contextLines, setContextLines] = useState<0 | 3 | 10>(3);
	const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
	const [detectRenames, setDetectRenames] = useState(true);
  const [wrap, setWrap] = useState(true);

  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<GitDiffCommitsResponse | null>(null);
  const [activeFile, setActiveFile] = useState<string>('');
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoMsg, setUndoMsg] = useState<string>('');

	useEffect(() => {
	  if (!isExpanded) return;
	  if (activeView !== 'git') return;
	  if (!canGitDiff) return;

	  let cancelled = false;
	  setDiffLoading(true);
	  setDiffError(null);
	  setUndoMsg('');
	  const req = ghostAfter
	    ? invoke<GitDiffCommitsResponse>('git_diff_commits', {
	        args: {
	          repoRoot,
	          from: ghostBefore,
	          to: ghostAfter,
	          paths: affectedPaths,
	          options: {
	            contextLines,
	            ignoreWhitespace,
	            detectRenames,
	          },
	        },
	      })
	    : invoke<GitDiffCommitsResponse>('git_diff_ghost_worktree', {
	        args: {
	          repoRoot,
	          workTree: effectiveWorkTree || undefined,
	          ghostBefore,
	          paths: affectedPaths,
	          options: {
	            contextLines,
	            ignoreWhitespace,
	            detectRenames,
	          },
	        },
	      });
	  void req
	    .then((res) => {
	      if (cancelled) return;
	      setDiffData(res);
	      const firstPath = res?.files?.[0]?.path;
        setActiveFile((prev) => prev || (typeof firstPath === 'string' ? firstPath : ''));
      })
      .catch((e) => {
        if (cancelled) return;
        setDiffData(null);
        setDiffError(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setDiffLoading(false);
      });

	  return () => {
	    cancelled = true;
	  };
	}, [isExpanded, activeView, canGitDiff, repoRoot, effectiveWorkTree, ghostBefore, ghostAfter, affectedPaths.join('|'), contextLines, ignoreWhitespace, detectRenames, refreshSeq]);

  const diffByFile = useMemo(() => splitDiffByFile(diffData?.diff || ''), [diffData?.diff]);
  const currentDiff = useMemo(() => {
    if (!diffData?.diff) return '';
    if (activeFile && diffByFile.has(activeFile)) return diffByFile.get(activeFile) || '';
    return diffData.diff;
  }, [diffData, activeFile, diffByFile]);

	const doUndo = useCallback(async () => {
	  if (!isTauri()) return;
	  if (!repoRoot || !ghostBefore || affectedPaths.length === 0) return;
	  const ok = window.confirm('确认撤销本次 apply_patch 的修改吗？这会覆盖这些文件的当前工作区内容。');
	  if (!ok) return;
	  setUndoBusy(true);
	  setUndoMsg('');
	  try {
	    await invoke('undo_apply_patch', {
	      args: {
	        repoRoot,
	        workTree: effectiveWorkTree || undefined,
	        ghostBefore,
	        affectedPaths,
	        createdPaths,
	      },
	    });
      setUndoMsg('已撤销。');
      // Refresh diff
      setActiveFile('');
      setDiffData(null);
      setDiffError(null);
      setRefreshSeq((v) => v + 1);
    } catch (e) {
      setUndoMsg(`撤销失败：${String(e)}`);
	  } finally {
	    setUndoBusy(false);
	  }
	}, [repoRoot, effectiveWorkTree, ghostBefore, affectedPaths.join('|'), createdPaths.join('|')]);

  return (
    <div className={`mb-2 rounded-lg border ${tone.container}`}>
      <div className={`flex items-center gap-2 px-3 py-2 text-left text-sm ${tone.headerText}`}>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left ${tone.hoverBg}`}
        >
          <Wrench size={16} className="shrink-0" />
          <span className="font-medium">工具：{name || 'unknown'}</span>
          {summary ? (
            <span className={`ml-2 max-w-[60%] truncate font-mono text-xs ${tone.summaryText}`}>
              {summary}
            </span>
          ) : null}
          {isStreaming ? (
            <span className={`ml-1 inline-block h-2 w-2 animate-pulse rounded-full ${tone.pulse}`} />
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {toolStatus.badge ? (
              <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${tone.badge}`}>
                {toolStatus.badge}
              </span>
            ) : null}
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        {canAbort ? (
          <button
            type="button"
            onClick={() => callId && onAbortTool?.(callId)}
            className={`rounded border px-2 py-0.5 text-[10px] font-medium ${tone.badge} ${tone.hoverBg}`}
            title="强制关闭当前工具（将终止本轮）"
          >
            强制关闭
          </button>
        ) : null}
      </div>

      {isExpanded ? (
        <div className={`border-t px-3 py-2 ${tone.detailBorder}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded border border-gray-200 dark:border-gray-800">
              <button
                type="button"
                onClick={() => setActiveView('git')}
                className={`px-2 py-1 text-xs font-medium ${activeView === 'git' ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900/40 dark:text-gray-200 dark:hover:bg-gray-800'}`}
                title="默认视图：Git diff"
              >
                变更预览（Git）
              </button>
              <button
                type="button"
                onClick={() => setActiveView('tool')}
                className={`px-2 py-1 text-xs font-medium ${activeView === 'tool' ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900/40 dark:text-gray-200 dark:hover:bg-gray-800'}`}
              >
                工具详情
              </button>
            </div>

            {activeView === 'git' ? (
              <>
                <label className="ml-2 inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                  上下文
                  <select
                    value={contextLines}
                    onChange={(e) => setContextLines(Number(e.target.value) as 0 | 3 | 10)}
                    className="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs dark:border-gray-800 dark:bg-gray-900/40"
                  >
                    <option value={0}>0</option>
                    <option value={3}>3</option>
                    <option value={10}>10</option>
                  </select>
                </label>
                <label className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={ignoreWhitespace} onChange={(e) => setIgnoreWhitespace(e.target.checked)} />
                  忽略空白
                </label>
                <label className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={detectRenames} onChange={(e) => setDetectRenames(e.target.checked)} />
                  检测重命名
                </label>
                <label className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
                  自动换行
                </label>
	                <button
	                  type="button"
	                  onClick={doUndo}
	                  disabled={!canUndo || undoBusy}
	                  className={`ml-auto rounded border px-2 py-1 text-xs font-medium ${!canUndo || undoBusy ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-600' : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-100 dark:hover:bg-gray-800'}`}
	                  title="撤销本次 apply_patch（仅 affected）"
	                >
                  {undoBusy ? '撤销中…' : 'Undo'}
                </button>
              </>
            ) : null}
          </div>

          {activeView === 'git' ? (
            <>
              {toolStatus.kind === 'error' || toolStatus.kind === 'aborted' ? (
                <div className="mb-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-900 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-100">
                  <AlertTriangle size={14} className="mr-1 inline-block" />
                  本次执行未完全成功：可能存在部分写入，请以当前 diff 为准。
                </div>
              ) : null}

              {gitError ? (
                <div className="mb-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-900 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-100">
                  <AlertTriangle size={14} className="mr-1 inline-block" />
                  Git 不可用：{gitError}
                </div>
              ) : null}
              {snapshotErrBefore ? (
                <div className="mb-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-900 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-100">
                  <AlertTriangle size={14} className="mr-1 inline-block" />
                  快照失败（before）：{snapshotErrBefore}
                </div>
              ) : null}
              {snapshotErrAfter ? (
                <div className="mb-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-900 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-100">
                  <AlertTriangle size={14} className="mr-1 inline-block" />
                  快照失败（after）：{snapshotErrAfter}
                </div>
              ) : null}

              {undoMsg ? (
                <div className="mb-2 text-xs text-gray-700 dark:text-gray-200">{undoMsg}</div>
              ) : null}

              {diffLoading ? (
                <div className="text-xs text-gray-600 dark:text-gray-300">生成 Git diff 中…</div>
              ) : diffError ? (
                <div className="text-xs text-red-700 dark:text-red-300">生成 diff 失败：{diffError}</div>
              ) : diffData ? (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                    <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                      本次修改：{diffData.summary.filesChanged} 个文件，+{diffData.summary.insertions} −{diffData.summary.deletions}
                    </span>
                    {repoRoot ? <span className="truncate font-mono text-[10px] text-gray-500 dark:text-gray-400">repoRoot={repoRoot}</span> : null}
                  </div>

                  {diffData.files?.length ? (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {diffData.files.map((f) => {
                        const label = f.status.startsWith('R') && f.oldPath
                          ? `${f.status} ${f.oldPath} → ${f.path}`
                          : `${f.status} ${f.path}`;
                        const stats =
                          typeof f.added === 'number' || typeof f.deleted === 'number'
                            ? ` +${f.added ?? 0} -${f.deleted ?? 0}`
                            : '';
                        const isActive = activeFile === f.path;
                        return (
                          <button
                            key={`${f.status}:${f.path}`}
                            type="button"
                            onClick={() => setActiveFile(f.path)}
                            className={`rounded border px-2 py-0.5 text-[10px] font-mono ${isActive ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200 dark:hover:bg-gray-800'}`}
                            title={label}
                          >
                            {f.path}
                            <span className="ml-1 text-[10px] opacity-70">{stats}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {currentDiff ? (
                    <DiffViewer text={currentDiff} wrap={wrap} />
                  ) : (
                    <div className="text-xs text-gray-600 dark:text-gray-300">无差异（已与快照一致）</div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-gray-600 dark:text-gray-300">详情</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-gray-200 bg-white p-2 text-[11px] text-gray-800 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                      {JSON.stringify(toolMeta ?? null, null, 2)}
                    </pre>
                  </details>
                </>
              ) : (
                <div className="text-xs text-gray-600 dark:text-gray-300">
                  {canGitDiff ? '等待 diff 数据…' : '缺少 ghost commit 信息，无法生成 Git diff。请切换到“工具详情”。'}
                </div>
              )}
            </>
          ) : (
            <>
              {prettyArgs ? (
                <>
                  <div className={`mb-1 text-xs font-medium ${tone.detailLabel}`}>参数</div>
                  <pre className="mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-gray-800 dark:text-gray-100">
                    {prettyArgs}
                  </pre>
                </>
              ) : null}

              {resultText ? (
                <>
                  <div className={`mb-1 text-xs font-medium ${tone.detailLabel}`}>输出</div>
                  <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-gray-800 dark:text-gray-100">
                    <AnsiText text={resultText} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
                  </pre>
                </>
              ) : (
                <div className="text-xs text-green-700/70 dark:text-green-200/70">等待工具输出…</div>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};

const TaskPatchSummaryCard: React.FC<{
  group: TaskPatchSummaryGroup;
}> = ({ group }) => {
  const canUseTauri = isTauri();
  const canLoad = Boolean(canUseTauri && group.repoRoot && group.ghostBefore && group.affectedPaths.length > 0);
  const canUndo = canLoad;

  const [isExpanded, setIsExpanded] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<GitDiffCommitsResponse | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const [undoBusy, setUndoBusy] = useState(false);
  const [undoMsg, setUndoMsg] = useState<string>('');

  useEffect(() => {
    if (!isExpanded) return;
    if (!canLoad) return;

    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setUndoMsg('');
    const req = group.ghostAfter
      ? invoke<GitDiffCommitsResponse>('git_diff_commits', {
          args: {
            repoRoot: group.repoRoot,
            from: group.ghostBefore,
            to: group.ghostAfter,
            paths: group.affectedPaths,
            options: { detectRenames: true },
          },
        })
      : invoke<GitDiffCommitsResponse>('git_diff_ghost_worktree', {
          args: {
            repoRoot: group.repoRoot,
            workTree: group.workTree || undefined,
            ghostBefore: group.ghostBefore,
            paths: group.affectedPaths,
            options: { detectRenames: true },
          },
        });

    void req
      .then((res) => {
        if (cancelled) return;
        setDiffData(res);
      })
      .catch((e) => {
        if (cancelled) return;
        setDiffData(null);
        setDiffError(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isExpanded, canLoad, group.key, refreshSeq]);

  const doUndo = useCallback(async () => {
    if (!canUseTauri) return;
    if (!group.repoRoot || !group.ghostBefore || group.affectedPaths.length === 0) return;
    const ok = window.confirm('确认撤销本次任务内所有 apply_patch 修改吗？这会覆盖 affected 文件的当前工作区内容。');
    if (!ok) return;
    setUndoBusy(true);
    setUndoMsg('');
    try {
      await invoke('undo_apply_patch', {
        args: {
          repoRoot: group.repoRoot,
          workTree: group.workTree || undefined,
          ghostBefore: group.ghostBefore,
          affectedPaths: group.affectedPaths,
          createdPaths: group.createdPaths,
        },
      });
      setUndoMsg('已撤销。');
      setDiffData(null);
      setDiffError(null);
      setRefreshSeq((v) => v + 1);
    } catch (e) {
      setUndoMsg(`撤销失败：${String(e)}`);
    } finally {
      setUndoBusy(false);
    }
  }, [canUseTauri, group.key]);

  const title = diffData
    ? `本次任务修改：${diffData.summary.filesChanged} 个文件，+${diffData.summary.insertions} −${diffData.summary.deletions}`
    : '本次任务修改汇总';

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/40">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={isExpanded ? '收起' : '展开'}
        >
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
          <span className="ml-auto text-gray-400">{isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        </button>

        <button
          type="button"
          onClick={doUndo}
          disabled={!canUndo || undoBusy}
          className={`rounded px-3 py-1 text-sm font-medium ${!canUndo || undoBusy ? 'cursor-not-allowed bg-gray-100 text-gray-400 dark:bg-gray-800/60 dark:text-gray-600' : 'bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200'}`}
          title="Undo（仅 affected）"
        >
          {undoBusy ? '撤销中…' : 'Undo'}
        </button>
      </div>

      {isExpanded ? (
        <div className="border-t border-gray-200 dark:border-gray-800">
          {undoMsg ? (
            <div className="px-4 pt-3 text-xs text-gray-700 dark:text-gray-200">{undoMsg}</div>
          ) : null}

          {!canLoad ? (
            <div className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">
              当前环境不可用：缺少 git 快照信息或不是 Tauri 环境。
            </div>
          ) : diffLoading ? (
            <div className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">生成修改汇总中…</div>
          ) : diffError ? (
            <div className="px-4 py-3 text-xs text-red-700 dark:text-red-300">生成修改汇总失败：{diffError}</div>
          ) : diffData?.files?.length ? (
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {diffData.files.map((f) => {
                const plus = typeof f.added === 'number' ? f.added : 0;
                const minus = typeof f.deleted === 'number' ? f.deleted : 0;
                const label = f.status.startsWith('R') && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
                return (
                  <div key={`${f.status}:${f.path}`} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 truncate font-mono text-sm font-semibold text-gray-900 dark:text-gray-100" title={label}>
                      {label}
                    </div>
                    <div className="shrink-0 font-mono text-sm">
                      <span className="text-green-700 dark:text-green-300">+{plus}</span>{' '}
                      <span className="text-red-700 dark:text-red-300">-{minus}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">无差异（已与快照一致）</div>
          )}
        </div>
      ) : null}
    </div>
  );
};

const TaskPatchSummary: React.FC<{ blocks: MessageBlock[]; isStreaming?: boolean }> = ({ blocks, isStreaming }) => {
  const groups = useMemo(() => buildTaskPatchSummaryGroups(blocks), [blocks]);
  const show = !Boolean(isStreaming) && groups.length > 0;
  if (!show) return null;
  return (
    <div className="mb-2">
      {groups.map((g) => (
        <TaskPatchSummaryCard key={g.key} group={g} />
      ))}
    </div>
  );
};

interface ThinkingBlockProps {
  text: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}

const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ text, isStreaming, defaultExpanded, autoCollapseEnabled, autoCollapseSeq }) => {
  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  if (!text) return null;

  return (
    <div className="mb-2 rounded-lg border border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-purple-700 hover:bg-purple-100 dark:text-purple-300 dark:hover:bg-purple-900/50"
      >
        <Brain size={16} className="shrink-0" />
        <span className="font-medium">{isStreaming ? '思考中...' : '思考过程'}</span>
        {isStreaming && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-purple-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-purple-200 px-3 py-2 text-sm text-purple-800 dark:border-purple-800 dark:text-purple-200">
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap">{text}</div>
        </div>
      )}
    </div>
  );
};

const StatusBlock: React.FC<{ text: string; isStreaming?: boolean }> = ({ text, isStreaming }) => {
  if (!text) return null;

  return (
    <div className="mb-2 flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
      <RefreshCw size={14} className={`mt-0.5 shrink-0 ${isStreaming ? 'animate-spin' : ''}`} />
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
};

const UnknownBlock: React.FC<{ data: unknown }> = ({ data }) => {
  const text = useMemo(() => {
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  return (
    <div className="mb-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-200">
      <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">Unknown block</div>
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
};

const ToolCallBlock: React.FC<{
  name: string;
  args: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}> = ({
  name,
  args,
  isStreaming,
  defaultExpanded,
  autoCollapseEnabled,
  autoCollapseSeq,
}) => {
  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  // 收起状态下不做 JSON 解析/格式化，避免长对话里大量 tool block 造成卡顿
  const parsedArgs = useMemo(() => {
    if (!isExpanded) return null;
    if (!args) return null;
    // 过大的 JSON 解析/pretty print 会明显卡顿；展开时也优先直接展示原文
    if (args.length > 200_000) return null;
    try {
      return JSON.parse(args) as unknown;
    } catch {
      return null;
    }
  }, [args, isExpanded]);

  const prettyArgs = useMemo(() => {
    if (!isExpanded) return '';
    if (!args) return '';
    if (!parsedArgs) return args;
    try {
      return JSON.stringify(parsedArgs, null, 2);
    } catch {
      return args;
    }
  }, [args, isExpanded, parsedArgs]);

  const summary = useMemo(() => extractToolSummary(name, args, parsedArgs), [name, args, parsedArgs]);

  return (
    <div className="mb-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-green-700 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/50"
      >
        <Wrench size={16} className="shrink-0" />
        <span className="font-medium">工具调用：{name || 'unknown'}</span>
        {summary ? (
          <span className="ml-2 max-w-[50%] truncate font-mono text-xs text-green-700/70 dark:text-green-200/70">
            {summary}
          </span>
        ) : null}
        {isStreaming && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-green-200 px-3 py-2 text-sm text-green-900 dark:border-green-800 dark:text-green-100">
          <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2">{prettyArgs}</pre>
        </div>
      )}
    </div>
  );
};

const ApprovalBlock: React.FC<{
  conversationId?: string;
  block: Extract<MessageBlock, { type: 'approval' }>;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}> = ({ conversationId, block, isStreaming, defaultExpanded, autoCollapseEnabled, autoCollapseSeq }) => {
  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming || block.status === 'pending');
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { config, saveConfig } = useConfigStore();
  const sessionWorkstudioId = useSessionStore((state) => {
    if (!conversationId) return null;
    for (const s of state.sessions.values()) {
      if (s.conversationId === conversationId) return s.workstudioId ?? null;
    }
    return null;
  });
  const hasWorkspace = Boolean(sessionWorkstudioId && sessionWorkstudioId.trim());
  const trustScopeTouchedRef = useRef(false);

  // “信任并允许”的默认范围：优先“项目内允许”（绑定 Workstudio）；没有工作区时才默认“安全组允许”。
  const [trustInProject, setTrustInProject] = useState(() => hasWorkspace);
  const [trustInSecurityGroup, setTrustInSecurityGroup] = useState(() => !hasWorkspace);

  useEffect(() => {
    if (trustScopeTouchedRef.current) return;
    setTrustInProject(hasWorkspace);
    setTrustInSecurityGroup(!hasWorkspace);
  }, [hasWorkspace]);

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  // 收起状态下不做 JSON 解析/格式化（审批块里可能包含超大 apply_patch / 命令参数）
  const parsedArgs = useMemo(() => {
    if (!isExpanded) return null;
    const raw = block.arguments;
    if (!raw) return null;
    if (raw.length > 200_000) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }, [block.arguments, isExpanded]);

  const prettyArgs = useMemo(() => {
    if (!isExpanded) return '';
    const raw = block.arguments;
    if (!raw) return '';
    if (!parsedArgs) return raw;
    try {
      return JSON.stringify(parsedArgs, null, 2);
    } catch {
      return raw;
    }
  }, [block.arguments, isExpanded, parsedArgs]);

  const summary = useMemo(
    () => extractToolSummary(block.toolName, block.arguments, parsedArgs),
    [block.toolName, block.arguments, parsedArgs]
  );

  const trustCandidate = useMemo(() => {
    if (!isExpanded) return null;
    if (block.status !== 'pending') return null;
    if (!parsedArgs || typeof parsedArgs !== 'object') return null;

    const tool = block.toolName;
    const raw =
      tool === 'web_search'
        ? '*'
        : tool === 'shell_command' && typeof (parsedArgs as any).command === 'string'
          ? (parsedArgs as any).command
          : (tool === 'exec_command' || tool === 'exec_command_persistent') &&
              typeof (parsedArgs as any).cmd === 'string'
            ? (parsedArgs as any).cmd
            : null;

    const command = typeof raw === 'string' ? raw.trim() : '';
    if (!command) return null;
    return { tool, command };
  }, [block.status, block.toolName, isExpanded, parsedArgs]);

  const statusText = useMemo(() => {
    switch (block.status) {
      case 'pending':
        return '等待确认';
      case 'approved':
        return '已允许';
      case 'approved_for_session':
        return '本会话已允许';
      case 'denied':
        return '已拒绝';
      case 'abort':
        return '已终止';
      default:
        return block.status || '未知';
    }
  }, [block.status]);

  const canInvoke = Boolean(conversationId && isTauri());
  const canClick = canInvoke && block.status === 'pending' && !isSubmitting;
  const trustInProjectEffective = trustInProject && hasWorkspace;
  const trustScopeSelected = trustInProjectEffective || trustInSecurityGroup;
  const canTrust =
    canClick &&
    Boolean(trustCandidate) &&
    trustScopeSelected &&
    (!trustInSecurityGroup || Boolean(config));

  const trustAndApprove = async () => {
    if (!canTrust) return;
    if (!conversationId) return;
    if (!trustCandidate) return;

    setIsSubmitting(true);
    try {
      const nextEntry = { tool: trustCandidate.tool, command: trustCandidate.command };

      if (trustInProjectEffective) {
        const wsId = (sessionWorkstudioId ?? '').trim();
        if (!wsId) throw new Error('当前会话未绑定 Workstudio，无法写入“项目内允许”');

        const ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId: wsId });
        if (!ws?.id) throw new Error('Workstudio 不存在，无法写入“项目内允许”');
        if (!ws.mainFolder?.trim()) throw new Error('Workstudio 主目录为空，无法写入“项目内允许”');

        const wsSec = await invoke<WorkstudioSecurityConfig>('get_workstudio_security_config', { workstudioId: wsId });
        const existing = wsSec?.trustedCommands ?? [];
        const already = existing.some((t) => t.tool === nextEntry.tool && t.command === nextEntry.command);
        if (!already) {
          const payload: WorkstudioSecurityConfig = {
            writableRoots: wsSec?.writableRoots ?? [],
            trustedCommands: [...existing, nextEntry],
          };
          await invoke('set_workstudio_security_config', { workstudioId: wsId, config: payload });
        }
      }

      if (trustInSecurityGroup) {
        if (!config) throw new Error('应用配置尚未加载，无法写入“安全组允许”');

        const policyFromBlock = block.securityPolicy;
        const fallbackName = config.security.defaultPolicy || config.security.policies[0]?.name;
        const policyName = policyFromBlock || fallbackName;

        const idx = config.security.policies.findIndex((p) => p.name === policyName);
        const fallbackIdx = config.security.policies.findIndex((p) => p.name === config.security.defaultPolicy);
        const targetIndex = idx !== -1 ? idx : fallbackIdx !== -1 ? fallbackIdx : 0;

        const targetPolicy = config.security.policies[targetIndex];
        const existing = targetPolicy.trustedCommands ?? [];
        const already = existing.some((t) => t.tool === nextEntry.tool && t.command === nextEntry.command);

        if (!already) {
          const nextPolicies = config.security.policies.map((p, i) =>
            i === targetIndex ? { ...p, trustedCommands: [...existing, nextEntry] } : p
          );
          await saveConfig({
            ...config,
            security: { ...config.security, policies: nextPolicies },
          });
        }
      }

      await invoke('respond_approval', {
        conversationId,
        requestId: block.requestId,
        decision: 'approved',
      });
    } catch (e) {
      console.error('trustAndApprove failed:', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const send = async (decision: 'approved' | 'approved_for_session' | 'denied' | 'abort') => {
    if (!canClick) return;
    if (!conversationId) return;
    setIsSubmitting(true);
    try {
      await invoke('respond_approval', {
        conversationId,
        requestId: block.requestId,
        decision,
      });
    } catch (e) {
      console.error('respond_approval failed:', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mb-2 rounded-lg border border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-900/20">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-orange-800 hover:bg-orange-100 dark:text-orange-200 dark:hover:bg-orange-900/40"
      >
        <AlertTriangle size={16} className="shrink-0" />
        <span className="font-medium">需要审批：{block.toolName || 'unknown'}</span>
        {summary ? (
          <span className="ml-2 max-w-[45%] truncate font-mono text-xs text-orange-700/70 dark:text-orange-200/70">
            {summary}
          </span>
        ) : null}
        {block.escalated ? (
          <span className="ml-2 rounded bg-orange-200 px-1.5 py-0.5 text-[10px] font-medium text-orange-900 dark:bg-orange-800 dark:text-orange-100">
            提权重试
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="rounded bg-orange-200 px-1.5 py-0.5 text-[10px] font-medium text-orange-900 dark:bg-orange-800 dark:text-orange-100">
            {statusText}
          </span>
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {isExpanded ? (
        <div className="border-t border-orange-200 px-3 py-2 dark:border-orange-800">
          {block.reason ? (
            <div className="mb-2 text-xs text-orange-800/80 dark:text-orange-200/80">
              <span className="font-medium">原因：</span>
              <span className="whitespace-pre-wrap">{block.reason}</span>
            </div>
          ) : null}

          {prettyArgs ? (
            <>
              <div className="mb-1 text-xs font-medium text-orange-800/80 dark:text-orange-200/80">参数</div>
              <pre className="mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-orange-950 dark:text-orange-50">
                {prettyArgs}
              </pre>
            </>
          ) : null}

          {block.status === 'pending' ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canClick}
                onClick={() => send('approved')}
                className={`rounded border px-2 py-1 text-xs font-medium ${canClick
                  ? 'border-orange-300 bg-white text-orange-900 hover:bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-100 dark:hover:bg-orange-900/30'
                  : 'cursor-not-allowed border-orange-200 bg-orange-50 text-orange-400 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-600'
                  }`}
              >
                允许一次
              </button>
              {trustCandidate ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 rounded border border-orange-200 bg-white px-2 py-1 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-950/20 dark:text-orange-100">
                    {hasWorkspace ? (
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          className="h-3 w-3"
                          checked={trustInProject}
                          disabled={!canClick}
                          onChange={(e) => {
                            trustScopeTouchedRef.current = true;
                            setTrustInProject(e.target.checked);
                          }}
                        />
                        <span className={!canClick ? 'opacity-50' : undefined}>项目内允许</span>
                      </label>
                    ) : null}
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={trustInSecurityGroup}
                        disabled={!canClick || !config}
                        onChange={(e) => {
                          trustScopeTouchedRef.current = true;
                          setTrustInSecurityGroup(e.target.checked);
                        }}
                        title={!config ? '应用配置尚未加载，暂不可用' : undefined}
                      />
                      <span className={!canClick || !config ? 'opacity-50' : undefined}>安全组允许</span>
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={!canTrust}
                    onClick={trustAndApprove}
                    className={`rounded border px-2 py-1 text-xs font-medium ${canTrust
                      ? 'border-orange-300 bg-white text-orange-900 hover:bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-100 dark:hover:bg-orange-900/30'
                      : 'cursor-not-allowed border-orange-200 bg-orange-50 text-orange-400 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-600'
                      }`}
                    title="加入信任列表并执行（可选：项目内/安全组；默认项目内；无工作区时默认安全组且不显示“项目内”）"
                  >
                    信任并允许
                  </button>
                </>
              ) : null}
              <button
                type="button"
                disabled={!canClick}
                onClick={() => send('approved_for_session')}
                className={`rounded border px-2 py-1 text-xs font-medium ${canClick
                  ? 'border-orange-300 bg-white text-orange-900 hover:bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-100 dark:hover:bg-orange-900/30'
                  : 'cursor-not-allowed border-orange-200 bg-orange-50 text-orange-400 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-600'
                  }`}
              >
                本会话允许
              </button>
              <button
                type="button"
                disabled={!canClick}
                onClick={() => send('denied')}
                className={`rounded border px-2 py-1 text-xs font-medium ${canClick
                  ? 'border-orange-300 bg-white text-orange-900 hover:bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-100 dark:hover:bg-orange-900/30'
                  : 'cursor-not-allowed border-orange-200 bg-orange-50 text-orange-400 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-600'
                  }`}
              >
                拒绝
              </button>
              <button
                type="button"
                disabled={!canClick}
                onClick={() => send('abort')}
                className={`rounded border px-2 py-1 text-xs font-medium ${canClick
                  ? 'border-orange-300 bg-white text-orange-900 hover:bg-orange-50 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-100 dark:hover:bg-orange-900/30'
                  : 'cursor-not-allowed border-orange-200 bg-orange-50 text-orange-400 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-600'
                  }`}
                  title="终止当前任务（Stop）"
              >
                终止任务
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const ToolRunBlock: React.FC<{
  name: string;
  args: string;
  resultText?: string;
  callId?: string;
  isStreaming?: boolean;
  onAbortTool?: (callId: string) => void;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}> = ({
  name,
  args,
  resultText,
  callId,
  isStreaming,
  onAbortTool,
  ansiRenderMode,
  ansiColorMode,
  defaultExpanded,
  autoCollapseEnabled,
  autoCollapseSeq,
}) => {
  const toolStatus = useMemo(() => detectToolRunStatus(resultText), [resultText]);
  const tone = useMemo(() => {
    switch (toolStatus.kind) {
      case 'error':
        return {
          container: 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20',
          headerText: 'text-red-700 dark:text-red-300',
          hoverBg: 'hover:bg-red-100 dark:hover:bg-red-900/30',
          summaryText: 'text-red-700/70 dark:text-red-200/70',
          pulse: 'bg-red-500',
          badge: 'border border-red-200 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200',
          detailBorder: 'border-red-200 dark:border-red-800',
          detailLabel: 'text-red-700/80 dark:text-red-200/80',
        };
      case 'denied':
        return {
          container: 'border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-900/20',
          headerText: 'text-orange-800 dark:text-orange-300',
          hoverBg: 'hover:bg-orange-100 dark:hover:bg-orange-900/30',
          summaryText: 'text-orange-700/70 dark:text-orange-200/70',
          pulse: 'bg-orange-500',
          badge: 'border border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
          detailBorder: 'border-orange-200 dark:border-orange-800',
          detailLabel: 'text-orange-700/80 dark:text-orange-200/80',
        };
      case 'aborted':
        return {
          container: 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20',
          headerText: 'text-yellow-800 dark:text-yellow-300',
          hoverBg: 'hover:bg-yellow-100 dark:hover:bg-yellow-900/30',
          summaryText: 'text-yellow-700/70 dark:text-yellow-200/70',
          pulse: 'bg-yellow-500',
          badge: 'border border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
          detailBorder: 'border-yellow-200 dark:border-yellow-800',
          detailLabel: 'text-yellow-700/80 dark:text-yellow-200/80',
        };
      case 'running':
      case 'success':
      default:
        return {
          container: 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/30',
          headerText: 'text-green-700 dark:text-green-300',
          hoverBg: 'hover:bg-green-100 dark:hover:bg-green-900/50',
          summaryText: 'text-green-700/70 dark:text-green-200/70',
          pulse: 'bg-green-500',
          badge: 'border border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200',
          detailBorder: 'border-green-200 dark:border-green-800',
          detailLabel: 'text-green-700/80 dark:text-green-200/80',
        };
    }
  }, [toolStatus.kind]);

  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));
  const canAbort = Boolean(onAbortTool && callId && isStreaming);

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  // 收起状态下不做 JSON 解析/格式化（尤其是 apply_patch / 大文件内容会卡）
  const parsedArgs = useMemo(() => {
    if (!isExpanded) return null;
    if (!args) return null;
    if (args.length > 200_000) return null;
    try {
      return JSON.parse(args) as unknown;
    } catch {
      return null;
    }
  }, [args, isExpanded]);

  const prettyArgs = useMemo(() => {
    if (!isExpanded) return '';
    if (!args) return '';
    if (!parsedArgs) return args;
    try {
      return JSON.stringify(parsedArgs, null, 2);
    } catch {
      return args;
    }
  }, [args, isExpanded, parsedArgs]);

  const summary = useMemo(() => extractToolSummary(name, args, parsedArgs), [name, args, parsedArgs]);

  return (
    <div className={`mb-2 rounded-lg border ${tone.container}`}>
      <div className={`flex items-center gap-2 px-3 py-2 text-left text-sm ${tone.headerText}`}>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left ${tone.hoverBg}`}
        >
          <Wrench size={16} className="shrink-0" />
          <span className="font-medium">工具：{name || 'unknown'}</span>
          {summary ? (
            <span className={`ml-2 max-w-[60%] truncate font-mono text-xs ${tone.summaryText}`}>
              {summary}
            </span>
          ) : null}
          {isStreaming ? (
            <span className={`ml-1 inline-block h-2 w-2 animate-pulse rounded-full ${tone.pulse}`} />
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {toolStatus.badge ? (
              <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${tone.badge}`}>
                {toolStatus.badge}
              </span>
            ) : null}
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        {canAbort ? (
          <button
            type="button"
            onClick={() => callId && onAbortTool?.(callId)}
            className={`rounded border px-2 py-0.5 text-[10px] font-medium ${tone.badge} ${tone.hoverBg}`}
            title="强制关闭当前工具（将终止本轮）"
          >
            强制关闭
          </button>
        ) : null}
      </div>

      {isExpanded ? (
        <div className={`border-t px-3 py-2 ${tone.detailBorder}`}>
          {prettyArgs ? (
            <>
              <div className={`mb-1 text-xs font-medium ${tone.detailLabel}`}>参数</div>
              <pre className="mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-gray-800 dark:text-gray-100">
                {prettyArgs}
              </pre>
            </>
          ) : null}

          {resultText ? (
            <>
              <div className={`mb-1 text-xs font-medium ${tone.detailLabel}`}>输出</div>
              <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-sm text-gray-800 dark:text-gray-100">
                <AnsiText text={resultText} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
              </pre>
            </>
          ) : (
            <div className="text-xs text-green-700/70 dark:text-green-200/70">等待工具输出…</div>
          )}
        </div>
      ) : null}
    </div>
  );
};

const ToolResultBlock: React.FC<{
  text: string;
  callId?: string;
  isStreaming?: boolean;
  onAbortTool?: (callId: string) => void;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}> = ({ text, callId, isStreaming, onAbortTool, ansiRenderMode, ansiColorMode, defaultExpanded, autoCollapseEnabled, autoCollapseSeq }) => {
  if (!text) return null;
  const toolStatus = useMemo(() => detectToolRunStatus(text), [text]);
  const tone = useMemo(() => {
    switch (toolStatus.kind) {
      case 'error':
        return {
          container: 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20',
          headerText: 'text-red-700 dark:text-red-300',
          hoverBg: 'hover:bg-red-100 dark:hover:bg-red-900/30',
          badge: 'border border-red-200 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200',
        };
      case 'denied':
        return {
          container: 'border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-900/20',
          headerText: 'text-orange-800 dark:text-orange-300',
          hoverBg: 'hover:bg-orange-100 dark:hover:bg-orange-900/30',
          badge: 'border border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
        };
      case 'aborted':
        return {
          container: 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20',
          headerText: 'text-yellow-800 dark:text-yellow-300',
          hoverBg: 'hover:bg-yellow-100 dark:hover:bg-yellow-900/30',
          badge: 'border border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
        };
      case 'running':
      case 'success':
      default:
        return {
          container: 'border-green-200 bg-white dark:border-green-800 dark:bg-gray-900/40',
          headerText: 'text-green-700 dark:text-green-300',
          hoverBg: 'hover:bg-green-50 dark:hover:bg-green-900/20',
          badge: 'border border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200',
        };
    }
  }, [toolStatus.kind]);
  const canAbort = Boolean(onAbortTool && callId && isStreaming);
  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  return (
    <div className={`mb-2 rounded-lg border px-3 py-2 text-sm text-gray-800 dark:text-gray-100 ${tone.container}`}>
      <div className={`mb-1 flex items-center gap-2 text-xs font-medium ${tone.headerText}`}>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left ${tone.hoverBg}`}
        >
          <Wrench size={14} />
          <span>工具结果</span>
          <span className="ml-auto flex items-center gap-2">
            {toolStatus.badge ? (
              <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${tone.badge}`}>
                {toolStatus.badge}
              </span>
            ) : null}
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        {canAbort ? (
          <button
            type="button"
            onClick={() => callId && onAbortTool?.(callId)}
            className={`rounded border px-2 py-0.5 text-[10px] font-medium ${tone.badge} ${tone.hoverBg}`}
            title="强制关闭当前工具（将终止本轮）"
          >
            强制关闭
          </button>
        ) : null}
      </div>
      {isExpanded ? (
        <pre className="h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2">
          <AnsiText text={text} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
        </pre>
      ) : null}
    </div>
  );
};

const ErrorBlock: React.FC<{
  text: string;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
}> = ({ text, ansiRenderMode, ansiColorMode }) => {
  if (!text) return null;

  return (
    <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-100">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
        <AlertTriangle size={14} />
        <span>错误</span>
      </div>
      <pre className="whitespace-pre-wrap break-words">
        <AnsiText text={text} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
      </pre>
    </div>
  );
};

const WebSearchBlock: React.FC<{
  status: string;
  action?: unknown;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  autoCollapseEnabled?: boolean;
  autoCollapseSeq?: number;
}> = ({
  status,
  action,
  isStreaming,
  defaultExpanded,
  autoCollapseEnabled,
  autoCollapseSeq,
}) => {
  const resolvedDefaultExpanded = defaultExpanded ?? Boolean(isStreaming);
  const [isExpanded, setIsExpanded] = useState(Boolean(resolvedDefaultExpanded));

  useEffect(() => {
    if (!autoCollapseEnabled) return;
    setIsExpanded(Boolean(resolvedDefaultExpanded));
  }, [autoCollapseSeq]);

  const info = useMemo(() => {
    if (!isExpanded) return null;
    if (!action) return null;

    const safeParse = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return value;
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return value;
        }
      }
      return value;
    };

    const normalizeValue = (value: string, maxLength = 240) => {
      const trimmed = value.trim();
      if (trimmed.length <= maxLength) return trimmed;
      return `${trimmed.slice(0, maxLength)}...`;
    };

    const stringifyAction = (value: unknown) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    };

    const parsedAction = typeof action === 'string' ? safeParse(action) : action;
    const rawText = stringifyAction(parsedAction ?? action);

    if (!parsedAction || typeof parsedAction !== 'object') {
      const text = parsedAction == null ? '' : String(parsedAction);
      const extras = text ? [{ label: 'action', value: normalizeValue(text) }] : [];
      return {
        rawType: undefined,
        normalizedType: undefined,
        query: undefined,
        queries: undefined,
        url: undefined,
        pattern: undefined,
        sources: undefined,
        extras,
        rawText,
        hasCoreDetails: false,
        hasDetails: extras.length > 0,
      };
    }

    const a = parsedAction as any;

    const rawType = typeof a.type === 'string' ? a.type : undefined;
    const normalizedType = rawType === 'find_in_page' ? 'find' : rawType;

    const openPage = a.open_page ?? a.openPage ?? a.page;
    const findInPage = a.find_in_page ?? a.findInPage ?? a.find;

    const pickString = (...values: Array<unknown>) =>
      values.find((v) => typeof v === 'string') as string | undefined;
    const pickStringArray = (...values: Array<unknown>) => {
      const arr = values.find((v) => Array.isArray(v)) as Array<unknown> | undefined;
      return arr?.filter((q): q is string => typeof q === 'string');
    };

    const query = pickString(a.query, a.search_query, a.searchQuery);
    const queries = pickStringArray(a.queries, a.search_queries, a.searchQueries);
    const url = pickString(
      a.url,
      openPage?.url,
      findInPage?.url,
      a.page_url,
      a.pageUrl,
      a.href,
      a.link
    );
    const pattern = pickString(a.pattern, findInPage?.pattern, findInPage?.query, a.text);

    const sources = Array.isArray(a.sources)
      ? (a.sources as Array<{ url?: unknown }>)
        .map((s) => (typeof s?.url === 'string' ? s.url : null))
        .filter((u): u is string => typeof u === 'string')
      : undefined;

    const usedValues = new Set<string>();
    if (query) usedValues.add(query);
    if (queries?.length) queries.forEach((q) => usedValues.add(q));
    if (url) usedValues.add(url);
    if (pattern) usedValues.add(pattern);
    if (sources?.length) sources.forEach((s) => usedValues.add(s));

    const extras: Array<{ label: string; value: string }> = [];
    const extraSet = new Set<string>();
    const skipKeys = new Set([
      'type',
      'query',
      'search_query',
      'searchQuery',
      'queries',
      'search_queries',
      'searchQueries',
      'url',
      'page_url',
      'pageUrl',
      'pattern',
      'sources',
    ]);

    const addExtra = (label: string, value: string) => {
      if (!value) return;
      const normalized = normalizeValue(value);
      if (!normalized) return;
      if (usedValues.has(normalized)) return;
      const key = `${label}:${normalized}`;
      if (extraSet.has(key)) return;
      extraSet.add(key);
      extras.push({ label, value: normalized });
    };

    const collectExtras = (obj: unknown, prefix: string, depth: number) => {
      if (!obj || typeof obj !== 'object') return;
      if (depth > 2) return;
      if (Array.isArray(obj)) {
        if (!obj.length) return;
        const stringItems = obj.filter((v) => typeof v === 'string') as string[];
        if (stringItems.length) {
          addExtra(prefix || 'items', stringItems.map((v) => normalizeValue(v)).join(', '));
          return;
        }
        const urlItems = obj
          .map((v: any) => (v && typeof v === 'object' ? v.url : null))
          .filter((v: any) => typeof v === 'string') as string[];
        if (urlItems.length) {
          addExtra(`${prefix || 'items'}.url`, urlItems.slice(0, 5).map((v) => normalizeValue(v)).join(', '));
        }
        addExtra(`${prefix || 'items'}.count`, String(obj.length));
        return;
      }

      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (skipKeys.has(key)) continue;
        const label = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
          addExtra(label, value);
          continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          addExtra(label, String(value));
          continue;
        }
        if (Array.isArray(value)) {
          collectExtras(value, label, depth + 1);
          continue;
        }
        if (value && typeof value === 'object') {
          collectExtras(value, label, depth + 1);
        }
      }
    };

    collectExtras(a, '', 0);

    const hasCoreDetails = Boolean(
      (queries && queries.length) ||
      query ||
      url ||
      pattern ||
      (sources && sources.length)
    );
    const hasDetails = hasCoreDetails || extras.length > 0;

    return {
      rawType,
      normalizedType,
      query,
      queries,
      url,
      pattern,
      sources,
      extras,
      rawText,
      hasCoreDetails,
      hasDetails,
    };
  }, [action, isExpanded]);

  const queryItems =
    info && info.normalizedType === 'search'
      ? (info.queries?.length ? info.queries : info.query ? [info.query] : []).filter(
        (q): q is string => typeof q === 'string' && q.trim().length > 0
      )
      : [];

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'in_progress':
        return '准备中';
      case 'searching':
        return '搜索中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      default:
        return status || 'unknown';
    }
  }, [status]);

  return (
    <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/30">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/50"
      >
        <Search size={16} className="shrink-0" />
        <span className="font-medium">联网搜索：{statusLabel}</span>
        {isStreaming && status !== 'completed' && (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
        )}
        <span className="ml-auto">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-blue-200 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:text-blue-100">
          {!info ? (
            isStreaming ? (
              <div className="flex space-x-1 py-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.3s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.15s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500" />
              </div>
            ) : (
              <div className="text-xs text-blue-700 dark:text-blue-300">暂无可展示信息</div>
            )
          ) : null}

          {info && (
            <div className="space-y-2">
              {info.rawType && info.rawType !== 'search' && (
                <div className="text-xs text-blue-700 dark:text-blue-300">action: {info.rawType}</div>
              )}

              {info.normalizedType === 'search' && queryItems.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">queries</div>
                  <ul className="list-disc pl-5">
                    {queryItems.map((q) => (
                      <li key={q} className="break-words">
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(info.normalizedType === 'open_page' || info.normalizedType === 'find') && info.url && (
                <div className="break-words">
                  <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">url</span>
                  <span>{info.url}</span>
                </div>
              )}

              {info.normalizedType === 'find' && info.pattern && (
                <div className="break-words">
                  <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">pattern</span>
                  <span>{info.pattern}</span>
                </div>
              )}

              {info.sources?.length ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">sources</div>
                  <ul className="list-disc pl-5">
                    {info.sources.map((u: string) => (
                      <li key={u} className="break-words">
                        {u}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {info.extras?.length ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">其他字段</div>
                  <ul className="list-disc space-y-1 pl-5">
                    {info.extras.map((item) => (
                      <li key={`${item.label}:${item.value}`} className="break-words">
                        <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">
                          {item.label}
                        </span>
                        <span>{item.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!info.hasCoreDetails && info.rawText ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">原始数据</div>
                  <pre className="whitespace-pre-wrap break-words">{info.rawText}</pre>
                </div>
              ) : null}

              {!info.hasDetails && (
                <div className="text-xs text-blue-700 dark:text-blue-300">未找到可展示字段</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const MessageBlocks: React.FC<{
  blocks: MessageBlock[];
  conversationId?: string;
  isStreaming?: boolean;
  isUserBrowsing?: boolean;
  messageSource?: MessageSource;
  turns?: MessageTurn[];
  onAbortTool?: (callId: string) => void;
  assistantMessageId?: string;
  onRetryTurn?: (assistantMessageId: string, turnId: string) => void;
}> = ({ blocks, conversationId, isStreaming, isUserBrowsing, messageSource, turns, onAbortTool, assistantMessageId, onRetryTurn }) => {
  if (!blocks || blocks.length === 0) return null;

  const { config } = useConfigStore();
  const debugMode = config?.general?.debugMode ?? false;
  const ansiRenderMode = config?.general?.ansiRenderMode;
  const ansiColorMode = config?.general?.ansiColorMode;
  const [activeDebugTurn, setActiveDebugTurn] = useState<MessageTurn | null>(null);

  const turnMetaById = useMemo(() => {
    const map = new Map<string, MessageTurn>();
    for (const t of turns || []) {
      map.set(t.turnId, t);
    }
    return map;
  }, [turns]);

  const distinctTurnIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of blocks) {
      if (b.turnId) set.add(b.turnId);
    }
    return set;
  }, [blocks]);
  const showTurnHeader = distinctTurnIds.size > 0;
  const showTaskToggle = distinctTurnIds.size > 1;
  const [isTaskCollapsed, setIsTaskCollapsed] = useState<boolean>(() => messageSource !== 'live');
  const latestTurnId = useMemo(() => {
    let last: string | null = null;
    for (const b of blocks) {
      if (b.turnId) last = b.turnId;
    }
    return last;
  }, [blocks]);

  const latestBlockId = useMemo(() => (blocks.length > 0 ? blocks[blocks.length - 1].id : null), [blocks]);
  const autoCollapseEnabled = Boolean(isStreaming) && !Boolean(isUserBrowsing);
  const lastLatestBlockIdRef = useRef<string | null>(null);
  const [autoCollapseSeq, setAutoCollapseSeq] = useState(0);

  // 兼容旧行为：
  // - “历史加载”的多 Turn：默认收起整个 Task（只展示最新一轮）
  // - “刚生成（live）”：默认展开整个 Task（便于立刻查看）
  //
  // 仅在 messageSource 发生变化时重置；避免用户手动展开/收起时被流式增量更新打断。
  useEffect(() => {
    setIsTaskCollapsed(messageSource !== 'live');
  }, [messageSource]);

  useEffect(() => {
    if (!latestBlockId) return;

    // 仅在流式且用户在“跟随输出”的状态下做自动收起；避免浏览历史时布局突变。
    if (!autoCollapseEnabled) {
      lastLatestBlockIdRef.current = latestBlockId;
      return;
    }

    const prev = lastLatestBlockIdRef.current;
    lastLatestBlockIdRef.current = latestBlockId;
    if (prev && prev !== latestBlockId) {
      setAutoCollapseSeq((n) => n + 1);
    }
  }, [autoCollapseEnabled, latestBlockId]);

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        turnId?: string;
        turnIndex?: number;
        blocks: MessageBlock[];
      }
    >();
    const order: string[] = [];

    for (const block of blocks) {
      const key = block.turnId || '__legacy__';
      const existing = map.get(key);
      if (!existing) {
        order.push(key);
        const meta = block.turnId ? turnMetaById.get(block.turnId) : undefined;
        map.set(key, {
          key,
          turnId: block.turnId,
          turnIndex: meta?.turnIndex ?? block.turnIndex,
          blocks: [block],
        });
        continue;
      }

      existing.blocks.push(block);
      if (existing.turnIndex === undefined) {
        const meta = existing.turnId ? turnMetaById.get(existing.turnId) : undefined;
        existing.turnIndex = meta?.turnIndex ?? block.turnIndex;
      }
    }

    const pairToolBlocks = (turnBlocks: MessageBlock[]): MessageBlock[] => {
      const toolResultsByCallId = new Map<string, MessageBlock[]>();
      for (const b of turnBlocks) {
        if (b.type !== 'tool_result') continue;
        const callId = b.callId || '';
        const list = toolResultsByCallId.get(callId) ?? [];
        list.push(b);
        toolResultsByCallId.set(callId, list);
      }

      const approvalsByCallId = new Map<string, MessageBlock[]>();
      for (const b of turnBlocks) {
        if (b.type !== 'approval') continue;
        const callId = b.callId || b.requestId || '';
        const list = approvalsByCallId.get(callId) ?? [];
        list.push(b);
        approvalsByCallId.set(callId, list);
      }

      const used = new Set<string>();
      const ordered: MessageBlock[] = [];

      for (const b of turnBlocks) {
        if (used.has(b.id)) continue;

        if (b.type === 'tool_call') {
          ordered.push(b);
          used.add(b.id);

          const callId = b.callId || '';

          const approvals = approvalsByCallId.get(callId);
          const nextApproval = approvals && approvals.length > 0 ? approvals.shift() : undefined;
          if (nextApproval && !used.has(nextApproval.id)) {
            ordered.push(nextApproval);
            used.add(nextApproval.id);
          }

          const results = toolResultsByCallId.get(callId);
          const nextResult = results && results.length > 0 ? results.shift() : undefined;
          if (nextResult && !used.has(nextResult.id)) {
            ordered.push(nextResult);
            used.add(nextResult.id);
          }
          continue;
        }

        if (b.type === 'tool_result') {
          // 先跳过：稍后按剩余顺序追加，避免把结果挤到最前面
          continue;
        }

        if (b.type === 'approval') {
          // 先跳过：优先贴在 tool_call 后面，不然顺序会很怪
          continue;
        }

        ordered.push(b);
        used.add(b.id);
      }

      for (const b of turnBlocks) {
        if (b.type !== 'tool_result') continue;
        if (used.has(b.id)) continue;
        ordered.push(b);
        used.add(b.id);
      }

      for (const b of turnBlocks) {
        if (b.type !== 'approval') continue;
        if (used.has(b.id)) continue;
        ordered.push(b);
        used.add(b.id);
      }

      return ordered;
    };

    return order.map((key) => {
      const g = map.get(key)!;
      return { ...g, blocks: pairToolBlocks(g.blocks) };
    });
  }, [blocks, turnMetaById]);

  const visibleGroups = useMemo(() => {
    if (!showTaskToggle) return groups;
    if (!isTaskCollapsed) return groups;
    if (!latestTurnId) return groups;
    return groups.filter((g) => !g.turnId || g.turnId === latestTurnId);
  }, [groups, isTaskCollapsed, latestTurnId, showTaskToggle]);

  const renderBlock = (block: MessageBlock, opts?: { deferHeavy?: boolean }) => {
    const isLatest = Boolean(latestBlockId && block.id === latestBlockId);

    if (block.type === 'thinking') {
      return (
        <ThinkingBlock
          text={block.text}
          isStreaming={isStreaming}
          defaultExpanded={autoCollapseEnabled ? isLatest : Boolean(isStreaming)}
          autoCollapseEnabled={autoCollapseEnabled}
          autoCollapseSeq={autoCollapseSeq}
        />
      );
    }

    if (block.type === 'status') {
      return <StatusBlock text={block.text} isStreaming={isStreaming} />;
    }

    if (block.type === 'text') {
      const format = (block.format || 'markdown').toString();
      if (format === 'plain') {
        return <p className="whitespace-pre-wrap">{block.text}</p>;
      }
      if (format === 'json') {
        return (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
            {block.text}
          </pre>
        );
      }
      const deferHeavy = Boolean(opts?.deferHeavy) && !isStreaming;
      return <DeferredMarkdown content={block.text} conversationId={conversationId} immediate={!deferHeavy} minDelayMs={deferHeavy ? 220 : 0} />;
    }

    if (block.type === 'tool_call') {
      return (
        <ToolCallBlock
          name={block.name}
          args={block.arguments}
          isStreaming={isStreaming}
          defaultExpanded={autoCollapseEnabled ? isLatest : Boolean(isStreaming)}
          autoCollapseEnabled={autoCollapseEnabled}
          autoCollapseSeq={autoCollapseSeq}
        />
      );
    }

    if (block.type === 'approval') {
      const isPending = block.status === 'pending';
      const resolvedDefaultExpanded = isPending || (autoCollapseEnabled ? isLatest : Boolean(isStreaming));
      return (
        <ApprovalBlock
          conversationId={conversationId}
          block={block}
          isStreaming={isStreaming}
          defaultExpanded={resolvedDefaultExpanded}
          autoCollapseEnabled={autoCollapseEnabled}
          autoCollapseSeq={autoCollapseSeq}
        />
      );
    }

    if (block.type === 'tool_result') {
      return (
        <ToolResultBlock
          text={block.text}
          callId={block.callId}
          isStreaming={isStreaming}
          onAbortTool={onAbortTool}
          ansiRenderMode={ansiRenderMode}
          ansiColorMode={ansiColorMode}
          defaultExpanded={autoCollapseEnabled ? isLatest : Boolean(isStreaming)}
          autoCollapseEnabled={autoCollapseEnabled}
          autoCollapseSeq={autoCollapseSeq}
        />
      );
    }

    if (block.type === 'error') {
      return (
        <ErrorBlock
          text={block.text}
          ansiRenderMode={ansiRenderMode}
          ansiColorMode={ansiColorMode}
        />
      );
    }

    if (block.type === 'web_search') {
      return (
        <WebSearchBlock
          status={block.status}
          action={block.action}
          isStreaming={isStreaming}
          defaultExpanded={autoCollapseEnabled ? isLatest : Boolean(isStreaming)}
          autoCollapseEnabled={autoCollapseEnabled}
          autoCollapseSeq={autoCollapseSeq}
        />
      );
    }

    return <UnknownBlock data={block.data} />;
  };

  return (
    <>
      {showTaskToggle ? (
        <div className="mb-2 flex items-center justify-between">
          <div className="select-text text-[10px] font-mono text-gray-400 dark:text-gray-500">
            共 {distinctTurnIds.size} 轮
          </div>
          <button
            type="button"
            onClick={() => setIsTaskCollapsed((v) => !v)}
            className="flex items-center gap-1 rounded bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-100 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:bg-gray-800"
            title={isTaskCollapsed ? '展开任务' : '收起任务'}
          >
            {isTaskCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span>{isTaskCollapsed ? '展开' : '收起'}</span>
          </button>
        </div>
      ) : null}

      {visibleGroups.map((g, idx) => {
        const turnMeta = g.turnId ? turnMetaById.get(g.turnId) : undefined;
        const turnIndex = turnMeta?.turnIndex ?? g.turnIndex ?? idx + 1;
        const debugInfo = turnMeta?.debugInfo;
        // debugMode 只影响“采集”，不影响“查看历史里已经存在的 debug 数据”。
        const hasPersistedDebug = Boolean(debugInfo) || Boolean(turnMeta?.hasDebugInfo);
        const canOpenDebug = hasPersistedDebug;
        const debugButtonDisabled = !hasPersistedDebug;
        const debugTitle = debugInfo
          ? '查看该轮请求/响应'
          : turnMeta?.hasDebugInfo
            ? '点击加载该轮调试信息'
            : debugMode
              ? '该轮暂无调试数据'
              : '开启调试模式后可采集调试信息';
        const deferHeavyForGroup = !isStreaming && (g.turnId ? g.turnId === latestTurnId : true);

	        return (
	          <div key={`${g.key}:${idx}`}>
	            {showTurnHeader && g.turnId ? (
	              <div className="mb-1 flex items-center justify-between">
	                <div className="flex items-center gap-2">
                  <div
                    className="select-text text-[10px] font-mono text-gray-400 dark:text-gray-500"
                    title={g.turnId}
                  >
                    第 {turnIndex} 轮
                  </div>
	                </div>
	
	                <div className="flex items-center gap-2">
	                  {!isStreaming && assistantMessageId && onRetryTurn ? (
	                    <button
	                      type="button"
	                      onClick={() => onRetryTurn(assistantMessageId, g.turnId!)}
	                      className="flex items-center gap-1 rounded bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-100 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:bg-gray-800"
	                      title="重试该轮（重放该轮之前的上下文）"
	                    >
	                      <RefreshCw size={12} />
	                      <span>重试</span>
	                    </button>
	                  ) : null}

	                  <button
	                    type="button"
	                    onClick={() => canOpenDebug && setActiveDebugTurn(turnMeta || null)}
	                    disabled={debugButtonDisabled}
	                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${canOpenDebug
	                      ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
	                      : 'cursor-not-allowed bg-gray-50 text-gray-300 dark:bg-gray-900/40 dark:text-gray-700'
	                      }`}
	                    title={debugTitle}
	                  >
	                    <Bug size={12} />
	                    <span>Debug</span>
	                  </button>
	                </div>
	              </div>
	            ) : null}

            {g.blocks.map((block, blockIdx) => {
              if (block.type === 'tool_call') {
                const next = g.blocks[blockIdx + 1];
                if (next && next.type === 'tool_result' && next.callId === block.callId) {
                  const isLatestToolRun = Boolean(
                    latestBlockId && (block.id === latestBlockId || next.id === latestBlockId)
                  );
                  return block.name === 'apply_patch' ? (
                    <ApplyPatchToolRunBlock
                      key={`${block.id}:${next.id}`}
                      name={block.name}
                      args={block.arguments}
                      resultText={next.text}
                      callId={block.callId}
                      toolMeta={(block as any).meta}
                      isStreaming={isStreaming}
                      onAbortTool={onAbortTool}
                      ansiRenderMode={ansiRenderMode}
                      ansiColorMode={ansiColorMode}
                      defaultExpanded={autoCollapseEnabled ? isLatestToolRun : Boolean(isStreaming)}
                      autoCollapseEnabled={autoCollapseEnabled}
                      autoCollapseSeq={autoCollapseSeq}
                    />
                  ) : (
                    <ToolRunBlock
                      key={`${block.id}:${next.id}`}
                      name={block.name}
                      args={block.arguments}
                      resultText={next.text}
                      callId={block.callId}
                      isStreaming={isStreaming}
                      onAbortTool={onAbortTool}
                      ansiRenderMode={ansiRenderMode}
                      ansiColorMode={ansiColorMode}
                      defaultExpanded={autoCollapseEnabled ? isLatestToolRun : Boolean(isStreaming)}
                      autoCollapseEnabled={autoCollapseEnabled}
                      autoCollapseSeq={autoCollapseSeq}
                    />
                  );
                }
              }

              if (block.type === 'tool_result') {
                const prev = g.blocks[blockIdx - 1];
                if (prev && prev.type === 'tool_call' && prev.callId === block.callId) {
                  return null;
                }
              }

              return (
                <React.Fragment key={block.id}>
                  {renderBlock(block, { deferHeavy: deferHeavyForGroup })}
                </React.Fragment>
              );
            })}
          </div>
        );
      })}

	      <TaskPatchSummary blocks={blocks} isStreaming={isStreaming} />

	      {activeDebugTurn && (
	        <DebugModal
	          isOpen
	          onClose={() => setActiveDebugTurn(null)}
          debugInfo={activeDebugTurn.debugInfo || null}
          turns={turns || null}
          blocks={blocks}
          initialTurnId={activeDebugTurn.turnId || null}
          messageRole="assistant"
          conversationId={conversationId}
          messageId={assistantMessageId}
        />
      )}
    </>
  );
};
