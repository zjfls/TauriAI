/**
 * InputArea Component
 * Responsive input area with auto-expanding textarea and send functionality
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
import { Send, Square, Bot, Cpu, ChevronDown, Check, ImagePlus, Paperclip, FileText, Plug, File as FileIcon, Copy, GitBranch, Loader2, Plus } from 'lucide-react';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { McpModal } from './McpModal';
import { AttachmentPreview } from './AttachmentPreview';
import { ThinkingSelector } from './ThinkingSelector';
import { WebSearchToggle, type WebSearchProvider } from './WebSearchToggle';
import { isSupportedTextFile, readTextFile, validateFileCount } from '../../utils/textFileUtils';
import { isValidPdfFile, validatePdfSize, processPdfFile, MAX_PDF_SIZE } from '../../utils/pdfUtils';
import type {
  ContextUsageBreakdown,
  Agent,
  ContentPart,
  CodeSnippetContentPart,
  PendingImage,
  PendingTextFile,
  PendingPdf,
  ApiProtocolType,
  ThinkingMode,
  ProviderType,
  RunMode,
  SkillEntry,
  SkillLoadOutcome,
  Workstudio,
} from '../../types';
import { SUPPORTED_TEXT_EXTENSIONS, MAX_PDF_COUNT, MAX_TEXT_FILES } from '../../types';
import { FILE_ERROR_MESSAGES } from '../../utils/textFileUtils';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { message as showMessageDialog } from '@tauri-apps/plugin-dialog';
import { useConfigStore } from '../../stores/configStore';
import { SHORTCUT_ACTIONS, detectShortcutPlatform, normalizeKeybindingString } from '../../shortcuts';

// Constants for textarea sizing
const MIN_TEXTAREA_HEIGHT = 40; // Minimum height in pixels
const MAX_TEXTAREA_HEIGHT = 200; // Maximum height in pixels (Requirement 4.1)

const RUN_MODE_OPTIONS: { value: RunMode; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'agent', label: 'Agent' },
  { value: 'agent-full-access', label: 'Agent Full Access' },
  { value: 'agent-custom', label: 'Custom' },
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

function normalizePathForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function basename(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length === 0 ? p : segments[segments.length - 1];
}

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const maybeError = (err as { error?: unknown }).error;
    if (typeof maybeError === 'string' && maybeError.trim()) return maybeError.trim();
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.trim()) return maybe.trim();
  }
  try {
    const s = JSON.stringify(err);
    return typeof s === 'string' && s.trim() ? s : String(err);
  } catch {
    return String(err);
  }
}

function summarizeGitError(raw: string, workdir?: string): string {
  const s = raw.trim();
  if (!s) return '未知错误';

  const lower = s.toLowerCase();

  if (
    s.includes('Your local changes to the following files would be overwritten by checkout') ||
    s.includes('would be overwritten by checkout') ||
    s.includes('Please commit your changes or stash them before you switch branches')
  ) {
    return '工作区存在未提交修改，切换分支会覆盖它们。请先提交/暂存，或执行 git stash 后再切换。';
  }

  if (s.includes('The following untracked working tree files would be overwritten by checkout')) {
    return '工作区存在未跟踪文件会被覆盖。请先移动/删除这些文件，或将其加入 Git 后再切换。';
  }

  if (lower.includes('pathspec') && lower.includes('did not match any file(s) known to git')) {
    return '分支不存在（本地）或名称错误。';
  }

  if (lower.includes('not a git repository')) {
    return '当前目录不是 Git 仓库。';
  }

  if (lower.includes('detected dubious ownership in repository')) {
    const suffix = workdir ? `\n\n可尝试：git config --global --add safe.directory "${workdir}"` : '';
    return `Git 安全策略阻止访问（dubious ownership，需要配置 safe.directory）。${suffix}`;
  }

  if (lower.includes('index.lock') && lower.includes('file exists')) {
    return 'Git 被其他进程占用（index.lock）。请关闭占用 Git 的进程，或确认无 git 操作后删除锁文件再重试。';
  }

  if (
    (lower.includes('a branch named') && lower.includes('already exists')) ||
    (lower.includes('branch') && lower.includes('already exists'))
  ) {
    return '分支已存在。';
  }

  return s;
}

type WorkspaceRoot = { key: string; name: string; absPath: string };

function buildWorkspaceRoots(workstudio?: Workstudio | null): WorkspaceRoot[] {
  if (!workstudio) return [];
  const roots = [workstudio.mainFolder, ...(workstudio.folders ?? [])].filter((p) => p && p.trim().length > 0);
  const unique = Array.from(new Set(roots));
  return unique.map((absPath) => {
    const name = basename(absPath);
    const hash = fnv1a32Hex(normalizePathForCompare(absPath)).slice(0, 6);
    return { key: `${name}~${hash}`, name, absPath };
  });
}

function absPathToWorkspaceUri(absPath: string, roots: WorkspaceRoot[]): string | null {
  const absN = normalizePathForCompare(absPath);
  let best: WorkspaceRoot | null = null;
  for (const r of roots) {
    const rootN = normalizePathForCompare(r.absPath);
    if (absN === rootN || absN.startsWith(rootN + '/')) {
      if (!best || rootN.length > normalizePathForCompare(best.absPath).length) {
        best = r;
      }
    }
  }
  if (!best) return null;
  const rootN = normalizePathForCompare(best.absPath);
  const rel = absN === rootN ? '' : absN.slice(rootN.length + 1);
  const encodedRel = rel
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `workspace://${encodeURIComponent(best.key)}/${encodedRel}`;
}

function parseWorkspaceUri(uri: string): { rootKey: string; relPath: string } | null {
  if (!uri.startsWith('workspace://')) return null;
  const rest = uri.slice('workspace://'.length);
  const idx = rest.indexOf('/');
  const rootKeyEnc = idx >= 0 ? rest.slice(0, idx) : rest;
  const relEnc = idx >= 0 ? rest.slice(idx + 1) : '';
  const rootKey = decodeURIComponent(rootKeyEnc);
  const relPath = relEnc
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .join('/');
  return { rootKey, relPath };
}

const WORKSPACE_MENTION_TOKEN_RE = /@\{ref:([0-9a-fA-F-]{36})\}/g;
const CODE_SNIPPET_TOKEN_RE = /@\{snippet:([0-9a-fA-F-]{36})\}/g;

function hasWorkspaceMentionTokens(text: string): boolean {
  if (!text) return false;
  WORKSPACE_MENTION_TOKEN_RE.lastIndex = 0;
  return WORKSPACE_MENTION_TOKEN_RE.test(text);
}

function hasCodeSnippetTokens(text: string): boolean {
  if (!text) return false;
  CODE_SNIPPET_TOKEN_RE.lastIndex = 0;
  return CODE_SNIPPET_TOKEN_RE.test(text);
}

function quoteIfNeededForAtPath(path: string): string {
  return /\s/.test(path) && !path.includes('"') ? `"${path}"` : path;
}

function expandWorkspaceMentionTokens(text: string, mentions: { id: string; absPath: string }[]): string {
  if (!text) return text;
  const byId = new Map(mentions.map((m) => [m.id, m.absPath]));
  return text.replace(WORKSPACE_MENTION_TOKEN_RE, (_m, id: string) => {
    const abs = byId.get(id);
    if (!abs) return '';
    return `@${quoteIfNeededForAtPath(abs)}`;
  });
}

function findWorkspaceMentionTokenAt(
  text: string,
  index: number
): { start: number; end: number; id: string } | null {
  if (index < 0 || index > text.length) return null;
  WORKSPACE_MENTION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORKSPACE_MENTION_TOKEN_RE.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (index >= start && index < end) {
      return { start, end, id: match[1] };
    }
  }
  return null;
}

function findCodeSnippetTokenAt(
  text: string,
  index: number
): { start: number; end: number; id: string } | null {
  if (index < 0 || index > text.length) return null;
  CODE_SNIPPET_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SNIPPET_TOKEN_RE.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (index >= start && index < end) {
      return { start, end, id: match[1] };
    }
  }
  return null;
}

function findActiveAtQuery(text: string, cursor: number): { start: number; query: string } | null {
  if (cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const lastAt = before.lastIndexOf('@');
  if (lastAt < 0) return null;
  const prev = lastAt === 0 ? '' : before[lastAt - 1];
  // Codex-like behavior: only trigger `@` completion at token boundaries.
  // i.e. allow start-of-text or whitespace on the left; disallow `@@`, `a@b`, `(@foo)` etc.
  if (prev && !/\s/.test(prev)) return null;
  const query = before.slice(lastAt + 1);
  // Ignore our internal workspace mention tokens: "@{ref:<uuid>}"
  if (query.startsWith('{ref:') || query.startsWith('{snippet:')) return null;
  if (/\s/.test(query)) return null;
  return { start: lastAt, query };
}

function isDollarMentionChar(ch: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(ch);
}

function findActiveDollarQuery(text: string, cursor: number): { start: number; query: string } | null {
  if (cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const lastDollar = before.lastIndexOf('$');
  if (lastDollar < 0) return null;
  // Ignore $$ (LaTeX block delimiter).
  if (lastDollar > 0 && before[lastDollar - 1] === '$') return null;
  const prev = lastDollar === 0 ? '' : before[lastDollar - 1];
  // Avoid cases like "price$usd" or other identifier fragments.
  if (prev && isDollarMentionChar(prev)) return null;

  const rest = before.slice(lastDollar + 1);
  // Only treat as an active query if the user is still typing a mention token.
  // i.e. all characters from `$` to cursor must be mention chars.
  if (rest && [...rest].some((ch) => !isDollarMentionChar(ch))) return null;
  return { start: lastDollar, query: rest };
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
  onCloneConversation?: () => void;
  disabled: boolean;
  isGenerating: boolean;
  queuedCount?: number;
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
  availableProviders?: WebSearchProvider[];  // Available search providers
  selectedProvider?: WebSearchProvider | null;  // Currently selected provider
  onProviderSelect?: (provider: WebSearchProvider | null) => void;  // Callback when provider is selected

  webSearchDetails?: string;
  // PDF debug mode
  pdfDebugMode?: boolean;  // Whether to enable PDF debug mode controls
  // Workstudio (for @ mention file chips)
  workstudio?: Workstudio | null;
  /** 草稿里的“代码片段 chip”（来自 Workstudio 选中内容右键 Add to chat） */
  codeSnippets?: CodeSnippetContentPart[];
  onCodeSnippetsChange?: (snippets: CodeSnippetContentPart[]) => void;
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

