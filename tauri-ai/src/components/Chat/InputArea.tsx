/**
 * InputArea Component
 * Responsive input area with auto-expanding textarea and send functionality
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Brain, Bot, Cpu, ChevronDown, Check } from 'lucide-react';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import type { ContextUsageBreakdown, Agent } from '../../types';

// Constants for textarea sizing
const MIN_TEXTAREA_HEIGHT = 40; // Minimum height in pixels
const MAX_TEXTAREA_HEIGHT = 200; // Maximum height in pixels (Requirement 4.1)

interface ModelOption {
  label: string;
  value: string;
}

interface InputAreaProps {
  onSend: (content: string, enableThinking?: boolean) => void;
  onAbort?: () => void;
  disabled: boolean;
  isGenerating: boolean;
  supportsThinking?: boolean;  // Whether current model supports thinking
  contextUsage?: ContextUsageBreakdown | null;  // Context usage for indicator
  // Agent/Model selection
  agents?: Agent[];
  currentAgentName?: string;
  onAgentSelect?: (agentName: string) => void;
  modelOptions?: ModelOption[];
  currentModelRef?: string;
  onModelSelect?: (modelRef: string) => void;
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
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${colorClasses[activeColor as keyof typeof colorClasses] || colorClasses.purple
        } disabled:cursor-not-allowed disabled:opacity-50`}
      title={enabled ? `${label}已开启，点击关闭` : `${label}已关闭，点击开启`}
      aria-pressed={enabled}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

/**
 * Compact dropdown selector for agent/model selection
 */
interface CompactSelectorProps<T extends { label: string; value: string }> {
  icon: React.ReactNode;
  options: T[];
  currentValue: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function CompactSelector<T extends { label: string; value: string }>({
  icon,
  options,
  currentValue,
  onSelect,
  disabled = false,
  placeholder = '选择',
}: CompactSelectorProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentLabel = options.find(o => o.value === currentValue)?.label || placeholder;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {icon}
        <span className="max-w-20 truncate">{currentLabel}</span>
        <ChevronDown size={10} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 max-h-60 overflow-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              暂无可用选项
            </div>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  onSelect(option.value);
                  setIsOpen(false);
                }}
                className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <span className="text-xs text-gray-800 dark:text-white truncate">
                  {option.label}
                </span>
                {option.value === currentValue && (
                  <Check size={12} className="text-blue-500 flex-shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export interface InputAreaHandle {
  setValue: (value: string) => void;
  focus: () => void;
}

export const InputArea = React.forwardRef<InputAreaHandle, InputAreaProps>(({
  onSend,
  onAbort,
  disabled,
  isGenerating,
  supportsThinking = false,
  contextUsage = null,
  agents = [],
  currentAgentName = '',
  onAgentSelect,
  modelOptions = [],
  currentModelRef = '',
  onModelSelect,
}, ref) => {
  const [content, setContent] = useState('');
  const [enableThinking, setEnableThinking] = useState(true); // Default enabled when supported
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Helper to adjust textarea height
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = calculateTextareaHeight(textarea.scrollHeight);
      textarea.style.height = `${newHeight}px`;
    }
  }, []);

  // Expose methods to parent
  React.useImperativeHandle(ref, () => ({
    setValue: (value: string) => {
      setContent(value);
      // Auto-resize after setting content
      requestAnimationFrame(() => {
        adjustTextareaHeight();
        textareaRef.current?.focus();
      });
    },
    focus: () => {
      textareaRef.current?.focus();
    }
  }));

  /**
   * Auto-resize textarea based on content
   * Requirement 4.1: Auto-expand textarea height up to maximum limit
   */
  useEffect(() => {
    adjustTextareaHeight();
  }, [content, adjustTextareaHeight]);

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

  // Convert agents to selector options
  const agentOptions = agents.map(a => ({ label: a.displayName, value: a.name }));

  // Check if we have selectors to show
  const hasSelectors = agents.length > 0 || modelOptions.length > 0;
  const hasFeatureToggles = supportsThinking || contextUsage || hasSelectors;

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      {/* Toolbar: Agent/Model selectors and feature toggles */}
      {hasFeatureToggles && (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Agent selector */}
            {agents.length > 0 && onAgentSelect && (
              <CompactSelector
                icon={<Bot size={12} />}
                options={agentOptions}
                currentValue={currentAgentName}
                onSelect={onAgentSelect}
                disabled={isGenerating}
                placeholder="智能体"
              />
            )}
            {/* Model selector */}
            {modelOptions.length > 0 && onModelSelect && (
              <CompactSelector
                icon={<Cpu size={12} />}
                options={modelOptions}
                currentValue={currentModelRef}
                onSelect={onModelSelect}
                disabled={isGenerating}
                placeholder="模型"
              />
            )}
            {/* Divider if both selectors and toggles exist */}
            {(agents.length > 0 || modelOptions.length > 0) && supportsThinking && (
              <div className="h-4 w-px bg-gray-300 dark:bg-gray-600 mx-1" />
            )}
            {/* Thinking toggle */}
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
});

export default InputArea;
