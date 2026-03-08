import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMockStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
};

const installMockStorage = () => {
  const storage = createMockStorage();
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
  });
  return storage;
};

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
const getByLabelMock = vi.hoisted(() => vi.fn(async () => null));
const currentWindow = vi.hoisted(() => ({
  label: 'view-chat-1',
  emit: vi.fn(async () => undefined),
}));
const mainWindow = vi.hoisted(() => ({
  label: 'main',
  emit: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: getByLabelMock,
  },
  getCurrentWebviewWindow: () => currentWindow,
}));

import { __resetWindowLayoutCacheForTests, readWindowLayout, upsertWindowRecord } from './windowLayout';
import { RESET_MAIN_WINDOW_EVENT, requestMainWindowReset } from './resetMainWindow';

describe('resetMainWindow', () => {
  beforeEach(() => {
    installMockStorage();
    __resetWindowLayoutCacheForTests();
    invokeMock.mockClear();
    getByLabelMock.mockClear();
    getByLabelMock.mockResolvedValue(mainWindow);
    currentWindow.emit.mockClear();
    mainWindow.emit.mockClear();
  });

  it('clears persisted main-window layout state and emits a live reset event', async () => {
    window.localStorage.setItem('tauri-ai:window-layout:v2:main', JSON.stringify({ panes: ['x'] }));
    window.localStorage.setItem('tauri-ai:workspace-layout:v2:main', JSON.stringify({ panes: ['y'] }));
    window.localStorage.setItem('tauri-ai:workspace-tabs:v2:main', JSON.stringify({ tabOrder: ['chat:a'] }));
    window.localStorage.setItem('tauri-ai:workspace-layout:v1', JSON.stringify({ legacy: true }));
    window.localStorage.setItem('tauri-ai:workspace-tabs:v1', JSON.stringify({ legacy: true }));
    upsertWindowRecord({
      label: 'main',
      title: 'tauri-ai',
      params: { view: 'chat', standalone: false },
      bounds: null,
      updatedAt: 1,
    });
    upsertWindowRecord({
      label: 'view-chat-2',
      title: 'Chat 2',
      params: { view: 'chat', standalone: true },
      bounds: null,
      updatedAt: 2,
    });

    await requestMainWindowReset();

    expect(window.localStorage.getItem('tauri-ai:window-layout:v2:main')).toBeNull();
    expect(window.localStorage.getItem('tauri-ai:workspace-layout:v2:main')).toBeNull();
    expect(window.localStorage.getItem('tauri-ai:workspace-tabs:v2:main')).toBeNull();
    expect(window.localStorage.getItem('tauri-ai:workspace-layout:v1')).toBeNull();
    expect(window.localStorage.getItem('tauri-ai:workspace-tabs:v1')).toBeNull();
    expect(readWindowLayout().windows.map((item) => item.label)).toEqual(['view-chat-2']);
    expect(getByLabelMock).toHaveBeenCalledWith('main');
    expect(mainWindow.emit).toHaveBeenCalledWith(RESET_MAIN_WINDOW_EVENT);
  });
});
