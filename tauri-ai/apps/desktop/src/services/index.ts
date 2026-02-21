/**
 * Service exports
 * Central export point for all Tauri service wrappers
 */

// Chat service
export {
  chatStream,
  abortChat,
  setupStreamListeners,
  type StreamEventHandlers,
} from './chatService';

// Config service
export {
  getAppConfig,
  saveAppConfig,
  testConnection,
  type TestConnectionResult,
} from './configService';

// Conversation service
export {
  getConversations,
  getMessages,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  ensureConversationFileIndexes,
  type BindPreference,
  type ConversationFileIndexUpdate,
} from './conversationService';

// Code intelligence service
export {
  lspEnsureServer,
  lspNotify,
  lspRequest,
  lspShutdownWorkstudio,
  lspShutdownLanguage,
  lspStatus,
  lspDetectServer,
  astDocumentSymbols,
  codeIndexRequestDocumentSymbols,
  codeIndexStartWorkspaceScan,
  codeIndexStatus,
  codeIndexSummary,
  aiCodeCompletion,
  aiAnalyzeWorkstudioSymbol,
  getWorkstudioSymbolAnalysis,
  deleteWorkstudioSymbolAnalysis,
  saveWorkstudioSymbolAnalysis,
  type LspEnsureServerArgs,
  type LspNotifyArgs,
  type LspRequestArgs,
  type LspDetectServerArgs,
  type AstDocumentSymbolsArgs,
  type CodeIndexRequestDocumentSymbolsArgs,
  type CodeIndexDocumentSymbolsSnapshot,
  type CodeIndexRequestDocumentSymbolsResult,
  type CodeIndexStartWorkspaceScanArgs,
  type CodeIndexStatus,
  type CodeIndexSummary,
  type AiCodeCompletionArgs,
  type AiCodeCompletionItem,
  type AiCodeCompletionResult,
  type WorkstudioSymbolAnalysisKey,
  type SaveWorkstudioSymbolAnalysisArgs,
  type AiAnalyzeWorkstudioSymbolArgs,
} from './codeIntelService';
