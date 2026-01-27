/**
 * InputArea Component
 * Responsive input area with auto-expanding textarea and send functionality
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Square, Bot, Cpu, ChevronDown, Check, ImagePlus, Paperclip, FileText, Plug } from 'lucide-react';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { McpModal } from './McpModal';
import { AttachmentPreview } from './AttachmentPreview';
import { ThinkingSelector } from './ThinkingSelector';
import { WebSearchToggle } from './WebSearchToggle';
import { isSupportedTextFile, readTextFile, validateFileCount } from '../../utils/textFileUtils';
import { isValidPdfFile, validatePdfSize, processPdfFile, MAX_PDF_SIZE } from '../../utils/pdfUtils';
import type { ContextUsageBreakdown, Agent, ContentPart, PendingImage, PendingTextFile, PendingPdf, ApiProtocolType, ThinkingMode, ProviderType, RunMode } from '../../types';
import { SUPPORTED_TEXT_EXTENSIONS, MAX_PDF_COUNT, MAX_TEXT_FILES } from '../../types';
import { FILE_ERROR_MESSAGES } from '../../utils/textFileUtils';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Constants for textarea sizing
const MIN_TEXTAREA_HEIGHT = 40; // Minimum height in pixels
const MAX_TEXTAREA_HEIGHT = 200; // Maximum height in pixels (Requirement 4.1)

const RUN_MODE_OPTIONS: { value: RunMode; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'agent', label: 'Agent' },
  { value: 'agent-full-access', label: 'Agent Full Access' },
];

/**
 * Error messages for paste operations
 * 
 * Centralized error message constants for consistent user feedback across paste operations.
 * These messages are displayed when file validation fails or limits are exceeded.
 * 
 * Requirements: 4.1, 4.2
 * 
 * @constant
 * @property {string} IMAGE_NOT_SUPPORTED - Shown when user pastes images but model doesn't support vision
 * @property {string} IMAGE_LIMIT_EXCEEDED - Shown when image count limit is reached
 * @property {string} TEXT_FILE_LIMIT_EXCEEDED - Shown when text file count limit is reached
 * @property {string} PDF_LIMIT_EXCEEDED - Shown when PDF count limit is reached
 * @property {string} PDF_INVALID_TYPE - Shown when non-PDF file is selected in PDF picker
 * @property {Function} PDF_TOO_LARGE - Function that returns size limit error message
 * @property {string} MIXED_LIMIT_EXCEEDED - Shown when some files are skipped due to limits
 * @property {string} NO_SUPPORTED_FILES - Shown when no supported file types are detected
 */
const PASTE_ERROR_MESSAGES = {
  IMAGE_NOT_SUPPORTED: '当前模型不支持图片',
  IMAGE_LIMIT_EXCEEDED: '图片数量已达上限',
  TEXT_FILE_LIMIT_EXCEEDED: '文本文件数量已达上限',
  PDF_LIMIT_EXCEEDED: 'PDF 文件数量已达上限',
  PDF_INVALID_TYPE: '只支持 PDF 文件',
  PDF_TOO_LARGE: (maxSize: number) => `PDF 文件过大，请选择小于 ${maxSize}MB 的文件`,
  MIXED_LIMIT_EXCEEDED: '部分文件因数量限制未能添加',
  NO_SUPPORTED_FILES: '未检测到支持的文件类型',
} as const;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function inferImageMimeType(filename: string): string | null {
  const lower = filename.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex < 0) return null;
  const ext = lower.slice(dotIndex);
  return IMAGE_MIME_BY_EXTENSION[ext] ?? null;
}

function normalizeDroppedImageFile(file: File): File | null {
  if (file.type?.startsWith('image/')) return file;

  const inferred = inferImageMimeType(file.name);
  if (!inferred) return null;

  // 某些 WebView/浏览器会给本地文件的 type 为空，这里按扩展名补齐 MIME，保证后续渲染/发送一致
  return new File([file], file.name, { type: inferred, lastModified: file.lastModified });
}

function normalizeDroppedPdfFile(file: File): File | null {
  if (!file.name.toLowerCase().endsWith('.pdf')) return null;

  if (file.type === 'application/pdf') return file;

  // 某些 WebView/浏览器会给本地 PDF 的 type 为空，这里补齐 MIME，避免 isValidPdfFile 判定失败
  return new File([file], file.name, { type: 'application/pdf', lastModified: file.lastModified });
}

function getFilenameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const chunkSize = 1024 * 1024;
  const safeChunkSize = chunkSize - (chunkSize % 4);

  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (let offset = 0; offset < base64.length; offset += safeChunkSize) {
    const slice = base64.slice(offset, offset + safeChunkSize);
    const binary = atob(slice);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    chunks.push(bytes);
    totalLength += bytes.length;
  }

  const result = new Uint8Array(totalLength);
  let resultOffset = 0;
  for (const bytes of chunks) {
    result.set(bytes, resultOffset);
    resultOffset += bytes.length;
  }

  return result;
}

/**
 * Model option for dropdown selector
 */
interface ModelOption {
  label: string;
  value: string;
}

/**
 * Props for InputArea component
 * 
 * @interface InputAreaProps
 * @property {Function} onSend - Callback when user sends a message
 * @property {Function} [onAbort] - Optional callback to abort message generation
 * @property {boolean} disabled - Whether the input area is disabled
 * @property {boolean} isGenerating - Whether AI is currently generating a response
 * @property {boolean} [supportsThinking] - Whether current model supports thinking mode
 * @property {boolean} [supportsVision] - Whether current model supports vision/images
 * @property {ContextUsageBreakdown | null} [contextUsage] - Context usage data for indicator
 * @property {ApiProtocolType} [apiProtocol] - API protocol type for thinking mode
 * @property {boolean} [useReasoningEffort] - Whether to use reasoning_effort parameter
 * @property {Agent[]} [agents] - Available agents for selection
 * @property {string} [currentAgentName] - Currently selected agent name
 * @property {Function} [onAgentSelect] - Callback when agent is selected
 * @property {ModelOption[]} [modelOptions] - Available models for selection
 * @property {string} [currentModelRef] - Currently selected model reference
 * @property {Function} [onModelSelect] - Callback when model is selected
 * @property {boolean} [pdfDebugMode] - Whether to enable PDF debug mode controls
 */
