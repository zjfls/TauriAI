import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import type { WorkspaceTabId } from './workspaceTabStore';
import { getWindowLabelForStorage, getWindowScopedStorageKey, isMainWindowLabel } from '../utils/windowStorage';

export interface WorkspacePane {
  id: string;
  tabIds: WorkspaceTabId[];
  activeTabId: WorkspaceTabId | null;
  /** 用于横向分屏的宽度权重（flex-grow） */
  weight: number;
}

const STORAGE_KEY_PREFIX = 'tauri-ai:workspace-layout:v2';
const LEGACY_STORAGE_KEY = 'tauri-ai:workspace-layout:v1';

const getStorageKey = (): string => getWindowScopedStorageKey(STORAGE_KEY_PREFIX);

const normalizePaneWeights = (panes: WorkspacePane[]): WorkspacePane[] => {
  if (panes.length === 0) return panes;
  const sanitized = panes.map((p) => ({
    ...p,
    weight: Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1,
  }));
  const total = sanitized.reduce((acc, p) => acc + p.weight, 0);
  if (!Number.isFinite(total) || total <= 0) return sanitized.map((p) => ({ ...p, weight: 1 }));
  return sanitized;
};

const ensureAtLeastOnePane = (panes: WorkspacePane[]): WorkspacePane[] => {
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
  panes: WorkspacePane[],
  focusedPaneId: string | null
): { panes: WorkspacePane[]; focusedPaneId: string | null } => {
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

const isWorkspaceTabIdString = (s: unknown): s is WorkspaceTabId => {
  return (
    typeof s === 'string' &&
    (s.startsWith('chat:') ||
      s.startsWith('doc:') ||
      s.startsWith('web:') ||
      s.startsWith('term:') ||
      s.startsWith('ws:'))
  );
};

const loadInitialLayout = (): { panes: WorkspacePane[]; focusedPaneId: string | null } => {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : null;
    const key = getStorageKey();
    let raw = storage?.getItem(key);

    // Migration (main window): v1 global key -> v2 window-scoped key.
    if (!raw) {
      const label = getWindowLabelForStorage();
      if (isMainWindowLabel(label)) {
        raw = storage?.getItem(LEGACY_STORAGE_KEY);
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
    const panes: WorkspacePane[] = panesRaw
      .map((p): WorkspacePane | null => {
        const id = typeof p.id === 'string' ? p.id : null;
        if (!id) return null;

        const tabIds = Array.isArray(p.tabIds) ? p.tabIds.filter(isWorkspaceTabIdString) : [];
        const rawActiveTabId = isWorkspaceTabIdString(p.activeTabId) ? p.activeTabId : null;
        const fallbackActive: WorkspaceTabId | null = tabIds.length > 0 ? tabIds[0]! : null;
        const activeTabId = rawActiveTabId && tabIds.includes(rawActiveTabId) ? rawActiveTabId : fallbackActive;
        const weight = typeof p.weight === 'number' ? p.weight : 1;

        return {
          id,
          tabIds,
          activeTabId,
          weight,
        };
      })
      .filter((p): p is WorkspacePane => p !== null);

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

const persistLayout = (next: { panes: WorkspacePane[]; focusedPaneId: string | null }) => {
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

const findPaneIndexByTabId = (panes: WorkspacePane[], tabId: WorkspaceTabId): number => {
  return panes.findIndex((p) => p.tabIds.includes(tabId));
};

interface WorkspaceLayoutState {
  panes: WorkspacePane[];
  focusedPaneId: string | null;

  setFocusedPane: (paneId: string) => void;
  setActiveTabInPane: (paneId: string, tabId: WorkspaceTabId) => void;
  openTabInFocusedPane: (tabId: WorkspaceTabId, opts?: { activate?: boolean }) => void;
  closeTabInLayout: (tabId: WorkspaceTabId) => void;
  reorderTabInPane: (paneId: string, activeId: WorkspaceTabId, overId: WorkspaceTabId) => void;
  moveTabToPane: (tabId: WorkspaceTabId, toPaneId: string, toIndex?: number) => void;
  splitTabToNewPane: (tabId: WorkspaceTabId, direction: 'left' | 'right', targetPaneId: string) => void;
  closePaneAndMerge: (paneId: string) => void;
  setPaneWeights: (weights: Array<{ paneId: string; weight: number }>) => void;
  saveLayout: () => void;
  replaceLayout: (next: { panes: WorkspacePane[]; focusedPaneId: string | null }) => void;
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>((set, get) => {
  const initial = typeof window === 'undefined' ? { panes: ensureAtLeastOnePane([]), focusedPaneId: null } : loadInitialLayout();

  return {
    panes: initial.panes,
    focusedPaneId: initial.focusedPaneId,

    setFocusedPane: (paneId) => {
      set({ focusedPaneId: paneId });
      persistLayout({ panes: get().panes, focusedPaneId: paneId });
    },

    setActiveTabInPane: (paneId, tabId) => {
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
        persistLayout(next);
        return next;
      });
    },

    openTabInFocusedPane: (tabId, opts) => {
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
          persistLayout(next);
          return next;
        }

        const focusedPaneId =
          state.focusedPaneId && nextPanes.some((p) => p.id === state.focusedPaneId)
            ? state.focusedPaneId
            : nextPanes[0]!.id;
        const idx = Math.max(0, nextPanes.findIndex((p) => p.id === focusedPaneId));
        const pane = nextPanes[idx] ?? nextPanes[0]!;
        pane.tabIds.push(tabId);
        if (opts?.activate !== false) pane.activeTabId = tabId;

        const next = {
          panes: normalizePaneWeights(nextPanes),
          focusedPaneId: pane.id,
        };
        persistLayout(next);
        return next;
      });
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

        const next = { panes: compacted.panes, focusedPaneId: compacted.focusedPaneId };
        persistLayout(next);
        return next;
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
        persistLayout(next);
        return next;
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
        persistLayout(next);
        return next;
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

        const newPane: WorkspacePane = {
          id: crypto.randomUUID(),
          tabIds: [tabId],
          activeTabId: tabId,
          weight: newPaneWeight,
        };

        const insertAt = direction === 'left' ? targetIndex : targetIndex + 1;
        nextPanes.splice(insertAt, 0, newPane);

        const next = { panes: normalizePaneWeights(nextPanes), focusedPaneId: newPane.id };
        persistLayout(next);
        return next;
      });
    },

    closePaneAndMerge: (paneId) => {
      set((state) => {
        const basePanes = ensureAtLeastOnePane(state.panes ?? []);
        if (basePanes.length <= 1) return {};

        const nextPanes: WorkspacePane[] = basePanes.map((p) => ({
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
        persistLayout(next);
        return next;
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
        return { panes: normalizePaneWeights(nextPanes) };
      });
    },

    saveLayout: () => {
      const state = get();
      persistLayout({ panes: state.panes, focusedPaneId: state.focusedPaneId });
    },

    replaceLayout: (next) => {
      const compacted = compactEmptyPanes(next.panes, next.focusedPaneId ?? null);
      set({ panes: compacted.panes, focusedPaneId: compacted.focusedPaneId });
      persistLayout(compacted);
    },
  };
});
