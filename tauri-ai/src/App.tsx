/**
 * App Component
 * Main application entry point that wires up all components
 * Requirements: 2.1-2.6, 5.1, 5.2, 9.1-9.5
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { MainLayout } from './components/Layout/MainLayout';
import { StandaloneLayout } from './components/Layout/StandaloneLayout';
import { useConfigStore } from './stores/configStore';
import { useConversationStore } from './stores/conversationStore';
import { useSessionStore, initStreamListeners } from './stores/sessionStore';
import { useDocumentStore } from './stores/documentStore';
import { useUIStore } from './stores/uiStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { getViewDefinition } from './views/registry';
import { ChatViewContainer } from './views/ChatViewContainer';
import { getViewWindowParams } from './utils/viewWindow';
import './App.css';

function App() {
  const { loadConfig, config, isLoading: configLoading, error: configError } = useConfigStore();
  const loadConversations = useConversationStore((state) => state.loadConversations);
  const { activeView, setActiveView } = useUIStore();

  const windowParams = getViewWindowParams();
  const viewOverride = windowParams.view;
  const isStandalone = windowParams.standalone;
  const isStandaloneChatWindow = isStandalone && viewOverride === 'chat';
  const conversationIdOverride = windowParams.conversationId;
  const agentNameOverride = windowParams.agentName;
  const runModeOverride = windowParams.runMode;
  const documentPathOverride = windowParams.documentPath;
  // Standalone non-chat views should not start/restore chat sessions or stream listeners.
  // Otherwise opening a "文本/导图" window can create or mutate chat sessions unexpectedly.
  const shouldInitChatRuntime = !isStandalone || viewOverride === 'chat';
  
  // Session store for multi-agent workspace
  const restoreSessionState = useSessionStore((state) => state.restoreSessionState);
  const createSession = useSessionStore((state) => state.createSession);
  const openHistoricalConversation = useSessionStore((state) => state.openHistoricalConversation);
  
  // Track if session initialization has been done to prevent duplicate execution
  const sessionInitialized = useRef(false);
  const viewOverrideAppliedRef = useRef(false);
  const chatKeepAliveLayerRef = useRef<HTMLDivElement>(null);

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
   * Menu: File -> Open File...
   * The native menu event is emitted from Rust as `menu:open_file`.
   */
  useEffect(() => {
    // Workstudio 窗口需要把“打开文件”路由到自己的编辑器，而不是切换到全局 DocumentView。
    // 因此在 workstudio 视图（含 standalone 窗口）里跳过这里的监听（由 WorkstudioView 自己处理）。
    if ((isStandaloneChatWindow ? activeView : (viewOverride || activeView)) === 'workstudio') return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('menu:open_file', async () => {
      try {
        const selected = await openDialog({
          title: '打开文件',
          multiple: false,
          directory: false,
        });

        if (!selected || Array.isArray(selected)) return;

        const file = await invoke<{
          filename: string;
          mime: string;
          base64: string;
          size: number;
        }>('read_local_file_base64', { path: selected });

        const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
        const content = new TextDecoder('utf-8').decode(bytes);

        useDocumentStore.getState().openDocument({
          title: file.filename,
          path: selected,
          kind: 'text',
          content,
        });

        useUIStore.getState().setActiveView('document');
      } catch (error) {
        console.error('Failed to open file:', error);
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // In non-Tauri environments (tests/browser), the listener may not be available.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [viewOverride, activeView, isStandaloneChatWindow]);

  /**
   * Menu: File -> New .tauri.richtxt
   * Create a new empty .tauri.richtxt document
   */
  useEffect(() => {
    if ((isStandaloneChatWindow ? activeView : (viewOverride || activeView)) === 'workstudio') return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('menu:new_richtxt', () => {
      const re = /^Untitled-(\d+)\.tauri\.richtxt$/i;
      const docs = useDocumentStore.getState().documents;
      let max = 0;
      for (const d of docs) {
        const m = re.exec(d.title);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
      const title = `Untitled-${max + 1}.tauri.richtxt`;

      // Create a new untitled .tauri.richtxt document
      useDocumentStore.getState().openDocument({
        title,
        path: undefined,
        kind: 'text',
        content: '<!-- tauri.richtxt v1 -->\n\n# 新建文档\n\n',
      });

      useUIStore.getState().setActiveView('document');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // In non-Tauri environments, the listener may not be available.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [viewOverride, activeView, isStandaloneChatWindow]);

  /**
   * Standalone document window: open a local file if provided via query param.
   */
  useEffect(() => {
    if (!isStandalone) return;
    if (viewOverride !== 'document') return;
    if (!documentPathOverride) return;

    void (async () => {
      try {
        const file = await invoke<{
          filename: string;
          mime: string;
          base64: string;
          size: number;
        }>('read_local_file_base64', { path: documentPathOverride });

        const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
        const content = new TextDecoder('utf-8').decode(bytes);

        useDocumentStore.getState().openDocument({
          title: file.filename,
          path: documentPathOverride,
          kind: 'text',
          content,
        });

        useUIStore.getState().setActiveView('document');
      } catch (error) {
        console.error('Failed to open document in standalone window:', error);
      }
    })();
  }, [isStandalone, viewOverride, documentPathOverride]);

  /**
   * Handle window resize to force re-render
   */
  useEffect(() => {
    const handleResize = () => {
      // Force a re-render by updating a dummy state
      // This ensures all components recalculate their dimensions
      window.dispatchEvent(new Event('resize-complete'));
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleResize, 100);
    };

    window.addEventListener('resize', debouncedResize);
    return () => {
      window.removeEventListener('resize', debouncedResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, []);

  /**
   * Initialize stores on app load
   * Requirements: 5.1, 5.2
   */
  useEffect(() => {
    console.log('Initializing app...');
    // Initialize chat stream listeners only for chat-capable windows.
    if (shouldInitChatRuntime) {
      initStreamListeners();
    }
    // Load configuration from backend
    loadConfig().then(() => {
      console.log('Config loaded');
    }).catch((err) => {
      console.error('Failed to load config:', err);
    });
    // Load conversations from backend
    if (!isStandalone || viewOverride === 'history' || viewOverride === 'chat') {
      loadConversations().then(() => {
        console.log('Conversations loaded');
      }).catch((err) => {
        console.error('Failed to load conversations:', err);
      });
    }
  }, [loadConfig, loadConversations, shouldInitChatRuntime, isStandalone, viewOverride]);

  /**
   * Restore session state after config is loaded
   * Requirements: 5.2
   * - Calls restoreSessionState to restore previously active sessions
   * - If no sessions exist after restore, creates a default session
   */
  useEffect(() => {
    const initSessions = async () => {
      if (!shouldInitChatRuntime) return;
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
        // 防御：历史/边界情况下可能残留空 pane 或失效 activeSessionId，统一在启动时修复一次。
        useSessionStore.getState().sanitizeLayoutState();
      } catch (err) {
        console.error('Failed to restore session state:', err);
      }

      // Standalone chat window can target a specific conversation. Ensure it is opened & active.
      if (isStandalone && viewOverride === 'chat' && conversationIdOverride) {
        try {
          // Best-effort: ensure conversation metadata is loaded for title/agent/model.
          await loadConversations();
        } catch (err) {
          console.warn('Failed to load conversations for standalone chat:', err);
        }
        try {
          await openHistoricalConversation(conversationIdOverride, {
            agentName: agentNameOverride ?? undefined,
            runMode: runModeOverride ?? undefined,
          });
        } catch (err) {
          console.error('Failed to open conversation in standalone chat:', err);
        }
      }

      // If no sessions exist after restore, create a default session
      const currentSessions = useSessionStore.getState().sessions;
      console.log('Current sessions count:', currentSessions.size);
      
      if (currentSessions.size === 0) {
        // If a standalone chat window is bound to an existing conversation, don't create a new one.
        if (isStandalone && viewOverride === 'chat' && conversationIdOverride) {
          return;
        }
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
  }, [
    config,
    restoreSessionState,
    createSession,
    openHistoricalConversation,
    shouldInitChatRuntime,
    isStandalone,
    viewOverride,
    conversationIdOverride,
    agentNameOverride,
    runModeOverride,
    loadConversations,
  ]);

  // 事件监听器已在 sessionStore 模块初始化时自动设置，无需在组件中处理

  /**
   * Render the active view based on UI state
   * Requirements: 2.1-2.6
   */
  const resolvedView = isStandaloneChatWindow ? activeView : viewOverride || activeView;
  const viewDef = getViewDefinition(resolvedView) || getViewDefinition('chat');
  const isChatActive = (viewDef?.id ?? 'chat') === 'chat';

  useEffect(() => {
    if (!viewOverride) return;

    // Standalone chat windows should behave like a mini-workspace: allow switching to web/terminal/etc.
    // So we apply the view override once as the initial active view, instead of locking it forever.
    if (isStandaloneChatWindow) {
      if (viewOverrideAppliedRef.current) return;
      viewOverrideAppliedRef.current = true;
      if (viewOverride !== activeView) setActiveView(viewOverride);
      return;
    }

    if (viewOverride !== activeView) setActiveView(viewOverride);
  }, [viewOverride, activeView, setActiveView, isStandaloneChatWindow]);

  // ChatView keep-alive:
  // - 在主窗口内切换到 History/Settings 等视图时，不卸载 ChatView（避免滚动/定位在重建时漂移）
  // - 仅通过可见性与 pointer-events 控制展示，保证回到聊天时“像没离开一样”
  useEffect(() => {
    if (isStandalone && !isStandaloneChatWindow) return;
    if (isChatActive) return;

    const chatLayer = chatKeepAliveLayerRef.current;
    const active = document.activeElement;
    if (!chatLayer || !active) return;
    if (!(active instanceof HTMLElement)) return;
    if (chatLayer.contains(active)) {
      active.blur();
    }
  }, [isChatActive, isStandalone, isStandaloneChatWindow]);

  const renderNonChatView = () => {
    if (isChatActive) return null;
    if (viewDef?.id === 'chat') return null;
    return viewDef?.render() ?? null;
  };

  if (isStandalone && !isStandaloneChatWindow) {
    return (
      <StandaloneLayout title={viewDef?.title}>
        {viewDef?.render() ?? null}
      </StandaloneLayout>
    );
  }

  return (
    <MainLayout>
      <div className="relative h-full w-full overflow-hidden">
        <div
          ref={chatKeepAliveLayerRef}
          className={`absolute inset-0 ${isChatActive ? '' : 'invisible pointer-events-none'}`}
          aria-hidden={!isChatActive}
        >
          <ChatViewContainer />
        </div>
        {!isChatActive && (
          <div className="absolute inset-0 z-10 bg-gray-50 dark:bg-gray-900">{renderNonChatView()}</div>
        )}
      </div>
    </MainLayout>
  );
}

export default App;
