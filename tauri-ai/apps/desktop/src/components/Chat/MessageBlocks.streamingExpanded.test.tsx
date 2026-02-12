import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBlocks } from './MessageBlocks';
import type { ToolCallMessageBlock, ToolResultMessageBlock } from '../../types';

describe('MessageBlocks streaming 默认展开', () => {
  afterEach(() => cleanup());

  it('ToolRunBlock 在 streaming 时默认展开（便于查看 ReAct 过程）', () => {
    const call: ToolCallMessageBlock = {
      id: 'tool-call-1',
      type: 'tool_call',
      callId: 'call-1',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'python --version', timeout_ms: 1000 }),
    };
    const result: ToolResultMessageBlock = {
      id: 'tool-result-1',
      type: 'tool_result',
      callId: 'call-1',
      text: 'Python 3.x',
    };

    render(<MessageBlocks blocks={[call, result]} isStreaming messageSource="live" />);

    expect(screen.getByText('参数')).toBeInTheDocument();
    expect(screen.getByText('输出')).toBeInTheDocument();
  });
});

