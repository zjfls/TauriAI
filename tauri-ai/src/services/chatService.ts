/**
 * Chat Service
 * Wraps Tauri invoke calls for chat commands
 * Requirements: 10.1, 10.2
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { RunEventPayload } from '../types';

/**
 * Format prompt types for different scenarios
 */
export type FormatPromptType = 'chat' | 'plain' | 'json' | 'none';

/**
 * Stream event handlers
 */
export interface StreamEventHandlers {
  onEvent?: (payload: RunEventPayload) => void;
  onBlockDelta?: (payload: Extract<RunEventPayload, { type: 'block_delta' }>) => void;
  onDone?: (payload: Extract<RunEventPayload, { type: 'done' }>) => void;
  onError?: (payload: Extract<RunEventPayload, { type: 'error' }>) => void;
}

/**
 * Options for chat stream
 */
export interface ChatStreamOptions {
  /** Agent name to use (uses default agent if not provided) */
  agentName?: string;
}

/**
 * Start a streaming chat request
 * 
 * @param conversationId - The conversation ID to send the message to
 * @param content - The message content to send
 * @param options - Optional settings including agent name
 */
export async function chatStream(
  conversationId: string,
  content: string,
  options?: ChatStreamOptions
): Promise<void> {
  return invoke('run_task', {
    conversationId, 
    content,
    agentName: options?.agentName
  });
}

/**
 * Abort an ongoing chat generation
 * Requirements: 10.2
 * 
 * @param conversationId - The conversation ID to abort
 */
export async function abortChat(conversationId: string): Promise<void> {
  return invoke('abort_run', { conversationId });
}

/**
 * Set up event listeners for chat streaming
 * Returns an unlisten function to clean up all listeners
 * 
 * @param handlers - Event handlers for token, done, and error events
 * @returns Promise resolving to an unlisten function
 */
export async function setupStreamListeners(
  handlers: StreamEventHandlers
): Promise<UnlistenFn> {
  const unlisten = await listen<RunEventPayload>('run:event', (event) => {
    handlers.onEvent?.(event.payload);

    if (event.payload.type === 'block_delta') {
      handlers.onBlockDelta?.(event.payload);
      return;
    }

    if (event.payload.type === 'done') {
      handlers.onDone?.(event.payload);
      return;
    }

    if (event.payload.type === 'error') {
      handlers.onError?.(event.payload);
    }
  });

  return unlisten;
}
