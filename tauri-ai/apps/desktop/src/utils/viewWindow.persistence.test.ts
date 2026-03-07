import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetWindowLayoutCacheForTests, upsertWindowRecord } from './windowLayout';

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

const createdWindows = vi.hoisted(() => [] as Array<{ label: string; options: Record<string, unknown> }>);
const knownWindows = vi.hoisted(() => new Map<string, unknown>());
const getByLabelMock = vi.hoisted(() => vi.fn(async (label: string) => knownWindows.get(label) ?? null));
const cursorPositionMock = vi.hoisted(() => vi.fn(async () => ({ x: 0, y: 0 })));
const currentWindow = vi.hoisted(() => ({
  label: 'main',
  outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  outerSize: vi.fn(async () => ({ width: 1440, height: 900 })),
  innerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  scaleFactor: vi.fn(async () => 1),
  setFocus: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/window', () => ({
  cursorPosition: cursorPositionMock,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class MockWebviewWindow {
    static getByLabel = getByLabelMock;
    static getAll = vi.fn(async () => []);

    label: string;
    options: Record<string, unknown>;

    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      this.options = options;
      createdWindows.push({ label, options });
      knownWindows.set(label, this);
    }

    once = vi.fn();
    emit = vi.fn(async () => undefined);
    setFocus = vi.fn(async () => undefined);
    setTitle = vi.fn(async () => undefined);
    outerPosition = vi.fn(async () => ({ x: 0, y: 0 }));
    outerSize = vi.fn(async () => ({ width: 1440, height: 900 }));
    innerPosition = vi.fn(async () => ({ x: 0, y: 0 }));
    scaleFactor = vi.fn(async () => 1);
    show = vi.fn(async () => undefined);
    isMinimized = vi.fn(async () => false);
    unminimize = vi.fn(async () => undefined);
  }

  return {
    WebviewWindow: MockWebviewWindow,
    getCurrentWebviewWindow: () => currentWindow,
  };
});

import { openOrFocusViewWindow, openViewWindow } from './viewWindow';

describe('viewWindow persistence', () => {
  beforeEach(() => {
    installMockStorage();
    __resetWindowLayoutCacheForTests();
    createdWindows.length = 0;
    knownWindows.clear();
    getByLabelMock.mockClear();
    getByLabelMock.mockImplementation(async (label: string) => knownWindows.get(label) ?? null);
    cursorPositionMock.mockClear();
    cursorPositionMock.mockImplementation(async () => ({ x: 0, y: 0 }));
  });

  it('reuses persisted bounds when opening a standalone window without explicit geometry', () => {
    upsertWindowRecord({
      label: 'view-chat-conv-1',
      title: 'Chat 1',
      params: {
        view: 'chat',
        standalone: true,
        noDefaultSession: true,
        conversationId: 'conv-1',
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
      },
      bounds: { x: 300, y: 220, width: 1100, height: 760 },
    });

    openViewWindow('chat', 'Chat 1', { label: 'view-chat-conv-1', noDefaultSession: true });

    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0]).toEqual(
      expect.objectContaining({
        label: 'view-chat-conv-1',
        options: expect.objectContaining({
          x: 300,
          y: 220,
          width: 1100,
          height: 760,
        }),
      })
    );
  });

  it('prefers explicit geometry over persisted bounds when both exist', () => {
    upsertWindowRecord({
      label: 'view-workstudio-ws-1',
      title: 'Workstudio',
      params: {
        view: 'workstudio',
        standalone: true,
        noDefaultSession: true,
        conversationId: null,
        runMode: null,
        agentName: null,
        documentPath: null,
        workstudioId: 'ws-1',
        webUrl: null,
        webTitle: null,
        terminalWorkdir: null,
        terminalTitle: null,
        filePath: null,
        line: null,
        column: null,
        endLine: null,
        endColumn: null,
      },
      bounds: { x: 20, y: 30, width: 700, height: 500 },
    });

    openViewWindow('workstudio', 'Workstudio', {
      label: 'view-workstudio-ws-1',
      workstudioId: 'ws-1',
      noDefaultSession: true,
      window: { x: 500, y: 360, width: 1280, height: 840 },
    });

    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0]?.options).toEqual(
      expect.objectContaining({
        x: 500,
        y: 360,
        width: 1280,
        height: 840,
      })
    );
  });

  it('reuses persisted bounds in openOrFocusViewWindow when recreating a labeled window', async () => {
    upsertWindowRecord({
      label: 'view-chat-conv-2',
      title: 'Chat 2',
      params: {
        view: 'chat',
        standalone: true,
        noDefaultSession: true,
        conversationId: 'conv-2',
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
      },
      bounds: { x: 640, y: 120, width: 900, height: 680 },
    });

    await openOrFocusViewWindow('chat', 'Chat 2', {
      label: 'view-chat-conv-2',
      conversationId: 'conv-2',
      noDefaultSession: true,
    });

    expect(getByLabelMock).toHaveBeenCalledWith('view-chat-conv-2');
    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0]?.options).toEqual(
      expect.objectContaining({
        x: 640,
        y: 120,
        width: 900,
        height: 680,
      })
    );
  });
});
