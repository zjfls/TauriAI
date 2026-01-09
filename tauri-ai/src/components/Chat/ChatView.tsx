/**
 * ChatView Component
 * Main chat interface composing MessageList and InputArea
 * Requirements: 2.3, 2.4
 */

import React from 'react';
import { useConversationStore } from '../../stores/conversationStore';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';
import * as opener from '@tauri-apps/plugin-opener';

interface ChatViewProps {
  conversationId: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({ conversationId }) => {
  const {
    messages,
    streamingMessage,
    isGenerating,
    sendMessage,
    abortGeneration,
    createConversation,
  } = useConversationStore();

  // 消息加载由 setCurrentConversation 负责，这里不再调用 loadMessages
  // 这样创建新对话时不会触发 loadMessages，避免竞态条件

  // Note: Stream listener is set up in App.tsx to avoid duplicate listeners

  const handleSend = async (content: string) => {
    // 如果没有对话，先创建一个
    if (!conversationId) {
      await createConversation();
      // createConversation 已设置 currentConversationId
    }
    await sendMessage(content);
  };

  const handleAbort = async () => {
    await abortGeneration();
  };

  const handleAction = async (action: import('../../types').Action) => {
    switch (action.action_type) {
      case 'copy':
        if (action.payload) {
          await navigator.clipboard.writeText(action.payload);
        }
        break;
      case 'retry':
        // For standard retry, we might need a message ID if payload is not enough context.
        // But here we rely on the component triggering it to pass context?
        // Wait, MessageToolbar triggers onAction(action).
        // Action payload doesn't necessarily have messageId.
        // We need to pass messageId TO the MessageToolbar or handle it in MessageItem wrapper.
        // Let's assume for MVP 'retry' action is context-aware via payload or we need to pass messageId.
        // Actually, the Store 'retry' takes `messageId`.
        // We need to know WHICH message triggered the action.
        // MessageItem knows the message. It passes `onAction`.
        // It should probably augment the action or we pass `(action, message)`?
        // Let's update `onAction` signature in MessageList/MessageItem to `(action, message)`.
        break;
      case 'navigate':
        // For now, no router integrated in UI Store widely, just console or window.location?
        // App.tsx handles views via UI Store.
        // useUIStore.getState().setActiveView(...)
        // Need to import useUIStore.
        break;
      case 'link':
        if (action.payload) {
          // Use Tauri opener
          await (opener as any).open(action.payload);
        }
        break;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <MessageList
        messages={messages}
        streamingContent={streamingMessage}
        isGenerating={isGenerating}
        onAction={handleAction}
      />
      <InputArea
        onSend={handleSend}
        onAbort={handleAbort}
        disabled={false}
        isGenerating={isGenerating}
      />
    </div>
  );
};

export default ChatView;
