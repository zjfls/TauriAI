import { create } from 'zustand';
import {
  closeAgentSession,
  getAgentSessionDetail,
  listAgentSessions,
  sendAgentSessionMessage,
  startAgentSession,
} from '../services/agentSessionService';
import type {
  AgentSessionCommandResult,
  AgentSessionDetail,
  AgentSessionScope,
  AgentSessionSummary,
} from '../types';

type ScopeFilter = AgentSessionScope | null;

const scopeKeyOf = (scope: ScopeFilter): string =>
  scope ? `${scope.kind}:${scope.id}` : 'all';

const scopeFromSummary = (summary: AgentSessionSummary): AgentSessionScope => ({
  kind: summary.scopeKind,
  id: summary.scopeId,
});

interface AgentSessionState {
  sessionsByScopeKey: Record<string, AgentSessionSummary[]>;
  selectedSessionIdByScopeKey: Record<string, string | null>;
  detailsBySessionId: Record<string, AgentSessionDetail>;
  isLoadingByScopeKey: Record<string, boolean>;
  isLoadingDetailBySessionId: Record<string, boolean>;
  isStartingByScopeKey: Record<string, boolean>;
  isSendingBySessionId: Record<string, boolean>;
  errorsByScopeKey: Record<string, string | null>;
  refreshSessions: (scope?: ScopeFilter) => Promise<void>;
  loadSessionDetail: (sessionId: string) => Promise<AgentSessionDetail | null>;
  selectSession: (scope: ScopeFilter, sessionId: string | null) => void;
  startSession: (input: {
    scope: AgentSessionScope;
    agentName: string;
    prompt: string;
    title?: string;
    modelRef?: string;
    runMode?: string;
    thinking?: unknown;
    timeoutMs?: number;
    cwd?: string;
  }) => Promise<AgentSessionCommandResult>;
  sendSessionMessage: (input: {
    scope?: ScopeFilter;
    sessionId: string;
    prompt: string;
    modelRef?: string;
    runMode?: string;
    thinking?: unknown;
    timeoutMs?: number;
    cwd?: string;
  }) => Promise<AgentSessionCommandResult>;
  closeSession: (input: {
    scope?: ScopeFilter;
    sessionId: string;
    deleteSessionDb?: boolean;
  }) => Promise<AgentSessionDetail>;
}

const ensureSelectedSessionId = (
  selectedSessionId: string | null | undefined,
  sessions: AgentSessionSummary[]
): string | null => {
  if (!sessions.length) return null;
  if (selectedSessionId && sessions.some((session) => session.sessionId === selectedSessionId)) {
    return selectedSessionId;
  }
  return sessions[0].sessionId;
};

const upsertSessionInList = (
  sessions: AgentSessionSummary[],
  nextSummary: AgentSessionSummary
): AgentSessionSummary[] => {
  const filtered = sessions.filter((session) => session.sessionId !== nextSummary.sessionId);
  return [nextSummary, ...filtered].sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt))
  );
};

