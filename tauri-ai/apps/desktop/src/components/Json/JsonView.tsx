import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { getNodeValue, parseTree, type Node as JsonAstNode, type ParseError } from 'jsonc-parser';
import { setupMonaco } from '../../utils/monaco';

export type JsonViewMode = 'object' | 'vscode';

export interface JsonViewProps {
  text: string;
  onTextChange?: (next: string) => void;
  readOnly?: boolean;
  defaultMode?: JsonViewMode;
  className?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const safeStringify = (value: unknown, indent: number = 2): string => {
  try {
    const out = JSON.stringify(value, null, indent);
    return typeof out === 'string' ? out : String(out ?? '');
  } catch {
    try {
      return String(value ?? '');
    } catch {
      return '';
    }
  }
};

const maybeParseJsonContainerString = (raw: string): unknown | null => {
  const text = raw.trim();
  if (!text) return null;
  const maybeContainer =
    (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
  if (!maybeContainer) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const maybeParseJsonStringLiteral = (raw: string): string | null => {
  const text = raw.trim();
  if (text.length < 2) return null;
  if (!text.startsWith('"') || !text.endsWith('"')) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeJsonLikeStrings = (value: unknown, depth: number = 0): unknown => {
  if (depth > 10) return value;

  if (typeof value === 'string') {
    const parsed = maybeParseJsonContainerString(value);
    if (parsed !== null) {
      return normalizeJsonLikeStrings(parsed, depth + 1);
    }

    const decoded = maybeParseJsonStringLiteral(value);
    if (decoded !== null) {
      const reparsed = maybeParseJsonContainerString(decoded);
      if (reparsed !== null) {
        return normalizeJsonLikeStrings(reparsed, depth + 1);
      }
      return decoded;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonLikeStrings(item, depth + 1));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeJsonLikeStrings(v, depth + 1);
    }
    return out;
  }

  return value;
};

const isTextualFieldName = (fieldName?: string): boolean => {
  if (!fieldName) return false;
  const k = fieldName.toLowerCase();
  return (
    k === 'text' ||
    k.endsWith('_text') ||
    k.includes('content') ||
    k.includes('message') ||
    k.includes('summary') ||
    k.includes('thinking') ||
    k.includes('reasoning') ||
    k.includes('prompt') ||
    k.includes('output')
  );
};

const shouldRenderStringAsTextBlock = (value: string, fieldName?: string): boolean => {
  if (value.length === 0) return true;
  if (value.includes('\n')) return true;
  if (value.length > 140) return true;
  return isTextualFieldName(fieldName);
};

const normalizeStringForDisplay = (value: string): string => {
  if (!value) return value;
  if (!value.includes('\\n') && !value.includes('\\r')) return value;
  return value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
};

const inlinePrimitiveText = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return safeStringify(value);
};

const StructuredJsonNode: React.FC<{
  value: unknown;
  name?: string;
  depth: number;
  nodeKey: string;
}> = ({ value, name, depth, nodeKey }) => {
  const label = name ? (
    <span className="font-medium text-gray-700 dark:text-gray-200">{name}: </span>
  ) : null;
  const childIndent = depth === 0 ? '' : 'pl-3 border-l border-gray-200 dark:border-gray-700';

  if (Array.isArray(value)) {
    const summary = name ? `${name} [${value.length}]` : `Array [${value.length}]`;
    return (
      <details
        open={depth < 2}
        className="rounded border border-gray-200 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-800/40"
      >
        <summary className="cursor-pointer select-none px-2 py-1 text-xs text-gray-700 dark:text-gray-200">
          {summary}
        </summary>
        <div className={`space-y-2 px-2 pb-2 ${childIndent}`}>
          {value.length === 0 ? (
            <div className="text-xs text-gray-500 dark:text-gray-400">[]</div>
          ) : (
            value.map((item, idx) => (
              <StructuredJsonNode
                key={`${nodeKey}[${idx}]`}
                value={item}
                name={`[${idx}]`}
                depth={depth + 1}
                nodeKey={`${nodeKey}[${idx}]`}
              />
            ))
          )}
        </div>
      </details>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    const summary = name ? `${name} {${entries.length}}` : `Object {${entries.length}}`;
    return (
      <details
        open={depth < 2}
        className="rounded border border-gray-200 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-800/40"
      >
        <summary className="cursor-pointer select-none px-2 py-1 text-xs text-gray-700 dark:text-gray-200">
          {summary}
        </summary>
        <div className={`space-y-2 px-2 pb-2 ${childIndent}`}>
          {entries.length === 0 ? (
            <div className="text-xs text-gray-500 dark:text-gray-400">{'{}'}</div>
          ) : (
            entries.map(([k, v]) => (
              <StructuredJsonNode
                key={`${nodeKey}.${k}`}
                value={v}
                name={k}
                depth={depth + 1}
                nodeKey={`${nodeKey}.${k}`}
              />
            ))
          )}
        </div>
      </details>
    );
  }

  if (typeof value === 'string' && shouldRenderStringAsTextBlock(value, name)) {
    const normalizedText = normalizeStringForDisplay(value);
    return (
      <div className="space-y-1">
        {name && <div className="text-xs">{label}</div>}
        <pre className="rounded border border-gray-200 bg-white/80 px-2 py-1 text-xs whitespace-pre-wrap break-words text-gray-800 dark:border-gray-700 dark:bg-black/20 dark:text-gray-100">
          {normalizedText || '(空字符串)'}
        </pre>
      </div>
    );
  }

  return (
    <div className="text-xs break-words text-gray-800 dark:text-gray-100">
      {label}
      <span className="font-mono">{inlinePrimitiveText(value)}</span>
    </div>
  );
};

type OutlineItem = {
  id: string;
  label: string;
  kind: 'object' | 'array' | 'leaf';
  selectOffset: number;
  selectLength: number;
  count?: number;
  children?: OutlineItem[];
};

const pickPropertyKey = (prop: JsonAstNode): string => {
  const key = prop.children?.[0];
  const raw = (key as any)?.value;
  return typeof raw === 'string' && raw.trim() ? raw : '(unknown)';
};

const pickPropertyValueNode = (prop: JsonAstNode): JsonAstNode | null => {
  const v = prop.children?.[1] ?? null;
  return v && typeof (v as any).offset === 'number' && typeof (v as any).length === 'number' ? v : null;
};

const buildOutline = (node: JsonAstNode, id: string, label: string): OutlineItem => {
  const kind: OutlineItem['kind'] = node.type === 'object' ? 'object' : node.type === 'array' ? 'array' : 'leaf';

  if (node.type === 'object') {
    const props = node.children ?? [];
    const children: OutlineItem[] = props
      .filter((p) => p.type === 'property')
      .map((p) => {
        const key = pickPropertyKey(p);
        const valueNode = pickPropertyValueNode(p) ?? p;
        const childId = id ? `${id}.${key}` : key;
        return buildOutline(valueNode, childId, key);
      });

    return {
      id,
      label,
      kind,
      selectOffset: node.offset,
      selectLength: node.length,
      count: children.length,
      children,
    };
  }

  if (node.type === 'array') {
    const items = node.children ?? [];
    const children = items.map((child, idx) => {
      const childId = `${id}[${idx}]`;
      const childLabel = `[${idx}]`;
      return buildOutline(child, childId, childLabel);
    });

    return {
      id,
      label,
      kind,
      selectOffset: node.offset,
      selectLength: node.length,
      count: children.length,
      children,
    };
  }

  return {
    id,
    label,
    kind,
    selectOffset: node.offset,
    selectLength: node.length,
  };
};

const OutlineTree: React.FC<{
  item: OutlineItem;
  depth: number;
  selectedId: string | null;
  onSelect: (item: OutlineItem) => void;
}> = ({ item, depth, selectedId, onSelect }) => {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = Boolean(item.children && item.children.length > 0);
  const isSelected = selectedId === item.id;
  const indentStyle: React.CSSProperties = { paddingLeft: depth * 12 };
  const countText =
    typeof item.count === 'number'
      ? item.kind === 'array'
        ? ` [${item.count}]`
        : item.kind === 'object'
          ? ` {${item.count}}`
          : ''
      : '';

  if (!hasChildren) {
    return (
      <button
        type="button"
        onClick={() => onSelect(item)}
        style={indentStyle}
        className={`w-full text-left rounded px-2 py-1 text-xs font-mono ${
          isSelected
            ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800/60'
        }`}
        title={item.id}
      >
        {item.label}
      </button>
    );
  }

  return (
    <div className="rounded">
      <div
        style={indentStyle}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
          isSelected
            ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800/60'
        }`}
        title={item.id}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="p-0.5 rounded hover:bg-gray-200/60 dark:hover:bg-gray-700/60"
          title={expanded ? '收起' : '展开'}
        >
          {expanded ? <ChevronDown size={14} className="opacity-80" /> : <ChevronRight size={14} className="opacity-80" />}
        </button>
        <button
          type="button"
          onClick={() => onSelect(item)}
          className="flex-1 text-left font-mono"
        >
          {item.label}
          <span className="opacity-60">{countText}</span>
        </button>
      </div>

      {expanded && (
        <div className="mt-1 space-y-1">
          {item.children?.map((c) => (
            <OutlineTree
              key={c.id}
              item={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const parseErrorSummary = (errors: ParseError[]): string => {
  if (!errors || errors.length === 0) return '';
  const first = errors[0]!;
  const code = typeof first.error === 'number' ? String(first.error) : 'unknown';
  return `JSON 解析失败（errors=${errors.length}，code=${code}）`;
};

export const JsonView: React.FC<JsonViewProps> = ({
  text,
  onTextChange,
  readOnly = true,
  defaultMode = 'object',
  className,
}) => {
  const [mode, setMode] = useState<JsonViewMode>(defaultMode);
  useEffect(() => setMode(defaultMode), [defaultMode]);

  const rawEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const { root, errors, value } = useMemo(() => {
    const errs: ParseError[] = [];
    const root = parseTree(text, errs, { allowTrailingComma: true, disallowComments: false });
    const value = root ? getNodeValue(root) : null;
    return { root, errors: errs, value };
  }, [text]);

  const normalizedValue = useMemo(() => normalizeJsonLikeStrings(value), [value]);

  const prettyText = useMemo(() => {
    if (!root || errors.length > 0) return text;
    const formatted = safeStringify(value, 2);
    return formatted.trim() ? formatted : text;
  }, [errors.length, root, text, value]);

  const outlineRoot = useMemo(() => {
    if (!root || errors.length > 0) return null;
    const label = root.type === 'array' ? 'root' : root.type === 'object' ? 'root' : 'root';
    return buildOutline(root, 'root', label);
  }, [errors.length, root]);

  const [selectedOutlineId, setSelectedOutlineId] = useState<string | null>(null);
  useEffect(() => {
    // 内容变化时清空选中，避免 offset 失效导致跳转怪异
    setSelectedOutlineId(null);
  }, [text]);

  const handleRawMount = useCallback<OnMount>((editor, monaco) => {
    setupMonaco(monaco);
    rawEditorRef.current = editor as unknown as Monaco.editor.IStandaloneCodeEditor;
  }, []);

  const handlePrettyMount = useCallback<OnMount>((_editor, monaco) => {
    setupMonaco(monaco);
  }, []);

  const selectRawRange = useCallback((offset: number, length: number) => {
    const editor = rawEditorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const start = model.getPositionAt(Math.max(0, offset));
    const end = model.getPositionAt(Math.max(0, offset + Math.max(0, length)));
    const sel: Monaco.IRange = {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    };
    try {
      editor.setSelection(sel);
      editor.revealRangeInCenter(sel);
      editor.focus();
    } catch {
      // ignore
    }
  }, []);

  const onSelectOutline = useCallback(
    (item: OutlineItem) => {
      setSelectedOutlineId(item.id);
      selectRawRange(item.selectOffset, item.selectLength);
    },
    [selectRawRange]
  );

  const activeClass = 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100';
  const inactiveClass =
    'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800';

  const parseWarn = errors.length > 0 ? parseErrorSummary(errors) : '';

  return (
    <div className={`flex h-full flex-col ${className ?? ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <button
            type="button"
            onClick={() => setMode('object')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'object' ? activeClass : inactiveClass
            }`}
            title="对象 + 可读文本"
          >
            对象
          </button>
          <button
            type="button"
            onClick={() => setMode('vscode')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'vscode' ? activeClass : inactiveClass
            }`}
            title="VSCode 风格导航 + 原始文本"
          >
            VSCode
          </button>
        </div>

        {parseWarn ? (
          <div className="inline-flex items-center gap-1 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-800 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-200">
            <AlertTriangle size={14} />
            <span className="font-medium">{parseWarn}</span>
          </div>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            左侧用于导航；右侧用于查看文本（可复制/可选中）。
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {mode === 'object' ? (
          <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="h-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
                <div className="font-medium">JSON 对象（展开结构 + 可读文本）</div>
              </div>
              <div className="h-[calc(100%-36px)] overflow-auto p-3">
                {root && errors.length === 0 && (isRecord(normalizedValue) || Array.isArray(normalizedValue)) ? (
                  <div className="space-y-2">
                    <StructuredJsonNode value={normalizedValue} depth={0} nodeKey="root" />
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {text.trim() ? '不是有效的 JSON 对象/数组。' : '暂无内容。'}
                  </div>
                )}
              </div>
            </div>

            <div className="h-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
                <div className="font-medium">可读文本（格式化）</div>
              </div>
              <div className="h-[calc(100%-36px)] overflow-hidden">
                <Editor
                  height="100%"
                  theme={
                    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
                      ? 'vs-dark'
                      : 'vs'
                  }
                  value={prettyText}
                  language="json"
                  beforeMount={setupMonaco}
                  onMount={handlePrettyMount}
                  options={{
                    readOnly: true,
                    fontSize: 12,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    lineNumbers: 'on',
                    renderWhitespace: 'selection',
                    tabSize: 2,
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[340px_1fr]">
            <div className="h-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
                <div className="font-medium">导航</div>
              </div>
              <div className="h-[calc(100%-36px)] overflow-auto p-2">
                {outlineRoot ? (
                  <div className="space-y-1">
                    <OutlineTree item={outlineRoot} depth={0} selectedId={selectedOutlineId} onSelect={onSelectOutline} />
                  </div>
                ) : (
                  <div className="p-2 text-xs text-gray-500 dark:text-gray-400">
                    {text.trim() ? '无法解析 JSON（请先保证 JSON 格式正确）。' : '暂无内容。'}
                  </div>
                )}
              </div>
            </div>

            <div className="h-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
                <div className="font-medium">原始文本</div>
              </div>
              <div className="h-[calc(100%-36px)] overflow-hidden">
                <Editor
                  height="100%"
                  theme={
                    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
                      ? 'vs-dark'
                      : 'vs'
                  }
                  value={text}
                  language="json"
                  beforeMount={setupMonaco}
                  onMount={handleRawMount}
                  onChange={(value) => {
                    if (readOnly) return;
                    if (!onTextChange) return;
                    onTextChange(value ?? '');
                  }}
                  options={{
                    readOnly: readOnly || !onTextChange,
                    fontSize: 12,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    lineNumbers: 'on',
                    renderWhitespace: 'selection',
                    tabSize: 2,
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
