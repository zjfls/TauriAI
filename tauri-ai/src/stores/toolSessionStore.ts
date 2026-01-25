/**
 * Tool Session Store
 * Manages long-lived PTY sessions per conversation
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { PtySessionInfo } from '../types';

interface ToolSessionState {
  sessionsByConversation: Record<string, PtySessionInfo[]>;
  isLoadingByConversation: Record<string, boolean>;
  refreshSessions: (conversationId: string) => Promise<void>;
  closeSession: (conversationId: string, sessionId: number) => Promise<boolean>;
  clearSessions: (conversationId: string) => void;
}

export const useToolSessionStore = create<ToolSessionState>((set, get) => ({
  sessionsByConversation: {},
  isLoadingByConversation: {},

  refreshSessions: async (conversationId: string) => {
    if (!conversationId) return;
    set((state) => ({
      isLoadingByConversation: { ...state.isLoadingByConversation, [conversationId]: true },
    }));
    try {
      const sessions = await invoke<PtySessionInfo[]>('list_pty_sessions', { conversationId });
      set((state) => ({
        sessionsByConversation: { ...state.sessionsByConversation, [conversationId]: sessions },
        isLoadingByConversation: { ...state.isLoadingByConversation, [conversationId]: false },
      }));
    } catch (err) {
      console.error('Failed to load PTY sessions:', err);
      set((state) => ({
        isLoadingByConversation: { ...state.isLoadingByConversation, [conversationId]: false },
      }));
    }
  },

  closeSession: async (conversationId: string, sessionId: number) => {
    if (!conversationId) return false;
    try {
      const ok = await invoke<boolean>('close_pty_session', { conversationId, sessionId });
      if (ok) {
        const current = get().sessionsByConversation[conversationId] || [];
        set((state) => ({
          sessionsByConversation: {
            ...state.sessionsByConversation,
            [conversationId]: current.filter((s) => s.sessionId !== sessionId),
          },
        }));
      }
      return ok;
    } catch (err) {
      console.error('Failed to close PTY session:', err);
      return false;
    }
  },

  clearSessions: (conversationId: string) => {
    set((state) => ({
      sessionsByConversation: { ...state.sessionsByConversation, [conversationId]: [] },
    }));
  },
}));

// -----------------------------------------------------------------------------
// Debug: tool session store update storm detector (DEV only)
// -----------------------------------------------------------------------------
const TOOL_SESSION_STORE_DEBUG_LAST_STORM_KEY = 'tauri-ai:debug:last_tool_session_store_storm';
const toolSessionStoreStormDebugEnabled = (() => {
  try {
    return import.meta.env.DEV;
  } catch {
    return false;
  }
})();

if (toolSessionStoreStormDebugEnabled) {
  let windowStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let updatesInWindow = 0;
  let tracedInWindow = false;

  const WINDOW_MS = 500;
  const TRACE_THRESHOLD = 40;

  useToolSessionStore.subscribe((state, prev) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      updatesInWindow = 0;
      tracedInWindow = false;
    }

    updatesInWindow += 1;

    if (!tracedInWindow && updatesInWindow >= TRACE_THRESHOLD) {
      tracedInWindow = true;

      const stack = (() => {
        try {
          return new Error('toolSessionStore update storm').stack || '';
        } catch {
          return '';
        }
      })();

      try {
        if (typeof localStorage !== 'undefined') {
          const record = {
            ts: Date.now(),
            updatesInWindow,
            windowMs: WINDOW_MS,
            state: {
              conversations: Object.keys(state.sessionsByConversation).length,
              loading: Object.keys(state.isLoadingByConversation).filter((k) => state.isLoadingByConversation[k]).length,
            },
            prevState: {
              conversations: Object.keys(prev.sessionsByConversation).length,
              loading: Object.keys(prev.isLoadingByConversation).filter((k) => prev.isLoadingByConversation[k]).length,
            },
            stack,
          };
          localStorage.setItem(TOOL_SESSION_STORE_DEBUG_LAST_STORM_KEY, JSON.stringify(record));
        }
      } catch {
        // ignore
      }

      console.groupCollapsed(`[debug] toolSessionStore 更新风暴: ${updatesInWindow}/${WINDOW_MS}ms`);
      console.log('state:', {
        conversations: Object.keys(state.sessionsByConversation).length,
        loading: Object.keys(state.isLoadingByConversation).filter((k) => state.isLoadingByConversation[k]).length,
      });
      console.log('prev:', {
        conversations: Object.keys(prev.sessionsByConversation).length,
        loading: Object.keys(prev.isLoadingByConversation).filter((k) => prev.isLoadingByConversation[k]).length,
      });
      console.trace('toolSessionStore update storm stack');
      if (stack) console.log('captured stack:', stack);
      console.groupEnd();
    }
  });
}
