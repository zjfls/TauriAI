import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import Editor, { type OnMount } from '@monaco-editor/react';
import { FileText, Copy, Pencil, Eye, Save, SaveAll } from 'lucide-react';
import { useDocumentStore, type DocumentRevealTarget } from '../../stores/documentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { setupMonaco } from '../../utils/monaco';
import MarkdownRenderer from '../Chat/MarkdownRenderer';

const isRichTxtDoc = (pathOrTitle: string) => pathOrTitle.toLowerCase().endsWith('.tauri.richtxt');

const basename = (path: string) => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
};

const languageForPath = (path: string): string => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.tauri.richtxt')) return 'markdown';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.c')) return 'c';
  if (
    lower.endsWith('.cc') ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.cxx') ||
    lower.endsWith('.h') ||
    lower.endsWith('.hh') ||
    lower.endsWith('.hpp') ||
    lower.endsWith('.hxx') ||
    lower.endsWith('.inl') ||
    lower.endsWith('.ipp') ||
    lower.endsWith('.ixx') ||
    lower.endsWith('.cppm')
  )
    return 'cpp';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'shell';
  return 'plaintext';
};

export const DocumentView: React.FC<{ documentId?: string }> = ({ documentId }) => {
  const documents = useDocumentStore((s) => s.documents);
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
  const updateDocumentContent = useDocumentStore((s) => s.updateDocumentContent);
  const updateDocumentMeta = useDocumentStore((s) => s.updateDocumentMeta);
  const activeWorkstudioId = useSessionStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return null;
    return s.sessions.get(sid)?.workstudioId ?? null;
  });

  const resolvedDocumentId = (documentId ?? activeDocumentId) || null;
  const revealTarget = useDocumentStore((s) =>
    resolvedDocumentId ? s.revealTargets[resolvedDocumentId] : undefined
  );
  const setRevealTarget = useDocumentStore((s) => s.setRevealTarget);

  const activeDoc = useMemo(() => {
    if (!resolvedDocumentId) return null;
    return documents.find((d) => d.id === resolvedDocumentId) ?? null;
  }, [documents, resolvedDocumentId]);

  // 懒加载：避免把大文件内容塞进 localStorage；需要展示时再从磁盘读取
  useEffect(() => {
    if (!activeDoc) return;
    if (!activeDoc.path) return;
    if (activeDoc.contentLoaded !== false) return;
    if (!isTauri()) return;

    let cancelled = false;
    void (async () => {
      try {
        const file = await invoke<{
          filename: string;
          mime: string;
          base64: string;
          size: number;
        }>('read_local_file_base64', { path: activeDoc.path });
        const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
        const content = new TextDecoder('utf-8').decode(bytes);
        if (cancelled) return;
        updateDocumentContent(activeDoc.id, content);
      } catch {
        // ignore: best-effort
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeDoc?.id, activeDoc?.path, activeDoc?.contentLoaded, updateDocumentContent]);

  const modeByDocIdRef = useRef<Record<string, 'preview' | 'edit'>>({});
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const editorRef = useRef<any>(null);
  const [editorRevision, setEditorRevision] = useState(0);
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

  const handleEditorMount = useCallback<OnMount>((editor, monaco) => {
    setupMonaco(monaco);
    editorRef.current = editor;
    setEditorRevision((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!activeDoc || !resolvedDocumentId) return;
    if (!revealTarget) return;
    if (mode !== 'edit') setModeAndRemember('edit');
  }, [activeDoc, mode, resolvedDocumentId, revealTarget, setModeAndRemember]);

  useEffect(() => {
    if (!activeDoc || !resolvedDocumentId) return;
    if (!revealTarget) return;
    const editor = editorRef.current as any;
    if (!editor) return;

    const target: DocumentRevealTarget = revealTarget;
    const startLineNumber = Math.max(1, Math.floor(target.line));
    const startColumn = Math.max(1, Math.floor(target.column ?? 1));
    const endLineNumber = Math.max(1, Math.floor(target.endLine ?? startLineNumber));
    const endColumn = Math.max(1, Math.floor(target.endColumn ?? startColumn));

    const sel = {
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
    };

    try {
      editor.setSelection(sel);
      editor.revealRangeInCenter(sel);
      editor.focus();
      setRevealTarget(resolvedDocumentId, null);
    } catch {
      // ignore
    }
  }, [activeDoc, editorRevision, resolvedDocumentId, revealTarget, setRevealTarget]);

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
    const onShortcut = (event: Event) => {
      const e = event as CustomEvent<{ action?: string }>;
      if (e.detail?.action !== 'document.save') return;
      void handleSave();
    };
    window.addEventListener('tauri-ai:shortcut', onShortcut as EventListener);
    return () => window.removeEventListener('tauri-ai:shortcut', onShortcut as EventListener);
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
            const language = languageForPath(activeDoc.path || activeDoc.title || '');
            const theme =
              typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
                ? 'vs-dark'
                : 'vs';
            return (
              <div className="h-full w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <Editor
                  height="100%"
                  theme={theme}
                  value={activeDoc.content}
                  language={language}
                  onMount={handleEditorMount}
                  onChange={(value) => updateDocumentContent(activeDoc.id, value ?? '')}
                  options={{
                    fontSize: 12,
                    minimap: { enabled: false },
                    wordWrap: renderMarkdown ? 'on' : 'off',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    lineNumbers: 'on',
                    renderWhitespace: 'selection',
                    tabSize: 2,
                  }}
                />
              </div>
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
