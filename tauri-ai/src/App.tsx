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
import { useSessionStore } from './stores/sessionStore';
import { useUIStore } from './stores/uiStore';
import './App.css';

function App() {
  const { loadConfig, config } = useConfigStore();
  const { loadConversations } = useConversationStore();
  const { activeView } = useUIStore();
  
  // Session store for multi-agent workspace
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const restoreSessionState = useSessionStore((state) => state.restoreSessionState);
  const createSession = useSessionStore((state) => state.createSession);
  const sessions = useSessionStore((state) => state.sessions);

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

  /**
   * Restore session state after config is loaded
   * Requirements: 5.2
   */
  useEffect(() => {
    const initSessions = async () => {
      // Wait for config to be loaded
      if (!config) return;
      
      // Restore previous sessions
      await restoreSessionState();
      
      // If no sessions exist after restore, create a default session
      const currentSessions = useSessionStore.getState().sessions;
      if (currentSessions.size === 0) {
        const defaultAgent = config.defaultAgent || config.agents?.[0]?.name;
        if (defaultAgent) {
          try {
            await createSession(defaultAgent);
          } catch (error) {
            console.error('Failed to create default session:', error);
          }
        }
      }
    };
    
    initSessions();
  }, [config, restoreSessionState, createSession]);

  // 事件监听器已在 sessionStore 模块初始化时自动设置，无需在组件中处理

  /**
   * Render the active view based on UI state
   * Requirements: 2.1-2.6
   */
  const renderActiveView = () => {
    switch (activeView) {
      case 'chat':
        // Render ChatView with activeSessionId, handle no active session
        if (!activeSessionId) {
          return (
            <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">
              <div className="text-center">
                <p className="text-lg mb-2">暂无活动会话</p>
                <p className="text-sm">点击上方 "+" 按钮创建新会话</p>
              </div>
            </div>
          );
        }
        return <ChatView sessionId={activeSessionId} />;
      case 'history':
        return <HistoryPanel />;
      case 'settings':
        return <SettingsView />;
      default:
        return <ChatView sessionId={activeSessionId} />;
    }
  };

  return (
    <MainLayout>
      {renderActiveView()}
    </MainLayout>
  );
}

export default App;
