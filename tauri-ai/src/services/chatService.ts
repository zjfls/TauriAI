/**
 * Chat Service
 * Wraps Tauri invoke calls for chat commands
 * Requirements: 10.1, 10.2
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
 * Start a streaming chat request
 * Requirements: 10.1
 * 
 * @param conversationId - The conversation ID to send the message to
 * @param content - The message content to send
 */
export async function chatStream(
  conversationId: string,
  content: string
): Promise<void> {
  return invoke('chat_stream', { conversationId, content });
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
