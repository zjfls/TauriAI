/**
 * App Component
 * Main application entry point that wires up all components
 * Requirements: 2.1-2.6, 5.1, 5.2
 */

import { useEffect } from 'react';
import { MainLayout } from './components/Layout/MainLayout';
import { ChatView } from './components/Chat/ChatView';
import { SettingsView } from './components/Settings/SettingsView';
import { HistoryPanel } from './components/History/HistoryPanel';
import { useConfigStore } from './stores/configStore';
import { useConversationStore } from './stores/conversationStore';
import { useUIStore } from './stores/uiStore';
import './App.css';

function App() {
  const { loadConfig } = useConfigStore();
  const { loadConversations, currentConversationId } = useConversationStore();
  const { activeView } = useUIStore();

  /**
   * Initialize stores on app load
   * Requirements: 5.1, 5.2
   */
  useEffect(() => {
    // Load configuration from backend
    loadConfig();
    // Load conversations from backend
    loadConversations();
  }, [loadConfig, loadConversations]);

  // 事件监听器已在 conversationStore 模块初始化时自动设置，无需在组件中处理

  /**
   * Render the active view based on UI state
   * Requirements: 2.1-2.6
   */
  const renderActiveView = () => {
    switch (activeView) {
      case 'chat':
        return <ChatView conversationId={currentConversationId} />;
      case 'history':
        return <HistoryPanel />;
      case 'settings':
        return <SettingsView />;
      default:
        return <ChatView conversationId={currentConversationId} />;
    }
  };

  return (
    <MainLayout>
      {renderActiveView()}
    </MainLayout>
  );
}

export default App;
