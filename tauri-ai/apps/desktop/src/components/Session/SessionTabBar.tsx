/**
 * SessionTabBar Component
 * Displays all active sessions as tabs with support for switching, closing, and creating new sessions
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.5
 */

import React, { useState, useRef, useEffect } from 'react';
import { X, Plus, Loader2, Bot, ChevronDown } from 'lucide-react';
import type { AgentSession, Agent } from '../../types';
import { ContextMenu } from './ContextMenu';
import { useSessionStore } from '../../stores/sessionStore';

interface SessionTabBarProps {
  sessions: AgentSession[];
  activeSessionId: string | null;
  agents: Agent[];
  onTabClick: (sessionId: string) => void;
  onTabClose: (sessionId: string) => void;
  onNewSession: (agentName: string) => void;
  onPopoutSession?: (sessionId: string) => void;
}

/**
 * Individual session tab component
 */
interface SessionTabProps {
  session: AgentSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const SessionTab: React.FC<SessionTabProps> = ({
  session,
  isActive,
  onSelect,
  onClose,
  onContextMenu,
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
      onContextMenu={onContextMenu}
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

      {/* Session title with API type indicator */}
      <span className="flex-1 text-sm font-medium truncate flex items-center gap-1">
        {session.title}
        {session.apiType === 'responses' && (
          <span
            className="text-xs px-1 rounded bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-300"
            title="Responses API"
          >
            R
          </span>
        )}
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
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}

const AgentSelector: React.FC<AgentSelectorProps> = ({ agents, onSelect, onClose, buttonRef }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });

  // Calculate dropdown position relative to viewport (right-aligned)
  // Run on every render to ensure position is always correct
  useEffect(() => {
    const updatePosition = () => {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setPosition({
          top: rect.bottom + 4, // 4px gap below button
          right: window.innerWidth - rect.right, // Right-align to button's right edge
        });
      }
    };

    // Update position immediately
    updatePosition();

    // Also update on window resize/scroll
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [buttonRef]);

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
        className="fixed w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-[100]"
        style={{ top: `${position.top}px`, right: `${position.right}px` }}
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
      className="fixed w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-[100] max-h-80 overflow-auto"
      style={{ top: `${position.top}px`, right: `${position.right}px` }}
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
  onPopoutSession,
}) => {
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const newSessionButtonRef = useRef<HTMLButtonElement>(null);
  
  // 上下文菜单状态 (任务 4.1)
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    position: { x: number; y: number };
    targetSessionId: string;
    targetSessionIndex: number;
  } | null>(null);

  // 从 sessionStore 获取批量操作方法
  const closeOtherSessions = useSessionStore((state) => state.closeOtherSessions);
  const closeSessionsToLeft = useSessionStore((state) => state.closeSessionsToLeft);
  const closeSessionsToRight = useSessionStore((state) => state.closeSessionsToRight);

  // Handle tab click
  const handleTabClick = (sessionId: string) => {
    onTabClick(sessionId);
  };

  // Handle tab close
  const handleTabClose = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onTabClose(sessionId);
  };

  // 处理右键菜单 (任务 4.2)
  const handleContextMenu = (e: React.MouseEvent, sessionId: string, index: number) => {
    e.preventDefault(); // 阻止浏览器默认右键菜单
    setContextMenu({
      visible: true,
      position: { x: e.clientX, y: e.clientY },
      targetSessionId: sessionId,
      targetSessionIndex: index,
    });
  };

  // 关闭上下文菜单
  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  // 菜单项操作回调 (任务 4.4)
  const handleCloseOthers = () => {
    if (contextMenu) {
      closeOtherSessions(contextMenu.targetSessionId);
      handleCloseContextMenu();
    }
  };

  const handleCloseToLeft = () => {
    if (contextMenu) {
      closeSessionsToLeft(contextMenu.targetSessionId);
      handleCloseContextMenu();
    }
  };

  const handleCloseToRight = () => {
    if (contextMenu) {
      closeSessionsToRight(contextMenu.targetSessionId);
      handleCloseContextMenu();
    }
  };

  const handleCloseCurrent = () => {
    if (contextMenu) {
      onTabClose(contextMenu.targetSessionId);
      handleCloseContextMenu();
    }
  };

  const handlePopoutCurrent = () => {
    if (contextMenu && onPopoutSession) {
      onPopoutSession(contextMenu.targetSessionId);
      handleCloseContextMenu();
    }
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
    <div
      data-tauri-drag-region
      className="relative flex items-center bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700"
    >
      {/* Tab container with horizontal scroll */}
      <div
        ref={tabContainerRef}
        className="flex-1 flex items-center overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
        style={{ scrollbarWidth: 'thin' }}
      >
        {sessions.map((session, index) => (
          <SessionTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={() => handleTabClick(session.id)}
            onClose={(e) => handleTabClose(e, session.id)}
            onContextMenu={(e) => handleContextMenu(e, session.id, index)}
          />
        ))}
      </div>

      {/* New session button */}
      <div className="relative flex-shrink-0 px-2">
        <button
          ref={newSessionButtonRef}
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
            buttonRef={newSessionButtonRef}
          />
        )}
      </div>

      {/* 渲染上下文菜单 (任务 4.3) */}
      {contextMenu && (
        <ContextMenu
          visible={contextMenu.visible}
          position={contextMenu.position}
          targetSessionId={contextMenu.targetSessionId}
          targetSessionIndex={contextMenu.targetSessionIndex}
          totalSessions={sessions.length}
          onClose={handleCloseContextMenu}
          onOpenInNewWindow={onPopoutSession ? handlePopoutCurrent : undefined}
          onCloseOthers={handleCloseOthers}
          onCloseToLeft={handleCloseToLeft}
          onCloseToRight={handleCloseToRight}
          onCloseCurrent={handleCloseCurrent}
        />
      )}
    </div>
  );
};

export default SessionTabBar;