interface ExtraActionsMenuProps {
  onCloneConversation?: () => void;
  cloneConversationShortcutLabel?: string | null;
  disabled?: boolean;
}

const ExtraActionsMenu: React.FC<ExtraActionsMenuProps> = ({
  onCloneConversation,
  cloneConversationShortcutLabel,
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

  const menuItems = [
    {
      icon: <Copy size={14} />,
      label: '克隆对话',
      onClick: onCloneConversation,
      enabled: typeof onCloneConversation === 'function',
      disabledTip: '当前对话不可克隆',
      shortcut: cloneConversationShortcutLabel ?? null,
    },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="inline-flex items-center gap-1 text-gray-400 hover:text-blue-500 dark:text-gray-500 dark:hover:text-blue-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title="更多操作"
        aria-label="更多操作"
      >
        <FileIcon size={12} />
        <span>更多</span>
        <ChevronDown size={10} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-40 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
          {menuItems.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                if (item.enabled && item.onClick) {
                  item.onClick();
                  setIsOpen(false);
                }
              }}
              disabled={!item.enabled || disabled}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${item.enabled && !disabled
                ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                }`}
              title={!item.enabled ? item.disabledTip : undefined}
            >
              {item.icon}
              <span className="text-xs">{item.label}</span>
              {item.shortcut ? (
                <span className="ml-auto rounded border border-gray-200 bg-white/60 px-1.5 py-0.5 text-[10px] font-mono text-gray-500 dark:border-gray-700 dark:bg-black/20 dark:text-gray-400">
                  {item.shortcut}
                </span>
              ) : null}
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
        <div className="absolute bottom-full left-0 mb-1 w-[18.667rem] bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 max-h-60 overflow-auto">
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
  /** 从外部（例如撤回）恢复待发送的多模态内容 */
  setContentParts: (parts?: ContentPart[]) => void;
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
  onCloneConversation,
  disabled,
  isGenerating,
  queuedCount = 0,
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
  availableProviders,
  selectedProvider,
  onProviderSelect,

  webSearchDetails,
  pdfDebugMode = false,
  workstudio,
  codeSnippets = [],
  onCodeSnippetsChange,
}, ref) => {
  const [contentDraft, setContentDraft] = useState('');

  const content = controlledValue ?? contentDraft;
  const workspaceRoots = useMemo(() => buildWorkspaceRoots(workstudio), [workstudio]);
  const gitWorkdir = useMemo(() => (workstudio?.mainFolder ?? '').trim(), [workstudio?.mainFolder]);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const gitBranchFetchSeqRef = useRef(0);
  const [isGitBranchMenuOpen, setIsGitBranchMenuOpen] = useState(false);
  const gitBranchMenuRef = useRef<HTMLDivElement>(null);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [gitBranchesError, setGitBranchesError] = useState<string | null>(null);
  const [isGitBranchesLoading, setIsGitBranchesLoading] = useState(false);
  const [isGitCheckingOut, setIsGitCheckingOut] = useState(false);
  const [gitCheckoutError, setGitCheckoutError] = useState<string | null>(null);
  const gitBranchesFetchSeqRef = useRef(0);

  const refreshGitBranch = useCallback(async () => {
    const workdir = gitWorkdir;
    gitBranchFetchSeqRef.current += 1;
    const seq = gitBranchFetchSeqRef.current;

    if (!isTauri() || !workdir) {
      setGitBranch(null);
      return;
    }

    try {
      const branch = await invoke<string | null>('git_get_current_branch', { args: { workdir } });
      if (gitBranchFetchSeqRef.current !== seq) return;
      const normalized = typeof branch === 'string' && branch.trim().length > 0 ? branch.trim() : null;
      setGitBranch(normalized);
    } catch {
      if (gitBranchFetchSeqRef.current !== seq) return;
      setGitBranch(null);
    }
  }, [gitWorkdir]);

  useEffect(() => {
    void refreshGitBranch();
  }, [refreshGitBranch]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!gitWorkdir) return;

    const onFocus = () => void refreshGitBranch();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshGitBranch();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [gitWorkdir, refreshGitBranch]);

  const refreshGitBranches = useCallback(async () => {
    const workdir = gitWorkdir;
    gitBranchesFetchSeqRef.current += 1;
    const seq = gitBranchesFetchSeqRef.current;

    if (!isTauri() || !workdir) {
      setGitBranches([]);
      setGitBranchesError(null);
      setIsGitBranchesLoading(false);
      return;
    }

    setIsGitBranchesLoading(true);
    setGitBranchesError(null);

    try {
      const branches = await invoke<string[]>('git_list_local_branches', { args: { workdir } });
      if (gitBranchesFetchSeqRef.current !== seq) return;
      const normalized = Array.isArray(branches)
        ? branches
            .map((b) => (typeof b === 'string' ? b.trim() : ''))
            .filter((b) => b.length > 0)
        : [];
      setGitBranches(normalized);
      setGitBranchesError(null);
    } catch (err) {
      if (gitBranchesFetchSeqRef.current !== seq) return;
      setGitBranches([]);
      setGitBranchesError(toErrorMessage(err));
    } finally {
      if (gitBranchesFetchSeqRef.current !== seq) return;
      setIsGitBranchesLoading(false);
    }
  }, [gitWorkdir]);

  const checkoutGitBranch = useCallback(
    async (branch: string) => {
      const workdir = gitWorkdir;
      if (!isTauri() || !workdir) return;

      setIsGitCheckingOut(true);
      setGitCheckoutError(null);
      try {
        await invoke<string | null>('git_checkout_branch', { args: { workdir, branch } });
        setIsGitBranchMenuOpen(false);
        await refreshGitBranch();
        void refreshGitBranches();
      } catch (err) {
        const raw = toErrorMessage(err);
        const summary = summarizeGitError(raw, workdir);
        setGitCheckoutError(summary);
        try {
          await showMessageDialog(`切换到分支「${branch}」失败。\n\n${summary}\n\n详细信息：\n${raw}`, {
            title: '切换分支失败',
            kind: 'error',
          });
        } catch {
          window.alert(`切换到分支「${branch}」失败。\n\n${summary}\n\n详细信息：\n${raw}`);
        }
      } finally {
        setIsGitCheckingOut(false);
      }
    },
    [gitWorkdir, refreshGitBranch, refreshGitBranches]
  );

  const createAndCheckoutGitBranch = useCallback(async () => {
    const workdir = gitWorkdir;
    if (!isTauri() || !workdir) return;

    const input = window.prompt('请输入新分支名称（将创建并切换）', '');
    if (input === null) return;
    const branch = input.trim();
    if (!branch) return;

    setIsGitCheckingOut(true);
    setGitCheckoutError(null);
    try {
      await invoke<string | null>('git_create_and_checkout_branch', { args: { workdir, branch } });
      setIsGitBranchMenuOpen(false);
      await refreshGitBranch();
      void refreshGitBranches();
    } catch (err) {
      const raw = toErrorMessage(err);
      const summary = summarizeGitError(raw, workdir);
      setGitCheckoutError(summary);
      try {
        await showMessageDialog(`创建并切换到分支「${branch}」失败。\n\n${summary}\n\n详细信息：\n${raw}`, {
          title: '切换分支失败',
          kind: 'error',
        });
      } catch {
        window.alert(`创建并切换到分支「${branch}」失败。\n\n${summary}\n\n详细信息：\n${raw}`);
      }
    } finally {
      setIsGitCheckingOut(false);
    }
  }, [gitWorkdir, refreshGitBranch, refreshGitBranches]);

  // Close git branch menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (gitBranchMenuRef.current && !gitBranchMenuRef.current.contains(event.target as Node)) {
        setIsGitBranchMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isGitBranchMenuOpen) return;
    void refreshGitBranch();
    void refreshGitBranches();
  }, [isGitBranchMenuOpen, refreshGitBranch, refreshGitBranches]);

  useEffect(() => {
    if (!isGitBranchMenuOpen) return;
    setGitCheckoutError(null);
  }, [isGitBranchMenuOpen]);

  useEffect(() => {
    if (!isGitBranchMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGitBranchMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isGitBranchMenuOpen]);

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
  type WorkspaceMentionChip = { id: string; absPath: string; label: string };
  const [workspaceMentions, setWorkspaceMentions] = useState<WorkspaceMentionChip[]>([]);
  const [atQuery, setAtQuery] = useState<{ start: number; query: string } | null>(null);
  const [atResults, setAtResults] = useState<{ uri: string; absPath: string; label: string }[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  const [atError, setAtError] = useState<string | null>(null);
  const atTimerRef = useRef<number | null>(null);
  type DollarMentionResult =
    | { kind: 'skill'; name: string; description?: string; insertText: string }
    | { kind: 'mcp_server'; name: string; description?: string; insertText: string };
  const [dollarQuery, setDollarQuery] = useState<{ start: number; query: string } | null>(null);
  const [dollarResults, setDollarResults] = useState<DollarMentionResult[]>([]);
  const [dollarIndex, setDollarIndex] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaOverlayRef = useRef<HTMLDivElement>(null);
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

          // Check for images (Requirements: 3.1, 3.2)
          // NOTE: 视觉能力在 validatePasteFiles 中统一判断；这里先收集，避免“粘贴图片但不支持视觉时无反馈”。
          if (item.type.startsWith('image/')) {
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
    const overlay = textareaOverlayRef.current;
    if (!textarea) return;

    const prevScrollTop = textarea.scrollTop;
    const prevScrollLeft = textarea.scrollLeft;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const cursorAtEnd =
      typeof start === 'number' &&
      typeof end === 'number' &&
      start === end &&
      end === textarea.value.length;

    textarea.style.height = 'auto';
    const newHeight = calculateTextareaHeight(textarea.scrollHeight);
    textarea.style.height = `${newHeight}px`;

    // 调整高度过程中浏览器可能会重置滚动位置，导致 overlay 与光标所在位置不同步。
    // 这里恢复滚动位置，并在光标位于末尾时确保滚动到底部，避免“输入了但看不到”。
    textarea.scrollTop = prevScrollTop;
    textarea.scrollLeft = prevScrollLeft;

    const isFocused = typeof document !== 'undefined' && document.activeElement === textarea;
    if (isFocused && cursorAtEnd) {
      textarea.scrollTop = textarea.scrollHeight;
    }

    if (overlay) {
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
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
    setContentParts: (parts?: ContentPart[]) => {
      const nextImages: PendingImage[] = [];
      const nextTextFiles: PendingTextFile[] = [];
      const nextPdfs: PendingPdf[] = [];

      const items = parts ?? [];
      for (let idx = 0; idx < items.length; idx++) {
        const part = items[idx];
        if (part.type === 'image') {
          nextImages.push({ id: `undo_image_${idx}`, url: part.url });
          continue;
        }
        if (part.type === 'text_file') {
          const size =
            typeof TextEncoder !== 'undefined'
              ? new TextEncoder().encode(part.content).length
              : part.content.length;
          nextTextFiles.push({
            id: `undo_text_${idx}`,
            filename: part.filename,
            content: part.content,
            size,
          });
          continue;
        }
        if (part.type === 'pdf_document') {
          nextPdfs.push({
            id: `undo_pdf_${idx}`,
            filename: part.filename,
            size: 0,
            pages: part.pages,
            totalPages: part.totalPages,
            metadata: part.metadata,
            processingProgress: 100,
            includeImages: true,
            includeText: true,
          });
        }
      }

      setPendingImages(nextImages);
      setPendingTextFiles(nextTextFiles);
      setPendingPdfs(nextPdfs);
      setFileError(null);
      setPdfError(null);
    },
  }));

  /**
   * Auto-resize textarea based on content
   * Requirement 4.1: Auto-expand textarea height up to maximum limit
   */
  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [content, adjustTextareaHeight]);

  /**
   * Focus textarea on mount
   */
  // 注意：InputArea 可能会在 keep-alive / 多 Pane 场景下同时挂载多份。
  // 如果这里强制 focus，会导致“隐藏会话抢焦点”，甚至触发聚焦/切换的循环更新。
  // 输入框的自动聚焦由上层（ChatViewContainer/ChatView）按“当前聚焦 Pane 的激活会话”统一控制。

  /**
   * Handle sending message
   * 
   * Validates input, builds content parts from attachments, and sends the message.
   * After sending, clears the input and all pending attachments.
   * 
   * Validation:
   * - Prevents sending if input is empty/whitespace-only AND no attachments
   * - Prevents sending if disabled
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
	  const handleSend = useCallback(async () => {
	    // Requirement 4.6: Don't send empty/whitespace-only input (unless there are attachments)
	    const hasAttachments =
	      pendingImages.length > 0 ||
	      pendingTextFiles.length > 0 ||
	      pendingPdfs.length > 0 ||
	      hasWorkspaceMentionTokens(content) ||
	      hasCodeSnippetTokens(content) ||
	      codeSnippets.length > 0;
	    if ((isWhitespaceOnly(content) && !hasAttachments) || disabled) {
	      return;
	    }

    const expandedContent = expandWorkspaceMentionTokens(content, workspaceMentions);
    const trimmedContent = expandedContent.trim();
    let nextFileError: string | null = null;

	    // Build content parts for images, text files, and PDFs
	    let contentParts: ContentPart[] | undefined;

	    if (
	      pendingImages.length > 0 ||
	      pendingTextFiles.length > 0 ||
	      pendingPdfs.length > 0 ||
	      codeSnippets.length > 0
	    ) {
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
          content: file.content, // Send raw content, not formatted
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

	      // Add code snippet content parts (selection chips from Workstudio)
	      if (codeSnippets.length > 0) {
	        contentParts.push(...codeSnippets);
	      }
	    }

	    onSend(trimmedContent, supportsThinking ? thinkingMode : undefined, contentParts);
	    handleContentChange('');
    setPendingImages([]);
    // Requirement 3.3: Clear pending text files after sending
    setPendingTextFiles([]);
	    // Clear pending PDFs after sending
	    setPendingPdfs([]);
	    setWorkspaceMentions([]);
	    onCodeSnippetsChange?.([]);
	    setAtQuery(null);
	    setAtResults([]);
	    setAtIndex(0);
    setDollarQuery(null);
    setDollarResults([]);
    setDollarIndex(0);
    setFileError(nextFileError);
    setPdfError(null);

    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
    }

    // Refocus textarea after sending
    textareaRef.current?.focus();
	  }, [
	    content,
	    pendingImages,
	    pendingTextFiles,
	    pendingPdfs,
	    workspaceMentions,
	    codeSnippets,
	    disabled,
	    onSend,
	    supportsThinking,
	    thinkingMode,
	    handleContentChange,
	    onCodeSnippetsChange,
	  ]);

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
      if (workstudio?.id && atQuery) {
        if (e.key === 'ArrowDown') {
          if (atResults.length === 0) return;
          e.preventDefault();
          setAtIndex((v) => Math.min(v + 1, atResults.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          if (atResults.length === 0) return;
          e.preventDefault();
          setAtIndex((v) => Math.max(v - 1, 0));
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setAtQuery(null);
          setAtResults([]);
          setAtIndex(0);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const chosen = atResults.length > 0 ? atResults[atIndex] : undefined;
          if (!chosen) return;
          const el = textareaRef.current;
          const cursor = el?.selectionStart ?? content.length;
          const refId = crypto.randomUUID();
          const token = `@{ref:${refId}}`;
          const nextContent = content.slice(0, atQuery.start) + token + ' ' + content.slice(cursor);
          handleContentChange(nextContent);
          setAtQuery(null);
          setAtResults([]);
          setAtIndex(0);
          setWorkspaceMentions((prev) => {
            if (prev.some((m) => m.absPath === chosen.absPath)) return prev;
            return [...prev, { id: refId, absPath: chosen.absPath, label: chosen.label }];
          });
          window.setTimeout(() => {
            const el2 = textareaRef.current;
            if (!el2) return;
            el2.focus();
            const pos = atQuery.start + token.length + 1;
            try {
              el2.setSelectionRange(pos, pos);
            } catch {
              // ignore
            }
          }, 0);
          return;
        }
      }

      if (!atQuery && dollarQuery) {
        if (e.key === 'ArrowDown') {
          if (dollarResults.length === 0) return;
          e.preventDefault();
          setDollarIndex((v) => Math.min(v + 1, dollarResults.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          if (dollarResults.length === 0) return;
          e.preventDefault();
          setDollarIndex((v) => Math.max(v - 1, 0));
          return;
        }
      if (e.key === 'Escape') {
          e.preventDefault();
          setDollarQuery(null);
          setDollarResults([]);
          setDollarIndex(0);
          return;
        }
        if (e.key === 'Tab' && !e.shiftKey) {
          const chosen = dollarResults.length > 0 ? dollarResults[dollarIndex] : undefined;
          if (!chosen) return;
          e.preventDefault();
          const el = textareaRef.current;
          const cursor = el?.selectionStart ?? content.length;
          const token = chosen.insertText;
          const nextContent = content.slice(0, dollarQuery.start) + token + ' ' + content.slice(cursor);
          handleContentChange(nextContent);
          setDollarQuery(null);
          setDollarResults([]);
          setDollarIndex(0);
          window.setTimeout(() => {
            const el2 = textareaRef.current;
            if (!el2) return;
            el2.focus();
            const pos = dollarQuery.start + token.length + 1;
            try {
              el2.setSelectionRange(pos, pos);
            } catch {
              // ignore
            }
          }, 0);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const chosen = dollarResults.length > 0 ? dollarResults[dollarIndex] : undefined;
          if (!chosen) return;
          const el = textareaRef.current;
          const cursor = el?.selectionStart ?? content.length;
          const token = chosen.insertText;
          const nextContent = content.slice(0, dollarQuery.start) + token + ' ' + content.slice(cursor);
          handleContentChange(nextContent);
          setDollarQuery(null);
          setDollarResults([]);
          setDollarIndex(0);
          window.setTimeout(() => {
            const el2 = textareaRef.current;
            if (!el2) return;
            el2.focus();
            const pos = dollarQuery.start + token.length + 1;
            try {
              el2.setSelectionRange(pos, pos);
            } catch {
              // ignore
            }
          }, 0);
          return;
        }
      }

	      if (e.key === 'Backspace' || e.key === 'Delete') {
	        const el = textareaRef.current;
	        if (el && el.selectionStart === el.selectionEnd) {
	          const cursor = el.selectionStart ?? content.length;
	          const probeIndex = e.key === 'Backspace' ? cursor - 1 : cursor;
	          const hit = findWorkspaceMentionTokenAt(content, probeIndex);
	          if (hit) {
	            e.preventDefault();
	            const next = content.slice(0, hit.start) + content.slice(hit.end);
	            handleContentChange(next);
	            setWorkspaceMentions((prev) => prev.filter((m) => m.id !== hit.id));
	            window.setTimeout(() => {
	              const el2 = textareaRef.current;
	              if (!el2) return;
	              try {
	                el2.setSelectionRange(hit.start, hit.start);
	              } catch {
	                // ignore
	              }
	            }, 0);
	            return;
	          }

	          const snippetHit = findCodeSnippetTokenAt(content, probeIndex);
	          if (snippetHit) {
	            e.preventDefault();
	            const next = content.slice(0, snippetHit.start) + content.slice(snippetHit.end);
	            handleContentChange(next);
	            if (onCodeSnippetsChange) {
	              onCodeSnippetsChange(codeSnippets.filter((s) => s.id !== snippetHit.id));
	            }
	            window.setTimeout(() => {
	              const el2 = textareaRef.current;
	              if (!el2) return;
	              try {
	                el2.setSelectionRange(snippetHit.start, snippetHit.start);
	              } catch {
	                // ignore
	              }
	            }, 0);
	            return;
	          }
	        }
	      }

      if (e.key === 'Enter') {
        if (e.shiftKey) return;
        e.preventDefault();
        void handleSend();
      }
    },
	    [
	      workstudio?.id,
	      atQuery,
	      atResults,
	      atIndex,
	      dollarQuery,
	      dollarResults,
	      dollarIndex,
	      content,
	      codeSnippets,
	      onCodeSnippetsChange,
	      handleContentChange,
	      handleSend,
	    ]
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
      const nextValue = e.target.value;
      handleContentChange(nextValue);
      const cursor = e.target.selectionStart ?? nextValue.length;
      const nextAt = workstudio?.id ? findActiveAtQuery(nextValue, cursor) : null;
      setAtQuery(nextAt);
      setDollarQuery(nextAt ? null : findActiveDollarQuery(nextValue, cursor));
    },
    [handleContentChange, workstudio?.id]
  );

  const handleSelectionChange = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? content.length;
    const nextAt = workstudio?.id ? findActiveAtQuery(content, cursor) : null;
    setAtQuery(nextAt);
    setDollarQuery(nextAt ? null : findActiveDollarQuery(content, cursor));
  }, [content, workstudio?.id]);

	  const workspaceMentionsById = useMemo(() => {
	    return new Map(workspaceMentions.map((m) => [m.id, m]));
	  }, [workspaceMentions]);

	  const codeSnippetsById = useMemo(() => {
	    return new Map(codeSnippets.map((s) => [s.id, s]));
	  }, [codeSnippets]);

	  const textareaOverlayNodes = useMemo(() => {
	    const text = content ?? '';
	    if (!text) return null;

    const COMMON_ENV_VARS = new Set([
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'PWD',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LANG',
      'TERM',
      'XDG_CONFIG_HOME',
    ]);
    const isCommonEnvVar = (name: string) => COMMON_ENV_VARS.has(name.toUpperCase());

    const mentionClass =
      'rounded-sm bg-purple-200/70 text-purple-950 font-medium dark:bg-purple-900/40 dark:text-purple-100';

    const nodes: React.ReactNode[] = [];

    const flushText = (start: number, end: number) => {
      if (end <= start) return;
      nodes.push(<span key={`t-${start}`}>{text.slice(start, end)}</span>);
    };

    let i = 0;
    let lastTextStart = 0;

	    while (i < text.length) {
	      // Workspace mention token: @{ref:<uuid>}
	      if (text.startsWith('@{ref:', i)) {
        const m = text.slice(i).match(/^@\{ref:([0-9a-fA-F-]+)\}/);
        if (m) {
          const raw = m[0];
          const id = m[1];
          const start = i;
          const end = i + raw.length;

          flushText(lastTextStart, start);
          const mention = workspaceMentionsById.get(id);
          if (mention) {
            nodes.push(
              <span
                key={`ws-${id}-${start}`}
                className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-200 align-baseline"
                title={mention.absPath}
              >
                {mention.label}
              </span>
            );
          } else {
            nodes.push(
              <span key={`ws-missing-${id}-${start}`} className="text-gray-400">
                {raw}
              </span>
            );
          }

          i = end;
          lastTextStart = i;
          continue;
        }
	      }

	      // Code snippet token: @{snippet:<uuid>}
	      if (text.startsWith('@{snippet:', i)) {
	        const m = text.slice(i).match(/^@\{snippet:([0-9a-fA-F-]+)\}/);
	        if (m) {
	          const raw = m[0];
	          const id = m[1];
	          const start = i;
	          const end = i + raw.length;

	          flushText(lastTextStart, start);
	          const snippet = codeSnippetsById.get(id);
	          if (snippet) {
	            const titleParts: string[] = [];
	            if (snippet.filePath) titleParts.push(snippet.filePath);
	            if (snippet.range) {
	              titleParts.push(
	                `${snippet.range.startLine}:${snippet.range.startColumn} - ${snippet.range.endLine}:${snippet.range.endColumn}`
	              );
	            }
	            nodes.push(
	              <span
	                key={`snip-${id}-${start}`}
	                className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200 align-baseline"
	                title={titleParts.join('\n')}
	              >
	                {snippet.label}
	              </span>
	            );
	          } else {
	            nodes.push(
	              <span key={`snip-missing-${id}-${start}`} className="text-gray-400">
	                {raw}
	              </span>
	            );
	          }

	          i = end;
	          lastTextStart = i;
	          continue;
	        }
	      }

	      // Linked mention: [${name}](mcp://...) / [${name}](app://...) / skill links
	      // We only highlight the `$name` portion to keep caret alignment stable.
	      if (text[i] === '[' && text[i + 1] === '$') {
        const nameStart = i + 2;
        let nameEnd = nameStart;
        while (nameEnd < text.length && isDollarMentionChar(text[nameEnd]!)) nameEnd++;
        if (nameEnd > nameStart && text[nameEnd] === ']') {
          const name = text.slice(nameStart, nameEnd);
          if (!isCommonEnvVar(name)) {
            flushText(lastTextStart, i + 1); // include '['
            nodes.push(
              <span key={`link-$-${i}`} className={mentionClass}>
                {text.slice(i + 1, nameEnd)}
              </span>
            );
            i = nameEnd;
            lastTextStart = i;
            continue;
          }
        }
      }

      // Plain $mention
      if (text[i] === '$') {
        const prev = i > 0 ? text[i - 1] : '';
        // Avoid highlighting in the middle of a larger token like `$foo_bar` when cursor is at `bar`.
        if (!prev || !isDollarMentionChar(prev)) {
          const nameStart = i + 1;
          let nameEnd = nameStart;
          while (nameEnd < text.length && isDollarMentionChar(text[nameEnd]!)) nameEnd++;
          const name = text.slice(nameStart, nameEnd);
          // Avoid `$1` / `$0` etc (shell positional params) and common env vars.
          const hasLetter = /[a-zA-Z_]/.test(name);
          if (name && hasLetter && !isCommonEnvVar(name)) {
            flushText(lastTextStart, i);
            nodes.push(
              <span key={`$-${i}`} className={mentionClass}>
                {text.slice(i, nameEnd)}
              </span>
            );
            i = nameEnd;
            lastTextStart = i;
            continue;
          }
        }
      }

      i += 1;
    }

	    flushText(lastTextStart, text.length);
	    return nodes;
	  }, [content, workspaceMentionsById, codeSnippetsById]);

  const handleTextareaScroll = useCallback(() => {
    const el = textareaRef.current;
    const overlay = textareaOverlayRef.current;
    if (!el || !overlay) return;
    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;
  }, []);

  const handleCompositionStart = useCallback(() => {
    // IME 组合输入期间（拼音/日文等），让 textarea 真实文本可见并暂时隐藏 overlay，
    // 避免在内容较长/可滚动时出现“输入定位/候选框定位异常”的体验。
    setIsComposing(true);
  }, []);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    // 组合输入结束后，确保高度/滚动与 overlay 再次对齐。
    requestAnimationFrame(() => {
      adjustTextareaHeight();
    });
  }, [adjustTextareaHeight]);

  useEffect(() => {
    if (!workstudio?.id) return;
    if (!atQuery) return;

    const query = atQuery.query.trim();
    if (!query) {
      setAtResults([]);
      setAtIndex(0);
      setAtError(null);
      return;
    }

    if (atTimerRef.current) window.clearTimeout(atTimerRef.current);
    atTimerRef.current = window.setTimeout(() => {
      void invoke<string[]>('workstudio_find_files', {
        args: { workstudioId: workstudio.id, query, limit: 50 },
      })
        .then((paths) => {
          const results = paths
            .map((absPath) => {
              const uri = absPathToWorkspaceUri(absPath, workspaceRoots);
              if (!uri) return null;
              return { uri, absPath, label: basename(absPath) };
            })
            .filter((v): v is { uri: string; absPath: string; label: string } => Boolean(v));
          setAtResults(results);
          setAtIndex(0);
          setAtError(null);
        })
        .catch((error) => {
          setAtResults([]);
          setAtIndex(0);
          setAtError(toErrorMessage(error));
        });
    }, 120);

    return () => {
      if (atTimerRef.current) window.clearTimeout(atTimerRef.current);
    };
  }, [atQuery, workstudio?.id, workspaceRoots]);

  /**
   * Handle abort button click
   * 
   * Calls the onAbort callback to stop the current message generation.
   */
  const handleAbort = useCallback(() => {
    onAbort?.();
  }, [onAbort]);

  // Requirement 4.6: Disable send button for empty/whitespace input (unless there are attachments)
  const hasAttachments =
    pendingImages.length > 0 || pendingTextFiles.length > 0 || pendingPdfs.length > 0 || hasWorkspaceMentionTokens(content);
  const isSendDisabled = disabled || (isWhitespaceOnly(content) && !hasAttachments);

  const currentAgent = useMemo(() => {
    if (!currentAgentName) return undefined;
    return agents.find((a) => a.name === currentAgentName);
  }, [agents, currentAgentName]);

  const config = useConfigStore((state) => state.config);
  const keyboardShortcuts = config?.general?.keyboardShortcuts;
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const cloneConversationShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'session.clone');
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['session.clone']
        : keyboardShortcuts?.windows?.['session.clone'];
    const fallback = shortcutPlatform === 'mac' ? 'Cmd+Shift+D' : 'Ctrl+Shift+D';
    const raw = userRaw ?? (shortcutPlatform === 'mac' ? def?.defaultMac : def?.defaultWindows) ?? fallback;
    return normalizeKeybindingString(String(raw || ''), shortcutPlatform) ?? fallback;
  }, [keyboardShortcuts, shortcutPlatform]);

  // Skills catalog for `$skill` autocomplete (metadata only)
  const [skillOutcomeForMentions, setSkillOutcomeForMentions] = useState<SkillLoadOutcome | null>(null);
  useEffect(() => {
    const skillSetName = currentAgent?.skillSet;
    if (!skillSetName) {
      setSkillOutcomeForMentions(null);
      return;
    }
    if (!isTauri()) {
      setSkillOutcomeForMentions(null);
      return;
    }

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const load = async () => {
      try {
        const res = await invoke<[any, SkillLoadOutcome]>('list_skills', {
          args: {
            workstudioMainFolder: workstudio?.mainFolder || undefined,
            includeContents: false,
          },
        });
        if (cancelled) return;
        setSkillOutcomeForMentions(res[1]);
      } catch (e) {
        if (cancelled) return;
        setSkillOutcomeForMentions({ skills: [], errors: [String(e)] });
      }
    };

    void load();
    void listen('skills:changed', () => void load())
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [currentAgent?.skillSet, workstudio?.mainFolder]);

  const availableSkillsForMentions = useMemo((): SkillEntry[] => {
    const skillSetName = currentAgent?.skillSet;
    if (!skillSetName) return [];
    if (!config?.skills?.sets?.length) return [];
    if (!skillOutcomeForMentions?.skills?.length) return [];

    const set = config.skills.sets.find((s) => s.name === skillSetName);
    if (!set || (set.enabled ?? true) === false) return [];

    const disabledGlobal = new Set(config.skills.disabledSkills ?? []);
    const disabledSet = new Set(set.disabledSkills ?? []);
    const setSkills = set.skills ?? [];

    const byName = new Map(skillOutcomeForMentions.skills.map((s) => [s.meta.name, s] as const));
    const enabledNames =
      setSkills.length === 0 && set.name === '标准skill集'
        ? skillOutcomeForMentions.skills
            .map((s) => s.meta.name)
            .filter((n) => !disabledGlobal.has(n) && !disabledSet.has(n))
        : setSkills.filter((n) => !disabledGlobal.has(n) && !disabledSet.has(n));

    return enabledNames.map((n) => byName.get(n)).filter(Boolean) as SkillEntry[];
  }, [config?.skills, currentAgent?.skillSet, skillOutcomeForMentions]);

  const availableMcpServersForMentions = useMemo((): string[] => {
    if (!config?.mcp?.servers?.length) return [];
    const enabledServers = new Map(
      config.mcp.servers.filter((s) => s.config?.enabled).map((s) => [s.name, s] as const)
    );

    const setName = currentAgent?.mcpSet;
    if (setName && config?.mcp?.sets?.length) {
      const set = config.mcp.sets.find((s) => s.name === setName);
      if (!set) return [];
      return (set.servers ?? [])
        .filter((ss) => ss.enabled)
        .map((ss) => ss.server)
        .filter((name) => enabledServers.has(name));
    }

    // Unbound: allow explicit per-message selection of any enabled server.
    return [...enabledServers.keys()];
  }, [config?.mcp, currentAgent?.mcpSet]);

  useEffect(() => {
    if (!dollarQuery) {
      setDollarResults([]);
      setDollarIndex(0);
      return;
    }

    const q = dollarQuery.query.trim();
    if (!q) {
      setDollarResults([]);
      setDollarIndex(0);
      return;
    }

    const qLower = q.toLowerCase();
    const results: DollarMentionResult[] = [];

    // Skills
    for (const s of availableSkillsForMentions) {
      const name = s.meta.name;
      if (name.toLowerCase().startsWith(qLower)) {
        results.push({
          kind: 'skill',
          name,
          description: s.meta.description,
          insertText: `$${name}`,
        });
      }
    }

    // MCP servers
    for (const serverName of availableMcpServersForMentions) {
      if (serverName.toLowerCase().startsWith(qLower)) {
        results.push({
          kind: 'mcp_server',
          name: serverName,
          description: 'MCP Server',
          // Codex-like MCP mention: use an explicit mcp:// link to avoid ambiguity with `$skill`.
          insertText: `[$${serverName}](mcp://${serverName})`,
        });
      }
    }

    results.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'skill' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    setDollarResults(results.slice(0, 50));
    setDollarIndex(0);
  }, [dollarQuery, availableSkillsForMentions, availableMcpServersForMentions]);

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
            {/* Agent selector - 放在最左边 */}
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
                    'flex items-center gap-1.5 px-2 py-1 rounded-lg border',
                    'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700',
                    'text-gray-700 dark:text-gray-200',
                  ].join(' ')}
                  title={currentAgent?.type ? `${currentAgent.displayName} (${currentAgent.type})` : (currentAgent?.displayName || currentAgentName)}
                >
                  <Bot size={12} className="text-gray-500 dark:text-gray-400" />
                  <span className="text-xs font-medium max-w-32 truncate">
                    {currentAgent?.displayName || currentAgentName}
                    {currentAgent?.type ? ` (${currentAgent.type})` : ''}
                  </span>
                </div>
              )
            )}
            {/* Run mode selector (menu) */}
            {onRunModeChange && (
              <CompactSelector
                icon={<span className="text-[10px] text-gray-500 dark:text-gray-400">模式</span>}
                options={RUN_MODE_OPTIONS}
                currentValue={runMode}
                onSelect={(value) => onRunModeChange(value as RunMode)}
                disabled={disabled}
                placeholder="模式"
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
            {(agents.length > 0 || modelOptions.length > 0) && (supportsThinking || supportsWebSearch) && (
              <div className="h-4 w-px bg-gray-300 dark:bg-gray-600 mx-1" />
            )}
            {/* Thinking selector - adaptive based on API protocol */}
            {supportsThinking && (
              <ThinkingSelector
                apiProtocol={apiProtocol}
                providerType={providerType}
                value={thinkingMode}
                onChange={handleThinkingModeChange}
                disabled={disabled}
                useReasoningEffort={useReasoningEffort}
              />
            )}
            {/* Web search toggle */}
            {supportsWebSearch && (
              <WebSearchToggle
                providers={availableProviders}
                selected={selectedProvider}
                onSelect={onProviderSelect}
                disabled={isGenerating}

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
        <div className="relative flex-1">
          {workstudio?.id && atQuery && (
            <div className="absolute bottom-full mb-2 w-full rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
	              <div className="max-h-56 overflow-auto py-1 text-sm">
	                {atError ? (
	                  <div className="px-3 py-2 text-xs text-red-600 dark:text-red-300 whitespace-pre-wrap break-words">
	                    {atError}
	                  </div>
	                ) : atResults.length === 0 ? (
	                  <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
	                    {atQuery.query.trim()
	                      ? '未找到匹配文件'
	                      : '继续输入文件名以搜索（例如 @README 或 @src/app）'}
	                  </div>
                ) : (
                  atResults.map((r, idx) => (
                    <button
                      key={r.uri}
                      type="button"
                      className={[
                        'flex w-full items-center gap-2 px-3 py-2 text-left',
                        idx === atIndex
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700',
                      ].join(' ')}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => {
                        const el = textareaRef.current;
                        const cursor = el?.selectionStart ?? content.length;
                        const refId = crypto.randomUUID();
                        const token = `@{ref:${refId}}`;
                        const nextContent = content.slice(0, atQuery.start) + token + ' ' + content.slice(cursor);
                        handleContentChange(nextContent);
                        setAtQuery(null);
                        setAtResults([]);
                        setAtIndex(0);
                        setWorkspaceMentions((prev) => {
                          if (prev.some((m) => m.absPath === r.absPath)) return prev;
                          return [...prev, { id: refId, absPath: r.absPath, label: r.label }];
                        });
                        window.setTimeout(() => {
                          const el2 = textareaRef.current;
                          if (!el2) return;
                          el2.focus();
                          const pos = atQuery.start + token.length + 1;
                          try {
                            el2.setSelectionRange(pos, pos);
                          } catch {
                            // ignore
                          }
                        }, 0);
                      }}
                    >
                      <FileIcon size={14} className="text-gray-500 dark:text-gray-400" />
                      <span className="truncate">{r.label}</span>
                      <span className="ml-auto truncate text-xs text-gray-500 dark:text-gray-400">
                        {(() => {
                          const parsed = parseWorkspaceUri(r.uri);
                          if (!parsed) return '';
                          const rootName = parsed.rootKey.split('~')[0];
                          return `${rootName}/${parsed.relPath}`;
                        })()}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                输入 <span className="font-mono">@</span> 搜索工作区文件，回车插入，Esc 关闭
              </div>
            </div>
          )}

          {!atQuery && dollarQuery && (
            <div className="absolute bottom-full mb-2 w-full rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
              <div className="max-h-56 overflow-auto py-1 text-sm">
                {dollarResults.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {dollarQuery.query.trim()
                      ? '未找到匹配的 Skill / MCP Server'
                      : '继续输入名称以搜索（例如 $deep-learning 或 $github）'}
                  </div>
                ) : (
                  dollarResults.map((r, idx) => (
                    <button
                      key={`${r.kind}:${r.name}`}
                      type="button"
                      className={[
                        'flex w-full items-center gap-2 px-3 py-2 text-left',
                        idx === dollarIndex
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700',
                      ].join(' ')}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => {
                        const el = textareaRef.current;
                        const cursor = el?.selectionStart ?? content.length;
                        const token = r.insertText;
                        const nextContent =
                          content.slice(0, dollarQuery.start) + token + ' ' + content.slice(cursor);
                        handleContentChange(nextContent);
                        setDollarQuery(null);
                        setDollarResults([]);
                        setDollarIndex(0);
                        window.setTimeout(() => {
                          const el2 = textareaRef.current;
                          if (!el2) return;
                          el2.focus();
                          const pos = dollarQuery.start + token.length + 1;
                          try {
                            el2.setSelectionRange(pos, pos);
                          } catch {
                            // ignore
                          }
                        }, 0);
                      }}
                    >
                      {r.kind === 'skill' ? (
                        <FileText size={14} className="text-gray-500 dark:text-gray-400" />
                      ) : (
                        <Plug size={14} className="text-gray-500 dark:text-gray-400" />
                      )}
                      <span className="truncate">{r.name}</span>
                      {r.description && (
                        <span className="ml-auto truncate text-xs text-gray-500 dark:text-gray-400">
                          {r.description}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                输入 <span className="font-mono">$</span> 搜索 Skills / MCP Servers，回车/Tab 插入，Esc 关闭
              </div>
            </div>
          )}

          <div className="rounded-lg border border-gray-300 bg-gray-50 px-2 py-2 text-gray-900 placeholder-gray-500 transition-colors focus-within:border-blue-500 focus-within:outline-none focus-within:ring-1 focus-within:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 dark:focus-within:border-blue-400">
            <div className="relative">
              <div
                ref={textareaOverlayRef}
                aria-hidden="true"
                className={[
                  "absolute inset-0 z-0 w-full resize-none overflow-auto bg-transparent px-2 py-0 text-gray-900 placeholder-gray-500 focus:outline-none dark:text-gray-100 dark:placeholder-gray-400 pointer-events-none whitespace-pre-wrap break-words",
                  isComposing ? "opacity-0" : "opacity-100",
                ].join(" ")}
                style={{ minHeight: `${MIN_TEXTAREA_HEIGHT}px` }}
              >
                {textareaOverlayNodes}
              </div>

              <textarea
                ref={textareaRef}
                value={content}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onClick={handleSelectionChange}
                onSelect={handleSelectionChange}
                onScroll={handleTextareaScroll}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={handlePaste}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                placeholder={supportsVision ? "输入消息，或粘贴/拖拽图片、文本文件和 PDF..." : "输入消息，或粘贴/拖拽文本文件和 PDF..."}
                disabled={disabled}
                rows={1}
                aria-label="消息输入框"
                className={[
                  "relative z-10 w-full resize-none overflow-auto bg-transparent px-2 py-0 whitespace-pre-wrap break-words caret-gray-900 placeholder-gray-500 focus:outline-none dark:caret-gray-100 dark:placeholder-gray-400 disabled:cursor-not-allowed disabled:opacity-50",
                  isComposing ? "text-gray-900 dark:text-gray-100" : "text-transparent",
                ].join(" ")}
                style={{ minHeight: `${MIN_TEXTAREA_HEIGHT}px` }}
              />
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {isGenerating ? (
            <button
              type="button"
              onClick={handleAbort}
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              title="停止生成"
              aria-label="停止生成"
            >
              <Square size={18} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleSend}
            disabled={isSendDisabled}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500 text-white transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-500"
            title={isGenerating ? `加入队列${queuedCount > 0 ? `（当前 ${queuedCount}）` : ''}` : '发送消息'}
            aria-label={isGenerating ? `加入队列${queuedCount > 0 ? `（当前 ${queuedCount}）` : ''}` : '发送消息'}
          >
            <Send size={18} />
          </button>
        </div>
      </div>

      {/* Attachment menu + extra actions */}
      <div className="mt-1 flex items-center gap-3 text-xs">
        <AttachmentMenu
          onImageClick={() => fileInputRef.current?.click()}
          onTextFileClick={() => textFileInputRef.current?.click()}
          onPdfClick={() => pdfFileInputRef.current?.click()}
          supportsVision={supportsVision}
          disabled={disabled || isGenerating}
        />
        <ExtraActionsMenu
          onCloneConversation={onCloneConversation}
          cloneConversationShortcutLabel={cloneConversationShortcutLabel}
          disabled={disabled || isGenerating}
        />
        {gitBranch && (
          <div className="ml-auto relative" ref={gitBranchMenuRef}>
            <button
              type="button"
              onClick={() => setIsGitBranchMenuOpen((v) => !v)}
              disabled={isGitCheckingOut}
              className={[
                'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                'border-gray-200 dark:border-gray-700',
                'bg-gray-50 dark:bg-gray-900',
                'text-gray-700 dark:text-gray-200',
                'hover:bg-gray-100 dark:hover:bg-gray-800',
                'transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-60',
              ].join(' ')}
              title={gitWorkdir ? `Git branch（${gitWorkdir}）：${gitBranch}` : `Git branch：${gitBranch}`}
              aria-haspopup="menu"
              aria-expanded={isGitBranchMenuOpen}
            >
              <GitBranch size={12} className="text-gray-500 dark:text-gray-400" />
              <span className="max-w-40 truncate font-mono text-[11px]">{gitBranch}</span>
              <ChevronDown
                size={12}
                className={`transition-transform ${isGitBranchMenuOpen ? 'rotate-180' : ''}`}
              />
              {isGitCheckingOut ? (
                <Loader2 size={12} className="animate-spin text-gray-500 dark:text-gray-400" />
              ) : null}
            </button>

            {isGitBranchMenuOpen && (
              <div
                role="menu"
                className="absolute bottom-full right-0 mb-2 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50"
              >
                <div className="px-3 pb-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                  Checkout branch
                </div>

                {gitCheckoutError ? (
                  <div className="mx-3 mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200 whitespace-pre-wrap">
                    {gitCheckoutError}
                  </div>
                ) : null}

                <div className="max-h-72 overflow-auto">
                  {isGitBranchesLoading ? (
                    <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                      <Loader2 size={12} className="animate-spin" />
                      <span>正在加载分支…</span>
                    </div>
                  ) : gitBranchesError ? (
                    <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">
                      无法读取分支列表：{gitBranchesError}
                    </div>
                  ) : gitBranches.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">未找到本地分支</div>
                  ) : (
                    gitBranches.map((b) => {
                      const isCurrent = b === gitBranch;
                      return (
                        <button
                          key={b}
                          type="button"
                          role="menuitem"
                          disabled={isGitCheckingOut}
                          onClick={() => void checkoutGitBranch(b)}
                          className={[
                            'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors',
                            'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700',
                            isCurrent ? 'font-semibold' : '',
                            isGitCheckingOut ? 'cursor-not-allowed opacity-70' : '',
                          ].join(' ')}
                          title={b}
                        >
                          <GitBranch size={14} className="text-gray-500 dark:text-gray-400" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{b}</span>
                          {isCurrent ? <Check size={14} className="text-blue-500" /> : null}
                        </button>
                      );
                    })
                  )}
                </div>

                <div className="mt-2 border-t border-gray-200 dark:border-gray-700 pt-2 px-2">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isGitCheckingOut}
                    onClick={() => void createAndCheckoutGitBranch()}
                    className={[
                      'flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors',
                      'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700',
                      isGitCheckingOut ? 'cursor-not-allowed opacity-70' : '',
                    ].join(' ')}
                    title="创建并切换新分支"
                  >
                    <Plus size={14} className="text-gray-500 dark:text-gray-400" />
                    <span className="text-xs">Create and checkout new branch…</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
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
