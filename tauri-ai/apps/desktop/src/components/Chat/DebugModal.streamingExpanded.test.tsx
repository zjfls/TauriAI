import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MessageBlock } from '../../types';
import { DebugModal } from './DebugModal';

describe('DebugModal streaming 默认展开', () => {
  afterEach(() => cleanup());

  it('streaming 时默认展开“思考过程/工具执行”以便查看 ReAct', () => {
    const blocks: MessageBlock[] = [
      {
        id: 'thinking-1',
        type: 'thinking',
        text: 'hello thinking',
      },
    ];

    render(
      <DebugModal
        isOpen
        onClose={() => {}}
        isStreaming
        debugInfo={null}
        blocks={blocks}
        messageRole="assistant"
      />
    );

    expect(screen.getByText('hello thinking')).toBeInTheDocument();
  });

  it('非 streaming（历史加载）时默认收起“思考过程/工具执行”', () => {
    const blocks: MessageBlock[] = [
      {
        id: 'thinking-1',
        type: 'thinking',
        text: 'hello thinking',
      },
    ];

    render(
      <DebugModal
        isOpen
        onClose={() => {}}
        debugInfo={null}
        blocks={blocks}
        messageRole="assistant"
      />
    );

    expect(screen.queryByText('hello thinking')).toBeNull();
  });
});

