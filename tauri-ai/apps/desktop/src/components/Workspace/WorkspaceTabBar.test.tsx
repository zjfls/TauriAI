import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceTabBar } from './WorkspaceTabBar';
import { useUIStore } from '../../stores/uiStore';
import { useDocumentStore } from '../../stores/documentStore';
import { practiceTabId, useWorkspaceTabStore } from '../../stores/workspaceTabStore';
import { useWindowLayoutStore } from '../../stores/windowLayoutStore';
import type { Agent, AgentSession } from '../../types';

describe('WorkspaceTabBar', () => {
  const createMockSession = (id: string, title: string): AgentSession => ({
    id,
    agentName: 'test-agent',
    title,
    modelRef: 'test-model',
    conversationId: `conv-${id}`,
    apiType: null,
    messages: [],
    streamingBlocks: null,
    isGenerating: false,
    error: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  const createMockAgent = (name: string): Agent => ({
    name,
    displayName: name,
    modelRef: 'test-model',
    description: 'Test agent',
    systemPrompt: 'Test prompt',
    formatType: 'chat',
    reinjectThinking: false,
  });

  const mockSessions: AgentSession[] = [
    createMockSession('session-1', '会话 1'),
    createMockSession('session-2', '会话 2'),
    createMockSession('session-3', '会话 3'),
  ];

  const mockAgents: Agent[] = [createMockAgent('test-agent')];

  beforeEach(() => {
    try {
      localStorage.removeItem('tauri-ai:workspace-tabs:v1');
    } catch {
      // ignore
    }
    useWorkspaceTabStore.setState({ tabOrder: [] });
    useDocumentStore.setState({ documents: [], activeDocumentId: null });
    useWindowLayoutStore.setState({
      panes: [{ id: 'pane-1', tabIds: [], activeTabId: null, weight: 1 }],
      focusedPaneId: 'pane-1',
      lastUserPaneId: 'pane-1',
      lastUserChatPaneId: null,
    } as any);
    useUIStore.setState({ activeView: 'chat' } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('should show context menu when right-clicking on a tab', async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceTabBar
        sessions={mockSessions}
        agents={mockAgents}
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewSession={vi.fn()}
      />
    );

    const sessionTab = screen.getByText('会话 2');
    await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

    await waitFor(() => {
      expect(screen.getByText('关闭当前标签')).toBeInTheDocument();
    });
  });

  it('should open practice as a workspace tab from the view menu', async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceTabBar
        sessions={mockSessions}
        agents={mockAgents}
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewSession={vi.fn()}
        showChatTabs={false}
      />
    );

    await user.click(screen.getByTitle('视图'));
    await user.click(screen.getByText('练习'));

    const practiceId = practiceTabId();
    expect(useWorkspaceTabStore.getState().tabOrder).toContain(practiceId);
    expect(useWindowLayoutStore.getState().panes.some((pane) => pane.tabIds.includes(practiceId))).toBe(true);
    expect(useUIStore.getState().activeView).toBe('chat');
  });


  it('should call onTabClose when clicking "关闭当前标签"', async () => {
    const user = userEvent.setup();
    const onTabClose = vi.fn();

    render(
      <WorkspaceTabBar
        sessions={mockSessions}
        agents={mockAgents}
        onTabClick={vi.fn()}
        onTabClose={onTabClose}
        onNewSession={vi.fn()}
      />
    );

    const sessionTab = screen.getByText('会话 2');
    await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

    await waitFor(() => {
      expect(screen.getByText('关闭当前标签')).toBeInTheDocument();
    });

    await user.click(screen.getByText('关闭当前标签'));

    expect(onTabClose).toHaveBeenCalledWith('session-2');
  });
});
