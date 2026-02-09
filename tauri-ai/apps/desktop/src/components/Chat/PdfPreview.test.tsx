/**
 * Unit tests for PdfPreview component
 * Requirements: 5.1, 5.2, 5.3, 5.5, 5.6
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PdfPreview, formatFileSize, MAX_THUMBNAIL_DISPLAY } from './PdfPreview';
import type { PendingPdf } from '../../types';

describe('PdfPreview', () => {
  // Helper to create a mock PendingPdf
  const createMockPdf = (overrides?: Partial<PendingPdf>): PendingPdf => ({
    id: 'test-pdf-1',
    filename: 'test-document.pdf',
    size: 1024 * 1024, // 1 MB
    pages: [
      {
        pageNumber: 1,
        text: 'Page 1 content',
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
      {
        pageNumber: 2,
        text: 'Page 2 content',
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    ],
    totalPages: 2,
    processingProgress: 100,
    ...overrides,
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });
  });

  describe('Component Rendering', () => {
    it('should display PDF filename (Requirement 5.1)', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('test-document.pdf')).toBeInTheDocument();
    });

    it('should display file size (Requirement 5.1)', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('1.0 MB')).toBeInTheDocument();
    });

    it('should display total page count (Requirement 5.5)', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('2 页')).toBeInTheDocument();
    });

    it('should display PDF metadata when available (Requirement 5.1)', () => {
      const pdf = createMockPdf({
        metadata: {
          title: 'Test Document Title',
          author: 'Test Author',
        },
      });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText(/标题:/)).toBeInTheDocument();
      expect(screen.getByText(/Test Document Title/)).toBeInTheDocument();
      expect(screen.getByText(/作者:/)).toBeInTheDocument();
      expect(screen.getByText(/Test Author/)).toBeInTheDocument();
    });

    it('should not display metadata section when metadata is not available', () => {
      const pdf = createMockPdf({ metadata: undefined });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.queryByText(/标题:/)).not.toBeInTheDocument();
      expect(screen.queryByText(/作者:/)).not.toBeInTheDocument();
    });
  });

  describe('Processing Progress (Requirement 5.2)', () => {
    it('should display progress bar when processing is incomplete', () => {
      const pdf = createMockPdf({ processingProgress: 50 });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('处理中...')).toBeInTheDocument();
      expect(screen.getByText('50%')).toBeInTheDocument();
    });

    it('should not display progress bar when processing is complete', () => {
      const pdf = createMockPdf({ processingProgress: 100 });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.queryByText('处理中...')).not.toBeInTheDocument();
    });

    it('should update progress bar width based on progress percentage', () => {
      const pdf = createMockPdf({ processingProgress: 75 });
      const onRemove = vi.fn();
      
      const { container } = render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const progressBar = container.querySelector('.bg-blue-500');
      expect(progressBar).toHaveStyle({ width: '75%' });
    });
  });

  describe('Page Thumbnails (Requirement 5.3)', () => {
    it('should display page thumbnails', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('页面预览:')).toBeInTheDocument();
      expect(screen.getByAltText('第 1 页')).toBeInTheDocument();
      expect(screen.getByAltText('第 2 页')).toBeInTheDocument();
    });

    it('should display page numbers on thumbnails', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('第 1 页')).toBeInTheDocument();
      expect(screen.getByText('第 2 页')).toBeInTheDocument();
    });

    it('should display at most MAX_THUMBNAIL_DISPLAY thumbnails', () => {
      const pages = Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        text: `Page ${i + 1} content`,
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      }));
      
      const pdf = createMockPdf({ pages, totalPages: 10 });
      const onRemove = vi.fn();
      
      const { container } = render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const thumbnails = container.querySelectorAll('img[alt^="第"]');
      expect(thumbnails).toHaveLength(MAX_THUMBNAIL_DISPLAY);
    });

    it('should show "more pages" indicator when total pages exceed MAX_THUMBNAIL_DISPLAY', () => {
      const pages = Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        text: `Page ${i + 1} content`,
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      }));
      
      const pdf = createMockPdf({ pages, totalPages: 10 });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const remainingPages = 10 - MAX_THUMBNAIL_DISPLAY;
      expect(screen.getByText(`还有 ${remainingPages} 页未显示`)).toBeInTheDocument();
    });

    it('should not show "more pages" indicator when total pages <= MAX_THUMBNAIL_DISPLAY', () => {
      const pdf = createMockPdf({ totalPages: 3 });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.queryByText(/还有.*页未显示/)).not.toBeInTheDocument();
    });
  });

  describe('Remove Button (Requirement 5.6)', () => {
    it('should display remove button', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const removeButton = screen.getByRole('button', { name: /移除 test-document.pdf/ });
      expect(removeButton).toBeInTheDocument();
    });

    it('should call onRemove with PDF id when remove button is clicked', async () => {
      const user = userEvent.setup();
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const removeButton = screen.getByRole('button', { name: /移除 test-document.pdf/ });
      await user.click(removeButton);
      
      expect(onRemove).toHaveBeenCalledWith('test-pdf-1');
      expect(onRemove).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tooltip (Requirement 5.1)', () => {
    it('should include filename, size, and page count in tooltip', () => {
      const pdf = createMockPdf();
      const onRemove = vi.fn();
      
      const { container } = render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const previewCard = container.querySelector('.group');
      expect(previewCard).toHaveAttribute('title');
      
      const tooltip = previewCard?.getAttribute('title') || '';
      expect(tooltip).toContain('test-document.pdf');
      expect(tooltip).toContain('1.0 MB');
      expect(tooltip).toContain('2 页');
    });

    it('should include metadata in tooltip when available', () => {
      const pdf = createMockPdf({
        metadata: {
          title: 'Test Document Title',
          author: 'Test Author',
        },
      });
      const onRemove = vi.fn();
      
      const { container } = render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      const previewCard = container.querySelector('.group');
      const tooltip = previewCard?.getAttribute('title') || '';
      
      expect(tooltip).toContain('标题: Test Document Title');
      expect(tooltip).toContain('作者: Test Author');
    });
  });

  describe('Edge Cases', () => {
    it('should handle PDF with no pages', () => {
      const pdf = createMockPdf({ pages: [], totalPages: 0 });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('test-document.pdf')).toBeInTheDocument();
      expect(screen.getByText('0 页')).toBeInTheDocument();
      expect(screen.queryByText('页面预览:')).not.toBeInTheDocument();
    });

    it('should handle very large file sizes', () => {
      const pdf = createMockPdf({ size: 20 * 1024 * 1024 }); // 20 MB
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('20.0 MB')).toBeInTheDocument();
    });

    it('should handle progress at 0%', () => {
      const pdf = createMockPdf({ processingProgress: 0 });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText('处理中...')).toBeInTheDocument();
      expect(screen.getByText('0%')).toBeInTheDocument();
    });

    it('should handle long filenames gracefully', () => {
      const longFilename = 'very-long-filename-that-should-be-truncated-in-the-ui-display.pdf';
      const pdf = createMockPdf({ filename: longFilename });
      const onRemove = vi.fn();
      
      render(<PdfPreview pdf={pdf} onRemove={onRemove} />);
      
      expect(screen.getByText(longFilename)).toBeInTheDocument();
    });
  });
});
