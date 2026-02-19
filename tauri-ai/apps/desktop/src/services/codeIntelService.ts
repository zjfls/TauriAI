import { invoke, isTauri } from '@tauri-apps/api/core';

import type { AstSymbol, LspDetectServerResult, LspServerStatus } from '../types';

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
