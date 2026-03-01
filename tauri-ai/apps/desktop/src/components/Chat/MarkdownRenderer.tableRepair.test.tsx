import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: async () => undefined,
    render: async () => ({ svg: '' }),
  },
}));

import { MarkdownRenderer } from './MarkdownRenderer';

describe('MarkdownRenderer - flattened table repair', () => {
  it('should render table when rows are accidentally joined by ||', () => {
    const content = '| 需求 | nohup | PTY ||------|------|------|| 进程后台存活 | ✅ | ✅ || 交互输入 | ❌ | ✅ |';
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('tr').length).toBeGreaterThanOrEqual(3);
  });

  it('should not turn normal logical-or text into table rows', () => {
    const content = '这个表达式是 a || b，不是表格。';
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent || '').toContain('a || b');
  });
});

