/**
 * ContextUsageIndicator Component
 * Circular progress indicator showing context window usage
 * - Hover: Shows brief context summary
 * - Click: Opens detailed context breakdown modal
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  FileText,
  MessageSquare,
  Wrench,
  Plug,
  BookOpen,
  Sparkles,
  Copy,
  MoreHorizontal,
  Hash,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { ContextMessageGroups, ContextUsageBreakdown, Message } from '../../types';
import { countTokens } from '../../utils/tokenizer';

interface ContextUsageIndicatorProps {
  usage: ContextUsageBreakdown;
  disabled?: boolean;
}

const formatTokens = (tokens: number): string => {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
};

const getUsageColor = (percentage: number): { stroke: string; text: string; bg: string } => {
  if (percentage >= 90) return { stroke: '#ef4444', text: 'text-red-500', bg: 'bg-red-500' };
  if (percentage >= 70) return { stroke: '#f97316', text: 'text-orange-500', bg: 'bg-orange-500' };
  if (percentage >= 50) return { stroke: '#eab308', text: 'text-yellow-500', bg: 'bg-yellow-500' };
  return { stroke: '#22c55e', text: 'text-green-500', bg: 'bg-green-500' };
};

const shortId = (id: string, keep = 8): string => {
  if (!id) return '';
  return id.length <= keep ? id : id.slice(0, keep);
};

const normalizeOneLine = (text: string, maxLen = 120): string => {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
};

const extractTextFromContentParts = (message: Message): string => {
  const parts = message.contentParts ?? [];
  if (!Array.isArray(parts) || parts.length === 0) return '';

  const chunks: string[] = [];
  for (const p of parts as any[]) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      chunks.push(p.text);
      continue;
    }
    if (p.type === 'image' && typeof p.url === 'string') {
      chunks.push(`[image] ${p.url}`);
      continue;
    }
    if (p.type === 'image_url' && typeof p.image_url?.url === 'string') {
      chunks.push(`[image_url] ${p.image_url.url}`);
      continue;
    }
    if (typeof p.type === 'string') {
      chunks.push(`[${p.type}]`);
    }
  }
  return chunks.join('\n');
};

const extractTextFromBlocks = (message: Message): string => {
  const blocks = message.blocks ?? [];
  if (!Array.isArray(blocks) || blocks.length === 0) return '';

  const chunks: string[] = [];
  for (const b of blocks as any[]) {
    if (!b || typeof b !== 'object') continue;
    const t = typeof b.type === 'string' ? b.type : 'unknown';
    const text =
      typeof b.text === 'string'
        ? b.text
        : typeof b.content === 'string'
          ? b.content
          : typeof b.markdown === 'string'
            ? b.markdown
            : null;
    if (text && text.trim()) {
      chunks.push(text);
    } else {
      chunks.push(`[block:${t}]`);
    }
  }
  return chunks.join('\n');
};

const getMessageEffectiveContentText = (message: Message): string => {
  const direct = typeof message.content === 'string' ? message.content : '';
  if (direct.trim()) return direct;

  const fromParts = extractTextFromContentParts(message);
  if (fromParts.trim()) return fromParts;

  const fromBlocks = extractTextFromBlocks(message);
  if (fromBlocks.trim()) return fromBlocks;

  return '';
};

const roleAbbrev = (role: Message['role']): string => {
  switch (role) {
    case 'user':
      return 'U';
    case 'assistant':
      return 'A';
    case 'system':
      return 'S';
    case 'error':
      return 'E';
    default:
      return String(role);
  }
};

const contentPartsSummary = (message: Message): string => {
  const parts = message.contentParts ?? [];
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const counts = new Map<string, number>();
  for (const p of parts as any[]) {
    const t = typeof p?.type === 'string' ? p.type : 'unknown';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const items = Array.from(counts.entries()).map(([k, v]) => `${k}:${v}`);
  return `附件 ${parts.length}${items.length ? `（${items.join(', ')}）` : ''}`;
};

const blocksSummary = (message: Message): string => {
  const blocks = message.blocks ?? [];
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const counts = new Map<string, number>();
  for (const b of blocks as any[]) {
    const t = typeof b?.type === 'string' ? b.type : 'unknown';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const items = Array.from(counts.entries()).map(([k, v]) => `${k}:${v}`);
  return `blocks ${blocks.length}${items.length ? `（${items.join(', ')}）` : ''}`;
};

const buildMessageGroupsText = (usage: ContextUsageBreakdown): string => {
  const groups = usage.messageGroups;
  if (!groups) return '';

  const limit = usage.limit || 0;
  const includeThinking = Boolean(groups.includeThinking);

  const lines: string[] = [];
  lines.push(`消息上限: ${groups.messageLimit}`);
  lines.push(`将发送: ${groups.used.length}  |  被裁剪: ${groups.trimmed.length}  |  失败(不发送): ${groups.failed.length}`);
  lines.push(`包含 thinking/reasoning_content: ${includeThinking ? '是' : '否'}`);
  lines.push(`分母(context window): ${limit || '未知'}`);
  lines.push('');

  const renderList = (title: string, list: Message[], maxShown: number) => {
    lines.push(`${title} (${list.length})`);
    if (list.length === 0) {
      lines.push('- (空)');
      return;
    }

    const shown = list.length <= maxShown ? list : list.slice(list.length - maxShown);
    if (shown.length < list.length) {
      lines.push(`- … 省略 ${list.length - shown.length} 条`);
    }

    for (const m of shown) {
      const status = m.status ?? 'success';
      const partsCount = Array.isArray(m.contentParts) ? m.contentParts.length : 0;
      const blocksCount = Array.isArray(m.blocks) ? m.blocks.length : 0;
      const extra =
        partsCount > 0 || blocksCount > 0 ? ` parts:${partsCount} blocks:${blocksCount}` : '';

      const preview = normalizeOneLine(getMessageEffectiveContentText(m) || '', 160);
      const thinkingText = includeThinking ? m.thinking || '' : '';
      const thinkingPreview =
        includeThinking && thinkingText.trim()
          ? ` | thinking:${normalizeOneLine(thinkingText, 120)}`
          : '';

      lines.push(`- ${roleAbbrev(m.role)}/${status} ${shortId(m.id)}${extra} :: ${preview}${thinkingPreview}`);
    }
  };

  renderList('Used(计入本次请求)', groups.used, groups.messageLimit);
  lines.push('');
  renderList('Trimmed(已裁剪)', groups.trimmed, 20);
  lines.push('');
  renderList('Failed(失败消息)', groups.failed, 20);

  return lines.join('\n');
};

const MessageGroupsViewer: React.FC<{
  groups: ContextMessageGroups;
  contextLimit: number;
}> = ({ groups, contextLimit }) => {
  type TabKey = 'used' | 'trimmed' | 'failed';
  const [tab, setTab] = useState<TabKey>('used');
  const includeThinking = Boolean(groups.includeThinking);
  const [actionMenuForMessageId, setActionMenuForMessageId] = useState<string | null>(null);
  const [tokenEstimates, setTokenEstimates] = useState<
    Record<string, { content: number; thinking: number; total: number; updatedAt: number }>
  >({});

  useEffect(() => {
    if (!actionMenuForMessageId) return;
    const onGlobalPointerDown = () => setActionMenuForMessageId(null);
    window.addEventListener('pointerdown', onGlobalPointerDown);
    return () => window.removeEventListener('pointerdown', onGlobalPointerDown);
  }, [actionMenuForMessageId]);

  const list = useMemo(() => {
    if (tab === 'trimmed') return groups.trimmed ?? [];
    if (tab === 'failed') return groups.failed ?? [];
    return groups.used ?? [];
  }, [groups.failed, groups.trimmed, groups.used, tab]);

  const headerLine = useMemo(() => {
    const limitStr = contextLimit > 0 ? String(contextLimit) : '未知';
    return `消息上限: ${groups.messageLimit}  |  将发送: ${groups.used.length}  |  已裁剪: ${groups.trimmed.length}  |  失败(不发送): ${groups.failed.length}  |  包含 thinking: ${includeThinking ? '是' : '否'}  |  context window: ${limitStr}`;
  }, [contextLimit, groups.failed.length, groups.messageLimit, groups.trimmed.length, groups.used.length, includeThinking]);

  const TabButton: React.FC<{ k: TabKey; label: string }> = ({ k, label }) => {
    const active = tab === k;
    return (
      <button
        type="button"
        onClick={() => setTab(k)}
        className={`rounded px-2 py-1 text-xs transition-colors ${
          active
            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900/40 dark:text-gray-300 dark:hover:bg-gray-800'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap">
        {headerLine}
      </div>

      <div className="flex flex-wrap gap-1">
        <TabButton k="used" label={`将发送 (${groups.used.length})`} />
        <TabButton k="trimmed" label={`已裁剪 (${groups.trimmed.length})`} />
        <TabButton k="failed" label={`失败 (${groups.failed.length})`} />
      </div>

      <div className="max-h-64 overflow-auto space-y-2 pr-1">
        {list.length === 0 ? (
          <div className="rounded border border-gray-200 bg-white p-2 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            （空）
          </div>
        ) : (
          list.map((m, idx) => {
            const status = m.status ?? 'success';
            const partsSummary = contentPartsSummary(m);
            const blocksInfo = blocksSummary(m);
            const content = getMessageEffectiveContentText(m);
            const thinking = includeThinking ? (m.thinking ?? '') : '';
            const hasParts = Array.isArray(m.contentParts) && m.contentParts.length > 0;
            const hasBlocks = Array.isArray(m.blocks) && m.blocks.length > 0;
            const estimate = tokenEstimates[m.id];
            const estimateTitle = estimate
              ? `估算 token: content ${estimate.content} + thinking ${estimate.thinking} = ${estimate.total}`
              : undefined;
            const copyPayload =
              includeThinking && thinking.trim()
                ? `${content}\n\n[thinking]\n${thinking}`
                : content;

            return (
              <details
                key={`${m.id}:${idx}`}
                className="rounded border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800"
              >
                <summary className="list-none cursor-pointer select-none">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-gray-800 dark:text-gray-100">
                        {idx + 1}. {roleAbbrev(m.role)}/{status} {shortId(m.id)}
                        {estimate ? (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-normal text-gray-600 dark:bg-gray-900/40 dark:text-gray-300"
                            title={estimateTitle}
                          >
                            <Hash size={12} />
                            ≈{estimate.total}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 truncate">
                        {normalizeOneLine(content, 120) || '（空内容）'}
                        {partsSummary ? `  ·  ${partsSummary}` : ''}
                        {blocksInfo ? `  ·  ${blocksInfo}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <div
                        className="relative"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setActionMenuForMessageId((prev) => (prev === m.id ? null : m.id));
                          }}
                          title="更多操作"
                          aria-label="更多操作"
                        >
                          <MoreHorizontal size={14} />
                        </button>

                        {actionMenuForMessageId === m.id ? (
                          <div
                            className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
                            onPointerDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                          >
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void navigator.clipboard.writeText(copyPayload);
                                setActionMenuForMessageId(null);
                              }}
                              title="复制（含 thinking）"
                            >
                              <Copy size={14} />
                              复制
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void navigator.clipboard.writeText(JSON.stringify(m, null, 2));
                                setActionMenuForMessageId(null);
                              }}
                              title="复制原始 JSON（真实发送前的消息对象）"
                            >
                              <Copy size={14} />
                              JSON
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const contentTokens = countTokens(content || '');
                                const thinkingTokens =
                                  includeThinking && thinking.trim() ? countTokens(thinking) : 0;
                                const total = contentTokens + thinkingTokens;
                                setTokenEstimates((prev) => ({
                                  ...prev,
                                  [m.id]: {
                                    content: contentTokens,
                                    thinking: thinkingTokens,
                                    total,
                                    updatedAt: Date.now(),
                                  },
                                }));
                                setActionMenuForMessageId(null);
                              }}
                              title="估算 token（使用本地 tokenizer）"
                            >
                              <Hash size={14} />
                              估算 token
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </summary>

                <div className="mt-2 space-y-2">
                  {estimate ? (
                    <div className="text-[11px] text-gray-500 dark:text-gray-400" title={estimateTitle}>
                      估算 token：content {estimate.content} + thinking {estimate.thinking} = {estimate.total}
                    </div>
                  ) : null}
                  <div className="rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                    <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">content</div>
                    <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words">{content || '（空）'}</pre>
                  </div>
                  {includeThinking && thinking.trim() ? (
                    <div className="rounded bg-purple-50 p-2 text-xs text-purple-900 dark:bg-purple-900/20 dark:text-purple-100">
                      <div className="mb-1 text-[11px] text-purple-700 dark:text-purple-200">thinking</div>
                      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words">{thinking}</pre>
                    </div>
                  ) : null}
                  {hasParts ? (
                    <div className="rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                      <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">contentParts</div>
                      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words">
                        {JSON.stringify(m.contentParts, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {hasBlocks ? (
                    <div className="rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                      <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">blocks</div>
                      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words">
                        {JSON.stringify(m.blocks, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {partsSummary ? (
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">{partsSummary}</div>
                  ) : null}
                </div>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
};

interface CircularProgressProps {
  percentage: number;
  size?: number;
  strokeWidth?: number;
}

const CircularProgress: React.FC<CircularProgressProps> = ({ percentage, size = 24, strokeWidth = 3 }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;
  const color = getUsageColor(percentage);

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-gray-200 dark:text-gray-700"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color.stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-300"
      />
    </svg>
  );
};

const TooltipContent: React.FC<{ usage: ContextUsageBreakdown }> = ({ usage }) => {
  const limitKnown = usage.limit > 0;
  const color = limitKnown
    ? getUsageColor(usage.percentage)
    : { stroke: '#9ca3af', text: 'text-gray-500', bg: 'bg-gray-400' };
  const actual = usage.actualUsage;

  return (
    <div className="min-w-[180px] p-2 text-xs">
      <div className="mb-1 font-medium">Context 使用量</div>
      <div className={`text-lg font-bold ${color.text}`}>{limitKnown ? `${usage.percentage.toFixed(1)}%` : '—'}</div>
      <div className="mt-1 text-gray-500 dark:text-gray-400">
        {formatTokens(usage.total)} / {limitKnown ? formatTokens(usage.limit) : '未知'} tokens
      </div>
      {actual ? (
        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          实际 in:{formatTokens(actual.promptTokens)} out:{formatTokens(actual.completionTokens)} total:{formatTokens(
            actual.totalTokens
          )}
        </div>
      ) : null}
    </div>
  );
};

interface DetailModalProps {
  usage: ContextUsageBreakdown;
  isOpen: boolean;
  onClose: () => void;
}

const DetailModal: React.FC<DetailModalProps> = ({ usage, isOpen, onClose }) => {
  const limitKnown = usage.limit > 0;
  const actual = usage.actualUsage;
  const actualPromptTokens = actual?.promptTokens;
  const actualCompletionTokens = actual?.completionTokens;
  const actualTotalTokens = actual?.totalTokens;

  const actualPromptPct =
    limitKnown && typeof actualPromptTokens === 'number' ? (actualPromptTokens / usage.limit) * 100 : null;
  const estimatedPromptTokens = usage.total;
  const estimatedPromptPct = usage.percentage;

  const displayPct = limitKnown ? (actualPromptPct ?? estimatedPromptPct) : 0;
  const color = limitKnown
    ? getUsageColor(displayPct)
    : { stroke: '#9ca3af', text: 'text-gray-500', bg: 'bg-gray-400' };

  type Detail = { key: string; label: string; text: string; tokens: number; percent: number };
  type Item = {
    key: string;
    icon: React.ReactNode;
    label: string;
    tokens: number;
    percent: number;
    getDetails?: () => Detail[];
  };

  const breakdownItems = useMemo(() => {
    const limit = usage.limit || 0;
    const pct = (tokens: number) => (limit > 0 ? (tokens / limit) * 100 : 0);

    const items: Item[] = [];

    items.push({
      key: 'system',
      icon: <FileText size={14} />,
      label: '系统提示词',
      tokens: usage.systemPrompt,
      percent: pct(usage.systemPrompt),
      getDetails: usage.systemPromptText
        ? () => {
            const t = countTokens(usage.systemPromptText || '');
            return [
              {
                key: 'system-text',
                label: '系统提示词（文本）',
                text: usage.systemPromptText || '',
                tokens: t,
                percent: pct(t),
              },
            ];
          }
        : undefined,
    });

    items.push({
      key: 'format',
      icon: <BookOpen size={14} />,
      label: '格式提示词',
      tokens: usage.formatPrompt || 0,
      percent: pct(usage.formatPrompt || 0),
      getDetails: usage.formatPromptText
        ? () => {
            const t = countTokens(usage.formatPromptText || '');
            return [
              {
                key: 'format-text',
                label: '格式提示词（文本）',
                text: usage.formatPromptText || '',
                tokens: t,
                percent: pct(t),
              },
            ];
          }
        : undefined,
    });

    items.push({
      key: 'skills',
      icon: <Sparkles size={14} />,
      label: 'Skills',
      tokens: usage.skills || 0,
      percent: pct(usage.skills || 0),
      getDetails:
        usage.skillsSectionText || usage.skillsInjectedText
          ? () => {
              const details: Detail[] = [];
              if (usage.skillsSectionText) {
                const t = countTokens(usage.skillsSectionText);
                details.push({
                  key: 'skills-section',
                  label: 'Skills 列表说明',
                  text: usage.skillsSectionText,
                  tokens: t,
                  percent: pct(t),
                });
              }
              if (usage.skillsInjectedText) {
                const t = countTokens(usage.skillsInjectedText);
                details.push({
                  key: 'skills-injected',
                  label: 'Skills 注入内容',
                  text: usage.skillsInjectedText,
                  tokens: t,
                  percent: pct(t),
                });
              }
              return details;
            }
          : undefined,
    });

    items.push({
      key: 'messages',
      icon: <MessageSquare size={14} />,
      label: '对话消息',
      tokens: usage.messages,
      percent: pct(usage.messages),
      getDetails: usage.messageGroups
        ? () => [
            {
              key: 'messages-list',
              label: '对话消息（将发送 / 已裁剪 / 失败）',
              text: buildMessageGroupsText(usage),
              tokens: usage.messages,
              percent: pct(usage.messages),
            },
          ]
        : undefined,
    });

    items.push({
      key: 'tools',
      icon: <Wrench size={14} />,
      label: '工具定义',
      tokens: usage.tools || 0,
      percent: pct(usage.tools || 0),
    });

    items.push({
      key: 'mcp',
      icon: <Plug size={14} />,
      label: 'MCP 上下文',
      tokens: usage.mcp || 0,
      percent: pct(usage.mcp || 0),
      getDetails: usage.mcpPromptText
        ? () => {
            const t = countTokens(usage.mcpPromptText || '');
            return [
              {
                key: 'mcp-text',
                label: 'MCP 提示词（资源工具）',
                text: usage.mcpPromptText || '',
                tokens: t,
                percent: pct(t),
              },
            ];
          }
        : undefined,
    });

    return items.filter((item) => item.key === 'skills' || item.tokens > 0 || Boolean(item.getDetails));
  }, [usage]);

  const BreakdownRow: React.FC<{ item: Item }> = ({ item }) => {
    const [open, setOpen] = useState(false);
    const details = useMemo(() => {
      if (!open || !item.getDetails) return [];
      return item.getDetails();
    }, [open, item.getDetails]);

    const header = (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
          {item.icon}
          <span>{item.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{formatTokens(item.tokens)}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{item.percent.toFixed(1)}%</div>
          </div>
          {item.getDetails && (
            <span className="text-gray-400 dark:text-gray-500">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
          )}
        </div>
      </div>
    );

    if (!item.getDetails) {
      return (
        <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/30">
          {header}
        </div>
      );
    }

    return (
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="rounded-lg border border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/30"
      >
        <summary className="list-none cursor-pointer select-none px-3 py-2">{header}</summary>
        {open && (
          <div className="px-3 pb-3 space-y-2">
            {details.map((detail) => (
              <div
                key={detail.key}
                className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-200">{detail.label}</div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {formatTokens(detail.tokens)} ({detail.percent.toFixed(1)}%)
                    </div>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                      onClick={() => navigator.clipboard.writeText(detail.text)}
                      title="复制文本"
                    >
                      <Copy size={14} />
                      复制
                    </button>
                  </div>
                </div>
                {detail.key === 'messages-list' && usage.messageGroups ? (
                  <div className="mt-2">
                    <MessageGroupsViewer groups={usage.messageGroups} contextLimit={usage.limit || 0} />
                  </div>
                ) : (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                    {detail.text}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </details>
    );
  };

  if (!isOpen) return null;

  return (
	    <>
	      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
	      <div className="absolute bottom-full right-0 mb-2 z-50 w-96 max-h-[70vh] overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
	        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
	          <h3 className="font-medium text-gray-900 dark:text-gray-100">Context 详情</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <X size={16} />
          </button>
        </div>

	        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
	          <div className="flex items-center justify-between mb-2">
	            <span className="text-sm text-gray-600 dark:text-gray-400">总使用量（prompt）</span>
	            <div className="text-right">
	              <div className={`text-lg font-bold ${color.text}`}>
	                {limitKnown ? `${displayPct.toFixed(1)}%` : '—'}
	              </div>
	              {actualPromptPct !== null ? (
	                <div className="text-[11px] text-gray-500 dark:text-gray-400">
	                  估算 {estimatedPromptPct.toFixed(1)}%
	                </div>
	              ) : null}
	            </div>
	          </div>
	          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
	            <div
	              className={`h-full rounded-full transition-all duration-300 ${color.bg}`}
	              style={{ width: `${limitKnown ? Math.min(displayPct, 100) : 0}%` }}
	            />
	          </div>
	          <div className="mt-1 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
	            {actual ? (
	              <div>
	                实际 in:{formatTokens(actualPromptTokens ?? 0)} out:{formatTokens(actualCompletionTokens ?? 0)} total:
	                {formatTokens(actualTotalTokens ?? (actualPromptTokens ?? 0) + (actualCompletionTokens ?? 0))}
	              </div>
	            ) : (
	              <div>实际：暂无（服务端未返回 usage）</div>
	            )}
	            <div>
	              估算 prompt：{formatTokens(estimatedPromptTokens)}（用于“使用明细”分项）
	              {actual && typeof actualPromptTokens === 'number'
	                ? `｜差值 ${formatTokens(estimatedPromptTokens - actualPromptTokens)}`
	                : ''}
	            </div>
	            <div>{limitKnown ? `${formatTokens(usage.limit)} 上限` : '上限未知'}</div>
	          </div>
	        </div>

        <div className="px-4 py-3">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">使用明细</div>
          <div className="space-y-2">
            {breakdownItems.map((item) => (
              <BreakdownRow key={item.key} item={item} />
            ))}
          </div>
        </div>

        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900/50 rounded-b-lg">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            当 context 接近上限时，较早的消息可能会被截断
          </p>
        </div>
      </div>
    </>
  );
};

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({ usage, disabled = false }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const limitKnown = usage.limit > 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setShowModal(true)}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        disabled={disabled}
        className={`relative flex items-center justify-center w-7 h-7 rounded-md border transition-colors ${
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700'
        } bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-700`}
        title="Context 使用量"
        aria-label="查看 Context 使用量"
      >
        <CircularProgress percentage={limitKnown ? usage.percentage : 0} size={18} strokeWidth={2.5} />
      </button>

      {showTooltip && !showModal && (
        <div className="absolute bottom-full right-0 mb-2 z-30 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <TooltipContent usage={usage} />
        </div>
      )}

      <DetailModal usage={usage} isOpen={showModal} onClose={() => setShowModal(false)} />
    </div>
  );
};

export default ContextUsageIndicator;
