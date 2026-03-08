import { invoke, isTauri } from '@tauri-apps/api/core';

import type {
  AstSymbol,
  LspDetectServerResult,
  LspServerStatus,
  WorkstudioChatWithFileSummary,
  WorkstudioChatWithRecord,
  WorkstudioChatWithThread,
  WorkstudioFolderAnalysis,
  WorkstudioFolderAnalysisSummary,
  WorkstudioSymbolAnalysis,
  WorkstudioSymbolAnalysisSummary,
} from '../types';

export type LspEnsureServerArgs = {
  workstudioId: string;
  languageId: string;
};

export const lspEnsureServer = async (args: LspEnsureServerArgs): Promise<void> => {
  if (!isTauri()) return;
  await invoke<void>('lsp_ensure_server', { args });
};

export type LspNotifyArgs = {
  workstudioId: string;
  languageId: string;
  method: string;
  params?: unknown;
};

export const lspNotify = async (args: LspNotifyArgs): Promise<void> => {
  if (!isTauri()) return;
  await invoke<void>('lsp_notify', { args });
};

export type LspRequestArgs = {
  workstudioId: string;
  languageId: string;
  method: string;
  params?: unknown;
  timeoutMs?: number;
};

export const lspRequest = async <T = unknown>(args: LspRequestArgs): Promise<T> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<T>('lsp_request', { args });
};

export const lspShutdownWorkstudio = async (workstudioId: string): Promise<void> => {
  if (!isTauri()) return;
  await invoke<void>('lsp_shutdown_workstudio', { workstudioId });
};

export const lspShutdownLanguage = async (workstudioId: string, languageId: string): Promise<void> => {
  if (!isTauri()) return;
  await invoke<void>('lsp_shutdown_language', { workstudioId, languageId });
};

export const lspStatus = async (workstudioId: string): Promise<LspServerStatus[]> => {
  if (!isTauri()) return [];
  return invoke<LspServerStatus[]>('lsp_status', { workstudioId });
};

export type LspDetectServerArgs = {
  languageId: string;
};

export const lspDetectServer = async (args: LspDetectServerArgs): Promise<LspDetectServerResult> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<LspDetectServerResult>('lsp_detect_server', { args });
};

export type AstDocumentSymbolsArgs = {
  languageId: string;
  text: string;
};

export const astDocumentSymbols = async (args: AstDocumentSymbolsArgs): Promise<AstSymbol[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<AstSymbol[]>('ast_document_symbols', { args });
};

// ============================================================================
// Code Index (persisted cache, separate DB; used for fast restore and background indexing)
// ============================================================================

export type CodeIndexRequestDocumentSymbolsArgs = {
  workstudioId: string;
  filePath: string;
  languageId?: string;
  priority?: number;
  force?: boolean;
};

export type CodeIndexDocumentSymbolsSnapshot = {
  filePath: string;
  languageId: string;
  source: string;
  symbols: any;
  updatedAtMs: number;
  isStale: boolean;
  fileMtimeMs?: number | null;
  fileSizeBytes?: number | null;
};

export type CodeIndexRequestDocumentSymbolsResult = {
  cached?: CodeIndexDocumentSymbolsSnapshot | null;
  queued: boolean;
};

export const codeIndexRequestDocumentSymbols = async (
  args: CodeIndexRequestDocumentSymbolsArgs
): Promise<CodeIndexRequestDocumentSymbolsResult> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<CodeIndexRequestDocumentSymbolsResult>('code_index_request_document_symbols', { args });
};

export type CodeIndexStartWorkspaceScanArgs = {
  workstudioId: string;
  priority?: number;
};

export const codeIndexStartWorkspaceScan = async (args: CodeIndexStartWorkspaceScanArgs): Promise<void> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  await invoke<void>('code_index_start_workspace_scan', { args });
};

export type CodeIndexSearchWorkspaceSymbolsArgs = {
  workstudioId: string;
  query: string;
  limit?: number;
};

export type CodeIndexWorkspaceSymbolSearchResult = {
  symbolId: string;
  filePath: string;
  symbolName: string;
  symbolKind: string;
  detail?: string | null;
  containerName?: string | null;
  selectionLine: number;
  selectionColumn: number;
  rangeStartLine: number;
  rangeStartColumn: number;
  rangeEndLine: number;
  rangeEndColumn: number;
  languageId: string;
  updatedAtMs: number;
};