export const useAgentSessionStore = create<AgentSessionState>((set, get) => {
  const refreshRelatedScopes = async (scope?: ScopeFilter) => {
    const scopes: ScopeFilter[] = [];
    if (scope !== undefined) scopes.push(scope);
    scopes.push(null);
    const seen = new Set<string>();
    for (const item of scopes) {
      const key = scopeKeyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      await get().refreshSessions(item);
    }
  };

  return {
    sessionsByScopeKey: {},
    selectedSessionIdByScopeKey: {},
    detailsBySessionId: {},
    isLoadingByScopeKey: {},
    isLoadingDetailBySessionId: {},
    isStartingByScopeKey: {},
    isSendingBySessionId: {},
    errorsByScopeKey: {},

    refreshSessions: async (scope = null) => {
      const scopeKey = scopeKeyOf(scope);
      set((state) => ({
        isLoadingByScopeKey: { ...state.isLoadingByScopeKey, [scopeKey]: true },
        errorsByScopeKey: { ...state.errorsByScopeKey, [scopeKey]: null },
      }));
      try {
        const sessions = await listAgentSessions(scope ?? undefined);
        set((state) => ({
          sessionsByScopeKey: { ...state.sessionsByScopeKey, [scopeKey]: sessions },
          selectedSessionIdByScopeKey: {
            ...state.selectedSessionIdByScopeKey,
            [scopeKey]: ensureSelectedSessionId(state.selectedSessionIdByScopeKey[scopeKey], sessions),
          },
          isLoadingByScopeKey: { ...state.isLoadingByScopeKey, [scopeKey]: false },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          isLoadingByScopeKey: { ...state.isLoadingByScopeKey, [scopeKey]: false },
          errorsByScopeKey: { ...state.errorsByScopeKey, [scopeKey]: message },
        }));
      }
    },

    loadSessionDetail: async (sessionId: string) => {
      if (!sessionId) return null;
      set((state) => ({
        isLoadingDetailBySessionId: {
          ...state.isLoadingDetailBySessionId,
          [sessionId]: true,
        },
      }));
      try {
        const detail = await getAgentSessionDetail(sessionId);
        set((state) => ({
          detailsBySessionId: { ...state.detailsBySessionId, [sessionId]: detail },
          isLoadingDetailBySessionId: {
            ...state.isLoadingDetailBySessionId,
            [sessionId]: false,
          },
        }));
        return detail;
      } catch (error) {
        console.error('Failed to load agent session detail:', error);
        set((state) => ({
          isLoadingDetailBySessionId: {
            ...state.isLoadingDetailBySessionId,
            [sessionId]: false,
          },
        }));
        return null;
      }
    },

    selectSession: (scope, sessionId) => {
      const scopeKey = scopeKeyOf(scope);
      set((state) => ({
        selectedSessionIdByScopeKey: {
          ...state.selectedSessionIdByScopeKey,
          [scopeKey]: sessionId,
        },
      }));
      if (sessionId) {
        void get().loadSessionDetail(sessionId);
      }
    },

    startSession: async (input) => {
      const scopeKey = scopeKeyOf(input.scope);
      set((state) => ({
        isStartingByScopeKey: { ...state.isStartingByScopeKey, [scopeKey]: true },
        errorsByScopeKey: { ...state.errorsByScopeKey, [scopeKey]: null },
      }));
      try {
        const result = await startAgentSession(input);
        const summary = result.detail.summary;
        const summaryScope = scopeFromSummary(summary);
        set((state) => ({
          detailsBySessionId: {
            ...state.detailsBySessionId,
            [summary.sessionId]: result.detail,
          },
          sessionsByScopeKey: {
            ...state.sessionsByScopeKey,
            [scopeKeyOf(summaryScope)]: upsertSessionInList(
              state.sessionsByScopeKey[scopeKeyOf(summaryScope)] ?? [],
              summary
            ),
            [scopeKeyOf(null)]: upsertSessionInList(
              state.sessionsByScopeKey[scopeKeyOf(null)] ?? [],
              summary
            ),
          },
          selectedSessionIdByScopeKey: {
            ...state.selectedSessionIdByScopeKey,
            [scopeKeyOf(summaryScope)]: summary.sessionId,
            [scopeKey]: summary.sessionId,
            [scopeKeyOf(null)]: summary.sessionId,
          },
          isStartingByScopeKey: { ...state.isStartingByScopeKey, [scopeKey]: false },
        }));
        await refreshRelatedScopes(summaryScope);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          isStartingByScopeKey: { ...state.isStartingByScopeKey, [scopeKey]: false },
          errorsByScopeKey: { ...state.errorsByScopeKey, [scopeKey]: message },
        }));
        throw error;
      }
    },

    sendSessionMessage: async (input) => {
      set((state) => ({
        isSendingBySessionId: {
          ...state.isSendingBySessionId,
          [input.sessionId]: true,
        },
      }));
      try {
        const result = await sendAgentSessionMessage({
          sessionId: input.sessionId,
          prompt: input.prompt,
          modelRef: input.modelRef,
          runMode: input.runMode,
          thinking: input.thinking,
          timeoutMs: input.timeoutMs,
          cwd: input.cwd,
        });
        const summary = result.detail.summary;
        const summaryScope = scopeFromSummary(summary);
        set((state) => ({
          detailsBySessionId: {
            ...state.detailsBySessionId,
            [summary.sessionId]: result.detail,
          },
          sessionsByScopeKey: {
            ...state.sessionsByScopeKey,
            [scopeKeyOf(summaryScope)]: upsertSessionInList(
              state.sessionsByScopeKey[scopeKeyOf(summaryScope)] ?? [],
              summary
            ),
            [scopeKeyOf(null)]: upsertSessionInList(
              state.sessionsByScopeKey[scopeKeyOf(null)] ?? [],
              summary
            ),
          },
          selectedSessionIdByScopeKey: {
            ...state.selectedSessionIdByScopeKey,
            [scopeKeyOf(summaryScope)]: summary.sessionId,
            [scopeKeyOf(null)]: summary.sessionId,
          },
          isSendingBySessionId: {
            ...state.isSendingBySessionId,
            [input.sessionId]: false,
          },
        }));
        await refreshRelatedScopes(input.scope ?? summaryScope);
        return result;
      } catch (error) {
        set((state) => ({
          isSendingBySessionId: {
            ...state.isSendingBySessionId,
            [input.sessionId]: false,
          },
        }));
        throw error;
      }
    },

    closeSession: async (input) => {
      try {
        const detail = await closeAgentSession(input.sessionId, input.deleteSessionDb ?? false);
        const summary = detail.summary;
        const summaryScope = scopeFromSummary(summary);
        set((state) => ({
          detailsBySessionId: {
            ...state.detailsBySessionId,
            [summary.sessionId]: detail,
          },
          sessionsByScopeKey: {
            ...state.sessionsByScopeKey,
            [scopeKeyOf(summaryScope)]: upsertSessionInList(
              state.sessionsByScopeKey[scopeKeyOf(summaryScope)] ?? [],
              summary
            ),
            [scopeKeyOf(null)]: upsertSessionInList(
              state.sessionsByScopeKey[scopeKeyOf(null)] ?? [],
              summary
            ),
          },
        }));
        await refreshRelatedScopes(input.scope ?? summaryScope);
        return detail;
      } catch (error) {
        throw error;
      }
    },
  };
});
