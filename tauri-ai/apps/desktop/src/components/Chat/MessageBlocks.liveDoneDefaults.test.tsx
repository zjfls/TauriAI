import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBlocks } from './MessageBlocks';
import type { ToolCallMessageBlock, ToolResultMessageBlock } from '../../types';

describe('MessageBlocks live（非 streaming）默认行为', () => {
  afterEach(() => cleanup());

  it('stream 完成后：默认收起每个 turn 的 block，但 task（多 turn）整体不收起', () => {
    const call1: ToolCallMessageBlock = {
      id: 'tool-call-1',
      type: 'tool_call',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'python --version', timeout_ms: 1000 }),
    };
    const result1: ToolResultMessageBlock = {
      id: 'tool-result-1',
      type: 'tool_result',
      turnId: 'turn-1',
      callId: 'call-1',
      text: 'Python 3.x',
    };
    const call2: ToolCallMessageBlock = {
      id: 'tool-call-2',
      type: 'tool_call',
      turnId: 'turn-2',
      callId: 'call-2',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'node --version', timeout_ms: 1000 }),
    };
    const result2: ToolResultMessageBlock = {
      id: 'tool-result-2',
      type: 'tool_result',
      turnId: 'turn-2',
      callId: 'call-2',
      text: 'v20.x',
    };

    render(<MessageBlocks blocks={[call1, result1, call2, result2]} messageSource="live" />);

    // task（多 turn）不收起：两个 turn 的 header 都存在（header 的 title 就是 turnId）
    expect(screen.getByTitle('turn-1')).toBeInTheDocument();
    expect(screen.getByTitle('turn-2')).toBeInTheDocument();

    // 每个 turn 的细节 block 默认收起：不显示“参数/输出”等细节标签，但仍可见摘要（如 command）
    expect(screen.queryByText('参数')).not.toBeInTheDocument();
    expect(screen.getByText('python --version')).toBeInTheDocument();
    expect(screen.getByText('node --version')).toBeInTheDocument();
  });
});

