import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockOpenOrFocusWorkstudioWindow = vi.hoisted(() => vi.fn());

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: async () => undefined,
    render: async () => ({ svg: '' }),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('../../utils/viewWindow', () => ({
  openOrFocusWorkstudioWindow: mockOpenOrFocusWorkstudioWindow,
}));

import { MarkdownRenderer } from './MarkdownRenderer';

describe('MarkdownRenderer - anchor file path links', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpenOrFocusWorkstudioWindow.mockReset();
    (window as any).__TAURI__ = {};
  });

  it('opens workstudio when clicking markdown link href path without line', async () => {
    mockInvoke.mockResolvedValue(null);

    render(<MarkdownRenderer content={'[Open](E:/work/TauriAI/foo.rs)'} workstudioId="ws1" />);

    fireEvent.click(screen.getByText('Open'));

    await waitFor(() => {
      expect(mockOpenOrFocusWorkstudioWindow).toHaveBeenCalledTimes(1);
    });

    expect(mockOpenOrFocusWorkstudioWindow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workstudioId: 'ws1',
        filePath: 'E:/work/TauriAI/foo.rs',
      })
    );
  });
});

