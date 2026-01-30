/**
 * MainLayout Component
 * Main application layout with sidebar, session tabs, and content area
 * Requirements: 2.1, 2.2
 */

import React from 'react';
import { WorkspaceTabBar } from '../Workspace/WorkspaceTabBar';
import { useUIStore } from '../../stores/uiStore';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { openViewWindow } from '../../utils/viewWindow';
import { markChatOpenProfile, startChatOpenProfile } from '../../utils/chatOpenProfile';

interface MainLayoutProps {
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const { setActiveView } = useUIStore();
  const {
    config,
  } = useConfigStore();

  // Session store for multi-agent workspace
  // Use shallow comparison to prevent infinite re-renders
  const sessionsMap = useSessionStore((state) => state.sessions);
  const sessions = React.useMemo(() => Array.from(sessionsMap.values()), [sessionsMap]);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const switchSession = useSessionStore((state) => state.switchSession);
  const closeSession = useSessionStore((state) => state.closeSession);
  const createSession = useSessionStore((state) => state.createSession);

  // Handle session tab click - switch to session
  const handleTabClick = (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId);
    const profileId = startChatOpenProfile({
      source: 'workspace_tabs:switch_session',
      sessionId,
      conversationId: target?.conversationId ?? undefined,
      meta: {
        title: target?.title,
        messageCount: target?.messages?.length ?? 0,
      },
    });
    markChatOpenProfile('workspace_tabs:switchSession', { profileId: profileId || undefined, sessionId });
    switchSession(sessionId);
    setActiveView('chat');
    markChatOpenProfile('workspace_tabs:setActiveView(chat)', { profileId: profileId || undefined, sessionId });
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

  // Get agents for session creation dropdown
  const agents = config?.agents || [];

  const handlePopoutSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const conversationId = session.conversationId ?? undefined;
    openViewWindow('chat', session.title, conversationId ? { conversationId } : undefined);
    await closeSession(sessionId);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Workspace Tab Bar (chat sessions) */}
        <WorkspaceTabBar
          sessions={sessions}
          activeSessionId={activeSessionId}
          agents={agents}
          onTabClick={handleTabClick}
          onTabClose={handleTabClose}
          onNewSession={handleNewSession}
          onPopoutSession={handlePopoutSession}
        />

        {/* Content */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
