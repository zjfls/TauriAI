/**
 * SessionTabBar Component
 * Displays all active sessions as tabs with support for switching, closing, and creating new sessions
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.5
 */

import React, { useState, useRef, useEffect } from 'react';
import { X, Plus, Loader2, Bot, ChevronDown } from 'lucide-react';
import type { AgentSession, Agent } from '../../types';

interface SessionTabBarProps {
  sessions: AgentSession[];
  activeSessionId: string | null;
  agents: Agent[];
  onTabClick: (sessionId: string) => void;
  onTabClose: (sessionId: string) => void;
  onNewSession: (agentName: string) => void;
}

/**
 * Individual session tab component
 */
interface SessionTabProps {
  session: AgentSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
}

const SessionTab: React.FC<SessionTabProps> = ({
  session,
  isActive,
  onSelect,
  onClose,
}) => {
  return (
    <div
      className={`
        group relative flex items-center gap-2 px-3 py-2 min-w-[120px] max-w-[200px]
        cursor-pointer select-none transition-colors duration-150 border-b-2
        ${isActive
          ? 'bg-white dark:bg-gray-800 border-blue-500 text-gray-800 dark:text-white'
          : 'bg-gray-50 dark:bg-gray-900 border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'
        }
      `}
      onClick={onSelect}
      title={session.title}
    >
      {/* Loading indicator or bot icon */}
      <div className="flex-shrink-0">
        {session.isGenerating ? (
          <Loader2 size={14} className="animate-spin text-blue-500" />
        ) : (
          <Bot size={14} className={isActive ? 'text-blue-500' : 'text-gray-400'} />
        )}
      </div>

      {/* Session title */}
      <span className="flex-1 text-sm font-medium truncate">
        {session.title}
      </span>

      {/* Close button */}
      <button
        onClick={onClose}
        className={`
          flex-shrink-0 p-0.5 rounded transition-colors
          ${isActive
            ? 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            : 'opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
          }
        `}
        title="关闭会话"
      >
        <X size={14} />
      </button>
    </div>
  );
};

/**
 * Agent selection dropdown for creating new sessions
 */
interface AgentSelectorProps {
  agents: Agent[];
  onSelect: (agentName: string) => void;
  onClose: () => void;
}

const AgentSelector: React.FC<AgentSelectorProps> = ({ agents, onSelect, onClose }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (agents.length === 0) {
    return (
      <div
        ref={dropdownRef}
        className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50"
      >
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
          暂无配置的智能体，请先在设置中添加智能体
        </div>
      </div>
    );
  }

  return (
    <div
      ref={dropdownRef}
      className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 max-h-80 overflow-auto"
    >
      <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
        选择智能体
      </div>
      {agents.map((agent) => (
        <button
          key={agent.name}
          onClick={() => {
            onSelect(agent.name);
            onClose();
          }}
          className="flex flex-col w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <span className="text-sm font-medium text-gray-800 dark:text-white">
            {agent.displayName}
          </span>
          {agent.description && (
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {agent.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};

/**
 * Main SessionTabBar component
 */
export const SessionTabBar: React.FC<SessionTabBarProps> = ({
  sessions,
  activeSessionId,
  agents,
  onTabClick,
  onTabClose,
  onNewSession,
}) => {
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const tabContainerRef = useRef<HTMLDivElement>(null);

  // Handle tab click
  const handleTabClick = (sessionId: string) => {
    onTabClick(sessionId);
  };

  // Handle tab close
  const handleTabClose = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onTabClose(sessionId);
  };

  // Handle new session button click
  const handleNewSessionClick = () => {
    if (agents.length === 0) {
      // Show message that no agents are configured
      setShowAgentSelector(true);
    } else if (agents.length === 1) {
      // If only one agent, create session directly
      onNewSession(agents[0].name);
    } else {
      // Show agent selector
      setShowAgentSelector(!showAgentSelector);
    }
  };

  // Handle agent selection for new session
  const handleAgentSelect = (agentName: string) => {
    onNewSession(agentName);
    setShowAgentSelector(false);
  };

  return (
    <div className="flex items-center bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
      {/* Tab container with horizontal scroll */}
      <div
        ref={tabContainerRef}
        className="flex-1 flex items-center overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
        style={{ scrollbarWidth: 'thin' }}
      >
        {sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={() => handleTabClick(session.id)}
            onClose={(e) => handleTabClose(e, session.id)}
          />
        ))}
      </div>

      {/* New session button */}
      <div className="relative flex-shrink-0 px-2">
        <button
          onClick={handleNewSessionClick}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          title="新建会话"
        >
          <Plus size={16} />
          {agents.length > 1 && (
            <ChevronDown size={12} className={`transition-transform ${showAgentSelector ? 'rotate-180' : ''}`} />
          )}
        </button>

        {/* Agent selector dropdown */}
        {showAgentSelector && (
          <AgentSelector
            agents={agents}
            onSelect={handleAgentSelect}
            onClose={() => setShowAgentSelector(false)}
          />
        )}
      </div>
    </div>
  );
};

export default SessionTabBar;
