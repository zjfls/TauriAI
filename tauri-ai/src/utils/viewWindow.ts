import { listen } from '@tauri-apps/api/event';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { cursorPosition } from '@tauri-apps/api/window';
import type { ActiveView, RunMode } from '../types';

type WorkstudioOpenPayload = {
  workstudioId?: string | null;
  filePath: string;
  line?: number | null;
  column?: number | null;
  endLine?: number | null;
  endColumn?: number | null;
};

export type ChatDockPlacement = 'tab' | 'split-left' | 'split-right';

type ChatDockRequestPayload = {
  requestId: string;
  conversationId: string;
  fromWindowLabel: string;
  placement: ChatDockPlacement;
  runMode?: RunMode;
  agentName?: string;
};

type ChatDockAckPayload = {
  requestId: string;
  ok: boolean;
  error?: string | null;
};

export type WorkspaceDockItem =
  | {
      kind: 'document';
      title?: string | null;
      documentPath: string;
    }
  | {
      kind: 'web';
      title?: string | null;
      webUrl: string;
    }
  | {
      kind: 'terminal';
      title?: string | null;
      terminalWorkdir?: string | null;
    };

export type WorkspaceDockRequestPayload = {
  requestId: string;
  fromWindowLabel: string;
  placement: ChatDockPlacement;
  item: WorkspaceDockItem;
};

export type WorkspaceDockAckPayload = {
  requestId: string;
  ok: boolean;
  error?: string | null;
};

type PhysicalRect = { x: number; y: number; width: number; height: number };

const pointInRect = (p: { x: number; y: number }, r: PhysicalRect) => {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
};

const workstudioOpenSeqByLabel = new Map<string, number>();
const workstudioOpenTimersByLabel = new Map<string, number[]>();

const clearWorkstudioOpenTimers = (label: string) => {
  const timers = workstudioOpenTimersByLabel.get(label);
  if (timers) {
    for (const id of timers) window.clearTimeout(id);
  }
  workstudioOpenTimersByLabel.delete(label);
};

const parseRunMode = (value: string | null): RunMode | null => {
  switch (value) {
    case 'chat':
    case 'agent':
    case 'agent-custom':
    case 'agent-full-access':
      return value;
    default:
      return null;
  }
};

const scheduleWorkstudioOpenFile = async (
  win: WebviewWindow,
  label: string,
  payload: WorkstudioOpenPayload
) => {
  const nextSeq = (workstudioOpenSeqByLabel.get(label) ?? 0) + 1;
  workstudioOpenSeqByLabel.set(label, nextSeq);
  clearWorkstudioOpenTimers(label);

  const delays = [0, 60, 180, 420, 900];
  const timerIds: number[] = [];

  for (const delayMs of delays) {
    const id = window.setTimeout(() => {
      if (workstudioOpenSeqByLabel.get(label) !== nextSeq) return;
      void win.emit('workstudio:open_file', payload).catch(() => {
        // ignore; best-effort
      });
    }, delayMs);
    timerIds.push(id);
  }

  workstudioOpenTimersByLabel.set(label, timerIds);
};

export const workstudioWindowLabel = (workstudioId: string) => `view-workstudio-${workstudioId}`;

const normalizeWorkstudioMainFolderKey = (input: string): string => {
  const raw = (input ?? '').trim();
  if (!raw) return '';

  let out = raw.replace(/[\\]+/g, '/').replace(/\/+/g, '/');

  // Keep "C:/" as-is (root drive), otherwise strip trailing slashes for stability.
  if (!/^[A-Za-z]:\/$/.test(out)) {
    out = out.replace(/\/+$/, '');
  }

  // Windows drive paths are case-insensitive; normalize to lowercase for stable identity.
  if (/^[A-Za-z]:\//.test(out)) {
    out = out.toLowerCase();
  }

  return out;
};

