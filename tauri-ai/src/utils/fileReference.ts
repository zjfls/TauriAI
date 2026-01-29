export type ParsedFileReference = {
  filePath: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
};

const stripDiffPrefix = (path: string) => {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  if (path.startsWith('a\\') || path.startsWith('b\\')) return path.slice(2);
  return path;
};

/**
 * Parse a "file reference token" from inline code, e.g.:
 * - `src/app.ts:42`
 * - `b/server/index.js#L10`
 *
 * Supports range formats:
 * - `events.rs:96-125`
 * - `events.rs:96:3-125:9`
 * - `events.rs#L96-L125`
 * - `events.rs#L96C3-L125C9`
 */
export const parseFileReferenceToken = (token: string): ParsedFileReference | null => {
  const raw = token.trim();
  if (!raw) return null;
  if (raw.length > 800) return null;
  if (/[\r\n\t]/.test(raw)) return null;
  // Disallow URLs like https://... (but keep Windows paths like C:\...)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return null;

  // Hash style: path#L10 or path#L10C2
  // Range: path#L10-L20 or path#L10C2-L20C9
  const hashRangeMatch = raw.match(/^(.*)#L(\d+)(?:C(\d+))?-(?:L)?(\d+)(?:C(\d+))?$/);
  if (hashRangeMatch) {
    const filePath = stripDiffPrefix(hashRangeMatch[1] ?? '').trim();
    const line = Number(hashRangeMatch[2]);
    const column = hashRangeMatch[3] ? Number(hashRangeMatch[3]) : undefined;
    const endLine = Number(hashRangeMatch[4]);
    const endColumn = hashRangeMatch[5] ? Number(hashRangeMatch[5]) : undefined;
    if (!filePath || !Number.isFinite(line) || line <= 0) return null;
    if (typeof column === 'number' && (!Number.isFinite(column) || column <= 0)) return null;
    if (!Number.isFinite(endLine) || endLine <= 0) return null;
    if (typeof endColumn === 'number' && (!Number.isFinite(endColumn) || endColumn <= 0)) return null;
    return { filePath, line, column, endLine, endColumn };
  }

  const hashMatch = raw.match(/^(.*)#L(\d+)(?:C(\d+))?$/);
  if (hashMatch) {
    const filePath = stripDiffPrefix(hashMatch[1] ?? '').trim();
    const line = Number(hashMatch[2]);
    const column = hashMatch[3] ? Number(hashMatch[3]) : undefined;
    if (!filePath || !Number.isFinite(line) || line <= 0) return null;
    if (typeof column === 'number' && (!Number.isFinite(column) || column <= 0)) return null;
    return { filePath, line, column };
  }

  // Colon style: path:10 or path:10:2
  // Range: path:10-20 or path:10:2-20:9
  const colonRangeWithColumnMatch = raw.match(/^(.*):(\d+):(\d+)-(\d+):(\d+)$/);
  if (colonRangeWithColumnMatch) {
    const filePath = stripDiffPrefix(colonRangeWithColumnMatch[1] ?? '').trim();
    const line = Number(colonRangeWithColumnMatch[2]);
    const column = Number(colonRangeWithColumnMatch[3]);
    const endLine = Number(colonRangeWithColumnMatch[4]);
    const endColumn = Number(colonRangeWithColumnMatch[5]);
    if (!filePath || !Number.isFinite(line) || line <= 0) return null;
    if (!Number.isFinite(column) || column <= 0) return null;
    if (!Number.isFinite(endLine) || endLine <= 0) return null;
    if (!Number.isFinite(endColumn) || endColumn <= 0) return null;
    return { filePath, line, column, endLine, endColumn };
  }

  const colonRangeMatch = raw.match(/^(.*):(\d+)-(\d+)$/);
  if (colonRangeMatch) {
    const filePath = stripDiffPrefix(colonRangeMatch[1] ?? '').trim();
    const line = Number(colonRangeMatch[2]);
    const endLine = Number(colonRangeMatch[3]);
    if (!filePath || !Number.isFinite(line) || line <= 0) return null;
    if (!Number.isFinite(endLine) || endLine <= 0) return null;
    return { filePath, line, endLine };
  }

  const colonWithColumnMatch = raw.match(/^(.*):(\d+):(\d+)$/);
  if (colonWithColumnMatch) {
    const filePath = stripDiffPrefix(colonWithColumnMatch[1] ?? '').trim();
    const line = Number(colonWithColumnMatch[2]);
    const column = Number(colonWithColumnMatch[3]);
    if (!filePath || !Number.isFinite(line) || line <= 0) return null;
    if (!Number.isFinite(column) || column <= 0) return null;
    return { filePath, line, column };
  }

  const colonMatch = raw.match(/^(.*):(\d+)$/);
  if (colonMatch) {
    const filePath = stripDiffPrefix(colonMatch[1] ?? '').trim();
    const line = Number(colonMatch[2]);
    if (!filePath || !Number.isFinite(line) || line <= 0) return null;
    return { filePath, line };
  }

  return null;
};
