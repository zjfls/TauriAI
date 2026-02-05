import { invoke } from '@tauri-apps/api/core';
import type { Workstudio } from '../types';
import { useDocumentStore, type DocumentRevealTarget } from '../stores/documentStore';
import { docTabId } from '../stores/workspaceTabStore';
import { useUIStore } from '../stores/uiStore';
import { useWindowLayoutStore } from '../stores/windowLayoutStore';

export type WorkstudioOpenFileTarget = {
  filePath: string;
  line?: number | null;
  column?: number | null;
  endLine?: number | null;
  endColumn?: number | null;
};

const normalizeFsPath = (p: string) => p.replace(/\\/g, '/');

const isAbsoluteFsPath = (p: string) => {
  const normalized = normalizeFsPath(p);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//');
};

const joinFsPath = (baseDir: string, relative: string) => {
  const base = normalizeFsPath(baseDir).replace(/\/+$/, '');
  const rel = normalizeFsPath(relative).replace(/^\/+/, '');
  return base && rel ? `${base}/${rel}` : base || rel;
};

const basename = (p: string) => {
  const normalized = normalizeFsPath(p);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
};

const decodeUtf8Base64 = (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
};

const toRevealTarget = (t: WorkstudioOpenFileTarget): DocumentRevealTarget | null => {
  const line = typeof t.line === 'number' && Number.isFinite(t.line) ? Math.max(1, Math.floor(t.line)) : null;
  if (!line) return null;
  const column = typeof t.column === 'number' && Number.isFinite(t.column) ? Math.max(1, Math.floor(t.column)) : 1;
  const endLine = typeof t.endLine === 'number' && Number.isFinite(t.endLine) ? Math.max(1, Math.floor(t.endLine)) : undefined;
  const endColumn =
    typeof t.endColumn === 'number' && Number.isFinite(t.endColumn) ? Math.max(1, Math.floor(t.endColumn)) : undefined;
  return { line, column, endLine, endColumn };
};

const pickBestCandidate = (needle: string, candidates: string[]): string | null => {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const normalizedNeedle = normalizeFsPath(needle);
  const lowerNeedle = normalizedNeedle.toLowerCase();
  const base = basename(normalizedNeedle);

  if (normalizedNeedle.includes('/')) {
    const tail = `/${lowerNeedle}`;
    const exactTail = candidates.find((p) => normalizeFsPath(p).toLowerCase().endsWith(tail));
    if (exactTail) return exactTail;
  }

  const byBase = candidates.find((p) => basename(p).toLowerCase() === base.toLowerCase());
  return byBase ?? candidates[0] ?? null;
};

export const openWorkstudioFileInWorkspace = async (opts: {
  workstudioId: string;
  target: WorkstudioOpenFileTarget;
}): Promise<{ resolvedPath: string; docId: string } | null> => {
  const workstudioId = (opts.workstudioId ?? '').trim();
  const target = opts.target;
  const raw = (target?.filePath ?? '').trim();
  if (!workstudioId || !raw) return null;

  const ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId });
  if (!ws) throw new Error(`Workstudio not found: ${workstudioId}`);

  const normalized = normalizeFsPath(raw);
  const isAbs = isAbsoluteFsPath(normalized);
  const resolved = isAbs ? normalized : joinFsPath(ws.mainFolder, normalized);

  const tryOpen = async (path: string) => {
    const file = await invoke<{
      filename: string;
      mime: string;
      base64: string;
      size: number;
    }>('read_local_file_base64', { path });

    if (!file.mime.startsWith('text/')) {
      throw new Error(`Unsupported mime: ${file.mime}`);
    }

    const content = decodeUtf8Base64(file.base64);
    const docId = useDocumentStore.getState().openDocument({
      title: file.filename,
      path,
      kind: 'text',
      content,
    });

    const reveal = toRevealTarget(target);
    if (reveal) {
      useDocumentStore.getState().setRevealTarget(docId, reveal);
    }

    useWindowLayoutStore.getState().openTabInFocusedPane(docTabId(docId));
    useUIStore.getState().setActiveView('chat');
    return docId;
  };

  try {
    const docId = await tryOpen(resolved);
    return { resolvedPath: resolved, docId };
  } catch (error) {
    if (isAbs) throw error;

    const needle = normalized;
    const base = basename(needle);
    const candidates = await invoke<string[]>('workstudio_find_files', {
      args: { workstudioId, query: base, limit: 50 },
    });

    const best = pickBestCandidate(needle, candidates);
    if (!best) throw error;
    const bestNormalized = normalizeFsPath(best);
    const docId = await tryOpen(bestNormalized);
    return { resolvedPath: bestNormalized, docId };
  }
};
