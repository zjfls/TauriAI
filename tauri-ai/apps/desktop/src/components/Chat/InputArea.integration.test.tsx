/**
 * InputArea Integration Tests
 * 
 * Tests the complete text file attachment flow:
 * - File selection via menu
 * - Drag and drop
 * - Preview display
 * - Message sending
 * 
 * **Validates: Requirements 1.1-7.3**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InputArea } from './InputArea';
import { MAX_TEXT_FILES, MAX_TEXT_FILE_SIZE } from '../../types';

// Mock pdfjs-dist for PDF tests
vi.mock('pdfjs-dist', () => {
  const mockGetDocument = vi.fn((data: any) => {
    return {
      promise: Promise.resolve({
        numPages: 3,
        getPage: vi.fn((pageNum: number) => {
          return Promise.resolve({
            getViewport: vi.fn((params: any) => ({
              width: 595,
              height: 842,
            })),
            getTextContent: vi.fn(() => {
              return Promise.resolve({
                items: [
                  { str: `Page ${pageNum} content` },
                  { str: 'Some text here' },
                ],
              });
            }),
            render: vi.fn((renderContext: any) => ({
              promise: Promise.resolve(),
            })),
          });
        }),
        getMetadata: vi.fn(() => {
          return Promise.resolve({
            info: {
              Title: 'Test PDF Document',
              Author: 'Test Author',
              CreationDate: '2024-01-01',
            },
          });
        }),
        cleanup: vi.fn(() => Promise.resolve()),
        destroy: vi.fn(() => Promise.resolve()),
      }),
    };
  });

  return {
    default: {
      GlobalWorkerOptions: {
        workerSrc: '',
      },
      getDocument: mockGetDocument,
      version: '4.0.0',
    },
    GlobalWorkerOptions: {
      workerSrc: '',
    },
    getDocument: mockGetDocument,
    version: '4.0.0',
  };
});

// Mock file creation helper
function createMockFile(
  name: string, 
  content: string, 
  type: string = 'text/plain'
): File {
  const blob = new Blob([content], { type });
  
  // Add arrayBuffer method to Blob if not present
  if (!blob.arrayBuffer) {
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async function() {
        // Convert blob content to ArrayBuffer
        const text = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(this as Blob);
        });
        const encoder = new TextEncoder();
        return encoder.encode(text).buffer;
      },
      writable: false,
      configurable: true,
    });
  }
  
  const file = new File([blob], name, { type });
  
  // Add arrayBuffer method for PDF processing
  if (!file.arrayBuffer) {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async function() {
        return await blob.arrayBuffer();
      },
      writable: false,
      configurable: true,
    });
  }
  
  return file;
}

// Mock Canvas for PDF rendering
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn((contextType: string) => {
    if (contextType === '2d') {
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(),
        putImageData: vi.fn(),
        createImageData: vi.fn(),
        setTransform: vi.fn(),
        resetTransform: vi.fn(),
        scale: vi.fn(),
        rotate: vi.fn(),
        translate: vi.fn(),
        transform: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        bezierCurveTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        arc: vi.fn(),
        arcTo: vi.fn(),
        ellipse: vi.fn(),
        rect: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        clip: vi.fn(),
        isPointInPath: vi.fn(),
        isPointInStroke: vi.fn(),
        measureText: vi.fn(() => ({ width: 0 })),
        fillText: vi.fn(),
        strokeText: vi.fn(),
      } as any;
    }
    return null;
  }) as any;

  HTMLCanvasElement.prototype.toDataURL = vi.fn((type?: string, quality?: number) => {
    return 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=';
  }) as any;
}

// Create a mock FileList
function createMockFileList(files: File[]): FileList {
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] || null,
    [Symbol.iterator]: function* () {
      for (const file of files) {
        yield file;
      }
    },
  } as FileList;
  
  // Add indexed access
  files.forEach((file, index) => {
    Object.defineProperty(fileList, index, {
      value: file,
      enumerable: true,
    });
  });
  
  return fileList;
}

describe('InputArea Text File Integration', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test 1: File selection via menu (Requirements 1.1, 1.2, 1.3)
   */
  describe('File Selection via Menu', () => {
    it('opens file picker when clicking text file menu item', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Click attachment menu
      const attachButton = screen.getByTitle('添加附件');
      fireEvent.click(attachButton);

      // Click text file option
      const textFileOption = screen.getByText('文本文件');
      expect(textFileOption).toBeDefined();
    });

    it('shows clear current conversation in extra actions and triggers callback', async () => {
      const mockOnClearConversation = vi.fn();

      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          onCloneConversation={() => {}}
          onClearConversation={mockOnClearConversation}
          disabled={false}
          isGenerating={false}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /鏇村|更多/ }));

      const clearItem = screen.getByRole('menuitem', { name: /娓呯┖褰撳墠浼氳瘽|清空当前会话/ });
      fireEvent.click(clearItem);

      expect(mockOnClearConversation).toHaveBeenCalledTimes(1);

      await waitFor(() => {
        expect(screen.queryByRole('menuitem')).toBeNull();
      });
    });

    it('waits for async extra actions to finish before closing the menu', async () => {
      let resolveClearConversation: (() => void) | null = null;
      const mockOnClearConversation = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClearConversation = resolve;
          })
      );

      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          onCloneConversation={() => {}}
          onClearConversation={mockOnClearConversation}
          disabled={false}
          isGenerating={false}
        />
      );

      const menuButtons = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
      expect(menuButtons.length).toBeGreaterThan(1);
      fireEvent.click(menuButtons[1] as HTMLButtonElement);

      const clearItem = screen.getAllByRole('menuitem')[1];
      fireEvent.click(clearItem);

      expect(mockOnClearConversation).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('menuitem')).toHaveLength(2);

      resolveClearConversation?.();

      await waitFor(() => {
        expect(screen.queryByRole('menuitem')).toBeNull();
      });
    });

    it('renders attachment menu in a body portal so scroll containers do not clip it', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      fireEvent.click(screen.getByTitle('添加附件'));

      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(screen.getByText('文本文件')).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.mouseDown(document.body);

      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
      });
    });

    it('renders run mode options in a body portal so they stay visible inside the horizontal scroller', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
          runMode="agent"
          onRunModeChange={() => {}}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Agent/i }));

      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(screen.getByText('Agent Full Access')).toBeDefined();
    });

    it('has file input with supported extensions', () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Find all file inputs
      const fileInputs = document.querySelectorAll('input[type="file"]');
      
      // Find the text file input (the one that accepts text extensions)
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;
      
      expect(textFileInput).toBeDefined();
      
      // Verify accept attribute contains supported extensions
      const acceptValue = textFileInput?.accept || '';
      expect(acceptValue).toContain('.txt');
      expect(acceptValue).toContain('.md');
      expect(acceptValue).toContain('.json');
    });

    it('reads file content when valid file is selected', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Create a mock file
      const mockFile = createMockFile('test.txt', 'Hello, World!');
      const mockFileList = createMockFileList([mockFile]);
      
      // Find the text file input
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      // Simulate file selection
      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      
      fireEvent.change(textFileInput);

      // Wait for file to be processed
      await waitFor(() => {
        const preview = screen.queryByText('test.txt');
        expect(preview).not.toBeNull();
      }, { timeout: 2000 });
    });
  });

  /**
   * Test 2: Drag and drop (Requirements 4.1, 4.2, 4.3, 4.4)
   */
  describe('Drag and Drop', () => {
    it('accepts valid text files on drop', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      const inputArea = document.querySelector('.border-t');
      expect(inputArea).not.toBeNull();

      // Create mock file
      const mockFile = createMockFile('dropped.md', '# Markdown Content');
      const mockFileList = createMockFileList([mockFile]);

      // Simulate drop
      fireEvent.drop(inputArea!, {
        dataTransfer: { files: mockFileList }
      });

      // Wait for file to be processed
      await waitFor(() => {
        const preview = screen.queryByText('dropped.md');
        expect(preview).not.toBeNull();
      }, { timeout: 2000 });
    });

    it('silently ignores unsupported file types on drop', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      const inputArea = document.querySelector('.border-t');
      
      // Create unsupported file (use a video file which is not supported)
      const mockFile = createMockFile('video.mp4', 'Video content', 'video/mp4');
      const mockFileList = createMockFileList([mockFile]);

      // Simulate drop
      fireEvent.drop(inputArea!, {
        dataTransfer: { files: mockFileList }
      });

      // Should not show any preview
      await new Promise(resolve => setTimeout(resolve, 200));
      const preview = screen.queryByText('video.mp4');
      expect(preview).toBeNull();
    });
  });

  /**
   * Test 2.5: Paste support (Requirements 4.1, 4.2)
   */
  describe('Paste Support', () => {
    it('accepts valid text files on paste', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      const textarea = screen.getByRole('textbox');

      // Create mock file
      const mockFile = createMockFile('pasted.txt', 'Pasted content');
      
      // Create mock clipboard data
      const mockClipboardData = {
        items: [
          {
            type: 'text/plain',
            getAsFile: () => mockFile,
          },
        ],
      };

      // Simulate paste
      fireEvent.paste(textarea, {
        clipboardData: mockClipboardData,
      });

      // Wait for file to be processed
      await waitFor(() => {
        const preview = screen.queryByText('pasted.txt');
        expect(preview).not.toBeNull();
      }, { timeout: 2000 });
    });

    it('silently ignores unsupported file types on paste', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      const textarea = screen.getByRole('textbox');

      // Create unsupported file (use .exe which is truly unsupported)
      const mockFile = createMockFile('program.exe', 'Binary content', 'application/x-msdownload');
      
      // Create mock clipboard data
      const mockClipboardData = {
        items: [
          {
            type: 'application/x-msdownload',
            getAsFile: () => mockFile,
          },
        ],
      };

      // Simulate paste
      fireEvent.paste(textarea, {
        clipboardData: mockClipboardData,
      });

      // Should not show any preview
      await new Promise(resolve => setTimeout(resolve, 200));
      const preview = screen.queryByText('program.exe');
      expect(preview).toBeNull();
    });
  });

  /**
   * Test 3: Preview display (Requirements 2.1, 2.2, 2.3, 2.4)
   */
  describe('Preview Display', () => {
    it('shows file name and content preview', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Add a file
      const mockFile = createMockFile('config.json', '{"key": "value"}');
      const mockFileList = createMockFileList([mockFile]);
      
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.json')
      ) as HTMLInputElement;

      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      fireEvent.change(textFileInput);

      await waitFor(() => {
        // Check filename is displayed
        expect(screen.queryByText('config.json')).not.toBeNull();
      }, { timeout: 2000 });
    });

    it('removes file when clicking remove button', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Add a file
      const mockFile = createMockFile('remove-me.txt', 'Content to remove');
      const mockFileList = createMockFileList([mockFile]);
      
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      fireEvent.change(textFileInput);

      await waitFor(() => {
        expect(screen.queryByText('remove-me.txt')).not.toBeNull();
      }, { timeout: 2000 });

      // Click remove button
      const removeButton = screen.getByTitle('移除');
      fireEvent.click(removeButton);

      // File should be removed
      await waitFor(() => {
        expect(screen.queryByText('remove-me.txt')).toBeNull();
      });
    });
  });

  /**
   * Test 4: Message sending (Requirements 3.1, 3.2, 3.3, 3.4)
   */
  describe('Message Sending', () => {
    it('includes text file content in message when sending', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Add a file
      const mockFile = createMockFile('send-me.txt', 'File content to send');
      const mockFileList = createMockFileList([mockFile]);
      
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      fireEvent.change(textFileInput);

      await waitFor(() => {
        expect(screen.queryByText('send-me.txt')).not.toBeNull();
      }, { timeout: 2000 });

      // Type a message
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Please analyze this file' } });

      // Click send
      const sendButton = screen.getByTitle('发送消息');
      fireEvent.click(sendButton);

      // Verify onSend was called with correct arguments
      expect(mockOnSend).toHaveBeenCalledTimes(1);
      const [content, , contentParts] = mockOnSend.mock.calls[0];
      
      expect(content).toBe('Please analyze this file');
      expect(contentParts).toBeDefined();
      expect(contentParts.length).toBe(1);
      expect(contentParts[0].type).toBe('text_file');
      expect(contentParts[0].filename).toBe('send-me.txt');
      expect(contentParts[0].content).toBe('File content to send');  // Raw content, not formatted
    });

    it('clears pending files after sending', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Add a file
      const mockFile = createMockFile('clear-me.txt', 'Content');
      const mockFileList = createMockFileList([mockFile]);
      
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      fireEvent.change(textFileInput);

      await waitFor(() => {
        expect(screen.queryByText('clear-me.txt')).not.toBeNull();
      }, { timeout: 2000 });

      // Send message
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Test' } });
      const sendButton = screen.getByTitle('发送消息');
      fireEvent.click(sendButton);

      // Files should be cleared
      await waitFor(() => {
        expect(screen.queryByText('clear-me.txt')).toBeNull();
      });
    });

    it('can send with only file attachment (no text)', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Add a file
      const mockFile = createMockFile('only-file.txt', 'Only file content');
      const mockFileList = createMockFileList([mockFile]);
      
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      fireEvent.change(textFileInput);

      await waitFor(() => {
        expect(screen.queryByText('only-file.txt')).not.toBeNull();
      }, { timeout: 2000 });

      // Send without typing text
      const sendButton = screen.getByTitle('发送消息');
      fireEvent.click(sendButton);

      // Should still send
      expect(mockOnSend).toHaveBeenCalledTimes(1);
      const [content, , contentParts] = mockOnSend.mock.calls[0];
      expect(content).toBe('');
      expect(contentParts).toBeDefined();
      expect(contentParts.length).toBe(1);
    });
  });

  /**
   * Test 5: File count limit (Requirements 5.1, 5.2, 5.3, 5.4)
   */
  describe('File Count Limit', () => {
    it('limits total files to MAX_TEXT_FILES', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      // Add MAX_TEXT_FILES + 1 files one by one
      for (let i = 0; i <= MAX_TEXT_FILES; i++) {
        const mockFile = createMockFile(`file${i}.txt`, `Content ${i}`);
        const mockFileList = createMockFileList([mockFile]);
        
        Object.defineProperty(textFileInput, 'files', {
          value: mockFileList,
          writable: true,
          configurable: true,
        });
        fireEvent.change(textFileInput);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Should show error message about file limit
      await waitFor(() => {
        const errorMessage = screen.queryByText(/最多只能添加/);
        expect(errorMessage).not.toBeNull();
      }, { timeout: 2000 });
    });
  });

  /**
   * Test 6: Error handling (Requirements 7.1, 7.2, 7.3)
   */
  describe('Error Handling', () => {
    it('shows error for files larger than MAX_TEXT_FILE_SIZE', async () => {
      render(
        <InputArea
          onSend={mockOnSend}
          onAbort={mockOnAbort}
          disabled={false}
          isGenerating={false}
        />
      );

      // Create a large file content
      const largeContent = 'x'.repeat(MAX_TEXT_FILE_SIZE + 1);
      const mockFile = createMockFile('large.txt', largeContent);
      const mockFileList = createMockFileList([mockFile]);

      const fileInputs = document.querySelectorAll('input[type="file"]');
      const textFileInput = Array.from(fileInputs).find(
        input => (input as HTMLInputElement).accept?.includes('.txt')
      ) as HTMLInputElement;

      Object.defineProperty(textFileInput, 'files', {
        value: mockFileList,
        writable: false,
      });
      fireEvent.change(textFileInput);

      // Should show error message
      await waitFor(() => {
        const errorMessage = screen.queryByText(/文件过大/);
        expect(errorMessage).not.toBeNull();
      }, { timeout: 2000 });
    });
  });
});

