import type { CodeSnippetContentPart, WorkstudioCodeAnchor } from '../types';

const normalizeFsPath = (value: string): string => value.replace(/\\/g, '/');

export const formatChatWithTitle = (anchor: WorkstudioCodeAnchor): string => {
  const normalized = normalizeFsPath(anchor.filePath || '');
  const base = normalized.split('/').filter(Boolean).pop() || normalized || 'Chat with';
  const range = anchor.range;
  if (!range) return `Chat with · ${base}`;
  const lineLabel =
    range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-${range.endLine}`;
  return `Chat with · ${base} · ${lineLabel}`;
};

export const buildChatWithSnippet = (
  anchor: WorkstudioCodeAnchor,
  selectionText: string
): CodeSnippetContentPart => ({
  type: 'code_snippet',
  id: crypto.randomUUID(),
  label: anchor.label,
  text: selectionText,
  languageId: anchor.languageId || undefined,
  filePath: anchor.filePath || undefined,
  range: anchor.range
    ? {
        startLine: anchor.range.startLine,
        startColumn: anchor.range.startColumn,
        endLine: anchor.range.endLine,
        endColumn: anchor.range.endColumn,
      }
    : undefined,
});
