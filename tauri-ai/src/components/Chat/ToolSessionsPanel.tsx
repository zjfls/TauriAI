/**
 * ToolSessionsPanel
 * Conversation-level PTY session manager
 */

import React, { useEffect, useMemo } from 'react';
import { X, RefreshCw, PlugZap, Trash2 } from 'lucide-react';
import { useToolSessionStore } from '../../stores/toolSessionStore';
import type { PtySessionInfo, PtySessionScope } from '../../types';

interface ToolSessionsPanelProps {
  conversationId: string;
  isOpen: boolean;
  onClose: () => void;
}

const scopeLabel = (scope: PtySessionScope) => (scope === 'conversation' ? '持久' : '仅本任务');

const formatTime = (value: number) => {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
};

const ToolSessionRow: React.FC<{
  session: PtySessionInfo;
  onCloseSession: (sessionId: number) => void;
}> = ({ session, onCloseSession }) => {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-sm dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 text-green-600 dark:text-green-300">
          <PlugZap size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] text-gray-800 dark:text-gray-100">
            {session.command || '(empty command)'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-gray-500 dark:text-gray-400">
            <span className={session.isAlive ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}>
              {session.isAlive ? '运行中' : '已退出'}
            </span>
            <span>{scopeLabel(session.scope)}</span>
            <span title={session.workdir || ''}>cwd: {session.workdir || '-'}</span>
            <span>创建: {formatTime(session.createdAtMs)}</span>
            <span>最近: {formatTime(session.lastUsedMs)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onCloseSession(session.sessionId)}
          className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          title="强制关闭该会话"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
};

export const ToolSessionsPanel: React.FC<ToolSessionsPanelProps> = ({
  conversationId,
  isOpen,
  onClose,
}) => {
  const {
    sessionsByConversation,
    isLoadingByConversation,
    refreshSessions,
    closeSession,
  } = useToolSessionStore();

  const sessions = useMemo(
    () =>
      (sessionsByConversation[conversationId] || []).filter(
        (s) => s.scope === 'conversation'
      ),
    [sessionsByConversation, conversationId]
  );
  const isLoading = Boolean(isLoadingByConversation[conversationId]);

  useEffect(() => {
    if (isOpen && conversationId) {
      refreshSessions(conversationId);
    }
  }, [isOpen, conversationId, refreshSessions]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="absolute left-6 top-16 w-[420px] max-w-[90vw] rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <PlugZap size={16} />
            <span>持久进程</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => refreshSessions(conversationId)}
              className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              title="刷新"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {isLoading && (
            <div className="text-xs text-gray-400">加载中...</div>
          )}
          {!isLoading && sessions.length === 0 && (
            <div className="text-xs text-gray-400">暂无持久进程</div>
          )}
          <div className="space-y-2">
            {sessions.map((session) => (
              <ToolSessionRow
                key={session.sessionId}
                session={session}
                onCloseSession={(id) => closeSession(conversationId, id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
