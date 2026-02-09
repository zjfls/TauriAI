/**
 * TextFilePreview Component
 * Displays a preview card for pending text file attachments
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import React from 'react';
import { FileText, X } from 'lucide-react';
import type { PendingTextFile } from '../../types';

/**
 * Maximum characters to show in preview
 * Requirement 2.2: Show first 500 characters with truncation indicator
 */
export const PREVIEW_MAX_CHARS = 500;

/**
 * Truncate content for preview display
 * Returns truncated content with ellipsis if longer than maxChars
 * 
 * Property 4: Content Truncation
 * For any file content string, the preview display SHALL show at most 500 characters,
 * and if the original content length > 500, the preview SHALL include a truncation indicator.
 * 
 * @param content - The full file content
 * @param maxChars - Maximum characters to show (default: 500)
 * @returns Truncated content with ellipsis if needed
 */
export function truncateContent(content: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars) + '...';
}

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

interface TextFilePreviewProps {
  file: PendingTextFile;
  onRemove: (id: string) => void;
}

/**
 * Text file preview card component
 * - Displays file icon and filename (Requirement 2.1)
 * - Shows content preview with truncation (Requirement 2.2)
 * - Shows tooltip with full filename and size on hover (Requirement 2.3)
 * - Provides remove button (Requirement 2.4)
 */
export const TextFilePreview: React.FC<TextFilePreviewProps> = ({ file, onRemove }) => {
  const truncatedContent = truncateContent(file.content);
  const isTruncated = file.content.length > PREVIEW_MAX_CHARS;
  const formattedSize = formatFileSize(file.size);
  
  // Tooltip text with full filename and size
  const tooltipText = `${file.filename} (${formattedSize})`;

  return (
    <div 
      className="relative group bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 p-3 max-w-md"
      title={tooltipText}
    >
      {/* Header: Icon, filename, and size */}
      <div className="flex items-center gap-2 mb-2">
        <FileText 
          size={16} 
          className="text-blue-500 dark:text-blue-400 flex-shrink-0" 
        />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate flex-1">
          {file.filename}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
          {formattedSize}
        </span>
      </div>

      {/* Content preview */}
      <div className="text-xs text-gray-600 dark:text-gray-300 font-mono bg-white dark:bg-gray-800 rounded p-2 max-h-24 overflow-hidden">
        <pre className="whitespace-pre-wrap break-words m-0">
          {truncatedContent}
        </pre>
        {isTruncated && (
          <span className="text-gray-400 dark:text-gray-500 italic">
            （内容已截断）
          </span>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={() => onRemove(file.id)}
        className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        title="移除文件"
        aria-label={`移除 ${file.filename}`}
      >
        <X size={12} />
      </button>
    </div>
  );
};

export default TextFilePreview;