interface InputAreaProps {
  onSend: (content: string, thinking?: ThinkingMode, images?: ContentPart[]) => void;
  onAbort?: () => void;
  disabled: boolean;
  isGenerating: boolean;
  supportsThinking?: boolean;  // Whether current model supports thinking
  supportsVision?: boolean;    // Whether current model supports vision/images
  contextUsage?: ContextUsageBreakdown | null;  // Context usage for indicator
  apiProtocol?: ApiProtocolType;  // API protocol type for thinking mode
  providerType?: ProviderType; // Provider type (for responses thinking level options)
  value?: string; // Controlled input text (per-session draft)
  onValueChange?: (value: string) => void;
  thinkingMode?: ThinkingMode; // Controlled thinking mode/level (per-session)
  onThinkingModeChange?: (value: ThinkingMode) => void;
  useReasoningEffort?: boolean;  // Whether to use reasoning_effort parameter
  // Run mode selection (chat/agent/full access)
  runMode?: RunMode;
  onRunModeChange?: (mode: RunMode) => void;
  // Agent/Model selection
  agents?: Agent[];
  currentAgentName?: string;
  onAgentSelect?: (agentName: string) => void;
  modelOptions?: ModelOption[];
  currentModelRef?: string;
  onModelSelect?: (modelRef: string) => void;
  // Web search
  supportsWebSearch?: boolean;  // Whether current model supports web search
  webSearchEnabled?: boolean;   // Whether web search is enabled
  onWebSearchToggle?: (enabled: boolean) => void;  // Callback when web search is toggled
  webSearchToggleMode?: 'native' | 'tool';
  webSearchDetails?: string;
  // PDF debug mode
  pdfDebugMode?: boolean;  // Whether to enable PDF debug mode controls
}

/**
 * Check if input is empty or whitespace-only
 * 
 * Used to validate user input before sending messages. Empty or whitespace-only
 * input should not be sent unless there are attachments.
 * 
 * Requirement 4.6: Disable send for empty/whitespace input
 * 
 * @param {string} text - The text to check
 * @returns {boolean} True if text is empty or contains only whitespace
 * 
 * @example
 * isWhitespaceOnly("   ") // true
 * isWhitespaceOnly("hello") // false
 * isWhitespaceOnly("\n\t  ") // true
 */
export const isWhitespaceOnly = (text: string): boolean => {
  return text.trim().length === 0;
};

/**
 * Validation result for paste files
 * 
 * Contains the results of validating pasted files against count limits and model capabilities.
 * Used to determine which files can be added and what error messages to show.
 * 
 * Requirements: 2.2, 6.1, 6.2, 6.3, 6.4
 * 
 * @interface PasteValidationResult
 * @property {boolean} canProceed - Whether at least one valid file exists to proceed with paste
 * @property {File[]} imageFiles - Array of valid image files that can be added
 * @property {File[]} textFiles - Array of valid text files that can be added
 * @property {File[]} pdfFiles - Array of valid PDF files that can be added
 * @property {string[]} errors - Array of error/warning messages to display to user
 */
interface PasteValidationResult {
  canProceed: boolean;
  imageFiles: File[];
  textFiles: File[];
  pdfFiles: File[];
  errors: string[];
}

/**
 * Validate pasted files against count limits
 * 
 * This function validates files from a paste operation against the current attachment counts
 * and model capabilities. It enforces file count limits for each type (images, text files, PDFs)
 * and returns only the files that can be added within the limits.
 * 
 * The validation process:
 * 1. Checks if model supports vision for image files
 * 2. Calculates remaining slots for each file type
 * 3. Truncates file arrays to fit within limits
 * 4. Collects error messages for files that exceed limits
 * 5. Returns validation result with valid files and errors
 * 
 * Requirements: 2.2, 6.1, 6.2, 6.3, 6.4
 * 
 * @param {File[]} imageFiles - Array of image files to validate
 * @param {File[]} textFiles - Array of text files to validate
 * @param {File[]} pdfFiles - Array of PDF files to validate
 * @param {number} currentImageCount - Current number of pending images
 * @param {number} currentTextFileCount - Current number of pending text files
 * @param {number} currentPdfCount - Current number of pending PDFs
 * @param {boolean} supportsVision - Whether the current model supports vision/images
 * @returns {PasteValidationResult} Validation result with valid files and error messages
 * 
 * @example
 * const result = validatePasteFiles(
 *   [imageFile1, imageFile2],
 *   [textFile1],
 *   [pdfFile1],
 *   5,  // current image count
 *   2,  // current text file count
 *   0,  // current PDF count
 *   true // supports vision
 * );
 * if (result.canProceed) {
 *   // Process result.imageFiles, result.textFiles, result.pdfFiles
 * }
 * if (result.errors.length > 0) {
 *   // Show result.errors to user
 * }
 */
