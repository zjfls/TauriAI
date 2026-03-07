import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ViewWindowParams } from './viewWindow';

export const MIN_WINDOW_WIDTH = 240;
export const MIN_WINDOW_HEIGHT = 144;

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MonitorAreaLike = {
  position: { x: number; y: number };
  size: { width: number; height: number };
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

const EMPTY_WINDOW_LAYOUT: PersistedWindowLayout = { version: 1, windows: [] };

const STORAGE_KEY = 'tauri-ai:window-layout:v1';

let cachedLayout: PersistedWindowLayout | null = null;
let syncPromise: Promise<PersistedWindowLayout> | null = null;
let hasHydratedFromBackend = false;

const safeParseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const normalizeWindowBounds = (b: unknown): WindowBounds | null => {
  const x = typeof (b as any)?.x === 'number' ? (b as any).x : null;
  const y = typeof (b as any)?.y === 'number' ? (b as any).y : null;
  const width = typeof (b as any)?.width === 'number' ? (b as any).width : null;
  const height = typeof (b as any)?.height === 'number' ? (b as any).height : null;
  if (x === null || y === null || width === null || height === null) return null;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.max(MIN_WINDOW_WIDTH, Math.floor(width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.floor(height)),
  };
};

const normalizeMonitorArea = (source: unknown): WindowBounds | null => {
  const position = (source as any)?.position;
  const size = (source as any)?.size;
  const x = typeof position?.x === 'number' ? position.x : null;
  const y = typeof position?.y === 'number' ? position.y : null;
  const width = typeof size?.width === 'number' ? size.width : null;
  const height = typeof size?.height === 'number' ? size.height : null;
  if (x === null || y === null || width === null || height === null) return null;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
};

const clamp = (value: number, min: number, max: number) => {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
};

const intersectionArea = (a: WindowBounds, b: WindowBounds): number => {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return 0;
  return width * height;
};

const squaredDistanceFromPointToRect = (point: { x: number; y: number }, rect: WindowBounds): number => {
  const clampedX = clamp(point.x, rect.x, rect.x + rect.width);
  const clampedY = clamp(point.y, rect.y, rect.y + rect.height);
  const dx = point.x - clampedX;
  const dy = point.y - clampedY;
  return dx * dx + dy * dy;
};

export const clampWindowBoundsToMonitors = (
  bounds: WindowBounds,
  monitors: Array<{ workArea?: MonitorAreaLike | null; position?: { x: number; y: number }; size?: { width: number; height: number } }>
): WindowBounds => {
  const normalized = normalizeWindowBounds(bounds) ?? {
    x: 0,
    y: 0,
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
  };

  const areas = monitors
    .map((monitor) => normalizeMonitorArea(monitor?.workArea ?? monitor))
    .filter((area): area is WindowBounds => Boolean(area));

  if (areas.length === 0) return normalized;

  let bestArea = areas[0];
  let bestOverlap = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  const center = {
    x: normalized.x + normalized.width / 2,
    y: normalized.y + normalized.height / 2,
  };

  for (const area of areas) {
    const overlap = intersectionArea(normalized, area);
    if (overlap > 0) {
      if (overlap > bestOverlap) {
        bestArea = area;
        bestOverlap = overlap;
      }
      continue;
    }

    if (bestOverlap > 0) continue;

    const distance = squaredDistanceFromPointToRect(center, area);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestArea = area;
    }
  }

  const width = Math.min(normalized.width, Math.max(MIN_WINDOW_WIDTH, bestArea.width));
  const height = Math.min(normalized.height, Math.max(MIN_WINDOW_HEIGHT, bestArea.height));
  const maxX = bestArea.x + bestArea.width - width;
  const maxY = bestArea.y + bestArea.height - height;

  return {
    x: clamp(normalized.x, bestArea.x, maxX),
    y: clamp(normalized.y, bestArea.y, maxY),
    width,
    height,
  };
};

const normalizePersistedWindowLayout = (raw: unknown): PersistedWindowLayout => {
  const parsed = raw as PersistedWindowLayout | null | undefined;
  const windowsRaw = Array.isArray(parsed?.windows) ? parsed!.windows : [];

  const windows: PersistedWindowRecord[] = [];
  const seen = new Set<string>();
  for (const w of windowsRaw) {
    const label = typeof (w as any)?.label === 'string' ? ((w as any).label as string).trim() : '';
    if (!label || seen.has(label)) continue;
    seen.add(label);

    const title = typeof (w as any)?.title === 'string' ? ((w as any).title as string) : label;
    const params = ((w as any)?.params ?? null) as ViewWindowParams;
    const updatedAt = typeof (w as any)?.updatedAt === 'number' ? (w as any).updatedAt : Date.now();
    const bounds = normalizeWindowBounds((w as any)?.bounds) ?? null;
    windows.push({ label, title, params, bounds, updatedAt });
  }

  return { version: 1, windows };
};

