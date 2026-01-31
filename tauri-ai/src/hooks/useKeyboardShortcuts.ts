/**
 * useKeyboardShortcuts Hook
 * Provides global keyboard shortcuts for session management
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import { useEffect, useCallback, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useConfigStore } from '../stores/configStore';
import { useUIStore } from '../stores/uiStore';
import { markChatOpenProfile, startChatOpenProfile } from '../utils/chatOpenProfile';
import type { AgentSession, AppConfig } from '../types';

interface KeyboardShortcutsOptions {
  /** Whether shortcuts are enabled */
  enabled?: boolean;
  /** Callback when a new session is requested (for showing agent selector) */
  onNewSessionRequest?: () => void;
}

interface ConfigStoreState {
  config: AppConfig | null;
}

interface SessionStoreState {
  activeSessionId: string | null;
}

/**
 * Hook to handle global keyboard shortcuts for session management
 * 
 * Shortcuts:
 * - Ctrl+T: Create new session
 * - Ctrl+W: Close current session
 * - Ctrl+Tab: Switch to next session
 * - Ctrl+Shift+Tab: Switch to previous session
 * - Ctrl+1-9: Switch to session at index
 */
export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
  const { enabled = true, onNewSessionRequest } = options;
  
  // Config store for agents - subscribe to config changes
  const config = useConfigStore((s: ConfigStoreState) => s.config);
  
  // Subscribe to activeSessionId for reactivity (though we use getState() in handlers)
  useSessionStore((s: SessionStoreState) => s.activeSessionId);
  
  // Track if we're showing agent selector
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  
  // Get ordered session list
  const getOrderedSessions = useCallback((): AgentSession[] => {
    const currentSessions = useSessionStore.getState().sessions;
    const sessionArray: AgentSession[] = Array.from(currentSessions.values());
    return sessionArray.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, []);
  
  // Get current session index
  const getCurrentSessionIndex = useCallback(() => {
    const currentActiveId = useSessionStore.getState().activeSessionId;
    if (!currentActiveId) return -1;
    const orderedSessions = getOrderedSessions();
    return orderedSessions.findIndex((s) => s.id === currentActiveId);
  }, [getOrderedSessions]);

  
  /**
   * Create a new session
   * Requirements: 9.1
   */
  const handleCreateSession = useCallback(async () => {
    const agents = config?.agents || [];
    
    if (agents.length === 0) {
      // No agents configured
      console.warn('No agents configured');
      return;
    }
    
    if (agents.length === 1) {
      // Only one agent, create session directly
      try {
        await useSessionStore.getState().createSession(agents[0].name);
      } catch (error) {
        console.error('Failed to create session:', error);
      }
    } else {
      // Multiple agents, show selector or use default
      if (onNewSessionRequest) {
        onNewSessionRequest();
      } else {
        // Default: use default agent
        const defaultAgent = config?.defaultAgent || agents[0].name;
        try {
          await useSessionStore.getState().createSession(defaultAgent);
        } catch (error) {
          console.error('Failed to create session:', error);
        }
      }
    }
  }, [config, onNewSessionRequest]);
  
  /**
   * Close current session
   * Requirements: 9.2
   */
  const handleCloseSession = useCallback(async () => {
    const currentActiveId = useSessionStore.getState().activeSessionId;
    if (!currentActiveId) return;
    
    try {
      await useSessionStore.getState().closeSession(currentActiveId);
    } catch (error) {
      console.error('Failed to close session:', error);
    }
  }, []);
  
  /**
   * Switch to next session
   * Requirements: 9.3
   */
  const handleNextSession = useCallback(() => {
    const orderedSessions = getOrderedSessions();
    if (orderedSessions.length <= 1) return;
    
    const currentIndex = getCurrentSessionIndex();
    const nextIndex = (currentIndex + 1) % orderedSessions.length;
    const nextSession = orderedSessions[nextIndex];
    if (nextSession) {
      const activeView = useUIStore.getState().activeView;
      const profileId =
        activeView === 'chat'
          ? startChatOpenProfile({
              source: 'keyboard_shortcuts:next_session',
              sessionId: nextSession.id,
              conversationId: nextSession.conversationId ?? undefined,
              meta: {
                title: nextSession.title,
                messageCount: nextSession.messages?.length ?? 0,
              },
            })
          : null;
      markChatOpenProfile('keyboard_shortcuts:switchSession', { profileId: profileId || undefined, sessionId: nextSession.id });
      useSessionStore.getState().switchSession(nextSession.id);
    }
  }, [getOrderedSessions, getCurrentSessionIndex]);
  
  /**
   * Switch to previous session
   * Requirements: 9.4
   */
  const handlePreviousSession = useCallback(() => {
    const orderedSessions = getOrderedSessions();
    if (orderedSessions.length <= 1) return;
    
    const currentIndex = getCurrentSessionIndex();
    const prevIndex = currentIndex <= 0 ? orderedSessions.length - 1 : currentIndex - 1;
    const prevSession = orderedSessions[prevIndex];
    if (prevSession) {
      const activeView = useUIStore.getState().activeView;
      const profileId =
        activeView === 'chat'
          ? startChatOpenProfile({
              source: 'keyboard_shortcuts:previous_session',
              sessionId: prevSession.id,
              conversationId: prevSession.conversationId ?? undefined,
              meta: {
                title: prevSession.title,
                messageCount: prevSession.messages?.length ?? 0,
              },
            })
          : null;
      markChatOpenProfile('keyboard_shortcuts:switchSession', { profileId: profileId || undefined, sessionId: prevSession.id });
      useSessionStore.getState().switchSession(prevSession.id);
    }
  }, [getOrderedSessions, getCurrentSessionIndex]);
  
  /**
   * Switch to session at specific index (1-9)
   * Requirements: 9.5
   */
  const handleSwitchToIndex = useCallback((index: number) => {
    const orderedSessions = getOrderedSessions();
    // index is 1-based (Ctrl+1 = first session)
    const targetIndex = index - 1;
    
    if (targetIndex >= 0 && targetIndex < orderedSessions.length) {
      const targetSession = orderedSessions[targetIndex];
      if (targetSession) {
        const activeView = useUIStore.getState().activeView;
        const profileId =
          activeView === 'chat'
            ? startChatOpenProfile({
                source: 'keyboard_shortcuts:switch_to_index',
                sessionId: targetSession.id,
                conversationId: targetSession.conversationId ?? undefined,
                meta: {
                  index,
                  title: targetSession.title,
                  messageCount: targetSession.messages?.length ?? 0,
                },
              })
            : null;
        markChatOpenProfile('keyboard_shortcuts:switchSession', {
          profileId: profileId || undefined,
          sessionId: targetSession.id,
        });
        useSessionStore.getState().switchSession(targetSession.id);
      }
    }
  }, [getOrderedSessions]);

  
  /**
   * Main keyboard event handler
   */
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Check if Ctrl (or Cmd on Mac) is pressed
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;
    
    if (!isCtrlOrCmd) return;
    
    // Handle Ctrl+T: Create new session
    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      handleCreateSession();
      return;
    }
    
    // Handle Ctrl+W: Close current session
    if (event.key === 'w' || event.key === 'W') {
      event.preventDefault();
      handleCloseSession();
      return;
    }
    
    // Handle Ctrl+Tab: Next session
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      handleNextSession();
      return;
    }
    
    // Handle Ctrl+Shift+Tab: Previous session
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      handlePreviousSession();
      return;
    }
    
    // Handle Ctrl+1-9: Switch to session at index
    const numKey = parseInt(event.key, 10);
    if (numKey >= 1 && numKey <= 9) {
      event.preventDefault();
      handleSwitchToIndex(numKey);
      return;
    }
  }, [
    handleCreateSession,
    handleCloseSession,
    handleNextSession,
    handlePreviousSession,
    handleSwitchToIndex,
  ]);
  
  // Set up event listener
  useEffect(() => {
    if (!enabled) return;
    
    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);
  
  return {
    showAgentSelector,
    setShowAgentSelector,
  };
}

export default useKeyboardShortcuts;
