/**
 * API Type Utilities
 * Provides functions for API protocol type checking and isolation
 */

import type { ProviderType, ApiProtocolType, AppConfig } from '../types';

/**
 * Map ProviderType to ApiProtocolType
 * Only 'openai_responses' uses the Responses API, all others use Chat Completions
 */
const PROVIDER_API_TYPE: Record<ProviderType, ApiProtocolType> = {
    'openai': 'chat_completions',
    'openai_compatible': 'chat_completions',
    'openai_responses': 'responses',
    'anthropic': 'chat_completions',
    'google': 'chat_completions',
    'ollama': 'chat_completions',
};

/**
 * Get the API protocol type for a given provider type
 */
export function getApiType(providerType: ProviderType): ApiProtocolType {
    return PROVIDER_API_TYPE[providerType];
}

/**
 * Get the API protocol type from a model reference
 * @param modelRef Format: "provider_name/model_name"
 * @param config App configuration containing providers
 */
export function getApiTypeFromModelRef(
    modelRef: string,
    config: AppConfig
): ApiProtocolType {
    const [providerName] = modelRef.split('/');
    const provider = config.providers.find(p => p.name === providerName);
    return getApiType(provider?.type || 'openai_compatible');
}

/**
 * Result of API type compatibility check
 */
export interface ApiTypeCheckResult {
    allowed: boolean;
    reason?: string;
}

/**
 * Check if model switching is allowed based on API type isolation
 * @param currentApiType Current session's locked API type (null if not locked)
 * @param newModelRef The model reference to switch to
 * @param config App configuration
 */
export function canSwitchModel(
    currentApiType: ApiProtocolType | null,
    newModelRef: string,
    config: AppConfig
): ApiTypeCheckResult {
    // Not locked yet - allow any switch
    if (!currentApiType) {
        return { allowed: true };
    }

    const newApiType = getApiTypeFromModelRef(newModelRef, config);

    // Same type - allow
    if (currentApiType === newApiType) {
        return { allowed: true };
    }

    // Different type - deny
    return {
        allowed: false,
        reason: currentApiType === 'responses'
            ? '当前会话使用 Responses API，无法切换到其他协议类型的模型。请新开会话。'
            : '当前会话使用 Chat Completions，无法切换到 Responses API 模型。请新开会话。',
    };
}

/**
 * Get display label for API protocol type
 */
export function getApiTypeLabel(apiType: ApiProtocolType | null): string {
    if (!apiType) return '';
    return apiType === 'responses' ? '[R]' : '';
}
