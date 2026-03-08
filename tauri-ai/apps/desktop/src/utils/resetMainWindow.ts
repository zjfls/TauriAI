import { isTauri } from '@tauri-apps/api/core';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { removeWindowRecord } from './windowLayout';

export const RESET_MAIN_WINDOW_EVENT = 'app:reset_main_window';

const MAIN_WINDOW_STORAGE_KEYS = [
  'tauri-ai:window-layout:v2:main',
  'tauri-ai:workspace-layout:v2:main',
  'tauri-ai:workspace-tabs:v2:main',
  'tauri-ai:workspace-layout:v1',
  'tauri-ai:workspace-tabs:v1',
] as const;

export const clearPersistedMainWindowState = () => {
  try {
    if (typeof window !== 'undefined') {
      for (const key of MAIN_WINDOW_STORAGE_KEYS) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore
  }

  removeWindowRecord('main');
};

export const requestMainWindowReset = async () => {
  clearPersistedMainWindowState();

  if (!isTauri()) return;

  const currentWindow = getCurrentWebviewWindow();
  const mainWindow =
    currentWindow.label === 'main'
      ? currentWindow
      : await WebviewWindow.getByLabel('main').catch(() => null);

  if (!mainWindow) return;

  await mainWindow.emit(RESET_MAIN_WINDOW_EVENT);
};
