import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { FileText, Copy, Pencil, Eye, Save, SaveAll } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { useSessionStore } from '../../stores/sessionStore';
import MarkdownRenderer from '../Chat/MarkdownRenderer';

const isRichTxtDoc = (pathOrTitle: string) => pathOrTitle.toLowerCase().endsWith('.tauri.richtxt');

const basename = (path: string) => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
};

export const DocumentView: React.FC = () => {
  const documents = useDocumentStore((s) => s.documents);
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
  const updateDocumentContent = useDocumentStore((s) => s.updateDocumentContent);
  const updateDocumentMeta = useDocumentStore((s) => s.updateDocumentMeta);
  const activeWorkstudioId = useSessionStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return null;
    return s.sessions.get(sid)?.workstudioId ?? null;
  });

  const activeDoc = useMemo(() => {
    if (!activeDocumentId) return null;
    return documents.find((d) => d.id === activeDocumentId) ?? null;
  }, [documents, activeDocumentId]);

  const modeByDocIdRef = useRef<Record<string, 'preview' | 'edit'>>({});
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!activeDoc) return;
    const cached = modeByDocIdRef.current[activeDoc.id];
    if (cached) {
      setMode(cached);
      return;
    }
    // Default: untitled docs go edit-first; file-backed docs keep preview-first.
    const next: 'preview' | 'edit' = activeDoc.path ? 'preview' : 'edit';
    modeByDocIdRef.current[activeDoc.id] = next;
    setMode(next);
  }, [activeDoc?.id]);

  const setModeAndRemember = useCallback(
    (next: 'preview' | 'edit') => {
      if (activeDoc) modeByDocIdRef.current[activeDoc.id] = next;
      setMode(next);
    },
    [activeDoc]
  );

  const writeFile = useCallback(
    async (path: string) => {
      if (!activeDoc) return;
      if (!isTauri()) {
        setSaveError('当前不是 Tauri 环境，无法写入本地文件');
        return;
      }
      setSaving(true);
      setSaveError(null);
      setSaved(false);
      try {
        await invoke('write_local_text_file', { path, content: activeDoc.content });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
      } catch (e) {
        setSaveError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [activeDoc]
  );

  const handleSave = useCallback(async () => {
    if (!activeDoc) return;
    if (activeDoc.path) {
      await writeFile(activeDoc.path);
      return;
    }
    const suggested = activeDoc.title || 'Untitled.tauri.richtxt';
    try {
      if (!isTauri()) {
        setSaveError('当前不是 Tauri 环境，无法打开保存对话框');
        return;
      }
      const picked = await saveDialog({
        title: '保存文件',
        defaultPath: suggested,
      });
      if (!picked) return;

      const nextPath = isRichTxtDoc(suggested) && !picked.toLowerCase().endsWith('.tauri.richtxt')
        ? `${picked}.tauri.richtxt`
        : picked;

      await writeFile(nextPath);
      // 写入成功后，绑定到路径（并把标题更新成文件名）
      updateDocumentMeta(activeDoc.id, { path: nextPath, title: basename(nextPath) });
    } catch (e) {
      setSaveError(String(e));
    }
  }, [activeDoc, updateDocumentMeta, writeFile]);

  const handleSaveAs = useCallback(async () => {
    if (!activeDoc) return;
    try {
      if (!isTauri()) {
        setSaveError('当前不是 Tauri 环境，无法打开保存对话框');
        return;
      }
      const suggested = activeDoc.path ?? activeDoc.title ?? 'Untitled.tauri.richtxt';
      const picked = await saveDialog({
        title: '另存为…',
        defaultPath: suggested,
      });
      if (!picked) return;

      const isRich = isRichTxtDoc(activeDoc.path ?? activeDoc.title ?? '');
      const nextPath = isRich && !picked.toLowerCase().endsWith('.tauri.richtxt')
        ? `${picked}.tauri.richtxt`
        : picked;

      await writeFile(nextPath);
      updateDocumentMeta(activeDoc.id, { path: nextPath, title: basename(nextPath) });
    } catch (e) {
      setSaveError(String(e));
    }
  }, [activeDoc, updateDocumentMeta, writeFile]);

  useEffect(() => {
    if (!activeDoc) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (!isCmdOrCtrl) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void handleSave();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDoc, handleSave]);

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
            onClick={() => setModeAndRemember(mode === 'edit' ? 'preview' : 'edit')}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title={mode === 'edit' ? '预览' : '编辑'}
          >
            {mode === 'edit' ? <Eye size={12} /> : <Pencil size={12} />}
            {mode === 'edit' ? '预览' : '编辑'}
          </button>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title={activeDoc.path ? '保存（Cmd/Ctrl+S）' : '保存到文件（Cmd/Ctrl+S）'}
          >
            <Save size={12} />
            {saving ? '保存中…' : '保存'}
          </button>

          <button
            type="button"
            onClick={() => void handleSaveAs()}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            title="另存为…"
          >
            <SaveAll size={12} />
            另存为
          </button>

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
      <div className="flex-1 min-h-0 overflow-hidden p-4">
        {saveError && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
            {saveError}
          </div>
        )}

        {saved && (
          <div className="mb-3 rounded-lg border border-green-200 bg-green-50 p-2 text-xs text-green-700 dark:border-green-900/40 dark:bg-green-950/40 dark:text-green-300">
            已保存
          </div>
        )}

        {(() => {
          const pathOrTitle = (activeDoc.path || activeDoc.title || '').toLowerCase();
          const renderMarkdown =
            pathOrTitle.endsWith('.md') ||
            pathOrTitle.endsWith('.markdown') ||
            pathOrTitle.endsWith('.tauri.richtxt');

          if (mode === 'edit') {
            return (
              <textarea
                value={activeDoc.content}
                onChange={(e) => updateDocumentContent(activeDoc.id, e.target.value)}
                className="h-full w-full resize-none rounded-lg border border-gray-200 bg-white p-4 font-mono text-xs leading-relaxed text-gray-800 shadow-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                spellCheck={false}
              />
            );
          }

          if (renderMarkdown) {
            return (
              <div className="h-full overflow-auto rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <MarkdownRenderer content={activeDoc.content} workstudioId={activeWorkstudioId} />
              </div>
            );
          }

          return (
            <pre className="h-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-white p-4 text-xs leading-relaxed text-gray-800 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
              {activeDoc.content}
            </pre>
          );
        })()}
      </div>
    </div>
  );
};

export default DocumentView;
