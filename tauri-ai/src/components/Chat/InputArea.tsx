/**
 * InputArea Component
 * Responsive input area with auto-expanding textarea and send functionality
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Brain, Bot, Cpu, ChevronDown, Check, ImagePlus, X, Paperclip, FileText } from 'lucide-react';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { TextFilePreview } from './TextFilePreview';
import { PdfPreview } from './PdfPreview';
import { ThinkingSelector } from './ThinkingSelector';
import { isSupportedTextFile, readTextFile, validateFileCount } from '../../utils/textFileUtils';
import { isValidPdfFile, validatePdfSize, processPdfFile, MAX_PDF_SIZE } from '../../utils/pdfUtils';
import type { ContextUsageBreakdown, Agent, ContentPart, PendingTextFile, PendingPdf, ApiProtocolType, ThinkingMode } from '../../types';
import { SUPPORTED_TEXT_EXTENSIONS, MAX_PDF_COUNT } from '../../types';
import { FILE_ERROR_MESSAGES } from '../../utils/textFileUtils';

// Constants for textarea sizing
const MIN_TEXTAREA_HEIGHT = 40; // Minimum height in pixels
const MAX_TEXTAREA_HEIGHT = 200; // Maximum height in pixels (Requirement 4.1)

interface ModelOption {
  label: string;
  value: string;
}

/**
 * Pending image for upload preview
 */
interface PendingImage {
  id: string;
  url: string;  // Base64 data URL
  file?: File;
}

interface InputAreaProps {
  onSend: (content: string, thinking?: ThinkingMode, images?: ContentPart[]) => void;
  onAbort?: () => void;
  disabled: boolean;
  isGenerating: boolean;
  supportsThinking?: boolean;  // Whether current model supports thinking
  supportsVision?: boolean;    // Whether current model supports vision/images
  contextUsage?: ContextUsageBreakdown | null;  // Context usage for indicator
  apiProtocol?: ApiProtocolType;  // API protocol type for thinking mode
  // Agent/Model selection
  agents?: Agent[];
  currentAgentName?: string;
  onAgentSelect?: (agentName: string) => void;
  modelOptions?: ModelOption[];
  currentModelRef?: string;
  onModelSelect?: (modelRef: string) => void;
}

/**
 * Check if input is empty or whitespace-only
 * Requirement 4.6: Disable send for empty/whitespace input
 */
export const isWhitespaceOnly = (text: string): boolean => {
  return text.trim().length === 0;
};

/**
 * Calculate textarea height based on content
 * Requirement 4.1: Auto-expand textarea height up to maximum limit
 */
export const calculateTextareaHeight = (
  scrollHeight: number,
  minHeight: number = MIN_TEXTAREA_HEIGHT,
  maxHeight: number = MAX_TEXTAREA_HEIGHT
): number => {
  return Math.max(minHeight, Math.min(scrollHeight, maxHeight));
};

/**
 * Feature toggle button component
 */
interface FeatureToggleProps {
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  activeColor?: string;
}