const hashToWorkstudioLabel = (key: string): string => {
  // 64-bit FNV-1a (stable, fast, no crypto dependency).
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < key.length; i++) {
    hash ^= BigInt(key.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(36);
};

export const workstudioWindowLabelByMainFolder = (mainFolder: string) => {
  const key = normalizeWorkstudioMainFolderKey(mainFolder);
  if (!key) return null;
  const h = hashToWorkstudioLabel(key).slice(0, 13);
  return `view-workstudio-dir-${h}`;
};

export interface ViewWindowParams {
  view?: ActiveView | null;
  standalone: boolean;
  /** Standalone chat window: do not auto-create a default session when empty. */
  noDefaultSession?: boolean;
  conversationId?: string | null;
  runMode?: RunMode | null;
  agentName?: string | null;
  documentPath?: string | null;
  workstudioId?: string | null;
  webUrl?: string | null;
  webTitle?: string | null;
  terminalWorkdir?: string | null;
  terminalTitle?: string | null;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
  endLine?: number | null;
  endColumn?: number | null;
}

export const getViewWindowParams = (): ViewWindowParams => {
  if (typeof window === 'undefined') {
    return {
      view: null,
      standalone: false,
      noDefaultSession: false,
      conversationId: null,
      runMode: null,
      agentName: null,
      documentPath: null,
      workstudioId: null,
      webUrl: null,
      webTitle: null,
      terminalWorkdir: null,
      terminalTitle: null,
      filePath: null,
      line: null,
      column: null,
      endLine: null,
      endColumn: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') as ActiveView | null;
  const standalone = params.get('standalone') === '1';
  const noDefaultSession = params.get('noDefaultSession') === '1';
  const conversationId = params.get('conversationId');
  const runMode = parseRunMode(params.get('runMode'));
  const agentName = params.get('agentName');
  const documentPath = params.get('documentPath');
  const workstudioId = params.get('workstudioId');
  const webUrl = params.get('webUrl');
  const webTitle = params.get('webTitle');
  const terminalWorkdir = params.get('terminalWorkdir');
  const terminalTitle = params.get('terminalTitle');
  const filePath = params.get('filePath');
  const lineRaw = params.get('line');
  const columnRaw = params.get('column');
  const endLineRaw = params.get('endLine');
  const endColumnRaw = params.get('endColumn');
  const line = lineRaw ? Number(lineRaw) : null;
  const column = columnRaw ? Number(columnRaw) : null;
  const endLine = endLineRaw ? Number(endLineRaw) : null;
  const endColumn = endColumnRaw ? Number(endColumnRaw) : null;
  return {
    view,
    standalone,
    noDefaultSession,
    conversationId,
    runMode,
    agentName,
    documentPath,
    workstudioId,
    webUrl,
    webTitle,
    terminalWorkdir,
    terminalTitle,
    filePath,
    line: Number.isFinite(line) ? line : null,
    column: Number.isFinite(column) ? column : null,
    endLine: Number.isFinite(endLine) ? endLine : null,
    endColumn: Number.isFinite(endColumn) ? endColumn : null,
  };
};

export const openViewWindow = (
  view: ActiveView,
  title: string,
  opts?: {
    conversationId?: string;
    runMode?: RunMode;
    agentName?: string;
    noDefaultSession?: boolean;
    documentPath?: string;
    workstudioId?: string;
    webUrl?: string;
    webTitle?: string;
    terminalWorkdir?: string;
    terminalTitle?: string;
    filePath?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    label?: string;
  }
) => {
  const label = opts?.label ?? `view-${view}-${Date.now()}`;
  const params = new URLSearchParams();
  params.set('view', view);
  params.set('standalone', '1');
  if (opts?.noDefaultSession) {
    params.set('noDefaultSession', '1');
  }
  if (opts?.conversationId) {
    params.set('conversationId', opts.conversationId);
  }
  if (opts?.runMode) {
    params.set('runMode', opts.runMode);
  }
  if (opts?.agentName) {
    params.set('agentName', opts.agentName);
  }
  if (opts?.documentPath) {
    params.set('documentPath', opts.documentPath);
  }
  if (opts?.workstudioId) {
    params.set('workstudioId', opts.workstudioId);
  }
  if (opts?.webUrl) {
    params.set('webUrl', opts.webUrl);
  }
  if (opts?.webTitle) {
    params.set('webTitle', opts.webTitle);
  }
  if (opts?.terminalWorkdir) {
    params.set('terminalWorkdir', opts.terminalWorkdir);
  }
  if (opts?.terminalTitle) {
    params.set('terminalTitle', opts.terminalTitle);
  }
  if (opts?.filePath) {
    params.set('filePath', opts.filePath);
  }
  if (typeof opts?.line === 'number') {
    params.set('line', String(opts.line));
  }
  if (typeof opts?.column === 'number') {
    params.set('column', String(opts.column));
  }
  if (typeof opts?.endLine === 'number') {
    params.set('endLine', String(opts.endLine));
  }
  if (typeof opts?.endColumn === 'number') {
    params.set('endColumn', String(opts.endColumn));
  }
  const url = `/?${params.toString()}`;
  const win = new WebviewWindow(label, {
    title,
    url,
    width: 900,
    height: 700,
  });
  // 在一些环境中，新窗口创建失败不会 throw，而是触发 `tauri://error` 事件。
  // 这里做一个低成本的诊断日志，方便排查“看起来没反应”的问题。
  try {
    win.once('tauri://error', (e) => {
      console.error('[openViewWindow] tauri://error', { label, view, url, payload: (e as any)?.payload });
    });
  } catch {
    // ignore
  }
  return win;
};

export const openOrFocusViewWindow = async (
  view: ActiveView,
  title: string,
  opts?: {
    conversationId?: string;
    runMode?: RunMode;
    agentName?: string;
    noDefaultSession?: boolean;
    documentPath?: string;
    workstudioId?: string;
    webUrl?: string;
    webTitle?: string;
    terminalWorkdir?: string;
    terminalTitle?: string;
    filePath?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    label?: string;
  }
) => {
  const label = opts?.label ?? `view-${view}-${Date.now()}`;
  if (opts?.label) {
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return existing;
      }
    } catch {
      // ignore, will create new window
    }
  }

  const params = new URLSearchParams();
  params.set('view', view);
  params.set('standalone', '1');
  if (opts?.noDefaultSession) {
    params.set('noDefaultSession', '1');
  }
  if (opts?.conversationId) {
    params.set('conversationId', opts.conversationId);
  }
  if (opts?.runMode) {
    params.set('runMode', opts.runMode);
  }
  if (opts?.agentName) {
    params.set('agentName', opts.agentName);
  }
  if (opts?.documentPath) {
    params.set('documentPath', opts.documentPath);
  }
  if (opts?.workstudioId) {
    params.set('workstudioId', opts.workstudioId);
  }
  if (opts?.webUrl) {
    params.set('webUrl', opts.webUrl);
  }
  if (opts?.webTitle) {
    params.set('webTitle', opts.webTitle);
  }
  if (opts?.terminalWorkdir) {
    params.set('terminalWorkdir', opts.terminalWorkdir);
  }
  if (opts?.terminalTitle) {
    params.set('terminalTitle', opts.terminalTitle);
  }
  if (opts?.filePath) {
    params.set('filePath', opts.filePath);
  }
  if (typeof opts?.line === 'number') {
    params.set('line', String(opts.line));
  }
  if (typeof opts?.column === 'number') {
    params.set('column', String(opts.column));
  }
  if (typeof opts?.endLine === 'number') {
    params.set('endLine', String(opts.endLine));
  }
  if (typeof opts?.endColumn === 'number') {
    params.set('endColumn', String(opts.endColumn));
  }
  const url = `/?${params.toString()}`;

  return new WebviewWindow(label, {
    title,
    url,
    width: 900,
    height: 700,
  });
};

export const openOrFocusConversationChatWindow = async (
  conversationId: string,
  title: string,
  opts?: { runMode?: RunMode; agentName?: string }
) => {
  const label = `view-chat-${conversationId}`;
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return { win: existing, isExisting: true as const, label };
    }
  } catch {
    // ignore, will create new window
  }

  const win = openViewWindow('chat', title, {
    conversationId,
    label,
    runMode: opts?.runMode,
    agentName: opts?.agentName,
  });
  return { win, isExisting: false as const, label };
};

