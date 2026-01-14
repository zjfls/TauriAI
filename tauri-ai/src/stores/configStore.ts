/**
 * Config Store
 * Manages application configuration state using Zustand
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, Provider, Model, Agent } from '../types';
import { useUIStore } from './uiStore';

interface ConfigState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  
  // Provider actions
  addProvider: (provider: Provider) => void;
  updateProvider: (provider: Provider) => void;
  deleteProvider: (providerName: string) => void;
  toggleProvider: (providerName: string, enabled: boolean) => void;
  
  // Model actions (within a provider)
  addModel: (providerName: string, model: Model) => void;
  updateModel: (providerName: string, model: Model) => void;
  deleteModel: (providerName: string, modelName: string) => void;
  
  // Agent actions
  addAgent: (agent: Agent) => void;
  updateAgent: (agent: Agent) => void;
  deleteAgent: (agentName: string) => void;
  setDefaultAgent: (agentName: string) => void;
  
  // Runtime state actions
  setCurrentAgent: (agentName: string) => void;
  setCurrentModel: (modelRef: string) => void;
  getCurrentAgent: () => Agent | undefined;
  getCurrentModelRef: () => string | undefined;
  
  // Helper getters
  getProvider: (name: string) => Provider | undefined;
  getAgent: (name: string) => Agent | undefined;
  getDefaultAgent: () => Agent | undefined;
  getModelOptions: () => { label: string; value: string }[];
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await invoke<AppConfig>('get_app_config');
      set({ config, isLoading: false });
      
      if (config.appearance?.theme) {
        useUIStore.getState().initializeTheme(config.appearance.theme);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, isLoading: false });
    }
  },

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

  // Provider actions
  addProvider: (provider: Provider) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = { ...config, providers: [...config.providers, provider] };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  updateProvider: (provider: Provider) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      providers: config.providers.map((p) => (p.name === provider.name ? provider : p)),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  deleteProvider: (providerName: string) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      providers: config.providers.filter((p) => p.name !== providerName),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  toggleProvider: (providerName: string, enabled: boolean) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      providers: config.providers.map((p) =>
        p.name === providerName ? { ...p, enabled } : p
      ),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  // Model actions
  addModel: (providerName: string, model: Model) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      providers: config.providers.map((p) =>
        p.name === providerName ? { ...p, models: [...p.models, model] } : p
      ),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  updateModel: (providerName: string, model: Model) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      providers: config.providers.map((p) =>
        p.name === providerName
          ? { ...p, models: p.models.map((m) => (m.name === model.name ? model : m)) }
          : p
      ),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  deleteModel: (providerName: string, modelName: string) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      providers: config.providers.map((p) =>
        p.name === providerName
          ? { ...p, models: p.models.filter((m) => m.name !== modelName) }
          : p
      ),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  // Agent actions
  addAgent: (agent: Agent) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = { ...config, agents: [...config.agents, agent] };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  updateAgent: (agent: Agent) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      agents: config.agents.map((a) => (a.name === agent.name ? agent : a)),
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  deleteAgent: (agentName: string) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = {
      ...config,
      agents: config.agents.filter((a) => a.name !== agentName),
      defaultAgent: config.defaultAgent === agentName ? '' : config.defaultAgent,
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  setDefaultAgent: (agentName: string) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = { ...config, defaultAgent: agentName };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  // Runtime state actions
  setCurrentAgent: (agentName: string) => {
    const { config, saveConfig, getAgent } = get();
    if (!config) return;
    const agent = getAgent(agentName);
    // When switching agent, reset to agent's default model
    const updatedConfig = {
      ...config,
      currentAgent: agentName,
      currentModelRef: agent?.modelRef || undefined,
    };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  setCurrentModel: (modelRef: string) => {
    const { config, saveConfig } = get();
    if (!config) return;
    const updatedConfig = { ...config, currentModelRef: modelRef };
    set({ config: updatedConfig });
    saveConfig(updatedConfig);
  },

  getCurrentAgent: () => {
    const { config, getAgent, getDefaultAgent } = get();
    if (!config) return undefined;
    if (config.currentAgent) {
      return getAgent(config.currentAgent);
    }
    return getDefaultAgent();
  },

  getCurrentModelRef: () => {
    const { config, getCurrentAgent } = get();
    if (!config) return undefined;
    // If currentModelRef is set, use it; otherwise use agent's default
    if (config.currentModelRef) {
      return config.currentModelRef;
    }
    const agent = getCurrentAgent();
    return agent?.modelRef;
  },

  // Helper getters
  getProvider: (name: string) => {
    const { config } = get();
    return config?.providers.find((p) => p.name === name);
  },

  getAgent: (name: string) => {
    const { config } = get();
    return config?.agents.find((a) => a.name === name);
  },

  getDefaultAgent: () => {
    const { config } = get();
    if (!config) return undefined;
    if (config.defaultAgent) {
      return config.agents.find((a) => a.name === config.defaultAgent);
    }
    return config.agents[0];
  },

  getModelOptions: () => {
    const { config } = get();
    if (!config) return [];
    const options: { label: string; value: string }[] = [];
    for (const provider of config.providers) {
      if (!provider.enabled) continue;
      for (const model of provider.models) {
        options.push({
          label: `${provider.displayName} / ${model.name}`,
          value: `${provider.name}/${model.name}`,
        });
      }
    }
    return options;
  },
}));
