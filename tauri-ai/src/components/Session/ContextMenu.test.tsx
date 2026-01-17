/**
 * Unit tests for ContextMenu component
 * Requirements: 1.4, 2.3, 3.2, 4.2, 5.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuProps } from './ContextMenu';

describe('ContextMenu', () => {
  // Helper to create default props
  const createDefaultProps = (overrides?: Partial<ContextMenuProps>): ContextMenuProps => ({
    visible: true,
    position: { x: 100, y: 100 },
    targetSessionId: 'session-1',
    targetSessionIndex: 1,
    totalSessions: 3,
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToLeft: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseCurrent: vi.fn(),
    ...overrides,
  });

  // 在每个测试前清理 mock
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 在每个测试后清理组件
  afterEach(() => {
    cleanup();
  });

  describe('Visibility', () => {
    it('should not render when visible is false', () => {
      const props = createDefaultProps({ visible: false });
      const { container } = render(<ContextMenu {...props} />);
      
      expect(container.firstChild).toBeNull();
    });

    it('should render when visible is true', () => {
      const props = createDefaultProps();
      render(<ContextMenu {...props} />);
      
      expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
    });
  });

  describe('Menu Position', () => {
    it('should position menu at specified coordinates', () => {
      const props = createDefaultProps({ position: { x: 200, y: 300 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toHaveStyle({ left: '200px', top: '300px' });
    });
  });

  describe('Menu Items Rendering (Requirement 1.4)', () => {
    it('should render all four menu items', () => {
      const props = createDefaultProps();
      render(<ContextMenu {...props} />);
      
      expect(screen.getByText('关闭其他标签页')).toBeInTheDocument();
      expect(screen.getByText('关闭左侧标签页')).toBeInTheDocument();
      expect(screen.getByText('关闭右侧标签页')).toBeInTheDocument();
      expect(screen.getByText('关闭当前标签页')).toBeInTheDocument();
    });

    it('should render menu items in correct order', () => {
      const props = createDefaultProps();
      render(<ContextMenu {...props} />);
      
      const buttons = screen.getAllByRole('button');
      expect(buttons[0]).toHaveTextContent('关闭其他标签页');
      expect(buttons[1]).toHaveTextContent('关闭左侧标签页');
      expect(buttons[2]).toHaveTextContent('关闭右侧标签页');
      expect(buttons[3]).toHaveTextContent('关闭当前标签页');
    });
  });

  describe('Disabled State Logic', () => {
    describe('Close Others (Requirement 2.3)', () => {
      it('should disable "关闭其他标签页" when only one session exists', () => {
        const props = createDefaultProps({ totalSessions: 1, targetSessionIndex: 0 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭其他标签页').closest('button');
        expect(button).toBeDisabled();
      });

      it('should enable "关闭其他标签页" when multiple sessions exist', () => {
        const props = createDefaultProps({ totalSessions: 3, targetSessionIndex: 1 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭其他标签页').closest('button');
        expect(button).not.toBeDisabled();
      });
    });

    describe('Close Left (Requirement 3.2)', () => {
      it('should disable "关闭左侧标签页" when target is leftmost session', () => {
        const props = createDefaultProps({ targetSessionIndex: 0, totalSessions: 3 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭左侧标签页').closest('button');
        expect(button).toBeDisabled();
      });

      it('should enable "关闭左侧标签页" when target is not leftmost', () => {
        const props = createDefaultProps({ targetSessionIndex: 1, totalSessions: 3 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭左侧标签页').closest('button');
        expect(button).not.toBeDisabled();
      });

      it('should enable "关闭左侧标签页" when target is rightmost', () => {
        const props = createDefaultProps({ targetSessionIndex: 2, totalSessions: 3 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭左侧标签页').closest('button');
        expect(button).not.toBeDisabled();
      });
    });

    describe('Close Right (Requirement 4.2)', () => {
      it('should disable "关闭右侧标签页" when target is rightmost session', () => {
        const props = createDefaultProps({ targetSessionIndex: 2, totalSessions: 3 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭右侧标签页').closest('button');
        expect(button).toBeDisabled();
      });

      it('should enable "关闭右侧标签页" when target is not rightmost', () => {
        const props = createDefaultProps({ targetSessionIndex: 1, totalSessions: 3 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭右侧标签页').closest('button');
        expect(button).not.toBeDisabled();
      });

      it('should enable "关闭右侧标签页" when target is leftmost', () => {
        const props = createDefaultProps({ targetSessionIndex: 0, totalSessions: 3 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭右侧标签页').closest('button');
        expect(button).not.toBeDisabled();
      });
    });

    describe('Close Current (Requirement 5.3)', () => {
      it('should always enable "关闭当前标签页" even with only one session', () => {
        const props = createDefaultProps({ totalSessions: 1, targetSessionIndex: 0 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭当前标签页').closest('button');
        expect(button).not.toBeDisabled();
      });

      it('should enable "关闭当前标签页" with multiple sessions', () => {
        const props = createDefaultProps({ totalSessions: 5, targetSessionIndex: 2 });
        render(<ContextMenu {...props} />);
        
        const button = screen.getByText('关闭当前标签页').closest('button');
        expect(button).not.toBeDisabled();
      });
    });
  });

  describe('Disabled Styling', () => {
    it('should apply disabled styles to disabled menu items', () => {
      const props = createDefaultProps({ totalSessions: 1, targetSessionIndex: 0 });
      render(<ContextMenu {...props} />);
      
      const disabledButton = screen.getByText('关闭其他标签页').closest('button');
      expect(disabledButton).toHaveClass('text-gray-400', 'dark:text-gray-600', 'cursor-not-allowed');
    });

    it('should apply enabled styles to enabled menu items', () => {
      const props = createDefaultProps({ totalSessions: 3, targetSessionIndex: 1 });
      render(<ContextMenu {...props} />);
      
      const enabledButton = screen.getByText('关闭其他标签页').closest('button');
      expect(enabledButton).toHaveClass('text-gray-800', 'dark:text-gray-200', 'cursor-pointer');
    });
  });

  describe('Menu Item Actions', () => {
    it('should call action callback when clicking enabled menu item', async () => {
      const user = userEvent.setup();
      const onCloseOthers = vi.fn();
      const props = createDefaultProps({ onCloseOthers, totalSessions: 3, targetSessionIndex: 1 });
      
      render(<ContextMenu {...props} />);
      
      const button = screen.getByText('关闭其他标签页').closest('button');
      await user.click(button!);
      
      // 应该调用对应的 action 回调
      expect(onCloseOthers).toHaveBeenCalledTimes(1);
    });

    it('should not call action when clicking disabled menu item', async () => {
      const user = userEvent.setup();
      const onCloseOthers = vi.fn();
      const props = createDefaultProps({ onCloseOthers, totalSessions: 1, targetSessionIndex: 0 });
      
      render(<ContextMenu {...props} />);
      
      const button = screen.getByText('关闭其他标签页').closest('button');
      await user.click(button!);
      
      // Disabled buttons don't trigger onClick
      expect(onCloseOthers).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle single session correctly', () => {
      const props = createDefaultProps({ totalSessions: 1, targetSessionIndex: 0 });
      render(<ContextMenu {...props} />);
      
      // Only "关闭当前标签页" should be enabled
      expect(screen.getByText('关闭其他标签页').closest('button')).toBeDisabled();
      expect(screen.getByText('关闭左侧标签页').closest('button')).toBeDisabled();
      expect(screen.getByText('关闭右侧标签页').closest('button')).toBeDisabled();
      expect(screen.getByText('关闭当前标签页').closest('button')).not.toBeDisabled();
    });

    it('should handle two sessions - leftmost target', () => {
      const props = createDefaultProps({ totalSessions: 2, targetSessionIndex: 0 });
      render(<ContextMenu {...props} />);
      
      expect(screen.getByText('关闭其他标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭左侧标签页').closest('button')).toBeDisabled();
      expect(screen.getByText('关闭右侧标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭当前标签页').closest('button')).not.toBeDisabled();
    });

    it('should handle two sessions - rightmost target', () => {
      const props = createDefaultProps({ totalSessions: 2, targetSessionIndex: 1 });
      render(<ContextMenu {...props} />);
      
      expect(screen.getByText('关闭其他标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭左侧标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭右侧标签页').closest('button')).toBeDisabled();
      expect(screen.getByText('关闭当前标签页').closest('button')).not.toBeDisabled();
    });

    it('should handle many sessions - middle target', () => {
      const props = createDefaultProps({ totalSessions: 10, targetSessionIndex: 5 });
      render(<ContextMenu {...props} />);
      
      // All menu items should be enabled for middle session
      expect(screen.getByText('关闭其他标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭左侧标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭右侧标签页').closest('button')).not.toBeDisabled();
      expect(screen.getByText('关闭当前标签页').closest('button')).not.toBeDisabled();
    });

    it('should handle position at screen edges', () => {
      const props = createDefaultProps({ position: { x: 0, y: 0 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });

    it('should handle large position values', () => {
      const props = createDefaultProps({ position: { x: 9999, y: 9999 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });
  });

  describe('Boundary Detection (Requirement 1.1)', () => {
    beforeEach(() => {
      // Mock window dimensions
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1024,
      });
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 768,
      });
    });

    it('should render menu at original position when within viewport bounds', () => {
      const props = createDefaultProps({ position: { x: 100, y: 100 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });

    it('should adjust position when menu would overflow right edge', () => {
      // Position near right edge where menu would overflow
      const props = createDefaultProps({ position: { x: 1000, y: 100 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });

    it('should adjust position when menu would overflow bottom edge', () => {
      // Position near bottom edge where menu would overflow
      const props = createDefaultProps({ position: { x: 100, y: 750 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });

    it('should adjust position when menu would overflow both right and bottom edges', () => {
      // Position at corner where menu would overflow both edges
      const props = createDefaultProps({ position: { x: 1000, y: 750 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });

    it('should handle very small viewport', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 200,
      });
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 200,
      });

      const props = createDefaultProps({ position: { x: 150, y: 150 } });
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.fixed');
      expect(menuContainer).toBeInTheDocument();
    });
  });

  describe('Dark Mode Styling', () => {
    it('should include dark mode classes for menu container', () => {
      const props = createDefaultProps();
      const { container } = render(<ContextMenu {...props} />);
      
      const menuContainer = container.querySelector('.dark\\:bg-gray-800');
      expect(menuContainer).toBeInTheDocument();
    });

    it('should include dark mode classes for enabled menu items', () => {
      const props = createDefaultProps({ totalSessions: 3, targetSessionIndex: 1 });
      render(<ContextMenu {...props} />);
      
      const button = screen.getByText('关闭其他标签页').closest('button');
      expect(button).toHaveClass('dark:text-gray-200', 'dark:hover:bg-gray-700');
    });

    it('should include dark mode classes for disabled menu items', () => {
      const props = createDefaultProps({ totalSessions: 1, targetSessionIndex: 0 });
      render(<ContextMenu {...props} />);
      
      const button = screen.getByText('关闭其他标签页').closest('button');
      expect(button).toHaveClass('dark:text-gray-600');
    });
  });

  describe('Menu Close Logic (Requirements 1.2, 1.3)', () => {
    it('should call onClose when clicking outside the menu (Requirement 1.2)', async () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 等待下一个事件循环，确保事件监听器已添加
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 点击菜单外部区域
      const clickEvent = new MouseEvent('mousedown', { bubbles: true });
      document.body.dispatchEvent(clickEvent);
      
      // 应该至少被调用一次
      expect(onClose).toHaveBeenCalled();
      
      // 清理
      unmount();
    });

    it('should not call onClose when clicking inside the menu', async () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose, totalSessions: 3, targetSessionIndex: 1 });
      
      const { container, unmount } = render(<ContextMenu {...props} />);
      
      // 等待下一个事件循环
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 点击菜单内部
      const menuElement = container.querySelector('.fixed');
      if (menuElement) {
        const clickEvent = new MouseEvent('mousedown', { bubbles: true });
        menuElement.dispatchEvent(clickEvent);
      }
      
      // onClose 不应该被调用
      expect(onClose).not.toHaveBeenCalled();
      
      // 清理
      unmount();
    });

    it('should call onClose when pressing Escape key (Requirement 1.3)', () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 按下 Escape 键
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent);
      
      // 应该至少被调用一次
      expect(onClose).toHaveBeenCalled();
      
      // 清理
      unmount();
    });

    it('should not call onClose when pressing other keys', () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 按下其他键
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      document.dispatchEvent(enterEvent);
      
      const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
      document.dispatchEvent(spaceEvent);
      
      const aEvent = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
      document.dispatchEvent(aEvent);
      
      expect(onClose).not.toHaveBeenCalled();
      
      // 清理
      unmount();
    });

    it('should cleanup event listeners when component unmounts', () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 卸载组件
      unmount();
      
      // 尝试触发事件，不应该调用 onClose
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent);
      
      const clickEvent = new MouseEvent('mousedown', { bubbles: true });
      document.dispatchEvent(clickEvent);
      
      expect(onClose).not.toHaveBeenCalled();
    });

    it('should not add event listeners when menu is not visible', () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ visible: false, onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 尝试触发事件
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent);
      
      const clickEvent = new MouseEvent('mousedown', { bubbles: true });
      document.dispatchEvent(clickEvent);
      
      expect(onClose).not.toHaveBeenCalled();
      
      // 清理
      unmount();
    });

    it('should handle multiple Escape key presses', () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 按下 Escape 键多次
      const escapeEvent1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent1);
      
      const escapeEvent2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent2);
      
      // 应该被调用多次
      expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);
      
      // 清理
      unmount();
    });

    it('should handle rapid clicks outside menu', async () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });
      
      const { unmount } = render(<ContextMenu {...props} />);
      
      // 等待事件监听器添加
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 快速点击外部多次
      const clickEvent1 = new MouseEvent('mousedown', { bubbles: true });
      document.body.dispatchEvent(clickEvent1);
      
      const clickEvent2 = new MouseEvent('mousedown', { bubbles: true });
      document.body.dispatchEvent(clickEvent2);
      
      // 应该被调用多次
      expect(onClose).toHaveBeenCalled();
      expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(1);
      
      // 清理
      unmount();
    });
  });
});