export const openOrFocusWorkstudioWindow = async (
  title: string,
  opts: {
    workstudioId: string;
    mainFolder?: string | null;
    filePath?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
  }
) => {
  const workstudioId = (opts.workstudioId ?? '').trim();
  if (!workstudioId) {
    throw new Error('workstudioId 不能为空');
  }

  const label = (() => {
    const byFolder = opts.mainFolder ? workstudioWindowLabelByMainFolder(opts.mainFolder) : null;
    return byFolder ?? workstudioWindowLabel(workstudioId);
  })();

  const win = await openOrFocusViewWindow('workstudio', title, {
    label,
    workstudioId,
    noDefaultSession: true,
  });

  if (opts.filePath) {
    await scheduleWorkstudioOpenFile(win, label, {
      workstudioId,
      filePath: opts.filePath,
      line: opts.line ?? null,
      column: opts.column ?? null,
      endLine: opts.endLine ?? null,
      endColumn: opts.endColumn ?? null,
    });
  }

  return win;
};

export type ChatWindowInfo = {
  label: string;
  kind: 'main' | 'chat';
  conversationId?: string | null;
};

export const listChatWindows = async (): Promise<ChatWindowInfo[]> => {
  try {
    const wins = await WebviewWindow.getAll();
    const labels = wins.map((w) => w.label);
    const infos: ChatWindowInfo[] = [];
    for (const label of labels) {
      if (label === 'main') {
        infos.push({ label, kind: 'main', conversationId: null });
        continue;
      }
      if (label.startsWith('view-chat-')) {
        infos.push({
          label,
          kind: 'chat',
          conversationId: label.slice('view-chat-'.length),
        });
        continue;
      }
      if (label.startsWith('view-workstudio-')) {
        infos.push({
          label,
          kind: 'chat',
          conversationId: null,
        });
        continue;
      }
      // Generic workspace window (tab/pane container). Treated as a chat-capable window for docking.
      if (label.startsWith('workspace-')) {
        infos.push({
          label,
          kind: 'chat',
          conversationId: null,
        });
      }
    }
    infos.sort((a, b) => {
      if (a.kind === 'main' && b.kind !== 'main') return -1;
      if (b.kind === 'main' && a.kind !== 'main') return 1;
      return a.label.localeCompare(b.label);
    });
    return infos;
  } catch {
    return [];
  }
};

