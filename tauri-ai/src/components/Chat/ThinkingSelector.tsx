/**
 * ThinkingSelector Component
 * Adaptive thinking mode selector that supports both binary (on/off) and multi-level modes
 * depending on the API protocol type
 */

import React, { useState, useRef, useEffect } from 'react';
import { Brain, ChevronDown, Check } from 'lucide-react';
import type { ApiProtocolType, ThinkingMode, ThinkingLevel } from '../../types';

interface ThinkingSelectorProps {
  apiProtocol: ApiProtocolType;
  value: ThinkingMode;
  onChange: (value: ThinkingMode) => void;
  disabled?: boolean;
}

/**
 * Feature toggle button component for binary mode
 */
interface FeatureToggleProps {
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

const FeatureToggle: React.FC<FeatureToggleProps> = ({
  icon,
  label,
  enabled,
  onToggle,
  disabled = false,
}) => {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
        enabled
          ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-900/40 dark:text-purple-400 dark:border-purple-700'
          : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700'
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
 * ThinkingSelector Component
 * Renders different UI based on API protocol:
 * - chat_completions: Binary toggle (on/off)
 * - responses: Multi-level dropdown (无/低/中/高/超高)
 */
export const ThinkingSelector: React.FC<ThinkingSelectorProps> = ({
  apiProtocol,
  value,
  onChange,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Binary mode for chat_completions API
  if (apiProtocol === 'chat_completions') {
    return (
      <FeatureToggle
        icon={<Brain size={12} />}
        label="思考"
        enabled={value as boolean}
        onToggle={() => onChange(!(value as boolean))}
        disabled={disabled}
      />
    );
  }

  // Multi-level mode for responses API
  const levels: { value: ThinkingLevel; label: string }[] = [
    { value: null, label: '无' },
    { value: 'minimal', label: '最少' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '超高' },
  ];

  const currentLevel = value as ThinkingLevel;
  const currentLabel = levels.find(l => l.value === currentLevel)?.label || '无';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
          currentLevel
            ? 'bg-purple-100 text-purple-600 border-purple-300 dark:bg-purple-900/40 dark:text-purple-400 dark:border-purple-700'
            : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700'
        } disabled:cursor-not-allowed disabled:opacity-50`}
        title={`思考级别: ${currentLabel}`}
        aria-label={`思考级别: ${currentLabel}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Brain size={12} />
        <span>思考: {currentLabel}</span>
        <ChevronDown size={10} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div 
          className="absolute bottom-full left-0 mb-1 w-32 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50"
          role="menu"
        >
          {levels.map((level) => (
            <button
              key={level.value || 'none'}
              onClick={() => {
                onChange(level.value);
                setIsOpen(false);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              role="menuitem"
            >
              <span className="text-xs text-gray-800 dark:text-white">
                {level.label}
              </span>
              {level.value === currentLevel && (
                <Check size={12} className="text-purple-500 flex-shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ThinkingSelector;
