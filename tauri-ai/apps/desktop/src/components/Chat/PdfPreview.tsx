/**
 * PdfPreview Component
 * Displays a preview card for pending PDF document attachments
 * Requirements: 5.1, 5.2, 5.3, 5.5, 5.6
 */

import React from 'react';
import { FileText, X } from 'lucide-react';
import type { PendingPdf } from '../../types';

/**
 * Maximum number of page thumbnails to display
 */
export const MAX_THUMBNAIL_DISPLAY = 6;

/**
 * Format file size for display
 * @param bytes - File size in bytes
 * @returns Formatted size string (e.g., "1.5 KB", "2.3 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PdfPreviewProps {
  pdf: PendingPdf;
  onRemove: (id: string) => void;
  pdfDebugMode?: boolean;
  onPageRangeChange?: (id: string, startPage?: number, endPage?: number) => void;
  onIncludeImagesChange?: (id: string, includeImages: boolean) => void;
  onIncludeTextChange?: (id: string, includeText: boolean) => void;
}

/**
 * PDF preview card component
 * - Displays PDF file icon and filename (Requirement 5.1)
 * - Shows processing progress bar (Requirement 5.2)
 * - Shows page thumbnail grid (up to 6 pages) (Requirement 5.3)
 * - Shows total page count information (Requirement 5.5)
 * - Provides remove button (Requirement 5.6)
 * - Provides page range selection in debug mode
 */