const mergeWindowLayouts = (...layouts: Array<PersistedWindowLayout | null | undefined>): PersistedWindowLayout => {
  const merged = new Map<string, PersistedWindowRecord>();

  for (const layout of layouts) {
    for (const record of normalizePersistedWindowLayout(layout).windows) {
      const existing = merged.get(record.label);
      if (!existing || record.updatedAt >= existing.updatedAt) {
        merged.set(record.label, record);
      }
    }
  }

  return {
    version: 1,
    windows: Array.from(merged.values()).sort((a, b) => a.updatedAt - b.updatedAt || a.label.localeCompare(b.label)),
  };
};

const readLocalWindowLayout = (): PersistedWindowLayout => {
  try {
    if (typeof window === 'undefined') return EMPTY_WINDOW_LAYOUT;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizePersistedWindowLayout(safeParseJson<PersistedWindowLayout>(raw));
  } catch {
    return EMPTY_WINDOW_LAYOUT;
  }
};

const writeWindowLayout = (layout: PersistedWindowLayout) => {
  try {
    cachedLayout = layout;
    if (typeof window === 'undefined') return;
    if (!isTauri()) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    }
  } catch {
    // ignore
  }
};

const persistRecordToBackend = (record: PersistedWindowRecord) => {
  if (!isTauri()) return;
  void invoke('upsert_window_layout_record', {
    record: {
      label: record.label,
      title: record.title,
      params: record.params,
      bounds: record.bounds ?? null,
      updatedAt: record.updatedAt,
    },
  }).catch(() => {
    // ignore
  });
};

const persistRemoveToBackend = (label: string) => {
  if (!isTauri()) return;
  void invoke('remove_window_layout_record', { label }).catch(() => {
    // ignore
  });
};

export const readWindowLayout = (): PersistedWindowLayout => {
  if (isTauri()) {
    return cachedLayout ?? EMPTY_WINDOW_LAYOUT;
  }

  const layout = mergeWindowLayouts(cachedLayout, readLocalWindowLayout());
  cachedLayout = layout;
  return layout;
};

export const syncWindowLayoutFromBackend = async (): Promise<PersistedWindowLayout> => {
  if (!isTauri()) {
    const layout = readWindowLayout();
    cachedLayout = layout;
    return layout;
  }
  if (syncPromise) return syncPromise;

  syncPromise = invoke<PersistedWindowLayout>('get_window_layout_state')
    .then((state) => {
      const normalized = hasHydratedFromBackend
        ? mergeWindowLayouts(cachedLayout, state)
        : normalizePersistedWindowLayout(state);
      hasHydratedFromBackend = true;
      writeWindowLayout(normalized);
      return normalized;
    })
    .catch(() => {
      const fallback = readWindowLayout();
      writeWindowLayout(fallback);
      return fallback;
    })
    .finally(() => {
      syncPromise = null;
    });

  return syncPromise;
};

export const getWindowRecord = (label: string): PersistedWindowRecord | null => {
  try {
    const key = (label ?? '').trim();
    if (!key) return null;
    return readWindowLayout().windows.find((w) => w.label === key) ?? null;
  } catch {
    return null;
  }
};

export const upsertWindowRecord = (record: Omit<PersistedWindowRecord, 'updatedAt'> & { updatedAt?: number }) => {
  try {
    if (typeof window === 'undefined') return;
    const label = record.label.trim();
    if (!label) return;
    const layout = readWindowLayout();
    const existing = layout.windows.find((w) => w.label === label) ?? null;
    const nextUpdatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : Date.now();
    const next: PersistedWindowRecord = {
      label,
      title: record.title || label,
      params: record.params,
      bounds: normalizeWindowBounds(record.bounds) ?? existing?.bounds ?? null,
      updatedAt: nextUpdatedAt,
    };

    const windows = layout.windows.filter((w) => w.label !== label);
    windows.push(next);
    const nextLayout: PersistedWindowLayout = { version: 1, windows };
    writeWindowLayout(nextLayout);
    persistRecordToBackend(next);
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
    persistRemoveToBackend(key);
  } catch {
    // ignore
  }
};

export const __resetWindowLayoutCacheForTests = () => {
  cachedLayout = null;
  syncPromise = null;
  hasHydratedFromBackend = false;
};
