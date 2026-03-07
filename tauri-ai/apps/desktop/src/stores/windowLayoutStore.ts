import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import { getWindowLabelForStorage, getWindowScopedStorageKey, isMainWindowLabel } from '../utils/windowStorage';
import { recordWindowInteraction } from '../utils/windowInteractionRouting';

export type WindowTabId = string;

export interface WindowPane {
  id: string;
  tabIds: WindowTabId[];
  activeTabId: WindowTabId | null;
  /** 用于横向分屏的宽度权重（flex-grow） */
  weight: number;
}

const STORAGE_KEY_PREFIX = 'tauri-ai:window-layout:v2';
const LEGACY_STORAGE_KEY = 'tauri-ai:workspace-layout:v2';
const LEGACY_GLOBAL_STORAGE_KEY = 'tauri-ai:workspace-layout:v1';
const FOCUSED_PANE_PERSIST_DEBOUNCE_MS = 120;

let focusedPanePersistTimeout: ReturnType<typeof setTimeout> | null = null;

const getStorageKey = (): string => getWindowScopedStorageKey(STORAGE_KEY_PREFIX);

const normalizePaneWeights = (panes: WindowPane[]): WindowPane[] => {
  if (panes.length === 0) return panes;
  const sanitized = panes.map((p) => ({
    ...p,
    weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
  }));
  const total = sanitized.reduce((acc, p) => acc + p.weight, 0);
  if (!Number.isFinite(total) || total <= 0) return sanitized.map((p) => ({ ...p, weight: 1 }));
  return sanitized;
};

const ensureAtLeastOnePane = (panes: WindowPane[]): WindowPane[] => {
  if (panes.length > 0) return panes;
  return [
    {
      id: crypto.randomUUID(),
      tabIds: [],
      activeTabId: null,
      weight: 1,
    },
  ];
};

const compactEmptyPanes = (
  panes: WindowPane[],
  focusedPaneId: string | null
): { panes: WindowPane[]; focusedPaneId: string | null } => {
  let nextFocusedPaneId = focusedPaneId;
  let nextPanes = panes.map((p) => ({
    ...p,
    tabIds: [...p.tabIds],
    weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
  }));

  nextPanes = ensureAtLeastOnePane(nextPanes);

  // Remove empty panes if there is at least one other pane.
  for (let i = 0; i < nextPanes.length && nextPanes.length > 1; ) {
    const pane = nextPanes[i]!;
    if (pane.tabIds.length > 0) {
      i++;
      continue;
    }

    const closingWeight = Number.isFinite(pane.weight) && pane.weight > 0 ? pane.weight : 1;
    const targetIdx = i < nextPanes.length - 1 ? i + 1 : i - 1;
    const target = nextPanes[targetIdx]!;
    target.weight = (Number.isFinite(target.weight) && target.weight > 0 ? target.weight : 1) + closingWeight;

    if (nextFocusedPaneId === pane.id) nextFocusedPaneId = target.id;
    nextPanes.splice(i, 1);
  }

  nextPanes = ensureAtLeastOnePane(nextPanes).map((p) => {
    const active = p.activeTabId && p.tabIds.includes(p.activeTabId) ? p.activeTabId : p.tabIds[0] ?? null;
    return {
      ...p,
      activeTabId: active,
      weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
    };
  });

  if (!nextFocusedPaneId || !nextPanes.some((p) => p.id === nextFocusedPaneId)) {
    nextFocusedPaneId = nextPanes[0]!.id;
  }

  return { panes: normalizePaneWeights(nextPanes), focusedPaneId: nextFocusedPaneId };
};

const isWindowTabIdString = (s: unknown): s is WindowTabId => {
  return typeof s === 'string';
};

