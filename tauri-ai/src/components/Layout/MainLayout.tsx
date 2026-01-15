/**
 * MainLayout Component
 * Main application layout with sidebar, session tabs, and content area
 * Requirements: 2.1, 2.2
 */

import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SessionTabBar } from '../Session/SessionTabBar';
import { useUIStore } from '../../stores/uiStore';
import { useConfigStore } from '../../stores/configStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useSessionStore } from '../../stores/sessionStore';

interface MainLayoutProps {
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const { sidebarExpanded, activeView, setActiveView } = useUIStore();
  const { 
    config, 
    setCurrentAgent, 
    setCurrentModel,
    getCurrentAgent,
    getCurrentModelRef,
    getModelOptions,
  } = useConfigStore();
  const { setCurrentConversation, currentConversationId, conversations } = useConversationStore();
  
  // Session store for multi-agent workspace
  const sessions = useSessionStore((state) => Array.from(state.sessions.values()));
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const switchSession = useSessionStore((state) => state.switchSession);
  const closeSession = useSessionStore((state) => state.closeSession);
  const createSession = useSessionStore((state) => state.createSession);

  // Handle new conversation
  const handleNewConversation = () => {
    setCurrentConversation(null);
    setActiveView('chat');
  };

  // Handle session tab click - switch to session
  const handleTabClick = (sessionId: string) => {
    switchSession(sessionId);
    setActiveView('chat');
  };

  // Handle session tab close
  const handleTabClose = async (sessionId: string) => {
    await closeSession(sessionId);
  };

  // Handle new session creation
  const handleNewSession = async (agentName: string) => {
    try {
      await createSession(agentName);
      setActiveView('chat');
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  // Get current conversation title based on active view
  const getTitle = () => {
    switch (activeView) {
      case 'chat':
        if (currentConversationId) {
          const conversation = conversations.find(c => c.id === currentConversationId);
          return conversation?.title || '新对话';
        }
        return '新对话';
      case 'history':
        return '历史记录';
      case 'settings':
        return '设置';
      default:
        return 'TauriAI';
    }
  };

  // Get agents for header dropdown
  const agents = config?.agents || [];
  const currentAgent = getCurrentAgent();
  const currentAgentName = currentAgent?.name || config?.defaultAgent || '';
  const currentModelRef = getCurrentModelRef() || '';
  const modelOptions = getModelOptions();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
      {/* Sidebar */}
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        expanded={sidebarExpanded}
      />

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <Header
          title={getTitle()}
          onAgentSelect={setCurrentAgent}
          currentAgentName={currentAgentName}
          agents={agents}
          onNewConversation={activeView === 'chat' ? handleNewConversation : undefined}
          modelOptions={modelOptions}
          currentModelRef={currentModelRef}
          onModelSelect={setCurrentModel}
        />

        {/* Session Tab Bar - only show in chat view */}
        {activeView === 'chat' && (
          <SessionTabBar
            sessions={sessions}
            activeSessionId={activeSessionId}
            agents={agents}
            onTabClick={handleTabClick}
            onTabClose={handleTabClose}
            onNewSession={handleNewSession}
          />
        )}

        {/* Content */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
