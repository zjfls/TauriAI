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

describe('MarkdownRenderer - Mermaid in <details> blocks', () => {
  it('renders mermaid diagrams inside HTML <details> blocks', async () => {
    const content = `<details open><summary>图</summary>

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

</details>`;

    render(<MarkdownRenderer content={content} />);

    await waitFor(() => {
      expect((mermaid as any).render).toHaveBeenCalled();
    });

    expect(screen.getByTitle('点击放大查看')).toBeTruthy();
  });
});

