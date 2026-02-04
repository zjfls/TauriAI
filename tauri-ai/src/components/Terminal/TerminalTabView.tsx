import React from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Plus, TerminalSquare } from 'lucide-react';
import { useTerminalTabStore } from '../../stores/terminalTabStore';
import { useWorkspaceLayoutStore } from '../../stores/workspaceLayoutStore';
import { terminalTabId as toWorkspaceTerminalTabId } from '../../stores/workspaceTabStore';
import { resolveActiveWorkstudioMainFolder } from '../../utils/terminalWorkdir';
import { TerminalSurface } from './TerminalSurface';

export const TerminalTabView: React.FC<{ terminalTabId: string; isActive?: boolean }> = ({
  terminalTabId,
  isActive = true,
}) => {
  const tab = useTerminalTabStore((s) => s.tabs.find((t) => t.id === terminalTabId) ?? null);
  const openTerminalTab = useTerminalTabStore((s) => s.openTerminalTab);

  const createTab = () => {
    void (async () => {
      const workdir = await resolveActiveWorkstudioMainFolder();
      const id = openTerminalTab({ workdir: workdir ?? undefined, activate: true });
      useWorkspaceLayoutStore.getState().openTabInFocusedPane(toWorkspaceTerminalTabId(id));
    })();
  };

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

      <TerminalSurface
        scope={{ kind: 'workspace_terminal', id: terminalTabId }}
        workdir={tab.workdir ?? null}
        isActive={isActive}
        autoConnect
        className="flex-1 overflow-hidden bg-white dark:bg-gray-900"
      />
    </div>
  );
};

export default TerminalTabView;
