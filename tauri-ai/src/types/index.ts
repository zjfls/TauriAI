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

// API Protocol type for strong isolation
// - chat_completions: Traditional Chat Completions API (OpenAI, Anthropic, Ollama, etc.)
// - responses: OpenAI Responses API for reasoning models (o1, o3, gpt-4.1)
export type ApiProtocolType = 'chat_completions' | 'responses';

/**
 * Thinking level for OpenAI Response API and compatible services
 * Based on OpenAI official documentation
 * - null: No thinking (disabled)
 * - 'low': Low reasoning effort
 * - 'medium': Medium reasoning effort (default)
 * - 'high': High reasoning effort
 * - 'xhigh': Extra high reasoning effort (~95% of max_tokens)
 */
export type ThinkingLevel = null | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Thinking mode for different API protocols
 * - boolean: For chat_completions API (on/off)
 * - ThinkingLevel: For responses API (multi-level)
 */
export type ThinkingMode = boolean | ThinkingLevel;

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
  // Advanced settings
  maxImages?: number;     // Maximum number of images allowed (default: 10, only for vision models)
  thinkingBudgetTokens?: number; // Anthropic extended thinking budget (>=1024 and < maxTokens)
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
// Multimodal Content Types
// ============================================================================

/**
 * Image detail level for vision models
 */
export type ImageDetail = 'auto' | 'low' | 'high';

/**
 * Text content part
 */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * Image content part
 */
export interface ImageContentPart {
  type: 'image';
  url: string;  // Base64 data URL or HTTP URL
  detail?: ImageDetail;
}

/**
 * Text file content part
 */
export interface TextFileContentPart {
  type: 'text_file';
  filename: string;
  content: string;
}

/**
 * Pending text file for attachment (before sending)
 */
export interface PendingTextFile {
  id: string;           // Unique identifier
  filename: string;     // File name
  content: string;      // File content
  size: number;         // File size in bytes
}

/**
 * Supported text file extensions
 */
export const SUPPORTED_TEXT_EXTENSIONS = [
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.log',
  '.ini', '.toml', '.html', '.css', '.js', '.ts', '.py', '.rs',
  '.go', '.java', '.c', '.cpp', '.h', '.sh', '.bat', '.sql'
] as const;

/**
 * Maximum text file size (1MB)
 */
export const MAX_TEXT_FILE_SIZE = 1 * 1024 * 1024;

/**
 * Maximum number of text file attachments
 */
export const MAX_TEXT_FILES = 5;

// ============================================================================
// PDF Content Types
// ============================================================================

/**
 * PDF single page data
 */
export interface PdfPage {
  pageNumber: number;      // Page number (starting from 1)
  text: string;            // Extracted text content
  image: string;           // Base64 data URL (PNG format)
}

/**
 * PDF metadata
 */
export interface PdfMetadata {
  title?: string;          // Document title
  author?: string;         // Author
  createdAt?: string;      // Creation time
  producer?: string;       // PDF generator
  subject?: string;        // Subject
  keywords?: string;       // Keywords
}

/**
 * PDF document content part
 */
export interface PdfDocumentContentPart {
  type: 'pdf_document';
  filename: string;        // File name
  pages: PdfPage[];        // Page array
  totalPages: number;      // Total page count
  metadata?: PdfMetadata;  // Document metadata
}

/**
 * Pending PDF file for attachment (before sending)
 */
export interface PendingPdf {
  id: string;              // Unique identifier
  filename: string;        // File name
  size: number;            // File size in bytes
  pages: PdfPage[];        // Processed pages
  totalPages: number;      // Total page count
  metadata?: PdfMetadata;  // Metadata
  processingProgress: number;  // Processing progress (0-100)
  // Debug mode: page range selection
  pageRangeStart?: number;  // Start page (1-indexed, inclusive)
  pageRangeEnd?: number;    // End page (1-indexed, inclusive)
  // Debug mode: include images
  includeImages?: boolean;  // Whether to include images (default: true)
  // Debug mode: include text
  includeText?: boolean;    // Whether to include text (default: true)
}

/**
 * Maximum PDF file size (20MB)
 */
export const MAX_PDF_SIZE = 20 * 1024 * 1024;

/**
 * Maximum number of PDF pages to process
 */
export const MAX_PDF_PAGES = 50;

/**
 * PDF image rendering scale (for clarity)
 */
export const PDF_IMAGE_SCALE = 2.0;

/**
 * PDF image format
 */
export const PDF_IMAGE_FORMAT = 'image/png';

/**
 * Maximum number of simultaneous PDF documents
 */
export const MAX_PDF_COUNT = 3;

/**
 * A single part of message content (text, image, text file, or PDF document)
 */
export type ContentPart = TextContentPart | ImageContentPart | TextFileContentPart | PdfDocumentContentPart;

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
  contentParts?: ContentPart[];  // Multimodal content (images, etc.)
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
  action_type: 'copy' | 'retry' | 'navigate' | 'link' | 'event' | 'undo';
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
  modelRef?: string;      // Model reference used in this conversation
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
  theme?: Theme;        // UI theme preference (light/dark/system)
  pdfDebugMode?: boolean;  // Enable PDF debug mode to select page ranges
  openDevtoolsOnStart?: boolean; // Open DevTools on startup (dev builds only)
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

  // API type isolation (locked after first message)
  apiType: ApiProtocolType | null;    // null = not locked yet

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
  apiType: ApiProtocolType | null;  // Persisted API type lock
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
