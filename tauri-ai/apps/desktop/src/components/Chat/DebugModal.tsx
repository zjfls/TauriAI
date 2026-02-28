/**
 * DebugModal Component
 * Displays raw HTTP request/response information in a structured format
 */

import React, { useEffect, useMemo, useState } from 'react';
import { X, ChevronDown, ChevronRight, Copy, Check, ChevronLeft, Maximize2 } from 'lucide-react';
import type {
  DebugInfo,
  MessageBlock,
  MessageTurn,
  AnsiColorMode,
  AnsiRenderMode,
  StreamTerminationInfo,
} from '../../types';
import { useConfigStore } from '../../stores/configStore';
import { getTurnDebugInfo } from '../../services/conversationService';
import { AnsiText } from './AnsiText';

interface DebugModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 是否处于流式生成中（用于调整默认展开/收起行为） */
  isStreaming?: boolean;
  debugInfo: DebugInfo | null;
  turns?: MessageTurn[] | null;
  blocks?: MessageBlock[] | null;
  initialTurnId?: string | null;
  /** 任务结束的错误原因（可选，用于在“暂无 HTTP 调试信息”时也能解释结束原因） */
  errorMessage?: string | null;
  messageRole: 'user' | 'assistant' | 'error';
  conversationId?: string;
  messageId?: string;
}

interface CollapsibleSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultExpanded = true,
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-gray-800 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {title}
      </button>
      {isExpanded && (
        <div className="p-4 bg-white dark:bg-gray-900">{children}</div>
      )}
    </div>
  );
};

interface JsonViewerProps {
  data: unknown;
  label?: string;
}

interface TextViewerProps {
  text: string;
  label?: string;
  maxHeightClassName?: string;
  containerClassName?: string;
  onOpenLarge?: (() => void) | null;
  renderAnsi?: boolean;
  ansiRenderMode?: AnsiRenderMode;
  ansiColorMode?: AnsiColorMode;
}

interface StructuredJsonTextViewerProps {
  data: unknown;
  label?: string;
  maxHeightClassName?: string;
  emptyText?: string;
}

type ProviderEndReasonKind =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'timeout'
  | 'cancelled'
  | 'incomplete'
  | 'unknown';

type ProviderEndReason = {
  raw: string;
  source: string;
  kind: ProviderEndReasonKind;
  zh: string;
};

type ApiErrorInfo = {
  message: string;
  type?: string;
  code?: string;
  status?: number;
};

type StreamTerminationSummary = {
  label: string;
  detail: string;
  tone: 'success' | 'warn' | 'error' | 'neutral';
};

type DebugModalPage = 'overview' | 'tools';
type HttpDebugView = 'response' | 'request';
type LargeTextViewerState = {
  title: string;
  text: string;
  rawJson?: unknown;
};
type LargeViewerMode = 'text' | 'json' | 'structured';

const maskSensitiveHeaders = (headers: Record<string, string>): Record<string, string> => {
  const masked: Record<string, string> = {};

  const maskShort = (value: string): string => {
    const t = String(value ?? '');
    if (!t) return t;
    if (t.length <= 12) return '***';
    return `${t.slice(0, 8)}...`;
  };

  const maskBearer = (auth: string): string => {
    const prefix = 'Bearer ';
    if (!auth.startsWith(prefix)) return maskShort(auth);
    const rest = auth.slice(prefix.length).trim();
    return rest ? `${prefix}${rest.slice(0, 8)}...` : `${prefix}***`;
  };

  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      masked[key] = maskBearer(String(value ?? ''));
      continue;
    }
    if (lower === 'cookie' || lower === 'set-cookie') {
      masked[key] = maskShort(String(value ?? ''));
      continue;
    }
    if (
      lower === 'x-api-key' ||
      lower === 'api-key' ||
      lower === 'apikey' ||
      lower === 'x-auth-token' ||
      lower.endsWith('token')
    ) {
      masked[key] = maskShort(String(value ?? ''));
      continue;
    }
    masked[key] = value;
  }

  return masked;
};

const sortRecordKeys = (record: Record<string, string>): Record<string, string> => {
  const entries = Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};

const prepareHeadersForJson = (headers: Record<string, string>): Record<string, string> => {
  return sortRecordKeys(maskSensitiveHeaders(headers));
};

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

const safeParseUrlParts = (rawUrl: string): { host: string; path: string } | null => {
  const raw = (rawUrl ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.host || u.hostname || raw;
    const path = `${u.pathname || ''}${u.search || ''}${u.hash || ''}` || '/';
    return { host, path };
  } catch {
    return null;
  }
};

const toPrettyMaybeJson = (raw: unknown): string => {
  const text = typeof raw === 'string' ? raw : safeStringify(raw);
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

const truncateMiddle = (text: string, head: number = 28, tail: number = 28): string => {
  const s = String(text ?? '');
  const h = Math.max(0, head);
  const t = Math.max(0, tail);
  if (s.length <= h + t + 3) return s;
  return `${s.slice(0, h)}...${s.slice(-t)}`;
};

const headersToText = (headers: Record<string, string> | null | undefined): string => {
  const prepared = headers ? prepareHeadersForJson(headers) : {};
  const entries = Object.entries(prepared);
  if (entries.length === 0) return '(空)';
  return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
};

const formatMessageContentAsText = (content: unknown): string => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === 'string') {
        if (p.trim()) parts.push(p);
        continue;
      }
      if (!isRecord(p)) {
        const s = safeStringify(p);
        if (s.trim()) parts.push(s);
        continue;
      }

      const type = typeof p.type === 'string' ? p.type : '';
      if (type === 'text' && typeof p.text === 'string') {
        if (p.text.trim()) parts.push(p.text);
        continue;
      }

      // OpenAI-like: { type: "image_url", image_url: { url } }
      if (type === 'image_url') {
        const imageUrl = isRecord(p.image_url) && typeof p.image_url.url === 'string' ? p.image_url.url : null;
        parts.push(imageUrl ? `[image] ${imageUrl}` : '[image]');
        continue;
      }

      // Anthropic-like: { type: "image", source: { ... } }
      if (type === 'image') {
        parts.push('[image]');
        continue;
      }

      // Fallback: known "text" field, otherwise stringify.
      if (typeof p.text === 'string' && p.text.trim()) {
        parts.push(p.text);
        continue;
      }
      const s = safeStringify(p);
      if (s.trim()) parts.push(s);
    }
    return parts.join('\n');
  }

  if (isRecord(content)) {
    if (typeof content.text === 'string') return content.text;
  }

  return safeStringify(content);
};

