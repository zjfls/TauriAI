import { invoke, isTauri } from '@tauri-apps/api/core';
import { useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Workstudio } from '../types';

export const resolveActiveWorkstudioMainFolder = async (): Promise<string | null> => {
  if (!isTauri()) return null;

  const sessionState = useSessionStore.getState();
  const activeSessionId = sessionState.activeSessionId;
  if (!activeSessionId) return null;

  const session = sessionState.sessions.get(activeSessionId) ?? null;
  if (!session) return null;

  const wsId = (session.workstudioId ?? '').trim();
  if (wsId) {
    try {
      const ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId: wsId });
      const main = (ws?.mainFolder ?? '').trim();
      if (main) return main;
    } catch {
      // ignore
    }
  }

  const convId = (session.conversationId ?? '').trim();
  if (!convId) return null;

  const agent = useConfigStore.getState().getAgent(session.agentName);
  const workspaceEnabled = (agent?.type ?? 'chat') === 'tool' && (agent?.workspaceSupport ?? true);
  if (!workspaceEnabled) return null;

  try {
    const ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId: convId });
    const main = (ws?.mainFolder ?? '').trim();
    return main || null;
  } catch {
    return null;
  }
};

