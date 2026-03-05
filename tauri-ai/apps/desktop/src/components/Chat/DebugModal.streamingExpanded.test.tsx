import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MessageBlock } from '../../types';
import { DebugModal } from './DebugModal';

describe('DebugModal streaming 默认展开', () => {
  afterEach(() => cleanup());

  it('streaming 时默认展开“工具执行”以便查看 ReAct', () => {
    const blocks: MessageBlock[] = [
      {
        id: 'tool-call-1',
        type: 'tool_call',
        callId: 'call_1',
        name: 'my_tool',
        arguments: '{"x":1}',
      },
      {
        id: 'tool-result-1',
        type: 'tool_result',
        callId: 'call_1',
        text: 'ok',
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

    expect(screen.getByText('my_tool')).toBeInTheDocument();
  });

  it('非 streaming（历史加载）时默认停留在“概览”', () => {
    const blocks: MessageBlock[] = [
      {
        id: 'tool-call-1',
        type: 'tool_call',
        callId: 'call_1',
        name: 'my_tool',
        arguments: '{"x":1}',
      },
      {
        id: 'tool-result-1',
        type: 'tool_result',
        callId: 'call_1',
        text: 'ok',
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

    expect(screen.queryByText('my_tool')).toBeNull();
  });
});
