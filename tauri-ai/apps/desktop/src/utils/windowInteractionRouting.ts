import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindowLabelSafe } from './windowPresence';

export type WindowInteractionKind = 'chat' | 'workstudio' | 'other';

type RecordWindowInteractionArgs = {
  label?: string;
  kind?: WindowInteractionKind;
  paneId?: string | null;
  chatPaneId?: string | null;
};

let lastRecordedSignature: string | null = null;

export const resolveWindowInteractionKind = (label: string): WindowInteractionKind => {
  const normalized = String(label || '').trim();
  if (!normalized) return 'other';
  if (normalized === 'main' || normalized.startsWith('view-chat-') || normalized.startsWith('workspace-')) {
    return 'chat';
  }
  if (normalized.startsWith('view-workstudio-') || normalized.startsWith('view-workstudio-dir-')) {
    return 'workstudio';
  }
  return 'other';
};

export const recordWindowInteraction = async (args: RecordWindowInteractionArgs = {}): Promise<void> => {
  if (!isTauri()) return;

  const label = (args.label ?? getCurrentWindowLabelSafe()).trim();
  if (!label) return;

  const kind = args.kind ?? resolveWindowInteractionKind(label);
  const paneId = typeof args.paneId === 'string' && args.paneId.trim() ? args.paneId.trim() : null;
  const chatPaneId = typeof args.chatPaneId === 'string' && args.chatPaneId.trim() ? args.chatPaneId.trim() : null;
  const signature = JSON.stringify([label, kind, paneId, chatPaneId]);
  if (signature === lastRecordedSignature) return;

  lastRecordedSignature = signature;
  await invoke('record_window_interaction', {
    label,
    kind,
    paneId,
    chatPaneId,
  }).catch(() => {
    lastRecordedSignature = null;
  });
};

export const clearWindowInteraction = async (label = getCurrentWindowLabelSafe()): Promise<void> => {
  if (!isTauri()) return;
  lastRecordedSignature = null;
  await invoke('clear_window_interaction', { label }).catch(() => {});
};
