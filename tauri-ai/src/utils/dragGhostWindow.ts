import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type DragGhostPayload = {
  title: string;
};

const getSourceLabel = () => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
};

const invokeDragGhostWithFallback = async (
  primaryCommand: string,
  legacyCommand: string,
  args: Record<string, unknown>,
  logMeta: Record<string, unknown>
) => {
  try {
    await invoke(primaryCommand, args);
    return;
  } catch (e1) {
    try {
      await invoke(legacyCommand, args);
      return;
    } catch (e2) {
      // eslint-disable-next-line no-console
      console.log('[dragGhost][invoke][ERR]', { ...logMeta, primaryCommand, legacyCommand, error: e1, legacyError: e2 });
    }
  }
};

export const createDragGhostWindow = async (payload: DragGhostPayload) => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  const title = (payload.title ?? '').trim();
  if (!title) return;

  if (!isTauri()) return;
  await invokeDragGhostWithFallback(
    'drag_ghost_create',
    'debug_drag_ghost_create',
    { title, sourceLabel },
    { sourceLabel, title }
  );
};

export const moveDragGhostWindow = async (cursor: { x: number; y: number }) => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  if (!isTauri()) return;
  await invokeDragGhostWithFallback(
    'drag_ghost_move',
    'debug_drag_ghost_move',
    { sourceLabel, x: Math.round(cursor.x), y: Math.round(cursor.y) },
    { sourceLabel, cursor }
  );
};

export const destroyDragGhostWindow = async () => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  if (!isTauri()) return;
  await invokeDragGhostWithFallback(
    'drag_ghost_destroy',
    'debug_drag_ghost_destroy',
    { sourceLabel },
    { sourceLabel }
  );
};
