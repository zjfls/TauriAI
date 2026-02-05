import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';

export type DragGhostPayload = {
  title: string;
};

type DragGhostEntry = {
  label: string;
  win: WebviewWindow;
  lastPayloadKey: string;
  shown: boolean;
  ready: Promise<void>;
  lastSize: { width: number; height: number } | null;
  sizeFetchedAtMs: number;
};

const GHOST_SIZE_FALLBACK = { width: 420, height: 240 };
const GHOST_OFFSET = { x: 14, y: 18 };
const GHOST_SIZE_REFRESH_MIN_INTERVAL_MS = 500;

const entries = new Map<string, DragGhostEntry>();

const safeLabelPart = (raw: string) => raw.replace(/[^a-zA-Z0-9_:/-]/g, '_');

// 调试友好：label 需要一眼能看出是“幽灵窗”，并且可追溯到来源窗口 label。
// 注意：label 不能包含空格等特殊字符；这里做了安全过滤。
const ghostLabelForSource = (sourceLabel: string) => `__tauriai_ghost__${safeLabelPart(sourceLabel)}`;

const ghostWindowTitleForSource = (sourceLabel: string) => `[GHOST] TauriAI (${sourceLabel})`;

const computeGhostSizeForSource = async (): Promise<{ width: number; height: number }> => {
  try {
    const size = await getCurrentWebviewWindow().outerSize().catch(() => null);
    if (!size) return GHOST_SIZE_FALLBACK;
    return {
      width: Math.max(240, Math.floor(size.width / 5)),
      height: Math.max(160, Math.floor(size.height / 5)),
    };
  } catch {
    return GHOST_SIZE_FALLBACK;
  }
};

const buildGhostUrl = (payload: DragGhostPayload) => {
  const params = new URLSearchParams();
  params.set('view', 'drag-ghost');
  params.set('standalone', '1');
  params.set('ghostTitle', payload.title);
  return `/?${params.toString()}`;
};

const waitCreated = (win: WebviewWindow) =>
  new Promise<void>((resolve, reject) => {
    let done = false;
    void win
      .once('tauri://created', () => {
        if (done) return;
        done = true;
        resolve();
      })
      .catch(() => {});
    void win
      .once('tauri://error', (e) => {
        if (done) return;
        done = true;
        reject((e as any)?.payload ?? e);
      })
      .catch(() => {});
    window.setTimeout(() => {
      if (done) return;
      done = true;
      resolve();
    }, 800);
  });

const ensureEntry = async (sourceLabel: string, payload: DragGhostPayload): Promise<DragGhostEntry | null> => {
  if (!isTauri()) return null;
  const title = (payload.title ?? '').trim();
  if (!title) return null;

  const label = ghostLabelForSource(sourceLabel);
  const cached = entries.get(label);
  if (cached) return cached;

  const ghostSize = await computeGhostSizeForSource();

  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing) {
    const ready = Promise.resolve()
      .then(() => existing.setIgnoreCursorEvents(true))
      .catch(() => {});
    const entry: DragGhostEntry = {
      label,
      win: existing,
      lastPayloadKey: '',
      shown: false,
      ready,
      lastSize: ghostSize,
      sizeFetchedAtMs: Date.now(),
    };
    entries.set(label, entry);
    return entry;
  }

  const url = buildGhostUrl({ title });
  const win = new WebviewWindow(label, {
    title: ghostWindowTitleForSource(sourceLabel),
    url,
    visible: false,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
    focusable: false,
    width: ghostSize.width,
    height: ghostSize.height,
  });

  const ready = (async () => {
    await waitCreated(win).catch(() => {});
    await Promise.all([
      win.setIgnoreCursorEvents(true).catch(() => {}),
      win.setSize(new PhysicalSize(ghostSize.width, ghostSize.height)).catch(() => {}),
    ]);
  })();

  const entry: DragGhostEntry = {
    label,
    win,
    lastPayloadKey: '',
    shown: false,
    ready,
    lastSize: ghostSize,
    sizeFetchedAtMs: Date.now(),
  };
  entries.set(label, entry);

  try {
    win.once('tauri://error', (e) => {
      console.error('[dragGhost] tauri://error', { label, payload: (e as any)?.payload ?? e });
      entries.delete(label);
    });
  } catch {
    // ignore
  }

  return entry;
};

const getSourceLabel = () => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
};

export const primeDragGhostWindow = async (payload: DragGhostPayload) => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  const entry = await ensureEntry(sourceLabel, payload);
  if (!entry) return;
  await entry.ready.catch(() => {});

  const nextSize = await computeGhostSizeForSource();
  entry.lastSize = nextSize;
  entry.sizeFetchedAtMs = Date.now();
  await entry.win.setSize(new PhysicalSize(nextSize.width, nextSize.height)).catch(() => {});

  await entry.win.hide().catch(() => {});
  entry.shown = false;
};

export const showAndMoveDragGhostWindow = async (payload: DragGhostPayload, cursor: { x: number; y: number }) => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  const entry = await ensureEntry(sourceLabel, payload);
  if (!entry) return;

  await entry.ready.catch(() => {});

  const now = Date.now();
  if (now - entry.sizeFetchedAtMs >= GHOST_SIZE_REFRESH_MIN_INTERVAL_MS) {
    entry.sizeFetchedAtMs = now;
    const nextSize = await computeGhostSizeForSource();
    const prev = entry.lastSize;
    const changed =
      !prev || Math.abs(nextSize.width - prev.width) > 2 || Math.abs(nextSize.height - prev.height) > 2;
    if (changed) {
      entry.lastSize = nextSize;
      await entry.win.setSize(new PhysicalSize(nextSize.width, nextSize.height)).catch(() => {});
    }
  }

  const payloadKey = JSON.stringify({ title: (payload.title ?? '').trim() });
  if (payloadKey !== entry.lastPayloadKey) {
    entry.lastPayloadKey = payloadKey;
    try {
      await getCurrentWebviewWindow().emitTo(entry.label, 'drag-ghost:update', { title: payload.title });
    } catch {
      // ignore
    }
    // 调试友好：同时更新原生窗口标题（即使无装饰，也便于枚举窗口/日志排查）
    try {
      await entry.win.setTitle(`${ghostWindowTitleForSource(sourceLabel)} :: ${payload.title}`);
    } catch {
      // ignore
    }
  }

  if (!entry.shown) {
    await entry.win.show().catch(() => {});
    entry.shown = true;
    // 仅在首次显示时尝试把焦点留在源窗口：
    // - 频繁 setFocus 可能干扰跨窗口/跨应用拖拽（尤其在 macOS 上）
    // - ghost 窗本身是不可聚焦的，因此这里不需要每次 tick 都抢焦点
    try {
      await getCurrentWebviewWindow().setFocus();
    } catch {
      // ignore
    }
  }
  await entry.win
    .setPosition(new PhysicalPosition(cursor.x + GHOST_OFFSET.x, cursor.y + GHOST_OFFSET.y))
    .catch(() => {});
};

export const hideDragGhostWindow = async () => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  const label = ghostLabelForSource(sourceLabel);
  const entry = entries.get(label);
  if (!entry) return;
  await entry.ready.catch(() => {});
  await entry.win.hide().catch(() => {});
  entry.shown = false;
};
