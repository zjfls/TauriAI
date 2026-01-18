/**
 * Tests for InputArea placeholder text
 * Requirement 4.4: Placeholder text should reflect supported file types
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InputArea } from './InputArea';

describe('InputArea Placeholder Text', () => {
  it('shows image, text file, and PDF placeholder when supportsVision is true', () => {
    render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const textarea = screen.getByPlaceholderText('输入消息，或粘贴/拖拽图片、文本文件和 PDF...');
    expect(textarea).toBeInTheDocument();
  });

  it('shows text file and PDF placeholder when supportsVision is false', () => {
    render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        supportsVision={false}
      />
    );

    const textarea = screen.getByPlaceholderText('输入消息，或粘贴/拖拽文本文件和 PDF...');
    expect(textarea).toBeInTheDocument();
  });

  it('placeholder does not mention images when supportsVision is false', () => {
    render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        supportsVision={false}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect(textarea).toBeInTheDocument();
    expect(textarea.getAttribute('placeholder')).not.toContain('图片');
  });

  it('placeholder mentions images when supportsVision is true', () => {
    render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect(textarea).toBeInTheDocument();
    expect(textarea.getAttribute('placeholder')).toContain('图片');
  });

  it('placeholder always mentions text files and PDF', () => {
    // Test with supportsVision = true
    const { rerender } = render(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    let textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect(textarea.getAttribute('placeholder')).toContain('文本文件');
    expect(textarea.getAttribute('placeholder')).toContain('PDF');

    // Test with supportsVision = false
    rerender(
      <InputArea
        onSend={() => {}}
        disabled={false}
        isGenerating={false}
        supportsVision={false}
      />
    );

    textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect(textarea.getAttribute('placeholder')).toContain('文本文件');
    expect(textarea.getAttribute('placeholder')).toContain('PDF');
  });
});
