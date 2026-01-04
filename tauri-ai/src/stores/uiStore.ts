/**
 * UI Store
 * Manages UI state using Zustand
 * Requirements: 2.6
 */

import { create } from 'zustand';
import type { Theme, ActiveView } from '../types';

interface UIState {
  sidebarExpanded: boolean;
  activeView: ActiveView;
  theme: Theme;

  // Actions
  toggleSidebar: () => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setActiveView: (view: ActiveView) => void;
  setTheme: (theme: Theme) => void;
}

/**
 * Get the effective theme based on system preference
 */
const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return 'light';
};

/**
 * Apply theme to the document
 */
const applyTheme = (theme: Theme) => {
  if (typeof document === 'undefined') return;

  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;
  const root = document.documentElement;

  if (effectiveTheme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
};

export const useUIStore = create<UIState>((set) => ({
  sidebarExpanded: true,
  activeView: 'chat',
  theme: 'system',

  /**
   * Toggle sidebar expanded state
   */
  toggleSidebar: () => {
    set((state) => ({ sidebarExpanded: !state.sidebarExpanded }));
  },

  /**
   * Set sidebar expanded state
   */
  setSidebarExpanded: (expanded: boolean) => {
    set({ sidebarExpanded: expanded });
  },

  /**
   * Set the active view
   */
  setActiveView: (view: ActiveView) => {
    set({ activeView: view });
  },

  /**
   * Set the theme and apply it
   * Requirements: 2.6
   */
  setTheme: (theme: Theme) => {
    set({ theme });
    applyTheme(theme);
  },
}));

// Initialize theme on load and listen for system theme changes
if (typeof window !== 'undefined') {
  // Apply initial theme
  const initialTheme = useUIStore.getState().theme;
  applyTheme(initialTheme);

  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const currentTheme = useUIStore.getState().theme;
      if (currentTheme === 'system') {
        applyTheme('system');
      }
    });
  }
}