export const validatePasteFiles = (
  imageFiles: File[],
  textFiles: File[],
  pdfFiles: File[],
  currentImageCount: number,
  currentTextFileCount: number,
  currentPdfCount: number,
  supportsVision: boolean
): PasteValidationResult => {
  const errors: string[] = [];
  let validImageFiles: File[] = [];
  let validTextFiles: File[] = [];
  let validPdfFiles: File[] = [];

  // Default maximum counts
  const MAX_IMAGE_COUNT = 10;  // Default from Model.maxImages

  // Validate image files
  // Check if model supports vision and if there are remaining slots
  if (imageFiles.length > 0) {
    if (!supportsVision) {
      // Model doesn't support images - reject all
      errors.push(PASTE_ERROR_MESSAGES.IMAGE_NOT_SUPPORTED);
    } else {
      const remainingImageSlots = MAX_IMAGE_COUNT - currentImageCount;
      if (remainingImageSlots <= 0) {
        // No slots available - reject all
        errors.push(PASTE_ERROR_MESSAGES.IMAGE_LIMIT_EXCEEDED);
      } else if (imageFiles.length > remainingImageSlots) {
        // Some files exceed limit - truncate and warn
        errors.push(`图片数量超过限制，最多还能添加 ${remainingImageSlots} 张`);
        validImageFiles = imageFiles.slice(0, remainingImageSlots);
      } else {
        // All files fit within limit
        validImageFiles = imageFiles;
      }
    }
  }

  // Validate text files
  // Check remaining slots and truncate if necessary
  if (textFiles.length > 0) {
    const remainingTextSlots = MAX_TEXT_FILES - currentTextFileCount;
    if (remainingTextSlots <= 0) {
      // No slots available - reject all
      errors.push(PASTE_ERROR_MESSAGES.TEXT_FILE_LIMIT_EXCEEDED);
    } else if (textFiles.length > remainingTextSlots) {
      // Some files exceed limit - truncate and warn
      errors.push(`文本文件数量超过限制，最多还能添加 ${remainingTextSlots} 个`);
      validTextFiles = textFiles.slice(0, remainingTextSlots);
    } else {
      // All files fit within limit
      validTextFiles = textFiles;
    }
  }

  // Validate PDF files
  // Check remaining slots and truncate if necessary
  if (pdfFiles.length > 0) {
    const remainingPdfSlots = MAX_PDF_COUNT - currentPdfCount;
    if (remainingPdfSlots <= 0) {
      // No slots available - reject all
      errors.push(PASTE_ERROR_MESSAGES.PDF_LIMIT_EXCEEDED);
    } else if (pdfFiles.length > remainingPdfSlots) {
      // Some files exceed limit - truncate and warn
      errors.push(`PDF 文件数量超过限制，最多还能添加 ${remainingPdfSlots} 个`);
      validPdfFiles = pdfFiles.slice(0, remainingPdfSlots);
    } else {
      // All files fit within limit
      validPdfFiles = pdfFiles;
    }
  }

  // Can proceed if at least one valid file exists
  const canProceed = validImageFiles.length > 0 || validTextFiles.length > 0 || validPdfFiles.length > 0;

  return {
    canProceed,
    imageFiles: validImageFiles,
    textFiles: validTextFiles,
    pdfFiles: validPdfFiles,
    errors,
  };
};

/**
 * Calculate textarea height based on content
 * 
 * Dynamically calculates the appropriate height for the textarea based on its
 * scroll height, constrained between minimum and maximum limits. This enables
 * auto-expanding textarea behavior as user types.
 * 
 * Requirement 4.1: Auto-expand textarea height up to maximum limit
 * 
 * @param {number} scrollHeight - The scroll height of the textarea element
 * @param {number} minHeight - Minimum allowed height in pixels (default: 40px)
 * @param {number} maxHeight - Maximum allowed height in pixels (default: 200px)
 * @returns {number} Calculated height in pixels, clamped between min and max
 * 
 * @example
 * const height = calculateTextareaHeight(150, 40, 200); // returns 150
 * const height = calculateTextareaHeight(250, 40, 200); // returns 200 (clamped to max)
 * const height = calculateTextareaHeight(20, 40, 200);  // returns 40 (clamped to min)
 */
export const calculateTextareaHeight = (
  scrollHeight: number,
  minHeight: number = MIN_TEXTAREA_HEIGHT,
  maxHeight: number = MAX_TEXTAREA_HEIGHT
): number => {
  return Math.max(minHeight, Math.min(scrollHeight, maxHeight));
};

/**
 * Attachment menu for adding various content types
 * 
 * Dropdown menu that allows users to select different types of attachments
 * to add to their message (images, text files, PDFs).
 * 
 * @component
 * @property {Function} onImageClick - Callback when image option is clicked
 * @property {Function} onTextFileClick - Callback when text file option is clicked
 * @property {Function} onPdfClick - Callback when PDF option is clicked
 * @property {boolean} supportsVision - Whether current model supports vision (enables/disables image option)
 * @property {boolean} [disabled] - Whether the menu is disabled
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

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Menu items configuration
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
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${item.enabled
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
 * 
 * Generic dropdown component for selecting from a list of options.
 * Used for both agent and model selection in the input area toolbar.
 * 
 * @component
 * @template T - Type of option objects (must have label and value properties)
 * @property {React.ReactNode} icon - Icon to display in the selector button
 * @property {T[]} options - Array of selectable options
 * @property {string} currentValue - Currently selected value
 * @property {Function} onSelect - Callback when an option is selected
 * @property {boolean} [disabled] - Whether the selector is disabled
 * @property {string} [placeholder] - Placeholder text when no option is selected
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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Find current option label or use placeholder
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

/**
 * Handle interface for InputArea component
 * 
 * Exposes methods that parent components can call via ref to control the InputArea.
 * Used with React.forwardRef to provide imperative access to component functionality.
 * 
 * @interface InputAreaHandle
 * @property {Function} setValue - Set the textarea content programmatically
 * @property {Function} focus - Focus the textarea element
 * 
 * @example
 * const inputRef = useRef<InputAreaHandle>(null);
 * // Later...
 * inputRef.current?.setValue("Hello");
 * inputRef.current?.focus();
 */
export interface InputAreaHandle {
  setValue: (value: string) => void;
  focus: () => void;
  /** 从外部（例如聊天窗口 drop）追加文件到待发送附件 */
  addFiles: (files: FileList | File[]) => void;
  /** 从外部（例如聊天窗口 drop）把纯文本插入到输入框光标处 */
  insertText: (text: string) => void;
}

/**
 * InputArea Component
 * 
 * Responsive input area with auto-expanding textarea and comprehensive attachment support.
 * This is the main input component for the chat interface, handling user text input,
 * file attachments (images, text files, PDFs), and message sending.
 * 
 * Key Features:
 * - Auto-expanding textarea (40px - 200px height range)
 * - Multi-file attachment support (images, text files, PDFs)
 * - Drag-and-drop file upload
 * - Paste file support from clipboard
 * - File count validation and error handling
 * - Model capability awareness (vision, thinking)
 * - Agent and model selection
 * - Context usage indicator
 * - Keyboard shortcuts (Enter to send, Shift+Enter for newline)
 * 
 * File Handling:
 * - Images: Converted to base64 for preview and sending
 * - Text files: Read and formatted with filename headers
 * - PDFs: Processed with page extraction and metadata
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 * 
 * @component
 * @param {InputAreaProps} props - Component props
 * @param {React.Ref<InputAreaHandle>} ref - Forwarded ref for imperative access
 * 
 * @example
 * <InputArea
 *   onSend={(content, thinking, images) => handleSend(content, thinking, images)}
 *   disabled={false}
 *   isGenerating={false}
 *   supportsVision={true}
 *   supportsThinking={true}
 * />
 */
