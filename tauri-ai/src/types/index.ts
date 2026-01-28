/**
 * TauriAI Type Definitions
 * Core data models for the chat UI MVP
 */

// Message role enum
export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

// Message status enum
export type MessageStatus = 'pending' | 'success' | 'failed';

// Theme options
export type Theme =
  | 'system'
  | 'light'
  | 'dark'
  | 'tokyo-night'
  | 'dracula'
  | 'nord'
  | 'catppuccin'
  | 'solarized';

// ANSI rendering options
export type AnsiRenderMode = 'color' | 'strip' | 'raw';
export type AnsiColorMode = 'auto' | 'xterm' | 'vscode-dark' | 'vscode-light';

// View types for navigation
export type ActiveView = 'chat' | 'history' | 'settings' | 'document' | 'workstudio' | 'window_test';

// Format prompt types
export type FormatPromptType = 'chat' | 'plain' | 'json' | 'none';

// Agent type for extensible runtime behaviors
export type AgentType = 'chat' | 'tool';

// Run mode (input-level): chat / agent / agent full access
export type RunMode = 'chat' | 'agent' | 'agent-full-access';

// ============================================================================
// Security / Sandboxing
// ============================================================================

export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export type NetworkAccess = 'restricted' | 'enabled';

export type SandboxPolicy =
  | { type: 'danger-full-access' }
  | { type: 'read-only' }
  | { type: 'external-sandbox'; networkAccess?: NetworkAccess }
  | {
      type: 'workspace-write';
      writableRoots?: string[];
      networkAccess?: boolean;
      excludeTmpdirEnvVar?: boolean;
      excludeSlashTmp?: boolean;
    };

export interface TrustedCommandConfig {
  tool: string;
  command: string;
}

export interface SecurityPolicyConfig {
  name: string;
  sandboxPolicy: SandboxPolicy;
  approvalPolicy: AskForApproval;
  trustedCommands?: TrustedCommandConfig[];
}

export interface SecuritySettings {
  policies: SecurityPolicyConfig[];
  defaultPolicy: string;
}

// ============================================================================
// New Provider-Model-Agent Architecture
// ============================================================================

// Provider type for API compatibility (matches backend client types)
// - openai: OpenAI official API (uses "developer" role)
// - openai_compatible: OpenAI-compatible APIs (DeepSeek, SiliconFlow, etc.)
// - openai_responses: OpenAI Responses API for reasoning models (o1, o3, gpt-4.1)
// - anthropic: Anthropic Claude API
// - ollama: Local Ollama server
export type ProviderType = 'openai' | 'openai_compatible' | 'openai_responses' | 'anthropic' | 'google' | 'ollama';

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
  webSearch: boolean;     // Supports provider-native server-side web search
}

/**
 * Model configuration (pure model parameters, no system prompt)
 */
