import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bot, CircleOff, MessageSquarePlus, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { MarkdownRenderer } from '../Chat/MarkdownRenderer';
import type { AgentSessionDetail, AgentSessionScope, AgentSessionSummary } from '../../types';

interface AgentSessionsWorkspaceProps {
  listScope: AgentSessionScope | null;
  createScope: AgentSessionScope;
  title: string;
  embedded?: boolean;
  onClose?: () => void;
  onOpenManager?: () => void;
}

const scopeLabel = (session: AgentSessionSummary) => {
  switch (session.scopeKind) {
    case 'conversation':
      return '聊天';
    case 'standalone':
      return '独立';
    case 'workspace':
      return '工作区';
    case 'schedule':
      return '调度';
    default:
      return session.scopeKind;
  }
};

const sessionStatusLabel = (status: string) => (status === 'closed' ? '已关闭' : '运行中');

const formatDateTime = (value?: string | null) => {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

const roleTone = (role: string) => {
  switch (role) {
    case 'assistant':
      return 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30';
    case 'user':
      return 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900/50';
    case 'tool':
      return 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20';
    default:
      return 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20';
  }
};

const scopeKeyOf = (scope: AgentSessionScope | null) => (scope ? `${scope.kind}:${scope.id}` : 'all');

const MessageBubble: React.FC<{ detail: AgentSessionDetail; role: string; content: string; thinking?: string | null; createdAt?: string | null; }> = ({ detail, role, content, thinking, createdAt }) => {
  const conversationId = detail.summary.scopeKind === 'conversation' ? detail.summary.scopeId : undefined;
  return (
    <div className={`rounded-xl border px-3 py-3 ${roleTone(role)}`}>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium uppercase tracking-wide">{role}</span>
        <span>{formatDateTime(createdAt)}</span>
      </div>
      {thinking ? (
        <details className="mb-3 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Thinking
          </summary>
          <div className="mt-2 whitespace-pre-wrap break-words text-sm">{thinking}</div>
        </details>
      ) : null}
      <div className="min-w-0 text-sm text-gray-800 dark:text-gray-100">
        <MarkdownRenderer content={content || '（空消息）'} conversationId={conversationId} />
      </div>
    </div>
  );
};

export const AgentSessionsWorkspace: React.FC<AgentSessionsWorkspaceProps> = ({
  listScope,
  createScope,
  title,
  embedded = false,
  onClose,
  onOpenManager,
}) => {
  const scopeKey = scopeKeyOf(listScope);
  const { config } = useConfigStore();
  const {
    sessionsByScopeKey,
    selectedSessionIdByScopeKey,
    detailsBySessionId,
    isLoadingByScopeKey,
    isLoadingDetailBySessionId,
    isStartingByScopeKey,
    isSendingBySessionId,
    errorsByScopeKey,
    refreshSessions,
    loadSessionDetail,
    selectSession,
    startSession,
    sendSessionMessage,
    closeSession,
  } = useAgentSessionStore();

  const availableAgents = useMemo(
    () => (config?.externalAgents?.agents ?? []).filter((agent) => agent.enabled !== false),
    [config]
  );

  const sessions = sessionsByScopeKey[scopeKey] ?? [];
  const selectedSessionId = selectedSessionIdByScopeKey[scopeKey] ?? null;
  const selectedDetail = selectedSessionId ? detailsBySessionId[selectedSessionId] : undefined;
  const selectedSummary = useMemo(
    () => sessions.find((session) => session.sessionId === selectedSessionId) ?? selectedDetail?.summary,
    [selectedDetail?.summary, selectedSessionId, sessions]
  );
  const isLoading = Boolean(isLoadingByScopeKey[scopeKey]);
  const scopeError = errorsByScopeKey[scopeKey] ?? null;
  const isStarting = Boolean(isStartingByScopeKey[scopeKey]);
  const isSending = selectedSessionId ? Boolean(isSendingBySessionId[selectedSessionId]) : false;
  const isLoadingDetail = selectedSessionId ? Boolean(isLoadingDetailBySessionId[selectedSessionId]) : false;

  const [newAgentName, setNewAgentName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [replyPrompt, setReplyPrompt] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (newAgentName || availableAgents.length === 0) return;
    setNewAgentName(availableAgents[0].name);
  }, [availableAgents, newAgentName]);

  useEffect(() => {
    void refreshSessions(listScope);
  }, [listScope, refreshSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (detailsBySessionId[selectedSessionId]) return;
    void loadSessionDetail(selectedSessionId);
  }, [detailsBySessionId, loadSessionDetail, selectedSessionId]);

  const handleCreate = async () => {
    if (!newAgentName.trim()) {
      setLocalError('请选择一个可用的外部 Agent');
      return;
    }
    if (!newPrompt.trim()) {
      setLocalError('请输入初始化消息');
      return;
    }
    setLocalError(null);
    try {
      const result = await startSession({
        scope: createScope,
        agentName: newAgentName,
        prompt: newPrompt,
        title: newTitle || undefined,
      });
      selectSession(listScope, result.detail.summary.sessionId);
      setNewPrompt('');
      setNewTitle('');
      setReplyPrompt('');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSend = async () => {
    if (!selectedSummary) {
      setLocalError('请先选择一个会话');
      return;
    }
    if (!replyPrompt.trim()) {
      setLocalError('请输入要发送的内容');
      return;
    }
    setLocalError(null);
    try {
      await sendSessionMessage({
        scope: listScope,
        sessionId: selectedSummary.sessionId,
        prompt: replyPrompt,
      });
      setReplyPrompt('');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCloseSession = async () => {
    if (!selectedSummary) return;
    setLocalError(null);
    try {
      await closeSession({ scope: listScope, sessionId: selectedSummary.sessionId });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden ${embedded ? 'bg-white dark:bg-gray-900' : 'bg-gray-50 dark:bg-gray-950'}`}>
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Bot size={16} />
            <span>{title}</span>
            {listScope ? (
              <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {listScope.kind}:{listScope.id}
              </span>
            ) : (
              <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">
                all sessions
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            会话是一级工作单元：聊天面板和独立视图共用同一套 session。
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onOpenManager ? (
            <button
              type="button"
              onClick={onOpenManager}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              打开管理视图
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void refreshSessions(listScope)}
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            title="刷新会话列表"
          >
            <RefreshCw size={14} />
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              title="关闭"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] overflow-hidden">
        <div className="flex min-h-0 flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
              <MessageSquarePlus size={16} />
              <span>新建会话</span>
            </div>
            <div className="space-y-2">
              <select
                value={newAgentName}
                onChange={(event) => setNewAgentName(event.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                {availableAgents.length === 0 ? <option value="">无可用 Agent</option> : null}
                {availableAgents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.displayName || agent.name}
                  </option>
                ))}
              </select>
              <input
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="会话标题（可选）"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              />
              <textarea
                value={newPrompt}
                onChange={(event) => setNewPrompt(event.target.value)}
                placeholder="给这个子 Agent 的第一条消息…"
                className="min-h-[110px] w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={isStarting || availableAgents.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Sparkles size={14} />
                <span>{isStarting ? '创建中…' : '创建独立会话'}</span>
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {isLoading ? (
              <div className="text-xs text-gray-400">加载会话中…</div>
            ) : null}
            {!isLoading && sessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                当前范围内暂无会话。
              </div>
            ) : null}
            <div className="space-y-2">
              {sessions.map((session) => {
                const active = session.sessionId === selectedSessionId;
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => selectSession(listScope, session.sessionId)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${active
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/30'
                      : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800/80'
                      }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                        {session.title}
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${session.status === 'closed'
                        ? 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                        }`}>
                        {sessionStatusLabel(session.status)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      <span>{session.displayName || session.agentName}</span>
                      <span>·</span>
                      <span>{scopeLabel(session)}</span>
                      {session.modelRef ? (
                        <>
                          <span>·</span>
                          <span>{session.modelRef}</span>
                        </>
                      ) : null}
                    </div>
                    {session.lastResultPreview ? (
                      <div className="mt-2 line-clamp-2 text-xs text-gray-600 dark:text-gray-300">
                        {session.lastResultPreview}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col bg-gray-50 dark:bg-gray-950">
          {selectedSummary ? (
            <>
              <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
                      {selectedSummary.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span>{selectedSummary.displayName || selectedSummary.agentName}</span>
                      <span>·</span>
                      <span>{selectedSummary.transport}</span>
                      <span>·</span>
                      <span>{scopeLabel(selectedSummary)}</span>
                      <span>·</span>
                      <span>{formatDateTime(selectedSummary.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void loadSessionDetail(selectedSummary.sessionId)}
                      className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      刷新内容
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCloseSession()}
                      className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                      关闭会话
                    </button>
                  </div>
                </div>
                {selectedSummary.lastError ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    最近错误：{selectedSummary.lastError}
                  </div>
                ) : null}
                {selectedDetail?.transcriptError ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                    Transcript 加载异常：{selectedDetail.transcriptError}
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {isLoadingDetail ? (
                  <div className="text-sm text-gray-400">正在加载会话详情…</div>
                ) : null}
                {!isLoadingDetail && selectedDetail?.messages?.length ? (
                  <div className="space-y-3">
                    {selectedDetail.messages.map((message) => (
                      <MessageBubble
                        key={message.id}
                        detail={selectedDetail}
                        role={message.role}
                        content={message.content}
                        thinking={message.thinking}
                        createdAt={message.createdAt}
                      />
                    ))}
                  </div>
                ) : null}
                {!isLoadingDetail && !selectedDetail?.messages?.length ? (
                  <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    当前会话暂无可展示的 transcript。
                  </div>
                ) : null}
              </div>

              <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-800">
                <textarea
                  value={replyPrompt}
                  onChange={(event) => setReplyPrompt(event.target.value)}
                  placeholder={selectedSummary.status === 'closed' ? '该会话已关闭' : '继续给这个 Agent 发送消息…'}
                  disabled={selectedSummary.status === 'closed'}
                  className="min-h-[88px] w-full resize-none rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-900/50"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    会话 ID：<span className="font-mono">{selectedSummary.sessionId}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={selectedSummary.status === 'closed' || isSending}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Send size={14} />
                    <span>{isSending ? '发送中…' : '发送消息'}</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-8 text-center dark:border-gray-700 dark:bg-gray-900">
                <CircleOff className="mx-auto mb-3 text-gray-400" size={28} />
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">还没有选中会话</div>
                <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  你可以在左边创建一个新的 Agent session，或者打开已有 session 继续工作。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {(localError || scopeError) ? (
        <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>{localError || scopeError}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default AgentSessionsWorkspace;
