import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ToolCallMessageBlock, ToolResultMessageBlock } from '../../types';

const invokeMock = vi.fn();
const openOrFocusWorkstudioWindowMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../../utils/viewWindow', () => ({
  openOrFocusWorkstudioWindow: (...args: unknown[]) => openOrFocusWorkstudioWindowMock(...args),
}));

import { MessageBlocks } from './MessageBlocks';

describe('MessageBlocks 任务级补丁汇总详情', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openOrFocusWorkstudioWindowMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('支持点击文件行展开/收起该文件 diff 详情', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_diff_commits') {
        return {
          repoRoot: '/repo',
          from: 'ghost-before',
          to: 'ghost-after',
          summary: { filesChanged: 1, insertions: 2, deletions: 1 },
          files: [{ path: 'src/main.ts', status: 'M', added: 2, deleted: 1 }],
          diff: [
            'diff --git a/src/main.ts b/src/main.ts',
            'index 1111111..2222222 100644',
            '--- a/src/main.ts',
            '+++ b/src/main.ts',
            '@@ -1,2 +1,3 @@',
            ' const a = 1',
            '+const b = 2',
            '-console.log(a)',
            '+console.log(a, b)',
          ].join('\n'),
        };
      }
      if (cmd === 'ensure_workstudio_for_conversation') {
        return { id: 'ws-1', mainFolder: '/repo' };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const call: ToolCallMessageBlock = {
      id: 'tool-call-1',
      type: 'tool_call',
      callId: 'call-1',
      name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
      meta: {
        applyPatch: {
          baseDir: '/repo',
          git: {
            repoRoot: '/repo',
            workTree: '/repo',
            ghostBefore: 'ghost-before',
            ghostAfter: 'ghost-after',
            affectedPaths: ['src/main.ts'],
            createdPaths: [],
          },
        },
      },
    };
    const result: ToolResultMessageBlock = {
      id: 'tool-result-1',
      type: 'tool_result',
      callId: 'call-1',
      text: 'OK',
    };

    render(<MessageBlocks blocks={[call, result]} conversationId="conv-1" />);

    await screen.findByText('src/main.ts');
    expect(screen.queryByText('详情：src/main.ts')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /src\/main\.ts/i }));
    await waitFor(() => expect(screen.getByText('详情：src/main.ts')).toBeInTheDocument());
    expect(screen.getByText((text) => text.includes('console.log(a, b)'))).toBeInTheDocument();
    expect(openOrFocusWorkstudioWindowMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /\+console\.log\(a, b\)/i }));
    await waitFor(() =>
      expect(openOrFocusWorkstudioWindowMock).toHaveBeenCalledWith('Workstudio: /repo', {
        workstudioId: 'ws-1',
        mainFolder: '/repo',
        filePath: 'src/main.ts',
        line: 3,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/main\.ts/i }));
    await waitFor(() => expect(screen.queryByText('详情：src/main.ts')).not.toBeInTheDocument());
  });
});