export interface Model {
  name: string;           // Model name, e.g., "deepseek-v3"
  temperature: number;
  temperatureEnabled?: boolean; // When false, omit temperature from request
  maxTokens?: number;
  topP?: number;
  topPEnabled?: boolean; // When false, omit top_p from request
  contextLength?: number; // Maximum context length in tokens (e.g., 128000 for GPT-4o)
  capabilities: ModelCapabilities;
  // Advanced settings
  maxImages?: number;     // Maximum number of images allowed (default: 10, only for vision models)
  thinkingBudgetTokens?: number; // Anthropic extended thinking budget (>=1024 and < maxTokens)
  useReasoningEffort?: boolean; // Use reasoning_effort parameter for Chat Completions API (OpenAI GPT-5 series)
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
  skills?: number;          // Skills prompt tokens (from SKILL.md)
  // Optional preview texts for the context detail modal
  systemPromptText?: string;
  formatPromptText?: string;
  skillsSectionText?: string;
  skillsInjectedText?: string;
  mcpPromptText?: string;
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
  enabled?: boolean;      // Whether the agent is enabled (default: true)
  type?: AgentType;       // Agent runtime type (default: 'chat')
  displayName: string;    // Display name
  description?: string;
  modelRef: string;       // Format: "provider_name/model_name"
  systemPrompt: string;
  formatType: FormatPromptType;
  toolset?: string;       // Optional toolset binding (for tool agents)
  mcpSet?: string;        // Optional MCP Set binding (servers/tools per agent)
  skillSet?: string;      // Optional Skill Set binding (skills per agent)
  securityPolicy?: string; // Optional security policy name (defaults to global defaultPolicy)
  sandboxPolicy?: SandboxPolicy; // Optional sandbox policy override (defaults to global policy)
  approvalPolicy?: AskForApproval; // Optional approval policy override (defaults to global policy)
  workspaceSupport?: boolean; // Tool agent workspace support (default: true for tool, else false)
  maxTurns?: number;      // Max turns per run/task (default depends on agent type)
  reinjectThinking?: boolean; // Whether to reinject thinking into next turn context (default: false)
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
 * Pending image for attachment (before sending)
 */
export interface PendingImage {
  id: string;
  url: string;  // Base64 data URL
  file?: File;
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

export type TextBlockFormat = 'markdown' | 'plain' | 'json';

export interface BaseMessageBlock {
  id: string;
  type: string;
  /** 仅用于调试/多 Turn 场景：标识该 block 属于哪个 turn */
  turnId?: string;
  /** 仅用于调试/多 Turn 场景：turn 的序号（1/2/3...） */
  turnIndex?: number;
}

export interface TextMessageBlock extends BaseMessageBlock {
  type: 'text';
  format: TextBlockFormat | string;
  text: string;
}

export interface ThinkingMessageBlock extends BaseMessageBlock {
  type: 'thinking';
  text: string;
}

export interface ToolCallMessageBlock extends BaseMessageBlock {
  type: 'tool_call';
  callId: string;
  name: string;
  arguments: string;
}

export interface ToolResultMessageBlock extends BaseMessageBlock {
  type: 'tool_result';
  callId: string;
  text: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'approved_for_session' | 'denied' | 'abort';

export interface ApprovalMessageBlock extends BaseMessageBlock {
  type: 'approval';
  requestId: string;
  callId: string;
  toolName: string;
  arguments: string;
  status: ApprovalStatus | string;
  securityPolicy?: string;
  escalated?: boolean;
  reason?: string;
}

export interface ErrorMessageBlock extends BaseMessageBlock {
  type: 'error';
  text: string;
}

export interface WebSearchMessageBlock extends BaseMessageBlock {
  type: 'web_search';
  callId: string;
  status: string;
  action?: unknown;
}

export type PtySessionScope = 'task' | 'conversation';

export interface PtySessionInfo {
  sessionId: number;
  conversationId: string;
  taskId: string;
  scope: PtySessionScope;
  command: string;
  workdir?: string;
  createdAtMs: number;
  lastUsedMs: number;
  isAlive: boolean;
}

// Reserved for future expansion (tools/websearch/multimodal, etc.)
export interface UnknownMessageBlock extends BaseMessageBlock {
  type: 'unknown';
  data: unknown;
}

export type MessageBlock =
  | TextMessageBlock
  | ThinkingMessageBlock
  | ToolCallMessageBlock
  | ToolResultMessageBlock
  | ApprovalMessageBlock
  | ErrorMessageBlock
  | WebSearchMessageBlock
  | UnknownMessageBlock;

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
  // 结构化输出块（架构演进入口）：
  // - 未来 tool/websearch/非文本输出都将通过 blocks 表达
  // - 现阶段仍保留 content/thinking 作为兼容字段
  blocks?: MessageBlock[];
  meta?: MessageMeta;
  actions?: Action[];
  createdAt: string;
  // Message status
  status?: MessageStatus;
  // Error message if status is failed
  error?: string;
  // Debug info (only populated when debug mode is enabled)
  debugInfo?: DebugInfo;
  // Per-turn debug info (multi-turn tasks)
  turns?: MessageTurn[];
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
 * Multi-turn debug info (per model call)
 */
export interface MessageTurn {
  turnId: string;
  turnIndex: number;
  status?: TurnStatus;
  debugInfo?: DebugInfo;
  usage?: TokenUsage;
  model?: string;
}

// ============================================================================
// Unified Streaming Event Types (run:event)
// ============================================================================

// 后端 `run:event` 的统一流式输出：
// - 前端/业务层只需要消费这一条事件流
// - 未来新增输出类型只扩展 payload，不再增加新的 event name
export type RunEventType =
  | 'plan_created'
  | 'task_started'
  | 'turn_started'
  | 'turn_phase_started'
  | 'turn_phase_finished'
  | 'turn_finished'
  | 'block_delta'
  | 'done'
  | 'error';

export type TaskKind = 'chat' | 'tool' | 'planner';
export type TurnStatus = 'success' | 'failed' | 'aborted';
export type TurnPhase = 'think' | 'act' | 'observe';

export type RunBlockType =
  | 'text'
  | 'thinking'
  // Future block types (reserved)
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'error'
  | 'web_search'
  | 'image'
  | 'file'
  | 'json'
  | 'code'
  | 'unknown';

export type RunTextFormat = 'markdown' | 'plain' | 'json';

export type RunEventPayload =
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'plan_created';
    planId: string;
    tasks: Array<{
      taskId: string;
      taskKind: TaskKind;
      title?: string;
    }>;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'task_started';
    taskId: string;
    taskKind: TaskKind;
    title?: string;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'turn_started';
    taskId: string;
    turnId: string;
    turnIndex: number;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'turn_phase_started';
    taskId: string;
    turnId: string;
    phase: TurnPhase;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'turn_phase_finished';
    taskId: string;
    turnId: string;
    phase: TurnPhase;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'turn_finished';
    taskId: string;
    turnId: string;
    status: TurnStatus;
    turnIndex?: number;
    assistantMessageId?: string;
    debugInfo?: DebugInfo;
    usage?: TokenUsage;
    model?: string;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'block_delta';
    taskId: string;
    turnId: string;
    assistantMessageId?: string;
    blockId: string;
    blockType: RunBlockType;
    format?: RunTextFormat | string;
    delta: string;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'done';
    taskId: string;
    turnId: string;
    assistantMessageId?: string;
    fullContent: string;
    format?: RunTextFormat | string;
    thinking?: string;
    debugInfo?: DebugInfo;
    usage?: TokenUsage;
    model?: string;
  }
  | {
    conversationId: string;
    runId: string;
    seq: number;
    timestampMs: number;
    type: 'error';
    taskId?: string;
    turnId?: string;
    assistantMessageId?: string;
    error: string;
    debugInfo?: DebugInfo;
  };

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
  thinkingMode?: ThinkingMode; // Conversation-scoped thinking mode/level
  workstudioId?: string;  // Optional workstudio binding
  createdAt: string;
  updatedAt: string;
}

/**
 * Workstudio definition (workspace bound to one main folder and optional additional folders).
 */
export interface Workstudio {
  id: string;
  kind: string;
  mainFolder: string;
  folders: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Workstudio UI 持久化状态（用于恢复上次打开的文件/分屏等）。
 */
export interface WorkstudioUiState {
  openFiles: string[];
  groups?: { openFiles: string[]; activeFile?: string; weight?: number }[];
  focusedGroupIndex?: number;
  expandedDirs?: string[];
  activeLeftFile?: string;
  activeRightFile?: string;
  splitOpen?: boolean;
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
  debugSse?: boolean;   // Log raw SSE chunks during streaming (requires debug mode)
  showUsage?: boolean;  // Show token usage in messages
  theme?: Theme;        // UI theme preference (light/dark/system)
  pdfDebugMode?: boolean;  // Enable PDF debug mode to select page ranges
  openDevtoolsOnStart?: boolean; // Open DevTools on startup (dev builds only)
  ansiRenderMode?: AnsiRenderMode; // How to render ANSI sequences (color/strip/raw)
  ansiColorMode?: AnsiColorMode;   // ANSI 16-color palette selection
  webSearchTool?: WebSearchToolSettings; // Local web search tool settings
}

export type WebSearchProvider = 'tavily' | 'google' | 'brave';

export interface WebSearchToolSettings {
  // 各提供商独立启用开关
  tavilyEnabled?: boolean;
  googleEnabled?: boolean;
  braveEnabled?: boolean;
  // API Keys
  tavilyApiKey?: string;
  braveApiKey?: string;
  googleApiKey?: string;
  googleCx?: string; // Google Custom Search CX
  // 通用设置
  minIntervalMs?: number;
  maxResults?: number;
}

/**
 * Reusable toolset definition (bind different tool collections per agent)
 */
export interface ToolSetConfig {
  name: string;
  tools: string[];
  /**
   * 实验性：持久 shell/pty 增强（跨 task 保活 + 显示“持久进程”面板）。
   * 仅当 toolset 显式开启时才会影响模型侧工具定义，避免默认污染提示词。
   */
  persistanceShellEnhance?: boolean;
}

/**
 * Tools overall settings: toolsets only
 */
export interface ToolsSettings {
  toolsets: ToolSetConfig[];
}

// ============================================================================
// MCP (Model Context Protocol)
// ============================================================================

export type McpServerTransportConfig =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
      envVars: string[];
      cwd?: string;
    }
  | {
      transport: 'streamable_http';
      url: string;
      bearerTokenEnvVar?: string;
      httpHeaders?: Record<string, string>;
      envHttpHeaders?: Record<string, string>;
    };

export interface McpServerConfig {
  transport: McpServerTransportConfig;
  enabled: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools: string[];
  disabledTools: string[];
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
}

export interface McpSetServerConfig {
  server: string;
  enabled: boolean;
  enabledTools: string[];
  disabledTools: string[];
}

export interface McpSetConfig {
  name: string;
  servers: McpSetServerConfig[];
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerEntry[];
  sets: McpSetConfig[];
}

// ============================================================================
// Skills
// ============================================================================

export interface SkillSetConfig {
  name: string;
  enabled?: boolean;
  skills: string[];
  disabledSkills: string[];
}

export interface SkillsSettings {
  disabledSkills: string[];
  sets: SkillSetConfig[];
}

export type SkillRootKind = 'app' | 'workstudio' | 'repo';

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  category: string; // learn/system/code/...
  rootKind: SkillRootKind;
  path: string;
}

