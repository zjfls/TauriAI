/**
 * MainLayout Component
 * Main application layout with sidebar and content area
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useUIStore } from '../../stores/uiStore';
import { useConfigStore } from '../../stores/configStore';
import { useConversationStore } from '../../stores/conversationStore';

interface MainLayoutProps {
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const { sidebarExpanded, activeView, setActiveView } = useUIStore();
  const { config, setActiveModel } = useConfigStore();
  const { setCurrentConversation, currentConversationId, conversations } = useConversationStore();

  // Handle new conversation
  const handleNewConversation = () => {
    // Clear current conversation to start a new one
    setCurrentConversation(null);
    // Switch to chat view
    setActiveView('chat');
  };

  // Get current conversation title based on active view
  const getTitle = () => {
    switch (activeView) {
      case 'chat':
        // Get actual conversation title if exists
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
          onModelSelect={setActiveModel}
          currentModelId={config?.activeModelId || ''}
          models={config?.models || []}
          onNewConversation={activeView === 'chat' ? handleNewConversation : undefined}
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
