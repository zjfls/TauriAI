import { tauriInvoke as invoke } from '../utils/errorUtils';
import type {
  AgentSessionCommandResult,
  AgentSessionDetail,
  AgentSessionScope,
  AgentSessionSummary,
} from '../types';

interface StartAgentSessionInput {
  scope?: AgentSessionScope;
  agentName: string;
  prompt: string;
  title?: string;
  modelRef?: string;
  runMode?: string;
  thinking?: unknown;
  timeoutMs?: number;
  cwd?: string;
}

interface SendAgentSessionInput {
  sessionId: string;
  prompt: string;
  modelRef?: string;
  runMode?: string;
  thinking?: unknown;
  timeoutMs?: number;
  cwd?: string;
}

export async function listAgentSessions(scope?: AgentSessionScope): Promise<AgentSessionSummary[]> {
  return invoke<AgentSessionSummary[]>('list_agent_sessions', { scope });
}

export async function getAgentSessionDetail(sessionId: string): Promise<AgentSessionDetail> {
  return invoke<AgentSessionDetail>('get_agent_session_detail', { sessionId });
}

export async function startAgentSession(request: StartAgentSessionInput): Promise<AgentSessionCommandResult> {
  return invoke<AgentSessionCommandResult>('start_agent_session', { request });
}

export async function sendAgentSessionMessage(request: SendAgentSessionInput): Promise<AgentSessionCommandResult> {
  return invoke<AgentSessionCommandResult>('send_agent_session_message', { request });
}

export async function closeAgentSession(sessionId: string, deleteSessionDb = false): Promise<AgentSessionDetail> {
  return invoke<AgentSessionDetail>('close_agent_session', { sessionId, deleteSessionDb });
}
