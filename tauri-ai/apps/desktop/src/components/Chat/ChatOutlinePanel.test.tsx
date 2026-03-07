import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatOutlinePanel, type ChatOutlineItem } from './ChatOutlinePanel';

describe('ChatOutlinePanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('默认收起，外部切换后显示列表', async () => {
    const user = userEvent.setup();
    const items: ChatOutlineItem[] = [
      { messageId: 'm1', index: 1, preview: 'First request' },
      { messageId: 'm2', index: 2, preview: 'Second request' },
    ];
    const fullText: Record<string, string> = { m1: 'First full text', m2: 'Second full text' };

    const Wrapper = () => {
      const [open, setOpen] = useState(false);
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <div>
          <button type="button" onClick={() => setOpen((v) => !v)}>
            toggle
          </button>
          <ChatOutlinePanel
            items={items}
            selectedMessageId={selected}
            selectedFullText={selected ? fullText[selected] : null}
            isOpen={open}
            displayMode="sidebar"
            onToggle={() => setOpen((v) => !v)}
            onSelect={(id) => setSelected(id)}
          />
        </div>
      );
    };

    render(<Wrapper />);
    expect(screen.queryByText('First request')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByText('First request')).toBeInTheDocument();
  });

  it('overlay 模式显示关闭按钮文案', () => {
    const items: ChatOutlineItem[] = [{ messageId: 'm1', index: 1, preview: 'First request' }];

    render(
      <ChatOutlinePanel
        items={items}
        selectedMessageId="m1"
        selectedFullText="First full text"
        isOpen
        displayMode="overlay"
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: '关闭消息目录' })).toBeInTheDocument();
  });
});
