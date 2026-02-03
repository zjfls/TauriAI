import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, ExternalLink, Plus } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useWebTabStore } from '../../stores/webTabStore';
import { getViewWindowParams } from '../../utils/viewWindow';

const normalizeDisplayUrl = (url: string) => {
  const u = (url ?? '').trim();
  if (!u) return '';
  return u === 'about:blank' ? '' : u;
};

export const WebView: React.FC = () => {
  const tabs = useWebTabStore((s) => s.tabs);
  const activeTabId = useWebTabStore((s) => s.activeTabId);
  const openWebTab = useWebTabStore((s) => s.openWebTab);
  const setActiveWebTab = useWebTabStore((s) => s.setActiveWebTab);
  const updateWebTab = useWebTabStore((s) => s.updateWebTab);
  const bootstrappedFromWindowParamsRef = useRef(false);

  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  }, [tabs, activeTabId]);

  const [address, setAddress] = useState('');

  useEffect(() => {
    if (bootstrappedFromWindowParamsRef.current) return;
    if (tabs.length > 0) {
      bootstrappedFromWindowParamsRef.current = true;
      return;
    }

    const params = getViewWindowParams();
    const url = (params.webUrl ?? '').trim();
    const title = (params.webTitle ?? '').trim();
    if (!url) return;

    bootstrappedFromWindowParamsRef.current = true;
    const id = openWebTab(url, { title: title || undefined, activate: true });
    setActiveWebTab(id);
  }, [openWebTab, setActiveWebTab, tabs.length]);

  useEffect(() => {
    setAddress(activeTab ? normalizeDisplayUrl(activeTab.url) : '');
  }, [activeTab?.id]);

  const createTabAndOpen = () => {
    const input = address.trim();
    const id = openWebTab(input || 'about:blank');
    setActiveWebTab(id);
  };

  const updateActiveUrl = () => {
    if (!activeTab) return;
    updateWebTab(activeTab.id, { url: address.trim() || 'about:blank' });
  };

  if (!activeTab) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
            <Globe size={16} className="text-blue-600 dark:text-blue-300" />
            网页
          </div>
          <button
            type="button"
            onClick={() => openWebTab('about:blank')}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title="新建网页标签"
          >
            <Plus size={12} />
            新建
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-xl rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">
              <Globe size={18} />
            </div>
            <div className="text-base font-medium text-gray-800 dark:text-gray-100">打开网页</div>
            <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              在下方输入网址，或在聊天里点击链接自动打开。
            </div>

            <div className="mt-4 flex gap-2">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createTabAndOpen();
                }}
                placeholder="https://example.com"
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={createTabAndOpen}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                打开
              </button>
            </div>
          </div>
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
          onClick={() => openWebTab('about:blank')}
          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          title="新建标签"
        >
          <Plus size={12} />
        </button>

        <button
          type="button"
          onClick={() => {
            if (!isTauri()) return;
            void openUrl(activeTab.url);
          }}
          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          disabled={!isTauri() || !activeTab.url || activeTab.url === 'about:blank'}
          title="在系统浏览器打开"
        >
          <ExternalLink size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <iframe
          key={activeTab.id}
          src={activeTab.url}
          title={activeTab.title}
          className="h-full w-full bg-white dark:bg-gray-900"
        />
      </div>

      <div className="border-t border-gray-200 bg-white px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        说明：部分网站可能禁止被嵌入（X-Frame-Options / frame-ancestors），若无法显示请点击右侧按钮在系统浏览器打开。
      </div>
    </div>
  );
};

export default WebView;
