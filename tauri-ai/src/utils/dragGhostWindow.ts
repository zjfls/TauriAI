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
};

const GHOST_SIZE = { width: 360, height: 34 };
const GHOST_OFFSET = { x: 14, y: 18 };

const entries = new Map<string, DragGhostEntry>();

const safeLabelPart = (raw: string) => raw.replace(/[^a-zA-Z0-9_:/-]/g, '_');

const ghostLabelForSource = (sourceLabel: string) => `drag-ghost-${safeLabelPart(sourceLabel)}`;

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
    };
    entries.set(label, entry);
    return entry;
  }

  const url = buildGhostUrl({ title });
  const win = new WebviewWindow(label, {
    title: '',
    url,
    visible: false,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
    focusable: false,
    width: GHOST_SIZE.width,
    height: GHOST_SIZE.height,
  });

  const ready = (async () => {
    await waitCreated(win).catch(() => {});
    await Promise.all([
      win.setIgnoreCursorEvents(true).catch(() => {}),
      win.setSize(new PhysicalSize(GHOST_SIZE.width, GHOST_SIZE.height)).catch(() => {}),
    ]);
  })();

  const entry: DragGhostEntry = {
    label,
    win,
    lastPayloadKey: '',
    shown: false,
    ready,
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
  await entry.win.hide().catch(() => {});
  entry.shown = false;
};

export const showAndMoveDragGhostWindow = async (payload: DragGhostPayload, cursor: { x: number; y: number }) => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  const entry = await ensureEntry(sourceLabel, payload);
  if (!entry) return;

  await entry.ready.catch(() => {});

  const payloadKey = JSON.stringify({ title: (payload.title ?? '').trim() });
  if (payloadKey !== entry.lastPayloadKey) {
    entry.lastPayloadKey = payloadKey;
    try {
      await getCurrentWebviewWindow().emitTo(entry.label, 'drag-ghost:update', { title: payload.title });
    } catch {
      // ignore
    }
  }

  if (!entry.shown) {
    await entry.win.show().catch(() => {});
    entry.shown = true;
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