export const codeIndexSearchWorkspaceSymbols = async (
  args: CodeIndexSearchWorkspaceSymbolsArgs
): Promise<CodeIndexWorkspaceSymbolSearchResult[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<CodeIndexWorkspaceSymbolSearchResult[]>('code_index_search_workspace_symbols', { args });
};

export type CodeIndexStatus = {
  pendingJobs: number;
  runningJob?: string | null;
  scanPendingDirs: number;
  scanScannedFiles: number;
  scanQueuedFiles: number;
};

export const codeIndexStatus = async (workstudioId: string): Promise<CodeIndexStatus> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<CodeIndexStatus>('code_index_status', { workstudioId });
};

export type CodeIndexSummary = {
  workstudioId: string;
  dbPath: string;
  dbFileSizeBytes?: number | null;
  dbFileMtimeMs?: number | null;
  fileSymbolsCount: number;
  fullScanRoots?: string | null;
  fullScanCompletedAtMs?: number | null;
  currentRoots: string;
  sameRoots: boolean;
  isFresh: boolean;
  shouldSkipFullScan: boolean;
};

export const codeIndexSummary = async (workstudioId: string): Promise<CodeIndexSummary> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<CodeIndexSummary>('code_index_summary', { workstudioId });
};

// ============================================================================
// AI Code Completion (ghost inline + Ctrl+Space list)
// ============================================================================

export type AiCodeCompletionArgs = {
  workstudioId: string;
  languageId: string;
  filePath: string;
  prefix: string;
  suffix: string;
  count?: number;
};

export type AiCodeCompletionItem = {
  label: string;
  insertText: string;
};

export type AiCodeCompletionResult = {
  items: AiCodeCompletionItem[];
  modelRef: string;
  latencyMs: number;
};

export const aiCodeCompletion = async (args: AiCodeCompletionArgs): Promise<AiCodeCompletionResult> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<AiCodeCompletionResult>('ai_code_completion', { args });
};

// ============================================================================
// AI Symbol Analysis (Workstudio Outline, persisted in DB)
// ============================================================================

export type WorkstudioSymbolAnalysisKey = {
  workstudioId: string;
  filePath: string;
  symbolKey: string;
};

export type WorkstudioSymbolAnalysisFileKey = {
  workstudioId: string;
  filePath: string;
};

export const getWorkstudioSymbolAnalysis = async (
  args: WorkstudioSymbolAnalysisKey
): Promise<WorkstudioSymbolAnalysis | null> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioSymbolAnalysis | null>('get_workstudio_symbol_analysis', { args });
};

export const listWorkstudioSymbolAnalysisKeysForFile = async (
  args: WorkstudioSymbolAnalysisFileKey
): Promise<string[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<string[]>('list_workstudio_symbol_analysis_keys_for_file', { args });
};

export const listWorkstudioSymbolAnalysisSummariesForFile = async (
  args: WorkstudioSymbolAnalysisFileKey
): Promise<WorkstudioSymbolAnalysisSummary[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioSymbolAnalysisSummary[]>('list_workstudio_symbol_analysis_summaries_for_file', {
    args,
  });
};

export const deleteWorkstudioSymbolAnalysis = async (args: WorkstudioSymbolAnalysisKey): Promise<void> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  await invoke<void>('delete_workstudio_symbol_analysis', { args });
};

export type SaveWorkstudioSymbolAnalysisArgs = {
  workstudioId: string;
  languageId: string;
  filePath: string;
  /** 符号来源：lsp | ast_cst（可选，旧版本后端可忽略） */
  symbolSource?: string;
  symbolKey: string;
  symbolName: string;
  symbolKind: string;
  selectionLine: number;
  selectionColumn: number;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  answerMd: string;
  modelRef?: string;
  latencyMs?: number;
};

export const saveWorkstudioSymbolAnalysis = async (
  args: SaveWorkstudioSymbolAnalysisArgs
): Promise<WorkstudioSymbolAnalysis> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioSymbolAnalysis>('save_workstudio_symbol_analysis', { args });
};

export type AiAnalyzeWorkstudioSymbolArgs = {
  workstudioId: string;
  languageId: string;
  filePath: string;
  symbolKey: string;
  symbolName: string;
  symbolKind: string;
  selectionLine: number;
  selectionColumn: number;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  code: string;
};

export const aiAnalyzeWorkstudioSymbol = async (
  args: AiAnalyzeWorkstudioSymbolArgs
): Promise<WorkstudioSymbolAnalysis> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioSymbolAnalysis>('ai_analyze_workstudio_symbol', { args });
};