export const findChatDockTargetAtCursor = async (): Promise<
  | {
      targetLabel: string;
      placement: ChatDockPlacement;
    }
  | null
> => {
  const sourceLabel = (() => {
    try {
      return getCurrentWebviewWindow().label;
    } catch {
      return null;
    }
  })();

  const cursor = await cursorPosition().catch(() => null);
  if (!cursor) return null;

  const cursorPoint = { x: cursor.x, y: cursor.y };

  const candidates = await listChatWindows();

  for (const w of candidates) {
    if (sourceLabel && w.label === sourceLabel) continue;
    const win = await WebviewWindow.getByLabel(w.label).catch(() => null);
    if (!win) continue;

    const [pos, size] = await Promise.all([
      win.outerPosition().catch(() => null),
      win.outerSize().catch(() => null),
    ]);

    if (!pos || !size) continue;
    const rect: PhysicalRect = { x: pos.x, y: pos.y, width: size.width, height: size.height };
    if (!pointInRect(cursorPoint, rect)) continue;

    const ratioX = rect.width > 0 ? (cursorPoint.x - rect.x) / rect.width : 0.5;
    // 降低跨窗口分屏门槛：左右 1/3 区域即可触发分屏，其余区域为 tab 停靠。
    const placement: ChatDockPlacement = ratioX <= 0.33 ? 'split-left' : ratioX >= 0.67 ? 'split-right' : 'tab';

    return { targetLabel: w.label, placement };
  }

  return null;
};

export const emitToWindowLabel = async (label: string, eventName: string, payload: unknown): Promise<boolean> => {
  try {
    const win = await WebviewWindow.getByLabel(label);
    if (!win) return false;
    await win.emit(eventName, payload);
    return true;
  } catch {
    return false;
  }
};

