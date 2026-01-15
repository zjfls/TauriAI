/**
 * InputArea Component
 * Responsive input area with auto-expanding textarea and send functionality
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Brain } from 'lucide-react';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import type { ContextUsageBreakdown } from '../../types';

// Constants for textarea sizing
const MIN_TEXTAREA_HEIGHT = 40; // Minimum height in pixels
const MAX_TEXTAREA_HEIGHT = 200; // Maximum height in pixels (Requirement 4.1)

interface InputAreaProps {
  onSend: (content: string, enableThinking?: boolean) => void;
  onAbort?: () => void;
  disabled: boolean;
  isGenerating: boolean;
  supportsThinking?: boolean;  // Whether current model supports thinking
  contextUsage?: ContextUsageBreakdown | null;  // Context usage for indicator
}

/**
 * Check if input is empty or whitespace-only
 * Requirement 4.6: Disable send for empty/whitespace input
 */
export const isWhitespaceOnly = (text: string): boolean => {
  return text.trim().length === 0;
};

/**
 * Calculate textarea height based on content
 * Requirement 4.1: Auto-expand textarea height up to maximum limit
 */
export const calculateTextareaHeight = (
  scrollHeight: number,
  minHeight: number = MIN_TEXTAREA_HEIGHT,
  maxHeight: number = MAX_TEXTAREA_HEIGHT
): number => {
  return Math.max(minHeight, Math.min(scrollHeight, maxHeight));
};

/**
 * Feature toggle button component
 */
interface FeatureToggleProps {
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  activeColor?: string;
}

const FeatureToggle: React.FC<FeatureToggleProps> = ({
  icon,
  label,
  enabled,
  onToggle,
  disabled = false,
  activeColor = 'purple',
}) => {
  const colorClasses = {
    purple: enabled
      ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-900/40 dark:text-purple-400 dark:border-purple-700'
      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700',
    blue: enabled
      ? 'bg-blue-100 text-blue-600 border-blue-300 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-700'
      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700',
    green: enabled
      ? 'bg-green-100 text-green-600 border-green-300 dark:bg-green-900/40 dark:text-green-400 dark:border-green-700'
      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700',
  };

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
        colorClasses[activeColor as keyof typeof colorClasses] || colorClasses.purple
      } disabled:cursor-not-allowed disabled:opacity-50`}
      title={enabled ? `${label}已开启，点击关闭` : `${label}已关闭，点击开启`}
      aria-pressed={enabled}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

export const InputArea: React.FC<InputAreaProps> = ({
  onSend,
  onAbort,
  disabled,
  isGenerating,
  supportsThinking = false,
  contextUsage = null,
}) => {
  const [content, setContent] = useState('');
  const [enableThinking, setEnableThinking] = useState(true); // Default enabled when supported
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Auto-resize textarea based on content
   * Requirement 4.1: Auto-expand textarea height up to maximum limit
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get accurate scrollHeight
      textarea.style.height = 'auto';
      // Calculate and apply new height
      const newHeight = calculateTextareaHeight(textarea.scrollHeight);
      textarea.style.height = `${newHeight}px`;
    }
  }, [content]);

  /**
   * Focus textarea on mount
   */
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  /**
   * Handle sending message
   * Requirement 4.4: Click send button to send message
   */
  const handleSend = useCallback(() => {
    // Requirement 4.6: Don't send empty/whitespace-only input
    if (isWhitespaceOnly(content) || disabled || isGenerating) {
      return;
    }

    const trimmedContent = content.trim();
    onSend(trimmedContent, supportsThinking ? enableThinking : undefined);
    setContent('');

    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
    }

    // Refocus textarea after sending
    textareaRef.current?.focus();
  }, [content, disabled, isGenerating, onSend, supportsThinking, enableThinking]);

  /**
   * Handle keyboard events
   * Requirement 4.2: Enter (without Shift) sends message
   * Requirement 4.3: Shift+Enter inserts newline
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          // Requirement 4.3: Shift+Enter inserts newline (default behavior)
          return;
        }
        // Requirement 4.2: Enter sends message
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  /**
   * Handle input change
   */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
    },
    []
  );

  /**
   * Handle abort button click
   */
  const handleAbort = useCallback(() => {
    onAbort?.();
  }, [onAbort]);

  // Requirement 4.6: Disable send button for empty/whitespace input
  const isSendDisabled = disabled || isWhitespaceOnly(content);

  // Check if we have any feature toggles to show
  const hasFeatureToggles = supportsThinking || contextUsage;

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      {/* Feature toggles toolbar */}
      {hasFeatureToggles && (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {supportsThinking && (
              <FeatureToggle
                icon={<Brain size={12} />}
                label="思考"
                enabled={enableThinking}
                onToggle={() => setEnableThinking(!enableThinking)}
                disabled={isGenerating}
                activeColor="purple"
              />
            )}
            {/* Future toggles can be added here:
            <FeatureToggle icon={<Globe size={12} />} label="联网搜索" ... />
            <FeatureToggle icon={<Wrench size={12} />} label="工具调用" ... />
            */}
          </div>
          {/* Context usage indicator on the right */}
          {contextUsage && (
            <ContextUsageIndicator usage={contextUsage} disabled={isGenerating} />
          )}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          disabled={disabled || isGenerating}
          rows={1}
          aria-label="消息输入框"
          className="flex-1 resize-none rounded-lg border border-gray-300 bg-gray-50 px-4 py-2 text-gray-900 placeholder-gray-500 transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400"
          style={{ minHeight: `${MIN_TEXTAREA_HEIGHT}px` }}
        />
        {isGenerating ? (
          // Requirement 4.5: Show loading indicator when generating
          <button
            type="button"
            onClick={handleAbort}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            title="停止生成"
            aria-label="停止生成"
          >
            <Square size={18} />
          </button>
        ) : (
          // Requirement 4.5: Disable send button when generating
          <button
            type="button"
            onClick={handleSend}
            disabled={isSendDisabled}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500 text-white transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-500"
            title="发送消息"
            aria-label="发送消息"
          >
            <Send size={18} />
          </button>
        )}
      </div>

      {/* Keyboard shortcut hint */}
      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        <span>Enter 发送</span>
        <span className="mx-2">·</span>
        <span>Shift + Enter 换行</span>
      </div>
    </div>
  );
};

export default InputArea;
