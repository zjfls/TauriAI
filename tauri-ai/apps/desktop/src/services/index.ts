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
  getWorkstudioFolderAnalysis,
  listWorkstudioSymbolAnalysisKeysForFile,
  listWorkstudioSymbolAnalysisSummariesForFile,
  listWorkstudioFolderAnalysisSummaries,
  deleteWorkstudioSymbolAnalysis,
  deleteWorkstudioFolderAnalysis,
  listWorkstudioChatWithRecordsForFile,
  listWorkstudioChatWithFileSummaries,
  deleteWorkstudioChatWithRecordsForFile,
  deleteWorkstudioChatWithRecord,
  saveWorkstudioSymbolAnalysis,
  saveWorkstudioFolderAnalysis,
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
  type WorkstudioSymbolAnalysisFileKey,
  type WorkstudioFolderAnalysisKey,
  type WorkstudioChatWithFileKey,
  type WorkstudioChatWithFileSummariesArgs,
  type SaveWorkstudioSymbolAnalysisArgs,
  type SaveWorkstudioFolderAnalysisArgs,
  type AiAnalyzeWorkstudioSymbolArgs,
} from './codeIntelService';
