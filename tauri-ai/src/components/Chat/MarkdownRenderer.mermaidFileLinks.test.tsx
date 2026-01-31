import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkdownRenderer } from './MarkdownRenderer';

const mockInvoke = vi.fn();
const mockOpenOrFocusViewWindow = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue(undefined),
    render: vi.fn().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><a href="src/app.ts:42"><text>Open</text></a></svg>',
    }),
  },
}));

vi.mock('@tauri-apps/api/core', async () => ({
  invoke: mockInvoke,
}));

vi.mock('../../utils/viewWindow', async () => ({
  openOrFocusViewWindow: mockOpenOrFocusViewWindow,
}));

describe('MarkdownRenderer Mermaid file links', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpenOrFocusViewWindow.mockReset();
    (window as any).__TAURI__ = true;
  });

  it('opens workstudio when clicking mermaid <a> href token', async () => {
    mockInvoke.mockResolvedValue({ id: 'ws1', mainFolder: '/tmp' });

    render(
      <MarkdownRenderer
        content={'```mermaid\nflowchart TD\nA[Open]\n```'}
        conversationId="conv1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Open')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Open'));

    await waitFor(() => {
      expect(mockOpenOrFocusViewWindow).toHaveBeenCalledTimes(1);
    });

    expect(mockOpenOrFocusViewWindow).toHaveBeenCalledWith(
      'workstudio',
      expect.any(String),
      expect.objectContaining({
        workstudioId: 'ws1',
        filePath: 'src/app.ts',
        line: 42,
      })
    );
  });
});