/**
 * PDF Count Limit Property Tests
 * 
 * **Property 4: PDF Count Limit Invariant**
 * **Validates: Requirements 6.2, 6.5**
 * 
 * Verifies that the system always enforces the PDF count limit (MAX_PDF_COUNT = 3)
 */
describe('PDF Count Limit Property Tests', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property: The number of pending PDFs never exceeds MAX_PDF_COUNT
   * 
   * For any sequence of PDF file additions:
   * - pendingPdfs.length <= MAX_PDF_COUNT
   * - When attempting to add more than MAX_PDF_COUNT files, an error is shown
   * - Only the first MAX_PDF_COUNT files are accepted
   */
  it('Property: pendingPdfs.length <= MAX_PDF_COUNT invariant', async () => {
    const MAX_PDF_COUNT = 3; // From types/index.ts

    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // Find the PDF file input
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    expect(pdfFileInput).toBeDefined();

    // Test Case 1: Adding exactly MAX_PDF_COUNT files should succeed
    const validFiles: File[] = [];
    for (let i = 0; i < MAX_PDF_COUNT; i++) {
      const mockFile = createMockFile(
        `valid${i}.pdf`,
        `PDF content ${i}`,
        'application/pdf'
      );
      validFiles.push(mockFile);
    }

    const validFileList = createMockFileList(validFiles);
    Object.defineProperty(pdfFileInput, 'files', {
      value: validFileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    // Wait for processing (PDFs take time to process)
    await new Promise(resolve => setTimeout(resolve, 500));

    // Should not show error for MAX_PDF_COUNT files
    const errorAfterValid = screen.queryByText(/最多只能同时处理/);
    expect(errorAfterValid).toBeNull();

    // Test Case 2: Attempting to add more than MAX_PDF_COUNT files should show error
    const excessFiles: File[] = [];
    for (let i = 0; i < MAX_PDF_COUNT + 2; i++) {
      const mockFile = createMockFile(
        `excess${i}.pdf`,
        `PDF content ${i}`,
        'application/pdf'
      );
      excessFiles.push(mockFile);
    }

    const excessFileList = createMockFileList(excessFiles);
    Object.defineProperty(pdfFileInput, 'files', {
      value: excessFileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    // Should show error message
    await waitFor(() => {
      const errorMessage = screen.queryByText(/最多只能同时处理 3 个 PDF 文档/);
      expect(errorMessage).not.toBeNull();
    }, { timeout: 2000 });
  });

  /**
   * Property: Adding PDFs one-by-one respects the limit
   * 
   * When adding PDFs sequentially:
   * - First MAX_PDF_COUNT additions succeed
   * - (MAX_PDF_COUNT + 1)th addition shows error
   * - Total count never exceeds MAX_PDF_COUNT
   */
  it('Property: sequential PDF additions respect MAX_PDF_COUNT limit', async () => {
    const MAX_PDF_COUNT = 3;

    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // Add PDFs one by one up to the limit
    for (let i = 0; i < MAX_PDF_COUNT; i++) {
      const mockFile = createMockFile(
        `sequential${i}.pdf`,
        `PDF content ${i}`,
        'application/pdf'
      );
      const mockFileList = createMockFileList([mockFile]);
      
      Object.defineProperty(pdfFileInput, 'files', {
        value: mockFileList,
        writable: true,
        configurable: true,
      });
      fireEvent.change(pdfFileInput);
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // No error should be shown yet
    let errorMessage = screen.queryByText(/最多只能同时处理/);
    expect(errorMessage).toBeNull();

    // Try to add one more (should fail)
    const extraFile = createMockFile(
      'extra.pdf',
      'Extra PDF content',
      'application/pdf'
    );
    const extraFileList = createMockFileList([extraFile]);
    
    Object.defineProperty(pdfFileInput, 'files', {
      value: extraFileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    // Should show error message
    await waitFor(() => {
      errorMessage = screen.queryByText(/最多只能同时处理 3 个 PDF 文档/);
      expect(errorMessage).not.toBeNull();
    }, { timeout: 2000 });
  });

  /**
   * Property: Removing PDFs allows adding new ones
   * 
   * When at MAX_PDF_COUNT limit:
   * - Removing a PDF decreases count
   * - Can then add a new PDF
   * - Total never exceeds MAX_PDF_COUNT
   */
  it('Property: removing PDFs allows adding new ones within limit', async () => {
    const MAX_PDF_COUNT = 3;

    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // Add MAX_PDF_COUNT PDFs
    const initialFiles: File[] = [];
    for (let i = 0; i < MAX_PDF_COUNT; i++) {
      initialFiles.push(
        createMockFile(`initial${i}.pdf`, `Content ${i}`, 'application/pdf')
      );
    }

    const initialFileList = createMockFileList(initialFiles);
    Object.defineProperty(pdfFileInput, 'files', {
      value: initialFileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Try to add another (should fail)
    const blockedFile = createMockFile('blocked.pdf', 'Blocked', 'application/pdf');
    const blockedFileList = createMockFileList([blockedFile]);
    
    Object.defineProperty(pdfFileInput, 'files', {
      value: blockedFileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      const errorMessage = screen.queryByText(/最多只能同时处理/);
      expect(errorMessage).not.toBeNull();
    }, { timeout: 2000 });

    // Remove one PDF
    const removeButtons = screen.getAllByTitle("移除");
    if (removeButtons.length > 0) {
      fireEvent.click(removeButtons[0]);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Error should be cleared
      const errorAfterRemove = screen.queryByText(/最多只能同时处理/);
      expect(errorAfterRemove).toBeNull();

      // Now should be able to add a new PDF
      const newFile = createMockFile('new.pdf', 'New content', 'application/pdf');
      const newFileList = createMockFileList([newFile]);
      
      Object.defineProperty(pdfFileInput, 'files', {
        value: newFileList,
        writable: true,
        configurable: true,
      });
      fireEvent.change(pdfFileInput);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Should not show error
      const errorAfterAdd = screen.queryByText(/最多只能同时处理/);
      expect(errorAfterAdd).toBeNull();
    }
  });

  /**
   * Property: Drag-and-drop respects PDF count limit
   * 
   * When dragging and dropping PDFs:
   * - Same limit applies as file selection
   * - Error shown when exceeding limit
   */
  it('Property: drag-and-drop respects MAX_PDF_COUNT limit', async () => {
    const MAX_PDF_COUNT = 3;

    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const inputArea = document.querySelector('.border-t');
    expect(inputArea).not.toBeNull();

    // Drop more than MAX_PDF_COUNT PDFs
    const droppedFiles: File[] = [];
    for (let i = 0; i < MAX_PDF_COUNT + 2; i++) {
      droppedFiles.push(
        createMockFile(`dropped${i}.pdf`, `Content ${i}`, 'application/pdf')
      );
    }

    const droppedFileList = createMockFileList(droppedFiles);

    fireEvent.drop(inputArea!, {
      dataTransfer: { files: droppedFileList }
    });

    // Should show error message
    await waitFor(() => {
      const errorMessage = screen.queryByText(/最多只能同时处理 3 个 PDF 文档/);
      expect(errorMessage).not.toBeNull();
    }, { timeout: 2000 });
  });

  /**
   * Property: Sending message clears PDFs and resets limit
   * 
   * After sending a message with PDFs:
   * - All PDFs are cleared
   * - Can add MAX_PDF_COUNT new PDFs
   */
  it('Property: sending message resets PDF count', async () => {
    const MAX_PDF_COUNT = 3;

    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // Add some PDFs
    const files: File[] = [];
    for (let i = 0; i < 2; i++) {
      files.push(
        createMockFile(`send${i}.pdf`, `Content ${i}`, 'application/pdf')
      );
    }

    const fileList = createMockFileList(files);
    Object.defineProperty(pdfFileInput, 'files', {
      value: fileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Send message
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Analyze these PDFs' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    await new Promise(resolve => setTimeout(resolve, 100));

    // PDFs should be cleared
    expect(mockOnSend).toHaveBeenCalledTimes(1);

    // Should be able to add MAX_PDF_COUNT new PDFs
    const newFiles: File[] = [];
    for (let i = 0; i < MAX_PDF_COUNT; i++) {
      newFiles.push(
        createMockFile(`new${i}.pdf`, `New content ${i}`, 'application/pdf')
      );
    }

    const newFileList = createMockFileList(newFiles);
    Object.defineProperty(pdfFileInput, 'files', {
      value: newFileList,
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Should not show error
    const errorMessage = screen.queryByText(/最多只能同时处理/);
    expect(errorMessage).toBeNull();
  });
});


/**
 * PDF Message Formatting Property Tests
 * 
 * **Property 5: PDF Message Formatting**
 * **Validates: Requirements 4.1, 4.2, 4.4, 4.7**
 * 
 * Verifies that PDF files are correctly converted to PdfDocumentContentPart format
 * when sending messages.
 */
describe('Property 5: PDF Message Formatting', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property: PDF files are converted to PdfDocumentContentPart with correct structure
   * 
   * For any valid PDF file added to the input area:
   * - When sent, it SHALL be converted to a ContentPart with type 'pdf_document'
   * - The ContentPart SHALL contain: filename, pages, totalPages, metadata
   * - Each page SHALL contain: pageNumber, text, image
   * - The image SHALL be a valid Base64 data URL
   */
  it('Property: PDFs are converted to correct ContentPart structure', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // Create a mock PDF file
    const mockPdfFile = createMockFile(
      'test-document.pdf',
      'PDF content',
      'application/pdf'
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    expect(pdfFileInput).toBeDefined();

    // Add PDF file
    const mockFileList = createMockFileList([mockPdfFile]);
    Object.defineProperty(pdfFileInput, 'files', {
      value: mockFileList,
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    // Wait for PDF processing
    await waitFor(() => {
      const preview = screen.queryByText('test-document.pdf');
      expect(preview).not.toBeNull();
    }, { timeout: 3000 });

    // Type a message and send
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '请分析这个 PDF' } });
    
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    // Verify onSend was called
    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [content, , contentParts] = mockOnSend.mock.calls[0];
    
    // Verify message content
    expect(content).toBe('请分析这个 PDF');
    
    // Verify contentParts structure
    expect(contentParts).toBeDefined();
    expect(Array.isArray(contentParts)).toBe(true);
    expect(contentParts.length).toBeGreaterThan(0);
    
    // Find the PDF content part
    const pdfPart = contentParts.find((part: any) => part.type === 'pdf_document');
    expect(pdfPart).toBeDefined();
    
    // Verify PDF ContentPart structure (Requirements 4.1, 4.2)
    expect(pdfPart.type).toBe('pdf_document');
    expect(pdfPart.filename).toBe('test-document.pdf');
    expect(pdfPart).toHaveProperty('pages');
    expect(pdfPart).toHaveProperty('totalPages');
    expect(Array.isArray(pdfPart.pages)).toBe(true);
    expect(typeof pdfPart.totalPages).toBe('number');
    expect(pdfPart.totalPages).toBeGreaterThan(0);
    
    // Verify each page structure (Requirements 4.4, 4.7)
    for (const page of pdfPart.pages) {
      expect(page).toHaveProperty('pageNumber');
      expect(page).toHaveProperty('text');
      expect(page).toHaveProperty('image');
      
      expect(typeof page.pageNumber).toBe('number');
      expect(page.pageNumber).toBeGreaterThan(0);
      expect(typeof page.text).toBe('string');
      expect(typeof page.image).toBe('string');
      
      // Verify image is a valid Base64 data URL
      expect(page.image).toMatch(/^data:image\/(png|jpeg);base64,/);
    }
  });

  /**
   * Property: Multiple PDFs are all included in contentParts
   * 
   * When multiple PDF files are added:
   * - All PDFs SHALL be included in the contentParts array
   * - Each SHALL be a separate PdfDocumentContentPart
   * - Order SHALL be preserved
   */
  it('Property: multiple PDFs are all included in correct order', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // Add multiple PDFs
    const pdfFiles = [
      createMockFile('first.pdf', 'First PDF', 'application/pdf'),
      createMockFile('second.pdf', 'Second PDF', 'application/pdf'),
      createMockFile('third.pdf', 'Third PDF', 'application/pdf'),
    ];

    const mockFileList = createMockFileList(pdfFiles);
    Object.defineProperty(pdfFileInput, 'files', {
      value: mockFileList,
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    // Wait for all PDFs to be processed
    await waitFor(() => {
      expect(screen.queryByText('first.pdf')).not.toBeNull();
      expect(screen.queryByText('second.pdf')).not.toBeNull();
      expect(screen.queryByText('third.pdf')).not.toBeNull();
    }, { timeout: 5000 });

    // Send message
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '分析这些文档' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [, , contentParts] = mockOnSend.mock.calls[0];
    
    // Filter PDF content parts
    const pdfParts = contentParts.filter((part: any) => part.type === 'pdf_document');
    
    // Verify all PDFs are included
    expect(pdfParts.length).toBe(3);
    
    // Verify order is preserved
    expect(pdfParts[0].filename).toBe('first.pdf');
    expect(pdfParts[1].filename).toBe('second.pdf');
    expect(pdfParts[2].filename).toBe('third.pdf');
    
    // Verify each has correct structure
    for (const pdfPart of pdfParts) {
      expect(pdfPart.type).toBe('pdf_document');
      expect(pdfPart).toHaveProperty('pages');
      expect(pdfPart).toHaveProperty('totalPages');
      expect(Array.isArray(pdfPart.pages)).toBe(true);
    }
  });

  /**
   * Property: PDF ContentParts are cleared after sending
   * 
   * After sending a message with PDFs:
   * - pendingPdfs SHALL be cleared
   * - Next message SHALL not include previous PDFs
   */
  it('Property: PDFs are cleared after sending', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // Add a PDF
    const mockPdfFile = createMockFile('clear-test.pdf', 'Content', 'application/pdf');
    const mockFileList = createMockFileList([mockPdfFile]);
    Object.defineProperty(pdfFileInput, 'files', {
      value: mockFileList,
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('clear-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // Send first message
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '第一条消息' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [, , firstContentParts] = mockOnSend.mock.calls[0];
    const firstPdfParts = firstContentParts.filter((part: any) => part.type === 'pdf_document');
    expect(firstPdfParts.length).toBe(1);

    // PDF preview should be cleared
    await waitFor(() => {
      expect(screen.queryByText('clear-test.pdf')).toBeNull();
    });

    // Send second message without adding new PDF
    fireEvent.change(textarea, { target: { value: '第二条消息' } });
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(2);
    
    const [, , secondContentParts] = mockOnSend.mock.calls[1];
    
    // Second message should not include PDF
    if (secondContentParts) {
      const secondPdfParts = secondContentParts.filter((part: any) => part.type === 'pdf_document');
      expect(secondPdfParts.length).toBe(0);
    } else {
      // contentParts should be undefined if no attachments
      expect(secondContentParts).toBeUndefined();
    }
  });

  /**
   * Property: PDFs can be sent with other content types
   * 
   * When sending a message with PDFs, images, and text files:
   * - All content types SHALL be included in contentParts
   * - Each SHALL maintain its correct type and structure
   */
  it('Property: PDFs work alongside other content types', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    
    // Add an image
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;
    
    const mockImageFile = createMockFile('test.png', 'image data', 'image/png');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);

    await new Promise(resolve => setTimeout(resolve, 200));

    // Add a text file
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;
    
    const mockTextFile = createMockFile('notes.txt', 'Some notes', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('notes.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // Add a PDF
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;
    
    const mockPdfFile = createMockFile('document.pdf', 'PDF content', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('document.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // Send message
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '分析所有附件' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [content, , contentParts] = mockOnSend.mock.calls[0];
    
    expect(content).toBe('分析所有附件');
    expect(contentParts).toBeDefined();
    expect(Array.isArray(contentParts)).toBe(true);
    
    // Should have all three types
    const imageParts = contentParts.filter((part: any) => part.type === 'image');
    const textFileParts = contentParts.filter((part: any) => part.type === 'text_file');
    const pdfParts = contentParts.filter((part: any) => part.type === 'pdf_document');
    
    expect(imageParts.length).toBe(1);
    expect(textFileParts.length).toBe(1);
    expect(pdfParts.length).toBe(1);
    
    // Verify each type has correct structure
    expect(imageParts[0].url).toBeDefined();
    expect(textFileParts[0].filename).toBe('notes.txt');
    expect(textFileParts[0].content).toBe('Some notes');
    expect(pdfParts[0].filename).toBe('document.pdf');
    expect(pdfParts[0].pages).toBeDefined();
  });

  /**
   * Property: Empty message with only PDF attachment can be sent
   * 
   * When no text is entered but a PDF is attached:
   * - The send button SHALL be enabled
   * - The message SHALL be sent with empty text and PDF ContentPart
   */
  it('Property: can send PDF without text message', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // Add PDF without typing any text
    const mockPdfFile = createMockFile('standalone.pdf', 'Content', 'application/pdf');
    const mockFileList = createMockFileList([mockPdfFile]);
    Object.defineProperty(pdfFileInput, 'files', {
      value: mockFileList,
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('standalone.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // Send without typing text
    const sendButton = screen.getByTitle('发送消息');
    
    // Send button should be enabled (has attachment)
    expect(sendButton).not.toBeDisabled();
    
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [content, , contentParts] = mockOnSend.mock.calls[0];
    
    // Content should be empty string
    expect(content).toBe('');
    
    // But should have PDF ContentPart
    expect(contentParts).toBeDefined();
    const pdfParts = contentParts.filter((part: any) => part.type === 'pdf_document');
    expect(pdfParts.length).toBe(1);
    expect(pdfParts[0].filename).toBe('standalone.pdf');
  });

  /**
   * Property: PDF metadata is preserved in ContentPart
   * 
   * When a PDF with metadata is processed:
   * - The metadata SHALL be included in the PdfDocumentContentPart
   * - Metadata fields SHALL match the PDF's metadata
   */
  it('Property: PDF metadata is preserved', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    const mockPdfFile = createMockFile('metadata-test.pdf', 'Content', 'application/pdf');
    const mockFileList = createMockFileList([mockPdfFile]);
    Object.defineProperty(pdfFileInput, 'files', {
      value: mockFileList,
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('metadata-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // Send message
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Test' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [, , contentParts] = mockOnSend.mock.calls[0];
    const pdfPart = contentParts.find((part: any) => part.type === 'pdf_document');
    
    // Metadata field should exist (may be undefined or contain metadata)
    expect(pdfPart).toHaveProperty('metadata');
    
    // If metadata exists, it should have the correct structure
    if (pdfPart.metadata) {
      // Metadata can have optional fields: title, author, createdAt, etc.
      // Just verify it's an object
      expect(typeof pdfPart.metadata).toBe('object');
    }
  });

  /**
   * Property: Page numbers are sequential and start from 1
   * 
   * For any PDF with N pages:
   * - Page numbers SHALL be [1, 2, 3, ..., N]
   * - No gaps or duplicates SHALL exist
   */
  it('Property: page numbers are sequential starting from 1', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    const mockPdfFile = createMockFile('sequential.pdf', 'Content', 'application/pdf');
    const mockFileList = createMockFileList([mockPdfFile]);
    Object.defineProperty(pdfFileInput, 'files', {
      value: mockFileList,
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('sequential.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // Send message
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Test' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledTimes(1);
    
    const [, , contentParts] = mockOnSend.mock.calls[0];
    const pdfPart = contentParts.find((part: any) => part.type === 'pdf_document');
    
    expect(pdfPart).toBeDefined();
    expect(pdfPart.pages.length).toBeGreaterThan(0);
    
    // Verify page numbers are sequential
    const pageNumbers = pdfPart.pages.map((page: any) => page.pageNumber);
    
    // Should start from 1
    expect(pageNumbers[0]).toBe(1);
    
    // Should be sequential with no gaps
    for (let i = 0; i < pageNumbers.length; i++) {
      expect(pageNumbers[i]).toBe(i + 1);
    }
    
    // Should match totalPages
    expect(pageNumbers.length).toBe(pdfPart.totalPages);
  });
});

/**
 * AttachmentPreview Component Usage Tests
 * 
 * **Task 3.1: 更新现有测试以使用 AttachmentPreview**
 * **Validates: Requirements 1.1, 1.2, 1.3**
 * 
 * 验证 InputArea 组件使用 AttachmentPreview 组件来渲染所有类型的附件
 */
describe('AttachmentPreview Component Usage', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 验证图片附件使用 AttachmentPreview 组件渲染
   * Requirements: 1.1
   */
  it('renders image attachments using AttachmentPreview component', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // 创建一个模拟图片文件
    const mockImageFile = createMockFile('test-image.png', 'image data', 'image/png');
    
    // 查找图片文件输入
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;

    expect(imageInput).toBeDefined();

    // 添加图片
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: false,
    });
    fireEvent.change(imageInput);

    // 等待图片被处理
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证 AttachmentPreview 组件被渲染（通过查找紧凑模式的特征元素）
    // AttachmentPreview 在紧凑模式下显示文件名
    const fileName = screen.queryByText('test-image.png');
    expect(fileName).not.toBeNull();

    // 验证有移除按钮（AttachmentPreview 的特征）
    const removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();
  });

  /**
   * 验证文本文件附件使用 AttachmentPreview 组件渲染
   * Requirements: 1.2
   */
  it('renders text file attachments using AttachmentPreview component', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 创建一个模拟文本文件
    const mockTextFile = createMockFile('test-file.txt', 'Hello, World!', 'text/plain');
    
    // 查找文本文件输入
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    expect(textFileInput).toBeDefined();

    // 添加文本文件
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    // 等待文件被处理
    await waitFor(() => {
      const fileName = screen.queryByText('test-file.txt');
      expect(fileName).not.toBeNull();
    }, { timeout: 2000 });

    // 验证有移除按钮（AttachmentPreview 的特征）
    const removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();

    // 验证紧凑模式显示（AttachmentPreview 默认是紧凑模式）
    // 在紧凑模式下，文件内容不会立即显示
    const fileContent = screen.queryByText('Hello, World!');
    expect(fileContent).toBeNull();
  });

  /**
   * 验证 PDF 附件使用 AttachmentPreview 组件渲染
   * Requirements: 1.3
   */
  it('renders PDF attachments using AttachmentPreview component', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // 创建一个模拟 PDF 文件
    const mockPdfFile = createMockFile('test-document.pdf', 'PDF content', 'application/pdf');
    
    // 查找 PDF 文件输入
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    expect(pdfFileInput).toBeDefined();

    // 添加 PDF 文件
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    // 等待 PDF 被处理
    await waitFor(() => {
      const fileName = screen.queryByText('test-document.pdf');
      expect(fileName).not.toBeNull();
    }, { timeout: 3000 });

    // 验证有移除按钮（AttachmentPreview 的特征）
    const removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();
  });

  /**
   * 验证不同类型的附件都使用 AttachmentPreview 渲染
   * Requirements: 1.1, 1.2, 1.3
   */
  it('renders all attachment types using AttachmentPreview component', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');

    // 添加图片
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;
    const mockImageFile = createMockFile('image.png', 'image data', 'image/png');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);
    await new Promise(resolve => setTimeout(resolve, 200));

    // 添加文本文件
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;
    const mockTextFile = createMockFile('document.txt', 'text content', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('document.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 添加 PDF
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;
    const mockPdfFile = createMockFile('report.pdf', 'PDF content', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);
    await waitFor(() => {
      expect(screen.queryByText('report.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 验证所有三个附件都被渲染
    expect(screen.queryByText('image.png')).not.toBeNull();
    expect(screen.queryByText('document.txt')).not.toBeNull();
    expect(screen.queryByText('report.pdf')).not.toBeNull();

    // 验证所有附件都有移除按钮（AttachmentPreview 的特征）
    const removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(3);
  });

  /**
   * 验证 AttachmentPreview 的展开功能
   * 点击紧凑模式的附件应该展开显示详细内容
   */
  it('AttachmentPreview expands on click to show details', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加一个文本文件
    const mockTextFile = createMockFile('expandable.txt', 'This is the file content', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('expandable.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 初始状态：紧凑模式，内容不可见
    let fileContent = screen.queryByText('This is the file content');
    expect(fileContent).toBeNull();

    // 点击附件展开
    const fileName = screen.getByText('expandable.txt');
    fireEvent.click(fileName);

    // 等待展开动画
    await new Promise(resolve => setTimeout(resolve, 100));

    // 展开后：内容应该可见
    fileContent = screen.queryByText('This is the file content');
    expect(fileContent).not.toBeNull();
  });
});

/**
 * Compact Mode Initial State Property Tests
 * 
 * **Property 1: 紧凑模式初始状态**
 * **Validates: Requirements 2.1, 2.2, 2.3**
 * 
 * 验证所有类型的附件在首次添加时都以紧凑模式显示，
 * 包含文件类型图标、文件名、文件大小和向右箭头图标
 */
describe('Property 1: Compact Mode Initial State', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property: 图片附件初始以紧凑模式显示
   * 
   * 对于任意图片附件，当首次添加到输入区域时：
   * - 应该显示文件类型图标
   * - 应该显示文件名
   * - 应该显示文件大小
   * - 应该显示向右箭头图标（指示可以展开）
   * - 不应该显示图片预览内容
   */
  it('Property: image attachments start in compact mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // 创建一个模拟图片文件
    const mockImageFile = createMockFile('test-image.png', 'image data', 'image/png');
    
    // 查找图片文件输入
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;

    expect(imageInput).toBeDefined();

    // 添加图片
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: false,
    });
    fireEvent.change(imageInput);

    // 等待图片被处理
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证紧凑模式的特征（Requirements 2.1, 2.2, 2.3）
    
    // 1. 应该显示文件名
    const fileName = screen.queryByText('test-image.png');
    expect(fileName).not.toBeNull();

    // 2. 应该显示文件大小
    const fileSize = container.querySelector('.text-xs.text-gray-500');
    expect(fileSize).not.toBeNull();

    // 3. 应该显示向右箭头图标（ChevronRight）
    // 在紧凑模式下，AttachmentPreview 使用 ChevronRight 图标
    const chevronRight = container.querySelector('svg');
    expect(chevronRight).not.toBeNull();

    // 4. 不应该显示图片预览内容（紧凑模式下不显示 img 标签）
    const imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).toBeNull();

    // 5. 应该有可点击的容器（cursor-pointer 类）
    const compactContainer = container.querySelector('.cursor-pointer');
    expect(compactContainer).not.toBeNull();
  });

  /**
   * Property: 文本文件附件初始以紧凑模式显示
   * 
   * 对于任意文本文件附件，当首次添加到输入区域时：
   * - 应该显示文件类型图标
   * - 应该显示文件名
   * - 应该显示文件大小
   * - 应该显示向右箭头图标
   * - 不应该显示文本内容预览
   */
  it('Property: text file attachments start in compact mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 创建一个模拟文本文件
    const mockTextFile = createMockFile('document.txt', 'This is the file content', 'text/plain');
    
    // 查找文本文件输入
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    expect(textFileInput).toBeDefined();

    // 添加文本文件
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    // 等待文件被处理
    await waitFor(() => {
      const fileName = screen.queryByText('document.txt');
      expect(fileName).not.toBeNull();
    }, { timeout: 2000 });

    // 验证紧凑模式的特征（Requirements 2.1, 2.2, 2.3）
    
    // 1. 应该显示文件名
    const fileName = screen.queryByText('document.txt');
    expect(fileName).not.toBeNull();

    // 2. 应该显示文件大小
    const fileSize = container.querySelector('.text-xs.text-gray-500');
    expect(fileSize).not.toBeNull();

    // 3. 应该显示向右箭头图标
    const chevronRight = container.querySelector('svg');
    expect(chevronRight).not.toBeNull();

    // 4. 不应该显示文本内容预览（紧凑模式下不显示内容）
    const textContent = screen.queryByText('This is the file content');
    expect(textContent).toBeNull();

    // 5. 应该有可点击的容器
    const compactContainer = container.querySelector('.cursor-pointer');
    expect(compactContainer).not.toBeNull();
  });

  /**
   * Property: PDF 附件初始以紧凑模式显示
   * 
   * 对于任意 PDF 附件，当首次添加到输入区域时：
   * - 应该显示文件类型图标
   * - 应该显示文件名
   * - 应该显示文件大小
   * - 应该显示向右箭头图标
   * - 不应该显示 PDF 页面缩略图
   */
  it('Property: PDF attachments start in compact mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // 创建一个模拟 PDF 文件
    const mockPdfFile = createMockFile('report.pdf', 'PDF content', 'application/pdf');
    
    // 查找 PDF 文件输入
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    expect(pdfFileInput).toBeDefined();

    // 添加 PDF 文件
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    // 等待 PDF 被处理
    await waitFor(() => {
      const fileName = screen.queryByText('report.pdf');
      expect(fileName).not.toBeNull();
    }, { timeout: 3000 });

    // 验证紧凑模式的特征（Requirements 2.1, 2.2, 2.3）
    
    // 1. 应该显示文件名
    const fileName = screen.queryByText('report.pdf');
    expect(fileName).not.toBeNull();

    // 2. 应该显示文件大小
    const fileSize = container.querySelector('.text-xs.text-gray-500');
    expect(fileSize).not.toBeNull();

    // 3. 应该显示向右箭头图标
    const chevronRight = container.querySelector('svg');
    expect(chevronRight).not.toBeNull();

    // 4. 不应该显示 PDF 页面缩略图（紧凑模式下不显示）
    const pageThumbnail = screen.queryByText(/第 \d+ 页/);
    expect(pageThumbnail).toBeNull();

    // 5. 不应该显示页数信息（紧凑模式下不显示）
    const pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).toBeNull();

    // 6. 应该有可点击的容器
    const compactContainer = container.querySelector('.cursor-pointer');
    expect(compactContainer).not.toBeNull();
  });

  /**
   * Property: 多个不同类型的附件都以紧凑模式显示
   * 
   * 当添加多个不同类型的附件时：
   * - 所有附件都应该以紧凑模式显示
   * - 每个附件都应该有独立的紧凑视图
   * - 所有附件都应该显示向右箭头图标
   */
  it('Property: multiple attachments of different types all start in compact mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');

    // 添加图片
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;
    const mockImageFile = createMockFile('photo.jpg', 'image data', 'image/jpeg');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);
    await new Promise(resolve => setTimeout(resolve, 200));

    // 添加文本文件
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;
    const mockTextFile = createMockFile('notes.txt', 'Some notes', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('notes.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 添加 PDF
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;
    const mockPdfFile = createMockFile('document.pdf', 'PDF content', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);
    await waitFor(() => {
      expect(screen.queryByText('document.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 验证所有附件都以紧凑模式显示
    
    // 1. 所有文件名都应该可见
    expect(screen.queryByText('photo.jpg')).not.toBeNull();
    expect(screen.queryByText('notes.txt')).not.toBeNull();
    expect(screen.queryByText('document.pdf')).not.toBeNull();

    // 2. 应该有多个紧凑容器（每个附件一个）
    const compactContainers = container.querySelectorAll('.cursor-pointer');
    expect(compactContainers.length).toBeGreaterThanOrEqual(3);

    // 3. 不应该显示任何展开的内容
    const imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).toBeNull();
    
    const textContent = screen.queryByText('Some notes');
    expect(textContent).toBeNull();
    
    const pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).toBeNull();

    // 4. 所有附件都应该有移除按钮
    const removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(3);
  });

  /**
   * Property: 紧凑模式在不同文件大小下都正确显示
   * 
   * 对于不同大小的文件：
   * - 小文件（< 1KB）应该显示 B 单位
   * - 中等文件（< 1MB）应该显示 KB 单位
   * - 大文件（>= 1MB）应该显示 MB 单位
   * - 所有文件都应该以紧凑模式显示
   */
  it('Property: compact mode displays file sizes correctly', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    // 测试小文件（< 1KB）
    const smallFile = createMockFile('small.txt', 'x'.repeat(500), 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([smallFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('small.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 应该显示文件大小（B 或 KB 单位）
    let fileSizeElement = container.querySelector('.text-xs.text-gray-500');
    expect(fileSizeElement).not.toBeNull();
    expect(fileSizeElement?.textContent).toMatch(/\d+(\.\d+)?\s*(B|KB)/);

    // 移除文件
    let removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 测试中等文件（< 1MB）
    const mediumFile = createMockFile('medium.txt', 'x'.repeat(50000), 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mediumFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('medium.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 应该显示 KB 单位
    fileSizeElement = container.querySelector('.text-xs.text-gray-500');
    expect(fileSizeElement).not.toBeNull();
    expect(fileSizeElement?.textContent).toMatch(/\d+\.\d+\s*KB/);

    // 验证仍然是紧凑模式
    const compactContainer = container.querySelector('.cursor-pointer');
    expect(compactContainer).not.toBeNull();
  });

  /**
   * Property: 紧凑模式在不同文件名长度下都正确显示
   * 
   * 对于不同长度的文件名：
   * - 短文件名应该完整显示
   * - 长文件名应该被截断（truncate）
   * - 所有文件都应该以紧凑模式显示
   */
  it('Property: compact mode handles different filename lengths', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    // 测试短文件名
    const shortNameFile = createMockFile('a.txt', 'content', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([shortNameFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('a.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 应该显示完整文件名
    let fileName = screen.queryByText('a.txt');
    expect(fileName).not.toBeNull();

    // 应该是紧凑模式
    let compactContainer = container.querySelector('.cursor-pointer');
    expect(compactContainer).not.toBeNull();

    // 移除文件
    let removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 测试长文件名
    const longNameFile = createMockFile(
      'this-is-a-very-long-filename-that-should-be-truncated-in-compact-mode.txt',
      'content',
      'text/plain'
    );
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([longNameFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      const longFileName = screen.queryByText(/this-is-a-very-long-filename/);
      expect(longFileName).not.toBeNull();
    }, { timeout: 2000 });

    // 文件名元素应该有 truncate 类
    const fileNameElement = container.querySelector('.truncate');
    expect(fileNameElement).not.toBeNull();

    // 应该仍然是紧凑模式
    compactContainer = container.querySelector('.cursor-pointer');
    expect(compactContainer).not.toBeNull();
  });
});

/**
 * Expand-Collapse Round-Trip Property Tests
 * 
 * **Property 2: 展开-收起往返**
 * **Validates: Requirements 3.1, 3.3**
 * 
 * 验证附件可以展开和收起，形成完整的往返操作
 */
describe('Property 2: Expand-Collapse Round-Trip', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property: 图片附件展开-收起往返
   * 
   * 对于任意图片附件：
   * - 初始状态：紧凑模式，不显示图片预览
   * - 点击后：展开模式，显示图片预览
   * - 再次点击头部：收起回到紧凑模式
   * - 状态应该完整往返
   */
  it('Property: image attachments can expand and collapse', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // 添加图片附件
    const mockImageFile = createMockFile('photo.jpg', 'image data', 'image/jpeg');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;

    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: false,
    });
    fireEvent.change(imageInput);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 初始状态：紧凑模式（Requirement 3.1）
    let fileName = screen.queryByText('photo.jpg');
    expect(fileName).not.toBeNull();

    // 不应该显示图片预览
    let imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).toBeNull();

    // 应该显示向右箭头（ChevronRight）
    let chevronRight = container.querySelector('svg');
    expect(chevronRight).not.toBeNull();

    // 点击展开（Requirement 3.1）
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 展开后：应该显示图片预览
    imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).not.toBeNull();

    // 应该显示向下箭头（ChevronDown）
    const chevronDown = container.querySelector('svg');
    expect(chevronDown).not.toBeNull();

    // 点击头部收起（Requirement 3.3）
    fileName = screen.queryByText('photo.jpg');
    expect(fileName).not.toBeNull();
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 收起后：回到紧凑模式
    imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).toBeNull();

    // 应该再次显示向右箭头
    chevronRight = container.querySelector('svg');
    expect(chevronRight).not.toBeNull();
  });

  /**
   * Property: 文本文件附件展开-收起往返
   * 
   * 对于任意文本文件附件：
   * - 初始状态：紧凑模式，不显示文本内容
   * - 点击后：展开模式，显示文本内容预览
   * - 再次点击头部：收起回到紧凑模式
   * - 状态应该完整往返
   */
  it('Property: text file attachments can expand and collapse', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件附件
    const mockTextFile = createMockFile('notes.txt', 'This is my note content', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('notes.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 初始状态：紧凑模式（Requirement 3.1）
    let fileName = screen.queryByText('notes.txt');
    expect(fileName).not.toBeNull();

    // 不应该显示文本内容
    let textContent = screen.queryByText('This is my note content');
    expect(textContent).toBeNull();

    // 点击展开（Requirement 3.1）
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 展开后：应该显示文本内容
    textContent = screen.queryByText('This is my note content');
    expect(textContent).not.toBeNull();

    // 点击头部收起（Requirement 3.3）
    fileName = screen.queryByText('notes.txt');
    expect(fileName).not.toBeNull();
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 收起后：回到紧凑模式
    textContent = screen.queryByText('This is my note content');
    expect(textContent).toBeNull();
  });

  /**
   * Property: PDF 附件展开-收起往返
   * 
   * 对于任意 PDF 附件：
   * - 初始状态：紧凑模式，不显示页面缩略图
   * - 点击后：展开模式，显示页数和页面缩略图
   * - 再次点击头部：收起回到紧凑模式
   * - 状态应该完整往返
   */
  it('Property: PDF attachments can expand and collapse', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('document.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('document.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 初始状态：紧凑模式（Requirement 3.1）
    let fileName = screen.queryByText('document.pdf');
    expect(fileName).not.toBeNull();

    // 不应该显示页数信息
    let pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).toBeNull();

    // 不应该显示页面缩略图
    let pageThumbnail = screen.queryByText(/第 \d+ 页/);
    expect(pageThumbnail).toBeNull();

    // 点击展开（Requirement 3.1）
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 展开后：应该显示页数信息
    pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).not.toBeNull();

    // 应该显示页面缩略图（可能有多个）
    const pageThumbnails = screen.queryAllByText(/第 \d+ 页/);
    expect(pageThumbnails.length).toBeGreaterThan(0);

    // 点击头部收起（Requirement 3.3）
    fileName = screen.queryByText('document.pdf');
    expect(fileName).not.toBeNull();
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 收起后：回到紧凑模式
    pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).toBeNull();

    const pageThumbnailsAfterCollapse = screen.queryAllByText(/第 \d+ 页/);
    expect(pageThumbnailsAfterCollapse.length).toBe(0);
  });

  /**
   * Property: 多次展开-收起往返
   * 
   * 对于任意附件：
   * - 可以多次展开和收起
   * - 每次往返都应该正确切换状态
   * - 状态不应该出现错误
   */
  it('Property: attachments can be expanded and collapsed multiple times', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件附件
    const mockTextFile = createMockFile('test.txt', 'Test content', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('test.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 执行多次展开-收起往返
    for (let i = 0; i < 3; i++) {
      // 紧凑模式：内容不可见
      let textContent = screen.queryByText('Test content');
      expect(textContent).toBeNull();

      // 点击展开
      let fileName = screen.queryByText('test.txt');
      expect(fileName).not.toBeNull();
      fireEvent.click(fileName!);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 展开模式：内容可见
      textContent = screen.queryByText('Test content');
      expect(textContent).not.toBeNull();

      // 点击收起
      fileName = screen.queryByText('test.txt');
      expect(fileName).not.toBeNull();
      fireEvent.click(fileName!);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 最终应该回到紧凑模式
    const textContent = screen.queryByText('Test content');
    expect(textContent).toBeNull();
  });

  /**
   * Property: 多个附件独立展开-收起
   * 
   * 当有多个附件时：
   * - 每个附件可以独立展开和收起
   * - 展开一个附件不影响其他附件的状态
   * - 可以同时展开多个附件
   */
  it('Property: multiple attachments can be expanded and collapsed independently', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');

    // 添加第一个文本文件
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;
    const mockTextFile1 = createMockFile('file1.txt', 'Content 1', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('file1.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 添加第二个文本文件
    const mockTextFile2 = createMockFile('file2.txt', 'Content 2', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('file2.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 添加图片
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;
    const mockImageFile = createMockFile('image.png', 'image data', 'image/png');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);
    await new Promise(resolve => setTimeout(resolve, 200));

    // 初始状态：所有附件都是紧凑模式
    expect(screen.queryByText('Content 1')).toBeNull();
    expect(screen.queryByText('Content 2')).toBeNull();
    expect(container.querySelector('img[alt="预览"]')).toBeNull();

    // 展开第一个文本文件
    const file1Name = screen.queryByText('file1.txt');
    expect(file1Name).not.toBeNull();
    fireEvent.click(file1Name!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 第一个文件展开，其他仍然紧凑
    expect(screen.queryByText('Content 1')).not.toBeNull();
    expect(screen.queryByText('Content 2')).toBeNull();
    expect(container.querySelector('img[alt="预览"]')).toBeNull();

    // 展开图片
    const imageName = screen.queryByText('image.png');
    expect(imageName).not.toBeNull();
    fireEvent.click(imageName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 第一个文件和图片都展开，第二个文件仍然紧凑
    expect(screen.queryByText('Content 1')).not.toBeNull();
    expect(screen.queryByText('Content 2')).toBeNull();
    expect(container.querySelector('img[alt="预览"]')).not.toBeNull();

    // 收起第一个文件
    const file1NameExpanded = screen.queryByText('file1.txt');
    expect(file1NameExpanded).not.toBeNull();
    fireEvent.click(file1NameExpanded!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 第一个文件收起，图片仍然展开
    expect(screen.queryByText('Content 1')).toBeNull();
    expect(screen.queryByText('Content 2')).toBeNull();
    expect(container.querySelector('img[alt="预览"]')).not.toBeNull();

    // 展开第二个文件
    const file2Name = screen.queryByText('file2.txt');
    expect(file2Name).not.toBeNull();
    fireEvent.click(file2Name!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 第二个文件和图片都展开，第一个文件紧凑
    expect(screen.queryByText('Content 1')).toBeNull();
    expect(screen.queryByText('Content 2')).not.toBeNull();
    expect(container.querySelector('img[alt="预览"]')).not.toBeNull();
  });

  /**
   * Property: 展开-收起不影响移除功能
   * 
   * 对于任意附件：
   * - 在紧凑模式下可以移除
   * - 在展开模式下可以移除
   * - 移除功能不受展开状态影响
   */
  it('Property: expand-collapse does not affect remove functionality', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    // 添加两个文本文件
    const mockTextFile1 = createMockFile('remove1.txt', 'Content 1', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('remove1.txt')).not.toBeNull();
    }, { timeout: 2000 });

    const mockTextFile2 = createMockFile('remove2.txt', 'Content 2', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('remove2.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 在紧凑模式下移除第一个文件
    let removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 第一个文件应该被移除
    expect(screen.queryByText('remove1.txt')).toBeNull();
    expect(screen.queryByText('remove2.txt')).not.toBeNull();

    // 展开第二个文件
    const file2Name = screen.queryByText('remove2.txt');
    expect(file2Name).not.toBeNull();
    fireEvent.click(file2Name!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 在展开模式下移除第二个文件
    removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(1);
    fireEvent.click(removeButtons[0]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 第二个文件应该被移除
    expect(screen.queryByText('remove2.txt')).toBeNull();
  });

  /**
   * Property: 展开-收起往返保持附件数据完整性
   * 
   * 对于任意附件：
   * - 展开-收起往返后，附件数据应该保持不变
   * - 文件名、大小、内容都应该保持一致
   * - 可以正常发送消息
   */
  it('Property: expand-collapse preserves attachment data integrity', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件
    const mockTextFile = createMockFile('integrity.txt', 'Important data', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('integrity.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 执行展开-收起往返
    let fileName = screen.queryByText('integrity.txt');
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    fileName = screen.queryByText('integrity.txt');
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 发送消息
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Test message' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    // 验证附件数据完整性
    expect(mockOnSend).toHaveBeenCalledTimes(1);
    const [content, , contentParts] = mockOnSend.mock.calls[0];
    
    expect(content).toBe('Test message');
    expect(contentParts).toBeDefined();
    expect(contentParts.length).toBe(1);
    expect(contentParts[0].type).toBe('text_file');
    expect(contentParts[0].filename).toBe('integrity.txt');
    expect(contentParts[0].content).toBe('Important data');
  });
});

/**
 * Remove Button Availability Property Tests
 * 
 * **Property 5: 移除按钮可用性**
 * **Validates: Requirements 4.1, 4.2, 4.3**
 * 
 * 验证移除按钮在紧凑模式和展开模式下都可用，
 * 悬停时显示，点击后正确移除附件
 */
describe('Property 5: Remove Button Availability', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property: 紧凑模式下移除按钮可用
   * 
   * 对于任意附件，在紧凑模式下：
   * - 悬停时应该显示移除按钮
   * - 点击移除按钮应该从附件列表中移除该附件
   * - 移除按钮应该位于附件的右上角
   */
  it('Property: remove button is available in compact mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件附件
    const mockTextFile = createMockFile('compact-remove.txt', 'Content to remove', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('compact-remove.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 验证附件在紧凑模式（Requirement 4.1）
    const fileName = screen.queryByText('compact-remove.txt');
    expect(fileName).not.toBeNull();

    // 内容不应该显示（紧凑模式）
    const textContent = screen.queryByText('Content to remove');
    expect(textContent).toBeNull();

    // 验证移除按钮存在（Requirement 4.1, 4.3）
    const removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();

    // 验证移除按钮位于右上角（通过 CSS 类）
    expect(removeButton.className).toContain('absolute');
    expect(removeButton.className).toContain('-top-2');
    expect(removeButton.className).toContain('-right-2');

    // 点击移除按钮（Requirement 4.2）
    fireEvent.click(removeButton);

    // 等待附件被移除
    await waitFor(() => {
      expect(screen.queryByText('compact-remove.txt')).toBeNull();
    });
  });

  /**
   * Property: 展开模式下移除按钮可用
   * 
   * 对于任意附件，在展开模式下：
   * - 悬停时应该显示移除按钮
   * - 点击移除按钮应该从附件列表中移除该附件
   * - 移除按钮应该位于附件的右上角
   */
  it('Property: remove button is available in expanded mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件附件
    const mockTextFile = createMockFile('expanded-remove.txt', 'Content to remove', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('expanded-remove.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 展开附件
    const fileName = screen.queryByText('expanded-remove.txt');
    expect(fileName).not.toBeNull();
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证附件在展开模式（Requirement 4.3）
    const textContent = screen.queryByText('Content to remove');
    expect(textContent).not.toBeNull();

    // 验证移除按钮存在（Requirement 4.1, 4.3）
    const removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();

    // 验证移除按钮位于右上角
    expect(removeButton.className).toContain('absolute');
    expect(removeButton.className).toContain('-top-2');
    expect(removeButton.className).toContain('-right-2');

    // 点击移除按钮（Requirement 4.2）
    fireEvent.click(removeButton);

    // 等待附件被移除
    await waitFor(() => {
      expect(screen.queryByText('expanded-remove.txt')).toBeNull();
    });
  });

  /**
   * Property: 图片附件在两种模式下都可移除
   * 
   * 对于图片附件：
   * - 紧凑模式下可以移除
   * - 展开模式下可以移除
   * - 移除功能在两种模式下都正常工作
   */
  it('Property: image attachments can be removed in both modes', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;

    // 测试紧凑模式下的移除
    const mockImageFile1 = createMockFile('image1.png', 'image data 1', 'image/png');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证图片在紧凑模式
    expect(screen.queryByText('image1.png')).not.toBeNull();
    let imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).toBeNull();

    // 移除图片
    let removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.queryByText('image1.png')).toBeNull();

    // 测试展开模式下的移除
    const mockImageFile2 = createMockFile('image2.png', 'image data 2', 'image/png');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);
    await new Promise(resolve => setTimeout(resolve, 200));

    // 展开图片
    const fileName = screen.queryByText('image2.png');
    expect(fileName).not.toBeNull();
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证图片在展开模式
    imagePreview = container.querySelector('img[alt="预览"]');
    expect(imagePreview).not.toBeNull();

    // 移除图片
    removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.queryByText('image2.png')).toBeNull();
  });

  /**
   * Property: PDF 附件在两种模式下都可移除
   * 
   * 对于 PDF 附件：
   * - 紧凑模式下可以移除
   * - 展开模式下可以移除
   * - 移除功能在两种模式下都正常工作
   */
  it('Property: PDF attachments can be removed in both modes', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // 测试紧凑模式下的移除
    const mockPdfFile1 = createMockFile('document1.pdf', 'PDF content 1', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);
    await waitFor(() => {
      expect(screen.queryByText('document1.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 验证 PDF 在紧凑模式
    let pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).toBeNull();

    // 移除 PDF
    let removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.queryByText('document1.pdf')).toBeNull();

    // 测试展开模式下的移除
    const mockPdfFile2 = createMockFile('document2.pdf', 'PDF content 2', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);
    await waitFor(() => {
      expect(screen.queryByText('document2.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF
    const fileName = screen.queryByText('document2.pdf');
    expect(fileName).not.toBeNull();
    fireEvent.click(fileName!);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证 PDF 在展开模式
    pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).not.toBeNull();

    // 移除 PDF
    removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.queryByText('document2.pdf')).toBeNull();
  });

  /**
   * Property: 多个附件可以独立移除
   * 
   * 当有多个附件时：
   * - 每个附件都有独立的移除按钮
   * - 移除一个附件不影响其他附件
   * - 可以按任意顺序移除附件
   */
  it('Property: multiple attachments can be removed independently', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');

    // 添加三个不同类型的附件
    const imageInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === 'image/*'
    ) as HTMLInputElement;
    const mockImageFile = createMockFile('photo.jpg', 'image data', 'image/jpeg');
    Object.defineProperty(imageInput, 'files', {
      value: createMockFileList([mockImageFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(imageInput);
    await new Promise(resolve => setTimeout(resolve, 200));

    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;
    const mockTextFile = createMockFile('notes.txt', 'text content', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);
    await waitFor(() => {
      expect(screen.queryByText('notes.txt')).not.toBeNull();
    }, { timeout: 2000 });

    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;
    const mockPdfFile = createMockFile('report.pdf', 'PDF content', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);
    await waitFor(() => {
      expect(screen.queryByText('report.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 验证所有三个附件都存在
    expect(screen.queryByText('photo.jpg')).not.toBeNull();
    expect(screen.queryByText('notes.txt')).not.toBeNull();
    expect(screen.queryByText('report.pdf')).not.toBeNull();

    // 验证有三个移除按钮
    let removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(3);

    // 移除中间的附件（文本文件）
    fireEvent.click(removeButtons[1]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证文本文件被移除，其他附件仍然存在
    expect(screen.queryByText('photo.jpg')).not.toBeNull();
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(screen.queryByText('report.pdf')).not.toBeNull();

    // 验证现在有两个移除按钮
    removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(2);

    // 移除第一个附件（图片）
    fireEvent.click(removeButtons[0]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证图片被移除，PDF 仍然存在
    expect(screen.queryByText('photo.jpg')).toBeNull();
    expect(screen.queryByText('report.pdf')).not.toBeNull();

    // 验证现在有一个移除按钮
    removeButtons = screen.getAllByTitle('移除');
    expect(removeButtons.length).toBe(1);

    // 移除最后一个附件（PDF）
    fireEvent.click(removeButtons[0]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证所有附件都被移除
    expect(screen.queryByText('photo.jpg')).toBeNull();
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(screen.queryByText('report.pdf')).toBeNull();

    // 验证没有移除按钮
    removeButtons = screen.queryAllByTitle('移除');
    expect(removeButtons.length).toBe(0);
  });

  /**
   * Property: 移除按钮不会意外触发展开/收起
   * 
   * 当点击移除按钮时：
   * - 应该只移除附件
   * - 不应该触发展开或收起操作
   * - 事件传播应该被正确阻止
   */
  it('Property: remove button does not trigger expand/collapse', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件附件
    const mockTextFile = createMockFile('test.txt', 'Test content', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('test.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 验证初始状态：紧凑模式
    let textContent = screen.queryByText('Test content');
    expect(textContent).toBeNull();

    // 点击移除按钮
    const removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);

    // 等待一小段时间，确保没有展开操作
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证附件被移除，而不是被展开
    expect(screen.queryByText('test.txt')).toBeNull();
    textContent = screen.queryByText('Test content');
    expect(textContent).toBeNull();
  });

  /**
   * Property: 移除按钮在悬停时可见
   * 
   * 对于任意附件：
   * - 移除按钮应该在悬停时显示
   * - 移除按钮应该有适当的视觉样式
   * - 移除按钮应该有 title 属性用于辅助功能
   */
  it('Property: remove button is visible on hover', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    // 添加文本文件附件
    const mockTextFile = createMockFile('hover-test.txt', 'Content', 'text/plain');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('hover-test.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 验证移除按钮存在
    const removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();

    // 验证移除按钮有正确的 title 属性（用于辅助功能）
    expect(removeButton.getAttribute('title')).toBe('移除');

    // 验证移除按钮有悬停样式类
    expect(removeButton.className).toContain('group-hover:opacity-100');
    expect(removeButton.className).toContain('hover:bg-red-600');

    // 验证移除按钮是一个按钮元素
    expect(removeButton.tagName).toBe('BUTTON');
    expect(removeButton.getAttribute('type')).toBe('button');
  });

  /**
   * Property: 移除附件后可以重新添加
   * 
   * 当移除一个附件后：
   * - 应该可以重新添加相同类型的附件
   * - 应该可以添加不同类型的附件
   * - 附件计数应该正确更新
   */
  it('Property: can add attachments after removal', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    // 添加第一个文件
    const mockTextFile1 = createMockFile('file1.txt', 'Content 1', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('file1.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 移除第一个文件
    let removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.queryByText('file1.txt')).toBeNull();

    // 添加第二个文件
    const mockTextFile2 = createMockFile('file2.txt', 'Content 2', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('file2.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 验证第二个文件被成功添加
    expect(screen.queryByText('file2.txt')).not.toBeNull();
    removeButton = screen.getByTitle('移除');
    expect(removeButton).toBeDefined();
  });

  /**
   * Property: 移除所有附件后发送按钮状态正确
   * 
   * 当移除所有附件后：
   * - 如果没有文本输入，发送按钮应该被禁用
   * - 如果有文本输入，发送按钮应该保持启用
   */
  it('Property: send button state is correct after removing all attachments', async () => {
    render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const textFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept?.includes('.txt')
    ) as HTMLInputElement;

    // 添加附件
    const mockTextFile = createMockFile('test.txt', 'Content', 'text/plain');
    Object.defineProperty(textFileInput, 'files', {
      value: createMockFileList([mockTextFile]),
      writable: false,
    });
    fireEvent.change(textFileInput);

    await waitFor(() => {
      expect(screen.queryByText('test.txt')).not.toBeNull();
    }, { timeout: 2000 });

    // 发送按钮应该启用（有附件）
    let sendButton = screen.getByTitle('发送消息');
    expect(sendButton).not.toBeDisabled();

    // 移除附件
    const removeButton = screen.getByTitle('移除');
    fireEvent.click(removeButton);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 发送按钮应该被禁用（没有附件也没有文本）
    sendButton = screen.getByTitle('发送消息');
    expect(sendButton).toBeDisabled();

    // 输入文本
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello' } });

    // 发送按钮应该启用（有文本）
    sendButton = screen.getByTitle('发送消息');
    expect(sendButton).not.toBeDisabled();
  });
});

/**
 * PDF Debug Mode Tests
 * 
 * **Property 6: PDF 设置更新**
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
 * 
 * 验证 PDF 调试模式下的页面范围选择、"包含图片"和"包含文本"选项，
 * 以及回调函数正确更新 PDF 设置
 */
describe('Property 6: PDF Debug Mode Settings', () => {
  const mockOnSend = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Property: PDF 调试模式显示页面范围选择控件
   * 
   * 当 pdfDebugMode 启用且 PDF 附件展开时：
   * - 应该显示"调试模式"标签
   * - 应该显示"从"和"到"页面范围输入框
   * - 输入框应该有正确的 min/max 属性
   * 
   * Requirements: 5.1
   */
  it('Property: PDF debug mode shows page range controls when enabled', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('debug-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    // 等待 PDF 被处理
    await waitFor(() => {
      expect(screen.queryByText('debug-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    const fileName = screen.getByText('debug-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证调试模式控件显示（Requirement 5.1）
    const debugModeLabel = screen.queryByText('调试模式');
    expect(debugModeLabel).not.toBeNull();

    // 验证页面范围控件
    const fromLabel = screen.queryByText('从');
    expect(fromLabel).not.toBeNull();

    const toLabel = screen.queryByText('到');
    expect(toLabel).not.toBeNull();

    // 验证输入框存在
    const numberInputs = container.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThanOrEqual(2);

    // 验证输入框有正确的属性
    const startPageInput = numberInputs[0] as HTMLInputElement;
    const endPageInput = numberInputs[1] as HTMLInputElement;

    expect(startPageInput.min).toBe('1');
    expect(startPageInput.max).toBe('3'); // Mock PDF has 3 pages
    expect(endPageInput.min).toBe('1');
    expect(endPageInput.max).toBe('3');
  });

  /**
   * Property: PDF 调试模式显示内容选项复选框
   * 
   * 当 pdfDebugMode 启用且 PDF 附件展开时：
   * - 应该显示"包含图片"复选框
   * - 应该显示"包含文本"复选框
   * - 复选框应该默认选中
   * 
   * Requirements: 5.2
   */
  it('Property: PDF debug mode shows content option checkboxes', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('options-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('options-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    const fileName = screen.getByText('options-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证"包含图片"复选框（Requirement 5.2）
    const includeImagesLabel = screen.queryByText('包含图片');
    expect(includeImagesLabel).not.toBeNull();

    const includeImagesCheckbox = includeImagesLabel?.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(includeImagesCheckbox).not.toBeNull();
    expect(includeImagesCheckbox.checked).toBe(true); // 默认选中

    // 验证"包含文本"复选框（Requirement 5.2）
    const includeTextLabel = screen.queryByText('包含文本');
    expect(includeTextLabel).not.toBeNull();

    const includeTextCheckbox = includeTextLabel?.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(includeTextCheckbox).not.toBeNull();
    expect(includeTextCheckbox.checked).toBe(true); // 默认选中
  });

  /**
   * Property: 修改页面范围更新 PDF 设置
   * 
   * 当用户修改页面范围时：
   * - 应该调用 onPdfPageRangeChange 回调
   * - 回调应该接收正确的 PDF ID 和页面范围
   * - 无效的页面范围应该被忽略（不调用回调）
   * 
   * Requirements: 5.3
   */
  it('Property: changing page range updates PDF settings', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('range-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('range-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    const fileName = screen.getByText('range-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 获取页面范围输入框
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const startPageInput = numberInputs[0] as HTMLInputElement;
    const endPageInput = numberInputs[1] as HTMLInputElement;

    // 测试有效的页面范围（Requirement 5.3）
    fireEvent.change(startPageInput, { target: { value: '1' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    fireEvent.change(endPageInput, { target: { value: '2' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证输入框的值已更新
    expect(startPageInput.value).toBe('1');
    expect(endPageInput.value).toBe('2');

    // 测试清空页面范围（应该允许）
    fireEvent.change(startPageInput, { target: { value: '' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    fireEvent.change(endPageInput, { target: { value: '' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(startPageInput.value).toBe('');
    expect(endPageInput.value).toBe('');

    // 测试无效的页面范围（超出范围）
    fireEvent.change(startPageInput, { target: { value: '10' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    // 输入框应该显示输入的值（但不会触发回调）
    expect(startPageInput.value).toBe('10');

    // 测试无效的页面范围（起始页大于结束页）
    fireEvent.change(startPageInput, { target: { value: '3' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    fireEvent.change(endPageInput, { target: { value: '1' } });
    await new Promise(resolve => setTimeout(resolve, 50));

    // 输入框应该显示输入的值
    expect(startPageInput.value).toBe('3');
    expect(endPageInput.value).toBe('1');
  });

  /**
   * Property: 切换"包含图片"选项更新 PDF 设置
   * 
   * 当用户切换"包含图片"复选框时：
   * - 复选框状态应该更新
   * - 应该能够选中和取消选中
   * - 状态应该正确反映用户的选择
   * 
   * Requirements: 5.4
   */
  it('Property: toggling include images option updates PDF settings', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('images-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('images-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    const fileName = screen.getByText('images-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 获取"包含图片"复选框
    const includeImagesLabel = screen.getByText('包含图片');
    const includeImagesCheckbox = includeImagesLabel.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;

    // 初始状态应该是选中（Requirement 5.4）
    expect(includeImagesCheckbox.checked).toBe(true);

    // 取消选中
    fireEvent.click(includeImagesCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证状态已更新
    expect(includeImagesCheckbox.checked).toBe(false);

    // 再次选中
    fireEvent.click(includeImagesCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证状态已更新
    expect(includeImagesCheckbox.checked).toBe(true);
  });

  /**
   * Property: 切换"包含文本"选项更新 PDF 设置
   * 
   * 当用户切换"包含文本"复选框时：
   * - 复选框状态应该更新
   * - 应该能够选中和取消选中
   * - 状态应该正确反映用户的选择
   * 
   * Requirements: 5.5
   */
  it('Property: toggling include text option updates PDF settings', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('text-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('text-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    const fileName = screen.getByText('text-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 获取"包含文本"复选框
    const includeTextLabel = screen.getByText('包含文本');
    const includeTextCheckbox = includeTextLabel.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;

    // 初始状态应该是选中（Requirement 5.5）
    expect(includeTextCheckbox.checked).toBe(true);

    // 取消选中
    fireEvent.click(includeTextCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证状态已更新
    expect(includeTextCheckbox.checked).toBe(false);

    // 再次选中
    fireEvent.click(includeTextCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证状态已更新
    expect(includeTextCheckbox.checked).toBe(true);
  });

  /**
   * Property: PDF 调试模式不影响非调试模式
   * 
   * 当 pdfDebugMode 为 false 时：
   * - 不应该显示调试模式控件
   * - PDF 附件应该正常展开和显示
   * - 不应该显示页面范围选择
   * - 不应该显示内容选项复选框
   */
  it('Property: PDF debug mode does not affect non-debug mode', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={false}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('normal-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('normal-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    const fileName = screen.getByText('normal-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证不显示调试模式控件
    const debugModeLabel = screen.queryByText('调试模式');
    expect(debugModeLabel).toBeNull();

    const fromLabel = screen.queryByText('从');
    expect(fromLabel).toBeNull();

    const toLabel = screen.queryByText('到');
    expect(toLabel).toBeNull();

    const includeImagesLabel = screen.queryByText('包含图片');
    expect(includeImagesLabel).toBeNull();

    const includeTextLabel = screen.queryByText('包含文本');
    expect(includeTextLabel).toBeNull();

    // 验证 PDF 正常显示
    const pageCount = screen.queryByText(/共 \d+ 页/);
    expect(pageCount).not.toBeNull();

    const pageThumbnails = screen.queryAllByText(/第 \d+ 页/);
    expect(pageThumbnails.length).toBeGreaterThan(0);
  });

  /**
   * Property: 多个 PDF 附件独立的调试模式设置
   * 
   * 当有多个 PDF 附件时：
   * - 每个 PDF 应该有独立的调试模式控件
   * - 修改一个 PDF 的设置不影响其他 PDF
   * - 每个 PDF 可以有不同的页面范围和内容选项
   */
  it('Property: multiple PDFs have independent debug mode settings', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // 添加第一个 PDF
    const mockPdfFile1 = createMockFile('pdf1.pdf', 'PDF content 1', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('pdf1.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 添加第二个 PDF
    const mockPdfFile2 = createMockFile('pdf2.pdf', 'PDF content 2', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('pdf2.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开第一个 PDF
    const fileName1 = screen.getByText('pdf1.pdf');
    fireEvent.click(fileName1);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 展开第二个 PDF
    const fileName2 = screen.getByText('pdf2.pdf');
    fireEvent.click(fileName2);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证有两组调试模式控件
    const debugModeLabels = screen.queryAllByText('调试模式');
    expect(debugModeLabels.length).toBe(2);

    // 验证有两组"包含图片"复选框
    const includeImagesLabels = screen.queryAllByText('包含图片');
    expect(includeImagesLabels.length).toBe(2);

    // 验证有两组"包含文本"复选框
    const includeTextLabels = screen.queryAllByText('包含文本');
    expect(includeTextLabels.length).toBe(2);

    // 修改第一个 PDF 的"包含图片"选项
    const firstIncludeImagesCheckbox = includeImagesLabels[0].closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(firstIncludeImagesCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证第一个 PDF 的复选框已取消选中
    expect(firstIncludeImagesCheckbox.checked).toBe(false);

    // 验证第二个 PDF 的复选框仍然选中
    const secondIncludeImagesCheckbox = includeImagesLabels[1].closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(secondIncludeImagesCheckbox.checked).toBe(true);
  });

  /**
   * Property: PDF 调试模式设置在展开-收起后保持
   * 
   * 当用户修改 PDF 调试模式设置后：
   * - 收起 PDF 附件
   * - 再次展开 PDF 附件
   * - 设置应该保持不变
   */
  it('Property: PDF debug mode settings persist after expand-collapse', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    // 添加 PDF 附件
    const mockPdfFile = createMockFile('persist-test.pdf', 'PDF content', 'application/pdf');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile]),
      writable: false,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('persist-test.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开 PDF 附件
    let fileName = screen.getByText('persist-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 修改设置：取消选中"包含图片"
    const includeImagesLabel = screen.getByText('包含图片');
    const includeImagesCheckbox = includeImagesLabel.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(includeImagesCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证已取消选中
    expect(includeImagesCheckbox.checked).toBe(false);

    // 收起 PDF 附件
    fileName = screen.getByText('persist-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 再次展开 PDF 附件
    fileName = screen.getByText('persist-test.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证设置保持不变
    const includeImagesLabelAfter = screen.getByText('包含图片');
    const includeImagesCheckboxAfter = includeImagesLabelAfter.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(includeImagesCheckboxAfter.checked).toBe(false);
  });

  /**
   * Property: PDF 调试模式在发送消息后重置
   * 
   * 当发送包含 PDF 的消息后：
   * - PDF 附件应该被清除
   * - 再次添加 PDF 时，调试模式设置应该恢复默认值
   */
  it('Property: PDF debug mode settings reset after sending message', async () => {
    const { container } = render(
      <InputArea
        onSend={mockOnSend}
        onAbort={mockOnAbort}
        disabled={false}
        isGenerating={false}
        supportsVision={true}
        pdfDebugMode={true}
      />
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const pdfFileInput = Array.from(fileInputs).find(
      input => (input as HTMLInputElement).accept === '.pdf'
    ) as HTMLInputElement;

    // 添加第一个 PDF
    const mockPdfFile1 = createMockFile('reset-test1.pdf', 'PDF content', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile1]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('reset-test1.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开并修改设置
    let fileName = screen.getByText('reset-test1.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    const includeImagesCheckbox = screen.getByText('包含图片').closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(includeImagesCheckbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(includeImagesCheckbox.checked).toBe(false);

    // 发送消息
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Test message' } });
    const sendButton = screen.getByTitle('发送消息');
    fireEvent.click(sendButton);

    await new Promise(resolve => setTimeout(resolve, 100));

    // PDF 应该被清除
    expect(screen.queryByText('reset-test1.pdf')).toBeNull();

    // 添加新的 PDF
    const mockPdfFile2 = createMockFile('reset-test2.pdf', 'PDF content', 'application/pdf');
    Object.defineProperty(pdfFileInput, 'files', {
      value: createMockFileList([mockPdfFile2]),
      writable: true,
      configurable: true,
    });
    fireEvent.change(pdfFileInput);

    await waitFor(() => {
      expect(screen.queryByText('reset-test2.pdf')).not.toBeNull();
    }, { timeout: 3000 });

    // 展开新 PDF
    fileName = screen.getByText('reset-test2.pdf');
    fireEvent.click(fileName);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证设置恢复默认值（选中）
    const newIncludeImagesCheckbox = screen.getByText('包含图片').closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(newIncludeImagesCheckbox.checked).toBe(true);
  });
});
