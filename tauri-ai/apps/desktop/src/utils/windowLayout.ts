import type { ViewWindowParams } from './viewWindow';

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PersistedWindowRecord = {
  label: string;
  title: string;
  params: ViewWindowParams;
  bounds?: WindowBounds | null;
  updatedAt: number;
};

type PersistedWindowLayout = {
  version: 1;
  windows: PersistedWindowRecord[];
};

const STORAGE_KEY = 'tauri-ai:window-layout:v1';
const APP_CLOSING_TS_KEY = 'tauri-ai:window-layout:app_closing_ts';

const safeParseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const normalizeBounds = (b: unknown): WindowBounds | null => {
  const x = typeof (b as any)?.x === 'number' ? (b as any).x : null;
  const y = typeof (b as any)?.y === 'number' ? (b as any).y : null;
  const width = typeof (b as any)?.width === 'number' ? (b as any).width : null;
  const height = typeof (b as any)?.height === 'number' ? (b as any).height : null;
  if (x === null || y === null || width === null || height === null) return null;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.max(240, Math.floor(width)),
    height: Math.max(160, Math.floor(height)),
  };
};

export const readWindowLayout = (): PersistedWindowLayout => {
  try {
    if (typeof window === 'undefined') return { version: 1, windows: [] };
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = safeParseJson<PersistedWindowLayout>(raw);
    const windowsRaw = Array.isArray(parsed?.windows) ? parsed!.windows : [];

    const windows: PersistedWindowRecord[] = [];
    const seen = new Set<string>();
    for (const w of windowsRaw) {
      const label = typeof (w as any)?.label === 'string' ? ((w as any).label as string).trim() : '';
      if (!label || seen.has(label)) continue;
      seen.add(label);

      const title = typeof (w as any)?.title === 'string' ? ((w as any).title as string) : label;
      const params = (w as any)?.params as ViewWindowParams;
      const updatedAt = typeof (w as any)?.updatedAt === 'number' ? (w as any).updatedAt : Date.now();
      const bounds = normalizeBounds((w as any)?.bounds) ?? null;

      windows.push({ label, title, params, bounds, updatedAt });
    }

    return { version: 1, windows };
  } catch {
    return { version: 1, windows: [] };
  }
};

const writeWindowLayout = (layout: PersistedWindowLayout) => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore
  }
};

export const upsertWindowRecord = (record: Omit<PersistedWindowRecord, 'updatedAt'> & { updatedAt?: number }) => {
  try {
    if (typeof window === 'undefined') return;
    const label = record.label.trim();
    if (!label) return;
    const layout = readWindowLayout();
    const nextUpdatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : Date.now();
    const next: PersistedWindowRecord = {
      label,
      title: record.title || label,
      params: record.params,
      bounds: record.bounds ?? null,
      updatedAt: nextUpdatedAt,
    };

    const windows = layout.windows.filter((w) => w.label !== label);
    windows.push(next);
    writeWindowLayout({ version: 1, windows });
  } catch {
    // ignore
  }
};

export const removeWindowRecord = (label: string) => {
  try {
    if (typeof window === 'undefined') return;
    const key = (label ?? '').trim();
    if (!key) return;
    const layout = readWindowLayout();
    const windows = layout.windows.filter((w) => w.label !== key);
    writeWindowLayout({ version: 1, windows });
  } catch {
    // ignore
  }
};

export const markAppClosing = () => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(APP_CLOSING_TS_KEY, String(Date.now()));
  } catch {
    // ignore
  }
};

export const isAppClosingRecently = (ttlMs = 2_500): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    const raw = window.localStorage.getItem(APP_CLOSING_TS_KEY);
    const ts = raw ? Number(raw) : NaN;
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= ttlMs;
  } catch {
    return false;
  }
};

export const clearAppClosingIfStale = (ttlMs = 8_000) => {
  try {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(APP_CLOSING_TS_KEY);
    const ts = raw ? Number(raw) : NaN;
    if (!Number.isFinite(ts) || Date.now() - ts > ttlMs) {
      window.localStorage.removeItem(APP_CLOSING_TS_KEY);
    }
  } catch {
    // ignore
  }
};

