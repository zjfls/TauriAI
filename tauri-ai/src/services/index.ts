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
