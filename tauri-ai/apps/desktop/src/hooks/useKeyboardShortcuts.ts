/**
 * useKeyboardShortcuts Hook
 * Provides global keyboard shortcuts (configurable, cross-platform)
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import { useEffect, useCallback, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSessionStore } from '../stores/sessionStore';
import { useConfigStore } from '../stores/configStore';
import { useUIStore } from '../stores/uiStore';
import { markChatOpenProfile, startChatOpenProfile } from '../utils/chatOpenProfile';
import { detectShortcutPlatform, eventToKeybindingString, isEditableElement, normalizeKeybindingString } from '../shortcuts';
import { SHORTCUT_ACTIONS } from '../shortcuts/registry';
import type { AgentSession, AppConfig } from '../types';

interface KeyboardShortcutsOptions {
  /** Whether shortcuts are enabled */
  enabled?: boolean;
  /**
   * Shortcut handling scope.
   * - all: default behavior (session/chat/workstudio/etc.)
   * - workstudio: only handle Workstudio actions (plus DevTools)
   */
  scope?: 'all' | 'workstudio';
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
 * - Configurable: see Settings -> 通用 -> 快捷键
 * - 固定补充：Ctrl/Cmd + 1-9 切换当前 Pane 内的会话索引（不在设置里展开配置）
 */
