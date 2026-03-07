import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InputArea } from './InputArea';

describe('InputArea - overlay token 占位', () => {
  it('workspace mention chip 在 overlay 中保留 raw token 文本占位（避免光标错位）', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const value = `hello @{ref:${id}} world`;

    const { container } = render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        value={value}
        workspaceMentions={[{ id, absPath: '/tmp/foo.ts', label: 'foo.ts' }]}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect((textarea as HTMLTextAreaElement).value).toBe(value);

    const overlay = container.querySelector('div[aria-hidden="true"]') as HTMLDivElement | null;
    expect(overlay).toBeTruthy();
    expect(overlay!.textContent).toContain(`@{ref:${id}}`);
    expect(overlay!.textContent).toContain('foo.ts');
  });

  it('code snippet chip 在 overlay 中保留 raw token 文本占位（避免光标错位）', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const value = `before @{snippet:${id}} after`;

    const { container } = render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        value={value}
        codeSnippets={[
          {
            type: 'code_snippet',
            id,
            label: 'snippet.ts:1:1-2:1',
            text: 'console.log(1);',
            filePath: '/tmp/snippet.ts',
            range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
          },
        ]}
      />
    );

    const overlay = container.querySelector('div[aria-hidden="true"]') as HTMLDivElement | null;
    expect(overlay).toBeTruthy();
    expect(overlay!.textContent).toContain(`@{snippet:${id}}`);
    expect(overlay!.textContent).toContain('snippet.ts:1:1-2:1');
  });

  it('plain $skill 在 overlay 中保留 raw token 占位（避免光标错位）', () => {
    const value = '$skill-forge-quiz 为我生成试题';

    const { container } = render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        value={value}
      />
    );

    const overlay = container.querySelector('div[aria-hidden="true"]') as HTMLDivElement | null;
    expect(overlay).toBeTruthy();
    const transparentSpans = Array.from(overlay!.querySelectorAll('span.text-transparent'));
    expect(transparentSpans.some((span) => span.textContent === '$skill-forge-quiz')).toBe(true);
  });

  it('[$skill](...) 在 overlay 中保留 $skill raw token 占位（避免光标错位）', () => {
    const value = '使用 [$skill-forge-quiz](app://skill-forge-quiz) 生成';

    const { container } = render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        value={value}
      />
    );

    const overlay = container.querySelector('div[aria-hidden="true"]') as HTMLDivElement | null;
    expect(overlay).toBeTruthy();
    const transparentSpans = Array.from(overlay!.querySelectorAll('span.text-transparent'));
    expect(transparentSpans.some((span) => span.textContent === '$skill-forge-quiz')).toBe(true);
    expect(overlay!.textContent).toContain('(app://skill-forge-quiz)');
  });
});
