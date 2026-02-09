import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Mermaid is initialized at module import time in MarkdownRenderer; mock it to keep this test
// focused on markdown/math behavior and avoid DOM/environment pitfalls.
vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: async () => undefined,
    render: async () => ({ svg: '' }),
  },
}));

import { MarkdownRenderer } from './MarkdownRenderer';

describe('MarkdownRenderer - Math fences', () => {
  it('renders display math with newlines inside cases', () => {
    const content = `$$
F_y(\\alpha)=\\begin{cases}
- a\\\\[8pt]-a\\end{cases}
$$`;

    const { container } = render(<MarkdownRenderer content={content} />);

    // When $$ fences are preserved, remark-math + rehype-katex should produce KaTeX display output.
    expect(container.querySelector('.katex-display')).not.toBeNull();

    // Regression: when $$ accidentally becomes $, markdown may interpret "- " as a list item.
    expect(container.querySelector('ul')).toBeNull();
  });
});

