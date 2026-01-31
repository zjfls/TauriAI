import React, { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/shallow';
import { ChatView } from '../components/Chat/ChatView';
import { useSessionStore } from '../stores/sessionStore';
import { endChatOpenProfile, getActiveChatOpenProfile, markChatOpenProfile } from '../utils/chatOpenProfile';

const MemoChatView = React.memo(ChatView);
MemoChatView.displayName = 'MemoChatView';

const ChatViewContainerInner: React.FC = () => {
  const sessionIds = useSessionStore(
    useShallow((state): string[] => Array.from(state.sessions.keys()))
  );
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const hasActive = useSessionStore((state) => {
    const active = state.activeSessionId;
    return Boolean(active && state.sessions.has(active));
  });
  const switchSession = useSessionStore((state) => state.switchSession);
  const layerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const profileScheduledRef = useRef<string | null>(null);

  // 容错：恢复状态异常时（sessions 有值但 activeSessionId 为空），自动选择第一个会话。
  useEffect(() => {
    if (activeSessionId) return;
    const firstId = sessionIds[0];
    if (!firstId) return;
    switchSession(firstId);
  }, [activeSessionId, sessionIds, switchSession]);

  // 切换会话时，如果焦点仍在已隐藏的会话层里，主动 blur，避免键盘输入落到不可见输入框。
  useEffect(() => {
    if (!activeSessionId) return;
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLElement)) return;
    for (const [sessionId, el] of layerRefs.current) {
      if (sessionId === activeSessionId) continue;
      if (el.contains(active)) {
        active.blur();
        break;
      }
    }
  }, [activeSessionId]);

  // Debug profiling: keep-alive 模式下 ChatView 不会随切换重新渲染，因此在容器层补齐“切换到可见并完成绘制”的时点。
  useEffect(() => {
    if (!activeSessionId) return;

    const profile = getActiveChatOpenProfile();
    if (!profile || profile.ended) return;

    const activeSession = useSessionStore.getState().sessions.get(activeSessionId);
    const conversationId = activeSession?.conversationId ?? undefined;

    const matches =
      (profile.sessionId ? profile.sessionId === activeSessionId : false) ||
      (conversationId && profile.conversationId ? profile.conversationId === conversationId : false);
    if (!matches) return;

    if (profileScheduledRef.current === profile.id) return;
    profileScheduledRef.current = profile.id;

    markChatOpenProfile('chatViewContainer:active_changed', {
      profileId: profile.id,
      sessionId: activeSessionId,
      conversationId,
      meta: { keepAlive: true },
    });

    requestAnimationFrame(() => {
      markChatOpenProfile('chatViewContainer:raf1', { profileId: profile.id, sessionId: activeSessionId, conversationId });
      requestAnimationFrame(() => {
        markChatOpenProfile('chatViewContainer:raf2', { profileId: profile.id, sessionId: activeSessionId, conversationId });
        requestAnimationFrame(() => {
          endChatOpenProfile('chatViewContainer:painted', { profileId: profile.id, sessionId: activeSessionId, conversationId });
        });
      });
    });
  }, [activeSessionId]);

  const setLayerRef = useCallback(
    (sessionId: string) => (el: HTMLDivElement | null) => {
      const map = layerRefs.current;
      if (el) map.set(sessionId, el);
      else map.delete(sessionId);
    },
    []
  );

  if (!hasActive) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <p className="text-lg mb-2">暂无活动会话</p>
          <p className="text-sm">点击上方 "+" 按钮创建新会话</p>
        </div>
      </div>
    );
  }

  // Keep-alive（按会话）：为每个会话保留一个 ChatView 实例，切换时仅做显示/隐藏，
  // 从而保留各自的滚动位置与 UI 状态，避免“重入后重新渲染导致定位漂移”。
  return (
    <div className="relative h-full w-full overflow-hidden">
      {sessionIds.map((sessionId) => (
        <div
          key={sessionId}
          ref={setLayerRef(sessionId)}
          className={`absolute inset-0 ${sessionId === activeSessionId ? '' : 'invisible pointer-events-none'}`}
          aria-hidden={sessionId !== activeSessionId}
        >
          <MemoChatView sessionId={sessionId} />
        </div>
      ))}
    </div>
  );
};

// 避免主视图切换（activeView 改变）导致 ChatViewContainer 重渲染。
export const ChatViewContainer = React.memo(ChatViewContainerInner);
ChatViewContainer.displayName = 'ChatViewContainer';
