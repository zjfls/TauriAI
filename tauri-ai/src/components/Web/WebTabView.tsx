import React, { useEffect, useState } from 'react';
import { Globe, ExternalLink, Plus } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useWebTabStore } from '../../stores/webTabStore';
import { useWorkspaceLayoutStore } from '../../stores/workspaceLayoutStore';
import { webTabId as toWorkspaceWebTabId } from '../../stores/workspaceTabStore';

const normalizeDisplayUrl = (url: string) => {
  const u = (url ?? '').trim();
  if (!u) return '';
  return u === 'about:blank' ? '' : u;
};

export const WebTabView: React.FC<{ webTabId: string }> = ({ webTabId }) => {
  const tab = useWebTabStore(
    (s) => s.tabs.find((t) => t.id === webTabId) ?? null
  );
  const updateWebTab = useWebTabStore((s) => s.updateWebTab);
  const openWebTab = useWebTabStore((s) => s.openWebTab);

  const [address, setAddress] = useState('');

  useEffect(() => {
    if (!tab) return;
    setAddress(normalizeDisplayUrl(tab.url));
  }, [tab?.id, tab?.url]);

  const updateActiveUrl = () => {
    if (!tab) return;
    updateWebTab(tab.id, { url: address.trim() || 'about:blank' });
  };

  const createTabAndOpen = () => {
    const input = address.trim();
    const id = openWebTab(input || 'about:blank', { activate: true });
    useWorkspaceLayoutStore.getState().openTabInFocusedPane(toWorkspaceWebTabId(id));
  };

  if (!tab) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
            <Globe size={16} className="text-blue-600 dark:text-blue-300" />
            网页
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-gray-500 dark:text-gray-400">
          该网页标签已关闭
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
        <Globe size={16} className="text-blue-600 dark:text-blue-300" />

        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') updateActiveUrl();
          }}
          placeholder="https://example.com"
          className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />

        <button
          type="button"
          onClick={updateActiveUrl}
          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          title="加载"
        >
          加载
        </button>

        <button
          type="button"
          onClick={createTabAndOpen}
          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          title="新建网页标签"
        >
          <Plus size={12} />
        </button>

        <button
          type="button"
          onClick={() => {
            if (!isTauri()) return;
            void openUrl(tab.url);
          }}
          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          disabled={!isTauri() || !tab.url || tab.url === 'about:blank'}
          title="在系统浏览器打开"
        >
          <ExternalLink size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <iframe
          key={tab.id}
          src={tab.url}
          title={tab.title}
          className="h-full w-full bg-white dark:bg-gray-900"
        />
      </div>

      <div className="border-t border-gray-200 bg-white px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        说明：部分网站可能禁止被嵌入（X-Frame-Options / frame-ancestors），若无法显示请点右侧按钮在系统浏览器打开。
      </div>
    </div>
  );
};

export default WebTabView;