export const InputArea = React.forwardRef<InputAreaHandle, InputAreaProps>(({
  onSend,
  onAbort,
  disabled,
  isGenerating,
  supportsThinking = false,
  supportsVision = false,
  contextUsage = null,
  apiProtocol = 'chat_completions',
  providerType,
  value: controlledValue,
  onValueChange,
  thinkingMode: controlledThinkingMode,
  onThinkingModeChange,
  useReasoningEffort = false,
  runMode = 'chat',
  onRunModeChange,
  agents = [],
  currentAgentName = '',
  onAgentSelect,
  modelOptions = [],
  currentModelRef = '',
  onModelSelect,
  supportsWebSearch = false,
  webSearchEnabled = false,
  onWebSearchToggle,
  webSearchToggleMode,
  webSearchDetails,
  pdfDebugMode = false,
}, ref) => {
  const [contentDraft, setContentDraft] = useState('');

  const content = controlledValue ?? contentDraft;

  const handleContentChange = useCallback(
    (value: string) => {
      onValueChange?.(value);
      if (controlledValue === undefined) {
        setContentDraft(value);
      }
    },
    [onValueChange, controlledValue]
  );
  // Initialize thinking mode based on API protocol
  const [thinkingModeDraft, setThinkingModeDraft] = useState<ThinkingMode>(
    apiProtocol === 'responses' ? 'medium' : true
  );

  // When uncontrolled, keep draft mode aligned to protocol changes
  useEffect(() => {
    if (controlledThinkingMode !== undefined) return;
    setThinkingModeDraft(apiProtocol === 'responses' ? 'medium' : true);
  }, [apiProtocol, controlledThinkingMode]);

  const thinkingMode = controlledThinkingMode ?? thinkingModeDraft;

  const handleThinkingModeChange = useCallback(
    (value: ThinkingMode) => {
      onThinkingModeChange?.(value);
      if (controlledThinkingMode === undefined) {
        setThinkingModeDraft(value);
      }
    },
    [onThinkingModeChange, controlledThinkingMode]
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
   * Insert text at the current cursor position (or append if cursor is unavailable).
   * Used by drag-drop of plain text from both input area and chat window.
   */
  const insertTextAtCursor = useCallback(
    (text: string) => {
      if (!text || disabled) return;

      const textarea = textareaRef.current;
      const current = content ?? '';

      if (!textarea) {
        handleContentChange(current + text);
        return;
      }

      const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : current.length;
      const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : current.length;

      const next = current.slice(0, start) + text + current.slice(end);
      handleContentChange(next);

      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const cursor = start + text.length;
        try {
          el.setSelectionRange(cursor, cursor);
        } catch {
          // ignore
        }
      });
    },
    [content, disabled, isGenerating, handleContentChange]
  );

  /**
   * Convert file to base64 data URL
   * 
   * Reads a file and converts it to a base64-encoded data URL that can be used
   * in image src attributes or sent to APIs.
   * 
   * @param {File} file - The file to convert
   * @returns {Promise<string>} Promise that resolves to base64 data URL
   * @throws {Error} If file reading fails
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
   * 
   * This helper function creates a FileList-compatible object from a File array.
   * This is necessary because the FileList constructor is not directly available
   * in JavaScript, but many APIs (like file input handlers) expect FileList objects.
   * 
   * The created object implements:
   * - length property
   * - item(index) method
   * - Indexed access (fileList[0], fileList[1], etc.)
   * - Iterator protocol (for...of support)
   * 
   * @param {File[]} files - Array of File objects to convert
   * @returns {FileList} FileList-like object containing the files
   * 
   * @example
   * const files = [file1, file2, file3];
   * const fileList = createFileList(files);
   * handleTextFileSelect(fileList);
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
   * 
   * Processes selected image files, validates them, converts to base64 data URLs,
   * and adds them to the pending images list for preview and sending.
   * 
   * Validation:
   * - Only accepts files with MIME type starting with "image/"
   * - Rejects files larger than 20MB
   * - Only processes files if model supports vision
   * 
   * @param {FileList | null} files - FileList from file input or drag-drop
   */
  const handleImageSelect = useCallback(async (files: FileList | null) => {
    if (!files || !supportsVision) return;

    const newImages: PendingImage[] = [];
    for (const rawFile of Array.from(files)) {
      const file = normalizeDroppedImageFile(rawFile) ?? rawFile;
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
   * Remove a pending text file from the list
   * 
   * Also clears any file error messages when a file is removed.
   * 
   * Requirement 2.4
   * 
   * @param {string} id - Unique identifier of the text file to remove
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

    for (const rawFile of filesToProcess) {
      const file = normalizeDroppedPdfFile(rawFile) ?? rawFile;
      // Validate file type (Requirements: 1.1, 1.2, 1.3)
      if (!isValidPdfFile(file)) {
        setPdfError(PASTE_ERROR_MESSAGES.PDF_INVALID_TYPE);
        continue;
      }

      // Validate file size (Requirements: 1.3, 1.5)
      if (!validatePdfSize(file)) {
        setPdfError(PASTE_ERROR_MESSAGES.PDF_TOO_LARGE(MAX_PDF_SIZE / 1024 / 1024));
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
   * Remove a pending PDF from the list
   * 
   * Also clears any PDF error messages when a PDF is removed.
   * 
   * Requirement 5.1
   * 
   * @param {string} id - Unique identifier of the PDF to remove
   */
  const removePdf = useCallback((id: string) => {
    setPendingPdfs(prev => prev.filter(p => p.id !== id));
    setPdfError(null);
  }, []);

  /**
   * Handle PDF page range change
   * 
   * Updates the page range selection for a specific PDF. This allows users to
   * select which pages of the PDF to include in the message.
   * 
   * Requirement 5.3
   * 
   * @param {string} id - Unique identifier of the PDF
   * @param {number} [startPage] - Starting page number (1-indexed), undefined for all pages
   * @param {number} [endPage] - Ending page number (1-indexed), undefined for all pages
   */
  const handlePdfPageRangeChange = useCallback((id: string, startPage?: number, endPage?: number) => {
    setPendingPdfs(prev =>
      prev.map(pdf =>
        pdf.id === id
          ? { ...pdf, pageRangeStart: startPage, pageRangeEnd: endPage }
          : pdf
      )
    );
  }, []);

  /**
   * Handle PDF include images option change
   * 
   * Toggles whether images should be extracted from the PDF pages.
   * When enabled, images embedded in PDF pages are included in the content.
   * 
   * Requirement 5.4
   * 
   * @param {string} id - Unique identifier of the PDF
   * @param {boolean} includeImages - Whether to include images from PDF
   */
  const handlePdfIncludeImagesChange = useCallback((id: string, includeImages: boolean) => {
    setPendingPdfs(prev =>
      prev.map(pdf =>
        pdf.id === id
          ? { ...pdf, includeImages }
          : pdf
      )
    );
  }, []);

  /**
   * Handle PDF include text option change
   * 
   * Toggles whether text should be extracted from the PDF pages.
   * When enabled, text content from PDF pages is included in the message.
   * 
   * Requirement 5.5
   * 
   * @param {string} id - Unique identifier of the PDF
   * @param {boolean} includeText - Whether to include text from PDF
   */
  const handlePdfIncludeTextChange = useCallback((id: string, includeText: boolean) => {
    setPendingPdfs(prev =>
      prev.map(pdf =>
        pdf.id === id
          ? { ...pdf, includeText }
          : pdf
      )
    );
  }, []);

  /**
   * Handle paste event for images, text files, and PDF files
   * 
   * This function processes clipboard paste events to extract and add files (images, text files, PDFs)
   * to the input area. It implements comprehensive file handling with validation, error recovery,
   * and user feedback.
   * 
   * The paste handling workflow:
   * 1. Clear previous errors to start fresh
   * 2. Extract and classify files from clipboard data
   * 3. Detect file types (images, text files, PDFs) using MIME types and extensions
   * 4. Track unsupported files and null file items for debugging
   * 5. Validate files against count limits using validatePasteFiles
   * 6. Process valid files through appropriate handlers (handleImageSelect, handleTextFileSelect, handlePdfSelect)
   * 7. Display warnings for skipped files or exceeded limits
   * 8. Implement error recovery - partial failures don't prevent successful files from being added
   * 
   * File type detection:
   * - Images: MIME type starts with "image/" AND supportsVision is true
   * - PDFs: MIME type is "application/pdf" OR filename ends with ".pdf"
   * - Text files: Validated using isSupportedTextFile() function
   * - Unsupported: All other file types are silently skipped
   * 
   * Default behavior handling:
   * - Pure text paste: Default behavior is preserved (no preventDefault)
   * - File paste: Default behavior is prevented (preventDefault called)
   * - Mixed paste: Files take priority over text
   * 
   * Error handling:
   * - Individual item processing errors are caught and logged
   * - File reading errors are caught and displayed to user
   * - Partial failures allow successful files to be added
   * - Null file items (getAsFile() returns null) are tracked and skipped
   * 
   * Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 7.4
   * 
   * @param {React.ClipboardEvent} e - The clipboard paste event
   * 
   * @example
   * // User pastes 2 images and 1 PDF
   * // Result: Both images and PDF are added if within limits
   * 
   * @example
   * // User pastes 15 images when limit is 10 and 5 already exist
   * // Result: First 5 images are added, warning shown about limit
   * 
   * @example
   * // User pastes plain text
   * // Result: Default paste behavior (text inserted into textarea)
   */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // Clear previous errors at the start of new operation (Requirement 4.4)
    setFileError(null);
    setPdfError(null);

    try {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      const textFiles: File[] = [];
      const pdfFiles: File[] = [];
      let skippedUnsupportedCount = 0;
      let skippedNullFileCount = 0;  // Track items where getAsFile() returns null

      // Collect and classify files from clipboard in order (Requirements: 2.1, 2.3, 7.4)
      // Process each clipboard item sequentially to maintain paste order
      for (const item of Array.from(items)) {
        try {
          const file = item.getAsFile();
          if (!file) {
            // Skip if getAsFile() returns null (Requirement 7.4)
            // This can happen for non-file clipboard items or browser limitations
            skippedNullFileCount++;
            console.debug('Skipped clipboard item with null file:', item.type);
            continue;
          }

          // Check for images (Requirements: 3.1, 3.2 - consider supportsVision flag)
          // Only accept images if model supports vision capability
          if (item.type.startsWith('image/') && supportsVision) {
            imageFiles.push(file);
          }
          // Check for PDF files (Requirements: 1.1, 1.2, 3.4 - check MIME type and extension)
          // Use both MIME type and file extension for robust PDF detection
          else if (item.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            pdfFiles.push(normalizeDroppedPdfFile(file) ?? file);
          }
          // Check for text files (Requirements: 3.3, 3.5 - use isSupportedTextFile)
          // Delegate to utility function for consistent text file validation
          else if (isSupportedTextFile(file.name)) {
            textFiles.push(file);
          }
          // Track unsupported files (Requirement 2.3, 3.5)
          // These will be silently skipped but counted for user feedback
          else {
            skippedUnsupportedCount++;
          }
        } catch (itemError) {
          // Handle individual item processing errors (Requirement 4.3)
          // Don't let one bad item break the entire paste operation
          console.error('Error processing clipboard item:', itemError);
          // Continue processing other items
          continue;
        }
      }

      // If no files detected, allow default paste behavior (Requirement 5.1)
      // This preserves normal text paste functionality
      if (imageFiles.length === 0 && textFiles.length === 0 && pdfFiles.length === 0) {
        return;
      }

      // Prevent default behavior when files are detected (Requirement 5.2)
      // This stops the browser from inserting file paths or other default behavior
      e.preventDefault();

      // Validate files against count limits before processing (Requirements: 2.2, 6.1, 6.2, 6.3, 6.4)
      // This ensures we respect attachment limits and provide clear feedback
      const validation = validatePasteFiles(
        imageFiles,
        textFiles,
        pdfFiles,
        pendingImages.length,
        pendingTextFiles.length,
        pendingPdfs.length,
        supportsVision
      );

      // If no valid files, show errors and return
      if (!validation.canProceed) {
        if (validation.errors.length > 0) {
          // Show the first error (most relevant)
          // Categorize error by file type for appropriate error state
          if (imageFiles.length > 0 && !supportsVision) {
            setFileError(validation.errors[0]);
          } else if (validation.errors[0].includes('图片')) {
            setFileError(validation.errors[0]);
          } else if (validation.errors[0].includes('文本')) {
            setFileError(validation.errors[0]);
          } else if (validation.errors[0].includes('PDF')) {
            setPdfError(validation.errors[0]);
          } else {
            setFileError(validation.errors[0]);
          }
        }
        return;
      }

      // Process valid files in order to maintain paste sequence (Requirement 2.1, 2.4)
      // Ensure partial failures don't prevent successful files from being added (Requirement 4.3)

      // Handle valid image files
      if (validation.imageFiles.length > 0) {
        try {
          // Create FileList from array for handleImageSelect
          const dataTransfer = new DataTransfer();
          validation.imageFiles.forEach(f => dataTransfer.items.add(f));
          handleImageSelect(dataTransfer.files);
        } catch (imageError) {
          // Log error but continue processing other file types
          console.error('Error processing image files:', imageError);
          setFileError('部分图片文件处理失败，请重试');
        }
      }

      // Handle valid text files
      if (validation.textFiles.length > 0) {
        try {
          // Use createFileList helper to convert array to FileList
          handleTextFileSelect(createFileList(validation.textFiles));
        } catch (textError) {
          // Log error but continue processing other file types
          console.error('Error processing text files:', textError);
          setFileError('部分文本文件处理失败，请重试');
        }
      }

      // Handle valid PDF files (Requirements: 1.1, 1.2)
      if (validation.pdfFiles.length > 0) {
        try {
          // Use createFileList helper to convert array to FileList
          handlePdfSelect(createFileList(validation.pdfFiles));
        } catch (pdfError) {
          // Log error but continue processing other file types
          console.error('Error processing PDF files:', pdfError);
          setPdfError('部分 PDF 文件处理失败，请重试');
        }
      }

      // Show warning if some files were skipped (Requirements: 2.2, 2.3, 7.4)
      // Collect all warnings to provide comprehensive feedback
      const warnings: string[] = [];

      // Add validation errors (files exceeding limits)
      if (validation.errors.length > 0) {
        warnings.push(...validation.errors);
      }

      // Add unsupported file type warning (Requirement 2.3)
      if (skippedUnsupportedCount > 0) {
        warnings.push(`已跳过 ${skippedUnsupportedCount} 个不支持的文件类型`);
      }

      // Add null file warning for debugging (Requirement 7.4)
      if (skippedNullFileCount > 0) {
        console.debug(`Skipped ${skippedNullFileCount} clipboard items with null files`);
        // Only show warning if no other files were processed successfully
        if (validation.imageFiles.length === 0 && validation.textFiles.length === 0 && validation.pdfFiles.length === 0) {
          warnings.push(`无法读取 ${skippedNullFileCount} 个剪贴板项目`);
        }
      }

      // Display warnings if any
      if (warnings.length > 0) {
        const warningMessage = warnings.join('；');
        // Categorize warning by file type for appropriate error state
        if (warningMessage.includes('图片')) {
          setFileError(warningMessage);
        } else if (warningMessage.includes('文本')) {
          setFileError(warningMessage);
        } else if (warningMessage.includes('PDF')) {
          setPdfError(warningMessage);
        } else {
          // Generic warning
          setFileError(warningMessage);
        }
      }
    } catch (error) {
      // Catch any unexpected errors during paste handling (Requirement 4.3)
      // This is the last line of defense to prevent crashes
      console.error('Unexpected error during paste handling:', error);
      setFileError('粘贴文件时发生错误，请重试');
    }
  }, [supportsVision, handleImageSelect, handleTextFileSelect, handlePdfSelect, createFileList, pendingImages.length, pendingTextFiles.length, pendingPdfs.length]);

  /**
   * Handle drag and drop
   * 
   * Processes files dropped onto the input area, separating them by type
   * (images, text files, PDFs) and passing them to appropriate handlers.
   * 
   * File classification:
   * - Images: MIME type starts with "image/" (vision capability checked in validatePasteFiles)
   * - PDFs: MIME type is "application/pdf" OR filename ends with ".pdf"
   * - Text files: Validated using isSupportedTextFile() function
   * - Unsupported files are silently ignored
   * 
   * Requirements: 4.1, 4.2, 4.3, 4.4, 7.1, 7.2, 7.3, 7.4, 7.6
   * 
   * @param {React.DragEvent} e - The drag event
   */
  const handleDroppedFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files || files.length === 0 || disabled) return;

      // Clear previous errors at the start of new operation
      setFileError(null);
      setPdfError(null);

      // Separate image files, text files, and PDF files
      const imageFiles: File[] = [];
      const textFiles: File[] = [];
      const pdfFiles: File[] = [];

      // Classify each dropped file by type
      for (const rawFile of Array.from(files)) {
        const imageFile = normalizeDroppedImageFile(rawFile);
        if (imageFile) {
          imageFiles.push(imageFile);
          continue;
        }

        const pdfFile = normalizeDroppedPdfFile(rawFile);
        if (pdfFile) {
          pdfFiles.push(pdfFile);
          continue;
        }

        if (isSupportedTextFile(rawFile.name)) {
          textFiles.push(rawFile);
        }
        // Silently ignore unsupported files (Requirement 4.3, 7.3)
      }

      if (imageFiles.length === 0 && textFiles.length === 0 && pdfFiles.length === 0) {
        setFileError(PASTE_ERROR_MESSAGES.NO_SUPPORTED_FILES);
        return;
      }

      // Reuse paste validation to enforce limits & capability checks（仅图片/文本）
      // PDF 的数量限制与错误文案由 handlePdfSelect 统一处理，避免与 validatePasteFiles 的提示不一致
      const validation = validatePasteFiles(
        imageFiles,
        textFiles,
        [],
        pendingImages.length,
        pendingTextFiles.length,
        pendingPdfs.length,
        supportsVision
      );

      if (validation.errors.length > 0) {
        const pdfErrors = validation.errors.filter((error) => error.toUpperCase().includes('PDF'));
        const otherErrors = validation.errors.filter((error) => !error.toUpperCase().includes('PDF'));

        if (otherErrors.length > 0) setFileError(otherErrors[0]);
        if (pdfErrors.length > 0) setPdfError(pdfErrors[0]);
      }

      if (validation.canProceed && validation.imageFiles.length > 0) {
        handleImageSelect(createFileList(validation.imageFiles));
      }
      if (validation.canProceed && validation.textFiles.length > 0) {
        handleTextFileSelect(createFileList(validation.textFiles));
      }
      if (pdfFiles.length > 0) {
        // PDF 数量限制与错误文案由 handlePdfSelect 统一处理，避免与 validatePasteFiles 的提示不一致
        handlePdfSelect(createFileList(pdfFiles));
      }
    },
    [
      disabled,
      isGenerating,
      pendingImages.length,
      pendingTextFiles.length,
      pendingPdfs.length,
      supportsVision,
      handleImageSelect,
      handleTextFileSelect,
      handlePdfSelect,
      createFileList,
    ]
  );

  const handleDroppedPaths = useCallback(
    async (paths: string[]) => {
      if (!paths || paths.length === 0 || disabled) return;

      // Clear previous errors at the start of new operation
      setFileError(null);
      setPdfError(null);

      const supportedPaths = paths.filter((path) => {
        const filename = getFilenameFromPath(path);
        if (filename.toLowerCase().endsWith('.pdf')) return true;
        if (inferImageMimeType(filename)) return true;
        return isSupportedTextFile(filename);
      });

      if (supportedPaths.length === 0) {
        setFileError(PASTE_ERROR_MESSAGES.NO_SUPPORTED_FILES);
        return;
      }

      type LocalFileBase64 = {
        filename: string;
        mime: string;
        base64: string;
        size: number;
      };

      const files: File[] = [];
      const errors: string[] = [];

      for (const path of supportedPaths) {
        try {
          const payload = await invoke<LocalFileBase64>('read_local_file_base64', { path });
          const bytes = base64ToUint8Array(payload.base64);
          files.push(new File([bytes], payload.filename, { type: payload.mime, lastModified: Date.now() }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          console.error('Failed to load dropped file from path:', path, error);
        }
      }

      if (files.length === 0 && errors.length > 0) {
        setFileError(errors[0]);
        return;
      }

      if (files.length === 0) {
        setFileError('拖拽文件读取失败，请检查文件是否存在/权限，或尝试用“+”按钮选择文件');
        return;
      }

      handleDroppedFiles(files);
    },
    [disabled, handleDroppedFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const dataTransfer = e.dataTransfer;

      const droppedFiles =
        dataTransfer.files && dataTransfer.files.length > 0
          ? Array.from(dataTransfer.files)
          : Array.from(dataTransfer.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));

      // 在 Tauri 里，文件拖拽由 tauri://drag-drop 提供真实路径，这里避免与 DOM drop 重复处理
      if (!isTauri() && droppedFiles.length > 0) {
        handleDroppedFiles(droppedFiles);
        return;
      }

      // Plain text drag-drop (e.g., from browser/editor)
      const text = dataTransfer.getData('text/plain') || dataTransfer.getData('text/uri-list');
      if (text) {
        insertTextAtCursor(text);
      }
    },
    [handleDroppedFiles, insertTextAtCursor]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Prevent default to allow drop
    e.preventDefault();
  }, []);

  // 在 Tauri WebView 里，系统层面的文件拖拽不一定会触发 DOM drop 事件
  // 使用 tauri://drag-drop 事件获取真实的本地路径，再转成 File 复用现有附件逻辑
  const handleDroppedPathsRef = useRef(handleDroppedPaths);
  useEffect(() => {
    handleDroppedPathsRef.current = handleDroppedPaths;
  }, [handleDroppedPaths]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const unlistenFn = await getCurrentWindow().onDragDropEvent((event) => {
          if (event.payload.type !== 'drop') return;
          void handleDroppedPathsRef.current(event.payload.paths);
        });

        if (disposed) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      } catch (error) {
        console.error('Failed to register Tauri drag drop listener:', error);
        if (!disposed) {
          setFileError('初始化拖拽监听失败，请检查 Tauri 权限/窗口配置');
        }
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * Remove a pending image from the list
   * 
   * @param {string} id - Unique identifier of the image to remove
   */
  const removeImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  }, []);

  /**
   * Helper to adjust textarea height based on content
   * 
   * Resets the textarea height to auto, then calculates and applies the appropriate
   * height based on scroll height, constrained between min and max limits.
   * This enables the auto-expanding textarea behavior.
   */
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = calculateTextareaHeight(textarea.scrollHeight);
      textarea.style.height = `${newHeight}px`;
    }
  }, []);

  /**
   * Expose methods to parent component via ref
   * 
   * Allows parent components to programmatically control the InputArea:
   * - setValue: Set textarea content and auto-resize
   * - focus: Focus the textarea element
   */
  React.useImperativeHandle(ref, () => ({
    setValue: (value: string) => {
      handleContentChange(value);
      // Auto-resize after setting content
      requestAnimationFrame(() => {
        adjustTextareaHeight();
        textareaRef.current?.focus();
      });
    },
    focus: () => {
      textareaRef.current?.focus();
    },
    addFiles: (files: FileList | File[]) => {
      handleDroppedFiles(files);
    },
    insertText: (text: string) => {
      insertTextAtCursor(text);
    },
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
   * 
   * Validates input, builds content parts from attachments, and sends the message.
   * After sending, clears the input and all pending attachments.
   * 
   * Validation:
   * - Prevents sending if input is empty/whitespace-only AND no attachments
   * - Prevents sending if disabled or currently generating
   * 
   * Content building:
   * - Trims whitespace from text content
   * - Adds image content parts with base64 URLs
   * - Adds text file content parts with raw content (backend formats)
   * - Adds PDF content parts with pages and metadata
   * 
   * Cleanup:
   * - Clears text content
   * - Clears all pending attachments (images, text files, PDFs)
   * - Clears error messages
   * - Resets textarea height
   * - Refocuses textarea for next input
   * 
   * Requirement 4.4: Click send button to send message
   * Requirement 4.6: Don't send empty/whitespace-only input (unless there are attachments)
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
    handleContentChange('');
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
  }, [content, pendingImages, pendingTextFiles, pendingPdfs, disabled, isGenerating, onSend, supportsThinking, thinkingMode, handleContentChange]);

  /**
   * Handle keyboard events in textarea
   * 
   * Implements keyboard shortcuts:
   * - Enter (without Shift): Send message
   * - Shift+Enter: Insert newline (default behavior)
   * 
   * Requirement 4.2: Enter (without Shift) sends message
   * Requirement 4.3: Shift+Enter inserts newline
   * 
   * @param {React.KeyboardEvent<HTMLTextAreaElement>} e - Keyboard event
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
   * Handle input change in textarea
   * 
   * Updates the content state as user types. The textarea will auto-resize
   * via the useEffect that watches the content state.
   * 
   * @param {React.ChangeEvent<HTMLTextAreaElement>} e - Change event
   */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleContentChange(e.target.value);
    },
    [handleContentChange]
  );

  /**
   * Handle abort button click
   * 
   * Calls the onAbort callback to stop the current message generation.
   */
  const handleAbort = useCallback(() => {
    onAbort?.();
  }, [onAbort]);

  // Requirement 4.6: Disable send button for empty/whitespace input (unless there are attachments)
  const hasAttachments = pendingImages.length > 0 || pendingTextFiles.length > 0 || pendingPdfs.length > 0;
  const isSendDisabled = disabled || (isWhitespaceOnly(content) && !hasAttachments);

  const currentAgent = useMemo(() => {
    if (!currentAgentName) return undefined;
    return agents.find((a) => a.name === currentAgentName);
  }, [agents, currentAgentName]);

  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
  const hasMcpSetBinding = Boolean(currentAgent?.mcpSet);

  // Convert agents to selector options (include type to make it visible even when truncated)
  const agentOptions = useMemo(() => {
    return agents.map((a) => ({
      label: a.type ? `${a.displayName} (${a.type})` : a.displayName,
      value: a.name,
    }));
  }, [agents]);

  // Check if we have selectors to show
  const hasSelectors = agents.length > 0 || modelOptions.length > 0;
  const hasModeSelector = Boolean(onRunModeChange);
  const hasFeatureToggles =
    hasModeSelector || supportsThinking || supportsWebSearch || supportsVision || contextUsage || hasSelectors;

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
            {/* Run mode selector (menu) */}
            {onRunModeChange && (
              <CompactSelector
                icon={<span className="text-[10px] text-gray-500 dark:text-gray-400">模式</span>}
                options={RUN_MODE_OPTIONS}
                currentValue={runMode}
                onSelect={(value) => onRunModeChange(value as RunMode)}
                disabled={isGenerating}
                placeholder="模式"
              />
            )}
            {/* Agent selector */}
            {agents.length > 0 && currentAgentName && (
              onAgentSelect ? (
                <CompactSelector
                  icon={<Bot size={12} />}
                  options={agentOptions}
                  currentValue={currentAgentName}
                  onSelect={onAgentSelect}
                  disabled={isGenerating}
                  placeholder="智能体"
                />
              ) : (
                <div
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border',
                    'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700',
                    'text-gray-700 dark:text-gray-200',
                  ].join(' ')}
                  title={currentAgent?.type ? `${currentAgent.displayName} (${currentAgent.type})` : (currentAgent?.displayName || currentAgentName)}
                >
                  <Bot size={12} className="text-gray-500 dark:text-gray-400" />
                  <span className="text-sm font-medium max-w-40 truncate">
                    {currentAgent?.displayName || currentAgentName}
                    {currentAgent?.type ? ` (${currentAgent.type})` : ''}
                  </span>
                </div>
              )
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
                providerType={providerType}
                value={thinkingMode}
                onChange={handleThinkingModeChange}
                disabled={isGenerating}
                useReasoningEffort={useReasoningEffort}
              />
            )}
            {/* Web search toggle */}
            {supportsWebSearch && onWebSearchToggle && (
              <WebSearchToggle
                enabled={webSearchEnabled}
                onToggle={() => onWebSearchToggle(!webSearchEnabled)}
                disabled={isGenerating}
                mode={webSearchToggleMode}
                details={webSearchDetails}
              />
            )}

            {/* MCP button (shows bound MCP set + tools) */}
            {hasMcpSetBinding && (
              <button
                type="button"
                disabled={disabled || isGenerating}
                onClick={() => setIsMcpModalOpen(true)}
                className={[
                  'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                  'border-gray-200 dark:border-gray-700',
                  'bg-gray-50 dark:bg-gray-900',
                  'text-gray-700 dark:text-gray-200',
                  'hover:bg-gray-100 dark:hover:bg-gray-800',
                  disabled || isGenerating ? 'opacity-60 cursor-not-allowed' : '',
                ].join(' ')}
                title={'查看 MCP'}
              >
                <Plug size={12} />
                <span>MCP</span>
              </button>
            )}
          </div>
          {/* Context usage indicator on the right */}
          {contextUsage && (
            <ContextUsageIndicator usage={contextUsage} disabled={isGenerating} />
          )}
        </div>
      )}

      {/* Unified attachment preview area */}
      {(pendingImages.length > 0 || pendingTextFiles.length > 0 || pendingPdfs.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-2 max-h-96 overflow-auto">
          {/* Render images */}
          {pendingImages.map(img => (
            <AttachmentPreview
              key={img.id}
              attachment={img}
              type="image"
              onRemove={removeImage}
            />
          ))}
          {/* Render text files */}
          {pendingTextFiles.map(file => (
            <AttachmentPreview
              key={file.id}
              attachment={file}
              type="text"
              onRemove={removeTextFile}
            />
          ))}
          {/* Render PDFs */}
          {pendingPdfs.map(pdf => (
            <AttachmentPreview
              key={pdf.id}
              attachment={pdf}
              type="pdf"
              onRemove={removePdf}
              pdfDebugMode={pdfDebugMode}
              onPdfPageRangeChange={handlePdfPageRangeChange}
              onPdfIncludeImagesChange={handlePdfIncludeImagesChange}
              onPdfIncludeTextChange={handlePdfIncludeTextChange}
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
          placeholder={supportsVision ? "输入消息，或粘贴/拖拽图片、文本文件和 PDF..." : "输入消息，或粘贴/拖拽文本文件和 PDF..."}
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

      {/* MCP modal */}
      {currentAgentName && (
        <McpModal
          isOpen={isMcpModalOpen}
          onClose={() => setIsMcpModalOpen(false)}
          agentName={currentAgentName}
        />
      )}
    </div>
  );
});

export default InputArea;
