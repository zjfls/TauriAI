/**
 * MessageItem Component
 * Renders individual chat messages with proper styling
 * Requirements: 3.1, 3.2, 3.6
 */

import React, { useState } from 'react';
import { User, Bot, Bug, AlertCircle, RefreshCw, ZoomIn, File as FileIcon } from 'lucide-react';
import type { Message, Action, ContentPart } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';
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

function renderUserTextWithPathChips(text: string): React.ReactNode {
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
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <img
        src={imageUrl}
        alt="图片预览"
        className="max-h-[90vh] max-w-[90vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
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

  // If no content parts, just render text
  if (!contentParts || contentParts.length === 0) {
    if (isUser) {
      return <p className="whitespace-pre-wrap">{renderUserTextWithPathChips(textContent)}</p>;
    }
    return <MarkdownRenderer content={textContent} conversationId={conversationId} />;
  }

  return (
    <>
      {contentParts.map((part, index) => {
        if (part.type === 'text') {
          if (isUser) {
            return (
              <p key={index} className="whitespace-pre-wrap">
                {renderUserTextWithPathChips(part.text)}
              </p>
            );
          }
          return <MarkdownRenderer key={index} content={part.text} conversationId={conversationId} />;
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
        onClose={() => setPreviewImage(null)}
      />
    </>
  );
};

interface MessageItemProps {
  message: Message;
  isStreaming?: boolean;
  onAction: (action: Action) => void;
  onAbortTool?: (callId: string) => void;
  onRetryTurn?: (assistantMessageId: string, turnId: string) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isStreaming = false,
  onAction,
  onAbortTool,
  onRetryTurn,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const { config } = useConfigStore();
  const debugMode = config?.general?.debugMode ?? false;
  const showUsage = config?.general?.showUsage ?? true;
  const hasDebugInfo =
    Boolean(message.debugInfo) ||
    Boolean(message.turns?.some((t) => t.debugInfo || t.hasDebugInfo));

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isError = message.role === 'error';
  const isPending = message.status === 'pending';

  // Build actions
  const actions = buildMessageActions(message);

  // 统一以 blocks 作为 assistant 输出渲染入口（未来可扩展 tool/websearch/多模态输出）
  const assistantBlocks = isAssistant ? getAssistantMessageBlocks(message) : [];
  const shouldPreferWideBubble =
    hasWideVisualFence(message.content) ||
    assistantBlocks.some((b) => b.type === 'text' && hasWideVisualFence(b.text));
  const bubbleWidthClass = shouldPreferWideBubble ? 'w-full max-w-[92%]' : 'max-w-[80%]';
  const minBubbleWidthClass = isAssistant ? 'min-w-[min(420px,100%)]' : '';

  // Error message styling
  if (isError) {
    return (
      <div
        className="group flex gap-3 px-4 py-3 flex-row"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Error Avatar */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
          <AlertCircle size={18} />
        </div>

        {/* Error Content */}
        <div
          className={`relative ${bubbleWidthClass} rounded-2xl px-4 py-2 bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800`}
        >
          <div className="text-sm font-medium mb-1">请求失败</div>
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>

          {/* Action buttons for error messages */}
          {(actions.length > 0 || hasDebugInfo || debugMode) && (
            <div
              className={`mt-2 flex flex-wrap gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'
                }`}
            >
              <MessageToolbar actions={actions} onAction={onAction} />
              {/* Debug button for error messages */}
              {hasDebugInfo && (
                <button
                  onClick={() => setShowDebugModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
                  title="查看调试信息"
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
            debugInfo={message.debugInfo || null}
            turns={message.turns || null}
            blocks={message.blocks || null}
            messageRole="error"
            conversationId={message.conversationId}
            messageId={message.id}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex gap-3 px-4 py-3 ${isUser ? 'flex-row-reverse' : 'flex-row'
        }`}
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
        className={`relative ${bubbleWidthClass} ${minBubbleWidthClass} rounded-2xl px-4 py-2 overflow-hidden ${isUser
          ? isPending
            ? 'bg-blue-400 text-white'
            : 'bg-blue-500 text-white'
          : 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100'
          }`}
      >
        {/* Model name label for assistant messages */}
        {isAssistant && (message.meta?.model || message.usage) && (
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
          </div>
        )}

        {/* Assistant blocks (extensible output) */}
        {isAssistant && assistantBlocks.length > 0 ? (
          <div>
            <MessageBlocks
              blocks={assistantBlocks}
              conversationId={message.conversationId}
              turns={message.turns}
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
            {/* Debug button - only for assistant messages and if debugMode is on */}
            {/* 多 Turn 的调试入口在 MessageBlocks 的「第 N 轮」旁边；这里仅兜底 legacy 消息 */}
            {isAssistant && assistantBlocks.every((b) => !b.turnId) && hasDebugInfo && (
              <button
                onClick={() => setShowDebugModal(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors"
                title="查看 HTTP 调试信息"
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
          debugInfo={message.debugInfo || null}
          turns={message.turns || null}
          blocks={isAssistant ? assistantBlocks : message.blocks || null}
          messageRole={isUser ? 'user' : 'assistant'}
          conversationId={message.conversationId}
          messageId={message.id}
        />
      )}
    </div>
  );
};

export default MessageItem;
