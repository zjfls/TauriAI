/**
 * Config Service
 * Wraps Tauri invoke calls for configuration commands
 * Requirements: 10.6, 10.7, 10.8
 */

import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, ModelConfig } from '../types';

/**
 * Test connection result from the backend
 */
export interface TestConnectionResult {
  success: boolean;
  message: string;
  response_time_ms?: number;
}

/**
 * Get the current application configuration
 * Requirements: 10.6
 * 
 * @returns Promise resolving to the application configuration
 */
export async function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>('get_app_config');
}

/**
 * Save the application configuration
 * Requirements: 10.7
 * 
 * @param config - The configuration to save
 */
export async function saveAppConfig(config: AppConfig): Promise<void> {
  return invoke('save_app_config', { config });
}

/**
 * Test a model configuration by sending a minimal request
 * Requirements: 10.8
 * 
 * @param modelConfig - The model configuration to test
 * @returns Promise resolving to the test result
 */
export async function testConnection(
  modelConfig: ModelConfig
): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>('test_connection', { modelConfig });
}
