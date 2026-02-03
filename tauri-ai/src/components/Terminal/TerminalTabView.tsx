import React, { useCallback, useEffect, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { Plus, TerminalSquare } from 'lucide-react';
import { useTerminalTabStore } from '../../stores/terminalTabStore';
import { useWorkspaceLayoutStore } from '../../stores/workspaceLayoutStore';
import { terminalTabId as toWorkspaceTerminalTabId } from '../../stores/workspaceTabStore';

const decodeBase64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export const TerminalTabView: React.FC<{ terminalTabId: string; isActive?: boolean }> = ({
  terminalTabId,
  isActive = true,
}) => {
  const tab = useTerminalTabStore((s) => s.tabs.find((t) => t.id === terminalTabId) ?? null);
  const openTerminalTab = useTerminalTabStore((s) => s.openTerminalTab);
  const ensureTerminalSession = useTerminalTabStore((s) => s.ensureTerminalSession);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<number | null>(null);
  const activeRef = useRef<boolean>(isActive);

  useEffect(() => {
    activeRef.current = isActive;
  }, [isActive]);

  const ensureSessionId = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const sid = await ensureTerminalSession(terminalTabId);
    if (sid) sessionIdRef.current = sid;
    return sid;
  }, [ensureTerminalSession, terminalTabId]);

  const createTab = () => {
    const id = openTerminalTab({ activate: true });
    useWorkspaceLayoutStore.getState().openTabInFocusedPane(toWorkspaceTerminalTabId(id));
  };

  useEffect(() => {
    if (!isTauri()) return;
    if (!containerRef.current) return;
    if (!tab) return;
    if (termRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: document.documentElement.classList.contains('dark')
        ? { background: '#0b0f19', foreground: '#e5e7eb' }
        : { background: '#ffffff', foreground: '#111827' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // ignore
    }

    termRef.current = term;
    fitRef.current = fit;

    const disposeData = term.onData((data) => {
      if (!isTauri()) return;
      void (async () => {
        const sid = await ensureSessionId();
        if (!sid) return;
        await invoke('workstudio_terminal_write', { workstudioId: terminalTabId, sessionId: sid, chars: data });
      })();
    });

    let cancelled = false;
    let timer: number | null = null;

    const pump = async () => {
      if (cancelled) return;
      try {
        const sid = await ensureSessionId();
        if (!sid) return;

        const timeoutMs = activeRef.current ? 1000 : 0;
        const base64 = await invoke<string>('workstudio_terminal_read_base64', {
          workstudioId: terminalTabId,
          sessionId: sid,
          timeoutMs,
          maxBytes: 64 * 1024,
        });

        if (cancelled) return;
        if (base64) {
          const bytes = decodeBase64ToBytes(base64);
          term.write(bytes);
        }
      } catch {
        // ignore
      } finally {
        if (cancelled) return;
        const nextDelay = activeRef.current ? 0 : 600;
        timer = window.setTimeout(pump, nextDelay);
      }
    };

    timer = window.setTimeout(pump, 20);

    const stop = () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      try {
        disposeData.dispose();
      } catch {
        // ignore
      }
      try {
        term.dispose();
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
      sessionIdRef.current = null;
    };

    return () => stop();
  }, [ensureSessionId, tab, terminalTabId]);

  // Fit on resize and when activated.
  useEffect(() => {
    if (!isTauri()) return;
    const onResize = () => {
      const fit = fitRef.current;
      if (!fit) return;
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    if (!isActive) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    window.setTimeout(() => {
      try {
        fit.fit();
        term.focus();
      } catch {
        // ignore
      }
    }, 30);
  }, [isActive, terminalTabId]);

  if (!isTauri()) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 dark:bg-gray-900 p-8">
        <div className="max-w-md rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">
            <TerminalSquare size={18} />
          </div>
          <div className="text-base font-medium text-gray-800 dark:text-gray-100">终端仅桌面版可用</div>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            当前不是 Tauri 运行环境，无法启动本地 PTY 终端。
          </div>
        </div>
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
            <TerminalSquare size={16} className="text-blue-600 dark:text-blue-300" />
            终端
          </div>
          <button
            type="button"
            onClick={createTab}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title="新建终端"
          >
            <Plus size={12} />
            新建
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-gray-500 dark:text-gray-400">
          该终端标签已关闭
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
          <TerminalSquare size={16} className="text-blue-600 dark:text-blue-300" />
          终端
        </div>
        <button
          type="button"
          onClick={createTab}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          title="新建终端"
        >
          <Plus size={12} />
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-hidden bg-white dark:bg-gray-900" />
    </div>
  );
};

export default TerminalTabView;
