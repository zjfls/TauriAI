import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBlocks } from './MessageBlocks';
import { useSessionStore } from '../../stores/sessionStore';
import type { AgentSession, ApprovalMessageBlock } from '../../types';

const createSession = (overrides: Partial<AgentSession>): AgentSession => ({
  id: overrides.id ?? 'session-1',
  agentName: overrides.agentName ?? 'test-agent',
  title: overrides.title ?? '测试会话',
  modelRef: overrides.modelRef ?? 'test-model',
  conversationId: overrides.conversationId ?? 'conv-1',
  workstudioId: overrides.workstudioId,
  apiType: overrides.apiType ?? null,
  messages: overrides.messages ?? [],
  streamingBlocks: overrides.streamingBlocks ?? null,
  isGenerating: overrides.isGenerating ?? false,
  error: overrides.error ?? null,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
  lastActiveAt: overrides.lastActiveAt ?? new Date().toISOString(),
});

const createApprovalBlock = (overrides: Partial<ApprovalMessageBlock>): ApprovalMessageBlock => ({
  id: overrides.id ?? 'block-1',
  type: 'approval',
  requestId: overrides.requestId ?? 'req-1',
  callId: overrides.callId ?? 'call-1',
  toolName: overrides.toolName ?? 'shell_command',
  arguments:
    overrides.arguments ??
    JSON.stringify({
      command: 'ls',
      timeout_ms: 1000,
    }),
  status: overrides.status ?? 'pending',
  securityPolicy: overrides.securityPolicy,
  escalated: overrides.escalated,
  reason: overrides.reason,
  turnId: overrides.turnId,
  turnIndex: overrides.turnIndex,
});

describe('MessageBlocks 审核默认勾选', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), activeSessionId: null } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('存在工作区时默认勾选“项目内允许”', () => {
    const session = createSession({ conversationId: 'conv-1', workstudioId: 'ws-1' });
    useSessionStore.setState({
      sessions: new Map([[session.id, session]]),
      activeSessionId: session.id,
    } as any);

    const block = createApprovalBlock({});
    render(<MessageBlocks blocks={[block]} conversationId="conv-1" />);

    expect(screen.getByRole('checkbox', { name: '项目内允许' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '安全组允许' })).not.toBeChecked();
  });

  it('无工作区时默认勾选“安全组允许”', () => {
    const session = createSession({ conversationId: 'conv-2', workstudioId: null });
    useSessionStore.setState({
      sessions: new Map([[session.id, session]]),
      activeSessionId: session.id,
    } as any);

    const block = createApprovalBlock({ id: 'block-2' });
    render(<MessageBlocks blocks={[block]} conversationId="conv-2" />);

    expect(screen.queryByRole('checkbox', { name: '项目内允许' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: '安全组允许' })).toBeChecked();
  });
});

