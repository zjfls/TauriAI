import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export const WINDOW_PRESENCE_KEY_PREFIX = 'tauri-ai:presence:window:';

export type WindowPresenceRecord = {
  ts: number;
  openConversationIds: string[];
};

const safeParseJson = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const getCurrentWindowLabelSafe = (): string => {
  try {
    if (isTauri()) return getCurrentWebviewWindow().label;
  } catch {
    // ignore
  }
  return typeof window !== 'undefined' && window.name ? window.name : 'browser';
};

export const writeWindowPresence = (label: string, record: Omit<WindowPresenceRecord, 'ts'>): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    const openConversationIds = Array.from(new Set(record.openConversationIds.filter(Boolean))).sort();
    const payload: WindowPresenceRecord = { ts: Date.now(), openConversationIds };
    localStorage.setItem(`${WINDOW_PRESENCE_KEY_PREFIX}${label}`, JSON.stringify(payload));
  } catch {
    // ignore
  }
};

export const removeWindowPresence = (label: string): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(`${WINDOW_PRESENCE_KEY_PREFIX}${label}`);
  } catch {
    // ignore
  }
};

export const collectOpenConversationIdsFromPresence = (opts?: { ttlMs?: number }): Set<string> => {
  const ttlMs = opts?.ttlMs ?? 12_000;
  const out = new Set<string>();
  try {
    if (typeof localStorage === 'undefined') return out;
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(WINDOW_PRESENCE_KEY_PREFIX)) continue;
      const rec = safeParseJson<WindowPresenceRecord>(localStorage.getItem(key));
      if (!rec || typeof rec.ts !== 'number' || now - rec.ts > ttlMs) continue;
      for (const cid of rec.openConversationIds || []) {
        if (cid) out.add(cid);
      }
    }
  } catch {
    // ignore
  }
  return out;
};

export const subscribeWindowPresenceChanges = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: StorageEvent) => {
    const k = e.key;
    if (!k) return;
    if (!k.startsWith(WINDOW_PRESENCE_KEY_PREFIX)) return;
    cb();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
};