const loadInitialLayout = (): { panes: WindowPane[]; focusedPaneId: string | null } => {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : null;
    const key = getStorageKey();
    let raw = storage?.getItem(key);

    // Migration: workspace v2 key -> window v2 key.
    if (!raw) {
      raw = storage?.getItem(getWindowScopedStorageKey(LEGACY_STORAGE_KEY));
    }

    // Migration (main window): v1 global key -> v2 window-scoped key.
    if (!raw) {
      const label = getWindowLabelForStorage();
      if (isMainWindowLabel(label)) {
        raw = storage?.getItem(LEGACY_GLOBAL_STORAGE_KEY);
      }
    }

    if (!raw) return { panes: ensureAtLeastOnePane([]), focusedPaneId: null };
    const parsed = JSON.parse(raw) as
      | {
          panes?: Array<{
            id?: unknown;
            tabIds?: unknown;
            activeTabId?: unknown;
            weight?: unknown;
          }>;
          focusedPaneId?: unknown;
        }
      | null;

    const panesRaw = Array.isArray(parsed?.panes) ? parsed!.panes! : [];
    const panes: WindowPane[] = panesRaw
      .map((p): WindowPane | null => {
        const id = typeof p.id === 'string' ? p.id : null;
        if (!id) return null;

        const tabIds = Array.isArray(p.tabIds) ? p.tabIds.filter(isWindowTabIdString) : [];
        const rawActiveTabId = isWindowTabIdString(p.activeTabId) ? p.activeTabId : null;
        const fallbackActive: WindowTabId | null = tabIds.length > 0 ? tabIds[0]! : null;
        const activeTabId = rawActiveTabId && tabIds.includes(rawActiveTabId) ? rawActiveTabId : fallbackActive;
        const weight = typeof p.weight === 'number' ? p.weight : 1;

        return {
          id,
          tabIds,
          activeTabId,
          weight,
        };
      })
      .filter((p): p is WindowPane => p !== null);

    const focusedPaneId = typeof parsed?.focusedPaneId === 'string' ? (parsed?.focusedPaneId as string) : null;
    const compacted = compactEmptyPanes(panes, focusedPaneId);

    // Best-effort persist to the new v2 key after a successful parse (covers v1 migration).
    try {
      storage?.setItem(key, JSON.stringify({ panes: compacted.panes, focusedPaneId: compacted.focusedPaneId }));
    } catch {
      // ignore
    }

    return compacted;
  } catch {
    return { panes: ensureAtLeastOnePane([]), focusedPaneId: null };
  }
};

const persistLayout = (next: { panes: WindowPane[]; focusedPaneId: string | null }) => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      getStorageKey(),
      JSON.stringify({
        panes: next.panes,
        focusedPaneId: next.focusedPaneId,
      })
    );
  } catch {
    // ignore
  }
};

const scheduleFocusedPanePersist = (readLayout: () => { panes: WindowPane[]; focusedPaneId: string | null }) => {
  if (typeof window === 'undefined') return;
  if (focusedPanePersistTimeout !== null) {
    window.clearTimeout(focusedPanePersistTimeout);
  }
  focusedPanePersistTimeout = window.setTimeout(() => {
    focusedPanePersistTimeout = null;
    persistLayout(readLayout());
  }, FOCUSED_PANE_PERSIST_DEBOUNCE_MS);
};

const findPaneIndexByTabId = (panes: WindowPane[], tabId: WindowTabId): number => {
  return panes.findIndex((p) => p.tabIds.includes(tabId));
};

const isChatTabId = (tabId: WindowTabId | null | undefined): boolean => {
  return typeof tabId === 'string' && tabId.startsWith('chat:');
};

const resolveInteractionTargets = (
  panes: WindowPane[],
  focusedPaneId: string | null,
  lastUserPaneId: string | null,
  lastUserChatPaneId: string | null
): { lastUserPaneId: string | null; lastUserChatPaneId: string | null } => {
  const resolvedFocusedPaneId =
    focusedPaneId && panes.some((p) => p.id === focusedPaneId) ? focusedPaneId : panes[0]?.id ?? null;

  const nextLastUserPaneId =
    lastUserPaneId && panes.some((p) => p.id === lastUserPaneId)
      ? lastUserPaneId
      : resolvedFocusedPaneId;

  const nextLastUserChatPaneId =
    lastUserChatPaneId && panes.some((p) => p.id === lastUserChatPaneId && p.tabIds.some((id) => isChatTabId(id)))
      ? lastUserChatPaneId
      : panes.find((p) => p.tabIds.some((id) => isChatTabId(id)))?.id ?? null;

  return {
    lastUserPaneId: nextLastUserPaneId,
    lastUserChatPaneId: nextLastUserChatPaneId,
  };
};

