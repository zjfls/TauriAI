/**
 * Config Store
 * Manages application configuration state using Zustand
 */

import { create } from 'zustand';
import { tauriInvoke as invoke } from '../utils/errorUtils';
import type { AppConfig, Provider, Model, Agent } from '../types';
import { useUIStore } from './uiStore';

interface ConfigState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  saveConfigDebounced: (config: AppConfig, delayMs?: number) => void;
  flushConfigSaves: () => Promise<void>;
  
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

const DEFAULT_CONFIG_SAVE_DEBOUNCE_MS = 400;

let debouncedSaveTimer: ReturnType<typeof setTimeout> | null = null;
let saveQueue: Promise<void> = Promise.resolve();

const enqueueConfigSave = (config: AppConfig): Promise<void> => {
  // Serialize config writes to ensure the latest config is not overwritten by an earlier request finishing later.
  const task = saveQueue.then(() => invoke<void>('save_app_config', { config }));
  saveQueue = task.catch(() => undefined);
  return task;
};

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
      if (debouncedSaveTimer) {
        clearTimeout(debouncedSaveTimer);
        debouncedSaveTimer = null;
      }
      await enqueueConfigSave(config);
      set({ config, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, isLoading: false });
    }
  },

  saveConfigDebounced: (config: AppConfig, delayMs = DEFAULT_CONFIG_SAVE_DEBOUNCE_MS) => {
    // Update UI immediately, persist shortly after (debounced).
    set({ config });

    if (debouncedSaveTimer) {
      clearTimeout(debouncedSaveTimer);
    }

    debouncedSaveTimer = setTimeout(() => {
      debouncedSaveTimer = null;
      const latest = get().config;
      if (!latest) return;
      enqueueConfigSave(latest).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message });
      });
    }, delayMs);
  },

  flushConfigSaves: async () => {
    if (debouncedSaveTimer) {
      clearTimeout(debouncedSaveTimer);
      debouncedSaveTimer = null;
      const latest = get().config;
      if (latest) {
        await enqueueConfigSave(latest);
      }
    }
    await saveQueue;
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
    if (!agent) return;
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
    return config?.agents.find((a) => a.name === name && (a.enabled ?? true));
  },

  getDefaultAgent: () => {
    const { config } = get();
    if (!config) return undefined;
    if (config.defaultAgent) {
      const byName = config.agents.find((a) => a.name === config.defaultAgent);
      if (byName && (byName.enabled ?? true)) return byName;
    }
    return config.agents.find((a) => (a.enabled ?? true));
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

// -----------------------------------------------------------------------------
// Debug: config store update storm detector (DEV only)
// -----------------------------------------------------------------------------
// 目的：定位“循环 setState / 最大更新深度”这类问题时，不依赖 DevTools。
// 触发后会把堆栈写入 localStorage，供 ErrorBoundary 展示。
const CONFIG_STORE_DEBUG_LAST_STORM_KEY = 'tauri-ai:debug:last_config_store_storm';
const configStoreStormDebugEnabled = (() => {
  try {
    return import.meta.env.DEV;
  } catch {
    return false;
  }
})();

if (configStoreStormDebugEnabled) {
  let windowStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let updatesInWindow = 0;
  let tracedInWindow = false;

  const WINDOW_MS = 500;
  const TRACE_THRESHOLD = 40;

  useConfigStore.subscribe((state, prev) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      updatesInWindow = 0;
      tracedInWindow = false;
    }

    updatesInWindow += 1;

    if (!tracedInWindow && updatesInWindow >= TRACE_THRESHOLD) {
      tracedInWindow = true;

      const stack = (() => {
        try {
          return new Error('configStore update storm').stack || '';
        } catch {
          return '';
        }
      })();

      try {
        if (typeof localStorage !== 'undefined') {
          const record = {
            ts: Date.now(),
            updatesInWindow,
            windowMs: WINDOW_MS,
            state: {
              isLoading: state.isLoading,
              hasConfig: Boolean(state.config),
              providers: state.config?.providers?.length ?? null,
              agents: state.config?.agents?.length ?? null,
              error: state.error ?? null,
            },
            prevState: {
              isLoading: prev.isLoading,
              hasConfig: Boolean(prev.config),
              providers: prev.config?.providers?.length ?? null,
              agents: prev.config?.agents?.length ?? null,
              error: prev.error ?? null,
            },
            stack,
          };
          localStorage.setItem(CONFIG_STORE_DEBUG_LAST_STORM_KEY, JSON.stringify(record));
        }
      } catch {
        // ignore
      }

      console.groupCollapsed(`[debug] configStore 更新风暴: ${updatesInWindow}/${WINDOW_MS}ms`);
      console.log('state:', {
        isLoading: state.isLoading,
        hasConfig: Boolean(state.config),
        providers: state.config?.providers?.length,
        agents: state.config?.agents?.length,
        error: state.error,
      });
      console.log('prev:', {
        isLoading: prev.isLoading,
        hasConfig: Boolean(prev.config),
        providers: prev.config?.providers?.length,
        agents: prev.config?.agents?.length,
        error: prev.error,
      });
      console.trace('configStore update storm stack');
      if (stack) console.log('captured stack:', stack);
      console.groupEnd();
    }
  });
}
