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
import { useWindowLayoutStore } from '../stores/windowLayoutStore';
import { markChatOpenProfile, startChatOpenProfile } from '../utils/chatOpenProfile';
import { closeAllWorkstudioWindows, openOrFocusWorkstudioWindow } from '../utils/viewWindow';
import { openPracticeWindow, openPracticeWorkspaceTab } from '../utils/practiceWorkspaceTab';
import { detectShortcutPlatform, eventToKeybindingString, isEditableElement, normalizeKeybindingString } from '../shortcuts';
import { SHORTCUT_ACTIONS } from '../shortcuts/registry';
import type { AgentSession, AppConfig, Workstudio } from '../types';
import { filterNonPracticeAgents } from '../../../common/src/agentUtils';

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
        if (actionId === 'app.openDevtools' || actionId === 'app.openPractice') return true;
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
      // 在 Tauri 桌面端：这些动作由系统菜单 accelerator 处理，避免与前端 keydown 双触发。
      if (isNativeMenuAuthoritative && (
        action.id === 'session.new'
        || action.id === 'app.openSettings'
        || action.id === 'app.openHistory'
        || action.id === 'app.openDevtools'
      )) {
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
    const layout = useWindowLayoutStore.getState();
    const panes = layout.panes ?? [];
    const focusedPaneId = layout.focusedPaneId ?? panes[0]?.id ?? null;
    const focusedPane = (focusedPaneId ? panes.find((pane) => pane.id === focusedPaneId) : null) ?? panes[0] ?? null;
    if (!focusedPane) return [];

    const out: AgentSession[] = [];
    for (const tabId of focusedPane.tabIds) {
      if (!tabId.startsWith('chat:')) continue;
      const sessionId = tabId.slice('chat:'.length);
      const session = state.sessions.get(sessionId);
      if (session) out.push(session);
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
    const agents = filterNonPracticeAgents(config?.agents || []);
    const externalAgents = (config?.externalAgents?.agents || []).filter((agent) => agent.enabled ?? true);
    const totalCount = agents.length + externalAgents.length;

    if (totalCount === 0) {
      console.warn('No session entry configured');
      return;
    }

    if (totalCount === 1) {
      try {
        if (agents.length === 1) {
          await useSessionStore.getState().createSession(agents[0].name);
        } else if (externalAgents.length === 1) {
          await useSessionStore.getState().createExternalSession(externalAgents[0].name);
        }
      } catch (error) {
        console.error('Failed to create session:', error);
      }
      return;
    }

    if (onNewSessionRequest) {
      onNewSessionRequest();
      return;
    }

    const defaultAgent =
      (config?.defaultAgent && agents.some((agent) => agent.name === config.defaultAgent)
        ? config.defaultAgent
        : '') || agents[0]?.name || '';

    try {
      if (defaultAgent) {
        await useSessionStore.getState().createSession(defaultAgent);
      } else if (externalAgents[0]) {
        await useSessionStore.getState().createExternalSession(externalAgents[0].name);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
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

  const reportCloneFailure = useCallback((reason: string) => {
    try {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(`克隆失败：${reason}`);
      }
    } catch {
      // ignore UI errors
    }
  }, []);

  const dispatchShortcutEvent = useCallback((actionId: string) => {
    try {
      window.dispatchEvent(new CustomEvent('tauri-ai:shortcut', { detail: { action: actionId } }));
    } catch {
      // ignore
    }
  }, []);

  const openWorkstudioFromActiveSession = useCallback(async (): Promise<boolean> => {
    if (!isTauri()) return false;
    const state = useSessionStore.getState();
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return false;
    const activeSession = state.sessions.get(activeSessionId);
    const conversationId = activeSession?.conversationId;
    if (!conversationId) return false;

    try {
      const ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
      await openOrFocusWorkstudioWindow(`Workstudio: ${ws.mainFolder}`, {
        workstudioId: ws.id,
        mainFolder: ws.mainFolder,
      });
      return true;
    } catch (error) {
      console.error('Failed to open workstudio from shortcut:', error);
      return false;
    }
  }, []);

  const executeAction = useCallback(
    async (actionId: string): Promise<boolean> => {
      switch (actionId) {
        case 'app.openSettings': {
          console.log('[Shortcut][frontend] app.openSettings executing via keydown path');
          useUIStore.getState().setActiveView('settings');
          return true;
        }
        case 'app.openHistory': {
          useUIStore.getState().setActiveView('history');
          return true;
        }
        case 'app.openPractice': {
          if (!isTauri()) {
            openPracticeWorkspaceTab();
            return true;
          }
          await openPracticeWindow();
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
          if (activeView !== 'chat') {
            reportCloneFailure('当前不在聊天视图');
            return false;
          }
          const activeSessionId = useSessionStore.getState().activeSessionId;
          if (!activeSessionId) {
            reportCloneFailure('当前没有可克隆的会话');
            return false;
          }
          try {
            await useSessionStore.getState().cloneConversation(activeSessionId);
            return true;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('Failed to clone conversation:', e);
            reportCloneFailure(message || '未知错误');
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
          const activeView = useUIStore.getState().activeView;
          if (activeView === 'workstudio') return false;
          if (activeView === 'chat') {
            dispatchShortcutEvent(actionId);
            return true;
          }
          return openWorkstudioFromActiveSession();
        }
        case 'workstudio.closeAllWindows': {
          if (!isTauri()) return false;
          try {
            await closeAllWorkstudioWindows();
            return true;
          } catch (error) {
            console.error('Failed to close all workstudio windows:', error);
            return false;
          }
        }
        case 'workstudio.fileSearch':
        case 'workstudio.fileSymbolSearch':
        case 'workstudio.workspaceSymbolSearch': {
          if (useUIStore.getState().activeView !== 'workstudio') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'workstudio.triggerSuggest': {
          if (useUIStore.getState().activeView !== 'workstudio') return false;
          dispatchShortcutEvent(actionId);
          return true;
        }
        case 'workstudio.backToMain': {
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
        case 'workstudio.fontZoomIn':
        case 'workstudio.fontZoomOut':
        case 'workstudio.fontZoomReset': {
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
      openPracticeWindow,
      openWorkstudioFromActiveSession,
      reportCloneFailure,
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
    const rawBinding = eventToKeybindingString(event, platform);
    if (!rawBinding) return;

    let binding = rawBinding;
    let actionId = bindingMap[binding];

    // Ctrl/Cmd + "+" is typically emitted as Shift+ "=" on many keyboards (event.code === "Equal"),
    // so allow matching a configured "Ctrl/Cmd + =" binding as a fallback.
    if (!actionId && event.shiftKey && (event.code === 'Equal' || event.code === 'NumpadAdd')) {
      const withoutShift = binding.replace('Shift+', '');
      const fallbackAction = bindingMap[withoutShift];
      if (fallbackAction) {
        binding = withoutShift;
        actionId = fallbackAction;
      }
    }

    if (!actionId) return;

    const def = SHORTCUT_ACTIONS.find((a) => a.id === actionId) || null;
    if (def && !def.allowWhenTyping && isEditableElement(event.target)) {
      return;
    }

    // Tauri 桌面端：这些动作默认由系统菜单 accelerator 处理，避免重复触发。
    if (isTauri() && (
      actionId === 'session.new'
      || actionId === 'app.openSettings'
      || actionId === 'app.openHistory'
      || actionId === 'app.openDevtools'
    )) {
      if (actionId === 'app.openSettings') {
        console.log('[Shortcut][frontend] app.openSettings matched in keydown path, but skipped because Tauri menu is authoritative');
      }
      return;
    }

    const canHandleNow = (() => {
      switch (actionId) {
        case 'app.openDevtools':
          return isTauri();
        case 'workstudio.closeAllWindows':
          return isTauri();
        case 'workstudio.backToMain':
        case 'workstudio.fileSearch':
        case 'workstudio.fileSymbolSearch':
        case 'workstudio.workspaceSymbolSearch':
        case 'workstudio.triggerSuggest':
          return useUIStore.getState().activeView === 'workstudio';
        case 'workstudio.navigateBack':
        case 'workstudio.navigateForward':
          return useUIStore.getState().activeView === 'workstudio';
        case 'workstudio.goToDefinition':
        case 'workstudio.goToTypeDefinition':
        case 'workstudio.goToReferences':
        case 'workstudio.peekDefinition':
          return useUIStore.getState().activeView === 'workstudio';
        case 'workstudio.fontZoomIn':
        case 'workstudio.fontZoomOut':
        case 'workstudio.fontZoomReset':
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
          return useUIStore.getState().activeView !== 'workstudio';
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
      actionId === 'workstudio.backToMain' ||
      actionId === 'workstudio.fileSymbolSearch' ||
      actionId === 'workstudio.workspaceSymbolSearch' ||
      actionId === 'workstudio.triggerSuggest' ||
      actionId === 'workstudio.goToDefinition' ||
      actionId === 'workstudio.goToTypeDefinition' ||
      actionId === 'workstudio.goToReferences' ||
      actionId === 'workstudio.peekDefinition' ||
      actionId === 'workstudio.fontZoomIn' ||
      actionId === 'workstudio.fontZoomOut' ||
      actionId === 'workstudio.fontZoomReset'
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
