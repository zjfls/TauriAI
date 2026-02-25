import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

import AgentConfigForm from './AgentConfigForm';
import { useConfigStore } from '../../stores/configStore';

describe('AgentConfigForm - 删除确认兼容异步 confirm', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);

    useConfigStore.setState({
      config: {
        appearance: {} as any,
        general: {} as any,
        strictErrorMode: false,
        interceptConsoleError: false,
        tools: { toolsets: [] } as any,
        codeIntelligence: { lspServers: [] } as any,
        mcp: { sets: [] } as any,
        skills: { sets: [] } as any,
        security: { policies: [], defaultPolicy: 'default' } as any,
        providers: [],
        agents: [
          {
            name: 'agent_a',
            enabled: true,
            type: 'chat',
            displayName: '智能体A',
            description: '',
            modelRef: '',
            systemPrompt: '',
            formatType: 'chat',
          },
          {
            name: 'agent_b',
            enabled: true,
            type: 'chat',
            displayName: '智能体B',
            description: '',
            modelRef: '',
            systemPrompt: '',
            formatType: 'chat',
          },
        ],
        defaultAgent: 'agent_a',
      } as any,
      isLoading: false,
      error: null,
    } as any);
  });

  it('confirm 返回 Promise 时，应在确认后才执行删除', async () => {
    render(<AgentConfigForm />);

    // 初始选中第一个 agent（智能体A）
    expect(screen.getAllByText('智能体A').length).toBeGreaterThan(0);

    let resolveConfirm: (value: boolean) => void;
    const confirmPromise = new Promise<boolean>((r) => {
      resolveConfirm = r;
    });

    const originalConfirm = window.confirm;
    const confirmMock = vi.fn(() => confirmPromise as any);
    (window as any).confirm = confirmMock;

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    // 未确认前不应删除
    expect(screen.getAllByText('智能体A').length).toBeGreaterThan(0);

    resolveConfirm!(true);

    await waitFor(() => {
      expect(screen.queryAllByText('智能体A')).toHaveLength(0);
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    (window as any).confirm = originalConfirm;
  });
});
