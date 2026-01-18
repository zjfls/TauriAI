/**
 * ThinkingSelector Component Tests
 * Tests for adaptive thinking mode selector
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingSelector } from './ThinkingSelector';
import type { ApiProtocolType, ThinkingMode } from '../../types';

describe('ThinkingSelector', () => {
  describe('Binary Mode (chat_completions)', () => {
    it('renders as toggle button for chat_completions API', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="chat_completions"
          value={true}
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button', { pressed: true });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('思考');
    });

    it('toggles between true and false when clicked', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <ThinkingSelector
          apiProtocol="chat_completions"
          value={true}
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(onChange).toHaveBeenCalledWith(false);

      // Rerender with new value
      rerender(
        <ThinkingSelector
          apiProtocol="chat_completions"
          value={false}
          onChange={onChange}
        />
      );

      fireEvent.click(button);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it('is disabled when disabled prop is true', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="chat_completions"
          value={true}
          onChange={onChange}
          disabled={true}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('Multi-level Mode (responses)', () => {
    it('renders as dropdown button for responses API', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="medium"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button', { expanded: false });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('思考: 中');
    });

    it('opens dropdown menu when clicked', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="medium"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Check if menu is open
      expect(button).toHaveAttribute('aria-expanded', 'true');
      
      // Check if all level options are present (5 levels: null, low, medium, high, xhigh)
      expect(screen.getByRole('menu')).toBeInTheDocument();
      const menuItems = screen.getAllByRole('menuitem');
      expect(menuItems).toHaveLength(5);
    });

    it('displays all thinking levels', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="medium"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByText('无')).toBeInTheDocument();
      expect(screen.getByText('低')).toBeInTheDocument();
      expect(screen.getByText('中')).toBeInTheDocument();
      expect(screen.getByText('高')).toBeInTheDocument();
      expect(screen.getByText('超高')).toBeInTheDocument();
    });

    it('calls onChange with selected level', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="medium"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      const highOption = screen.getByText('高');
      fireEvent.click(highOption);

      expect(onChange).toHaveBeenCalledWith('high');
    });

    it('closes menu after selecting an option', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="medium"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);
      
      const lowOption = screen.getByText('低');
      fireEvent.click(lowOption);

      // Menu should be closed
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('shows checkmark on current level', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="high"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      // The high option should have a checkmark (Check icon)
      const menuItems = screen.getAllByRole('menuitem');
      const highItem = menuItems.find(item => item.textContent?.includes('高'));
      expect(highItem).toBeInTheDocument();
      // Check icon should be present in the high item
      expect(highItem?.querySelector('svg')).toBeInTheDocument();
    });

    it('handles null value (disabled thinking)', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value={null}
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('思考: 无');
    });

    it('is disabled when disabled prop is true', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="medium"
          onChange={onChange}
          disabled={true}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('Styling', () => {
    it('applies active styling when thinking is enabled (binary mode)', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="chat_completions"
          value={true}
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-purple-100', 'text-purple-600');
    });

    it('applies inactive styling when thinking is disabled (binary mode)', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="chat_completions"
          value={false}
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-gray-50', 'text-gray-400');
    });

    it('applies active styling when level is selected (multi-level mode)', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value="high"
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-purple-100', 'text-purple-600');
    });

    it('applies inactive styling when level is null (multi-level mode)', () => {
      const onChange = vi.fn();
      render(
        <ThinkingSelector
          apiProtocol="responses"
          value={null}
          onChange={onChange}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-gray-50', 'text-gray-400');
    });
  });
});
