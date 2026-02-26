import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputArea } from './InputArea';

describe('InputArea textarea overlay scroll sync', () => {
  it('在内容变长时保持 overlay 与 textarea 的滚动同步', () => {
    const mockOnSend = vi.fn();
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        disabled={false}
        isGenerating={false}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement;
    const overlay = container.querySelector('div[aria-hidden="true"]') as HTMLDivElement | null;
    const overlayContent = overlay?.firstElementChild as HTMLDivElement | null;
    expect(overlay).toBeTruthy();
    expect(overlayContent).toBeTruthy();

    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    Object.defineProperty(textarea, 'scrollHeight', { value: 2000, configurable: true });
    let textareaScrollTop = 0;
    let textareaScrollLeft = 0;
    Object.defineProperty(textarea, 'scrollTop', {
      configurable: true,
      get: () => textareaScrollTop,
      set: (v) => { textareaScrollTop = Number(v); },
    });
    Object.defineProperty(textarea, 'scrollLeft', {
      configurable: true,
      get: () => textareaScrollLeft,
      set: (v) => { textareaScrollLeft = Number(v); },
    });

    // 固定光标不在末尾，避免触发“末尾自动滚动到底部”的逻辑，便于测试 scroll 同步行为
    Object.defineProperty(textarea, 'selectionStart', {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(textarea, 'selectionEnd', {
      configurable: true,
      get: () => 0,
    });

    const bigText = 'line\n'.repeat(600);
    fireEvent.change(textarea, { target: { value: bigText } });
    expect(overlayContent!.style.transform).toBe('translate3d(0px, 0px, 0)');

    // 模拟“粘贴大量文本后浏览器自动滚动了 textarea，但没有触发 scroll 事件”，导致 overlay 未同步
    textarea.scrollTop = 123;
    expect(textarea.scrollTop).toBe(123);
    expect(overlayContent!.style.transform).toBe('translate3d(0px, 0px, 0)');

    // 下一次输入（内容变化）应自动把 overlay 滚动同步到 textarea 当前滚动位置
    const nextText = bigText + 'more';
    fireEvent.change(textarea, { target: { value: nextText } });

    expect(textarea.scrollTop).toBe(123);
    expect(overlayContent!.style.transform).toBe('translate3d(0px, -123px, 0)');
  });

  it('光标在末尾时自动滚动到底部，避免“输入了但看不到”', () => {
    const mockOnSend = vi.fn();
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        disabled={false}
        isGenerating={false}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement;
    const overlay = container.querySelector('div[aria-hidden="true"]') as HTMLDivElement | null;
    const overlayContent = overlay?.firstElementChild as HTMLDivElement | null;
    expect(overlay).toBeTruthy();
    expect(overlayContent).toBeTruthy();

    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const bigText = 'line\n'.repeat(600);
    Object.defineProperty(textarea, 'scrollHeight', { value: 2000, configurable: true });
    let textareaScrollTop = 0;
    let textareaScrollLeft = 0;
    Object.defineProperty(textarea, 'scrollTop', {
      configurable: true,
      get: () => textareaScrollTop,
      set: (v) => { textareaScrollTop = Number(v); },
    });
    Object.defineProperty(textarea, 'scrollLeft', {
      configurable: true,
      get: () => textareaScrollLeft,
      set: (v) => { textareaScrollLeft = Number(v); },
    });

    // 避免依赖 jsdom 对 selectionStart/End 的实现细节（以及 setSelectionRange 的滚动副作用）
    let selectionStart = bigText.length;
    let selectionEnd = bigText.length;
    Object.defineProperty(textarea, 'selectionStart', {
      configurable: true,
      get: () => selectionStart,
      set: (v) => { selectionStart = Number(v); },
    });
    Object.defineProperty(textarea, 'selectionEnd', {
      configurable: true,
      get: () => selectionEnd,
      set: (v) => { selectionEnd = Number(v); },
    });

    fireEvent.change(textarea, { target: { value: bigText } });

    expect(textarea.scrollTop).toBe(2000);
    expect(overlayContent!.style.transform).toBe('translate3d(0px, -2000px, 0)');

    const nextText = bigText + 'x';
    Object.defineProperty(textarea, 'scrollHeight', { value: 2100, configurable: true });
    selectionStart = nextText.length;
    selectionEnd = nextText.length;
    fireEvent.change(textarea, { target: { value: nextText } });

    expect(overlay!.textContent).toContain('x');
    expect(textarea.scrollTop).toBe(2100);
    expect(overlayContent!.style.transform).toBe('translate3d(0px, -2100px, 0)');
  });
});
