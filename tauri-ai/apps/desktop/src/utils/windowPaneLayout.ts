import type { WindowPane, WindowTabId } from '../stores/windowLayoutStore';

export type WindowPaneLayoutSnapshot = {
  panes: WindowPane[];
  focusedPaneId: string | null;
  lastUserPaneId?: string | null;
  lastUserChatPaneId?: string | null;
};

export type ReconcileWindowPaneLayoutOptions = {
  validTabIds: Iterable<WindowTabId>;
  requiredTabIds?: Iterable<WindowTabId>;
  fallbackPaneId: string;
  fallbackTabIds?: Iterable<WindowTabId>;
  fallbackActiveTabId?: WindowTabId | null;
};

const normalizePaneWeight = (weight: number): number => {
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
};

const collectUniqueValidTabIds = (
  input: Iterable<WindowTabId> | undefined,
  validTabIdSet: ReadonlySet<WindowTabId>
): WindowTabId[] => {
  if (!input) return [];
  const out: WindowTabId[] = [];
  const seen = new Set<WindowTabId>();
  for (const rawTabId of input) {
    if (typeof rawTabId !== 'string') continue;
    if (!validTabIdSet.has(rawTabId)) continue;
    if (seen.has(rawTabId)) continue;
    seen.add(rawTabId);
    out.push(rawTabId);
  }
  return out;
};

export const isChatWindowTabId = (tabId: WindowTabId | null | undefined): boolean => {
  return typeof tabId === 'string' && tabId.startsWith('chat:');
};

export const resolvePreferredChatPaneId = (
  panes: WindowPane[],
  focusedPaneId: string | null,
  lastUserPaneId: string | null,
  lastUserChatPaneId: string | null
): string | null => {
  if (lastUserChatPaneId && panes.some((pane) => pane.id === lastUserChatPaneId && pane.tabIds.some((id) => isChatWindowTabId(id)))) {
    return lastUserChatPaneId;
  }

  if (lastUserPaneId) {
    const pane = panes.find((item) => item.id === lastUserPaneId) ?? null;
    if (pane && pane.tabIds.some((id) => isChatWindowTabId(id))) return pane.id;
  }

  if (focusedPaneId) {
    const pane = panes.find((item) => item.id === focusedPaneId) ?? null;
    if (pane && pane.tabIds.some((id) => isChatWindowTabId(id))) return pane.id;
  }

  return panes.find((pane) => pane.tabIds.some((id) => isChatWindowTabId(id)))?.id ?? focusedPaneId ?? panes[0]?.id ?? null;
};

export const resolvePreferredWindowPaneId = (
  panes: WindowPane[],
  focusedPaneId: string | null,
  lastUserPaneId: string | null,
  lastUserChatPaneId: string | null,
  tabId?: WindowTabId | null
): string | null => {
  if (tabId && isChatWindowTabId(tabId)) {
    return resolvePreferredChatPaneId(panes, focusedPaneId, lastUserPaneId, lastUserChatPaneId);
  }

  if (lastUserPaneId && panes.some((pane) => pane.id === lastUserPaneId)) return lastUserPaneId;
  if (focusedPaneId && panes.some((pane) => pane.id === focusedPaneId)) return focusedPaneId;
  return panes[0]?.id ?? null;
};

export const windowPaneLayoutKey = (snapshot: Pick<WindowPaneLayoutSnapshot, 'panes' | 'focusedPaneId'>): string => {
  return `${snapshot.focusedPaneId ?? ''}|${snapshot.panes
    .map((pane) => `${pane.id}:${pane.activeTabId ?? ''}:${pane.tabIds.join(',')}:${pane.weight}`)
    .join('|')}`;
};