export const PdfPreview: React.FC<PdfPreviewProps> = ({ 
  pdf, 
  onRemove, 
  pdfDebugMode = false,
  onPageRangeChange,
  onIncludeImagesChange,
  onIncludeTextChange 
}) => {
  const formattedSize = formatFileSize(pdf.size);
  const isProcessing = pdf.processingProgress < 100;
  
  // Get pages to display (max 6)
  const displayPages = pdf.pages.slice(0, MAX_THUMBNAIL_DISPLAY);
  const hasMorePages = pdf.totalPages > MAX_THUMBNAIL_DISPLAY;
  
  // Local state for page range inputs
  const [startPage, setStartPage] = React.useState<string>(pdf.pageRangeStart?.toString() || '');
  const [endPage, setEndPage] = React.useState<string>(pdf.pageRangeEnd?.toString() || '');
  const [includeImages, setIncludeImages] = React.useState<boolean>(pdf.includeImages ?? true);
  const [includeText, setIncludeText] = React.useState<boolean>(pdf.includeText ?? true);
  
  // Handle page range change
  const handlePageRangeChange = React.useCallback((start: string, end: string) => {
    setStartPage(start);
    setEndPage(end);
    
    if (!onPageRangeChange) return;
    
    const startNum = start ? parseInt(start, 10) : undefined;
    const endNum = end ? parseInt(end, 10) : undefined;
    
    // Validate range
    if (startNum !== undefined && (startNum < 1 || startNum > pdf.totalPages)) return;
    if (endNum !== undefined && (endNum < 1 || endNum > pdf.totalPages)) return;
    if (startNum !== undefined && endNum !== undefined && startNum > endNum) return;
    
    onPageRangeChange(pdf.id, startNum, endNum);
  }, [pdf.id, pdf.totalPages, onPageRangeChange]);
  
  // Handle include images change
  const handleIncludeImagesChange = React.useCallback((checked: boolean) => {
    setIncludeImages(checked);
    if (onIncludeImagesChange) {
      onIncludeImagesChange(pdf.id, checked);
    }
  }, [pdf.id, onIncludeImagesChange]);

  // Handle include text change
  const handleIncludeTextChange = React.useCallback((checked: boolean) => {
    setIncludeText(checked);
    if (onIncludeTextChange) {
      onIncludeTextChange(pdf.id, checked);
    }
  }, [pdf.id, onIncludeTextChange]);
  
  // Tooltip text with full filename, size, and metadata
  const tooltipParts = [
    pdf.filename,
    formattedSize,
    `${pdf.totalPages} 页`,
  ];
  
  if (pdf.metadata?.title) {
    tooltipParts.push(`标题: ${pdf.metadata.title}`);
  }
  if (pdf.metadata?.author) {
    tooltipParts.push(`作者: ${pdf.metadata.author}`);
  }
  
  const tooltipText = tooltipParts.join(' | ');

  return (
    <div 
      className="relative group bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 p-3 max-w-2xl"
      title={tooltipText}
    >
      {/* Header: Icon, filename, size, and page count */}
      <div className="flex items-center gap-2 mb-2">
        <FileText 
          size={16} 
          className="text-red-500 dark:text-red-400 flex-shrink-0" 
        />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate flex-1">
          {pdf.filename}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
          {formattedSize}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
          {pdf.totalPages} 页
        </span>
      </div>

      {/* Metadata (if available) */}
      {(pdf.metadata?.title || pdf.metadata?.author) && (
        <div className="text-xs text-gray-600 dark:text-gray-400 mb-2 space-y-0.5">
          {pdf.metadata.title && (
            <div className="truncate">
              <span className="font-medium">标题:</span> {pdf.metadata.title}
            </div>
          )}
          {pdf.metadata.author && (
            <div className="truncate">
              <span className="font-medium">作者:</span> {pdf.metadata.author}
            </div>
          )}
        </div>
      )}

      {/* Debug mode: Page range selection */}
      {pdfDebugMode && (
        <div className="mb-2 p-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded">
          <div className="text-xs font-medium text-yellow-800 dark:text-yellow-300 mb-2">
            调试模式: 页面范围选择
          </div>
          <div className="flex items-center gap-2 mb-2">
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-600 dark:text-gray-400">从</label>
              <input
                type="number"
                min="1"
                max={pdf.totalPages}
                value={startPage}
                onChange={(e) => handlePageRangeChange(e.target.value, endPage)}
                placeholder="1"
                className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-600 dark:text-gray-400">到</label>
              <input
                type="number"
                min="1"
                max={pdf.totalPages}
                value={endPage}
                onChange={(e) => handlePageRangeChange(startPage, e.target.value)}
                placeholder={pdf.totalPages.toString()}
                className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              (共 {pdf.totalPages} 页)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`include-images-${pdf.id}`}
              checked={includeImages}
              onChange={(e) => handleIncludeImagesChange(e.target.checked)}
              className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
            />
            <label 
              htmlFor={`include-images-${pdf.id}`}
              className="text-xs text-gray-700 dark:text-gray-300 cursor-pointer"
            >
              包含图片
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`include-text-${pdf.id}`}
              checked={includeText}
              onChange={(e) => handleIncludeTextChange(e.target.checked)}
              className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
            />
            <label 
              htmlFor={`include-text-${pdf.id}`}
              className="text-xs text-gray-700 dark:text-gray-300 cursor-pointer"
            >
              包含文本
            </label>
          </div>
        </div>
      )}

      {/* Processing progress bar */}
      {isProcessing && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
            <span>处理中...</span>
            <span>{Math.round(pdf.processingProgress)}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-1.5 overflow-hidden">
            <div 
              className="bg-blue-500 dark:bg-blue-400 h-full transition-all duration-300 ease-out"
              style={{ width: `${pdf.processingProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Page thumbnails grid */}
      {displayPages.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-600 dark:text-gray-400 font-medium">
            页面预览:
          </div>
          <div className="grid grid-cols-3 gap-2">
            {displayPages.map((page) => (
              <div 
                key={page.pageNumber}
                className="relative aspect-[3/4] bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-600 overflow-hidden group/thumb cursor-pointer transition-all duration-200 hover:shadow-lg hover:scale-105 hover:border-blue-400 dark:hover:border-blue-500"
              >
                <img 
                  src={page.image}
                  alt={`第 ${page.pageNumber} 页`}
                  className="w-full h-full object-contain transition-transform duration-200 group-hover/thumb:scale-110"
                />
                {/* Page number overlay */}
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs py-0.5 text-center transition-colors duration-200 group-hover/thumb:bg-black/70">
                  第 {page.pageNumber} 页
                </div>
                {/* Hover overlay effect */}
                <div className="absolute inset-0 bg-blue-500/0 group-hover/thumb:bg-blue-500/10 transition-colors duration-200 pointer-events-none" />
              </div>
            ))}
          </div>
          
          {/* More pages indicator */}
          {hasMorePages && (
            <div className="text-xs text-gray-500 dark:text-gray-400 text-center italic">
              还有 {pdf.totalPages - MAX_THUMBNAIL_DISPLAY} 页未显示
            </div>
          )}
        </div>
      )}

      {/* Remove button */}
      <button
        type="button"
        onClick={() => onRemove(pdf.id)}
        className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        title="移除 PDF"
        aria-label={`移除 ${pdf.filename}`}
      >
        <X size={12} />
      </button>
    </div>
  );
};

export default PdfPreview;
