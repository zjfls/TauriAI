/**
 * Text File Utils Property Tests
 * 
 * Property 2: Extension Validation
 * Property 3: Size Validation
 * 
 * **Validates: Requirements 1.4, 1.5, 4.3, 4.4**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { isSupportedTextFile } from './textFileUtils';
import { SUPPORTED_TEXT_EXTENSIONS } from '../types';

/**
 * Property 2: Extension Validation
 * 
 * *For any* filename, `isSupportedTextFile(filename)` SHALL return true 
 * if and only if the filename ends with one of the supported extensions (case-insensitive).
 * 
 * **Validates: Requirements 1.4, 4.3**
 */
describe('Property 2: Extension Validation', () => {
  /**
   * Arbitrary for generating valid filenames with supported extensions
   */
  const validFilenameArb = fc.tuple(
    fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('.') && !s.includes('/') && !s.includes('\\')),
    fc.constantFrom(...SUPPORTED_TEXT_EXTENSIONS)
  ).map(([name, ext]) => name + ext);

  /**
   * Arbitrary for generating filenames with unsupported extensions
   */
  const unsupportedExtensions = ['.exe', '.dll', '.bin', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.rar', '.7z', '.mp3', '.mp4', '.avi', '.mov', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico'];
  
  const invalidFilenameArb = fc.tuple(
    fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('.') && !s.includes('/') && !s.includes('\\')),
    fc.constantFrom(...unsupportedExtensions)
  ).map(([name, ext]) => name + ext);

  it('returns true for any filename with a supported extension', () => {
    fc.assert(
      fc.property(validFilenameArb, (filename) => {
        return isSupportedTextFile(filename) === true;
      }),
      { numRuns: 100 }
    );
  });

  it('returns false for any filename with an unsupported extension', () => {
    fc.assert(
      fc.property(invalidFilenameArb, (filename) => {
        return isSupportedTextFile(filename) === false;
      }),
      { numRuns: 100 }
    );
  });

  it('is case-insensitive for extension matching', () => {
    // Generate filenames with mixed case extensions
    const mixedCaseFilenameArb = fc.tuple(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('.') && !s.includes('/') && !s.includes('\\')),
      fc.constantFrom(...SUPPORTED_TEXT_EXTENSIONS),
      fc.boolean()
    ).map(([name, ext, toUpper]) => {
      // Randomly uppercase the extension
      const mixedExt = toUpper ? ext.toUpperCase() : ext;
      return name + mixedExt;
    });

    fc.assert(
      fc.property(mixedCaseFilenameArb, (filename) => {
        return isSupportedTextFile(filename) === true;
      }),
      { numRuns: 100 }
    );
  });

  it('returns false for empty or invalid filenames', () => {
    expect(isSupportedTextFile('')).toBe(false);
    expect(isSupportedTextFile(null as unknown as string)).toBe(false);
    expect(isSupportedTextFile(undefined as unknown as string)).toBe(false);
  });

  it('returns false for filenames without extensions', () => {
    const noExtFilenameArb = fc.string({ minLength: 1, maxLength: 50 })
      .filter(s => !s.includes('.'));

    fc.assert(
      fc.property(noExtFilenameArb, (filename) => {
        return isSupportedTextFile(filename) === false;
      }),
      { numRuns: 100 }
    );
  });
});


import { readTextFile, FILE_ERROR_MESSAGES } from './textFileUtils';
import { MAX_TEXT_FILE_SIZE } from '../types';

/**
 * Property 3: Size Validation
 * 
 * *For any* file with size > MAX_TEXT_FILE_SIZE (1MB), the file reader 
 * SHALL reject the file with an appropriate error message.
 * 
 * **Validates: Requirements 1.5, 4.4**
 */
