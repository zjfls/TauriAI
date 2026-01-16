/**
 * Header Component
 * Application header with title, agent selector, and model selector
 */

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Bot, Plus, Cpu } from 'lucide-react';
import type { Agent } from '../../types';

interface ModelOption {
  label: string;
  value: string;
}

interface HeaderProps {
  title?: string;  // Make title optional
  onAgentSelect: (agentName: string) => void;
  currentAgentName: string;
  agents: Agent[];
  onNewConversation?: () => void;
  // Model selection
  modelOptions: ModelOption[];
  currentModelRef: string;
  onModelSelect: (modelRef: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  onAgentSelect,
  currentAgentName,
  agents,
  onNewConversation,
  modelOptions,
  currentModelRef,
  onModelSelect,
}) => {
  const [isAgentDropdownOpen, setIsAgentDropdownOpen] = useState(false);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const agentDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const currentAgent = agents.find((a) => a.name === currentAgentName) || agents[0];
  const currentModelLabel = modelOptions.find((m) => m.value === currentModelRef)?.label || '选择模型';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(event.target as Node)) {
        setIsAgentDropdownOpen(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex items-center justify-between h-14 px-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
    >
      {title && (
        <div data-tauri-drag-region className="flex-1">
          <h1 data-tauri-drag-region className="text-lg font-medium text-gray-800 dark:text-white truncate">
            {title}
          </h1>
        </div>
      )}

      <div className={`flex items-center gap-2 ${!title ? 'ml-auto' : ''}`}>
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

        {/* Model Selector */}
        <div className="relative" ref={modelDropdownRef}>
          <button
            onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <Cpu size={16} className="text-gray-500 dark:text-gray-400" />
            <span className="text-sm text-gray-700 dark:text-gray-300 max-w-40 truncate">
              {currentModelLabel}
            </span>
            <ChevronDown
              size={16}
              className={`text-gray-500 transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isModelDropdownOpen && (
            <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 max-h-80 overflow-auto">
              {modelOptions.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                  暂无可用模型
                </div>
              ) : (
                modelOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      onModelSelect(option.value);
                      setIsModelDropdownOpen(false);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <span className="text-sm text-gray-800 dark:text-white truncate">
                      {option.label}
                    </span>
                    {option.value === currentModelRef && (
                      <Check size={16} className="text-blue-500 flex-shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        
        {/* Agent Selector */}
        <div className="relative" ref={agentDropdownRef}>
          <button
            onClick={() => setIsAgentDropdownOpen(!isAgentDropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <Bot size={16} className="text-gray-500 dark:text-gray-400" />
            <span className="text-sm text-gray-700 dark:text-gray-300 max-w-32 truncate">
              {currentAgent?.displayName || '选择智能体'}
            </span>
            <ChevronDown
              size={16}
              className={`text-gray-500 transition-transform ${isAgentDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isAgentDropdownOpen && (
            <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
              {agents.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                  暂无配置的智能体
                </div>
              ) : (
                agents.map((agent) => (
                  <button
                    key={agent.name}
                    onClick={() => {
                      onAgentSelect(agent.name);
                      setIsAgentDropdownOpen(false);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-gray-800 dark:text-white">
                        {agent.displayName}
                      </span>
                      {agent.description && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-48">
                          {agent.description}
                        </span>
                      )}
                    </div>
                    {agent.name === currentAgentName && (
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
