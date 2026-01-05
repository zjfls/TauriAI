/**
 * ChatView Component
 * Main chat interface composing MessageList and InputArea
 * Requirements: 2.3, 2.4
 */

import React, { useEffect } from 'react';
import { useConversationStore } from '../../stores/conversationStore';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';

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
    loadMessages,
  } = useConversationStore();

  // Load messages when conversation changes
  useEffect(() => {
    if (conversationId) {
      loadMessages(conversationId);
    }
  }, [conversationId, loadMessages]);

  // Note: Stream listener is set up in App.tsx to avoid duplicate listeners

  const handleSend = async (content: string) => {
    await sendMessage(content);
  };

  const handleAbort = async () => {
    await abortGeneration();
  };

  return (
    <div className="flex h-full flex-col">
      <MessageList
        messages={messages}
        streamingContent={streamingMessage}
        isGenerating={isGenerating}
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
