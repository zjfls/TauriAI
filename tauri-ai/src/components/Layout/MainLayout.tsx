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
import { useSessionStore } from '../../stores/sessionStore';

interface MainLayoutProps {
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const { sidebarExpanded, activeView, setActiveView } = useUIStore();
  const { 
    config, 
    getModelOptions,
  } = useConfigStore();
  
  // Session store for multi-agent workspace
  // Use shallow comparison to prevent infinite re-renders
  const sessionsMap = useSessionStore((state) => state.sessions);
  const sessions = React.useMemo(() => Array.from(sessionsMap.values()), [sessionsMap]);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const activeSession = useSessionStore((state) => state.getActiveSession());
  const switchSession = useSessionStore((state) => state.switchSession);
  const closeSession = useSessionStore((state) => state.closeSession);
  const createSession = useSessionStore((state) => state.createSession);
  const setSessionAgent = useSessionStore((state) => state.setSessionAgent);
  const setSessionModel = useSessionStore((state) => state.setSessionModel);

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
    console.log('handleNewSession called with agent:', agentName);
    try {
      await createSession(agentName);
      console.log('Session created successfully');
      setActiveView('chat');
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  // Handle agent selection for active session
  const handleAgentSelect = (agentName: string) => {
    if (activeView === 'chat' && activeSessionId) {
      setSessionAgent(activeSessionId, agentName);
    }
  };

  // Handle model selection for active session
  const handleModelSelect = (modelRef: string) => {
    if (activeView === 'chat' && activeSessionId) {
      setSessionModel(activeSessionId, modelRef);
    }
  };

  // Get current conversation title based on active view
  const getTitle = () => {
    switch (activeView) {
      case 'chat':
        return undefined; // No title in chat view
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
  const currentAgentName = activeSession?.agentName || config?.defaultAgent || '';
  const currentModelRef = activeSession?.modelRef || '';
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
          onAgentSelect={handleAgentSelect}
          currentAgentName={currentAgentName}
          agents={agents}
          modelOptions={modelOptions}
          currentModelRef={currentModelRef}
          onModelSelect={handleModelSelect}
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