export interface SkillEntry {
  meta: SkillMetadata;
  contents: string; // Full SKILL.md
}

export interface SkillLoadOutcome {
  skills: SkillEntry[];
  errors: string[];
}

export interface SkillRootsSnapshot {
  appSkillsDir?: string;
  repoSkillsDir?: string;
  workstudioSkillsDir?: string;
}

/**
 * Main application configuration
 */
export interface AppConfig {
  appearance: AppearanceSettings;
  general: GeneralSettings;
  tools: ToolsSettings;
  mcp: McpSettings;
  skills: SkillsSettings;
  security: SecuritySettings;
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
  workstudioId?: string | null;       // Optional workstudio binding (workspace-enabled agents)

  // API type isolation (locked after first message)
  apiType: ApiProtocolType | null;    // null = not locked yet

  // Per-session settings
  runMode?: RunMode;                  // Input run mode: chat/agent/agent-full-access
  thinkingMode?: ThinkingMode;        // Current thinking mode/level for this session
  webSearchProvider?: 'native' | 'tavily' | 'google' | 'brave' | null;  // Selected web search provider for this session
  draftContent?: string;              // Unsent input text for this session

  // Session state
  messages: Message[];                // Message history for this session
  // Unified streaming output blocks (chat/event -> blocks)
  // - null: not streaming
  // - []: stream started but no blocks yet (e.g., first-token latency)
  streamingBlocks: MessageBlock[] | null;
  // Streaming turn metadata (per model call, multi-turn tasks)
  streamingTurns?: Map<string, MessageTurn>;
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
  workstudioId?: string | null;
  apiType: ApiProtocolType | null;  // Persisted API type lock
  runMode?: RunMode;                // Persisted run mode selection
  thinkingMode?: ThinkingMode;      // Persisted thinking mode/level
  webSearchProvider?: 'native' | 'tavily' | 'google' | 'brave' | null;  // Persisted web search provider selection
  draftContent?: string;            // Persisted unsent input text
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