const resolvePreferredChatPaneId = (
  panes: WindowPane[],
  focusedPaneId: string | null,
  lastUserPaneId: string | null,
  lastUserChatPaneId: string | null
): string | null => {
  if (lastUserChatPaneId && panes.some((p) => p.id === lastUserChatPaneId && p.tabIds.some((id) => isChatTabId(id)))) {
    return lastUserChatPaneId;
  }

  if (lastUserPaneId) {
    const pane = panes.find((p) => p.id === lastUserPaneId) ?? null;
    if (pane && pane.tabIds.some((id) => isChatTabId(id))) return pane.id;
  }

  if (focusedPaneId) {
    const pane = panes.find((p) => p.id === focusedPaneId) ?? null;
    if (pane && pane.tabIds.some((id) => isChatTabId(id))) return pane.id;
  }

  return panes.find((p) => p.tabIds.some((id) => isChatTabId(id)))?.id ?? focusedPaneId ?? panes[0]?.id ?? null;
};

const resolvePreferredPaneId = (
  panes: WindowPane[],
  focusedPaneId: string | null,
  lastUserPaneId: string | null,
  lastUserChatPaneId: string | null,
  tabId?: WindowTabId | null
): string | null => {
  if (tabId && isChatTabId(tabId)) {
    return resolvePreferredChatPaneId(panes, focusedPaneId, lastUserPaneId, lastUserChatPaneId);
  }

  if (lastUserPaneId && panes.some((p) => p.id === lastUserPaneId)) return lastUserPaneId;
  if (focusedPaneId && panes.some((p) => p.id === focusedPaneId)) return focusedPaneId;
  return panes[0]?.id ?? null;
};

const resolveChatPaneForInteraction = (
  panes: WindowPane[],
  paneId: string,
  tabId?: WindowTabId | null
): string | null => {
  const pane = panes.find((p) => p.id === paneId) ?? null;
  if (!pane) return null;
  const candidate = tabId && pane.tabIds.includes(tabId) ? tabId : pane.activeTabId ?? pane.tabIds[0] ?? null;
  return isChatTabId(candidate) ? pane.id : null;
};

interface WindowLayoutState {
  panes: WindowPane[];
  focusedPaneId: string | null;
  lastUserPaneId: string | null;
  lastUserChatPaneId: string | null;

  setFocusedPane: (paneId: string, opts?: { trackUser?: boolean }) => void;
  setActiveTabInPane: (paneId: string, tabId: WindowTabId, opts?: { trackUser?: boolean }) => void;
  markUserPaneInteraction: (paneId: string, opts?: { tabId?: WindowTabId | null }) => void;
  getPreferredPaneId: (opts?: { tabId?: WindowTabId | null }) => string | null;
  getPreferredChatPaneId: () => string | null;
  getActiveChatSessionId: () => string | null;
  openTabInPane: (paneId: string | null, tabId: WindowTabId, opts?: { activate?: boolean }) => void;
  openTabInFocusedPane: (tabId: WindowTabId, opts?: { activate?: boolean }) => void;
  closeTabInLayout: (tabId: WindowTabId) => void;
  reorderTabInPane: (paneId: string, activeId: WindowTabId, overId: WindowTabId) => void;
  moveTabToPane: (tabId: WindowTabId, toPaneId: string, toIndex?: number) => void;
  splitTabToNewPane: (tabId: WindowTabId, direction: 'left' | 'right', targetPaneId: string) => void;
  closePaneAndMerge: (paneId: string) => void;
  setPaneWeights: (weights: Array<{ paneId: string; weight: number }>) => void;
  saveLayout: () => void;
  replaceLayout: (next: { panes: WindowPane[]; focusedPaneId: string | null }) => void;
}

