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

interface MainLayoutProps {
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const { sidebarExpanded, activeView, setActiveView } = useUIStore();
  const { config, setActiveModel } = useConfigStore();

  // Get current conversation title based on active view
  const getTitle = () => {
    switch (activeView) {
      case 'chat':
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
