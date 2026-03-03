import React, { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Workstudio } from '../../types';
import { getViewWindowParams, openViewWindow } from '../../utils/viewWindow';

export const WindowTestView: React.FC = () => {
  const windowParams = useMemo(() => getViewWindowParams(), []);
  const view = windowParams.view || '(none)';
  const standalone = windowParams.standalone ? '1' : '(none)';
  const [workstudioLoading, setWorkstudioLoading] = useState(false);
  const [lastEvent, setLastEvent] = useState<string>('');

  const currentLabel = useMemo(() => {
    try {
      return getCurrentWebviewWindow().label;
    } catch {
      return '(unknown)';
    }
  }, []);

  const openWindowWithDiagnostics = (
    label: string,
    title: string,
    create: () => ReturnType<typeof openViewWindow> | null
  ) => {
    setLastEvent(`creating window: label=${label} title=${title}`);
    try {
      const win = create();
      if (!win) return null;

      // These events are the most reliable way to learn *why* creation failed.
      // See https://tauri.app/reference/javascript/api/namespaces/webviewwindow/
      win.once('tauri://created', () => {
        setLastEvent(`created: label=${label}`);
      });
      win.once('tauri://error', (e) => {
        setLastEvent(`error: label=${label} payload=${JSON.stringify((e as any)?.payload)}`);
      });

      return win;
    } catch (e) {
      setLastEvent(`exception: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  return (
    <div className="h-full w-full bg-white dark:bg-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          多窗口测试页
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          这个页面用于验证：新窗口创建、路由参数、standalone 模式是否正常。
        </p>

        <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          <div>window.label: {currentLabel}</div>
          <div>query.view: {view}</div>
          <div>query.standalone: {standalone}</div>
          <div className="mt-2 break-all text-xs text-gray-500 dark:text-gray-400">
            location.href: {window.location.href}
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              const label = `view-window_test-${Date.now()}`;
              openWindowWithDiagnostics(label, 'Window Test', () =>
                openViewWindow('window_test', 'Window Test', { label, window: { width: 900, height: 700 } })
              );
            }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            前端创建新窗口
          </button>

          <button
            type="button"
            onClick={async () => {
              setWorkstudioLoading(true);
              try {
                const ws = await invoke<Workstudio>('create_workstudio');
                const label = `view-workstudio-${ws.id}`;
                openWindowWithDiagnostics(label, `Workstudio: ${ws.mainFolder}`, () =>
                  openViewWindow('workstudio', `Workstudio: ${ws.mainFolder}`, {
                    label,
                    workstudioId: ws.id,
                    window: { width: 900, height: 700 },
                  })
                );
              } finally {
                setWorkstudioLoading(false);
              }
            }}
            disabled={workstudioLoading}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-60"
          >
            {workstudioLoading ? '打开中...' : '打开标准 Workstudio 窗口'}
          </button>
        </div>

        {lastEvent && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
            <div className="font-medium">lastEvent</div>
            <div className="mt-1 break-all">{lastEvent}</div>
          </div>
        )}

        <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
          备注：菜单“测试多窗口”走的是后端创建窗口；此按钮走的是前端 JS 创建窗口。
        </div>
      </div>
    </div>
  );
};

export default WindowTestView;
