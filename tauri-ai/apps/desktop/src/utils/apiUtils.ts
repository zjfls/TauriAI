/**
 * API Utility Functions
 * Helper functions for API protocol detection and handling
 */

import type { ApiProtocolType, Provider, ProviderType } from '../types';

/**
 * Get API protocol type from model reference
 * 
 * @param modelRef - Model reference in format "provider_name/model_name"
 * @param providers - Array of provider configurations
 * @returns API protocol type ('chat_completions' or 'responses')
 * 
 * @example
 * getApiProtocol('openai/gpt-4', providers) // 'chat_completions'
 * getApiProtocol('openai_responses/o1', providers) // 'responses'
 */
export function getApiProtocol(
  modelRef: string,
  providers: Provider[]
): ApiProtocolType {
  // Extract provider name from model reference
  const [providerName] = modelRef.split('/');

  // Find the provider configuration
  const provider = providers.find(p => p.name === providerName);

  // Check if provider uses responses API (OpenAI Responses / Google / forced responses reasoning)
  if (
    provider?.type === 'openai_responses' ||
    provider?.type === 'google' ||
    (provider?.forceResponsesReasoning &&
      (provider.type === 'openai' || provider.type === 'openai_compatible'))
  ) {
    return 'responses';
  }

  // Default to chat_completions for all other cases
  return 'chat_completions';
}

/**
 * Get provider type from model reference
 *
 * @param modelRef - Model reference in format "provider_name/model_name"
 * @param providers - Array of provider configurations
 */
export function getProviderType(
  modelRef: string,
  providers: Provider[]
): ProviderType | undefined {
  const [providerName] = modelRef.split('/');
  return providers.find(p => p.name === providerName)?.type;
}

/**
 * Get default thinking mode for API protocol
 * 
 * @param apiProtocol - API protocol type
 * @returns Default thinking mode value
 * 
 * @example
 * getDefaultThinkingMode('chat_completions') // true
 * getDefaultThinkingMode('responses') // 'medium'
 */
export function getDefaultThinkingMode(apiProtocol: ApiProtocolType): boolean | 'medium' {
  if (apiProtocol === 'responses') {
    return 'medium';
  }
  return true;
}
