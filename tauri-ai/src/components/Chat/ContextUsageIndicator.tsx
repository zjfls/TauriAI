/**
 * ContextUsageIndicator Component
 * Circular progress indicator showing context window usage
 * - Hover: Shows brief context summary
 * - Click: Opens detailed context breakdown modal
 */

import React, { useMemo, useState } from 'react';
import { X, FileText, MessageSquare, Wrench, Plug, BookOpen, Sparkles, Copy } from 'lucide-react';
import type { ContextUsageBreakdown } from '../../types';
import { countTokens } from '../../utils/tokenizer';

interface ContextUsageIndicatorProps {
  usage: ContextUsageBreakdown;
  disabled?: boolean;
}

/**
 * Format token count for display (e.g., 1234 -> "1.2K", 123456 -> "123K")
 */
const formatTokens = (tokens: number): string => {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
};

/**
 * Get color based on usage percentage
 */
const getUsageColor = (percentage: number): { stroke: string; text: string; bg: string } => {
  if (percentage >= 90) {
    return { stroke: '#ef4444', text: 'text-red-500', bg: 'bg-red-500' }; // Red - critical
  }
  if (percentage >= 70) {
    return { stroke: '#f97316', text: 'text-orange-500', bg: 'bg-orange-500' }; // Orange - warning
  }
  if (percentage >= 50) {
    return { stroke: '#eab308', text: 'text-yellow-500', bg: 'bg-yellow-500' }; // Yellow - moderate
  }
  return { stroke: '#22c55e', text: 'text-green-500', bg: 'bg-green-500' }; // Green - healthy
};

/**
 * Circular progress ring component
 */
interface CircularProgressProps {
  percentage: number;
  size?: number;
  strokeWidth?: number;
}

