import React, { useMemo } from 'react';
import { FileText, Copy } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import MarkdownRenderer from '../Chat/MarkdownRenderer';

export const DocumentView: React.FC = () => {
  const documents = useDocumentStore((s) => s.documents);
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);

  const activeDoc = useMemo(() => {
    if (!activeDocumentId) return null;
    return documents.find((d) => d.id === activeDocumentId) ?? null;
  }, [documents, activeDocumentId]);

  if (!activeDoc) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">
            <FileText size={18} />
          </div>
          <div className="text-base font-medium text-gray-800 dark:text-gray-100">未打开文档</div>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            通过菜单「文件 → 打开文件…」（Cmd/Ctrl+O）打开一个文本文件
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-blue-600 dark:text-blue-300" />
            <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
              {activeDoc.title}
            </div>
          </div>
          {activeDoc.path && (
            <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
              {activeDoc.path}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(activeDoc.content);
              } catch {
                // Clipboard may be unavailable in some environments.
              }
            }}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title="复制全文"
          >
            <Copy size={12} />
            复制
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {(() => {
          const path = (activeDoc.path ?? '').toLowerCase();
          const renderMarkdown =
            path.endsWith('.md') || path.endsWith('.markdown') || path.endsWith('.tauri.richtxt');
          if (renderMarkdown) {
            return (
              <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <MarkdownRenderer content={activeDoc.content} />
              </div>
            );
          }
          return (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-white p-4 text-xs leading-relaxed text-gray-800 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
              {activeDoc.content}
            </pre>
          );
        })()}
      </div>
    </div>
  );
};

export default DocumentView;
