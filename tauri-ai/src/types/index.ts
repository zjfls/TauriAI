/**
 * TauriAI Type Definitions
 * Core data models for the chat UI MVP
 */

// Message role enum
export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

// Message status enum
export type MessageStatus = 'pending' | 'success' | 'failed';

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
// - openai: OpenAI official API (uses "developer" role)
// - openai_compatible: OpenAI-compatible APIs (DeepSeek, SiliconFlow, etc.)
// - openai_responses: OpenAI Responses API for reasoning models (o1, o3, gpt-4.1)
// - anthropic: Anthropic Claude API
// - ollama: Local Ollama server
export type ProviderType = 'openai' | 'openai_compatible' | 'openai_responses' | 'anthropic' | 'ollama';

/**
 * Model capabilities (what features the model supports)
 */
export interface ModelCapabilities {
  thinking: boolean;      // Supports thinking/reasoning (e.g., DeepSeek-R1)
  vision: boolean;        // Supports vision/image input
  functionCalling: boolean; // Supports function calling
}

/**
 * Model configuration (pure model parameters, no system prompt)
 */
export interface Model {
  name: string;           // Model name, e.g., "deepseek-v3"
  temperature: number;
  maxTokens?: number;
  topP?: number;
  contextLength?: number; // Maximum context length in tokens (e.g., 128000 for GPT-4o)
  capabilities: ModelCapabilities;
}

/**
 * Context usage breakdown for detailed display
 */
export interface ContextUsageBreakdown {
  systemPrompt: number;     // User's system prompt tokens
  formatPrompt: number;     // Format prompt tokens (Markdown/LaTeX guidelines)
  messages: number;         // Conversation messages tokens
  tools?: number;           // Tool definitions tokens (future)
  mcp?: number;             // MCP context tokens (future)
  total: number;            // Total used tokens
  limit: number;            // Model's context limit
  percentage: number;       // Usage percentage (0-100)
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
  thinking?: string;      // Thinking/reasoning content (for models like DeepSeek-R1)
  meta?: MessageMeta;
  actions?: Action[];
  createdAt: string;
  // Message status
  status?: MessageStatus;
  // Error message if status is failed
  error?: string;
  // Debug info (only populated when debug mode is enabled)
  debugInfo?: DebugInfo;
  // Token usage for this message
  usage?: TokenUsage;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;        // OpenAI prompt caching
  reasoningTokens?: number;     // o1 models reasoning tokens
  cacheCreationInputTokens?: number;  // Anthropic cache creation
  cacheReadInputTokens?: number;      // Anthropic cache read
}

/**
 * Debug information for a message (raw HTTP request/response)
 */
export interface DebugInfo {
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
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
  debugMode?: boolean;  // Enable debug mode to show raw HTTP messages
  showUsage?: boolean;  // Show token usage in messages
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
// Multi-Agent Workspace Types (Primary - Use These)
// ============================================================================

/**
 * Agent session instance
 * Each session is an independent running instance of an agent
 * 
 * This is the primary type for managing active chat sessions in the multi-agent workspace.
 * Use sessionStore to manage AgentSession instances.
 * 
 * Requirements: 1.1, 1.2, 4.1, 4.2
 */
export interface AgentSession {
  id: string;                         // Unique session identifier (UUID)
  agentName: string;                  // Name of the agent being used
  title: string;                      // Conversation title for display in tab
  modelRef?: string;                  // Current model reference (can override agent default)
  conversationId: string | null;      // Associated conversation ID

  // Session state
  messages: Message[];                // Message history for this session
  streamingMessage: string | null;    // Current streaming message content
  streamingThinking: string | null;   // Current streaming thinking content
  isGenerating: boolean;              // Whether the session is generating a response
  error: string | null;               // Error message if any

  // Metadata
  createdAt: string;                  // ISO timestamp of session creation
  lastActiveAt: string;               // ISO timestamp of last activity
}

/**
 * Persisted session data (subset of AgentSession for storage)
 * Used for saving/restoring sessions across app restarts
 * 
 * Requirements: 5.1, 5.2
 */
export interface PersistedSession {
  id: string;
  agentName: string;
  modelRef?: string;
  conversationId: string | null;
  createdAt: string;
  lastActiveAt: string;
}

/**
 * Persisted session state structure
 * Contains all data needed to restore workspace sessions
 * 
 * Requirements: 5.1, 5.2
 */
export interface PersistedSessionState {
  version: number;                    // Version number for migration support
  sessions: PersistedSession[];       // Array of persisted sessions
  activeSessionId: string | null;     // ID of the active session
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

// ============================================================================
// Deprecated Conversation Store Types
// Note: For new code, use sessionStore with AgentSession instead
// ============================================================================

/**
 * @deprecated Use sessionStore for active session management.
 * The conversationStore is now only used for:
 * - Loading conversation history list (loadConversations)
 * - Managing conversation metadata (title, delete)
 * 
 * For active chat sessions, use:
 * - sessionStore.createSession() to create new sessions
 * - sessionStore.sendMessage() to send messages
 * - sessionStore.getActiveSession() to get current session state
 */
export interface ConversationStoreDeprecationNotice {
  _notice: 'See sessionStore for active session management';
}
