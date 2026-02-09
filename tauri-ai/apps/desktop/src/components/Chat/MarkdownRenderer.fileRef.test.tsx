import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: async () => undefined,
    render: async () => ({ svg: '' }),
  },
}));

import { MarkdownRenderer } from './MarkdownRenderer';

describe('MarkdownRenderer - File reference buttons', () => {
  const originalTauri = (globalThis as any).window?.__TAURI__;

  beforeEach(() => {
    (window as any).__TAURI__ = {};
  });

  afterEach(() => {
    (window as any).__TAURI__ = originalTauri;
  });

  it('renders file refs as buttons inside tables when workstudioId is provided', () => {
    const content = `
| 事件 | 代码位置 | 触发场景 |
|---|---|---|
| \`RunEvent::Done\` | \`events.rs:96\` | Task 成功 |
`;

    render(<MarkdownRenderer content={content} workstudioId="ws-1" />);

    expect(screen.getByRole('button', { name: 'events.rs:96' })).toBeTruthy();
  });
});

