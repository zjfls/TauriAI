import React from 'react';
import { ChatView } from '../components/Chat/ChatView';
import { useSessionStore } from '../stores/sessionStore';

export const ChatViewContainer: React.FC = () => {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const session = useSessionStore((state) =>
    activeSessionId ? state.sessions.get(activeSessionId) : undefined
  );

  if (!activeSessionId || !session) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <p className="text-lg mb-2">暂无活动会话</p>
          <p className="text-sm">点击上方 "+" 按钮创建新会话</p>
        </div>
      </div>
    );
  }

  return <ChatView sessionId={activeSessionId} />;
};
