import { isTauri } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';

type OpenExternalWebWindowOptions = {
  title?: string;
  /**
   * Whether devtools should be enabled for this webview (only works in debug builds,
   * or in release builds with the `devtools` feature flag).
   */
  devtools?: boolean;
  /** Open in incognito mode (platform-specific support). */
  incognito?: boolean;
  /** Override user agent (optional). */
  userAgent?: string;
};

const makeLabel = () => `ext-web-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const openExternalWebWindow = (url: string, opts?: OpenExternalWebWindowOptions) => {
  const target = (url ?? '').trim();
  if (!target || target === 'about:blank') return null;

  // 非 Tauri 环境：退化为系统/浏览器打开（避免运行时报错）。
  if (!isTauri()) {
    try {
      window.open(target, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
    return null;
  }

  const label = makeLabel();
  const title = (opts?.title ?? '').trim() || '网页';
  const win = new WebviewWindow(label, {
    url: target,
    title,
    width: 1170,
    height: 910,
    devtools: opts?.devtools ?? true,
    incognito: opts?.incognito ?? false,
    userAgent: opts?.userAgent,
  });

  // 兜底：某些平台/配置下如果创建失败，方便排查。
  try {
    win.once('tauri://error', (e) => {
      console.error('[openExternalWebWindow] tauri://error', { label, url: target, payload: (e as any)?.payload });
      // 如果窗口创建失败，退回系统浏览器打开（避免“什么都没发生”）。
      void openUrl(target).catch(() => {});
    });
  } catch {
    // ignore
  }

  return win;
};

