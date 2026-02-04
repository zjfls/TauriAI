import React, { useEffect, useMemo, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Plus, TerminalSquare, X } from 'lucide-react';
import { useTerminalTabStore } from '../../stores/terminalTabStore';
import { getViewWindowParams } from '../../utils/viewWindow';
import { TerminalSurface } from './TerminalSurface';

export const TerminalView: React.FC = () => {
  const tabs = useTerminalTabStore((s) => s.tabs);
  const activeTabId = useTerminalTabStore((s) => s.activeTabId);
  const openTerminalTab = useTerminalTabStore((s) => s.openTerminalTab);
  const setActiveTerminalTab = useTerminalTabStore((s) => s.setActiveTerminalTab);
  const closeTerminalTab = useTerminalTabStore((s) => s.closeTerminalTab);
  const bootstrappedFromWindowParamsRef = useRef(false);

  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  }, [tabs, activeTabId]);

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

      {tabs.length > 0 && (
        <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600">
            {tabs.map((t) => {
              const active = t.id === activeTabId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTerminalTab(t.id)}
                  className={[
                    'group flex items-center gap-2 rounded px-2 py-1 text-xs',
                    active
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700',
                  ].join(' ')}
                  title={t.title}
                >
                  <span className="max-w-[200px] truncate">{t.title}</span>
                  <span
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-600 dark:hover:text-gray-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTerminalTab(t.id);
                    }}
                    role="button"
                    aria-label="close"
                    title="关闭"
                  >
                    <X size={12} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

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
                className={`absolute inset-0 ${cls}`}
              >
                <TerminalSurface
                  scope={{ kind: 'workspace_terminal', id: t.id }}
                  workdir={t.workdir ?? null}
                  isActive={isActive}
                  autoConnect={isActive}
                  className="h-full w-full bg-white dark:bg-gray-900"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TerminalView;