export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
  const { enabled = true, scope = 'all', onNewSessionRequest } = options;
  
  // Config store for agents - subscribe to config changes
  const config = useConfigStore((s: ConfigStoreState) => s.config);
  
  // Subscribe to activeSessionId for reactivity (though we use getState() in handlers)
  useSessionStore((s: SessionStoreState) => s.activeSessionId);
  
  // Track if we're showing agent selector
  const [showAgentSelector, setShowAgentSelector] = useState(false);

  // Active view (used to scope certain shortcuts)
  useUIStore((s) => s.activeView);

  const platform = detectShortcutPlatform();
  const shortcutSettings = config?.general?.keyboardShortcuts;
  const shortcutsEnabled = enabled && (shortcutSettings?.enabled ?? true);

  const isActionInScope = useCallback(
    (actionId: string) => {
      if (scope === 'workstudio') {
        if (actionId === 'app.openDevtools') return true;
        return actionId.startsWith('workstudio.');
      }
      return true;
    },
    [scope]
  );

  const getEffectiveBinding = useCallback(
    (actionId: string): string | null => {
      const defaults = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
      if (!defaults) return null;

      const userMap = platform === 'mac' ? shortcutSettings?.mac : shortcutSettings?.windows;
      const raw = (userMap as any)?.[actionId] ?? (platform === 'mac' ? defaults.defaultMac : defaults.defaultWindows);
      return normalizeKeybindingString(String(raw || ''), platform);
    },
    [platform, shortcutSettings]
  );

  const bindingToAction = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    const isNativeMenuAuthoritative = isTauri();
    for (const action of SHORTCUT_ACTIONS) {
      if (!isActionInScope(action.id)) continue;
      // 在 Tauri 桌面端：`session.new` 默认由系统菜单 accelerator 处理，避免与前端 keydown 双触发导致创建两次会话。
      if (isNativeMenuAuthoritative && action.id === 'session.new') {
        continue;
      }
      const binding = getEffectiveBinding(action.id);
      if (!binding) continue;
      if (out[binding]) continue; // keep first, UI will show conflicts
      out[binding] = action.id;
    }
    return out;
  }, [getEffectiveBinding, isActionInScope]);
  
  // Get ordered sessions in the focused pane (VS Code-like group behavior)
  const getOrderedSessions = useCallback((): AgentSession[] => {
    const state = useSessionStore.getState();
    const panes = state.panes ?? [];
    const focusedPaneId = state.focusedPaneId ?? panes[0]?.id ?? null;
    const focusedPane = (focusedPaneId ? panes.find((p) => p.id === focusedPaneId) : null) ?? panes[0] ?? null;
    if (!focusedPane) return [];

    const out: AgentSession[] = [];
    for (const id of focusedPane.sessionIds) {
      const s = state.sessions.get(id);
      if (s) out.push(s);
    }
    return out;
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

  const dispatchShortcutEvent = useCallback((actionId: string) => {
    try {
      window.dispatchEvent(new CustomEvent('tauri-ai:shortcut', { detail: { action: actionId } }));
    } catch {
      // ignore
    }
  }, []);

  const executeAction = useCallback(
    async (actionId: string): Promise<boolean> => {
      switch (actionId) {
        case 'app.openSettings': {
          useUIStore.getState().setActiveView('settings');
          return true;
        }
        case 'app.openHistory': {
          useUIStore.getState().setActiveView('history');
          return true;
        }
        case 'app.openDevtools': {
          if (!isTauri()) return false;
          try {
            await invoke('open_devtools_current_window');
            return true;
          } catch {
            return false;
          }
        }
        case 'session.new': {
          await handleCreateSession();
          return true;
        }
        case 'session.clone': {
          const activeView = useUIStore.getState().activeView;
          if (activeView !== 'chat') return false;
          const activeSessionId = useSessionStore.getState().activeSessionId;
          if (!activeSessionId) return false;
          try {
            await useSessionStore.getState().cloneConversation(activeSessionId);
            return true;
          } catch (e) {
            console.error('Failed to clone conversation:', e);
            return false;
          }
        }
        case 'session.close': {
          await handleCloseSession();
          return true;
        }
        case 'session.next': {
          handleNextSession();
          return true;
        }
        case 'session.previous': {
          handlePreviousSession();
          return true;
        }
        case 'chat.abortGeneration': {
          const activeView = useUIStore.getState().activeView;
          if (activeView !== 'chat') return false;
          const activeSessionId = useSessionStore.getState().activeSessionId;
          if (!activeSessionId) return false;
          const session = useSessionStore.getState().sessions.get(activeSessionId);
          if (!session?.isGenerating) return false;
          await useSessionStore.getState().abortGeneration(activeSessionId);
          return true;
        }
        case 'chat.toggleScrollNavigator': {
          if (useUIStore.getState().activeView !== 'chat') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'chat.toggleOutline': {
          if (useUIStore.getState().activeView !== 'chat') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'chat.openWorkstudio': {
          if (useUIStore.getState().activeView !== 'chat') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'workstudio.fileSearch': {
          if (useUIStore.getState().activeView !== 'workstudio') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'workstudio.navigateBack':
        case 'workstudio.navigateForward': {
          if (useUIStore.getState().activeView !== 'workstudio') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'workstudio.goToDefinition':
        case 'workstudio.goToTypeDefinition':
        case 'workstudio.goToReferences':
        case 'workstudio.peekDefinition': {
          if (useUIStore.getState().activeView !== 'workstudio') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'document.save': {
          if (useUIStore.getState().activeView !== 'document') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'web.focusAddressBar':
        case 'web.reload': {
          if (useUIStore.getState().activeView !== 'web') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        default:
          return false;
      }
    },
    [
      dispatchShortcutEvent,
      handleCloseSession,
      handleCreateSession,
      handleNextSession,
      handlePreviousSession,
    ]
  );

  
  /**
   * Main keyboard event handler
   */
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!shortcutsEnabled) return;

    // 先处理：Ctrl/Cmd + 1-9 切换会话（固定规则）
    if (scope !== 'workstudio') {
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;
      if (isCtrlOrCmd) {
        const numKey = parseInt(event.key, 10);
        if (numKey >= 1 && numKey <= 9) {
          event.preventDefault();
          handleSwitchToIndex(numKey);
          return;
        }
      }
    }

    const bindingMap = bindingToAction();
    const binding = eventToKeybindingString(event, platform);
    if (!binding) return;

    const actionId = bindingMap[binding];
    if (!actionId) return;

    const def = SHORTCUT_ACTIONS.find((a) => a.id === actionId) || null;
    if (def && !def.allowWhenTyping && isEditableElement(event.target)) {
      return;
    }

    // Tauri 桌面端：`session.new` 默认由系统菜单 accelerator 处理。
    // 如果这里也处理，会导致重复触发（例如 Cmd/Ctrl+T 新建两次会话）。
    if (isTauri() && actionId === 'session.new') {
      return;
    }

    const canHandleNow = (() => {
      switch (actionId) {
        case 'app.openDevtools':
          return isTauri();
        case 'workstudio.fileSearch':
          return useUIStore.getState().activeView === 'workstudio';
        case 'workstudio.navigateBack':
        case 'workstudio.navigateForward':
          return useUIStore.getState().activeView === 'workstudio';
        case 'workstudio.goToDefinition':
        case 'workstudio.goToTypeDefinition':
        case 'workstudio.goToReferences':
        case 'workstudio.peekDefinition':
          return useUIStore.getState().activeView === 'workstudio';
        case 'document.save':
          return useUIStore.getState().activeView === 'document';
        case 'web.focusAddressBar':
        case 'web.reload':
          return useUIStore.getState().activeView === 'web';
        case 'chat.abortGeneration': {
          if (useUIStore.getState().activeView !== 'chat') return false;
          // 图片预览 modal 打开时，Escape 应该优先用于关闭预览，避免误触发中止流式输出。
          if (document.body.dataset.tauriaiImagePreviewOpen === '1') return false;
          const activeSessionId = useSessionStore.getState().activeSessionId;
          if (!activeSessionId) return false;
          const session = useSessionStore.getState().sessions.get(activeSessionId);
          return Boolean(session?.isGenerating);
        }
        case 'chat.toggleScrollNavigator':
          return useUIStore.getState().activeView === 'chat';
        case 'chat.toggleOutline':
          return useUIStore.getState().activeView === 'chat';
        case 'chat.openWorkstudio':
          return useUIStore.getState().activeView === 'chat';
        default:
          return true;
      }
    })();
    if (!canHandleNow) return;

    // 允许 Escape 在其他监听里继续用于关闭面板；abort 成功也不强制阻止默认行为。
    if (binding !== 'Escape') {
      event.preventDefault();
    }

    // Workstudio 编辑器内动作：避免被 Monaco/其它监听重复处理（例如 F12 内置跳转）。
    if (
      actionId === 'workstudio.goToDefinition' ||
      actionId === 'workstudio.goToTypeDefinition' ||
      actionId === 'workstudio.goToReferences' ||
      actionId === 'workstudio.peekDefinition'
    ) {
      event.stopPropagation();
    }
    void executeAction(actionId);
  }, [
    shortcutsEnabled,
    scope,
    bindingToAction,
    executeAction,
    platform,
    handleSwitchToIndex,
  ]);
  
  // Set up event listener
  useEffect(() => {
    if (!shortcutsEnabled) return;
    
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [shortcutsEnabled, handleKeyDown]);
  
  return {
    showAgentSelector,
    setShowAgentSelector,
  };
}

export default useKeyboardShortcuts;
