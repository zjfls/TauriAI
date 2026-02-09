import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { TerminalScope } from '../types';

type TerminalSessionEntry = {
  scope: TerminalScope;
  sessionId: number;
  workdir?: string | null;
  createdAt: string;
  lastActiveAt: string;
};

const scopeKey = (scope: TerminalScope) => `${scope.kind}:${scope.id}`;

// Deduplicate concurrent creates.
const inflightEnsureByKey = new Map<string, Promise<number | null>>();

interface TerminalSessionState {
  sessions: Map<string, TerminalSessionEntry>;

  getSessionId: (scope: TerminalScope) => number | null;
  ensureSession: (scope: TerminalScope, opts?: { workdir?: string | null }) => Promise<number | null>;
  closeSession: (scope: TerminalScope) => Promise<boolean>;

  write: (scope: TerminalScope, chars: string) => Promise<void>;
  readBase64: (
    scope: TerminalScope,
    opts: { timeoutMs: number; maxBytes: number }
  ) => Promise<string>;
}

export const useTerminalSessionStore = create<TerminalSessionState>((set, get) => ({
  sessions: new Map(),

  getSessionId: (scope) => {
    return get().sessions.get(scopeKey(scope))?.sessionId ?? null;
  },

  ensureSession: async (scope, opts) => {
    if (!isTauri()) return null;
    const key = scopeKey(scope);
    const existing = get().sessions.get(key);
    if (existing?.sessionId) return existing.sessionId;

    const inflight = inflightEnsureByKey.get(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<number | null> => {
      try {
        const sid = await invoke<number>('terminal_create', {
          scope,
          workdir: (opts?.workdir ?? existing?.workdir ?? null) || undefined,
        });
        const now = new Date().toISOString();
        set((state) => {
          const next = new Map(state.sessions);
          next.set(key, {
            scope,
            sessionId: sid,
            workdir: opts?.workdir ?? existing?.workdir ?? null,
            createdAt: now,
            lastActiveAt: now,
          });
          return { sessions: next };
        });
        return sid;
      } catch (err) {
        console.warn('terminal_create failed:', err);
        return null;
      } finally {
        inflightEnsureByKey.delete(key);
      }
    })();

    inflightEnsureByKey.set(key, promise);
    return promise;
  },

  closeSession: async (scope) => {
    if (!isTauri()) return false;
    const key = scopeKey(scope);
    const entry = get().sessions.get(key);
    if (!entry?.sessionId) {
      set((state) => {
        if (!state.sessions.has(key)) return {};
        const next = new Map(state.sessions);
        next.delete(key);
        return { sessions: next };
      });
      return false;
    }

    try {
      const ok = await invoke<boolean>('terminal_close', {
        scope,
        sessionId: entry.sessionId,
      });
      set((state) => {
        const next = new Map(state.sessions);
        next.delete(key);
        return { sessions: next };
      });
      return ok;
    } catch (err) {
      console.warn('terminal_close failed:', err);
      set((state) => {
        const next = new Map(state.sessions);
        next.delete(key);
        return { sessions: next };
      });
      return false;
    }
  },

  write: async (scope, chars) => {
    if (!isTauri()) return;
    const sid = (await get().ensureSession(scope)) ?? null;
    if (!sid) return;
    try {
      await invoke('terminal_write', {
        scope,
        sessionId: sid,
        chars,
      });
      const key = scopeKey(scope);
      set((state) => {
        const entry = state.sessions.get(key);
        if (!entry) return {};
        const next = new Map(state.sessions);
        next.set(key, { ...entry, lastActiveAt: new Date().toISOString() });
        return { sessions: next };
      });
    } catch {
      // Session may have been invalidated (e.g., backend restart). Clear and allow re-create.
      const key = scopeKey(scope);
      set((state) => {
        if (!state.sessions.has(key)) return {};
        const next = new Map(state.sessions);
        next.delete(key);
        return { sessions: next };
      });
    }
  },

  readBase64: async (scope, opts) => {
    if (!isTauri()) return '';
    const sid = get().getSessionId(scope);
    if (!sid) return '';
    try {
      return await invoke<string>('terminal_read_base64', {
        scope,
        sessionId: sid,
        timeoutMs: Math.max(0, Math.floor(opts.timeoutMs)),
        maxBytes: Math.max(0, Math.floor(opts.maxBytes)),
      });
    } catch {
      // Session gone/stale. Clear so next connect can create a new one.
      const key = scopeKey(scope);
      set((state) => {
        if (!state.sessions.has(key)) return {};
        const next = new Map(state.sessions);
        next.delete(key);
        return { sessions: next };
      });
      return '';
    }
  },
}));
