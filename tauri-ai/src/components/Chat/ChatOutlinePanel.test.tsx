import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatOutlinePanel, type ChatOutlineItem } from './ChatOutlinePanel';

describe('ChatOutlinePanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('默认收起，点击后展开显示列表', async () => {
    const user = userEvent.setup();
    const items: ChatOutlineItem[] = [
      { messageId: 'm1', index: 1, preview: '第一条' },
      { messageId: 'm2', index: 2, preview: '第二条' },
    ];
    const fullText: Record<string, string> = { m1: '第一条完整内容', m2: '第二条完整内容' };

    const Wrapper = () => {
      const [open, setOpen] = useState(false);
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <ChatOutlinePanel
          items={items}
          selectedMessageId={selected}
          selectedFullText={selected ? fullText[selected] : null}
          isOpen={open}
          onToggle={() => setOpen((v) => !v)}
          onSelect={(id) => setSelected(id)}
        />
      );
    };

    render(<Wrapper />);
    expect(screen.getByRole('button', { name: '打开消息目录' })).toBeInTheDocument();
    expect(screen.queryByText('目录')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开消息目录' }));
    expect(screen.getByText('目录')).toBeInTheDocument();
    expect(screen.getByText('第一条')).toBeInTheDocument();
  });
});