const formatRequestBodyAsText = (body: unknown): string => {
  if (typeof body === 'string') return toPrettyMaybeJson(body);
  if (!isRecord(body)) return safeStringify(body);

  const model = typeof body.model === 'string' ? body.model : null;
  const stream = typeof body.stream === 'boolean' ? body.stream : null;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const tools = Array.isArray(body.tools) ? body.tools : null;

  const header: string[] = [];
  if (model) header.push(`model: ${model}`);
  if (typeof stream === 'boolean') header.push(`stream: ${String(stream)}`);
  if (messages) header.push(`messages: ${messages.length}`);
  if (tools) header.push(`tools: ${tools.length}`);

  if (!messages) {
    return safeStringify(body);
  }

  const lines: string[] = [];
  if (header.length > 0) {
    lines.push(header.join(' | '));
    lines.push('');
  }

  messages.forEach((mRaw, idx) => {
    const m = isRecord(mRaw) ? mRaw : null;
    const role = m && typeof m.role === 'string' ? m.role : 'unknown';
    const name = m && typeof m.name === 'string' ? m.name : null;
    const toolCallId = m && typeof m.tool_call_id === 'string' ? m.tool_call_id : null;
    const titleBits = [
      `[${idx}] ${role}`,
      name ? `name=${name}` : null,
      toolCallId ? `tool_call_id=${toolCallId}` : null,
    ].filter(Boolean);
    lines.push(`--- ${titleBits.join(' ')} ---`);

    const contentText = m ? formatMessageContentAsText(m.content) : safeStringify(mRaw);
    if (contentText.trim()) {
      lines.push(contentText.trimEnd());
    }

    // tool_calls (OpenAI-like)
    const toolCalls = m && Array.isArray(m.tool_calls) ? m.tool_calls : null;
    if (toolCalls && toolCalls.length > 0) {
      for (const tcRaw of toolCalls) {
        const tc = isRecord(tcRaw) ? tcRaw : null;
        const tcId = tc && typeof tc.id === 'string' ? tc.id : null;
        const fn = tc && isRecord(tc.function) ? tc.function : null;
        const fnName = fn && typeof fn.name === 'string' ? fn.name : null;
        const fnArgs = fn ? fn.arguments : null;
        const toolLine = [
          '[tool_call]',
          fnName ?? '(unknown)',
          tcId ? `id=${tcId}` : null,
        ].filter(Boolean);
        lines.push(toolLine.join(' '));
        if (fnArgs !== null && fnArgs !== undefined) {
          lines.push(toPrettyMaybeJson(fnArgs).trimEnd());
        }
      }
    }

    // function_call (legacy)
    const functionCall = m && isRecord(m.function_call) ? m.function_call : null;
    if (functionCall) {
      const fnName = typeof functionCall.name === 'string' ? functionCall.name : null;
      const fnArgs = functionCall.arguments ?? null;
      const toolLine = ['[function_call]', fnName ?? '(unknown)'].filter(Boolean);
      lines.push(toolLine.join(' '));
      if (fnArgs !== null && fnArgs !== undefined) {
        lines.push(toPrettyMaybeJson(fnArgs).trimEnd());
      }
    }

    lines.push('');
  });

  return lines.join('\n').trimEnd();
};

const formatResponseBodyAsText = (body: unknown): string => {
  if (typeof body === 'string') return toPrettyMaybeJson(body);
  if (body === null || body === undefined) return '';
  if (!isRecord(body)) return safeStringify(body);

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const thinking = typeof body.thinking === 'string' ? body.thinking.trim() : '';
  const sections: string[] = [];

  if (content) {
    sections.push(content);
  }
  if (thinking) {
    sections.push(`[thinking]\n${thinking}`);
  }
  if (sections.length > 0) {
    return sections.join('\n\n');
  }

  const normalized = normalizeJsonLikeStrings(body);
  return safeStringify(normalized, 2);
};

