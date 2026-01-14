/**
 * Chat Service
 * Wraps Tauri invoke calls for chat commands
 * Requirements: 10.1, 10.2
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Format prompt types for different scenarios
 */
export type FormatPromptType = 'chat' | 'plain' | 'json' | 'none';

/**
 * Payload for streaming token events
 */
export interface StreamTokenPayload {
  conversation_id: string;
  token: string;
}

/**
 * Payload for stream completion events
 */
export interface StreamDonePayload {
  conversation_id: string;
  full_content: string;
}

/**
 * Payload for stream error events
 */
export interface StreamErrorPayload {
  conversation_id: string;
  error: string;
}

/**
 * Stream event handlers
 */
export interface StreamEventHandlers {
  onToken?: (payload: StreamTokenPayload) => void;
  onDone?: (payload: StreamDonePayload) => void;
  onError?: (payload: StreamErrorPayload) => void;
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
  return invoke('chat_stream', { 
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
  return invoke('abort_chat', { conversationId });
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
  const unlisteners: UnlistenFn[] = [];

  // Listen for token events
  if (handlers.onToken) {
    const unlisten = await listen<StreamTokenPayload>('chat:token', (event) => {
      handlers.onToken?.(event.payload);
    });
    unlisteners.push(unlisten);
  }

  // Listen for done events
  if (handlers.onDone) {
    const unlisten = await listen<StreamDonePayload>('chat:done', (event) => {
      handlers.onDone?.(event.payload);
    });
    unlisteners.push(unlisten);
  }

  // Listen for error events
  if (handlers.onError) {
    const unlisten = await listen<StreamErrorPayload>('chat:error', (event) => {
      handlers.onError?.(event.payload);
    });
    unlisteners.push(unlisten);
  }

  // Return a combined unlisten function
  return () => {
    unlisteners.forEach((unlisten) => unlisten());
  };
}
