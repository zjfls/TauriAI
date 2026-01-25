import React from 'react';
import { X } from 'lucide-react';
import { closeCurrentWindow, getViewWindowParams } from '../../utils/viewWindow';

interface StandaloneLayoutProps {
  title?: string;
  children: React.ReactNode;
}

export const StandaloneLayout: React.FC<StandaloneLayoutProps> = ({ title, children }) => {
  const params = getViewWindowParams();
  const showHeader = params.view !== 'workstudio';

  if (!showHeader) {
    return <div className="h-screen w-screen overflow-hidden bg-gray-50 dark:bg-gray-900">{children}</div>;
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-gray-50 dark:bg-gray-900">
      <div
        data-tauri-drag-region
        className="flex items-center justify-between border-b border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
      >
        <div data-tauri-drag-region className="font-medium">
          {title || 'View'}
        </div>
        <button
          type="button"
          onClick={() => closeCurrentWindow()}
          className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          title="关闭窗口"
        >
          <X size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
};
