import { isTauri } from '@tauri-apps/api/core';
import type { AppConfig, CompletionNotificationSettings } from '../types';

export type TaskCompletionNotificationKind = 'success' | 'failure';

export interface TaskCompletionNotificationInput {
  kind: TaskCompletionNotificationKind;
  sessionTitle?: string | null;
  agentName?: string | null;
  previewText?: string | null;
}

export interface ResolvedCompletionNotificationSettings {
  enabled: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  includePreview: boolean;
  requestAttention: boolean;
}

const DEFAULT_COMPLETION_NOTIFICATION_SETTINGS: ResolvedCompletionNotificationSettings = {
  enabled: true,
  notifyOnSuccess: true,
  notifyOnFailure: true,
  includePreview: true,
  requestAttention: true,
};

let cachedPermissionGranted: boolean | null = null;
let permissionRequestInFlight: Promise<boolean> | null = null;

export const resolveCompletionNotificationSettings = (
  config: AppConfig | null | undefined
): ResolvedCompletionNotificationSettings => ({
  enabled: config?.general?.completionNotifications?.enabled ?? DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.enabled,
  notifyOnSuccess:
    config?.general?.completionNotifications?.notifyOnSuccess
    ?? DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.notifyOnSuccess,
  notifyOnFailure:
    config?.general?.completionNotifications?.notifyOnFailure
    ?? DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.notifyOnFailure,
  includePreview:
    config?.general?.completionNotifications?.includePreview
    ?? DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.includePreview,
  requestAttention:
    config?.general?.completionNotifications?.requestAttention
    ?? DEFAULT_COMPLETION_NOTIFICATION_SETTINGS.requestAttention,
});

export const defaultCompletionNotificationSettings = (): CompletionNotificationSettings => ({
  ...DEFAULT_COMPLETION_NOTIFICATION_SETTINGS,
});

const normalizePreviewText = (value: string | null | undefined): string => {
  const collapsed = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '')
    .trim();
  if (!collapsed) return '';
  if (collapsed.length <= 140) return collapsed;
  return `${collapsed.slice(0, 137).trimEnd()}…`;
};

const resolveSubject = (input: TaskCompletionNotificationInput): string => {
  const title = String(input.sessionTitle ?? '').trim();
  if (title) return title;
  const agent = String(input.agentName ?? '').trim();
  if (agent) return agent;
  return '当前会话';
};

const buildNotificationBody = (
  input: TaskCompletionNotificationInput,
  settings: ResolvedCompletionNotificationSettings
): string => {
  const preview = settings.includePreview ? normalizePreviewText(input.previewText) : '';
  if (preview) return preview;
  return input.kind === 'failure' ? '任务执行失败，点击返回查看错误详情。' : '任务已经完成，点击返回查看结果。';
};

const ensureNotificationPermission = async (): Promise<boolean> => {
  if (!isTauri()) return false;
  if (cachedPermissionGranted !== null) return cachedPermissionGranted;
  if (permissionRequestInFlight) return permissionRequestInFlight;

  permissionRequestInFlight = (async () => {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
      const alreadyGranted = await isPermissionGranted();
      if (alreadyGranted) {
        cachedPermissionGranted = true;
        return true;
      }

      const permission = await requestPermission();
      if (permission === 'granted') {
        cachedPermissionGranted = true;
        return true;
      }
      if (permission === 'denied') {
        cachedPermissionGranted = false;
      }
      return false;
    } catch {
      return false;
    } finally {
      permissionRequestInFlight = null;
    }
  })();

  return permissionRequestInFlight;
};

const requestWindowAttention = async (kind: TaskCompletionNotificationKind): Promise<void> => {
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    await getCurrentWindow().requestUserAttention(
      kind === 'failure' ? UserAttentionType.Critical : UserAttentionType.Informational
    );
  } catch {
    // ignore: best-effort desktop cue
  }
};

export const notifyTaskCompletion = async (
  input: TaskCompletionNotificationInput,
  config: AppConfig | null | undefined
): Promise<void> => {
  if (!isTauri()) return;

  const settings = resolveCompletionNotificationSettings(config);
  if (!settings.enabled) return;
  if (input.kind === 'success' && !settings.notifyOnSuccess) return;
  if (input.kind === 'failure' && !settings.notifyOnFailure) return;

  const subject = resolveSubject(input);
  const title = input.kind === 'failure' ? `任务失败 · ${subject}` : `任务已完成 · ${subject}`;
  const body = buildNotificationBody(input, settings);

  const permissionGranted = await ensureNotificationPermission();
  if (permissionGranted) {
    try {
      const { sendNotification } = await import('@tauri-apps/plugin-notification');
      sendNotification({ title, body });
    } catch {
      // ignore: fallback to window attention below
    }
  }

  if (settings.requestAttention) {
    await requestWindowAttention(input.kind);
  }
};

export const syncUnreadCompletionBadge = async (unreadCount: number): Promise<void> => {
  if (!isTauri()) return;

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const currentWindow = getCurrentWindow();

    try {
      if (unreadCount > 0) {
        await currentWindow.setBadgeCount(unreadCount);
      } else {
        await currentWindow.setBadgeCount();
      }
    } catch {
      // ignore: unsupported on this platform/window type
    }

    if (unreadCount === 0) {
      try {
        await currentWindow.requestUserAttention(null);
      } catch {
        // ignore: best-effort clear
      }
    }
  } catch {
    // ignore
  }
};
