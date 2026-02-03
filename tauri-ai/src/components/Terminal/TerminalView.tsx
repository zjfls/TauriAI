import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { Plus, TerminalSquare } from 'lucide-react';
import { useTerminalTabStore } from '../../stores/terminalTabStore';
import { getViewWindowParams } from '../../utils/viewWindow';

const decodeBase64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export const TerminalView: React.FC = () => {
  const tabs = useTerminalTabStore((s) => s.tabs);
  const activeTabId = useTerminalTabStore((s) => s.activeTabId);
  const openTerminalTab = useTerminalTabStore((s) => s.openTerminalTab);
  const setActiveTerminalTab = useTerminalTabStore((s) => s.setActiveTerminalTab);
  const ensureTerminalSession = useTerminalTabStore((s) => s.ensureTerminalSession);
  const bootstrappedFromWindowParamsRef = useRef(false);

  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  }, [tabs, activeTabId]);

  const containerByIdRef = useRef(new Map<string, HTMLDivElement>());
  const termByIdRef = useRef(new Map<string, XTerm>());
  const fitByIdRef = useRef(new Map<string, FitAddon>());
  const readLoopStopByIdRef = useRef(new Map<string, () => void>());
  const mountedIdsRef = useRef(new Set<string>());

  const createTab = () => {
    const id = openTerminalTab();
    setActiveTerminalTab(id);
  };

  useEffect(() => {
    if (bootstrappedFromWindowParamsRef.current) return;
    if (tabs.length > 0) {
      bootstrappedFromWindowParamsRef.current = true;
      return;
    }

    const params = getViewWindowParams();
    const workdir = (params.terminalWorkdir ?? '').trim();
    const title = (params.terminalTitle ?? '').trim();
    if (!workdir && !title) return;

    bootstrappedFromWindowParamsRef.current = true;
    const id = openTerminalTab({
      title: title || undefined,
      workdir: workdir || undefined,
      activate: true,
    });
    setActiveTerminalTab(id);
  }, [openTerminalTab, setActiveTerminalTab, tabs.length]);

  const ensureTerminal = useCallback(
    (tabId: string, el: HTMLDivElement) => {
      if (termByIdRef.current.has(tabId)) return;

      const term = new XTerm({
        cursorBlink: true,
        scrollback: 3000,
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
      term.open(el);
      try {
        fit.fit();
      } catch {
        // ignore
      }

      termByIdRef.current.set(tabId, term);
      fitByIdRef.current.set(tabId, fit);

      const disposeData = term.onData((data) => {
        if (!isTauri()) return;
        void ensureTerminalSession(tabId).then((sid) => {
          if (!sid) return;
          return invoke('terminal_write', { terminalId: tabId, sessionId: sid, chars: data });
        });
      });

      // Poll output in background; keep timeouts short to reduce lock contention.
      let cancelled = false;
      let timer: number | null = null;

      const tick = async () => {
        if (cancelled) return;
        try {
          if (!isTauri()) return;
          const sid = await ensureTerminalSession(tabId);
          if (!sid) return;
          const base64 = await invoke<string>('terminal_read_base64', {
            terminalId: tabId,
            sessionId: sid,
            timeoutMs: 80,
            maxBytes: 64 * 1024,
          });
          if (cancelled) return;
          if (!base64) return;
          const bytes = decodeBase64ToBytes(base64);
          term.write(bytes);
        } catch {
          // ignore
        } finally {
          if (!cancelled) timer = window.setTimeout(tick, 250);
        }
      };

      timer = window.setTimeout(tick, 50);

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
        termByIdRef.current.delete(tabId);
        fitByIdRef.current.delete(tabId);
      };

      readLoopStopByIdRef.current.set(tabId, stop);
    },
    [ensureTerminalSession]
  );

  const setContainerRef = useCallback(
    (tabId: string) => (el: HTMLDivElement | null) => {
      if (el) {
        containerByIdRef.current.set(tabId, el);
        if (isTauri()) ensureTerminal(tabId, el);
      } else {
        containerByIdRef.current.delete(tabId);
      }
    },
    [ensureTerminal]
  );

  // Fit active terminal on resize.
  useEffect(() => {
    if (!isTauri()) return;
    const onResize = () => {
      if (!activeTabId) return;
      const fit = fitByIdRef.current.get(activeTabId);
      if (!fit) return;
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeTabId]);

  // When switching active tab, focus & fit.
  useEffect(() => {
    if (!activeTabId) return;
    const fit = fitByIdRef.current.get(activeTabId);
    const term = termByIdRef.current.get(activeTabId);
    if (!fit || !term) return;
    window.setTimeout(() => {
      try {
        fit.fit();
        term.focus();
      } catch {
        // ignore
      }
    }, 30);
  }, [activeTabId]);

  // Cleanup removed tabs (closed via workspace tab bar).
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    for (const id of Array.from(mountedIdsRef.current)) {
      if (currentIds.has(id)) continue;
      mountedIdsRef.current.delete(id);
      const stop = readLoopStopByIdRef.current.get(id);
      if (stop) {
        readLoopStopByIdRef.current.delete(id);
        stop();
      }
    }
  }, [tabs]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      for (const stop of readLoopStopByIdRef.current.values()) {
        stop();
      }
      readLoopStopByIdRef.current.clear();
      containerByIdRef.current.clear();
      mountedIdsRef.current.clear();
    };
  }, []);

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

      {!activeTab ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-xl rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">
              <TerminalSquare size={18} />
            </div>
            <div className="text-base font-medium text-gray-800 dark:text-gray-100">新建终端</div>
            <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">点击右上角“新建”创建一个终端标签。</div>
          </div>
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden">
          {tabs.map((t) => {
            const isActive = t.id === activeTab.id;
            const cls = isActive ? '' : 'invisible pointer-events-none';
            return (
              <div
                key={t.id}
                ref={(el) => {
                  if (el) {
                    mountedIdsRef.current.add(t.id);
                  }
                  setContainerRef(t.id)(el);
                }}
                className={`absolute inset-0 ${cls}`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TerminalView;
