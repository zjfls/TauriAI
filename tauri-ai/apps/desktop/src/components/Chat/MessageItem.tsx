/**
 * MessageItem Component
 * Renders individual chat messages with proper styling
 * Requirements: 3.1, 3.2, 3.6
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { User, Bot, Bug, AlertCircle, RefreshCw, ZoomIn, X, File as FileIcon, Copy, Check } from 'lucide-react';
import type { Message, Action, ContentPart, MessageBlock, MessageTurn } from '../../types';
import { DeferredMarkdown } from './DeferredMarkdown';
import { MessageToolbar } from './MessageToolbar';
import { buildMessageActions } from '../../utils/messageActionBuilder';
import { DebugModal } from './DebugModal';
import { useConfigStore } from '../../stores/configStore';
import { getAssistantMessageBlocks } from '../../utils/messageBlocks';
import { MessageBlocks } from './MessageBlocks';

const WIDE_VISUAL_FENCE_RE = /```(?:mermaid|plot|mafs|json\\s+mafs)\\b/i;
const AT_PATH_RE = /@(\"[^\"]+\"|[^\s]+)/g;

function hasWideVisualFence(text: string): boolean {
  return WIDE_VISUAL_FENCE_RE.test(text);
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      el.style.top = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
};

function renderUserTextWithPathChips(
  text: string,
  codeSnippetLabels?: Map<string, { label: string; title?: string }>
): React.ReactNode {
  if (!text) return text;

  const nodes: React.ReactNode[] = [];
  let last = 0;
  AT_PATH_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = AT_PATH_RE.exec(text))) {
    const start = match.index;
    const prev = start === 0 ? '' : text[start - 1];
    // Avoid matching emails/identifiers like "a@b"
    if (prev && /[A-Za-z0-9_]/.test(prev)) continue;

    const raw = match[0];
    const end = start + raw.length;
    if (start > last) nodes.push(<span key={`t-${last}`}>{text.slice(last, start)}</span>);

    // Code snippet token: "@{snippet:<uuid>}"
    const token = match[1];
    if (token.startsWith('{snippet:') && token.endsWith('}')) {
      const id = token.slice('{snippet:'.length, -1);
      const info = codeSnippetLabels?.get(id) ?? null;
      if (info) {
        nodes.push(
          <span
            key={`snip-${start}`}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-200 align-baseline"
            title={info.title || info.label}
          >
            <span className="truncate max-w-56">{info.label}</span>
          </span>
        );
      } else {
        nodes.push(
          <span key={`snip-missing-${start}`} className="text-gray-400">
            {raw}
          </span>
        );
      }
      last = end;
      continue;
    }

    let path = match[1];
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
      path = path.slice(1, -1);
    }
    const label = basenameFromPath(path);
    nodes.push(
      <span
        key={`p-${start}`}
        className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-200 align-baseline"
        title={path}
      >
        <FileIcon size={14} className="shrink-0 opacity-80" />
        <span className="truncate max-w-56">{label}</span>
      </span>
    );

    last = end;
  }

  if (last < text.length) nodes.push(<span key={`t-${last}`}>{text.slice(last)}</span>);
  return <>{nodes}</>;
}

/**
 * Image preview modal component
 */
interface ImagePreviewModalProps {
  imageUrl: string;
  isOpen: boolean;
  onClose: () => void;
}

const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ imageUrl, isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;
    document.body.dataset.tauriaiImagePreviewOpen = '1';
    return () => {
      delete document.body.dataset.tauriaiImagePreviewOpen;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-3 -right-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white shadow-lg hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-white/70"
          aria-label="关闭图片预览"
          title="关闭"
        >
          <X size={18} />
        </button>
        <img
          src={imageUrl}
          alt="图片预览"
          className="max-h-[90vh] max-w-[90vw] object-contain"
        />
      </div>
    </div>
  );
};

/**
 * Render content parts (text and images)
 */
interface ContentPartsRendererProps {
  contentParts: ContentPart[];
  textContent: string;
  isUser: boolean;
  conversationId?: string | null;
}

