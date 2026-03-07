import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: vi.fn(async () => undefined),
    render: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })),
  },
}));

import mermaid from 'mermaid';
import { MarkdownRenderer } from './MarkdownRenderer';

describe('MarkdownRenderer - streaming Mermaid placeholder', () => {
  it('shows placeholder and skips Mermaid render until fence closes', async () => {
    const { rerender } = render(
      <MarkdownRenderer
        content={['先看图：', '', '```mermaid', 'flowchart TD', '  A --> B'].join('\n')}
        isStreaming
      />
    );

    expect(screen.getByText('图表准备中')).toBeTruthy();
    expect(screen.getByText('先看图：')).toBeTruthy();
    expect((mermaid as any).render).not.toHaveBeenCalled();

    rerender(
      <MarkdownRenderer
        content={['先看图：', '', '```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n')}
        isStreaming
      />
    );

    await waitFor(() => {
      expect((mermaid as any).render).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText('图表准备中')).toBeNull();
    expect(screen.getByTitle('点击放大查看')).toBeTruthy();
  });
});
