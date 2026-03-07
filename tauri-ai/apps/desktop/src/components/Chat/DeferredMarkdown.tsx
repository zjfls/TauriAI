import React, { startTransition, useEffect, useMemo, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

export type DeferredMarkdownProps = {
  content: string;
  conversationId?: string | null;
  workstudioId?: string | null;
  isStreaming?: boolean;
  /**
   * 是否立即渲染（用于 streaming / 用户主动展开时）。
   */
  immediate?: boolean;
  /**
   * 最小延迟（毫秒）。用于把重渲染挪到首帧之后，避免切换会话卡顿。
   */
  minDelayMs?: number;
  /**
   * 占位阶段最多展示多少字符（避免超长文本导致首屏排版/测量也变慢）。
   */
  previewChars?: number;
};

const SMALL_CONTENT_THRESHOLD = 600;

export const DeferredMarkdown: React.FC<DeferredMarkdownProps> = React.memo(function DeferredMarkdown({
  content,
  conversationId,
  workstudioId,
  isStreaming = false,
  immediate = false,
  minDelayMs = 0,
  previewChars = 2000,
}) {
  const shouldRenderNow = immediate || !content || content.length <= SMALL_CONTENT_THRESHOLD || minDelayMs <= 0;
  const [ready, setReady] = useState<boolean>(shouldRenderNow);

  useEffect(() => {
    if (shouldRenderNow) {
      setReady(true);
      return;
    }

    setReady(false);
    const handle = window.setTimeout(() => {
      startTransition(() => setReady(true));
    }, minDelayMs);

    return () => {
      clearTimeout(handle);
    };
  }, [content, minDelayMs, shouldRenderNow]);

  const preview = useMemo(() => {
    if (!content) return '';
    if (content.length <= previewChars) return content;
    return `${content.slice(0, previewChars)}…`;
  }, [content, previewChars]);

  if (ready) {
    return <MarkdownRenderer content={content} conversationId={conversationId} workstudioId={workstudioId} isStreaming={isStreaming} />;
  }

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-100">
      <div className="mb-1 text-[10px] text-gray-500 dark:text-gray-400">内容较多，正在渲染…</div>
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words pr-2">{preview}</pre>
    </div>
  );
});

DeferredMarkdown.displayName = 'DeferredMarkdown';

export default DeferredMarkdown;
