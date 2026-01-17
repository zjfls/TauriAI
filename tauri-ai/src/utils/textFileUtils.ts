/**
 * Text File Utilities
 * Functions for validating and reading text files
 * Requirements: 1.3, 1.4, 1.5, 4.3, 7.1, 7.2, 7.3
 */

import { 
  SUPPORTED_TEXT_EXTENSIONS, 
  MAX_TEXT_FILE_SIZE,
  MAX_TEXT_FILES,
  type PendingTextFile 
} from '../types';

/**
 * Check if a filename has a supported text file extension
 * Supports case-insensitive matching
 * 
 * Requirements: 1.4, 4.3
 * 
 * @param filename - The filename to check
 * @returns true if the file extension is supported, false otherwise
 */
export function isSupportedTextFile(filename: string): boolean {
  if (!filename || typeof filename !== 'string') {
    return false;
  }
  
  const lowerFilename = filename.toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.some(ext => lowerFilename.endsWith(ext));
}

/**
 * Error messages for file reading failures
 */
export const FILE_ERROR_MESSAGES = {
  TOO_LARGE: '文件过大，请选择小于 1MB 的文件',
  UNSUPPORTED_TYPE: '不支持的文件类型，请选择文本文件',
  ENCODING_ERROR: '文件编码不支持，请使用 UTF-8 编码的文件',
  PERMISSION_ERROR: '无法读取文件，请检查文件权限',
  READ_ERROR: (error: string) => `读取文件失败: ${error}`,
  FILE_COUNT_EXCEEDED: `最多只能添加 ${MAX_TEXT_FILES} 个文件`,
  FILE_COUNT_EXCEEDED_WITH_SLOTS: (availableSlots: number) => 
    `最多只能添加 ${MAX_TEXT_FILES} 个文件，当前还可添加 ${availableSlots} 个`,
} as const;

/**
 * Result of file count validation
 */
export interface FileCountValidationResult {
  /** Whether any files can be added */
  canAdd: boolean;
  /** Number of files that can be added */
  availableSlots: number;
  /** Error message if limit exceeded */
  error: string | null;
  /** Files to process (limited to available slots) */
  filesToProcess: number;
}

/**
 * Validate file count against the maximum limit
 * 
 * Property 6: File Count Limit Invariant
 * For any sequence of file attachment operations, the number of pending files 
 * SHALL never exceed MAX_TEXT_FILES (5). Attempting to add files beyond this 
 * limit SHALL reject the excess files.
 * 
 * Requirements: 5.3, 5.4
 * 
 * @param currentCount - Current number of pending files
 * @param newFilesCount - Number of new files to add
 * @returns Validation result with available slots and error message
 */
export function validateFileCount(
  currentCount: number, 
  newFilesCount: number
): FileCountValidationResult {
  const availableSlots = Math.max(0, MAX_TEXT_FILES - currentCount);
  
  if (availableSlots <= 0) {
    return {
      canAdd: false,
      availableSlots: 0,
      error: FILE_ERROR_MESSAGES.FILE_COUNT_EXCEEDED,
      filesToProcess: 0,
    };
  }
  
  if (newFilesCount > availableSlots) {
    return {
      canAdd: true,
      availableSlots,
      error: FILE_ERROR_MESSAGES.FILE_COUNT_EXCEEDED_WITH_SLOTS(availableSlots),
      filesToProcess: availableSlots,
    };
  }
  
  return {
    canAdd: true,
    availableSlots,
    error: null,
    filesToProcess: newFilesCount,
  };
}

/**
 * Format text file content for message display
 * 
 * Property 5: Message Formatting
 * For any filename and content, the formatted text SHALL match the pattern:
 * "📄 {filename}\n```\n{content}\n```"
 * 
 * Requirements: 3.1, 3.2, 3.4
 * 
 * @param filename - The name of the file
 * @param content - The content of the file
 * @returns Formatted string with file header and content in code block
 */
export function formatTextFileContent(filename: string, content: string): string {
  return `📄 ${filename}\n\`\`\`\n${content}\n\`\`\``;
}

/**
 * Read a text file and return its content
 * Validates file size (<= 1MB) and reads content as UTF-8 text
 * 
 * Requirements: 1.3, 1.5, 7.1, 7.2, 7.3
 * 
 * @param file - The File object to read
 * @returns Promise resolving to PendingTextFile with file info and content
 * @throws Error if file is too large, encoding is unsupported, or read fails
 */
export async function readTextFile(file: File): Promise<PendingTextFile> {
  // Validate file size (Requirements: 1.5, 4.4)
  if (file.size > MAX_TEXT_FILE_SIZE) {
    throw new Error(FILE_ERROR_MESSAGES.TOO_LARGE);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const content = reader.result as string;
      
      // Generate unique ID
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      
      resolve({
        id,
        filename: file.name,
        content,
        size: file.size,
      });
    };

    reader.onerror = () => {
      const error = reader.error;
      
      // Handle different error types (Requirements: 7.1, 7.2, 7.3)
      if (error) {
        // Check for permission/security errors
        if (error.name === 'NotReadableError' || error.name === 'SecurityError') {
          reject(new Error(FILE_ERROR_MESSAGES.PERMISSION_ERROR));
          return;
        }
        
        // Check for encoding errors
        if (error.name === 'EncodingError') {
          reject(new Error(FILE_ERROR_MESSAGES.ENCODING_ERROR));
          return;
        }
        
        // Generic error with message
        reject(new Error(FILE_ERROR_MESSAGES.READ_ERROR(error.message || '未知错误')));
        return;
      }
      
      reject(new Error(FILE_ERROR_MESSAGES.READ_ERROR('未知错误')));
    };

    // Read as text (UTF-8 by default)
    reader.readAsText(file, 'UTF-8');
  });
}