export const useWindowLayoutStore = create<WindowLayoutState>((set, get) => {
  const initial = typeof window === 'undefined' ? { panes: ensureAtLeastOnePane([]), focusedPaneId: null } : loadInitialLayout();

  return {
    panes: initial.panes,
    focusedPaneId: initial.focusedPaneId,
    lastUserPaneId: initial.focusedPaneId ?? initial.panes[0]?.id ?? null,
    lastUserChatPaneId: initial.panes.find((p) => p.tabIds.some((id) => isChatTabId(id)))?.id ?? null,

    setFocusedPane: (paneId, opts) => {
      const current = get();
      const exists = current.panes.some((p) => p.id === paneId);
      if (!exists) return;

      const pane = current.panes.find((p) => p.id === paneId)!;
      const nextInteraction = opts?.trackUser
        ? {
            lastUserPaneId: paneId,
            lastUserChatPaneId: resolveChatPaneForInteraction(current.panes, paneId),
          }
        : {};

      if (current.focusedPaneId === paneId && !opts?.trackUser) return;

      set({ focusedPaneId: paneId, ...nextInteraction });

      if (opts?.trackUser) {
        void recordWindowInteraction({
          paneId,
          chatPaneId: resolveChatPaneForInteraction(current.panes, paneId, pane.activeTabId),
        });
      }

      scheduleFocusedPanePersist(() => {
        const state = get();
        return { panes: state.panes, focusedPaneId: state.focusedPaneId };
      });
    },

    setActiveTabInPane: (paneId, tabId, opts) => {
      let interactionPayload: { paneId: string; chatPaneId: string | null } | null = null;
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        const nextPanes = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds],
        }));
        const idx = nextPanes.findIndex((p) => p.id === paneId);
        if (idx < 0) return {};
        const pane = nextPanes[idx]!;
        if (!pane.tabIds.includes(tabId)) return {};
        pane.activeTabId = tabId;
        const next = { panes: normalizePaneWeights(nextPanes), focusedPaneId: paneId };
        const interactionTargets = resolveInteractionTargets(
          next.panes,
          next.focusedPaneId,
          opts?.trackUser ? paneId : state.lastUserPaneId,
          opts?.trackUser ? resolveChatPaneForInteraction(next.panes, paneId, tabId) : state.lastUserChatPaneId
        );
        interactionPayload = opts?.trackUser
          ? {
              paneId,
              chatPaneId: resolveChatPaneForInteraction(next.panes, paneId, tabId),
            }
          : null;
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });

      if (interactionPayload) {
        void recordWindowInteraction(interactionPayload);
      }
    },

    markUserPaneInteraction: (paneId, opts) => {
      const state = get();
      if (!state.panes.some((p) => p.id === paneId)) return;
      const chatPaneId = resolveChatPaneForInteraction(state.panes, paneId, opts?.tabId ?? null);
      set({
        lastUserPaneId: paneId,
        lastUserChatPaneId: chatPaneId ?? state.lastUserChatPaneId,
      });
      void recordWindowInteraction({ paneId, chatPaneId });
    },

    getPreferredPaneId: (opts) => {
      const state = get();
      return resolvePreferredPaneId(
        state.panes,
        state.focusedPaneId,
        state.lastUserPaneId,
        state.lastUserChatPaneId,
        opts?.tabId ?? null
      );
    },

    getPreferredChatPaneId: () => {
      const state = get();
      return resolvePreferredChatPaneId(state.panes, state.focusedPaneId, state.lastUserPaneId, state.lastUserChatPaneId);
    },

    getActiveChatSessionId: () => {
      const state = get();
      const preferredPaneId = resolvePreferredChatPaneId(
        state.panes,
        state.focusedPaneId,
        state.lastUserPaneId,
        state.lastUserChatPaneId
      );
      const pane = (preferredPaneId ? state.panes.find((p) => p.id === preferredPaneId) : null) ?? state.panes[0] ?? null;
      if (!pane) return null;
      const activeChatTab = [pane.activeTabId, ...pane.tabIds].find((id) => isChatTabId(id ?? null)) ?? null;
      return activeChatTab && isChatTabId(activeChatTab) ? activeChatTab.slice('chat:'.length) : null;
    },

    openTabInPane: (paneId, tabId, opts) => {
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        const nextPanes = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds].filter((id) => id !== tabId),
        }));

        const existingIndex = findPaneIndexByTabId(basePanes, tabId);
        if (existingIndex >= 0) {
          const existing = nextPanes[existingIndex]!;
          if (!existing.tabIds.includes(tabId)) existing.tabIds.push(tabId);
          if (opts?.activate !== false) existing.activeTabId = tabId;
          const next = {
            panes: normalizePaneWeights(nextPanes),
            focusedPaneId: existing.id,
          };
          const interactionTargets = resolveInteractionTargets(
            next.panes,
            next.focusedPaneId,
            state.lastUserPaneId,
            state.lastUserChatPaneId
          );
          persistLayout(next);
          return { ...next, ...interactionTargets };
        }

        const resolvedPaneId =
          paneId && nextPanes.some((p) => p.id === paneId)
            ? paneId
            : resolvePreferredPaneId(nextPanes, state.focusedPaneId, state.lastUserPaneId, state.lastUserChatPaneId, tabId) ??
              nextPanes[0]!.id;
        const idx = Math.max(0, nextPanes.findIndex((p) => p.id === resolvedPaneId));
        const pane = nextPanes[idx] ?? nextPanes[0]!;
        pane.tabIds.push(tabId);
        if (opts?.activate !== false) pane.activeTabId = tabId;

        const next = {
          panes: normalizePaneWeights(nextPanes),
          focusedPaneId: pane.id,
        };
        const interactionTargets = resolveInteractionTargets(
          next.panes,
          next.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });
    },

    openTabInFocusedPane: (tabId, opts) => {
      get().openTabInPane(get().focusedPaneId, tabId, opts);
    },

    closeTabInLayout: (tabId) => {
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        const nextPanes = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds],
        }));

        let removedPaneIndex = -1;
        let removedIndexInPane = -1;

        for (let i = 0; i < nextPanes.length; i++) {
          const idx = nextPanes[i]!.tabIds.indexOf(tabId);
          if (idx < 0) continue;
          removedPaneIndex = i;
          removedIndexInPane = idx;
          nextPanes[i]!.tabIds.splice(idx, 1);
          break;
        }

        if (removedPaneIndex >= 0) {
          const pane = nextPanes[removedPaneIndex]!;
          if (pane.activeTabId === tabId) {
            pane.activeTabId =
              pane.tabIds.length > 0 ? pane.tabIds[Math.min(removedIndexInPane, pane.tabIds.length - 1)]! : null;
          }
        }

        const compacted = compactEmptyPanes(nextPanes, state.focusedPaneId ?? null);
        const interactionTargets = resolveInteractionTargets(
          compacted.panes,
          compacted.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );

        const next = { panes: compacted.panes, focusedPaneId: compacted.focusedPaneId };
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });
    },

    reorderTabInPane: (paneId, activeId, overId) => {
      if (activeId === overId) return;
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        const nextPanes = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds],
        }));
        const idx = nextPanes.findIndex((p) => p.id === paneId);
        if (idx < 0) return {};
        const pane = nextPanes[idx]!;
        const oldIndex = pane.tabIds.indexOf(activeId);
        const newIndex = pane.tabIds.indexOf(overId);
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return {};
        pane.tabIds = arrayMove(pane.tabIds, oldIndex, newIndex);
        const next = { panes: normalizePaneWeights(nextPanes), focusedPaneId: state.focusedPaneId ?? paneId };
        const interactionTargets = resolveInteractionTargets(
          next.panes,
          next.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });
    },

    moveTabToPane: (tabId, toPaneId, toIndex) => {
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        const nextPanes = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds].filter((id) => id !== tabId),
        }));

        const targetIdx = nextPanes.findIndex((p) => p.id === toPaneId);
        if (targetIdx < 0) return {};
        const target = nextPanes[targetIdx]!;

        const insertAt =
          typeof toIndex === 'number' && Number.isFinite(toIndex)
            ? Math.max(0, Math.min(target.tabIds.length, toIndex))
            : target.tabIds.length;
        target.tabIds.splice(insertAt, 0, tabId);
        target.activeTabId = tabId;

        // 移除空 pane（只要还有其它 pane）
        let compacted = nextPanes.filter((p) => p.tabIds.length > 0 || nextPanes.length === 1);
        const compactedState = compactEmptyPanes(nextPanes, target.id);
        compacted = compactedState.panes;

        const next = { panes: compacted, focusedPaneId: compactedState.focusedPaneId };
        const interactionTargets = resolveInteractionTargets(
          next.panes,
          next.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });
    },

    splitTabToNewPane: (tabId, direction, targetPaneId) => {
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        if (basePanes.length === 0) return {};

        let nextPanes = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds].filter((id) => id !== tabId),
        }));

        nextPanes = compactEmptyPanes(nextPanes, state.focusedPaneId ?? null).panes;

        const targetIndex = Math.max(0, nextPanes.findIndex((p) => p.id === targetPaneId));
        const target = nextPanes[targetIndex] ?? nextPanes[0]!;

        const baseWeight = Number.isFinite(target.weight) && target.weight > 0 ? target.weight : 1;
        const newPaneWeight = Math.max(0.4, baseWeight / 2);
        target.weight = Math.max(0.4, baseWeight - newPaneWeight);

        const newPane: WindowPane = {
          id: crypto.randomUUID(),
          tabIds: [tabId],
          activeTabId: tabId,
          weight: newPaneWeight,
        };

        const insertAt = direction === 'left' ? targetIndex : targetIndex + 1;
        nextPanes.splice(insertAt, 0, newPane);

        const next = { panes: normalizePaneWeights(nextPanes), focusedPaneId: newPane.id };
        const interactionTargets = resolveInteractionTargets(
          next.panes,
          next.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });
    },

    closePaneAndMerge: (paneId) => {
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        if (basePanes.length <= 1) return {};

        const nextPanes: WindowPane[] = basePanes.map((p) => ({
          ...p,
          tabIds: [...p.tabIds],
        }));

        const idx = nextPanes.findIndex((p) => p.id === paneId);
        if (idx < 0) return {};

        const closing = nextPanes[idx]!;
        const targetIdx = idx < nextPanes.length - 1 ? idx + 1 : idx - 1;
        const target = nextPanes[targetIdx]!;

        for (const tid of closing.tabIds) {
          if (!target.tabIds.includes(tid)) target.tabIds.push(tid);
        }

        target.weight =
          (Number.isFinite(target.weight) ? target.weight : 1) + (Number.isFinite(closing.weight) ? closing.weight : 1);
        if (target.activeTabId && !target.tabIds.includes(target.activeTabId)) {
          target.activeTabId = target.tabIds[0] ?? null;
        }
        if (!target.activeTabId && target.tabIds.length > 0) {
          target.activeTabId = target.tabIds[0]!;
        }

        nextPanes.splice(idx, 1);

        let focusedPaneId = state.focusedPaneId;
        if (focusedPaneId === paneId) focusedPaneId = target.id;
        if (!focusedPaneId || !nextPanes.some((p) => p.id === focusedPaneId)) {
          focusedPaneId = nextPanes[0]!.id;
        }

        const next = { panes: normalizePaneWeights(nextPanes), focusedPaneId };
        const interactionTargets = resolveInteractionTargets(
          next.panes,
          next.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );
        persistLayout(next);
        return { ...next, ...interactionTargets };
      });
    },

    setPaneWeights: (weights) => {
      if (!Array.isArray(weights) || weights.length === 0) return;
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        const map = new Map(weights.map((w) => [w.paneId, w.weight] as const));
        const nextPanes = basePanes.map((p) => {
          const next = map.get(p.id);
          if (next === undefined) return p;
          return { ...p, weight: Number.isFinite(next) && next > 0 ? next : p.weight };
        });
        const panes = normalizePaneWeights(nextPanes);
        const interactionTargets = resolveInteractionTargets(
          panes,
          state.focusedPaneId,
          state.lastUserPaneId,
          state.lastUserChatPaneId
        );
        return { panes, ...interactionTargets };
      });
    },

    saveLayout: () => {
      const state = get();
      persistLayout({ panes: state.panes, focusedPaneId: state.focusedPaneId });
    },

    replaceLayout: (next) => {
      const compacted = compactEmptyPanes(next.panes, next.focusedPaneId ?? null);
      const interactionTargets = resolveInteractionTargets(
        compacted.panes,
        compacted.focusedPaneId,
        get().lastUserPaneId,
        get().lastUserChatPaneId
      );
      set({
        panes: compacted.panes,
        focusedPaneId: compacted.focusedPaneId,
        ...interactionTargets,
      });
      persistLayout(compacted);
    },
  };
});
