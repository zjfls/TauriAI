/**
 * Config Service
 * Wraps Tauri invoke calls for configuration commands
 */

import { tauriInvoke as invoke } from '../utils/errorUtils';
import type { AppConfig, ProviderType } from '../types';

/**
 * Test connection result from the backend
 */
export interface TestConnectionResult {
  success: boolean;
  message: string;
  response_time_ms?: number;
}

/**
 * Model info returned from provider API
 */
export interface ModelInfo {
  id: string;
  owned_by?: string;
}

/**
 * Get the current application configuration
 */
export async function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>('get_app_config');
}

/**
 * Save the application configuration
 */
export async function saveAppConfig(config: AppConfig): Promise<void> {
  return invoke('save_app_config', { config });
}

/**
 * Test a provider connection with a specific model
 */
export async function testConnection(
  providerType: ProviderType,
  apiBase: string,
  apiKey: string | undefined,
  modelName: string
): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>('test_connection', {
    providerType,
    apiBase,
    apiKey,
    modelName,
  });
}

/**
 * Fetch available models from a provider's API
 */
export async function fetchProviderModels(
  providerType: ProviderType,
  apiBase: string,
  apiKey: string | undefined
): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('fetch_provider_models', {
    providerType,
    apiBase,
    apiKey,
  });
}
