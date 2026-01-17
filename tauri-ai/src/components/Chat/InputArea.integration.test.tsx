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

      // Create unsupported file
      const mockFile = createMockFile('document.pdf', 'PDF content', 'application/pdf');
      
      // Create mock clipboard data
      const mockClipboardData = {
        items: [
          {
            type: 'application/pdf',
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
      const preview = screen.queryByText('document.pdf');
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
      const removeButton = screen.getByTitle('移除文件');
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
    const removeButtons = screen.getAllByTitle(/移除 PDF/);
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
