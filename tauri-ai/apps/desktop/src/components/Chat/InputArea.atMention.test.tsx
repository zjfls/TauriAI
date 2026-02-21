import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InputArea } from './InputArea';

describe('InputArea - @ 文件引用触发规则', () => {
  const workstudio = { id: 'ws-1', mainFolder: '/tmp', folders: [] } as any;

  it('行首输入单个 @ 会打开文件索引面板', async () => {
    render(<InputArea onSend={() => {}} disabled={false} isGenerating={false} workstudio={workstudio} />);

    const textarea = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1, selectionEnd: 1 } });

    await waitFor(() => {
      expect(screen.getByText(/搜索工作区文件/)).toBeInTheDocument();
    });
  });

  it('紧挨着左侧字符的 @ 不应触发文件索引（例如 @@）', async () => {
    render(<InputArea onSend={() => {}} disabled={false} isGenerating={false} workstudio={workstudio} />);

    const textarea = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement;

    // 先触发一次面板
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1, selectionEnd: 1 } });
    await waitFor(() => expect(screen.getByText(/搜索工作区文件/)).toBeInTheDocument());

    // 再输入第二个 @，不应继续触发
    fireEvent.change(textarea, { target: { value: '@@', selectionStart: 2, selectionEnd: 2 } });
    await waitFor(() => {
      expect(screen.queryByText(/搜索工作区文件/)).not.toBeInTheDocument();
    });
  });

  it('a@b 这种中间连接的 @ 不应触发文件索引', async () => {
    render(<InputArea onSend={() => {}} disabled={false} isGenerating={false} workstudio={workstudio} />);

    const textarea = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a@b', selectionStart: 3, selectionEnd: 3 } });

    await waitFor(() => {
      expect(screen.queryByText(/搜索工作区文件/)).not.toBeInTheDocument();
    });
  });
});