describe('Property 3: Size Validation', () => {
  /**
   * Create a mock File object with specified size
   */
  function createMockFile(size: number, name: string = 'test.txt'): File {
    // Create a blob with the specified size
    const content = new Uint8Array(size);
    return new File([content], name, { type: 'text/plain' });
  }

  it('rejects files larger than MAX_TEXT_FILE_SIZE with appropriate error', async () => {
    // Test with files slightly over the limit
    const oversizedArb = fc.integer({ min: MAX_TEXT_FILE_SIZE + 1, max: MAX_TEXT_FILE_SIZE + 1000 });

    await fc.assert(
      fc.asyncProperty(oversizedArb, async (size) => {
        const file = createMockFile(size);
        
        try {
          await readTextFile(file);
          return false; // Should have thrown
        } catch (error) {
          return (error as Error).message === FILE_ERROR_MESSAGES.TOO_LARGE;
        }
      }),
      { numRuns: 20 }
    );
  });

  it('accepts files at or below MAX_TEXT_FILE_SIZE', async () => {
    // Test with files at or below the limit (use small sizes for speed)
    const validSizeArb = fc.integer({ min: 0, max: 1000 });

    await fc.assert(
      fc.asyncProperty(validSizeArb, async (size) => {
        const file = createMockFile(size);
        
        try {
          const result = await readTextFile(file);
          return result.size === size && result.filename === 'test.txt';
        } catch {
          return false; // Should not throw for valid sizes
        }
      }),
      { numRuns: 20 }
    );
  });

  it('accepts files exactly at MAX_TEXT_FILE_SIZE boundary', async () => {
    const file = createMockFile(MAX_TEXT_FILE_SIZE);
    
    const result = await readTextFile(file);
    expect(result.size).toBe(MAX_TEXT_FILE_SIZE);
    expect(result.filename).toBe('test.txt');
  });

  it('rejects files exactly 1 byte over MAX_TEXT_FILE_SIZE', async () => {
    const file = createMockFile(MAX_TEXT_FILE_SIZE + 1);
    
    await expect(readTextFile(file)).rejects.toThrow(FILE_ERROR_MESSAGES.TOO_LARGE);
  });
});


import { validateFileCount, FILE_ERROR_MESSAGES } from './textFileUtils';
import { MAX_TEXT_FILES } from '../types';

/**
 * Property 6: File Count Limit Invariant
 * 
 * *For any* sequence of file attachment operations, the number of pending files 
 * SHALL never exceed MAX_TEXT_FILES (5). Attempting to add files beyond this 
 * limit SHALL reject the excess files.
 * 
 * **Validates: Requirements 5.3, 5.4**
 */
describe('Property 6: File Count Limit Invariant', () => {
  /**
   * Arbitrary for current file count (0 to MAX_TEXT_FILES + some overflow)
   */
  const currentCountArb = fc.integer({ min: 0, max: MAX_TEXT_FILES + 5 });
  
  /**
   * Arbitrary for new files count (1 to 10)
   */
  const newFilesCountArb = fc.integer({ min: 1, max: 10 });

  it('filesToProcess never exceeds available slots', () => {
    fc.assert(
      fc.property(currentCountArb, newFilesCountArb, (currentCount, newFilesCount) => {
        const result = validateFileCount(currentCount, newFilesCount);
        const availableSlots = Math.max(0, MAX_TEXT_FILES - currentCount);
        
        // filesToProcess should never exceed available slots
        return result.filesToProcess <= availableSlots;
      }),
      { numRuns: 100 }
    );
  });

  it('total files after adding never exceeds MAX_TEXT_FILES (from valid state)', () => {
    // Only test from valid starting states (currentCount <= MAX_TEXT_FILES)
    const validCurrentCountArb = fc.integer({ min: 0, max: MAX_TEXT_FILES });
    
    fc.assert(
      fc.property(validCurrentCountArb, newFilesCountArb, (currentCount, newFilesCount) => {
        const result = validateFileCount(currentCount, newFilesCount);
        
        // Total files after adding should never exceed MAX_TEXT_FILES
        const totalAfterAdding = currentCount + result.filesToProcess;
        return totalAfterAdding <= MAX_TEXT_FILES;
      }),
      { numRuns: 100 }
    );
  });

  it('returns canAdd=false when no slots available', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_TEXT_FILES, max: MAX_TEXT_FILES + 10 }),
        newFilesCountArb,
        (currentCount, newFilesCount) => {
          const result = validateFileCount(currentCount, newFilesCount);
          
          // When at or over limit, canAdd should be false
          return result.canAdd === false && 
                 result.filesToProcess === 0 &&
                 result.error === FILE_ERROR_MESSAGES.FILE_COUNT_EXCEEDED;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('returns error when new files exceed available slots', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_TEXT_FILES - 1 }),
        (currentCount) => {
          const availableSlots = MAX_TEXT_FILES - currentCount;
          const newFilesCount = availableSlots + 1; // One more than available
          
          const result = validateFileCount(currentCount, newFilesCount);
          
          // Should have error but still allow adding up to available slots
          return result.canAdd === true &&
                 result.filesToProcess === availableSlots &&
                 result.error !== null;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('returns no error when new files fit within available slots', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_TEXT_FILES - 1 }),
        (currentCount) => {
          const availableSlots = MAX_TEXT_FILES - currentCount;
          // Generate a count that fits within available slots
          const newFilesCount = Math.min(availableSlots, Math.max(1, Math.floor(Math.random() * availableSlots)));
          
          const result = validateFileCount(currentCount, newFilesCount);
          
          return result.canAdd === true &&
                 result.filesToProcess === newFilesCount &&
                 result.error === null;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('availableSlots is always non-negative', () => {
    fc.assert(
      fc.property(currentCountArb, newFilesCountArb, (currentCount, newFilesCount) => {
        const result = validateFileCount(currentCount, newFilesCount);
        return result.availableSlots >= 0;
      }),
      { numRuns: 100 }
    );
  });

  // Boundary tests
  it('allows exactly MAX_TEXT_FILES when starting from 0', () => {
    const result = validateFileCount(0, MAX_TEXT_FILES);
    expect(result.canAdd).toBe(true);
    expect(result.filesToProcess).toBe(MAX_TEXT_FILES);
    expect(result.error).toBeNull();
  });

  it('rejects when trying to add to a full list', () => {
    const result = validateFileCount(MAX_TEXT_FILES, 1);
    expect(result.canAdd).toBe(false);
    expect(result.filesToProcess).toBe(0);
    expect(result.error).toBe(FILE_ERROR_MESSAGES.FILE_COUNT_EXCEEDED);
  });

  it('allows adding 1 file when at MAX_TEXT_FILES - 1', () => {
    const result = validateFileCount(MAX_TEXT_FILES - 1, 1);
    expect(result.canAdd).toBe(true);
    expect(result.filesToProcess).toBe(1);
    expect(result.error).toBeNull();
  });

  it('limits to 1 file when at MAX_TEXT_FILES - 1 and trying to add 2', () => {
    const result = validateFileCount(MAX_TEXT_FILES - 1, 2);
    expect(result.canAdd).toBe(true);
    expect(result.filesToProcess).toBe(1);
    expect(result.error).not.toBeNull();
  });
});


