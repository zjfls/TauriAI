/**
 * Header Component
 * Application header with title and model selector
 * Requirements: 2.2, 2.5
 */

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Cpu, Plus } from 'lucide-react';
import type { ModelConfig } from '../../types';

interface HeaderProps {
  title: string;
  onModelSelect: (modelId: string) => void;
  currentModelId: string;
  models: ModelConfig[];
  onNewConversation?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  onModelSelect,
  currentModelId,
  models,
  onNewConversation,
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Get current model info
  const currentModel = models.find((m) => m.id === currentModelId);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get provider display name
  const getProviderLabel = (provider: string) => {
    switch (provider) {
      case 'openai':
        return 'OpenAI';
      case 'anthropic':
        return 'Anthropic';
      case 'ollama':
        return 'Ollama';
      default:
        return provider;
    }
  };

  return (
    <header
      data-tauri-drag-region
      className="flex items-center justify-between h-14 px-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
    >
      {/* Title - Draggable Area */}
      <div data-tauri-drag-region className="flex-1">
        <h1
          data-tauri-drag-region
          className="text-lg font-medium text-gray-800 dark:text-white truncate"
        >
          {title}
        </h1>
      </div>

      {/* Right side actions */}
      <div className="flex items-center gap-2">
        {/* New Conversation Button */}
        {onNewConversation && (
          <button
            onClick={onNewConversation}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
            title="新对话"
          >
            <Plus size={16} />
            <span className="text-sm">新对话</span>
          </button>
        )}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <Cpu size={16} className="text-gray-500 dark:text-gray-400" />
            <span className="text-sm text-gray-700 dark:text-gray-300 max-w-32 truncate">
              {currentModel?.name || '选择模型'}
            </span>
            <ChevronDown
              size={16}
              className={`text-gray-500 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Dropdown Menu */}
          {isDropdownOpen && (
            <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
              {models.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                  暂无配置的模型
                </div>
              ) : (
                models.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onModelSelect(model.id);
                      setIsDropdownOpen(false);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-gray-800 dark:text-white">
                        {model.name}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {getProviderLabel(model.provider)} · {model.model}
                      </span>
                    </div>
                    {model.id === currentModelId && (
                      <Check size={16} className="text-blue-500 flex-shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