const FeatureToggle: React.FC<FeatureToggleProps> = ({
  icon,
  label,
  enabled,
  onToggle,
  disabled = false,
  activeColor = 'purple',
}) => {
  const colorClasses = {
    purple: enabled
      ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-900/40 dark:text-purple-400 dark:border-purple-700'
      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700',
    blue: enabled
      ? 'bg-blue-100 text-blue-600 border-blue-300 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-700'
      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700',
    green: enabled
      ? 'bg-green-100 text-green-600 border-green-300 dark:bg-green-900/40 dark:text-green-400 dark:border-green-700'
      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700',
  };

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${colorClasses[activeColor as keyof typeof colorClasses] || colorClasses.purple
        } disabled:cursor-not-allowed disabled:opacity-50`}
      title={enabled ? `${label}已开启，点击关闭` : `${label}已关闭，点击开启`}
      aria-pressed={enabled}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

/**
 * Attachment menu for adding various content types
 */
interface AttachmentMenuProps {
  onImageClick: () => void;
  onTextFileClick: () => void;
  onPdfClick: () => void;
  supportsVision: boolean;
  disabled?: boolean;
}

const AttachmentMenu: React.FC<AttachmentMenuProps> = ({
  onImageClick,
  onTextFileClick,
  onPdfClick,
  supportsVision,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const menuItems = [
    {
      icon: <ImagePlus size={14} />,
      label: '图片',
      onClick: onImageClick,
      enabled: supportsVision,
      disabledTip: '当前模型不支持图片',
    },
    {
      icon: <FileText size={14} />,
      label: '文本文件',
      onClick: onTextFileClick,
      enabled: true,
      disabledTip: '',
    },
    {
      icon: <FileText size={14} />,
      label: 'PDF文档',
      onClick: onPdfClick,
      enabled: true,
      disabledTip: '',
    },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="inline-flex items-center gap-1 text-gray-400 hover:text-blue-500 dark:text-gray-500 dark:hover:text-blue-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title="添加附件"
        aria-label="添加附件"
      >
        <Paperclip size={12} />
        <span>添加附件</span>
        <ChevronDown size={10} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-40 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
          {menuItems.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                if (item.enabled) {
                  item.onClick();
                  setIsOpen(false);
                }
              }}
              disabled={!item.enabled}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                item.enabled
                  ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                  : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
              }`}
              title={!item.enabled ? item.disabledTip : undefined}
            >
              {item.icon}
              <span className="text-xs">{item.label}</span>
              {!item.enabled && (
                <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-600">
                  {item.disabledTip}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Compact dropdown selector for agent/model selection
 */
interface CompactSelectorProps<T extends { label: string; value: string }> {
  icon: React.ReactNode;
  options: T[];
  currentValue: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function CompactSelector<T extends { label: string; value: string }>({
  icon,
  options,
  currentValue,
  onSelect,
  disabled = false,
  placeholder = '选择',
}: CompactSelectorProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentLabel = options.find(o => o.value === currentValue)?.label || placeholder;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {icon}
        <span className="max-w-20 truncate">{currentLabel}</span>
        <ChevronDown size={10} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 max-h-60 overflow-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              暂无可用选项
            </div>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  onSelect(option.value);
                  setIsOpen(false);
                }}
                className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <span className="text-xs text-gray-800 dark:text-white truncate">
                  {option.label}
                </span>
                {option.value === currentValue && (
                  <Check size={12} className="text-blue-500 flex-shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export interface InputAreaHandle {
  setValue: (value: string) => void;
  focus: () => void;
}

export const InputArea = React.forwardRef<InputAreaHandle, InputAreaProps>(({
  onSend,
  onAbort,
  disabled,
  isGenerating,
  supportsThinking = false,
  supportsVision = false,
  contextUsage = null,
  apiProtocol = 'chat_completions',
  agents = [],
  currentAgentName = '',
  onAgentSelect,
  modelOptions = [],
  currentModelRef = '',
  onModelSelect,
}, ref) => {
  const [content, setContent] = useState('');
  // Initialize thinking mode based on API protocol
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(
    apiProtocol === 'responses' ? 'medium' : true
  );
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingTextFiles, setPendingTextFiles] = useState<PendingTextFile[]>([]);
  const [pendingPdfs, setPendingPdfs] = useState<PendingPdf[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textFileInputRef = useRef<HTMLInputElement>(null);
  const pdfFileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Convert file to base64 data URL
   */
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  /**
   * Create a FileList-like object from an array of Files
   * This is needed because FileList constructor is not available
   */
  const createFileList = useCallback((files: File[]): FileList => {
    // Create a FileList-like object
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
  }, []);

  /**
   * Handle image file selection
   */
  const handleImageSelect = useCallback(async (files: FileList | null) => {
    if (!files || !supportsVision) return;

    const newImages: PendingImage[] = [];
    for (const file of Array.from(files)) {
      // Only accept image files
      if (!file.type.startsWith('image/')) continue;
      
      // Limit file size to 20MB
      if (file.size > 20 * 1024 * 1024) {
        console.warn('Image too large:', file.name);
        continue;
      }

      try {
        const url = await fileToBase64(file);
        newImages.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          url,
          file,
        });
      } catch (err) {
        console.error('Failed to read image:', err);
      }
    }

    setPendingImages(prev => [...prev, ...newImages]);
  }, [supportsVision, fileToBase64]);

  /**
   * Handle text file selection
   * Requirements: 1.1, 1.3, 5.1, 5.2, 5.3, 5.4
   */
  const handleTextFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    // Clear previous error
    setFileError(null);

    const filesToProcess = Array.from(files);
    
    // Validate file count (Requirements: 5.3, 5.4)
    const validation = validateFileCount(pendingTextFiles.length, filesToProcess.length);
    
    if (!validation.canAdd) {
      setFileError(validation.error);
      return;
    }

    if (validation.error) {
      setFileError(validation.error);
      // Only process files that fit within the limit
      filesToProcess.splice(validation.filesToProcess);
    }

    const newFiles: PendingTextFile[] = [];
    
    for (const file of filesToProcess) {
      // Check if file extension is supported (Requirements: 1.4, 4.3)
      if (!isSupportedTextFile(file.name)) {
        // Silently ignore unsupported files during drag-drop (Requirement 4.3)
        // But show error for explicit file selection
        continue;
      }

      try {
        const pendingFile = await readTextFile(file);
        newFiles.push(pendingFile);
      } catch (err) {
        // Show error message (Requirements: 7.1, 7.2, 7.3)
        const errorMessage = err instanceof Error ? err.message : FILE_ERROR_MESSAGES.READ_ERROR('未知错误');
        setFileError(errorMessage);
      }
    }

    if (newFiles.length > 0) {
      setPendingTextFiles(prev => [...prev, ...newFiles]);
    }
  }, [pendingTextFiles.length]);

  /**
   * Remove a pending text file
   * Requirement 2.4
   */
  const removeTextFile = useCallback((id: string) => {
    setPendingTextFiles(prev => prev.filter(f => f.id !== id));
    setFileError(null);
  }, []);

  /**
   * Handle PDF file selection
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.2, 6.5, 10.1-10.7
   */
  const handlePdfSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    // Clear previous error
    setPdfError(null);

    const filesToProcess = Array.from(files);

    // Check PDF count limit (Requirements: 6.2, 6.5)
    const currentCount = pendingPdfs.length;
    const newCount = filesToProcess.length;
    const totalCount = currentCount + newCount;

    if (totalCount > MAX_PDF_COUNT) {
      setPdfError(`最多只能同时处理 ${MAX_PDF_COUNT} 个 PDF 文档`);
      // Only process files that fit within the limit
      filesToProcess.splice(MAX_PDF_COUNT - currentCount);
      
      if (filesToProcess.length === 0) {
        return;
      }
    }

    for (const file of filesToProcess) {
      // Validate file type (Requirements: 1.1, 1.2, 1.3)
      if (!isValidPdfFile(file)) {
        setPdfError('只支持 PDF 文件');
        continue;
      }

      // Validate file size (Requirements: 1.3, 1.5)
      if (!validatePdfSize(file)) {
        setPdfError(`PDF 文件过大，请选择小于 ${MAX_PDF_SIZE / 1024 / 1024}MB 的文件`);
        continue;
      }

      try {
        // Process PDF file (Requirements: 1.4, 1.6)
        const pendingPdf = await processPdfFile(file, (progress) => {
          // Update processing progress
          setPendingPdfs(prev => 
            prev.map(p => 
              p.filename === file.name 
                ? { ...p, processingProgress: progress }
                : p
            )
          );
        });

        setPendingPdfs(prev => [...prev, pendingPdf]);
      } catch (err) {
        // Handle errors (Requirements: 10.1-10.7)
        const errorMessage = err instanceof Error ? err.message : 'PDF 处理失败';
        setPdfError(errorMessage);
      }
    }
  }, [pendingPdfs.length]);

  /**
   * Remove a pending PDF
   * Requirement 5.1
   */
  const removePdf = useCallback((id: string) => {
    setPendingPdfs(prev => prev.filter(p => p.id !== id));
    setPdfError(null);
  }, []);

  /**
   * Handle paste event for images and text files
   */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    
    for (const item of Array.from(items)) {
      const file = item.getAsFile();
      if (!file) continue;
      
      // Check for images
      if (item.type.startsWith('image/') && supportsVision) {
        imageFiles.push(file);
      }
      // Check for text files
      else if (isSupportedTextFile(file.name)) {
        textFiles.push(file);
      }
    }

    // Handle image files
    if (imageFiles.length > 0) {
      e.preventDefault();
      const dataTransfer = new DataTransfer();
      imageFiles.forEach(f => dataTransfer.items.add(f));
      handleImageSelect(dataTransfer.files);
    }
    
    // Handle text files
    if (textFiles.length > 0) {
      e.preventDefault();
      handleTextFileSelect(createFileList(textFiles));
    }
  }, [supportsVision, handleImageSelect, handleTextFileSelect, createFileList]);

  /**
   * Handle drag and drop
   * Requirements: 4.1, 4.2, 4.3, 4.4, 7.1, 7.2, 7.3, 7.4, 7.6
   */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    
    // Separate image files, text files, and PDF files
    const imageFiles: File[] = [];
    const textFiles: File[] = [];
    const pdfFiles: File[] = [];
    
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/') && supportsVision) {
        imageFiles.push(file);
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        pdfFiles.push(file);
      } else if (isSupportedTextFile(file.name)) {
        textFiles.push(file);
      }
      // Silently ignore unsupported files (Requirement 4.3, 7.3)
    }
    
    // Handle image files
    if (imageFiles.length > 0) {
      handleImageSelect(createFileList(imageFiles));
    }
    
    // Handle text files
    if (textFiles.length > 0) {
      handleTextFileSelect(createFileList(textFiles));
    }
    
    // Handle PDF files (Requirements: 7.1, 7.2, 7.4)
    if (pdfFiles.length > 0) {
      handlePdfSelect(createFileList(pdfFiles));
    }
  }, [supportsVision, handleImageSelect, handleTextFileSelect, handlePdfSelect, createFileList]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  /**
   * Remove a pending image
   */
  const removeImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  }, []);

  // Helper to adjust textarea height
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = calculateTextareaHeight(textarea.scrollHeight);
      textarea.style.height = `${newHeight}px`;
    }
  }, []);

  // Expose methods to parent
  React.useImperativeHandle(ref, () => ({
    setValue: (value: string) => {
      setContent(value);
      // Auto-resize after setting content
      requestAnimationFrame(() => {
        adjustTextareaHeight();
        textareaRef.current?.focus();
      });
    },
    focus: () => {
      textareaRef.current?.focus();
    }
  }));

  /**
   * Auto-resize textarea based on content
   * Requirement 4.1: Auto-expand textarea height up to maximum limit
   */
  useEffect(() => {
    adjustTextareaHeight();
  }, [content, adjustTextareaHeight]);

  /**
   * Focus textarea on mount
   */
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  /**
   * Handle sending message
   * Requirement 4.4: Click send button to send message
   * Requirements 3.1, 3.2, 3.3, 3.4: Text file content formatting and sending
   * Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7: PDF content formatting and sending
   */
  const handleSend = useCallback(() => {
    // Requirement 4.6: Don't send empty/whitespace-only input (unless there are attachments)
    const hasAttachments = pendingImages.length > 0 || pendingTextFiles.length > 0 || pendingPdfs.length > 0;
    if ((isWhitespaceOnly(content) && !hasAttachments) || disabled || isGenerating) {
      return;
    }

    const trimmedContent = content.trim();
    
    // Build content parts for images, text files, and PDFs
    let contentParts: ContentPart[] | undefined;
    
    if (pendingImages.length > 0 || pendingTextFiles.length > 0 || pendingPdfs.length > 0) {
      contentParts = [];
      
      // Add image content parts
      for (const img of pendingImages) {
        contentParts.push({
          type: 'image' as const,
          url: img.url,
          detail: 'auto' as const,
        });
      }
      
      // Add text file content parts (Requirements: 3.1, 3.2, 3.4)
      // Send raw content, backend will format it
      for (const file of pendingTextFiles) {
        contentParts.push({
          type: 'text_file' as const,
          filename: file.filename,
          content: file.content,  // Send raw content, not formatted
        });
      }
      
      // Add PDF content parts (Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7)
      for (const pdf of pendingPdfs) {
        contentParts.push({
          type: 'pdf_document' as const,
          filename: pdf.filename,
          pages: pdf.pages,
          totalPages: pdf.totalPages,
          metadata: pdf.metadata,
        });
      }
    }

    onSend(trimmedContent, supportsThinking ? thinkingMode : undefined, contentParts);
    setContent('');
    setPendingImages([]);
    // Requirement 3.3: Clear pending text files after sending
    setPendingTextFiles([]);
    // Clear pending PDFs after sending
    setPendingPdfs([]);
    setFileError(null);
    setPdfError(null);

    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
    }

    // Refocus textarea after sending
    textareaRef.current?.focus();
  }, [content, pendingImages, pendingTextFiles, pendingPdfs, disabled, isGenerating, onSend, supportsThinking, thinkingMode]);

  /**
   * Handle keyboard events
   * Requirement 4.2: Enter (without Shift) sends message
   * Requirement 4.3: Shift+Enter inserts newline
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          // Requirement 4.3: Shift+Enter inserts newline (default behavior)
          return;
        }
        // Requirement 4.2: Enter sends message
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  /**
   * Handle input change
   */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
    },
    []
  );

  /**
   * Handle abort button click
   */
  const handleAbort = useCallback(() => {
    onAbort?.();
  }, [onAbort]);

  // Requirement 4.6: Disable send button for empty/whitespace input (unless there are attachments)
  const hasAttachments = pendingImages.length > 0 || pendingTextFiles.length > 0 || pendingPdfs.length > 0;
  const isSendDisabled = disabled || (isWhitespaceOnly(content) && !hasAttachments);

  // Convert agents to selector options
  const agentOptions = agents.map(a => ({ label: a.displayName, value: a.name }));

  // Check if we have selectors to show
  const hasSelectors = agents.length > 0 || modelOptions.length > 0;
  const hasFeatureToggles = supportsThinking || supportsVision || contextUsage || hasSelectors;

  return (
    <div 
      className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Toolbar: Agent/Model selectors and feature toggles */}
      {hasFeatureToggles && (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Agent selector */}
            {agents.length > 0 && onAgentSelect && (
              <CompactSelector
                icon={<Bot size={12} />}
                options={agentOptions}
                currentValue={currentAgentName}
                onSelect={onAgentSelect}
                disabled={isGenerating}
                placeholder="智能体"
              />
            )}
            {/* Model selector */}
            {modelOptions.length > 0 && onModelSelect && (
              <CompactSelector
                icon={<Cpu size={12} />}
                options={modelOptions}
                currentValue={currentModelRef}
                onSelect={onModelSelect}
                disabled={isGenerating}
                placeholder="模型"
              />
            )}
            {/* Divider if both selectors and toggles exist */}
            {(agents.length > 0 || modelOptions.length > 0) && supportsThinking && (
              <div className="h-4 w-px bg-gray-300 dark:bg-gray-600 mx-1" />
            )}
            {/* Thinking selector - adaptive based on API protocol */}
            {supportsThinking && (
              <ThinkingSelector
                apiProtocol={apiProtocol}
                value={thinkingMode}
                onChange={setThinkingMode}
                disabled={isGenerating}
              />
            )}
          </div>
          {/* Context usage indicator on the right */}
          {contextUsage && (
            <ContextUsageIndicator usage={contextUsage} disabled={isGenerating} />
          )}
        </div>
      )}

      {/* Image preview area */}
      {pendingImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingImages.map(img => (
            <div key={img.id} className="relative group">
              <img
                src={img.url}
                alt="待发送图片"
                className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 flex items-center justify-center rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                title="移除图片"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Text file preview area */}
      {pendingTextFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 max-h-48 overflow-auto">
          {pendingTextFiles.map(file => (
            <TextFilePreview
              key={file.id}
              file={file}
              onRemove={removeTextFile}
            />
          ))}
        </div>
      )}

      {/* PDF preview area */}
      {pendingPdfs.length > 0 && (
        <div className="mb-2 flex flex-col gap-2 max-h-96 overflow-auto">
          {pendingPdfs.map(pdf => (
            <PdfPreview
              key={pdf.id}
              pdf={pdf}
              onRemove={removePdf}
            />
          ))}
        </div>
      )}

      {/* File error message */}
      {fileError && (
        <div className="mb-2 text-xs text-red-500 dark:text-red-400">
          {fileError}
        </div>
      )}

      {/* PDF error message */}
      {pdfError && (
        <div className="mb-2 text-xs text-red-500 dark:text-red-400">
          {pdfError}
        </div>
      )}

      {/* Hidden file input for images */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleImageSelect(e.target.files)}
      />

      {/* Hidden file input for text files */}
      <input
        ref={textFileInputRef}
        type="file"
        accept={SUPPORTED_TEXT_EXTENSIONS.join(',')}
        multiple
        className="hidden"
        onChange={(e) => {
          handleTextFileSelect(e.target.files);
          // Reset input value to allow selecting the same file again
          e.target.value = '';
        }}
      />

      {/* Hidden file input for PDFs */}
      <input
        ref={pdfFileInputRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          handlePdfSelect(e.target.files);
          // Reset input value to allow selecting the same file again
          e.target.value = '';
        }}
      />

      {/* Input row */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={supportsVision ? "输入消息，或粘贴/拖拽图片和文本文件..." : "输入消息，或粘贴/拖拽文本文件..."}
          disabled={disabled || isGenerating}
          rows={1}
          aria-label="消息输入框"
          className="flex-1 resize-none rounded-lg border border-gray-300 bg-gray-50 px-4 py-2 text-gray-900 placeholder-gray-500 transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400"
          style={{ minHeight: `${MIN_TEXTAREA_HEIGHT}px` }}
        />
        {isGenerating ? (
          // Requirement 4.5: Show loading indicator when generating
          <button
            type="button"
            onClick={handleAbort}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            title="停止生成"
            aria-label="停止生成"
          >
            <Square size={18} />
          </button>
        ) : (
          // Requirement 4.5: Disable send button when generating
          <button
            type="button"
            onClick={handleSend}
            disabled={isSendDisabled}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500 text-white transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-500"
            title="发送消息"
            aria-label="发送消息"
          >
            <Send size={18} />
          </button>
        )}
      </div>

      {/* Attachment menu */}
      <div className="mt-1 flex items-center text-xs">
        <AttachmentMenu
          onImageClick={() => fileInputRef.current?.click()}
          onTextFileClick={() => textFileInputRef.current?.click()}
          onPdfClick={() => pdfFileInputRef.current?.click()}
          supportsVision={supportsVision}
          disabled={disabled || isGenerating}
        />
      </div>
    </div>
  );
});

export default InputArea;
