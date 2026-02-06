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
  // eslint-disable-next-line no-console
  console.log('[dragGhost][create]', { sourceLabel, title });
  await invokeDragGhostWithFallback(
    'drag_ghost_create',
    'debug_drag_ghost_create',
    { title, source_label: sourceLabel },
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
    { source_label: sourceLabel, x: Math.round(cursor.x), y: Math.round(cursor.y) },
    { sourceLabel, cursor }
  );
};

export const moveDragGhostWindowClient = async (client: { x: number; y: number }) => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  if (!isTauri()) return;
  try {
    await invoke('drag_ghost_move_client', { source_label: sourceLabel, client_x: client.x, client_y: client.y });
  } catch {
    // ignore: fallback to cursorPosition polling
  }
};

export const destroyDragGhostWindow = async () => {
  const sourceLabel = getSourceLabel();
  if (!sourceLabel) return;
  if (!isTauri()) return;
  // eslint-disable-next-line no-console
  console.log('[dragGhost][destroy]', { sourceLabel });
  await invokeDragGhostWithFallback(
    'drag_ghost_destroy',
    'debug_drag_ghost_destroy',
    { source_label: sourceLabel },
    { sourceLabel }
  );
};

export const startDragGhostFollow = async (
  opts?: { offsetX: number; offsetY: number; width: number; height: number }
) => {
  if (!isTauri()) return false;
  try {
    await invoke('drag_ghost_follow_start', {
      offset_x: opts?.offsetX,
      offset_y: opts?.offsetY,
      width: opts?.width,
      height: opts?.height,
    });
    // eslint-disable-next-line no-console
    console.log('[dragGhost][follow][start]', opts ?? null);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[dragGhost][follow][start][ERR]', e);
    return false;
  }
};

export const stopDragGhostFollow = async () => {
  if (!isTauri()) return;
  try {
    await invoke('drag_ghost_follow_stop', {});
    // eslint-disable-next-line no-console
    console.log('[dragGhost][follow][stop]');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[dragGhost][follow][stop][ERR]', e);
  }
};