export const dockConversationToWindow = async (
  conversationId: string,
  targetLabel: string,
  placement: ChatDockPlacement = 'tab',
  opts?: { runMode?: RunMode; agentName?: string }
): Promise<void> => {
  const sourceLabel = getCurrentWebviewWindow().label;
  const target = await WebviewWindow.getByLabel(targetLabel);
  if (!target) {
    throw new Error(`目标窗口不存在：${targetLabel}`);
  }

  const requestId =
    typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
      ? (crypto as any).randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const payload: ChatDockRequestPayload = {
    requestId,
    conversationId,
    fromWindowLabel: sourceLabel,
    placement,
    runMode: opts?.runMode,
    agentName: opts?.agentName,
  };

  const delaysMs = [0, 60, 180, 420, 900];
  const timeoutMs = 2200;

  let done = false;
  const timers: number[] = [];
  let unlisten: null | (() => void) = null;

  const stop = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    for (const id of timers) window.clearTimeout(id);
    timers.length = 0;
  };

  const sendOnce = () => {
    void target.emit('chat:dock_request', payload).catch(() => {
      // ignore; best-effort retry
    });
  };

  await new Promise<void>((resolve, reject) => {
    void (async () => {
      try {
        unlisten = await listen<ChatDockAckPayload>('chat:dock_ack', (event) => {
          const ack = event.payload;
          if (!ack || ack.requestId !== requestId) return;
          if (done) return;
          done = true;
          stop();
          if (ack.ok) resolve();
          else reject(new Error(ack.error || '停靠失败'));
        });
      } catch (err) {
        done = true;
        stop();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      for (const delay of delaysMs) {
        timers.push(window.setTimeout(sendOnce, delay));
      }
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          done = true;
          stop();
          reject(new Error('停靠超时：目标窗口未响应'));
        }, timeoutMs)
      );
    })();
  });

  void target.setFocus().catch(() => {});
};

export const dockWorkspaceItemToWindow = async (
  item: WorkspaceDockItem,
  target: string | WebviewWindow,
  placement: ChatDockPlacement = 'tab'
): Promise<void> => {
  const sourceLabel = getCurrentWebviewWindow().label;
  const targetLabel = typeof target === 'string' ? target : target.label;
  const targetWin = typeof target === 'string' ? await WebviewWindow.getByLabel(target) : target;
  if (!targetWin) throw new Error(`目标窗口不存在：${targetLabel}`);

  const requestId =
    typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
      ? (crypto as any).randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const payload: WorkspaceDockRequestPayload = {
    requestId,
    item,
    fromWindowLabel: sourceLabel,
    placement,
  };

  const delaysMs = [0, 60, 180, 420, 900];
  const timeoutMs = 2200;

  let done = false;
  const timers: number[] = [];
  let unlisten: null | (() => void) = null;

  const stop = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    for (const id of timers) window.clearTimeout(id);
    timers.length = 0;
  };

  const sendOnce = () => {
    void targetWin.emit('workspace:dock_request', payload).catch(() => {
      // ignore; best-effort retry
    });
  };

  await new Promise<void>((resolve, reject) => {
    void (async () => {
      try {
        unlisten = await listen<WorkspaceDockAckPayload>('workspace:dock_ack', (event) => {
          const ack = event.payload;
          if (!ack || ack.requestId !== requestId) return;
          if (done) return;
          done = true;
          stop();
          if (ack.ok) resolve();
          else reject(new Error(ack.error || '停靠失败'));
        });
      } catch (err) {
        done = true;
        stop();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      for (const delay of delaysMs) {
        timers.push(window.setTimeout(sendOnce, delay));
      }
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          done = true;
          stop();
          reject(new Error('停靠超时：目标窗口未响应'));
        }, timeoutMs)
      );
    })();
  });

  void targetWin.setFocus().catch(() => {});
};

export const closeCurrentWindow = async () => {
  const win = getCurrentWebviewWindow();
  await win.close();
};