const ContentPartsRenderer: React.FC<ContentPartsRendererProps> = ({
  contentParts,
  textContent,
  isUser,
  conversationId,
}) => {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const closePreviewImage = useCallback(() => setPreviewImage(null), []);
  const codeSnippetLabels = useMemo(() => {
    const map = new Map<string, { label: string; title?: string }>();
    for (const p of contentParts ?? []) {
      if (p.type !== 'code_snippet') continue;
      const titleParts: string[] = [];
      if (p.filePath) titleParts.push(p.filePath);
      if (p.range) {
        titleParts.push(
          `${p.range.startLine}:${p.range.startColumn} - ${p.range.endLine}:${p.range.endColumn}`
        );
      }
      map.set(p.id, { label: p.label, title: titleParts.join('\n') });
    }
    return map;
  }, [contentParts]);

  // If no content parts, just render text
  if (!contentParts || contentParts.length === 0) {
    if (isUser) {
      return <p className="whitespace-pre-wrap">{renderUserTextWithPathChips(textContent)}</p>;
    }
    return <DeferredMarkdown content={textContent} conversationId={conversationId} minDelayMs={220} />;
  }

  return (
    <>
      {contentParts.map((part, index) => {
        if (part.type === 'text') {
          if (isUser) {
            return (
              <p key={index} className="whitespace-pre-wrap">
                {renderUserTextWithPathChips(part.text, codeSnippetLabels)}
              </p>
            );
          }
          return <DeferredMarkdown key={index} content={part.text} conversationId={conversationId} minDelayMs={220} />;
        }
        if (part.type === 'image') {
          return (
            <div key={index} className="my-2 relative group inline-block">
              <img
                src={part.url}
                alt="消息图片"
                className="max-h-64 max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setPreviewImage(part.url)}
              />
              <button
                onClick={() => setPreviewImage(part.url)}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
                title="放大查看"
              >
                <ZoomIn size={16} />
              </button>
            </div>
          );
        }
        if (part.type === 'file_ref') {
          return (
            <div
              key={index}
              className="my-1 inline-flex max-w-full items-center gap-2 rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
              title={part.path}
            >
              <FileIcon size={14} className="shrink-0 opacity-80" />
              <span className="truncate">{part.label || part.path}</span>
            </div>
          );
        }
        return null;
      })}
      <ImagePreviewModal
        imageUrl={previewImage || ''}
        isOpen={!!previewImage}
        onClose={closePreviewImage}
      />
    </>
  );
};

interface MessageItemProps {
  message: Message;
  isStreaming?: boolean;
  streamingBlocks?: MessageBlock[] | null;
  streamingTurns?: MessageTurn[];
  onAction: (action: Action) => void;
  onAbortTool?: (callId: string) => void;
  onRetryTurn?: (assistantMessageId: string, turnId: string) => void;
}

