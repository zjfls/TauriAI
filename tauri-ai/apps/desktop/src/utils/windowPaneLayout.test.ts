import { describe, expect, it } from 'vitest';
import { reconcileWindowPaneLayoutSnapshot, resolvePreferredWindowPaneId } from './windowPaneLayout';
import type { WindowPane } from '../stores/windowLayoutStore';

describe('windowPaneLayout', () => {
  it('appends missing required tabs without dropping existing panes', () => {
    const panes: WindowPane[] = [
      { id: 'left', tabIds: ['doc:a'], activeTabId: 'doc:a', weight: 1 },
      { id: 'right', tabIds: ['chat:1'], activeTabId: 'chat:1', weight: 1 },
    ];

    const next = reconcileWindowPaneLayoutSnapshot(
      {
        panes,
        focusedPaneId: 'left',
        lastUserPaneId: 'left',
        lastUserChatPaneId: 'right',
      },
      {
        validTabIds: ['doc:a', 'chat:1', 'chat:2'],
        requiredTabIds: ['doc:a', 'chat:1', 'chat:2'],
        fallbackPaneId: 'fallback',
        fallbackTabIds: ['doc:a', 'chat:1', 'chat:2'],
        fallbackActiveTabId: 'chat:1',
      }
    );

    expect(next.panes).toEqual([
      { id: 'left', tabIds: ['doc:a'], activeTabId: 'doc:a', weight: 1 },
      { id: 'right', tabIds: ['chat:1', 'chat:2'], activeTabId: 'chat:1', weight: 1 },
    ]);
    expect(next.focusedPaneId).toBe('left');
  });

  it('rebuilds a single fallback pane when layout is empty', () => {
    const next = reconcileWindowPaneLayoutSnapshot(
      {
        panes: [],
        focusedPaneId: null,
      },
      {
        validTabIds: ['chat:1', 'doc:a'],
        requiredTabIds: ['chat:1', 'doc:a'],
        fallbackPaneId: 'fallback',
        fallbackTabIds: ['chat:1', 'doc:a'],
        fallbackActiveTabId: 'chat:1',
      }
    );

    expect(next.panes).toEqual([
      { id: 'fallback', tabIds: ['chat:1', 'doc:a'], activeTabId: 'chat:1', weight: 1 },
    ]);
    expect(next.focusedPaneId).toBe('fallback');
  });

  it('filters invalid tabs and fixes focus', () => {
    const next = reconcileWindowPaneLayoutSnapshot(
      {
        panes: [
          { id: 'p1', tabIds: ['missing'], activeTabId: 'missing', weight: 0 },
          { id: 'p2', tabIds: ['doc:a'], activeTabId: 'doc:a', weight: 2 },
        ],
        focusedPaneId: 'missing-pane',
      },
      {
        validTabIds: ['doc:a'],
        requiredTabIds: ['doc:a'],
        fallbackPaneId: 'fallback',
        fallbackTabIds: ['doc:a'],
        fallbackActiveTabId: 'doc:a',
      }
    );

    expect(next.panes).toEqual([{ id: 'p2', tabIds: ['doc:a'], activeTabId: 'doc:a', weight: 2 }]);
    expect(next.focusedPaneId).toBe('p2');
  });

  it('prefers the last chat pane for chat tabs', () => {
    const panes: WindowPane[] = [
      { id: 'left', tabIds: ['doc:a'], activeTabId: 'doc:a', weight: 1 },
      { id: 'right', tabIds: ['chat:1'], activeTabId: 'chat:1', weight: 1 },
    ];

    expect(resolvePreferredWindowPaneId(panes, 'left', 'left', 'right', 'chat:2')).toBe('right');
    expect(resolvePreferredWindowPaneId(panes, 'left', 'left', 'right', 'doc:b')).toBe('left');
  });
});
