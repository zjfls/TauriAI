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
  initializeTheme: (theme: Theme) => void;
}

/**
 * Get the effective theme based on system preference
 * Requirements: 2.6 - Detect system theme preference
 */
export const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return 'light';
};

/**
 * Get the effective theme (resolves 'system' to actual theme)
 */
export const getEffectiveTheme = (theme: Theme): 'light' | 'dark' => {
  return theme === 'system' ? getSystemTheme() : theme;
};

/**
 * Apply theme to the document root element
 * Requirements: 2.6 - Apply theme classes to root element
 */
export const applyTheme = (theme: Theme) => {
  if (typeof document === 'undefined') return;

  const effectiveTheme = getEffectiveTheme(theme);
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
   * Requirements: 2.6 - Switch between light and dark mode
   */
  setTheme: (theme: Theme) => {
    set({ theme });
    applyTheme(theme);
  },

  /**
   * Initialize theme from config without triggering save
   * Used when loading config from backend
   */
  initializeTheme: (theme: Theme) => {
    set({ theme });
    applyTheme(theme);
  },
}));

/**
 * Set up system theme change listener
 * Requirements: 2.6 - When the system theme changes, switch accordingly
 */
const setupSystemThemeListener = () => {
  if (typeof window === 'undefined' || !window.matchMedia) return;

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  
  const handleChange = () => {
    const currentTheme = useUIStore.getState().theme;
    // Only re-apply if using system theme
    if (currentTheme === 'system') {
      applyTheme('system');
    }
  };

  // Use addEventListener for modern browsers
  mediaQuery.addEventListener('change', handleChange);
};

// Initialize theme on load and listen for system theme changes
if (typeof window !== 'undefined') {
  // Apply initial theme
  const initialTheme = useUIStore.getState().theme;
  applyTheme(initialTheme);

  // Set up listener for system theme changes
  setupSystemThemeListener();
}