export const MessageItem = React.memo(function MessageItem({
  message,
  isStreaming = false,
  streamingBlocks,
  streamingTurns,
  onAction,
  onAbortTool,
  onRetryTurn,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const { config } = useConfigStore();
  const debugMode = config?.general?.debugMode ?? false;
  const taskEndDebugButton = config?.general?.taskEndDebugButton ?? true;
  const showUsage = config?.general?.showUsage ?? true;
  const hasDebugInfo =
    Boolean(message.debugInfo) ||
    Boolean(message.turns?.some((t) => t.debugInfo || t.hasDebugInfo));
  const trimmedTurnSummary = useMemo(() => {
    const turns = message.turns ?? [];
    let trimmedTurnCount = 0;
    let removedMessagesTotal = 0;
    for (const turn of turns) {
      const trim = turn.contextTrim;
      if (!trim) continue;
      const removed = Math.max(0, trim.removedMessages ?? 0);
      if (removed > 0) {
        trimmedTurnCount += 1;
        removedMessagesTotal += removed;
      }
    }
    if (trimmedTurnCount <= 0) return null;
    return { trimmedTurnCount, removedMessagesTotal };
  }, [message.turns]);
  const hasTrimmedTurns = Boolean(trimmedTurnSummary);

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isError = message.role === 'error';
  const isPending = message.status === 'pending';

  // Build actions
  const actions = useMemo(() => buildMessageActions(message), [message]);

  // 统一以 blocks 作为 assistant 输出渲染入口（未来可扩展 tool/websearch/多模态输出）
  const assistantBlocks = useMemo(
    () => (isAssistant ? getAssistantMessageBlocks(message) : []),
    [isAssistant, message]
  );
  const renderedAssistantBlocks = useMemo(() => {
    if (!isAssistant) return [];
    if (!isStreaming || !streamingBlocks || streamingBlocks.length === 0) {
      return assistantBlocks;
    }

    const byId = new Map<string, MessageBlock>();
    const order: string[] = [];

    for (const b of assistantBlocks) {
      if (!b?.id) continue;
      if (!byId.has(b.id)) order.push(b.id);
      byId.set(b.id, b);
    }

    for (const b of streamingBlocks) {
      if (!b?.id) continue;
      if (!byId.has(b.id)) order.push(b.id);
      byId.set(b.id, b);
    }

    return order
      .map((id) => byId.get(id))
      .filter((b): b is MessageBlock => Boolean(b));
  }, [assistantBlocks, isAssistant, isStreaming, streamingBlocks]);
  const renderedTurns = useMemo(() => {
    const base = message.turns ?? [];
    if (!isAssistant || !isStreaming || !streamingTurns || streamingTurns.length === 0) {
      return base.length > 0 ? base : undefined;
    }

    const byId = new Map<string, MessageTurn>();
    for (const t of base) {
      byId.set(t.turnId, t);
    }
    for (const t of streamingTurns) {
      byId.set(t.turnId, t);
    }
    const merged = Array.from(byId.values()).sort((a, b) => a.turnIndex - b.turnIndex);
    return merged.length > 0 ? merged : undefined;
  }, [isAssistant, isStreaming, message.turns, streamingTurns]);
  const assistantTextFromBlocks = useMemo(() => {
    if (!isAssistant || renderedAssistantBlocks.length === 0) return '';
    return renderedAssistantBlocks
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter((t) => t.trim().length > 0)
      .join('\n\n');
  }, [isAssistant, renderedAssistantBlocks]);
  const initialTurnId = useMemo(() => {
    const turns = renderedTurns ?? [];
    if (turns.length > 0) return turns[turns.length - 1]?.turnId ?? null;
    const ids = renderedAssistantBlocks
      .map((b) => b.turnId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return ids.length > 0 ? ids[ids.length - 1]! : null;
  }, [renderedAssistantBlocks, renderedTurns]);
  const canOpenTaskEndDebug = taskEndDebugButton && (isAssistant || isError);
  const shouldPreferWideBubble =
    hasWideVisualFence(message.content) ||
    renderedAssistantBlocks.some((b) => b.type === 'text' && hasWideVisualFence(b.text));
  const copyPayload = useMemo(() => {
    const copyActionPayload = actions.find((a) => a.action_type === 'copy')?.payload;
    if (typeof copyActionPayload === 'string' && copyActionPayload.trim().length > 0) {
      return copyActionPayload;
    }
    if (typeof message.content === 'string' && message.content.trim().length > 0) {
      return message.content;
    }
    if (assistantTextFromBlocks.trim().length > 0) {
      return assistantTextFromBlocks;
    }
    return '';
  }, [actions, assistantTextFromBlocks, message.content]);
  const canCopyMessage = !isStreaming && copyPayload.trim().length > 0;
  const handleCopyMessage = useCallback(async () => {
    if (!canCopyMessage) return;
    const ok = await copyTextToClipboard(copyPayload);
    if (!ok) return;
    setCopied(true);
  }, [canCopyMessage, copyPayload]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1300);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // 气泡宽度策略：
  // - 默认使用“内容自适应 + 上限”保持对话气泡感
  // - streaming 初期内容很短会导致宽度反复变化；最小宽度由 streaming 容器控制（见 MessageList）
  // - 遇到宽图表/代码块时允许更宽
  const bubbleWidthClass = shouldPreferWideBubble ? 'w-full max-w-[98%]' : 'w-fit max-w-[92%]';

  // Error message styling
  if (isError) {
    return (
      <div
        className="group flex gap-3 py-3 flex-row"
        data-message-id={message.id}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Error Avatar */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
          <AlertCircle size={18} />
        </div>

        {/* Error Content */}
        <div
          className={`relative ${bubbleWidthClass} rounded-2xl pl-4 pr-11 py-2 bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800`}
        >
          {canCopyMessage && (
            <button
              type="button"
              onClick={handleCopyMessage}
              className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md bg-red-100/90 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-200 dark:hover:bg-red-900/70 transition-colors"
              title={copied ? '已复制' : '复制消息'}
              aria-label={copied ? '已复制' : '复制消息'}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          )}
          <div className="text-sm font-medium mb-1">请求失败</div>
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>

          {/* Action buttons for error messages */}
          {(actions.length > 0 || hasDebugInfo || debugMode || canOpenTaskEndDebug) && (
            <div
              className={`mt-2 flex flex-wrap gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'
                }`}
            >
              <MessageToolbar actions={actions} onAction={onAction} />
              {/* Debug button for error messages */}
              {canOpenTaskEndDebug && (
                <button
                  onClick={() => setShowDebugModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
                  title="查看任务结束原因与调试信息"
                >
                  <Bug size={14} />
                  <span>Debug</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Debug Modal */}
        {showDebugModal && (
          <DebugModal
            isOpen
            onClose={() => setShowDebugModal(false)}
            isStreaming={isStreaming}
            debugInfo={message.debugInfo || null}
            turns={message.turns || null}
            blocks={message.blocks || null}
            messageRole="error"
            conversationId={message.conversationId}
            messageId={message.id}
            errorMessage={message.error ?? message.content ?? null}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex gap-3 py-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
      data-message-id={message.id}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isUser
          ? 'bg-blue-500 text-white'
          : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
          }`}
      >
        {isUser ? <User size={18} /> : <Bot size={18} />}
      </div>

      {/* Message Content */}
      <div
        className={`relative ${bubbleWidthClass} rounded-2xl pl-4 pr-11 py-2 overflow-hidden ${isUser
          ? isPending
            ? 'bg-blue-400 text-white'
            : 'bg-blue-500 text-white'
          : 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100'
          }`}
      >
        {canCopyMessage && (
          <button
            type="button"
            onClick={handleCopyMessage}
            className={`absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${isUser
              ? 'bg-white/20 text-white hover:bg-white/30'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              }`}
            title={copied ? '已复制' : '复制消息'}
            aria-label={copied ? '已复制' : '复制消息'}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        {/* Model name label for assistant messages */}
        {isAssistant && (message.meta?.model || message.usage || hasTrimmedTurns) && (
          <div className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            {message.meta?.model}
            {/* Token usage display: input/output/total */}
            {showUsage && message.usage && (
              <span className={message.meta?.model ? 'ml-2' : ''}>
                {message.meta?.model ? '· ' : ''}
                in:{message.usage.promptTokens} out:{message.usage.completionTokens} total:{message.usage.totalTokens}
                {message.usage.reasoningTokens ? ` (${message.usage.reasoningTokens} reasoning)` : ''}
                {message.usage.cachedTokens ? ` (${message.usage.cachedTokens} cached)` : ''}
                {message.usage.cacheCreationInputTokens ? ` (${message.usage.cacheCreationInputTokens} cache write)` : ''}
                {message.usage.cacheReadInputTokens ? ` (${message.usage.cacheReadInputTokens} cache read)` : ''}
              </span>
            )}
            {trimmedTurnSummary ? (
              <span className={message.meta?.model || (showUsage && message.usage) ? 'ml-2' : ''}>
                <span
                  className="inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
                  title={`有 ${trimmedTurnSummary.trimmedTurnCount} 轮发生上下文裁剪${trimmedTurnSummary.removedMessagesTotal > 0 ? `，共移除 ${trimmedTurnSummary.removedMessagesTotal} 条消息` : ''}`}
                >
                  裁剪×{trimmedTurnSummary.trimmedTurnCount}
                  {trimmedTurnSummary.removedMessagesTotal > 0 ? ` / -${trimmedTurnSummary.removedMessagesTotal}条` : ''}
                </span>
              </span>
            ) : null}
          </div>
        )}

        {/* Assistant blocks (extensible output) */}
        {isAssistant && renderedAssistantBlocks.length > 0 ? (
          <div>
            <MessageBlocks
              blocks={renderedAssistantBlocks}
              conversationId={message.conversationId}
              messageSource={isStreaming ? 'live' : message.source}
              turns={renderedTurns}
              onAbortTool={onAbortTool}
              assistantMessageId={message.id}
              onRetryTurn={onRetryTurn}
            />

            {/* Fallback for multimodal output (future) */}
            {message.contentParts && message.contentParts.length > 0 && (
              <div>
                <ContentPartsRenderer
                  contentParts={message.contentParts || []}
                  textContent={message.content}
                  isUser={false}
                  conversationId={message.conversationId}
                />
              </div>
            )}
          </div>
        ) : (
          // Legacy rendering path (user messages & older assistant messages)
          <div className={isUser ? 'text-white' : ''}>
            <ContentPartsRenderer
              contentParts={message.contentParts || []}
              textContent={message.content}
              isUser={isUser}
              conversationId={message.conversationId}
            />
          </div>
        )}

        {/* Pending indicator */}
        {isUser && isPending && (
          <div className="mt-1 flex items-center gap-1.5 text-xs opacity-75">
            <RefreshCw size={12} className="animate-spin" />
            <span>处理中...</span>
          </div>
        )}

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 dark:bg-gray-500" />
        )}

        {/* Action buttons - always rendered for layout stability, visible on hover */}
        {!isStreaming && (actions.length > 0 || (isAssistant && (debugMode || hasDebugInfo))) && (
          <div
            className={`mt-2 flex flex-wrap gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'
              }`}
          >
            <MessageToolbar actions={actions} onAction={onAction} />
            {/* Debug button (task end) - controlled by GeneralSettings.taskEndDebugButton (default on) */}
            {canOpenTaskEndDebug && (
              <button
                onClick={() => setShowDebugModal(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors"
                title="查看任务结束原因与调试信息"
              >
                <Bug size={14} />
                <span>Debug</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Debug Modal */}
      {showDebugModal && (
        <DebugModal
          isOpen
          onClose={() => setShowDebugModal(false)}
          isStreaming={isStreaming}
          debugInfo={message.debugInfo || null}
          turns={renderedTurns || null}
          blocks={isAssistant ? renderedAssistantBlocks : message.blocks || null}
          initialTurnId={initialTurnId}
          messageRole={isUser ? 'user' : 'assistant'}
          conversationId={message.conversationId}
          messageId={message.id}
          errorMessage={message.error ?? null}
        />
      )}
    </div>
  );
});

MessageItem.displayName = 'MessageItem';

export default MessageItem;
