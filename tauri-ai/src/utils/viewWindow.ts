import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { ActiveView } from '../types';

export interface ViewWindowParams {
  view?: ActiveView | null;
  standalone: boolean;
  conversationId?: string | null;
  documentPath?: string | null;
  workstudioId?: string | null;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
}

export const getViewWindowParams = (): ViewWindowParams => {
  if (typeof window === 'undefined') {
    return {
      view: null,
      standalone: false,
      conversationId: null,
      documentPath: null,
      workstudioId: null,
      filePath: null,
      line: null,
      column: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') as ActiveView | null;
  const standalone = params.get('standalone') === '1';
  const conversationId = params.get('conversationId');
  const documentPath = params.get('documentPath');
  const workstudioId = params.get('workstudioId');
  const filePath = params.get('filePath');
  const lineRaw = params.get('line');
  const columnRaw = params.get('column');
  const line = lineRaw ? Number(lineRaw) : null;
  const column = columnRaw ? Number(columnRaw) : null;
  return {
    view,
    standalone,
    conversationId,
    documentPath,
    workstudioId,
    filePath,
    line: Number.isFinite(line) ? line : null,
    column: Number.isFinite(column) ? column : null,
  };
};

export const openViewWindow = (
  view: ActiveView,
  title: string,
  opts?: {
    conversationId?: string;
    documentPath?: string;
    workstudioId?: string;
    filePath?: string;
    line?: number;
    column?: number;
  }
) => {
  const label = `view-${view}-${Date.now()}`;
  const params = new URLSearchParams();
  params.set('view', view);
  params.set('standalone', '1');
  if (opts?.conversationId) {
    params.set('conversationId', opts.conversationId);
  }
  if (opts?.documentPath) {
    params.set('documentPath', opts.documentPath);
  }
  if (opts?.workstudioId) {
    params.set('workstudioId', opts.workstudioId);
  }
  if (opts?.filePath) {
    params.set('filePath', opts.filePath);
  }
  if (typeof opts?.line === 'number') {
    params.set('line', String(opts.line));
  }
  if (typeof opts?.column === 'number') {
    params.set('column', String(opts.column));
  }
  const url = `/?${params.toString()}`;
  return new WebviewWindow(label, {
    title,
    url,
    width: 900,
    height: 700,
  });
};

export const openOrFocusViewWindow = async (
  view: ActiveView,
  title: string,
  opts?: {
    conversationId?: string;
    documentPath?: string;
    workstudioId?: string;
    filePath?: string;
    line?: number;
    column?: number;
    label?: string;
  }
) => {
  const label = opts?.label ?? `view-${view}-${Date.now()}`;
  if (opts?.label) {
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return existing;
      }
    } catch {
      // ignore, will create new window
    }
  }

  const params = new URLSearchParams();
  params.set('view', view);
  params.set('standalone', '1');
  if (opts?.conversationId) {
    params.set('conversationId', opts.conversationId);
  }
  if (opts?.documentPath) {
    params.set('documentPath', opts.documentPath);
  }
  if (opts?.workstudioId) {
    params.set('workstudioId', opts.workstudioId);
  }
  if (opts?.filePath) {
    params.set('filePath', opts.filePath);
  }
  if (typeof opts?.line === 'number') {
    params.set('line', String(opts.line));
  }
  if (typeof opts?.column === 'number') {
    params.set('column', String(opts.column));
  }
  const url = `/?${params.toString()}`;

  return new WebviewWindow(label, {
    title,
    url,
    width: 900,
    height: 700,
  });
};

export const closeCurrentWindow = async () => {
  const win = getCurrentWebviewWindow();
  await win.close();
};
