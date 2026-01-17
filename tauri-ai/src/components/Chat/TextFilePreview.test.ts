/**
 * TextFilePreview Property Tests
 * 
 * Property 4: Content Truncation
 * 
 * **Validates: Requirements 2.2**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { truncateContent, PREVIEW_MAX_CHARS, formatFileSize } from './TextFilePreview';

/**
 * Property 4: Content Truncation
 * 
 * *For any* file content string, the preview display SHALL show at most 500 characters,
 * and if the original content length > 500, the preview SHALL include a truncation indicator.
 * 
 * **Validates: Requirements 2.2**
 */
describe('Property 4: Content Truncation', () => {
  /**
   * Arbitrary for generating content strings of various lengths
   */
  const contentArb = fc.string({ minLength: 0, maxLength: 2000 });

  it('truncated content length is at most PREVIEW_MAX_CHARS + 3 (for ellipsis)', () => {
    fc.assert(
      fc.property(contentArb, (content) => {
        const truncated = truncateContent(content);
        // If content is longer than max, result should be max + 3 (for "...")
        // If content is shorter or equal, result should be same length
        if (content.length > PREVIEW_MAX_CHARS) {
          return truncated.length === PREVIEW_MAX_CHARS + 3;
        }
        return truncated.length === content.length;
      }),
      { numRuns: 100 }
    );
  });

  it('content longer than PREVIEW_MAX_CHARS includes truncation indicator (...)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: PREVIEW_MAX_CHARS + 1, maxLength: 2000 }),
        (content) => {
          const truncated = truncateContent(content);
          return truncated.endsWith('...');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('content at or below PREVIEW_MAX_CHARS is returned unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: PREVIEW_MAX_CHARS }),
        (content) => {
          const truncated = truncateContent(content);
          return truncated === content;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('truncated content preserves the first PREVIEW_MAX_CHARS characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: PREVIEW_MAX_CHARS + 1, maxLength: 2000 }),
        (content) => {
          const truncated = truncateContent(content);
          const expectedPrefix = content.slice(0, PREVIEW_MAX_CHARS);
          return truncated.startsWith(expectedPrefix);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('content exactly at PREVIEW_MAX_CHARS boundary is not truncated', () => {
    // Generate content exactly at the boundary
    const exactLengthArb = fc.string({ minLength: PREVIEW_MAX_CHARS, maxLength: PREVIEW_MAX_CHARS });
    
    fc.assert(
      fc.property(exactLengthArb, (content) => {
        const truncated = truncateContent(content);
        return truncated === content && !truncated.endsWith('...');
      }),
      { numRuns: 50 }
    );
  });

  it('content exactly 1 character over PREVIEW_MAX_CHARS is truncated', () => {
    const overByOneArb = fc.string({ minLength: PREVIEW_MAX_CHARS + 1, maxLength: PREVIEW_MAX_CHARS + 1 });
    
    fc.assert(
      fc.property(overByOneArb, (content) => {
        const truncated = truncateContent(content);
        return truncated.endsWith('...') && truncated.length === PREVIEW_MAX_CHARS + 3;
      }),
      { numRuns: 50 }
    );
  });

  it('empty content returns empty string', () => {
    expect(truncateContent('')).toBe('');
  });
});

/**
 * Unit tests for formatFileSize helper
 */
describe('formatFileSize', () => {
  it('formats bytes correctly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(100)).toBe('100 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats kilobytes correctly', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1023)).toBe('1023.0 KB');
  });

  it('formats megabytes correctly', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });
});