const CircularProgress: React.FC<CircularProgressProps> = ({
  percentage,
  size = 24,
  strokeWidth = 3,
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;
  const color = getUsageColor(percentage);

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-gray-200 dark:text-gray-700"
      />
      {/* Progress circle */}
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

/**
 * Tooltip content for hover state
 */
interface TooltipContentProps {
  usage: ContextUsageBreakdown;
}

const TooltipContent: React.FC<TooltipContentProps> = ({ usage }) => {
  const limitKnown = usage.limit > 0;
  const color = limitKnown
    ? getUsageColor(usage.percentage)
    : { stroke: '#9ca3af', text: 'text-gray-500', bg: 'bg-gray-400' };
  
  return (
    <div className="min-w-[180px] p-2 text-xs">
      <div className="font-medium mb-1">Context 使用量</div>
      <div className={`text-lg font-bold ${color.text}`}>
        {limitKnown ? `${usage.percentage.toFixed(1)}%` : '—'}
      </div>
      <div className="text-gray-500 dark:text-gray-400 mt-1">
        {formatTokens(usage.total)} / {limitKnown ? formatTokens(usage.limit) : '未知'} tokens
      </div>
    </div>
  );
};

/**
 * Detail modal for click state
 */
interface DetailModalProps {
  usage: ContextUsageBreakdown;
  isOpen: boolean;
  onClose: () => void;
}

const DetailModal: React.FC<DetailModalProps> = ({ usage, isOpen, onClose }) => {
  if (!isOpen) return null;

  const limitKnown = usage.limit > 0;
  const color = limitKnown
    ? getUsageColor(usage.percentage)
    : { stroke: '#9ca3af', text: 'text-gray-500', bg: 'bg-gray-400' };

  const breakdownItems = useMemo(() => {
    const limit = usage.limit || 0;
    const pct = (tokens: number) => (limit > 0 ? (tokens / limit) * 100 : 0);

    type Detail = { key: string; label: string; text: string; tokens: number; percent: number };
    type Item = {
      key: string;
      icon: React.ReactNode;
      label: string;
      tokens: number;
      percent: number;
      details?: Detail[];
    };

    const items: Item[] = [];

    const systemTokens = usage.systemPrompt;
    items.push({
      key: 'system',
      icon: <FileText size={14} />,
      label: '系统提示词',
      tokens: systemTokens,
      percent: pct(systemTokens),
      details: usage.systemPromptText
        ? [
            {
              key: 'system-text',
              label: '系统提示词（文本）',
              text: usage.systemPromptText,
              tokens: systemTokens,
              percent: pct(systemTokens),
            },
          ]
        : undefined,
    });

    const formatPromptTokens = usage.formatPrompt || 0;
    items.push({
      key: 'format',
      icon: <BookOpen size={14} />,
      label: '格式提示词',
      tokens: formatPromptTokens,
      percent: pct(formatPromptTokens),
      details: usage.formatPromptText
        ? (() => {
            const t = formatPromptTokens || countTokens(usage.formatPromptText);
            return [
              {
                key: 'format-text',
                label: '格式提示词（文本）',
                text: usage.formatPromptText,
                tokens: t,
                percent: pct(t),
              },
            ];
          })()
        : undefined,
    });

    const skillsTokens = usage.skills || 0;
    const skillsDetails: Detail[] = [];
    if (usage.skillsSectionText) {
      const t = countTokens(usage.skillsSectionText);
      skillsDetails.push({ key: 'skills-section', label: 'Skills 列表说明', text: usage.skillsSectionText, tokens: t, percent: pct(t) });
    }
    if (usage.skillsInjectedText) {
      const t = countTokens(usage.skillsInjectedText);
      skillsDetails.push({ key: 'skills-injected', label: 'Skills 注入内容', text: usage.skillsInjectedText, tokens: t, percent: pct(t) });
    }
    items.push({
      key: 'skills',
      icon: <Sparkles size={14} />,
      label: 'Skills',
      tokens: skillsTokens,
      percent: pct(skillsTokens),
      details: skillsDetails.length ? skillsDetails : undefined,
    });

    const messagesTokens = usage.messages;
    items.push({
      key: 'messages',
      icon: <MessageSquare size={14} />,
      label: '对话消息',
      tokens: messagesTokens,
      percent: pct(messagesTokens),
    });

    const toolsTokens = usage.tools || 0;
    items.push({
      key: 'tools',
      icon: <Wrench size={14} />,
      label: '工具定义',
      tokens: toolsTokens,
      percent: pct(toolsTokens),
    });

    const mcpTokens = usage.mcp || 0;
    items.push({
      key: 'mcp',
      icon: <Plug size={14} />,
      label: 'MCP 上下文',
      tokens: mcpTokens,
      percent: pct(mcpTokens),
      details: usage.mcpPromptText
        ? (() => {
            const t = mcpTokens || countTokens(usage.mcpPromptText);
            return [
              {
                key: 'mcp-text',
                label: 'MCP 提示词（资源工具）',
                text: usage.mcpPromptText,
                tokens: t,
                percent: pct(t),
              },
            ];
          })()
        : undefined,
    });

    return items.filter(
      (item) => item.key === 'skills' || item.tokens > 0 || (item.details && item.details.length > 0)
    );
  }, [usage]);

  return (
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />
      {/* Modal */}
      <div className="absolute bottom-full right-0 mb-2 z-50 w-96 max-h-[70vh] overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h3 className="font-medium text-gray-900 dark:text-gray-100">Context 详情</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <X size={16} />
          </button>
        </div>

        {/* Progress overview */}
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">总使用量</span>
            <span className={`text-lg font-bold ${color.text}`}>
              {limitKnown ? `${usage.percentage.toFixed(1)}%` : '—'}
            </span>
          </div>
          {/* Progress bar */}
          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${color.bg}`}
              style={{ width: `${limitKnown ? Math.min(usage.percentage, 100) : 0}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-xs text-gray-500 dark:text-gray-400">
            <span>{formatTokens(usage.total)} tokens</span>
            <span>{limitKnown ? `${formatTokens(usage.limit)} 上限` : '上限未知'}</span>
          </div>
        </div>

        {/* Breakdown */}
        <div className="px-4 py-3">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            使用明细
          </div>
          <div className="space-y-2">
            {breakdownItems.map((item) => {
              const header = (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                    {item.icon}
                    <span>{item.label}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {formatTokens(item.tokens)}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {item.percent.toFixed(1)}%
                    </div>
                  </div>
                </div>
              );

              if (!item.details?.length) {
                return (
                  <div
                    key={item.key}
                    className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/30"
                  >
                    {header}
                  </div>
                );
              }

              return (
                <details
                  key={item.key}
                  className="rounded-lg border border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/30"
                >
                  <summary className="list-none cursor-pointer select-none px-3 py-2">
                    {header}
                  </summary>
                  <div className="px-3 pb-3 space-y-2">
                    {item.details.map((detail) => (
                      <div
                        key={detail.key}
                        className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-medium text-gray-700 dark:text-gray-200">
                            {detail.label}
                          </div>
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
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900/40 dark:text-gray-100">
                          {detail.text}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900/50 rounded-b-lg">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            当 context 接近上限时，较早的消息可能会被截断
          </p>
        </div>
      </div>
    </>
  );
};

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  usage,
  disabled = false,
}) => {
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
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700'
        } bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-700`}
        title="Context 使用量"
        aria-label="查看 Context 使用量"
      >
        <CircularProgress percentage={limitKnown ? usage.percentage : 0} size={18} strokeWidth={2.5} />
      </button>

      {/* Tooltip on hover */}
      {showTooltip && !showModal && (
        <div className="absolute bottom-full right-0 mb-2 z-30 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <TooltipContent usage={usage} />
        </div>
      )}

      {/* Detail modal on click */}
      <DetailModal
        usage={usage}
        isOpen={showModal}
        onClose={() => setShowModal(false)}
      />
    </div>
  );
};

export default ContextUsageIndicator;