const maybeParseJsonContainerString = (raw: string): unknown | null => {
  const text = raw.trim();
  if (!text) return null;
  const maybeContainer =
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('[') && text.endsWith(']'));
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
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
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
  const label = name ? <span className="font-medium text-gray-700 dark:text-gray-200">{name}: </span> : null;
  const childIndent = depth === 0 ? '' : 'pl-3 border-l border-gray-200 dark:border-gray-700';

  if (Array.isArray(value)) {
    const summary = name ? `${name} [${value.length}]` : `Array [${value.length}]`;
    return (
      <details open={depth < 2} className="rounded border border-gray-200 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-800/40">
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
      <details open={depth < 2} className="rounded border border-gray-200 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-800/40">
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
        {name && (
          <div className="text-xs">
            {label}
          </div>
        )}
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

type ChipTone = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple';

const chipToneClass: Record<ChipTone, string> = {
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-200',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-100',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-200',
};

const Chip: React.FC<{ tone?: ChipTone; title?: string; children: React.ReactNode }> = ({
  tone = 'gray',
  title,
  children,
}) => {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipToneClass[tone]}`}
      title={title}
    >
      {children}
    </span>
  );
};

const normalizeProviderEndReasonKind = (raw: string, source: string): ProviderEndReason => {
  const lower = raw.trim().toLowerCase();

  const mk = (kind: ProviderEndReasonKind, zh: string): ProviderEndReason => ({
    raw: raw.trim(),
    source,
    kind,
    zh,
  });

  if (!lower) return mk('unknown', '未知（空值）');

  // Provider-specific but common conventions:
  // - OpenAI: stop/length/content_filter/tool_calls
  // - Anthropic: end_turn/max_tokens/tool_use
  // - Gemini/others: STOP/MAX_TOKENS/SAFETY/...
  if (lower === 'stop' || lower === 'end_turn' || lower === 'end' || lower === 'finished') {
    return mk('stop', '正常停止（模型主动结束/命中 stop 条件）');
  }
  if (
    lower === 'length' ||
    lower === 'max_tokens' ||
    lower === 'max_output_tokens' ||
    lower === 'max_output' ||
    lower.includes('max_tokens') ||
    lower.includes('max_output')
  ) {
    return mk('length', '达到最大输出长度/Token 上限（被截断）');
  }
  if (
    lower === 'tool_calls' ||
    lower === 'tool_use' ||
    lower === 'function_call' ||
    lower.includes('tool')
  ) {
    return mk('tool_calls', '需要调用工具（模型请求 tool/function call）');
  }
  if (
    lower === 'content_filter' ||
    lower === 'safety' ||
    lower === 'blocked' ||
    lower.includes('filter') ||
    lower.includes('safety')
  ) {
    return mk('content_filter', '被安全策略/内容过滤拦截');
  }
  if (lower === 'timeout' || lower.includes('timeout')) {
    return mk('timeout', '请求超时');
  }
  if (
    lower === 'cancelled' ||
    lower === 'canceled' ||
    lower.includes('cancel') ||
    lower.includes('abort')
  ) {
    return mk('cancelled', '请求被取消/中止');
  }

  // Some providers expose `incomplete_details.reason`
  if (source.includes('incomplete')) {
    return mk('incomplete', '响应不完整（incomplete）');
  }

  return mk('unknown', '未知（提供方未标准化或未收录的原因）');
};

const extractApiErrorInfo = (body: any, httpStatus: number | null): ApiErrorInfo | null => {
  if (!body || typeof body !== 'object') return null;

  // Common patterns
  const candidate =
    body.error ??
    body.err ??
    body.errors?.[0] ??
    body.response?.error ??
    body.data?.error ??
    null;

  const pickString = (v: any): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  if (candidate && typeof candidate === 'object') {
    const message =
      pickString(candidate.message) ??
      pickString(candidate.msg) ??
      pickString(candidate.error?.message) ??
      pickString(body.message) ??
      pickString(body.msg) ??
      null;
    const type = pickString(candidate.type) ?? pickString(candidate.error?.type) ?? undefined;
    const code = pickString(candidate.code) ?? pickString(candidate.error?.code) ?? undefined;

    if (message) {
      return { message, type, code, status: typeof httpStatus === 'number' ? httpStatus : undefined };
    }
  }

  // Some APIs return a top-level message string
  const topMessage = pickString(body.message) ?? pickString(body.msg) ?? null;
  if (topMessage && (typeof httpStatus === 'number' ? httpStatus >= 400 : true)) {
    return { message: topMessage, status: typeof httpStatus === 'number' ? httpStatus : undefined };
  }

  return null;
};

const normalizeStreamTerminationInfo = (debugInfo: DebugInfo | null | undefined): StreamTerminationInfo | null => {
  const raw = (debugInfo as any)?.streamTermination ?? (debugInfo as any)?.stream_termination;
  if (!raw || typeof raw !== 'object') return null;

  const pickString = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  const pickStringArray = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === 'string');
    return out.length > 0 ? out : undefined;
  };

  const protocolComplete =
    typeof (raw as any).protocolComplete === 'boolean'
      ? (raw as any).protocolComplete
      : typeof (raw as any).protocol_complete === 'boolean'
        ? (raw as any).protocol_complete
        : null;

  const chunkCount =
    typeof (raw as any).chunkCount === 'number'
      ? (raw as any).chunkCount
      : typeof (raw as any).chunk_count === 'number'
        ? (raw as any).chunk_count
        : undefined;

  return {
    protocolComplete,
    terminationSource: pickString((raw as any).terminationSource) ?? pickString((raw as any).termination_source),
    protocolKind: pickString((raw as any).protocolKind) ?? pickString((raw as any).protocol_kind),
    expectedSignal: pickString((raw as any).expectedSignal) ?? pickString((raw as any).expected_signal),
    observedSignal: pickString((raw as any).observedSignal) ?? pickString((raw as any).observed_signal),
    lastEventType: pickString((raw as any).lastEventType) ?? pickString((raw as any).last_event_type),
    chunkCount,
    rawEventTail: pickStringArray((raw as any).rawEventTail) ?? pickStringArray((raw as any).raw_event_tail),
  };
};

const summarizeStreamTermination = (info: StreamTerminationInfo | null): StreamTerminationSummary => {
  if (!info) {
    return {
      label: '未知',
      detail: '未携带协议终止诊断字段',
      tone: 'neutral',
    };
  }

  const source = (info.terminationSource || '').toLowerCase();
  const protocol = info.protocolKind || 'unknown';
  const expected = info.expectedSignal || 'unknown';
  const observed = info.observedSignal || 'none';
  const chunkText = typeof info.chunkCount === 'number' ? `，chunks=${info.chunkCount}` : '';
  const eventText = info.lastEventType ? `，last_event=${info.lastEventType}` : '';

  if (info.protocolComplete === true) {
    return {
      label: '完整',
      detail: `协议标记已确认（source=${source || 'protocol_signal'}，protocol=${protocol}，expected=${expected}，observed=${observed}${chunkText}${eventText}）`,
      tone: 'success',
    };
  }

  if (source === 'eof_fallback') {
    return {
      label: 'EOF兜底',
      detail: `未观察到显式协议完成标记（protocol=${protocol}，expected=${expected}，observed=${observed}${chunkText}${eventText}）`,
      tone: 'warn',
    };
  }
  if (source === 'http_error') {
    return {
      label: 'HTTP错误',
      detail: `HTTP 层失败导致流提前结束（protocol=${protocol}，expected=${expected}，observed=${observed}${chunkText}${eventText}）`,
      tone: 'error',
    };
  }
  if (source === 'aborted') {
    return {
      label: '已中止',
      detail: `流被中止（protocol=${protocol}，expected=${expected}，observed=${observed}${chunkText}${eventText}）`,
      tone: 'warn',
    };
  }
  if (info.protocolComplete === false) {
    return {
      label: '不完整',
      detail: `协议终止未完整确认（source=${source || 'unknown'}，protocol=${protocol}，expected=${expected}，observed=${observed}${chunkText}${eventText}）`,
      tone: 'warn',
    };
  }

  return {
    label: '未知',
    detail: `终止信息不足以判定（source=${source || 'unknown'}，protocol=${protocol}，expected=${expected}，observed=${observed}${chunkText}${eventText}）`,
    tone: 'neutral',
  };
};

const JsonViewer: React.FC<JsonViewerProps> = ({ data, label }) => {
  const [copied, setCopied] = useState(false);
  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </div>
      )}
      <div className="relative group">
        <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-[50vh] text-gray-800 dark:text-gray-200">
          {jsonString}
        </pre>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
};

const TextViewer: React.FC<TextViewerProps> = ({
  text,
  label,
  maxHeightClassName = 'max-h-64',
  containerClassName = 'bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  onOpenLarge,
  renderAnsi = false,
  ansiRenderMode,
  ansiColorMode,
}) => {
  const [copied, setCopied] = useState(false);
  const actionPaddingRightClass = onOpenLarge ? 'pr-20' : 'pr-12';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </div>
      )}
      <div className="relative group">
        <pre
          className={`text-xs p-3 ${actionPaddingRightClass} rounded-lg overflow-auto ${maxHeightClassName} whitespace-pre-wrap ${containerClassName}`}
        >
          {renderAnsi ? (
            <AnsiText text={text} renderMode={ansiRenderMode} colorMode={ansiColorMode} />
          ) : (
            text
          )}
        </pre>
        <button
          type="button"
          onClick={() => onOpenLarge?.()}
          className={`absolute top-2 right-10 p-1.5 rounded bg-gray-200 dark:bg-gray-700 transition-opacity ${
            onOpenLarge ? 'opacity-0 group-hover:opacity-100' : 'hidden'
          }`}
          title="大窗口查看"
        >
          <Maximize2 size={14} className="text-gray-500 dark:text-gray-400" />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
};

const StructuredJsonTextViewer: React.FC<StructuredJsonTextViewerProps> = ({
  data,
  label,
  maxHeightClassName = 'max-h-[50vh]',
  emptyText = '(空内容)',
}) => {
  const [copied, setCopied] = useState(false);

  const normalized = useMemo(() => normalizeJsonLikeStrings(data), [data]);
  const hasValue = !(normalized === undefined || (typeof normalized === 'string' && normalized.trim().length === 0));
  const displayValue = hasValue ? normalized : emptyText;
  const copyValue = hasValue ? normalized : emptyText;
  const copyText = typeof copyValue === 'string' ? copyValue : safeStringify(copyValue, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {label}
        </div>
      )}
      <div className="relative group rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/40">
        <div className={`space-y-2 overflow-auto ${maxHeightClassName}`}>
          <StructuredJsonNode value={displayValue} depth={0} nodeKey="root" />
        </div>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-gray-200 dark:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
          title="复制"
        >
          {copied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>
    </div>
  );
};

export const DebugModal: React.FC<DebugModalProps> = ({
  isOpen,
  onClose,
  isStreaming,
  debugInfo,
  turns,
  blocks,
  initialTurnId,
  errorMessage,
  messageRole,
  conversationId,
  messageId,
}) => {
  const { config } = useConfigStore();
  const ansiRenderMode = config?.general?.ansiRenderMode;
  const ansiColorMode = config?.general?.ansiColorMode;
  const defaultExpandedForStreaming = Boolean(isStreaming);

  const sortedTurns = useMemo(
    () => (turns ?? []).slice().sort((a, b) => a.turnIndex - b.turnIndex),
    [turns]
  );
  const finalTurn = sortedTurns.length > 0 ? sortedTurns[sortedTurns.length - 1]! : null;
  const finalStatus = finalTurn?.status ?? (messageRole === 'error' ? 'failed' : null);
  const finalStatusTitle = finalStatus === 'success' ? '成功' : finalStatus === 'failed' ? '失败' : finalStatus === 'aborted' ? '中止' : '未知';
  const [loadedTurnDebugInfo, setLoadedTurnDebugInfo] = useState<Record<string, DebugInfo | null>>(
    {}
  );
  const [loadingTurnId, setLoadingTurnId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorTurnId, setLoadErrorTurnId] = useState<string | null>(null);
  const TURNS_PER_PAGE = 8;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(
    sortedTurns.length > 0
      ? (initialTurnId && sortedTurns.some((t) => t.turnId === initialTurnId)
        ? initialTurnId
        : sortedTurns[0].turnId)
      : (initialTurnId ?? null)
  );
  const [turnPage, setTurnPage] = useState(0);
  const [activePage, setActivePage] = useState<DebugModalPage>('overview');
  const [activeHttpView, setActiveHttpView] = useState<HttpDebugView>(
    messageRole === 'user' ? 'request' : 'response'
  );
  const [largeTextViewer, setLargeTextViewer] = useState<LargeTextViewerState | null>(null);
  const [largeViewerMode, setLargeViewerMode] = useState<LargeViewerMode>('text');

  useEffect(() => {
    if (!isOpen) return;
    setActivePage('overview');
    setActiveHttpView(messageRole === 'user' ? 'request' : 'response');
    setLargeTextViewer(null);
    setLargeViewerMode('text');
  }, [isOpen, messageRole]);

  useEffect(() => {
    if (!largeTextViewer) return;
    setLargeViewerMode('text');
  }, [largeTextViewer]);

  useEffect(() => {
    if (!isOpen) return;
    if (sortedTurns.length === 0) return;
    if (!activeTurnId || !sortedTurns.some((t) => t.turnId === activeTurnId)) {
      setActiveTurnId(sortedTurns[0].turnId);
    }
  }, [sortedTurns, activeTurnId, isOpen]);

  const activeTurn = activeTurnId
    ? sortedTurns.find((t) => t.turnId === activeTurnId) ?? null
    : null;
  const activeTurnPos = useMemo(() => {
    if (!activeTurnId) return -1;
    return sortedTurns.findIndex((t) => t.turnId === activeTurnId);
  }, [sortedTurns, activeTurnId]);

  const turnPageCount = useMemo(() => {
    if (sortedTurns.length <= 0) return 0;
    return Math.max(1, Math.ceil(sortedTurns.length / TURNS_PER_PAGE));
  }, [sortedTurns.length]);

  // Keep pagination in sync with active turn.
  useEffect(() => {
    if (!isOpen) return;
    if (sortedTurns.length <= TURNS_PER_PAGE) {
      setTurnPage(0);
      return;
    }
    if (activeTurnPos < 0) return;
    const nextPage = Math.floor(activeTurnPos / TURNS_PER_PAGE);
    setTurnPage((prev) => (prev === nextPage ? prev : nextPage));
  }, [isOpen, sortedTurns.length, activeTurnPos]);

  // Clamp when turns change (e.g. retry adds turns).
  useEffect(() => {
    if (!isOpen) return;
    if (turnPageCount <= 0) return;
    setTurnPage((prev) => Math.min(Math.max(prev, 0), turnPageCount - 1));
  }, [isOpen, turnPageCount]);

  const pagedTurns = useMemo(() => {
    if (sortedTurns.length <= TURNS_PER_PAGE) return sortedTurns;
    const start = turnPage * TURNS_PER_PAGE;
    const end = Math.min(sortedTurns.length, start + TURNS_PER_PAGE);
    return sortedTurns.slice(start, end);
  }, [sortedTurns, turnPage]);
  const loadedForActive = activeTurnId ? loadedTurnDebugInfo[activeTurnId] : undefined;
  const effectiveDebugInfo =
    loadedForActive !== undefined ? loadedForActive : activeTurn?.debugInfo ?? debugInfo;
  const isLoadingDebug = Boolean(activeTurnId && loadingTurnId === activeTurnId);
  const httpStatus = effectiveDebugInfo?.response?.status ?? null;
  const hasHttpResponse = Boolean(effectiveDebugInfo?.response);
  const hasHttpRequest = Boolean(effectiveDebugInfo?.request);

  useEffect(() => {
    if (!isOpen) return;
    if (activeHttpView === 'response' && !hasHttpResponse && hasHttpRequest) {
      setActiveHttpView('request');
      return;
    }
    if (activeHttpView === 'request' && !hasHttpRequest && hasHttpResponse) {
      setActiveHttpView('response');
    }
  }, [isOpen, activeHttpView, hasHttpResponse, hasHttpRequest]);

  const httpViewTabs = useMemo(() => {
    if (!hasHttpResponse && !hasHttpRequest && activePage !== 'tools') return null;
    const responseDisabled = !hasHttpResponse;
    const requestDisabled = !hasHttpRequest;

    const activeClass = 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100';
    const inactiveClass =
      'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800';
    const disabledClass =
      'bg-white text-gray-300 dark:bg-gray-900 dark:text-gray-700 cursor-not-allowed';

    return (
      <div
        className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
        title="切换 响应 / 请求 / 工具执行"
      >
        <button
          type="button"
          onClick={() => {
            if (responseDisabled) return;
            setActiveHttpView('response');
            if (activePage === 'tools') setActivePage('overview');
          }}
          disabled={responseDisabled}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            responseDisabled
              ? disabledClass
              : activePage !== 'tools' && activeHttpView === 'response'
                ? activeClass
                : inactiveClass
          }`}
        >
          响应
        </button>
        <button
          type="button"
          onClick={() => {
            if (requestDisabled) return;
            setActiveHttpView('request');
            if (activePage === 'tools') setActivePage('overview');
          }}
          disabled={requestDisabled}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            requestDisabled
              ? disabledClass
              : activePage !== 'tools' && activeHttpView === 'request'
                ? activeClass
                : inactiveClass
          }`}
        >
          请求
        </button>
        <button
          type="button"
          onClick={() => setActivePage('tools')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            activePage === 'tools' ? activeClass : inactiveClass
          }`}
        >
          工具执行
        </button>
      </div>
    );
  }, [activeHttpView, activePage, hasHttpResponse, hasHttpRequest]);
  const requestUrlParts = useMemo(
    () => safeParseUrlParts(effectiveDebugInfo?.request?.url ?? ''),
    [effectiveDebugInfo?.request?.url]
  );
  const requestHeadersText = useMemo(
    () => headersToText(effectiveDebugInfo?.request?.headers),
    [effectiveDebugInfo?.request?.headers]
  );
  const requestBodyText = useMemo(() => {
    const text = formatRequestBodyAsText(effectiveDebugInfo?.request?.body).trim();
    return text.length > 0 ? text : '(空请求体)';
  }, [effectiveDebugInfo?.request?.body]);
  const responseHeadersText = useMemo(
    () => headersToText(effectiveDebugInfo?.response?.headers),
    [effectiveDebugInfo?.response?.headers]
  );
  const responseBodyText = useMemo(() => {
    const text = formatResponseBodyAsText(effectiveDebugInfo?.response?.body).trim();
    return text.length > 0 ? text : '(空响应体)';
  }, [effectiveDebugInfo?.response?.body]);
  const providerEndReason = useMemo<ProviderEndReason | null>(() => {
    const body = effectiveDebugInfo?.response?.body as any;
    if (!body || typeof body !== 'object') return null;

    const candidates: Array<{ raw: any; source: string }> = [
      { raw: body.finish_reason ?? body.finishReason, source: 'body.finish_reason' },
      { raw: body.stop_reason ?? body.stopReason, source: 'body.stop_reason' },
      { raw: body.choices?.[0]?.finish_reason ?? body.choices?.[0]?.finishReason, source: 'choices[0].finish_reason' },
      { raw: body.incomplete_details?.reason ?? body.incompleteDetails?.reason, source: 'incomplete_details.reason' },
    ];

    for (const c of candidates) {
      if (typeof c.raw === 'string' && c.raw.trim().length > 0) {
        return normalizeProviderEndReasonKind(c.raw, c.source);
      }
    }

    return null;
  }, [effectiveDebugInfo?.response?.body]);
  const providerFinishReason = providerEndReason?.raw ?? null;
  const providerFinishReasonZh = providerEndReason?.zh ?? null;
  const providerFinishReasonSource = providerEndReason?.source ?? null;

  const apiErrorInfo = useMemo(
    () => extractApiErrorInfo(effectiveDebugInfo?.response?.body as any, httpStatus),
    [effectiveDebugInfo?.response?.body, httpStatus]
  );
  const streamTerminationInfo = useMemo(
    () => normalizeStreamTerminationInfo(effectiveDebugInfo),
    [effectiveDebugInfo]
  );
  const streamTerminationSummary = useMemo(
    () => summarizeStreamTermination(streamTerminationInfo),
    [streamTerminationInfo]
  );
  const endReasonSummary = useMemo(() => {
    const parts: string[] = [];

    if (finalStatus === 'success') {
      if (providerFinishReasonZh && providerFinishReason) {
        parts.push(`${providerFinishReasonZh}（${providerFinishReason}）`);
      } else if (providerFinishReason) {
        parts.push(`模型结束：${providerFinishReason}`);
      }
    } else if (finalStatus === 'aborted') {
      parts.push('任务中止');
    } else if (finalStatus === 'failed') {
      parts.push('任务失败');
    }

    if (apiErrorInfo?.message) {
      const extra: string[] = [];
      if (apiErrorInfo.type) extra.push(`type=${apiErrorInfo.type}`);
      if (apiErrorInfo.code) extra.push(`code=${apiErrorInfo.code}`);
      parts.push(`API 错误：${apiErrorInfo.message}${extra.length ? `（${extra.join(', ')}）` : ''}`);
    } else if ((finalStatus === 'failed' || finalStatus === 'aborted') && errorMessage) {
      parts.push(errorMessage);
    }

    if (typeof httpStatus === 'number') parts.push(`HTTP ${httpStatus}`);
    if (providerFinishReasonSource && providerFinishReason) parts.push(`来源 ${providerFinishReasonSource}`);
    if (effectiveDebugInfo) parts.push(`协议终止：${streamTerminationSummary.label}`);

    return parts.filter(Boolean).join('；') || null;
  }, [
    finalStatus,
    providerFinishReason,
    providerFinishReasonZh,
    providerFinishReasonSource,
    apiErrorInfo?.message,
    apiErrorInfo?.type,
    apiErrorInfo?.code,
    httpStatus,
    errorMessage,
    effectiveDebugInfo,
    streamTerminationSummary.label,
  ]);

  // Lazy-load per-turn debug info when needed (history initialization strips it by default).
  useEffect(() => {
    if (!isOpen) return;
    if (!conversationId || !messageId) return;
    if (!activeTurnId) return;

    const turn = sortedTurns.find((t) => t.turnId === activeTurnId);
    if (!turn) return;
    if (!turn.hasDebugInfo) return;

    // Already have it (inline or previously loaded)
    if (turn.debugInfo) return;
    if (Object.prototype.hasOwnProperty.call(loadedTurnDebugInfo, activeTurnId)) return;

    let cancelled = false;
    setLoadingTurnId(activeTurnId);
    setLoadError(null);
    setLoadErrorTurnId(null);

    getTurnDebugInfo(conversationId, messageId, activeTurnId)
      .then((di) => {
        if (cancelled) return;
        setLoadedTurnDebugInfo((prev) => ({ ...prev, [activeTurnId]: di }));
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        setLoadErrorTurnId(activeTurnId);
        setLoadedTurnDebugInfo((prev) => ({ ...prev, [activeTurnId]: null }));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingTurnId((prev) => (prev === activeTurnId ? null : prev));
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, conversationId, messageId, activeTurnId, sortedTurns, loadedTurnDebugInfo]);
  const effectiveBlocks = useMemo(() => {
    const allBlocks = blocks ?? [];
    if (allBlocks.length === 0) return [];
    if (!activeTurnId) return allBlocks;

    const byTurn = allBlocks.filter((b) => b.turnId === activeTurnId);
    if (byTurn.length > 0) return byTurn;

    const legacy = allBlocks.filter((b) => !b.turnId);
    return legacy.length > 0 ? legacy : allBlocks;
  }, [blocks, activeTurnId]);

  const thinkingText = useMemo(() => {
    const chunks = effectiveBlocks
      .filter((b): b is Extract<MessageBlock, { type: 'thinking' }> => b.type === 'thinking')
      .map((b) => b.text)
      .filter((t) => typeof t === 'string' && t.trim().length > 0);
    return chunks.length > 0 ? chunks.join('\n\n') : null;
  }, [effectiveBlocks]);

  const toolCalls = useMemo(
    () =>
      effectiveBlocks.filter(
        (b): b is Extract<MessageBlock, { type: 'tool_call' }> => b.type === 'tool_call'
      ),
    [effectiveBlocks]
  );
  const toolResults = useMemo(
    () =>
      effectiveBlocks.filter(
        (b): b is Extract<MessageBlock, { type: 'tool_result' }> => b.type === 'tool_result'
      ),
    [effectiveBlocks]
  );
  const webSearchBlocks = useMemo(
    () =>
      effectiveBlocks.filter(
        (b): b is Extract<MessageBlock, { type: 'web_search' }> => b.type === 'web_search'
      ),
    [effectiveBlocks]
  );

  const pairedToolRuns = useMemo(() => {
    const resultsByCallId = new Map<string, Extract<MessageBlock, { type: 'tool_result' }>>();
    for (const r of toolResults) resultsByCallId.set(r.callId, r);

    const runs = toolCalls.map((call) => ({
      call,
      result: resultsByCallId.get(call.callId) ?? null,
    }));

    const callsById = new Set(toolCalls.map((c) => c.callId));
    const orphanResults = toolResults.filter((r) => !callsById.has(r.callId));

    return { runs, orphanResults };
  }, [toolCalls, toolResults]);

  const responseBodyForDisplay = useMemo(() => {
    const body = effectiveDebugInfo?.response?.body;
    if (!body) return body;
    if (toolResults.length === 0 && toolCalls.length === 0) return body;

    const tool_runs = toolCalls.map((call) => {
      let parsedArgs: unknown = call.arguments;
      try {
        parsedArgs = JSON.parse(call.arguments);
      } catch {
        // keep raw
      }
      return {
        call_id: call.callId,
        name: call.name,
        arguments: parsedArgs,
        result_text: toolResults.find((r) => r.callId === call.callId)?.text ?? null,
      };
    });

    if (typeof body === 'object' && body !== null) {
      // 为避免重复展示，这里只注入 tool_runs，并在展示用响应体里剔除 tool_calls/tool_results。
      //（工具调用/输出已在 DebugModal 的“工具执行”区块成对展示）
      const sanitized = { ...(body as Record<string, unknown>) };
      delete sanitized.tool_calls;
      delete sanitized.tool_results;
      delete sanitized.tool_runs;
      return {
        ...sanitized,
        ...(tool_runs.length > 0 ? { tool_runs } : {}),
      };
    }
    return {
      body,
      ...(tool_runs.length > 0 ? { tool_runs } : {}),
    };
  }, [effectiveDebugInfo?.response?.body, toolResults, toolCalls]);

  const largeViewerJsonData = useMemo(() => {
    if (!largeTextViewer) return null;

    const fromRaw = largeTextViewer.rawJson;
    if (fromRaw !== undefined && fromRaw !== null) {
      const normalized = normalizeJsonLikeStrings(fromRaw);
      if (isRecord(normalized) || Array.isArray(normalized)) {
        return normalized;
      }
    }

    const parsed = maybeParseJsonContainerString(largeTextViewer.text);
    if (parsed !== null) {
      const normalized = normalizeJsonLikeStrings(parsed);
      if (isRecord(normalized) || Array.isArray(normalized)) {
        return normalized;
      }
    }

    return null;
  }, [largeTextViewer]);

  const largeViewerPlainText = useMemo(() => {
    if (!largeTextViewer) return '';
    return normalizeStringForDisplay(largeTextViewer.text);
  }, [largeTextViewer]);

  const largeViewerJsonText = useMemo(() => {
    if (!largeTextViewer) return null;

    const fromRaw = largeTextViewer.rawJson;
    if (fromRaw !== undefined && fromRaw !== null) {
      const normalized = normalizeJsonLikeStrings(fromRaw);
      if (typeof normalized === 'string') {
        return normalizeStringForDisplay(normalized);
      }
      return safeStringify(normalized, 2);
    }

    const parsed = maybeParseJsonContainerString(largeTextViewer.text);
    if (parsed !== null) {
      const normalized = normalizeJsonLikeStrings(parsed);
      if (typeof normalized === 'string') {
        return normalizeStringForDisplay(normalized);
      }
      return safeStringify(normalized, 2);
    }

    return null;
  }, [largeTextViewer]);

  const largeViewerCopyText = useMemo(() => {
    if (largeViewerMode === 'text') return largeViewerPlainText;
    return largeViewerJsonText ?? largeViewerPlainText;
  }, [largeViewerMode, largeViewerPlainText, largeViewerJsonText]);

  const hasTaskSummary =
    Boolean(
      finalTurn ||
        finalStatus ||
        providerFinishReason ||
        typeof httpStatus === 'number' ||
        effectiveDebugInfo?.request ||
        errorMessage ||
        conversationId ||
        messageId
    ) || sortedTurns.length > 1;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div className="pointer-events-auto absolute left-1/2 top-14 -translate-x-1/2 w-full max-w-3xl max-h-[80vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            调试信息 - {messageRole === 'user' ? '请求' : messageRole === 'error' ? '错误' : '响应'}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[calc(80vh-80px)] overflow-hidden">
          {hasTaskSummary && (
            <div className="mb-4">
              <CollapsibleSection title="结束原因与 Turn 导航" defaultExpanded={false}>
                {(finalTurn ||
                  finalStatus ||
                  providerFinishReason ||
                  typeof httpStatus === 'number' ||
                  effectiveDebugInfo?.request ||
                  errorMessage ||
                  conversationId ||
                  messageId) && (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-200">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-600 dark:text-gray-300">结束原因</span>
                        {finalStatus && (
                          <Chip
                            tone={
                              finalStatus === 'success'
                                ? 'green'
                                : finalStatus === 'aborted'
                                  ? 'yellow'
                                  : finalStatus === 'failed'
                                    ? 'red'
                                    : 'gray'
                            }
                          >
                            {finalStatusTitle}
                          </Chip>
                        )}
                        {finalTurn && <Chip tone="gray">最后 Turn {finalTurn.turnIndex}</Chip>}
                        {finalTurn?.model && <Chip tone="purple" title="model">{finalTurn.model}</Chip>}
                        {providerFinishReason && (
                          <Chip
                            tone="gray"
                            title={[providerFinishReasonZh, providerFinishReasonSource].filter(Boolean).join(' | ') || undefined}
                          >
                            finish_reason: {providerFinishReason}
                          </Chip>
                        )}
                        {typeof httpStatus === 'number' && (
                          <Chip tone={httpStatus >= 200 && httpStatus < 300 ? 'green' : 'red'}>
                            HTTP {httpStatus}
                          </Chip>
                        )}
                        {effectiveDebugInfo && (
                          <Chip
                            tone={
                              streamTerminationSummary.tone === 'success'
                                ? 'green'
                                : streamTerminationSummary.tone === 'warn'
                                  ? 'yellow'
                                  : streamTerminationSummary.tone === 'error'
                                    ? 'red'
                                    : 'gray'
                            }
                            title={streamTerminationSummary.detail}
                          >
                            协议终止: {streamTerminationSummary.label}
                          </Chip>
                        )}
                      </div>

                      {effectiveDebugInfo?.request && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-gray-600 dark:text-gray-300">请求</span>
                          {effectiveDebugInfo.request.method && (
                            <Chip tone="blue">{effectiveDebugInfo.request.method}</Chip>
                          )}
                          {requestUrlParts ? (
                            <>
                              <Chip tone="gray" title={requestUrlParts.host}>
                                host: {truncateMiddle(requestUrlParts.host, 24, 12)}
                              </Chip>
                              <Chip tone="gray" title={requestUrlParts.path}>
                                path: {truncateMiddle(requestUrlParts.path, 28, 18)}
                              </Chip>
                            </>
                          ) : effectiveDebugInfo.request.url ? (
                            <Chip tone="gray" title={effectiveDebugInfo.request.url}>
                              url: {truncateMiddle(effectiveDebugInfo.request.url, 26, 22)}
                            </Chip>
                          ) : null}
                        </div>
                      )}
                    </div>
                    {endReasonSummary && (
                      <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-300">
                        {endReasonSummary}
                      </div>
                    )}
                    {effectiveDebugInfo && (
                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                        协议终止详情：{streamTerminationSummary.detail}
                      </div>
                    )}
                    {errorMessage && (
                      <div className="mt-2 rounded bg-red-50 px-2 py-1 text-red-700 dark:bg-red-900/20 dark:text-red-300">
                        {errorMessage}
                      </div>
                    )}
                    {(conversationId || messageId) && (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                        {conversationId && <span>conversationId: {conversationId}</span>}
                        {messageId && <span>messageId: {messageId}</span>}
                        {finalTurn?.turnId && <span>turnId: {finalTurn.turnId}</span>}
                      </div>
                    )}
                  </div>
                )}

                {sortedTurns.length > 1 && (
                  <div className={`${finalTurn || finalStatus || providerFinishReason || typeof httpStatus === 'number' || effectiveDebugInfo?.request || errorMessage || conversationId || messageId ? 'mt-3' : ''}`}>
                    {sortedTurns.length > TURNS_PER_PAGE && (
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          Turn 分页：第 {turnPage + 1}/{turnPageCount} 页（共 {sortedTurns.length}）
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setTurnPage((p) => Math.max(0, p - 1))}
                            disabled={turnPage <= 0}
                            className="inline-flex items-center justify-center rounded border border-gray-200 bg-white p-1 text-gray-600 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
                            title="上一页"
                          >
                            <ChevronLeft size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setTurnPage((p) => Math.min(turnPageCount - 1, p + 1))}
                            disabled={turnPage >= turnPageCount - 1}
                            className="inline-flex items-center justify-center rounded border border-gray-200 bg-white p-1 text-gray-600 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
                            title="下一页"
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-1">
                      {(sortedTurns.length > TURNS_PER_PAGE ? pagedTurns : sortedTurns).map((t) => {
                        const isActive = t.turnId === activeTurnId;
                        const status = t.status || 'success';
                        const statusClass =
                          status === 'success'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                            : status === 'aborted'
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
                        const statusTitle = status === 'success' ? '成功' : status === 'failed' ? '失败' : '中止';

                        return (
                          <button
                            key={t.turnId}
                            onClick={() => setActiveTurnId(t.turnId)}
                            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                              isActive
                                ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:bg-gray-800'
                            }`}
                            title={t.model ? `model: ${t.model}` : undefined}
                          >
                            <span>Turn {t.turnIndex}</span>
                            <span
                              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${statusClass}`}
                              title={statusTitle}
                            >
                              {status === 'success' ? <Check size={12} /> : status === 'failed' ? <X size={12} /> : null}
                              {status === 'aborted' ? <span>aborted</span> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CollapsibleSection>
            </div>
          )}

          {isLoadingDebug && (
            <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
              正在加载调试信息…
            </div>
          )}
          {!isLoadingDebug && loadError && loadErrorTurnId === activeTurnId && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              加载调试信息失败：{loadError}
            </div>
          )}

          <div className="overflow-auto max-h-[calc(80vh-80px-72px)] space-y-4 pr-1">
            {activePage === 'overview' ? (
              <>
                {thinkingText && (
                  <CollapsibleSection title="思考过程" defaultExpanded={defaultExpandedForStreaming}>
                    <TextViewer
                      text={thinkingText}
                      containerClassName="bg-purple-50 dark:bg-purple-900/30 text-purple-800 dark:text-purple-200"
                      maxHeightClassName="max-h-64"
                    />
                  </CollapsibleSection>
                )}

                {!effectiveDebugInfo ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    <p>暂无调试信息</p>
                    <p className="text-sm mt-2">
                      {isLoadingDebug
                        ? '请稍候…'
                        : activeTurn?.hasDebugInfo
                          ? '该轮已标记存在调试信息，但当前未能加载。'
                          : '请确保在发送消息前开启调试模式。'}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        这里把 HTTP 请求/响应按可读文本渲染（headers 已脱敏）。请求体会尽量把 messages 展开成“对话 + 工具调用”格式，便于阅读历史上下文。
                      </div>
                      {httpViewTabs}
                    </div>

                    <div className="space-y-3">
                      {activeHttpView === 'request' ? (
                        effectiveDebugInfo.request ? (
                          <CollapsibleSection title="HTTP 请求（文本）" defaultExpanded>
                            <div className="space-y-4">
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                {effectiveDebugInfo.request.method && (
                                  <Chip tone="blue">{effectiveDebugInfo.request.method}</Chip>
                                )}
                                {requestUrlParts ? (
                                  <>
                                    <Chip tone="gray" title={requestUrlParts.host}>
                                      host: {truncateMiddle(requestUrlParts.host, 26, 14)}
                                    </Chip>
                                    <Chip tone="gray" title={requestUrlParts.path}>
                                      path: {truncateMiddle(requestUrlParts.path, 30, 18)}
                                    </Chip>
                                  </>
                                ) : effectiveDebugInfo.request.url ? (
                                  <Chip tone="gray" title={effectiveDebugInfo.request.url}>
                                    url: {truncateMiddle(effectiveDebugInfo.request.url, 30, 22)}
                                  </Chip>
                                ) : null}
                              </div>

                              <CollapsibleSection title="请求头（文本）" defaultExpanded>
                                <TextViewer
                                  text={requestHeadersText}
                                  maxHeightClassName="max-h-56"
                                  onOpenLarge={() =>
                                    setLargeTextViewer({
                                      title: 'HTTP 请求头（文本）',
                                      text: requestHeadersText,
                                      rawJson: prepareHeadersForJson(effectiveDebugInfo.request?.headers ?? {}),
                                    })
                                  }
                                />
                              </CollapsibleSection>

                              <CollapsibleSection title="请求体（文本）" defaultExpanded>
                                <TextViewer
                                  text={requestBodyText}
                                  maxHeightClassName="max-h-[50vh]"
                                  containerClassName="bg-gray-50 dark:bg-gray-800/40 text-gray-800 dark:text-gray-200"
                                  onOpenLarge={() =>
                                    setLargeTextViewer({
                                      title: 'HTTP 请求体（文本）',
                                      text: requestBodyText,
                                      rawJson: effectiveDebugInfo.request?.body,
                                    })
                                  }
                                />
                              </CollapsibleSection>
                            </div>
                          </CollapsibleSection>
                        ) : (
                          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
                            暂无 HTTP 请求调试信息
                          </div>
                        )
                      ) : effectiveDebugInfo.response ? (
                        <CollapsibleSection title="HTTP 响应（文本）" defaultExpanded>
                          <div className="space-y-4">
                            {typeof effectiveDebugInfo.response.status === 'number' && (
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <Chip
                                  tone={
                                    effectiveDebugInfo.response.status >= 200 &&
                                    effectiveDebugInfo.response.status < 300
                                      ? 'green'
                                      : 'red'
                                  }
                                >
                                  HTTP {effectiveDebugInfo.response.status}
                                </Chip>
                              </div>
                            )}

                            <CollapsibleSection title="响应头（文本）" defaultExpanded>
                              <TextViewer
                                text={responseHeadersText}
                                maxHeightClassName="max-h-56"
                                onOpenLarge={() =>
                                  setLargeTextViewer({
                                    title: 'HTTP 响应头（文本）',
                                    text: responseHeadersText,
                                    rawJson: prepareHeadersForJson(effectiveDebugInfo.response?.headers ?? {}),
                                  })
                                }
                              />
                            </CollapsibleSection>

                            <CollapsibleSection title="响应体（文本）" defaultExpanded>
                              <TextViewer
                                text={responseBodyText}
                                maxHeightClassName="max-h-[50vh]"
                                containerClassName="bg-gray-50 dark:bg-gray-800/40 text-gray-800 dark:text-gray-200"
                                onOpenLarge={() =>
                                  setLargeTextViewer({
                                    title: 'HTTP 响应体（文本）',
                                    text: responseBodyText,
                                    rawJson: responseBodyForDisplay,
                                  })
                                }
                              />
                            </CollapsibleSection>
                          </div>
                        </CollapsibleSection>
                      ) : (
                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
                          暂无 HTTP 响应调试信息
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    这里展示本轮工具调用参数与结果，便于排障与复现。
                  </div>
                  {httpViewTabs}
                </div>
                {toolCalls.length > 0 || toolResults.length > 0 || webSearchBlocks.length > 0 ? (
                  <div className="space-y-3">
                    {pairedToolRuns.runs.map(({ call, result }) => {
                      let prettyArgs: string = call.arguments;
                      try {
                        prettyArgs = JSON.stringify(JSON.parse(call.arguments), null, 2);
                      } catch {
                        // keep raw
                      }

                      return (
                        <div
                          key={call.id}
                          className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/30"
                        >
                          <div className="mb-2 text-xs font-medium text-green-800 dark:text-green-200">
                            {call.name} <span className="opacity-70">({call.callId})</span>
                          </div>

                          <div className="space-y-2">
                            <TextViewer
                              label="参数"
                              text={prettyArgs}
                              maxHeightClassName="max-h-48"
                              containerClassName="bg-white/60 dark:bg-black/20 text-green-900 dark:text-green-100"
                            />

                            <TextViewer
                              label="结果"
                              text={result?.text ?? '(暂无工具结果)'}
                              maxHeightClassName="max-h-64"
                              containerClassName="bg-white/60 dark:bg-black/20 text-gray-900 dark:text-gray-100"
                              renderAnsi={Boolean(result?.text)}
                              ansiRenderMode={ansiRenderMode}
                              ansiColorMode={ansiColorMode}
                            />
                          </div>
                        </div>
                      );
                    })}

                    {pairedToolRuns.orphanResults.length > 0 && (
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/40">
                        <div className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
                          未配对的工具结果
                        </div>
                        <div className="space-y-3">
                          {pairedToolRuns.orphanResults.map((r) => (
                            <div
                              key={r.id}
                              className="rounded border border-gray-200 bg-white/60 p-2 dark:border-gray-700 dark:bg-black/20"
                            >
                              <div className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
                                call_id: <span className="font-mono">{r.callId}</span>
                              </div>
                              <TextViewer
                                text={r.text}
                                maxHeightClassName="max-h-64"
                                renderAnsi
                                ansiRenderMode={ansiRenderMode}
                                ansiColorMode={ansiColorMode}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {webSearchBlocks.map((b) => (
                      <div
                        key={b.id}
                        className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/30"
                      >
                        <div className="mb-2 text-xs font-medium text-blue-800 dark:text-blue-200">
                          web_search <span className="opacity-70">({b.callId})</span>
                        </div>
                        <JsonViewer
                          data={{
                            status: b.status,
                            action: b.action,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
                    暂无工具执行信息
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {largeTextViewer && (
        <div
          className="pointer-events-auto absolute inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
          onClick={() => setLargeTextViewer(null)}
        >
          <div
            className="w-[min(95vw,1200px)] h-[min(92vh,920px)] bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {largeTextViewer.title}
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
                  title="切换查看方式"
                >
                  <button
                    type="button"
                    onClick={() => setLargeViewerMode('text')}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      largeViewerMode === 'text'
                        ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                        : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    纯文本
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!largeViewerJsonText) return;
                      setLargeViewerMode('json');
                    }}
                    disabled={!largeViewerJsonText}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      !largeViewerJsonText
                        ? 'bg-white text-gray-300 dark:bg-gray-900 dark:text-gray-700 cursor-not-allowed'
                        : largeViewerMode === 'json'
                          ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                          : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!largeViewerJsonData) return;
                      setLargeViewerMode('structured');
                    }}
                    disabled={!largeViewerJsonData}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      !largeViewerJsonData
                        ? 'bg-white text-gray-300 dark:bg-gray-900 dark:text-gray-700 cursor-not-allowed'
                        : largeViewerMode === 'structured'
                          ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                          : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    结构
                  </button>
                </div>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                  onClick={() => {
                    void navigator.clipboard.writeText(largeViewerCopyText);
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
                  onClick={() => setLargeTextViewer(null)}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="h-[calc(100%-48px)] p-4 overflow-auto">
              {largeViewerMode === 'structured' && largeViewerJsonData ? (
                <StructuredJsonTextViewer
                  data={largeViewerJsonData}
                  maxHeightClassName="max-h-[calc(92vh-11rem)]"
                  emptyText="(空)"
                />
              ) : largeViewerMode === 'json' && largeViewerJsonText ? (
                <pre className="min-h-full rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs whitespace-pre-wrap break-words text-gray-800 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-200">
                  {largeViewerJsonText}
                </pre>
              ) : (
                <pre className="min-h-full rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs whitespace-pre-wrap break-words text-gray-800 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-200">
                  {largeViewerPlainText}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DebugModal;