// ============================================================================
// AI Folder Analysis (Workstudio Explorer folders, persisted in DB)
// ============================================================================

export type WorkstudioFolderAnalysisKey = {
  workstudioId: string;
  folderPath: string;
};

export const getWorkstudioFolderAnalysis = async (
  args: WorkstudioFolderAnalysisKey
): Promise<WorkstudioFolderAnalysis | null> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioFolderAnalysis | null>('get_workstudio_folder_analysis', { args });
};

export const listWorkstudioFolderAnalysisSummaries = async (args: {
  workstudioId: string;
}): Promise<WorkstudioFolderAnalysisSummary[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioFolderAnalysisSummary[]>('list_workstudio_folder_analysis_summaries', { args });
};

export const deleteWorkstudioFolderAnalysis = async (args: WorkstudioFolderAnalysisKey): Promise<void> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  await invoke<void>('delete_workstudio_folder_analysis', { args });
};

export type SaveWorkstudioFolderAnalysisArgs = {
  workstudioId: string;
  folderPath: string;
  answerMd: string;
  modelRef?: string;
  latencyMs?: number;
};

export const saveWorkstudioFolderAnalysis = async (
  args: SaveWorkstudioFolderAnalysisArgs
): Promise<WorkstudioFolderAnalysis> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioFolderAnalysis>('save_workstudio_folder_analysis', { args });
};

// ============================================================================
// Workstudio Chat With (Inline Chat, persisted)
// ============================================================================

export type WorkstudioChatWithFileKey = {
  workstudioId: string;
  filePath: string;
  limit?: number;
};

export type WorkstudioChatWithFileSummariesArgs = {
  workstudioId: string;
  limit?: number;
};

export type FindWorkstudioChatWithThreadArgs = {
  workstudioId: string;
  agentName: string;
  filePath: string;
  languageId?: string;
  label?: string;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
};

export const findWorkstudioChatWithThread = async (
  args: FindWorkstudioChatWithThreadArgs
): Promise<WorkstudioChatWithThread | null> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithThread | null>('find_workstudio_chat_with_thread', { args });
};

export const saveWorkstudioChatWithThread = async (thread: WorkstudioChatWithThread): Promise<WorkstudioChatWithThread> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithThread>('save_workstudio_chat_with_thread', { args: { thread } });
};

export const getWorkstudioChatWithThreadByConversation = async (
  conversationId: string
): Promise<WorkstudioChatWithThread | null> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithThread | null>('get_workstudio_chat_with_thread_by_conversation', { conversationId });
};

export const listWorkstudioChatWithThreadsForFile = async (
  args: WorkstudioChatWithFileKey
): Promise<WorkstudioChatWithThread[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithThread[]>('list_workstudio_chat_with_threads_for_file', { args });
};

export const listWorkstudioChatWithRecordsForFile = async (
  args: WorkstudioChatWithFileKey
): Promise<WorkstudioChatWithRecord[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithRecord[]>('list_workstudio_chat_with_records_for_file', { args });
};

export const listWorkstudioChatWithFileSummaries = async (
  args: WorkstudioChatWithFileSummariesArgs
): Promise<WorkstudioChatWithFileSummary[]> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithFileSummary[]>('list_workstudio_chat_with_file_summaries', { args });
};

export const touchWorkstudioChatWithThreadForConversation = async (args: {
  conversationId: string;
  modelRef?: string;
}): Promise<WorkstudioChatWithThread | null> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  return invoke<WorkstudioChatWithThread | null>('touch_workstudio_chat_with_thread_for_conversation', { args });
};

export const deleteWorkstudioChatWithRecordsForFile = async (
  args: Omit<WorkstudioChatWithFileKey, 'limit'>
): Promise<void> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  await invoke<void>('delete_workstudio_chat_with_records_for_file', { args });
};

export const deleteWorkstudioChatWithRecord = async (args: { workstudioId: string; id: string }): Promise<void> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  await invoke<void>('delete_workstudio_chat_with_record', { args });
};

export const deleteWorkstudioChatWithThread = async (args: {
  threadId: string;
  workstudioId?: string;
}): Promise<void> => {
  if (!isTauri()) {
    throw new Error('Not running in Tauri');
  }
  await invoke<void>('delete_workstudio_chat_with_thread', { args });
};
