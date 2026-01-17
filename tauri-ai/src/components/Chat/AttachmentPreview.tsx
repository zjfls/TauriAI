/**
 * AttachmentPreview Component
 * Unified preview component for all attachment types (images, text files, PDFs)
 * Displays as compact icons by default, expands on click to show details
 */

import React, { useState } from 'react';
import { FileText, Image as ImageIcon, X, ChevronDown, ChevronRight } from 'lucide-react';
import type { PendingImage, PendingTextFile, PendingPdf } from '../../types';

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Truncate content for preview
 */
function truncateContent(content: string, maxChars: number = 500): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '...';
}

interface AttachmentPreviewProps {
  attachment: PendingImage | PendingTextFile | PendingPdf;
  type: 'image' | 'text' | 'pdf';
  onRemove: (id: string) => void;
  pdfDebugMode?: boolean;
  onPdfPageRangeChange?: (id: string, startPage?: number, endPage?: number) => void;
  onPdfIncludeImagesChange?: (id: string, includeImages: boolean) => void;
  onPdfIncludeTextChange?: (id: string, includeText: boolean) => void;
}

/**
 * Unified attachment preview component
 * - Compact icon view by default
 * - Click to expand and show details
 * - Remove button on hover
 */
export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({
  attachment,
  type,
  onRemove,
  pdfDebugMode = false,
  onPdfPageRangeChange,
  onPdfIncludeImagesChange,
  onPdfIncludeTextChange,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Get attachment info based on type
  const getAttachmentInfo = () => {
    if (type === 'image') {
      const img = attachment as PendingImage;
      return {
        icon: <ImageIcon size={16} className="text-blue-500" />,
        name: img.file?.name || '图片',
        size: img.file?.size,
        preview: <img src={img.url} alt="预览" className="w-full h-full object-cover" />,
      };
    } else if (type === 'text') {
      const file = attachment as PendingTextFile;
      return {
        icon: <FileText size={16} className="text-green-500" />,
        name: file.filename,
        size: file.size,
        preview: (
          <div className="text-xs text-gray-600 dark:text-gray-300 font-mono bg-white dark:bg-gray-800 rounded p-2 max-h-48 overflow-auto">
            <pre className="whitespace-pre-wrap break-words m-0">
              {truncateContent(file.content)}
            </pre>
          </div>
        ),
      };
    } else {
      const pdf = attachment as PendingPdf;
      return {
        icon: <FileText size={16} className="text-red-500" />,
        name: pdf.filename,
        size: pdf.size,
        preview: <PdfExpandedView 
          pdf={pdf} 
          pdfDebugMode={pdfDebugMode}
          onPageRangeChange={onPdfPageRangeChange}
          onIncludeImagesChange={onPdfIncludeImagesChange}
          onIncludeTextChange={onPdfIncludeTextChange}
        />,
      };
    }
  };

  const info = getAttachmentInfo();

  return (
    <div className="relative group">
      {/* Compact view */}
      {!isExpanded && (
        <div
          onClick={() => setIsExpanded(true)}
          className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
        >
          {info.icon}
          <span className="text-sm text-gray-700 dark:text-gray-200 truncate max-w-32">
            {info.name}
          </span>
          {info.size && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatFileSize(info.size)}
            </span>
          )}
          <ChevronRight size={14} className="text-gray-400 ml-auto" />
        </div>
      )}

      {/* Expanded view */}
      {isExpanded && (
        <div className="bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 p-3 max-w-2xl">
          {/* Header */}
          <div
            onClick={() => setIsExpanded(false)}
            className="flex items-center gap-2 mb-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 rounded p-1 -m-1"
          >
            {info.icon}
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate flex-1">
              {info.name}
            </span>
            {info.size && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatFileSize(info.size)}
              </span>
            )}
            <ChevronDown size={14} className="text-gray-400" />
          </div>

          {/* Content preview */}
          {info.preview}
        </div>
      )}

      {/* Remove button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(attachment.id);
        }}
        className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 z-10"
        title="移除"
      >
        <X size={12} />
      </button>
    </div>
  );
};

/**
 * PDF expanded view component
 */
interface PdfExpandedViewProps {
  pdf: PendingPdf;
  pdfDebugMode: boolean;
  onPageRangeChange?: (id: string, startPage?: number, endPage?: number) => void;
  onIncludeImagesChange?: (id: string, includeImages: boolean) => void;
  onIncludeTextChange?: (id: string, includeText: boolean) => void;
}

const PdfExpandedView: React.FC<PdfExpandedViewProps> = ({
  pdf,
  pdfDebugMode,
  onPageRangeChange,
  onIncludeImagesChange,
  onIncludeTextChange,
}) => {
  const [startPage, setStartPage] = useState<string>(pdf.pageRangeStart?.toString() || '');
  const [endPage, setEndPage] = useState<string>(pdf.pageRangeEnd?.toString() || '');
  const [includeImages, setIncludeImages] = useState<boolean>(pdf.includeImages ?? true);
  const [includeText, setIncludeText] = useState<boolean>(pdf.includeText ?? true);

  const handlePageRangeChange = (start: string, end: string) => {
    setStartPage(start);
    setEndPage(end);
    if (!onPageRangeChange) return;
    
    const startNum = start ? parseInt(start, 10) : undefined;
    const endNum = end ? parseInt(end, 10) : undefined;
    
    if (startNum !== undefined && (startNum < 1 || startNum > pdf.totalPages)) return;
    if (endNum !== undefined && (endNum < 1 || endNum > pdf.totalPages)) return;
    if (startNum !== undefined && endNum !== undefined && startNum > endNum) return;
    
    onPageRangeChange(pdf.id, startNum, endNum);
  };

  const displayPages = pdf.pages.slice(0, 6);
  const hasMorePages = pdf.totalPages > 6;

  return (
    <div className="space-y-3">
      {/* Metadata */}
      {(pdf.metadata?.title || pdf.metadata?.author) && (
        <div className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
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

      {/* Page count */}
      <div className="text-xs text-gray-600 dark:text-gray-400">
        共 {pdf.totalPages} 页
      </div>

      {/* Debug mode controls */}
      {pdfDebugMode && (
        <div className="p-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded space-y-2">
          <div className="text-xs font-medium text-yellow-800 dark:text-yellow-300">
            调试模式
          </div>
          
          {/* Page range */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 dark:text-gray-400">从</label>
            <input
              type="number"
              min="1"
              max={pdf.totalPages}
              value={startPage}
              onChange={(e) => handlePageRangeChange(e.target.value, endPage)}
              placeholder="1"
              className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
            />
            <label className="text-xs text-gray-600 dark:text-gray-400">到</label>
            <input
              type="number"
              min="1"
              max={pdf.totalPages}
              value={endPage}
              onChange={(e) => handlePageRangeChange(startPage, e.target.value)}
              placeholder={pdf.totalPages.toString()}
              className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
            />
          </div>

          {/* Include options */}
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={includeImages}
                onChange={(e) => {
                  setIncludeImages(e.target.checked);
                  onIncludeImagesChange?.(pdf.id, e.target.checked);
                }}
                className="w-4 h-4 rounded"
              />
              <span className="text-gray-700 dark:text-gray-300">包含图片</span>
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={includeText}
                onChange={(e) => {
                  setIncludeText(e.target.checked);
                  onIncludeTextChange?.(pdf.id, e.target.checked);
                }}
                className="w-4 h-4 rounded"
              />
              <span className="text-gray-700 dark:text-gray-300">包含文本</span>
            </label>
          </div>
        </div>
      )}

      {/* Page thumbnails */}
      {displayPages.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-600 dark:text-gray-400 font-medium">
            页面预览:
          </div>
          <div className="grid grid-cols-3 gap-2">
            {displayPages.map((page) => (
              <div
                key={page.pageNumber}
                className="relative aspect-[3/4] bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-600 overflow-hidden"
              >
                <img
                  src={page.image}
                  alt={`第 ${page.pageNumber} 页`}
                  className="w-full h-full object-contain"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs py-0.5 text-center">
                  第 {page.pageNumber} 页
                </div>
              </div>
            ))}
          </div>
          {hasMorePages && (
            <div className="text-xs text-gray-500 dark:text-gray-400 text-center italic">
              还有 {pdf.totalPages - 6} 页未显示
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AttachmentPreview;
