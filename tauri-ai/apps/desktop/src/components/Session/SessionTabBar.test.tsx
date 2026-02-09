/**
 * Unit tests for SessionTabBar integration with ContextMenu
 * Requirements: 1.1, 1.2, 1.3, 7.1, 7.2, 7.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionTabBar } from './SessionTabBar';
import type { AgentSession, Agent } from '../../types';

// Mock sessionStore
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: vi.fn((selector) => {
    const mockStore = {
      closeOtherSessions: vi.fn(),
      closeSessionsToLeft: vi.fn(),
      closeSessionsToRight: vi.fn(),
    };
    return selector ? selector(mockStore) : mockStore;
  }),
}));

describe('SessionTabBar - ContextMenu Integration', () => {
  // Helper to create mock sessions
  const createMockSession = (id: string, title: string): AgentSession => ({
    id,
    agentName: 'test-agent',
    title,
    modelRef: 'test-model',
    conversationId: `conv-${id}`,
    apiType: null,
    messages: [],
    streamingMessage: null,
    streamingThinking: null,
    isGenerating: false,
    error: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  // Helper to create mock agents
  const createMockAgent = (name: string): Agent => ({
    name,
    displayName: name,
    modelRef: 'test-model',
    description: 'Test agent',
    systemPrompt: 'Test prompt',
  });

  const mockSessions: AgentSession[] = [
    createMockSession('session-1', '会话 1'),
    createMockSession('session-2', '会话 2'),
    createMockSession('session-3', '会话 3'),
  ];

  const mockAgents: Agent[] = [createMockAgent('test-agent')];

  const defaultProps = {
    sessions: mockSessions,
    activeSessionId: 'session-1',
    agents: mockAgents,
    onTabClick: vi.fn(),
    onTabClose: vi.fn(),
    onNewSession: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Right-click Context Menu Display (Requirement 1.1)', () => {
    it('should show context menu when right-clicking on a session tab', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      // 菜单应该显示
      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });
    });

    it('should not show context menu on left-click', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      const sessionTab = screen.getByText('会话 2');
      await user.click(sessionTab);

      // 菜单不应该显示
      expect(screen.queryByText('关闭其他标签页')).not.toBeInTheDocument();
    });

    it('should show context menu at correct position', async () => {
      const user = userEvent.setup();
      const { container } = render(<SessionTabBar {...defaultProps} />);

      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        const menu = container.querySelector('.fixed');
        expect(menu).toBeInTheDocument();
      });
    });

    it('should show context menu for different session tabs', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 右键点击第一个标签页
      const sessionTab1 = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab1 });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 关闭菜单
      await user.keyboard('{Escape}');

      // 右键点击第三个标签页
      const sessionTab3 = screen.getByText('会话 3');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab3 });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });
    });
  });

  describe('Context Menu Close Behavior (Requirements 1.2, 1.3)', () => {
    it('should close context menu when clicking outside (Requirement 1.2)', async () => {
      const user = userEvent.setup();
      const { container } = render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 等待事件监听器添加
      await new Promise(resolve => setTimeout(resolve, 10));

      // 点击外部区域
      const clickEvent = new MouseEvent('mousedown', { bubbles: true });
      document.body.dispatchEvent(clickEvent);

      // 菜单应该关闭
      await waitFor(() => {
        expect(screen.queryByText('关闭其他标签页')).not.toBeInTheDocument();
      });
    });

    it('should close context menu when pressing Escape (Requirement 1.3)', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 按 Escape 键
      await user.keyboard('{Escape}');

      // 菜单应该关闭
      await waitFor(() => {
        expect(screen.queryByText('关闭其他标签页')).not.toBeInTheDocument();
      });
    });

    it('should close context menu after clicking a menu item', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭当前标签页')).toBeInTheDocument();
      });

      // 点击菜单项
      const menuItem = screen.getByText('关闭当前标签页');
      await user.click(menuItem);

      // 菜单应该关闭
      await waitFor(() => {
        expect(screen.queryByText('关闭当前标签页')).not.toBeInTheDocument();
      });
    });
  });

  describe('Menu Item Actions (Requirements 7.1, 7.2)', () => {
    it('should call closeOtherSessions when clicking "关闭其他标签页"', async () => {
      const user = userEvent.setup();
      const { useSessionStore } = await import('../../stores/sessionStore');
      const mockCloseOthers = vi.fn();
      
      vi.mocked(useSessionStore).mockImplementation((selector: any) => {
        const mockStore = {
          closeOtherSessions: mockCloseOthers,
          closeSessionsToLeft: vi.fn(),
          closeSessionsToRight: vi.fn(),
        };
        return selector ? selector(mockStore) : mockStore;
      });

      render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 点击菜单项
      const menuItem = screen.getByText('关闭其他标签页');
      await user.click(menuItem);

      // 应该调用 closeOtherSessions
      expect(mockCloseOthers).toHaveBeenCalledWith('session-2');
    });

    it('should call closeSessionsToLeft when clicking "关闭左侧标签页"', async () => {
      const user = userEvent.setup();
      const { useSessionStore } = await import('../../stores/sessionStore');
      const mockCloseLeft = vi.fn();
      
      vi.mocked(useSessionStore).mockImplementation((selector: any) => {
        const mockStore = {
          closeOtherSessions: vi.fn(),
          closeSessionsToLeft: mockCloseLeft,
          closeSessionsToRight: vi.fn(),
        };
        return selector ? selector(mockStore) : mockStore;
      });

      render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭左侧标签页')).toBeInTheDocument();
      });

      // 点击菜单项
      const menuItem = screen.getByText('关闭左侧标签页');
      await user.click(menuItem);

      // 应该调用 closeSessionsToLeft
      expect(mockCloseLeft).toHaveBeenCalledWith('session-2');
    });

    it('should call closeSessionsToRight when clicking "关闭右侧标签页"', async () => {
      const user = userEvent.setup();
      const { useSessionStore } = await import('../../stores/sessionStore');
      const mockCloseRight = vi.fn();
      
      vi.mocked(useSessionStore).mockImplementation((selector: any) => {
        const mockStore = {
          closeOtherSessions: vi.fn(),
          closeSessionsToLeft: vi.fn(),
          closeSessionsToRight: mockCloseRight,
        };
        return selector ? selector(mockStore) : mockStore;
      });

      render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭右侧标签页')).toBeInTheDocument();
      });

      // 点击菜单项
      const menuItem = screen.getByText('关闭右侧标签页');
      await user.click(menuItem);

      // 应该调用 closeSessionsToRight
      expect(mockCloseRight).toHaveBeenCalledWith('session-2');
    });

    it('should call onTabClose when clicking "关闭当前标签页"', async () => {
      const user = userEvent.setup();
      const onTabClose = vi.fn();
      
      render(<SessionTabBar {...defaultProps} onTabClose={onTabClose} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭当前标签页')).toBeInTheDocument();
      });

      // 点击菜单项
      const menuItem = screen.getByText('关闭当前标签页');
      await user.click(menuItem);

      // 应该调用 onTabClose
      expect(onTabClose).toHaveBeenCalledWith('session-2');
    });
  });

  describe('Disabled Menu Items (Requirement 7.3)', () => {
    it('should not execute action when clicking disabled menu item', async () => {
      const user = userEvent.setup();
      const { useSessionStore } = await import('../../stores/sessionStore');
      const mockCloseOthers = vi.fn();
      
      vi.mocked(useSessionStore).mockImplementation((selector: any) => {
        const mockStore = {
          closeOtherSessions: mockCloseOthers,
          closeSessionsToLeft: vi.fn(),
          closeSessionsToRight: vi.fn(),
        };
        return selector ? selector(mockStore) : mockStore;
      });

      // 只有一个会话
      const singleSession = [createMockSession('session-1', '会话 1')];
      
      render(<SessionTabBar {...defaultProps} sessions={singleSession} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 点击禁用的菜单项
      const disabledMenuItem = screen.getByText('关闭其他标签页').closest('button');
      expect(disabledMenuItem).toBeDisabled();
      
      await user.click(disabledMenuItem!);

      // 不应该调用操作
      expect(mockCloseOthers).not.toHaveBeenCalled();
    });

    it('should keep menu open when clicking disabled item', async () => {
      const user = userEvent.setup();
      
      // 只有一个会话
      const singleSession = [createMockSession('session-1', '会话 1')];
      
      render(<SessionTabBar {...defaultProps} sessions={singleSession} />);

      // 打开菜单
      const sessionTab = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 点击禁用的菜单项
      const disabledMenuItem = screen.getByText('关闭其他标签页').closest('button');
      await user.click(disabledMenuItem!);

      // 菜单应该保持打开
      expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
    });
  });

  describe('Multiple Sessions Scenarios', () => {
    it('should handle context menu for first session', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 右键点击第一个会话
      const sessionTab = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // "关闭左侧标签页" 应该被禁用
      const closeLeftButton = screen.getByText('关闭左侧标签页').closest('button');
      expect(closeLeftButton).toBeDisabled();

      // "关闭右侧标签页" 应该启用
      const closeRightButton = screen.getByText('关闭右侧标签页').closest('button');
      expect(closeRightButton).not.toBeDisabled();
    });

    it('should handle context menu for last session', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 右键点击最后一个会话
      const sessionTab = screen.getByText('会话 3');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // "关闭左侧标签页" 应该启用
      const closeLeftButton = screen.getByText('关闭左侧标签页').closest('button');
      expect(closeLeftButton).not.toBeDisabled();

      // "关闭右侧标签页" 应该被禁用
      const closeRightButton = screen.getByText('关闭右侧标签页').closest('button');
      expect(closeRightButton).toBeDisabled();
    });

    it('should handle context menu for middle session', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 右键点击中间的会话
      const sessionTab = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 所有菜单项都应该启用
      const closeOthersButton = screen.getByText('关闭其他标签页').closest('button');
      expect(closeOthersButton).not.toBeDisabled();

      const closeLeftButton = screen.getByText('关闭左侧标签页').closest('button');
      expect(closeLeftButton).not.toBeDisabled();

      const closeRightButton = screen.getByText('关闭右侧标签页').closest('button');
      expect(closeRightButton).not.toBeDisabled();

      const closeCurrentButton = screen.getByText('关闭当前标签页').closest('button');
      expect(closeCurrentButton).not.toBeDisabled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid right-clicks on different tabs', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 快速右键点击不同的标签页
      const sessionTab1 = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab1 });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      const sessionTab2 = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab2 });

      // 菜单应该仍然显示
      expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
    });

    it('should handle right-click while menu is already open', async () => {
      const user = userEvent.setup();
      render(<SessionTabBar {...defaultProps} />);

      // 打开菜单
      const sessionTab1 = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab1 });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      // 在另一个标签页上右键点击
      const sessionTab2 = screen.getByText('会话 2');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab2 });

      // 菜单应该更新到新位置
      expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
    });

    it('should not interfere with normal tab click', async () => {
      const user = userEvent.setup();
      const onTabClick = vi.fn();
      
      render(<SessionTabBar {...defaultProps} onTabClick={onTabClick} />);

      // 正常左键点击
      const sessionTab = screen.getByText('会话 2');
      await user.click(sessionTab);

      // 应该调用 onTabClick
      expect(onTabClick).toHaveBeenCalledWith('session-2');

      // 菜单不应该显示
      expect(screen.queryByText('关闭其他标签页')).not.toBeInTheDocument();
    });

    it('should not interfere with close button click', async () => {
      const user = userEvent.setup();
      const onTabClose = vi.fn();
      
      render(<SessionTabBar {...defaultProps} onTabClose={onTabClose} />);

      // 点击关闭按钮
      const closeButtons = screen.getAllByTitle('关闭会话');
      await user.click(closeButtons[1]); // 第二个会话的关闭按钮

      // 应该调用 onTabClose
      expect(onTabClose).toHaveBeenCalledWith('session-2');

      // 菜单不应该显示
      expect(screen.queryByText('关闭其他标签页')).not.toBeInTheDocument();
    });
  });

  describe('Integration with SessionStore', () => {
    it('should pass correct session ID to store methods', async () => {
      const user = userEvent.setup();
      const { useSessionStore } = await import('../../stores/sessionStore');
      const mockCloseOthers = vi.fn();
      const mockCloseLeft = vi.fn();
      const mockCloseRight = vi.fn();
      
      vi.mocked(useSessionStore).mockImplementation((selector: any) => {
        const mockStore = {
          closeOtherSessions: mockCloseOthers,
          closeSessionsToLeft: mockCloseLeft,
          closeSessionsToRight: mockCloseRight,
        };
        return selector ? selector(mockStore) : mockStore;
      });

      render(<SessionTabBar {...defaultProps} />);

      // 测试第一个会话
      const sessionTab1 = screen.getByText('会话 1');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab1 });

      await waitFor(() => {
        expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      });

      await user.click(screen.getByText('关闭其他标签页'));
      expect(mockCloseOthers).toHaveBeenCalledWith('session-1');

      // 关闭菜单
      await user.keyboard('{Escape}');

      // 测试第三个会话
      const sessionTab3 = screen.getByText('会话 3');
      await user.pointer({ keys: '[MouseRight>]', target: sessionTab3 });

      await waitFor(() => {
        expect(screen.getByText('关闭左侧标签页')).toBeInTheDocument();
      });

      await user.click(screen.getByText('关闭左侧标签页'));
      expect(mockCloseLeft).toHaveBeenCalledWith('session-3');
    });
  });
});
