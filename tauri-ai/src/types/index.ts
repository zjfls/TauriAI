/**
 * TauriAI Type Definitions
 * Core data models for the chat UI MVP
 */

// Message role enum
export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

// Theme options
export type Theme = 'light' | 'dark' | 'system';

// View types for navigation
export type ActiveView = 'chat' | 'history' | 'settings';

// Format prompt types
export type FormatPromptType = 'chat' | 'plain' | 'json' | 'none';

// ============================================================================
// New Provider-Model-Agent Architecture
// ============================================================================

// Provider type for API compatibility (matches backend client types)
export type ProviderType = 'openai' | 'openai_compatible' | 'anthropic' | 'ollama';

/**
 * Model configuration (pure model parameters, no system prompt)
 */
export interface Model {
  name: string;           // Model name, e.g., "deepseek-v3"
  temperature: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Provider configuration (contains API info and models)
 */
export interface Provider {
  name: string;           // Unique identifier, e.g., "siliconflow"
  displayName: string;    // Display name, e.g., "硅基流动"
  type: ProviderType;
  apiBase: string;
  apiKey?: string;
  enabled: boolean;
  models: Model[];
}

/**
 * Agent configuration (references a model, contains system prompt)
 */
export interface Agent {
  name: string;           // Unique identifier
  displayName: string;    // Display name
  description?: string;
  modelRef: string;       // Format: "provider_name/model_name"
  systemPrompt: string;
  formatType: FormatPromptType;
}

// ============================================================================
// Message & Conversation
// ============================================================================

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
  actions?: Action[];
  createdAt: string;
}

/**
 * Action definition for Message Toolbar
 */
export interface Action {
  id: string;
  label: string;
  icon?: string;
  action_type: 'copy' | 'retry' | 'navigate' | 'link' | 'event';
  payload?: string;
  style?: 'default' | 'primary' | 'danger';
}

/**
 * Structured Error from Backend
 */
export interface AppError {
  code: string;
  message: string;
  actions: Action[];
}

/**
 * Conversation session containing multiple messages
 */
export interface Conversation {
  id: string;
  title: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Application Configuration
// ============================================================================

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
  providers: Provider[];
  agents: Agent[];
  defaultAgent: string;
  // Runtime state (persisted)
  currentAgent?: string;      // Currently selected agent
  currentModelRef?: string;   // Currently selected model (can differ from agent's default)
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

// ============================================================================
// Legacy types (for migration compatibility)
// ============================================================================

/** @deprecated Use ProviderType instead */
export type LegacyProvider = 'openai' | 'anthropic' | 'ollama' | 'custom';

/** @deprecated Use Model instead */
export interface ModelParameters {
  temperature: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
}

/** @deprecated Use Provider + Model instead */
export interface ModelConfig {
  id: string;
  name: string;
  provider: LegacyProvider;
  apiBase?: string;
  apiKey?: string;
  model: string;
  parameters: ModelParameters;
}

/** @deprecated Use Agent instead */
export interface Preset {
  id: string;
  name: string;
  modelConfigId: string;
  systemPrompt: string;
  parametersOverride?: Partial<ModelParameters>;
}
