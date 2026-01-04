/**
 * TauriAI Type Definitions
 * Core data models for the chat UI MVP
 */

// Message role enum
export type MessageRole = 'user' | 'assistant' | 'system';

// AI Provider types
export type Provider = 'openai' | 'anthropic' | 'ollama' | 'custom';

// Theme options
export type Theme = 'light' | 'dark' | 'system';

// View types for navigation
export type ActiveView = 'chat' | 'history' | 'settings';

/**
 * Metadata associated with a message
 */
export interface MessageMeta {
  model?: string;
  tokens?: number;
  duration?: number;
}

/**
 * Single chat message
 */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  meta?: MessageMeta;
  createdAt: string;
}

/**
 * Conversation session containing multiple messages
 */
export interface Conversation {
  id: string;
  title: string;
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Model parameters for AI configuration
 */
export interface ModelParameters {
  temperature: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
}


/**
 * Configuration for an AI model
 */
export interface ModelConfig {
  id: string;
  name: string;
  provider: Provider;
  apiBase?: string;
  apiKey?: string;
  model: string;
  parameters: ModelParameters;
}

/**
 * Preset configuration combining model config and system prompt
 */
export interface Preset {
  id: string;
  name: string;
  modelConfigId: string;
  systemPrompt: string;
  parametersOverride?: Partial<ModelParameters>;
}

/**
 * Appearance settings
 */
export interface AppearanceSettings {
  theme: Theme;
  alwaysOnTop: boolean;
}

/**
 * General application settings
 */
export interface GeneralSettings {
  language: string;
  autoStart: boolean;
}

/**
 * Main application configuration
 */
export interface AppConfig {
  appearance: AppearanceSettings;
  general: GeneralSettings;
  activeModelId: string;
  models: ModelConfig[];
  presets: Preset[];
}

/**
 * API error response
 */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Connection test result
 */
export interface TestResult {
  success: boolean;
  message: string;
}