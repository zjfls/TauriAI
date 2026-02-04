import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MessageBlocks } from './MessageBlocks';
import type { ToolCallMessageBlock, ToolResultMessageBlock } from '../../types';

describe('MessageBlocks 工具失败标注', () => {
  afterEach(() => {
    cleanup();
  });

  const renderToolRun = (resultText: string) => {
    const call: ToolCallMessageBlock = {
      id: 'tool-call-1',
      type: 'tool_call',
      callId: 'call-1',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'echo ok' }),
    };
    const result: ToolResultMessageBlock = {
      id: 'tool-result-1',
      type: 'tool_result',
      callId: 'call-1',
      text: resultText,
    };

    render(<MessageBlocks blocks={[call, result]} />);
    const header = screen.getByText('工具：shell_command').closest('div');
    return header?.parentElement;
  };

  it('TOOL_ERROR: 显示失败 badge 并标红', () => {
    const container = renderToolRun('TOOL_ERROR: something bad');
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(container?.className).toContain('border-red-200');
  });

  it('TOOL_DENIED: 显示已拒绝 badge 并标橙', () => {
    const container = renderToolRun('TOOL_DENIED: user denied');
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(container?.className).toContain('border-orange-200');
  });

  it('TOOL_ABORTED: 显示已终止 badge 并标黄', () => {
    const container = renderToolRun('TOOL_ABORTED: user aborted');
    expect(screen.getByText('已终止')).toBeInTheDocument();
    expect(container?.className).toContain('border-yellow-200');
  });

  it('TOOL_RESULT_MISSING: 显示结果缺失 badge 并标红', () => {
    const container = renderToolRun('TOOL_RESULT_MISSING: call-1');
    expect(screen.getByText('结果缺失')).toBeInTheDocument();
    expect(container?.className).toContain('border-red-200');
  });

  it('非零 exit_code 后缀：显示 exit_code badge 并标红', () => {
    const container = renderToolRun('ok\n[exit_code=1]');
    expect(screen.getByText('exit_code=1')).toBeInTheDocument();
    expect(container?.className).toContain('border-red-200');
  });

  it('JSON exit_code：显示 exit_code badge 并标红', () => {
    const container = renderToolRun(JSON.stringify({ exit_code: 2, stdout: '', stderr: 'bad' }));
    expect(screen.getByText('exit_code=2')).toBeInTheDocument();
    expect(container?.className).toContain('border-red-200');
  });

  it('exit_code=0 不应被标注为失败', () => {
    const container = renderToolRun(JSON.stringify({ exit_code: 0, stdout: 'ok', stderr: '' }));
    expect(screen.queryByText(/exit_code=/)).not.toBeInTheDocument();
    expect(screen.queryByText('失败')).not.toBeInTheDocument();
    expect(container?.className).toContain('border-green-200');
  });
});
