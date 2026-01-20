/**
 * MessageItem Component
 * Renders individual chat messages with proper styling
 * Requirements: 3.1, 3.2, 3.6
 */

import React, { useState } from 'react';
import { User, Bot, Bug, AlertCircle, RefreshCw, ZoomIn } from 'lucide-react';
import type { Message, Action, ContentPart } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageToolbar } from './MessageToolbar';
import { buildMessageActions } from '../../utils/messageActionBuilder';
import { DebugModal } from './DebugModal';
import { useConfigStore } from '../../stores/configStore';
import { getAssistantMessageBlocks } from '../../utils/messageBlocks';
import { MessageBlocks } from './MessageBlocks';

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
}

const ContentPartsRenderer: React.FC<ContentPartsRendererProps> = ({
  contentParts,
  textContent,
  isUser,
}) => {
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // If no content parts, just render text
  if (!contentParts || contentParts.length === 0) {
    if (isUser) {
      return <p className="whitespace-pre-wrap">{textContent}</p>;
    }
    return <MarkdownRenderer content={textContent} />;
  }

  return (
    <>
      {contentParts.map((part, index) => {
        if (part.type === 'text') {
          if (isUser) {
            return (
              <p key={index} className="whitespace-pre-wrap">
                {part.text}
              </p>
            );
          }
          return <MarkdownRenderer key={index} content={part.text} />;
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
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  isStreaming = false,
  onAction,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const { config } = useConfigStore();
  const debugMode = config?.general?.debugMode ?? false;
  const showUsage = config?.general?.showUsage ?? true;

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isError = message.role === 'error';
  const isFailed = message.status === 'failed';
  const isPending = message.status === 'pending';

  // Build actions
  const actions = buildMessageActions(message);

  // 统一以 blocks 作为 assistant 输出渲染入口（未来可扩展 tool/websearch/多模态输出）
  const assistantBlocks = isAssistant ? getAssistantMessageBlocks(message) : [];

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
        <div className="relative max-w-[80%] rounded-2xl px-4 py-2 bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800">
          <div className="text-sm font-medium mb-1">请求失败</div>
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>

          {/* Action buttons for error messages */}
          {(actions.length > 0 || debugMode) && (
            <div
              className={`mt-2 flex flex-wrap gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'
                }`}
            >
              <MessageToolbar actions={actions} onAction={onAction} />
              {/* Debug button for error messages */}
              {debugMode && message.debugInfo && (
                <button
                  onClick={() => setShowDebugModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
                  title="查看原始消息"
                >
                  <Bug size={14} />
                  <span>Raw</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Debug Modal */}
        <DebugModal
          isOpen={showDebugModal}
          onClose={() => setShowDebugModal(false)}
          debugInfo={message.debugInfo || null}
          messageRole="error"
        />
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
        className={`relative max-w-[80%] rounded-2xl px-4 py-2 overflow-hidden ${isUser
          ? isFailed
            ? 'bg-red-500 text-white border-2 border-red-600'
            : isPending
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
            <MessageBlocks blocks={assistantBlocks} />

            {/* Fallback for multimodal output (future) */}
            {message.contentParts && message.contentParts.length > 0 && (
              <div>
                <ContentPartsRenderer
                  contentParts={message.contentParts || []}
                  textContent={message.content}
                  isUser={false}
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
            />
          </div>
        )}

        {/* Failed message error display */}
        {isUser && isFailed && message.error && (
          <div className="mt-2 text-xs bg-red-600/20 rounded px-2 py-1 flex items-center gap-1.5">
            <AlertCircle size={12} />
            <span className="opacity-90">{message.error}</span>
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
        {!isStreaming && (actions.length > 0 || (debugMode && isAssistant)) && (
          <div
            className={`mt-2 flex flex-wrap gap-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'
              }`}
          >
            <MessageToolbar actions={actions} onAction={onAction} />
            {/* Debug button - only for assistant messages and if debugMode is on */}
            {debugMode && isAssistant && message.debugInfo && (
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
      <DebugModal
        isOpen={showDebugModal}
        onClose={() => setShowDebugModal(false)}
        debugInfo={message.debugInfo || null}
        messageRole={isUser ? 'user' : 'assistant'}
      />
    </div>
  );
};

export default MessageItem;

