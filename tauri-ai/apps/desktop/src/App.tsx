/**
 * App Component
 * Main application entry point that wires up all components
 * Requirements: 2.1-2.6, 5.1, 5.2, 9.1-9.5
 */

import { useEffect, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { MainLayout } from './components/Layout/MainLayout';
import { StandaloneLayout } from './components/Layout/StandaloneLayout';
import { GlobalErrorModal } from './components/GlobalErrorModal';
import { WorkstudioView } from './components/Workstudio/WorkstudioView';
import { DragGhostView } from './components/DragGhost/DragGhostView';
import { useConfigStore } from './stores/configStore';
import { useConversationStore } from './stores/conversationStore';
import { useSessionStore, initStreamListeners } from './stores/sessionStore';
import { useDocumentStore } from './stores/documentStore';
import { useWebTabStore } from './stores/webTabStore';
import { useTerminalTabStore } from './stores/terminalTabStore';
import { useUIStore } from './stores/uiStore';
import { useWindowLayoutStore } from './stores/windowLayoutStore';
import { chatTabId, docTabId, terminalTabId, webTabId } from './stores/workspaceTabStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { getViewDefinition } from './views/registry';
import { ChatViewContainer } from './views/ChatViewContainer';
import { getViewWindowParams, openOrFocusViewWindow } from './utils/viewWindow';
import { resolveActiveWorkstudioMainFolder } from './utils/terminalWorkdir';
import { getCurrentWindowLabelSafe, removeWindowPresence, writeWindowPresence } from './utils/windowPresence';
import type { CodeSnippetContentPart, WorkspaceMentionChip, Workstudio } from './types';
import {
  clearAppClosingIfStale,
  isAppClosingRecently,
  readWindowLayout,
  removeWindowRecord,
  upsertWindowRecord,
} from './utils/windowLayout';
import './App.css';

function App() {
  const { loadConfig, config } = useConfigStore();
  const loadConversations = useConversationStore((state) => state.loadConversations);
  const { activeView, setActiveView } = useUIStore();

  const currentWindowLabel = getCurrentWindowLabelSafe();
  const isGhostLabel = currentWindowLabel.startsWith('__tauriai_ghost__');

  const windowParams = getViewWindowParams();
  const viewOverride = windowParams.view;
  const isStandalone = windowParams.standalone;
  const noDefaultSession = windowParams.noDefaultSession;
  const conversationIdOverride = windowParams.conversationId;
  const agentNameOverride = windowParams.agentName;
  const runModeOverride = windowParams.runMode;
  const documentPathOverride = windowParams.documentPath;
  const workstudioIdOverride = windowParams.workstudioId;
  const webUrlOverride = windowParams.webUrl;
  const webTitleOverride = windowParams.webTitle;
  const terminalWorkdirOverride = windowParams.terminalWorkdir;
  const terminalTitleOverride = windowParams.terminalTitle;
  // Standalone non-chat views should not start/restore chat sessions or stream listeners.
  // Otherwise opening a "文本/导图" window can create or mutate chat sessions unexpectedly.
  const isWorkstudioWindow = viewOverride === 'workstudio';
  const isDragGhostWindow = viewOverride === 'drag-ghost' || isGhostLabel;
  const shouldInitChatRuntime = !isWorkstudioWindow && !isDragGhostWindow;

  // Standalone Workstudio window: ensure native window title contains "Workstudio".
  // This avoids macOS Window menu showing the default HTML <title> ("Tauri + React + Typescript")
  // when a window is restored/created without an explicit title.
  useEffect(() => {
    if (!isTauri()) return;
    if (!isWorkstudioWindow) return;
    let disposed = false;
    const win = getCurrentWebviewWindow();

    const setTitleSafe = async (title: string) => {
      const t = (title ?? '').trim() || 'Workstudio';
      try {
        document.title = t;
      } catch {
        // ignore
      }
      try {
        await win.setTitle(t);
      } catch {
        // ignore
      }
    };

    void (async () => {
      const workstudioId = (workstudioIdOverride ?? '').trim();
      const currentTitle = await win.title().catch(() => '');
      if (disposed) return;

      const hasWorkstudioPrefix = /^workstudio\b/i.test((currentTitle ?? '').trim());
      if (!hasWorkstudioPrefix) {
        await setTitleSafe('Workstudio');
        if (disposed) return;
      } else {
        // Ensure document title is aligned; native title is already ok.
        await setTitleSafe(currentTitle);
        if (disposed) return;
        // If the title already contains a path, skip the DB roundtrip.
        if (/^workstudio:\s*.+/i.test((currentTitle ?? '').trim())) return;
      }

      if (!workstudioId) return;

      try {
        const ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId });
        if (disposed) return;
        const mainFolder = (ws?.mainFolder ?? '').trim();
        if (!mainFolder) return;
        await setTitleSafe(`Workstudio: ${mainFolder}`);
      } catch {
        // ignore
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isWorkstudioWindow, workstudioIdOverride]);

  // Session store for multi-agent workspace
  const restoreSessionState = useSessionStore((state) => state.restoreSessionState);
  const createSession = useSessionStore((state) => state.createSession);
  const openHistoricalConversation = useSessionStore((state) => state.openHistoricalConversation);

  // Track if session initialization has been done to prevent duplicate execution
  const sessionInitialized = useRef(false);
  const viewOverrideAppliedRef = useRef(false);
  const initialStandaloneTabsAppliedRef = useRef(false);
  const chatKeepAliveLayerRef = useRef<HTMLDivElement>(null);
  const restoredWindowsRef = useRef(false);

  // Cross-window "open conversation" presence:
  // - 供 History 列表标记“该对话已在其他窗口打开”
  // - 用 localStorage 做轻量广播，避免引入额外的后端状态
  useEffect(() => {
    if (!shouldInitChatRuntime) return;

    const label = getCurrentWindowLabelSafe();
    let disposed = false;
    let lastKey = '';
    let lastWriteAt = 0;
    let timer: number | null = null;

    const computeConversationIds = () => {
      const sessions = useSessionStore.getState().sessions;
      const ids = new Set<string>();
      for (const s of sessions.values()) {
        if (s.conversationId) ids.add(s.conversationId);
      }
      return Array.from(ids).sort();
    };

    const schedulePublish = (force: boolean) => {
      if (disposed) return;
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (disposed) return;
        const ids = computeConversationIds();
        const key = ids.join('|');
        const now = Date.now();
        const heartbeatDue = now - lastWriteAt >= 4_000;
        if (!force && key === lastKey && !heartbeatDue) return;
        writeWindowPresence(label, { openConversationIds: ids });
        lastKey = key;
        lastWriteAt = now;
      }, 120);
    };

    schedulePublish(true);

    const unsubscribe = useSessionStore.subscribe(() => {
      schedulePublish(false);
    });

    const interval = window.setInterval(() => schedulePublish(true), 4_000);

    const cleanup = () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(interval);
      unsubscribe();
      removeWindowPresence(label);
    };

    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      cleanup();
    };
  }, [shouldInitChatRuntime]);

  /**
   * Initialize keyboard shortcuts for session management
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
   */
  useKeyboardShortcuts({
    enabled: !isDragGhostWindow,
    scope: isWorkstudioWindow ? 'workstudio' : 'all',
  });

  // ---------------------------------------------------------------------------
  // 窗口/分屏持久化（跨重启）
  // - 记录当前窗口（label + view params + bounds）
  // - 主窗口启动时按记录恢复其它窗口
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;
    if (!isDragGhostWindow) return;

    const win = getCurrentWebviewWindow();
    let disposed = false;
    let unlistenClose: null | (() => void) = null;

    // Ghost window 不做持久化，但必须可关闭；否则 always-on-top 很容易给人“窗口创建卡住”的错觉。
    void win
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await invoke('close_invoking_window').catch(() => { });
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlistenClose = fn;
      })
      .catch(() => { });

    return () => {
      disposed = true;
      unlistenClose?.();
    };
  }, [isDragGhostWindow]);

  useEffect(() => {
    if (!isTauri()) return;
    if (isDragGhostWindow) return;

    clearAppClosingIfStale();

    const label = getCurrentWindowLabelSafe();
    const params = getViewWindowParams();
    const title = document.title || label;

    // 先写一份最小记录，bounds 稍后异步补齐
    upsertWindowRecord({ label, title, params, bounds: null });

    const win = getCurrentWebviewWindow();
    let disposed = false;
    let timer: number | null = null;

    const updateBounds = async () => {
      if (disposed) return;
      try {
        const [pos, size] = await Promise.all([win.outerPosition().catch(() => null), win.outerSize().catch(() => null)]);
        if (!pos || !size) return;
        upsertWindowRecord({
          label,
          title: document.title || title,
          params,
          bounds: { x: pos.x, y: pos.y, width: size.width, height: size.height },
        });
      } catch {
        // ignore
      }
    };

    const scheduleBounds = () => {
      if (disposed) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void updateBounds();
      }, 200);
    };

    void updateBounds();

    let unlistenMoved: null | (() => void) = null;
    let unlistenResized: null | (() => void) = null;
    let unlistenClose: null | (() => void) = null;

    void win
      .onMoved(() => scheduleBounds())
      .then((fn) => {
        unlistenMoved = fn;
      })
      .catch(() => { });
    void win
      .onResized(() => scheduleBounds())
      .then((fn) => {
        unlistenResized = fn;
      })
      .catch(() => { });

    void win
      .onCloseRequested(async (event) => {
        // 关键：`@tauri-apps/api` 的 `onCloseRequested` 默认会在 handler 结束后调用 `window.destroy()`，
        // 这需要 `core:window:allow-destroy` 权限。我们这里统一 preventDefault，并改用后端命令 destroy 窗口，
        // 避免权限报错导致“窗口无法关闭”。
        event.preventDefault();

        // 主窗口 close(X)：隐藏到系统托盘，不销毁任何资源（避免会话/对话重建）。
        if (label === 'main') {
          await invoke('hide_invoking_window').catch(() => { });
          return;
        }

        // 单独关闭某个窗口：从“下次启动恢复列表”移除（但应用退出时不移除）。
        // 注意：整体退出时，非 main 窗口可能先于 main 收到 close 请求；若立刻删除会导致重启丢布局。
        // 这里做一个极短延迟后二次检查，避免退出竞态误删。
        if (!isAppClosingRecently()) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
          if (!isAppClosingRecently()) removeWindowRecord(label);
        }

        await invoke('close_invoking_window').catch(() => { });
      })
      .then((fn) => {
        unlistenClose = fn;
      })
      .catch(() => { });

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      unlistenMoved?.();
      unlistenResized?.();
      unlistenClose?.();
    };
  }, [isStandalone, isDragGhostWindow]);

  useEffect(() => {
    if (!isTauri()) return;
    if (isStandalone) return;

    const label = getCurrentWindowLabelSafe();
    if (label !== 'main') return;
    if (restoredWindowsRef.current) return;
    restoredWindowsRef.current = true;
    let disposed = false;

    const layout = readWindowLayout();
    const records = layout.windows.filter((w) => w.label !== 'main' && w.params?.standalone && w.params?.view);
    const preferredWorkstudioLabel =
      records
        .filter((w) => w.params?.view === 'workstudio')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.label ?? null;

    // 逐个恢复；openOrFocus 会自动去重（若窗口已存在则只聚焦）
    for (const w of records) {
      const view = w.params.view;
      if (!view) continue;
      void openOrFocusViewWindow(view, w.title || view, {
        focus: false,
        label: w.label,
        noDefaultSession: w.params.noDefaultSession,
        conversationId: w.params.conversationId ?? undefined,
        runMode: w.params.runMode ?? undefined,
        agentName: w.params.agentName ?? undefined,
        documentPath: w.params.documentPath ?? undefined,
        workstudioId: w.params.workstudioId ?? undefined,
        webUrl: w.params.webUrl ?? undefined,
        webTitle: w.params.webTitle ?? undefined,
        terminalWorkdir: w.params.terminalWorkdir ?? undefined,
        terminalTitle: w.params.terminalTitle ?? undefined,
        filePath: w.params.filePath ?? undefined,
        line: typeof w.params.line === 'number' ? w.params.line : undefined,
        column: typeof w.params.column === 'number' ? w.params.column : undefined,
        endLine: typeof w.params.endLine === 'number' ? w.params.endLine : undefined,
        endColumn: typeof w.params.endColumn === 'number' ? w.params.endColumn : undefined,
        window: w.bounds ?? undefined,
      }).catch(() => {
        // ignore: best-effort
      });
    }

    // 启动恢复后：若存在 Workstudio 窗口，优先把最新使用的 Workstudio 置前。
    if (preferredWorkstudioLabel) {
      void (async () => {
        const retryDelaysMs = [90, 180, 320, 500, 800, 1200];
        for (const delayMs of retryDelaysMs) {
          if (disposed) return;
          await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
          if (disposed) return;

          const win = await WebviewWindow.getByLabel(preferredWorkstudioLabel).catch(() => null);
          if (!win) continue;

          try {
            const minimized = await (win as any).isMinimized?.();
            if (minimized) {
              await (win as any).unminimize?.();
            }
          } catch {
            // ignore
          }
          try {
            await (win as any).show?.();
          } catch {
            // ignore
          }
          try {
            await win.setFocus();
            return;
          } catch {
            // ignore and retry
          }
        }
      })();
    }

    return () => {
      disposed = true;
    };
  }, [isStandalone]);

  /**
   * Menu: Session -> New/Clone/Settings
   * These are emitted from Rust and routed to the focused window (fallback to main).
   */
  useEffect(() => {
    if (!isTauri()) return;
    if (!shouldInitChatRuntime) return;

    let disposed = false;
    let unlistenNewAgent: null | (() => void) = null;
    let unlistenSettings: null | (() => void) = null;

    void listen<string>('menu:new_session_agent', (event) => {
      const agentName = typeof event.payload === 'string' ? event.payload : '';
      if (!agentName) return;
      void useSessionStore
        .getState()
        .createSession(agentName)
        .catch((e) => console.error('menu:new_session_agent failed:', e));
      useUIStore.getState().setActiveView('chat');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlistenNewAgent = fn;
      })
      .catch(() => { });

    void listen('menu:open_settings', () => {
      useUIStore.getState().setActiveView('settings');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlistenSettings = fn;
      })
      .catch(() => { });

    return () => {
      disposed = true;
      unlistenNewAgent?.();
      unlistenSettings?.();
    };
  }, [shouldInitChatRuntime]);

  /**
   * Menu: View -> History
   * Emitted from Rust and routed to the focused window (fallback to main).
   */
  useEffect(() => {
    if (!isTauri()) return;
    if (!shouldInitChatRuntime) return;

    let disposed = false;
    let unlistenHistory: null | (() => void) = null;
    let unlistenPractice: null | (() => void) = null;

    void listen('menu:open_history', () => {
      useUIStore.getState().setActiveView('history');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlistenHistory = fn;
      })
      .catch(() => { });

    void listen('menu:open_practice', () => {
      useUIStore.getState().setActiveView('practice');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlistenPractice = fn;
      })
      .catch(() => { });

    return () => {
      disposed = true;
      unlistenHistory?.();
      unlistenPractice?.();
    };
  }, [shouldInitChatRuntime]);

  /**
   * Menu: File -> Open File...
   * The native menu event is emitted from Rust as `menu:open_file`.
   */
  useEffect(() => {
    // Workstudio 需要把“打开文件”路由到自己的编辑器，而不是切换到全局 DocumentView。
    // 因此只在“非 workstudio 视图”监听这里的菜单事件（由 WorkstudioView 自己处理）。
    if (isWorkstudioWindow || activeView === 'workstudio') return;

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

        const docId = useDocumentStore.getState().openDocument({
          title: file.filename,
          path: selected,
          kind: 'text',
          content,
        });

        if (!shouldInitChatRuntime) {
          useUIStore.getState().setActiveView('document');
          return;
        }

        useWindowLayoutStore.getState().openTabInFocusedPane(docTabId(docId));
        useUIStore.getState().setActiveView('chat');
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
  }, [viewOverride, activeView, shouldInitChatRuntime]);

  /**
   * Menu: File -> New .tauri.richtxt
   * Create a new empty .tauri.richtxt document
   */
  useEffect(() => {
    // Workstudio 视图由 WorkstudioView 处理“新建 .tauri.richtxt”，
    // 这里仅在非 workstudio 视图下响应，避免主窗口与 Workstudio 同时创建。
    if (isWorkstudioWindow || activeView === 'workstudio') return;

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
      const docId = useDocumentStore.getState().openDocument({
        title,
        path: undefined,
        kind: 'text',
        content: '<!-- tauri.richtxt v1 -->\n\n# 新建文档\n\n',
      });

      if (!shouldInitChatRuntime) {
        useUIStore.getState().setActiveView('document');
        return;
      }

      useWindowLayoutStore.getState().openTabInFocusedPane(docTabId(docId));
      useUIStore.getState().setActiveView('chat');
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
  }, [viewOverride, activeView, shouldInitChatRuntime]);

  /**
   * Menu: File -> New Text File
   * Create a new empty .txt document
   */
  useEffect(() => {
    if (isWorkstudioWindow || activeView === 'workstudio') return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('menu:new_text', () => {
      const re = /^Untitled-(\d+)\.txt$/i;
      const docs = useDocumentStore.getState().documents;
      let max = 0;
      for (const d of docs) {
        const m = re.exec(d.title);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
      const title = `Untitled-${max + 1}.txt`;

      const docId = useDocumentStore.getState().openDocument({
        title,
        path: undefined,
        kind: 'text',
        content: '',
      });

      if (!shouldInitChatRuntime) {
        useUIStore.getState().setActiveView('document');
        return;
      }

      useWindowLayoutStore.getState().openTabInFocusedPane(docTabId(docId));
      useUIStore.getState().setActiveView('chat');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [viewOverride, activeView, shouldInitChatRuntime]);

  /**
   * Menu: View -> Open Web Tab
   * Open a web tab inside the workspace (Pane + Tab), instead of a standalone window.
   */
  useEffect(() => {
    if (!shouldInitChatRuntime) return;
    if (isWorkstudioWindow) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('menu:open_web_tab', () => {
      const id = useWebTabStore.getState().openWebTab('about:blank', { title: '网页', activate: true });
      useWindowLayoutStore.getState().openTabInFocusedPane(webTabId(id));
      useUIStore.getState().setActiveView('chat');
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // ignore in non-Tauri environments
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [viewOverride, activeView, shouldInitChatRuntime]);

  /**
   * Menu: View -> Open Terminal Tab
   * Open a terminal tab inside the workspace (Pane + Tab), instead of a standalone window.
   */
  useEffect(() => {
    if (!shouldInitChatRuntime) return;
    if (isWorkstudioWindow) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('menu:open_terminal_tab', () => {
      void (async () => {
        const workdir = await resolveActiveWorkstudioMainFolder();
        const id = useTerminalTabStore.getState().openTerminalTab({
          title: '终端',
          workdir: workdir ?? undefined,
          activate: true,
        });
        useWindowLayoutStore.getState().openTabInFocusedPane(terminalTabId(id));
        useUIStore.getState().setActiveView('chat');
      })();
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // ignore in non-Tauri environments
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [viewOverride, activeView, shouldInitChatRuntime]);

  /**
   * Standalone window: 兼容旧的 `view=` 语义，把 document/web/terminal 映射到工作区 Tab。
   */
  useEffect(() => {
    if (!isStandalone) return;
    if (!viewOverride) return;
    if (initialStandaloneTabsAppliedRef.current) return;

    void (async () => {
      if (viewOverride === 'document') {
        if (!documentPathOverride) return;
        initialStandaloneTabsAppliedRef.current = true;
        try {
          const file = await invoke<{
            filename: string;
            mime: string;
            base64: string;
            size: number;
          }>('read_local_file_base64', { path: documentPathOverride });

          const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
          const content = new TextDecoder('utf-8').decode(bytes);

          const docId = useDocumentStore.getState().openDocument({
            title: file.filename,
            path: documentPathOverride,
            kind: 'text',
            content,
          });

          useWindowLayoutStore.getState().openTabInFocusedPane(docTabId(docId));
          useUIStore.getState().setActiveView('chat');
        } catch (error) {
          console.error('Failed to open document in standalone window:', error);
        }
        return;
      }

      if (viewOverride === 'web') {
        if (!webUrlOverride) return;
        initialStandaloneTabsAppliedRef.current = true;
        const wid = useWebTabStore.getState().openWebTab(webUrlOverride, {
          title: webTitleOverride ?? undefined,
          activate: true,
        });
        useWindowLayoutStore.getState().openTabInFocusedPane(webTabId(wid));
        useUIStore.getState().setActiveView('chat');
        return;
      }

      if (viewOverride === 'terminal') {
        initialStandaloneTabsAppliedRef.current = true;
        const tid = useTerminalTabStore.getState().openTerminalTab({
          title: terminalTitleOverride ?? undefined,
          workdir: terminalWorkdirOverride ?? undefined,
          activate: true,
        });
        useWindowLayoutStore.getState().openTabInFocusedPane(terminalTabId(tid));
        useUIStore.getState().setActiveView('chat');
        return;
      }
    })();
  }, [
    isStandalone,
    viewOverride,
    documentPathOverride,
    webUrlOverride,
    webTitleOverride,
    terminalWorkdirOverride,
    terminalTitleOverride,
  ]);

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
    if (isDragGhostWindow) return;
    // Initialize chat stream listeners only for chat-capable windows.
    if (shouldInitChatRuntime) {
      initStreamListeners();
    }
    // Load configuration from backend
    loadConfig().catch((err) => {
      console.error('Failed to load config:', err);
    });
    if (shouldInitChatRuntime) {
      // Load conversations from backend
      loadConversations()
        .catch((err) => {
          console.error('Failed to load conversations:', err);
        });
    }
  }, [loadConfig, loadConversations, shouldInitChatRuntime, isDragGhostWindow]);

  // ---------------------------------------------------------------------------
  // 配置同步（跨窗口）
  // - Settings 在主窗口修改 config 后，独立 Workstudio 窗口需要更新自己的 configStore
  // - 反过来同理：Workstudio 保存的配置也应通知主窗口刷新
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;
    if (isDragGhostWindow) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('app_config:changed', () => {
      if (disposed) return;
      // 小延迟：避免与 save debounce/队列写入产生竞态，尽量读取到最新落盘内容。
      window.setTimeout(() => {
        if (disposed) return;
        void useConfigStore.getState().loadConfig();
      }, 50);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error('listen app_config:changed failed:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDragGhostWindow]);

  // ---------------------------------------------------------------------------
  // Workstudio -> Main window: insert plain text into chat draft
  // - Legacy / misc: non-chip inserts
  // - Main window receives 'chat:insert_text' events and appends to the active chat draft
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;
    if (!shouldInitChatRuntime) return;
    if (isDragGhostWindow) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('chat:insert_text', (event) => {
      if (disposed) return;
      const payload = (event as any)?.payload ?? null;
      const text = String(payload?.text ?? '').trim();
      if (!text) return;

      const layout = useWindowLayoutStore.getState();
      const panes = layout.panes ?? [];
      const focusedPaneId = layout.focusedPaneId;
      const pane =
        (focusedPaneId ? panes.find((p) => p.id === focusedPaneId) : null) ?? panes[0] ?? null;
      const activeTabIdRaw =
        pane?.activeTabId && pane.tabIds.includes(pane.activeTabId)
          ? pane.activeTabId
          : pane?.tabIds[0] ?? null;

      const sessionStore = useSessionStore.getState();
      const sessions = sessionStore.sessions;

      const fromFocusedPane =
        typeof activeTabIdRaw === 'string' && activeTabIdRaw.startsWith('chat:')
          ? activeTabIdRaw.slice('chat:'.length)
          : '';
      const candidateSessionId = fromFocusedPane || sessionStore.activeSessionId || '';

      const targetSessionId = (() => {
        const sid = candidateSessionId.trim();
        if (sid && sessions.has(sid)) return sid;
        const first = sessions.keys().next().value as string | undefined;
        return first && sessions.has(first) ? first : null;
      })();

      if (!targetSessionId) return;

      const prevDraft = sessions.get(targetSessionId)?.draftContent ?? '';
      const nextDraft = prevDraft ? `${prevDraft}${prevDraft.endsWith('\n') ? '' : '\n'}${text}` : text;

      sessionStore.setSessionDraftContent(targetSessionId, nextDraft);
      useWindowLayoutStore.getState().openTabInFocusedPane(chatTabId(targetSessionId));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error('listen chat:insert_text failed:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDragGhostWindow, shouldInitChatRuntime]);

  // ---------------------------------------------------------------------------
  // Workstudio -> Main window: insert workspace mention chip into chat draft
  // - Used by Workstudio explorer context menu (“加入到 Chat”)
  // - Payload includes absPath + label (InputArea renders @{ref:<uuid>} as a chip)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;
    if (!shouldInitChatRuntime) return;
    if (isDragGhostWindow) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('chat:insert_workspace_mention', (event) => {
      if (disposed) return;
      const payload = (event as any)?.payload ?? null;
      const absPath = String(payload?.absPath ?? '').trim();
      const label = String(payload?.label ?? '').trim() || absPath.split('/').pop() || absPath;
      if (!absPath) return;

      const layout = useWindowLayoutStore.getState();
      const panes = layout.panes ?? [];
      const focusedPaneId = layout.focusedPaneId;
      const pane =
        (focusedPaneId ? panes.find((p) => p.id === focusedPaneId) : null) ?? panes[0] ?? null;
      const activeTabIdRaw =
        pane?.activeTabId && pane.tabIds.includes(pane.activeTabId)
          ? pane.activeTabId
          : pane?.tabIds[0] ?? null;

      const sessionStore = useSessionStore.getState();
      const sessions = sessionStore.sessions;

      const fromFocusedPane =
        typeof activeTabIdRaw === 'string' && activeTabIdRaw.startsWith('chat:')
          ? activeTabIdRaw.slice('chat:'.length)
          : '';
      const candidateSessionId = fromFocusedPane || sessionStore.activeSessionId || '';

      const targetSessionId = (() => {
        const sid = candidateSessionId.trim();
        if (sid && sessions.has(sid)) return sid;
        const first = sessions.keys().next().value as string | undefined;
        return first && sessions.has(first) ? first : null;
      })();

      if (!targetSessionId) return;

      const prevDraft = sessions.get(targetSessionId)?.draftContent ?? '';
      const prevMentions = sessions.get(targetSessionId)?.draftWorkspaceMentions ?? [];

      const existing = prevMentions.find((m) => m.absPath === absPath) ?? null;
      const id = existing?.id ?? crypto.randomUUID();
      const token = `@{ref:${id}}`;
      const mention: WorkspaceMentionChip = { id, absPath, label };
      const nextMentions = existing ? prevMentions : [...prevMentions, mention];

      const spacer = prevDraft && !/\s$/.test(prevDraft) ? ' ' : '';
      const nextDraft = prevDraft ? `${prevDraft}${spacer}${token} ` : `${token} `;

      sessionStore.setSessionDraftContent(targetSessionId, nextDraft);
      sessionStore.setSessionDraftWorkspaceMentions(targetSessionId, nextMentions);
      useWindowLayoutStore.getState().openTabInFocusedPane(chatTabId(targetSessionId));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error('listen chat:insert_workspace_mention failed:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDragGhostWindow, shouldInitChatRuntime]);

  // ---------------------------------------------------------------------------
  // Workstudio -> Main window: insert code snippet chip into chat draft
  // - Used by Workstudio editor context menu (“Add to chat”)
  // - Payload includes token + code snippet content part (backend will replace token with code)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;
    if (!shouldInitChatRuntime) return;
    if (isDragGhostWindow) return;

    let disposed = false;
    let unlisten: null | (() => void) = null;

    void listen('chat:insert_code_snippet', (event) => {
      if (disposed) return;
      const payload = (event as any)?.payload ?? null;
      const tokenRaw = String(payload?.token ?? '').trim();
      const snippetRaw = payload?.snippet ?? null;
      const id = String(snippetRaw?.id ?? '').trim();
      const text = String(snippetRaw?.text ?? '');
      const label = String(snippetRaw?.label ?? '').trim();
      const languageId = String(snippetRaw?.languageId ?? '').trim() || undefined;
      const filePath = String(snippetRaw?.filePath ?? '').trim() || undefined;
      const rangeRaw = snippetRaw?.range ?? null;
      const range =
        rangeRaw &&
          typeof rangeRaw.startLine === 'number' &&
          typeof rangeRaw.startColumn === 'number' &&
          typeof rangeRaw.endLine === 'number' &&
          typeof rangeRaw.endColumn === 'number'
          ? {
            startLine: rangeRaw.startLine,
            startColumn: rangeRaw.startColumn,
            endLine: rangeRaw.endLine,
            endColumn: rangeRaw.endColumn,
          }
          : undefined;

      if (!id || !text) return;
      const token = tokenRaw && tokenRaw.includes(id) ? tokenRaw : `@{snippet:${id}}`;
      const snippet: CodeSnippetContentPart = {
        type: 'code_snippet',
        id,
        label: label || `代码片段 ${id.slice(0, 8)}`,
        text,
        languageId,
        filePath,
        range,
      };

      const layout = useWindowLayoutStore.getState();
      const panes = layout.panes ?? [];
      const focusedPaneId = layout.focusedPaneId;
      const pane =
        (focusedPaneId ? panes.find((p) => p.id === focusedPaneId) : null) ?? panes[0] ?? null;
      const activeTabIdRaw =
        pane?.activeTabId && pane.tabIds.includes(pane.activeTabId)
          ? pane.activeTabId
          : pane?.tabIds[0] ?? null;

      const sessionStore = useSessionStore.getState();
      const sessions = sessionStore.sessions;

      const fromFocusedPane =
        typeof activeTabIdRaw === 'string' && activeTabIdRaw.startsWith('chat:')
          ? activeTabIdRaw.slice('chat:'.length)
          : '';
      const candidateSessionId = fromFocusedPane || sessionStore.activeSessionId || '';

      const targetSessionId = (() => {
        const sid = candidateSessionId.trim();
        if (sid && sessions.has(sid)) return sid;
        const first = sessions.keys().next().value as string | undefined;
        return first && sessions.has(first) ? first : null;
      })();

      if (!targetSessionId) return;

      const prevDraft = sessions.get(targetSessionId)?.draftContent ?? '';
      const spacer = prevDraft && !/\s$/.test(prevDraft) ? ' ' : '';
      const nextDraft = prevDraft ? `${prevDraft}${spacer}${token} ` : `${token} `;

      const prevSnips = sessions.get(targetSessionId)?.draftCodeSnippets ?? [];
      const nextSnips = prevSnips.some((s) => s.id === id) ? prevSnips : [...prevSnips, snippet];

      sessionStore.setSessionDraftContent(targetSessionId, nextDraft);
      sessionStore.setSessionDraftCodeSnippets(targetSessionId, nextSnips);
      useWindowLayoutStore.getState().openTabInFocusedPane(chatTabId(targetSessionId));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error('listen chat:insert_code_snippet failed:', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDragGhostWindow, shouldInitChatRuntime]);

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
        return;
      }

      // Prevent duplicate initialization
      if (sessionInitialized.current) return;
      sessionInitialized.current = true;

      // Restore previous sessions from localStorage
      try {
        await restoreSessionState();
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
      if (currentSessions.size === 0) {
        const skipDefaultSession =
          isStandalone &&
          (noDefaultSession ||
            Boolean(conversationIdOverride) ||
            (viewOverride !== null &&
              viewOverride !== undefined &&
              viewOverride !== 'chat' &&
              viewOverride !== 'history' &&
              viewOverride !== 'settings'));

        if (skipDefaultSession) return;
        const defaultAgent = config.defaultAgent || config.agents?.[0]?.name;
        if (defaultAgent) {
          try {
            await createSession(defaultAgent);
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
    noDefaultSession,
    agentNameOverride,
    runModeOverride,
    loadConversations,
  ]);

  // 事件监听器已在 sessionStore 模块初始化时自动设置，无需在组件中处理

  /**
   * Render the active view based on UI state
   * Requirements: 2.1-2.6
   */
  const resolvedView = activeView;
  const viewDef = getViewDefinition(resolvedView) || getViewDefinition('chat');
  const isChatActive = (viewDef?.id ?? 'chat') === 'chat';

  useEffect(() => {
    if (!viewOverride) return;
    if (viewOverrideAppliedRef.current) return;
    viewOverrideAppliedRef.current = true;

    // 兼容旧的 standalone window 语义：
    // - history/settings/practice：作为初始 activeView
    // - document/web/terminal/workstudio：视为“在工作区内打开一个 Tab”，activeView 仍为 chat
    if (viewOverride === 'history' || viewOverride === 'settings' || viewOverride === 'practice') {
      if (viewOverride !== activeView) setActiveView(viewOverride);
      return;
    }

    if (viewOverride === 'workstudio') {
      if (activeView !== 'workstudio') setActiveView('workstudio');
      return;
    }

    if (activeView !== 'chat') setActiveView('chat');
  }, [viewOverride, activeView, setActiveView]);

  // ChatView keep-alive:
  // - 在主窗口内切换到 History/Settings 等视图时，不卸载 ChatView（避免滚动/定位在重建时漂移）
  // - 仅通过可见性与 pointer-events 控制展示，保证回到聊天时“像没离开一样”
  useEffect(() => {
    if (isChatActive) return;

    const chatLayer = chatKeepAliveLayerRef.current;
    const active = document.activeElement;
    if (!chatLayer || !active) return;
    if (!(active instanceof HTMLElement)) return;
    if (chatLayer.contains(active)) {
      active.blur();
    }
  }, [isChatActive]);

  const renderNonChatView = () => {
    if (isChatActive) return null;
    if (viewDef?.id === 'chat') return null;
    return viewDef?.render() ?? null;
  };

  if (isDragGhostWindow) {
    return (
      <>
        <DragGhostView />
        <GlobalErrorModal />
      </>
    );
  }

  if (isWorkstudioWindow) {
    return (
      <StandaloneLayout title="Workstudio">
        <WorkstudioView workstudioId={workstudioIdOverride} />
        <GlobalErrorModal />
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
      <GlobalErrorModal />
    </MainLayout>
  );
}

export default App;
