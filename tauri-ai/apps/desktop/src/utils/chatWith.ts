import type { CodeSnippetContentPart, WorkstudioCodeAnchor } from '../types';

const normalizeFsPath = (value: string): string => value.replace(/\\/g, '/');

const formatChatWithRangeLabel = (anchor: WorkstudioCodeAnchor): string | null => {
  const range = anchor.range;
  if (!range) return null;
  return `L${range.startLine}:${range.startColumn} - L${range.endLine}:${range.endColumn}`;
};

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

export const buildChatWithDefaultDraft = (
  anchor: WorkstudioCodeAnchor,
  snippetId: string
): string => {
  const lines = ['请基于当前选中的代码片段回答我的问题。', ''];
  const normalizedPath = normalizeFsPath(anchor.filePath || '').trim();
  const normalizedLabel = String(anchor.label ?? '').trim();
  const normalizedLanguageId = String(anchor.languageId ?? '').trim();
  const rangeLabel = formatChatWithRangeLabel(anchor);

  if (normalizedLabel) lines.push(`选区：${normalizedLabel}`);
  if (normalizedPath) lines.push(`文件路径：${normalizedPath}`);
  if (rangeLabel) lines.push(`代码范围：${rangeLabel}`);
  if (normalizedLanguageId) lines.push(`语言：${normalizedLanguageId}`);

  lines.push('选中代码：');
  lines.push(`@{snippet:${snippetId}}`);
  lines.push('');
  lines.push('问题：');
  return lines.join('\n');
};