import { formatTextFileContent } from './textFileUtils';

/**
 * Property 5: Message Formatting
 * 
 * *For any* filename and content, the formatted ContentPart text SHALL match 
 * the pattern: "📄 {filename}\n```\n{content}\n```"
 * 
 * **Validates: Requirements 3.1, 3.2, 3.4**
 */
describe('Property 5: Message Formatting', () => {
  /**
   * Arbitrary for generating filenames (non-empty strings without newlines)
   */
  const filenameArb = fc.string({ minLength: 1, maxLength: 100 })
    .filter(s => !s.includes('\n') && !s.includes('\r'));

  /**
   * Arbitrary for generating file content (any string)
   */
  const contentArb = fc.string({ minLength: 0, maxLength: 1000 });

  it('formatted output starts with file emoji and filename', () => {
    fc.assert(
      fc.property(filenameArb, contentArb, (filename, content) => {
        const formatted = formatTextFileContent(filename, content);
        return formatted.startsWith(`📄 ${filename}\n`);
      }),
      { numRuns: 100 }
    );
  });

  it('formatted output contains content wrapped in code block', () => {
    fc.assert(
      fc.property(filenameArb, contentArb, (filename, content) => {
        const formatted = formatTextFileContent(filename, content);
        // Should contain the code block with content
        return formatted.includes('```\n' + content + '\n```');
      }),
      { numRuns: 100 }
    );
  });

  it('formatted output matches exact pattern', () => {
    fc.assert(
      fc.property(filenameArb, contentArb, (filename, content) => {
        const formatted = formatTextFileContent(filename, content);
        const expected = `📄 ${filename}\n\`\`\`\n${content}\n\`\`\``;
        return formatted === expected;
      }),
      { numRuns: 100 }
    );
  });

  it('formatted output ends with closing code block', () => {
    fc.assert(
      fc.property(filenameArb, contentArb, (filename, content) => {
        const formatted = formatTextFileContent(filename, content);
        return formatted.endsWith('```');
      }),
      { numRuns: 100 }
    );
  });

  // Specific example tests
  it('formats a simple text file correctly', () => {
    const formatted = formatTextFileContent('test.txt', 'Hello, World!');
    expect(formatted).toBe('📄 test.txt\n```\nHello, World!\n```');
  });

  it('formats a JSON file correctly', () => {
    const content = '{"key": "value"}';
    const formatted = formatTextFileContent('config.json', content);
    expect(formatted).toBe('📄 config.json\n```\n{"key": "value"}\n```');
  });

  it('handles empty content', () => {
    const formatted = formatTextFileContent('empty.txt', '');
    expect(formatted).toBe('📄 empty.txt\n```\n\n```');
  });

  it('handles content with newlines', () => {
    const content = 'line1\nline2\nline3';
    const formatted = formatTextFileContent('multiline.txt', content);
    expect(formatted).toBe('📄 multiline.txt\n```\nline1\nline2\nline3\n```');
  });

  it('handles content with special characters', () => {
    const content = '特殊字符: @#$%^&*()';
    const formatted = formatTextFileContent('special.txt', content);
    expect(formatted).toBe('📄 special.txt\n```\n特殊字符: @#$%^&*()\n```');
  });
});
