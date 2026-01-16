/**
 * App Component
 * Main application entry point that wires up all components
 * Requirements: 2.1-2.6, 5.1, 5.2, 9.1-9.5
 */

import { useEffect, useRef } from 'react';
import { MainLayout } from './components/Layout/MainLayout';
import { ChatView } from './components/Chat/ChatView';
import { SettingsView } from './components/Settings/SettingsView';
import { HistoryPanel } from './components/History/HistoryPanel';
import { useConfigStore } from './stores/configStore';
import { useConversationStore } from './stores/conversationStore';
import { useSessionStore, initStreamListeners } from './stores/sessionStore';
import { useUIStore } from './stores/uiStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import './App.css';

function App() {
  const { loadConfig, config, isLoading: configLoading, error: configError } = useConfigStore();
  const { loadConversations } = useConversationStore();
  const { activeView } = useUIStore();
  
  // Session store for multi-agent workspace
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const restoreSessionState = useSessionStore((state) => state.restoreSessionState);
  const createSession = useSessionStore((state) => state.createSession);
  
  // Track if session initialization has been done to prevent duplicate execution
  const sessionInitialized = useRef(false);

  // Debug logging
  useEffect(() => {
    console.log('App mounted, config:', config, 'loading:', configLoading, 'error:', configError);
  }, [config, configLoading, configError]);

  /**
   * Initialize keyboard shortcuts for session management
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
   */
  useKeyboardShortcuts({ enabled: true });

  /**
   * Handle window resize to force re-render
   */
  useEffect(() => {
    const handleResize = () => {
      // Force a re-render by updating a dummy state
      // This ensures all components recalculate their dimensions
      window.dispatchEvent(new Event('resize-complete'));
    };

    let resizeTimer: NodeJS.Timeout;
    const debouncedResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleResize, 100);
    };

    window.addEventListener('resize', debouncedResize);
    return () => {
      window.removeEventListener('resize', debouncedResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  /**
   * Initialize stores on app load
   * Requirements: 5.1, 5.2
   */
  useEffect(() => {
    console.log('Initializing app...');
    // Initialize stream listeners first
    initStreamListeners();
    // Load configuration from backend
    loadConfig().then(() => {
      console.log('Config loaded');
    }).catch((err) => {
      console.error('Failed to load config:', err);
    });
    // Load conversations from backend
    loadConversations().then(() => {
      console.log('Conversations loaded');
    }).catch((err) => {
      console.error('Failed to load conversations:', err);
    });
  }, [loadConfig, loadConversations]);

  /**
   * Restore session state after config is loaded
   * Requirements: 5.2
   * - Calls restoreSessionState to restore previously active sessions
   * - If no sessions exist after restore, creates a default session
   */
  useEffect(() => {
    const initSessions = async () => {
      // Wait for config to be loaded
      if (!config) {
        console.log('Waiting for config to load...');
        return;
      }
      
      // Prevent duplicate initialization
      if (sessionInitialized.current) return;
      sessionInitialized.current = true;
      
      console.log('Initializing sessions with config:', config);
      
      // Restore previous sessions from localStorage
      try {
        await restoreSessionState();
        console.log('Session state restored');
      } catch (err) {
        console.error('Failed to restore session state:', err);
      }
      
      // If no sessions exist after restore, create a default session
      const currentSessions = useSessionStore.getState().sessions;
      console.log('Current sessions count:', currentSessions.size);
      
      if (currentSessions.size === 0) {
        const defaultAgent = config.defaultAgent || config.agents?.[0]?.name;
        console.log('Creating default session with agent:', defaultAgent);
        if (defaultAgent) {
          try {
            await createSession(defaultAgent);
            console.log('Default session created');
          } catch (error) {
            console.error('Failed to create default session:', error);
          }
        } else {
          console.warn('No default agent available');
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
