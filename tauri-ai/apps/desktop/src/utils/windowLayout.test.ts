import { beforeEach, describe, expect, it } from 'vitest';
import type { ViewWindowParams } from './viewWindow';
import {
  __resetWindowLayoutCacheForTests,
  clampWindowBoundsToMonitors,
  getWindowRecord,
  MIN_WINDOW_HEIGHT,
  readWindowLayout,
  upsertWindowRecord,
} from './windowLayout';

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

const baseParams: ViewWindowParams = {
  view: 'chat',
  standalone: true,
  noDefaultSession: false,
  conversationId: null,
  runMode: null,
  agentName: null,
  documentPath: null,
  workstudioId: null,
  webUrl: null,
  webTitle: null,
  terminalWorkdir: null,
  terminalTitle: null,
  filePath: null,
  line: null,
  column: null,
  endLine: null,
  endColumn: null,
};

describe('windowLayout', () => {
  beforeEach(() => {
    installMockStorage();
    __resetWindowLayoutCacheForTests();
  });

  it('preserves existing bounds when a later update omits them', () => {
    upsertWindowRecord({
      label: 'view-chat-1',
      title: 'Chat 1',
      params: baseParams,
      bounds: { x: 120, y: 180, width: 960, height: 720 },
    });

    upsertWindowRecord({
      label: 'view-chat-1',
      title: 'Chat 1 Renamed',
      params: { ...baseParams, conversationId: 'conv-1' },
      bounds: null,
    });

    expect(getWindowRecord('view-chat-1')).toEqual(
      expect.objectContaining({
        title: 'Chat 1 Renamed',
        params: expect.objectContaining({ conversationId: 'conv-1' }),
        bounds: { x: 120, y: 180, width: 960, height: 720 },
      })
    );
  });


  it('merges the latest shared layout before writing a new window record', () => {
    upsertWindowRecord({
      label: 'view-chat-a',
      title: 'Chat A',
      params: { ...baseParams, conversationId: 'conv-a' },
      bounds: { x: 10, y: 20, width: 600, height: 500 },
      updatedAt: 1,
    });

    window.localStorage.setItem(
      'tauri-ai:window-layout:v1',
      JSON.stringify({
        version: 1,
        windows: [
          {
            label: 'view-chat-a',
            title: 'Chat A',
            params: { ...baseParams, conversationId: 'conv-a' },
            bounds: { x: 10, y: 20, width: 600, height: 500 },
            updatedAt: 1,
          },
          {
            label: 'view-chat-b',
            title: 'Chat B',
            params: { ...baseParams, conversationId: 'conv-b' },
            bounds: { x: 30, y: 40, width: 700, height: 520 },
            updatedAt: 2,
          },
        ],
      })
    );

    upsertWindowRecord({
      label: 'view-chat-c',
      title: 'Chat C',
      params: { ...baseParams, conversationId: 'conv-c' },
      bounds: { x: 50, y: 60, width: 800, height: 540 },
      updatedAt: 3,
    });

    expect(readWindowLayout().windows.map((item) => item.label)).toEqual([
      'view-chat-a',
      'view-chat-b',
      'view-chat-c',
    ]);
  });

  it('allows restoring a window on a secondary monitor without forcing it back to center', () => {
    const bounds = clampWindowBoundsToMonitors(
      { x: -1580, y: 120, width: 900, height: 680 },
      [
        { workArea: { position: { x: -1728, y: 25 }, size: { width: 1728, height: 1117 } } },
        { workArea: { position: { x: 0, y: 25 }, size: { width: 2560, height: 1415 } } },
      ]
    );

    expect(bounds).toEqual({ x: -1580, y: 120, width: 900, height: 680 });
  });

  it('clamps an off-screen window into the nearest monitor work area instead of letting the OS recenter it', () => {
    const bounds = clampWindowBoundsToMonitors(
      { x: 4200, y: 1200, width: 900, height: 680 },
      [
        { workArea: { position: { x: 0, y: 25 }, size: { width: 1728, height: 1055 } } },
        { workArea: { position: { x: 1728, y: 25 }, size: { width: 1728, height: 1055 } } },
      ]
    );

    expect(bounds).toEqual({ x: 2556, y: 400, width: 900, height: 680 });
  });

  it('uses the reduced minimum stored window height', () => {
    upsertWindowRecord({
      label: 'view-chat-small',
      title: 'Small Chat',
      params: baseParams,
      bounds: { x: 10, y: 20, width: 320, height: 80 },
    });

    expect(getWindowRecord('view-chat-small')?.bounds?.height).toBe(MIN_WINDOW_HEIGHT);
  });

  it('overrides bounds when a later update provides a new geometry', () => {
    upsertWindowRecord({
      label: 'view-workstudio-1',
      title: 'Workstudio',
      params: { ...baseParams, view: 'workstudio' },
      bounds: { x: 40, y: 60, width: 800, height: 600 },
    });

    upsertWindowRecord({
      label: 'view-workstudio-1',
      title: 'Workstudio',
      params: { ...baseParams, view: 'workstudio', workstudioId: 'ws-1' },
      bounds: { x: 200, y: 220, width: 1280, height: 900 },
    });

    expect(getWindowRecord('view-workstudio-1')?.bounds).toEqual({
      x: 200,
      y: 220,
      width: 1280,
      height: 900,
    });
  });
});
