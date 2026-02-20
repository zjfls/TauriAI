/**
 * Conversation Service
 * Wraps Tauri invoke calls for conversation commands
 * Requirements: 10.3, 10.4, 10.5
 */

import { tauriInvoke as invoke } from '../utils/errorUtils';
import type { Conversation, ConversationActivePath, DebugInfo, Message } from '../types';
import { hydrateMessagesFromBackend } from '../utils/hydrateMessages';

/**
 * Get all conversations sorted by update time descending
 * Requirements: 10.3
 * 
 * @returns Promise resolving to the list of conversations
 */
export async function getConversations(): Promise<Conversation[]> {
  return invoke<Conversation[]>('get_conversations');
}

/**
 * Get messages for a conversation with pagination
 * Requirements: 10.4
 * 
 * @param conversationId - The conversation to get messages from
 * @param limit - Maximum number of messages to return (default: 50)
 * @param beforeId - If provided, only return messages before this message ID
 * @returns Promise resolving to the list of messages
 */
export async function getMessages(
  conversationId: string,
  limit?: number,
  beforeId?: string
): Promise<Message[]> {
  const messages = await invoke<Message[]>('get_messages', {
    conversationId,
    limit: limit ?? 50,
    beforeId,
  });
  return hydrateMessagesFromBackend(messages);
}

/**
 * Lazy-load persisted debug info for a specific turn.
 */
export async function getTurnDebugInfo(
  conversationId: string,
  messageId: string,
  turnId: string
): Promise<DebugInfo | null> {
  return invoke<DebugInfo | null>('get_turn_debug_info', {
    conversationId,
    messageId,
    turnId,
  });
}

/**
 * Create a new conversation
 * Requirements: 10.5
 * 
 * @param title - Optional title for the conversation (defaults to "New Conversation")
 * @returns Promise resolving to the created conversation
 */
export async function createConversation(title?: string): Promise<Conversation> {
  return invoke<Conversation>('create_conversation', {
    title: title ?? 'New Conversation',
  });
}

/**
 * Delete a conversation and all its messages
 * Requirements: 10.5
 * 
 * @param conversationId - The conversation ID to delete
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  return invoke('delete_conversation', { conversationId });
}

/**
 * Update a conversation's title
 * Requirements: 10.5
 * 
 * @param conversationId - The conversation ID to update
 * @param title - The new title
 */
export async function updateConversationTitle(
  conversationId: string,
  title: string
): Promise<void> {
  return invoke('update_conversation_title', { conversationId, title });
}

export type BindPreference = 'file' | 'folder';

export interface ConversationFileIndexUpdate {
  conversationId: string;
  primaryPath?: string | null;
  primaryPathKind?: string | null;
  primaryPathPref?: string | null;
  activeFiles?: ConversationActivePath[] | null;
  activeFilesUpdatedAt?: string | null;
}

export async function ensureConversationFileIndexes(
  conversationIds: string[],
  opts?: { preference?: BindPreference; maxMessages?: number; force?: boolean }
): Promise<ConversationFileIndexUpdate[]> {
  return invoke<ConversationFileIndexUpdate[]>('ensure_conversation_file_indexes', {
    conversationIds,
    preference: opts?.preference ?? 'file',
    maxMessages: opts?.maxMessages ?? 200,
    force: opts?.force ?? false,
  });
}
