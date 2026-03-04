import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Clipboard, Copy, FileUp, Wand2 } from 'lucide-react';
import { JsonView } from './JsonView';

const decodeBase64Utf8 = (base64: string): string => {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
};

const safeFormatJson = (raw: string): { ok: true; text: string } | { ok: false; error: string } => {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, text: '' };
  try {
    const v = JSON.parse(text);
    return { ok: true, text: JSON.stringify(v, null, 2) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export const JsonAnalyzerView: React.FC = () => {
  const [text, setText] = useState<string>('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const headerHint = useMemo(() => {
    if (error) return `解析失败：${error}`;
    if (status) return status;
    return '打开 JSON 文件或粘贴 JSON 文本进行分析';
  }, [error, status]);

  const setWindowTitleSafe = useCallback(async (title: string) => {
    const t = (title ?? '').trim() || 'JSON 分析';
    try {
      document.title = t;
    } catch {
      // ignore
    }
    if (!isTauri()) return;
    try {
      await getCurrentWebviewWindow().setTitle(t);
    } catch {
      // ignore
    }
  }, []);

  const openFileIntoAnalyzer = useCallback(async () => {
    setError(null);
    setStatus(null);

    const selected = await openDialog({
      title: '打开 JSON 文件',
      multiple: false,
      directory: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (!selected || Array.isArray(selected)) return;

    const file = await invoke<{
      filename: string;
      mime: string;
      base64: string;
      size: number;
    }>('read_local_file_base64', { path: selected });

    const content = decodeBase64Utf8(file.base64);
    setText(content);
    setStatus(`已打开：${file.filename}（${file.size} bytes）`);
    await setWindowTitleSafe(`JSON 分析 - ${file.filename}`);
  }, [setWindowTitleSafe]);

  const pasteFromClipboard = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const t = await navigator.clipboard.readText();
      setText(t ?? '');
      setStatus('已从剪贴板粘贴');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制到剪贴板');
      window.setTimeout(() => setStatus(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [text]);

  const formatJson = useCallback(() => {
    setError(null);
    const out = safeFormatJson(text);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setText(out.text);
    setStatus('已格式化');
    window.setTimeout(() => setStatus(null), 1200);
  }, [text]);

  useEffect(() => {
    void setWindowTitleSafe('JSON 分析');
  }, [setWindowTitleSafe]);

  // 在 JSON 分析窗口中，让 File -> Open File 直接把内容载入分析器（而不是打开 DocumentView）。
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: null | (() => void) = null;
    void listen('menu:open_file', () => {
      void openFileIntoAnalyzer().catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [openFileIntoAnalyzer]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
        <div className="truncate">{headerHint}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void openFileIntoAnalyzer()}
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title="打开 JSON 文件"
          >
            <FileUp size={14} />
            打开
          </button>
          <button
            type="button"
            onClick={() => void pasteFromClipboard()}
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title="从剪贴板粘贴"
          >
            <Clipboard size={14} />
            粘贴
          </button>
          <button
            type="button"
            onClick={formatJson}
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title="格式化 JSON"
          >
            <Wand2 size={14} />
            格式化
          </button>
          <button
            type="button"
            onClick={() => void copyToClipboard()}
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title="复制当前文本"
          >
            <Copy size={14} />
            复制
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden p-3">
        <div className="h-full rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <div className="h-full p-3">
            <JsonView text={text} onTextChange={setText} readOnly={false} defaultMode="structured" />
          </div>
        </div>
      </div>
    </div>
  );
};
