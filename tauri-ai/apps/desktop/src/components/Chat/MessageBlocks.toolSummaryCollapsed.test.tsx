import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBlocks } from './MessageBlocks';
import type { ApprovalMessageBlock, ToolCallMessageBlock, ToolResultMessageBlock } from '../../types';

describe('MessageBlocks 工具块收起态摘要', () => {
  afterEach(() => {
    cleanup();
  });

  it('ToolRunBlock 收起时也显示 shell_command 的 command', () => {
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

    render(<MessageBlocks blocks={[call, result]} />);
    expect(screen.queryByText('参数')).not.toBeInTheDocument();
    expect(screen.getByText('python --version')).toBeInTheDocument();
  });

  it('ToolCallBlock 收起时也显示 read_file 的 file_path', () => {
    const call: ToolCallMessageBlock = {
      id: 'tool-call-2',
      type: 'tool_call',
      callId: 'call-2',
      name: 'read_file',
      arguments: JSON.stringify({ file_path: 'src/main.ts', offset: 10, limit: 50 }),
    };

    render(<MessageBlocks blocks={[call]} />);
    expect(screen.queryByText('src/main.ts')).toBeInTheDocument();
  });

  it('ApprovalBlock 收起时也显示 exec_command 的 cmd', () => {
    const block: ApprovalMessageBlock = {
      id: 'approval-1',
      type: 'approval',
      requestId: 'req-1',
      callId: 'call-3',
      toolName: 'exec_command',
      arguments: JSON.stringify({ cmd: 'echo ok', timeout_ms: 1000 }),
      status: 'approved',
    };

    render(<MessageBlocks blocks={[block]} conversationId="conv-1" />);
    expect(screen.queryByText('参数')).not.toBeInTheDocument();
    expect(screen.getByText('echo ok')).toBeInTheDocument();
  });
});