export const reconcileWindowPaneLayoutSnapshot = (
  snapshot: WindowPaneLayoutSnapshot,
  options: ReconcileWindowPaneLayoutOptions
): { panes: WindowPane[]; focusedPaneId: string | null } => {
  const validTabIdSet = new Set<WindowTabId>();
  for (const rawTabId of options.validTabIds) {
    if (typeof rawTabId !== 'string') continue;
    validTabIdSet.add(rawTabId);
  }

  const requiredTabIds = collectUniqueValidTabIds(options.requiredTabIds, validTabIdSet);
  const fallbackTabIds = collectUniqueValidTabIds(options.fallbackTabIds ?? requiredTabIds, validTabIdSet);

  const basePanes = Array.isArray(snapshot.panes) && snapshot.panes.length > 0
    ? snapshot.panes
    : [
        {
          id: options.fallbackPaneId,
          tabIds: [],
          activeTabId: null,
          weight: 1,
        },
      ];

  const assigned = new Set<WindowTabId>();
  let nextPanes: WindowPane[] = basePanes.map((pane, idx) => {
    const paneId = typeof pane.id === 'string' && pane.id.trim() ? pane.id.trim() : idx === 0 ? options.fallbackPaneId : `${options.fallbackPaneId}-${idx}`;
    const tabIds: WindowTabId[] = [];
    for (const rawTabId of Array.isArray(pane.tabIds) ? pane.tabIds : []) {
      if (typeof rawTabId !== 'string') continue;
      if (!validTabIdSet.has(rawTabId)) continue;
      if (assigned.has(rawTabId)) continue;
      assigned.add(rawTabId);
      tabIds.push(rawTabId);
    }
    const rawActiveTabId = typeof pane.activeTabId === 'string' ? pane.activeTabId : null;
    const activeTabId = rawActiveTabId && tabIds.includes(rawActiveTabId)
      ? rawActiveTabId
      : options.fallbackActiveTabId && tabIds.includes(options.fallbackActiveTabId)
        ? options.fallbackActiveTabId
        : tabIds[0] ?? null;

    return {
      id: paneId,
      tabIds,
      activeTabId,
      weight: normalizePaneWeight(pane.weight),
    };
  });

  let nextFocusedPaneId =
    snapshot.focusedPaneId && nextPanes.some((pane) => pane.id === snapshot.focusedPaneId)
      ? snapshot.focusedPaneId
      : nextPanes[0]?.id ?? null;

  const ensureTargetPane = (preferredPaneId: string | null): WindowPane => {
    if (nextPanes.length === 0) {
      const created: WindowPane = {
        id: preferredPaneId || options.fallbackPaneId,
        tabIds: [],
        activeTabId: null,
        weight: 1,
      };
      nextPanes = [created];
      if (!nextFocusedPaneId) nextFocusedPaneId = created.id;
      return created;
    }

    if (preferredPaneId) {
      const existing = nextPanes.find((pane) => pane.id === preferredPaneId) ?? null;
      if (existing) return existing;
    }

    return nextPanes[0]!;
  };

  for (const tabId of requiredTabIds) {
    if (assigned.has(tabId)) continue;
    const preferredPaneId = resolvePreferredWindowPaneId(
      nextPanes,
      nextFocusedPaneId,
      snapshot.lastUserPaneId ?? null,
      snapshot.lastUserChatPaneId ?? null,
      tabId
    );
    const targetPane = ensureTargetPane(preferredPaneId);
    targetPane.tabIds.push(tabId);
    assigned.add(tabId);
    if (!targetPane.activeTabId) {
      targetPane.activeTabId = tabId;
    }
  }

  nextPanes = nextPanes.filter((pane) => pane.tabIds.length > 0);

  if (nextPanes.length === 0) {
    nextPanes = [
      {
        id: options.fallbackPaneId,
        tabIds: [...fallbackTabIds],
        activeTabId:
          options.fallbackActiveTabId && fallbackTabIds.includes(options.fallbackActiveTabId)
            ? options.fallbackActiveTabId
            : fallbackTabIds[0] ?? null,
        weight: 1,
      },
    ];
  }

  nextPanes = nextPanes.map((pane) => {
    const activeTabId = pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
      ? pane.activeTabId
      : options.fallbackActiveTabId && pane.tabIds.includes(options.fallbackActiveTabId)
        ? options.fallbackActiveTabId
        : pane.tabIds[0] ?? null;

    return {
      ...pane,
      activeTabId,
      weight: normalizePaneWeight(pane.weight),
    };
  });

  nextFocusedPaneId =
    nextFocusedPaneId && nextPanes.some((pane) => pane.id === nextFocusedPaneId)
      ? nextFocusedPaneId
      : nextPanes[0]?.id ?? null;

  return {
    panes: nextPanes,
    focusedPaneId: nextFocusedPaneId,
  };
};
