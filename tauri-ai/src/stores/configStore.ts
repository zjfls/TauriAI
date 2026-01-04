/**
 * Config Store
 * Manages application configuration state using Zustand
 * Requirements: 5.1, 5.5, 5.6
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, ModelConfig } from '../types';

interface ConfigState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  setActiveModel: (modelId: string) => void;
  addModel: (model: ModelConfig) => void;
  updateModel: (model: ModelConfig) => void;
  deleteModel: (modelId: string) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  /**
   * Load configuration from the backend
   * Requirements: 5.1
   */
  loadConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await invoke<AppConfig>('get_app_config');
      set({ config, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, isLoading: false });
    }
  },

  /**
   * Save configuration to the backend
   * Requirements: 5.6
   */
  saveConfig: async (config: AppConfig) => {
    set({ isLoading: true, error: null });
    try {
      await invoke('save_app_config', { config });
      set({ config, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, isLoading: false });
    }
  },

  /**
   * Switch the active model
   * Requirements: 5.5
   */
  setActiveModel: (modelId: string) => {
    const { config, saveConfig } = get();
    if (!config) return;

    const updatedConfig = {
      ...config,
      activeModelId: modelId,
    };
    set({ config: updatedConfig });
    // Persist to backend
    saveConfig(updatedConfig);
  },

  /**
   * Add a new model configuration
   */
  addModel: (model: ModelConfig) => {
    const { config, saveConfig } = get();
    if (!config) return;

    const updatedConfig = {
      ...config,
      models: [...config.models, model],
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  /**
   * Update an existing model configuration
   */
  updateModel: (model: ModelConfig) => {
    const { config, saveConfig } = get();
    if (!config) return;

    const updatedConfig = {
      ...config,
      models: config.models.map((m) => (m.id === model.id ? model : m)),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  /**
   * Delete a model configuration
   */
  deleteModel: (modelId: string) => {
    const { config, saveConfig } = get();
    if (!config) return;

    const updatedConfig = {
      ...config,
      models: config.models.filter((m) => m.id !== modelId),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },
}));
