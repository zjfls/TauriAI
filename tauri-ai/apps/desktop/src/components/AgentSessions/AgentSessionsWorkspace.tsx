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

const scopeKindLabel = (kind: AgentSessionScope['kind']) => {
  switch (kind) {
    case 'conversation':
      return '聊天';
    case 'standalone':
      return '独立';
    case 'workspace':
      return '工作区';
    case 'schedule':
      return '调度';
    default:
      return kind;
  }
};

const scopeLabel = (session: AgentSessionSummary) => scopeKindLabel(session.scopeKind);

const transportLabel = (transport: string) => {
  switch (transport) {
    case 'headless':
      return 'Headless';
    case 'codex_cli':
      return 'Codex CLI';
    case 'claude_code':
      return 'Claude Code';
    default:
      return transport;
  }
};

const createScopeLabel = (scope: AgentSessionScope) => {
  switch (scope.kind) {
    case 'conversation':
      return '创建对话内工作单元';
    case 'workspace':
      return '创建工作区工作单元';
    case 'schedule':
      return '创建调度工作单元';
    case 'standalone':
    default:
      return '创建独立工作单元';
  }
};

const sessionStatusLabel = (status: string) => (status === 'closed' ? '已关闭' : '运行中');

const statusTone = (status: string) => {
  if (status === 'closed') {
    return 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
  }
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
};

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

const MessageBubble: React.FC<{
  detail: AgentSessionDetail;
  role: string;
  content: string;
  thinking?: string | null;
  createdAt?: string | null;
}> = ({ detail, role, content, thinking, createdAt }) => {
  const conversationId = detail.summary.scopeKind === 'conversation' ? detail.summary.scopeId : undefined;
  return (
    <div className={`rounded-2xl border px-4 py-3 ${roleTone(role)}`}>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium uppercase tracking-wide">{role}</span>
        <span>{formatDateTime(createdAt)}</span>
      </div>
      {thinking ? (
        <details className="mb-3 rounded-xl border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
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

const StatCard: React.FC<{ label: string; value: number; hint: string }> = ({ label, value, hint }) => (
  <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
    <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</div>
  </div>
);

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
    if (!availableAgents.length) {
      if (newAgentName) setNewAgentName('');
      return;
    }
    if (availableAgents.some((agent) => agent.name === newAgentName)) return;
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

  const selectedAgent = useMemo(
    () => availableAgents.find((agent) => agent.name === newAgentName) ?? null,
    [availableAgents, newAgentName]
  );
  const activeSessionCount = useMemo(
    () => sessions.filter((session) => session.status !== 'closed').length,
    [sessions]
  );
  const closedSessionCount = Math.max(0, sessions.length - activeSessionCount);
  const scopeBadge = listScope ? `${scopeKindLabel(listScope.kind)} · ${listScope.id}` : '全部会话';

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
    <div className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${embedded ? 'bg-white dark:bg-gray-900' : 'bg-gray-50 dark:bg-gray-950'}`}>
      <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
              <Bot size={16} />
              <span>{title}</span>
              <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {scopeBadge}
              </span>
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              像工作台一样统一查看、创建和继续外部 code agent 工作单元。
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onOpenManager ? (
              <button
                type="button"
                onClick={onOpenManager}
                className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                打开完整工作台
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
      </div>

      {!embedded ? (
        <div className="grid grid-cols-1 gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-950 sm:grid-cols-3">
          <StatCard label="已启用 Agent" value={availableAgents.length} hint="来自外部 Agent 配置，可直接创建工作单元。" />
          <StatCard label="运行中会话" value={activeSessionCount} hint="当前范围内仍可继续发送消息的会话。" />
          <StatCard label="已关闭会话" value={closedSessionCount} hint="可继续查看 transcript，但不会再接收新输入。" />
        </div>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[280px_320px_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 xl:border-b-0 xl:border-r">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">可用 Agent</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">先选择一个外部 agent，再创建新的工作单元。</div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="space-y-2">
              {availableAgents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  当前没有启用的外部 Agent，请先去设置页完成探测和启用。
                </div>
              ) : (
                availableAgents.map((agent) => {
                  const isSelected = agent.name === newAgentName;
                  return (
                    <button
                      key={agent.name}
                      type="button"
                      onClick={() => setNewAgentName(agent.name)}
                      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${isSelected
                        ? 'border-blue-500 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/30'
                        : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800/80'
                        }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                            {agent.displayName || agent.name}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                            <span>{transportLabel(agent.transport?.type ?? '')}</span>
                            {agent.modelRef ? (
                              <>
                                <span>·</span>
                                <span>{agent.modelRef}</span>
                              </>
                            ) : null}
                          </div>
                        </div>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                          {agent.name}
                        </span>
                      </div>
                      {agent.taskUsage || agent.description ? (
                        <div className="mt-2 line-clamp-3 text-xs text-gray-600 dark:text-gray-300">
                          {agent.taskUsage || agent.description}
                        </div>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950/60">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <MessageSquarePlus size={16} />
                <span>创建工作单元</span>
              </div>
              {selectedAgent ? (
                <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                  <div className="font-medium">{selectedAgent.displayName || selectedAgent.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-blue-700 dark:text-blue-300">
                    <span>{transportLabel(selectedAgent.transport?.type ?? '')}</span>
                    {selectedAgent.modelRef ? (
                      <>
                        <span>·</span>
                        <span>{selectedAgent.modelRef}</span>
                      </>
                    ) : null}
                    {selectedAgent.defaultTimeoutMs ? (
                      <>
                        <span>·</span>
                        <span>{Math.round(selectedAgent.defaultTimeoutMs / 1000)}s timeout</span>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="space-y-3">
                <input
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  placeholder="工作单元标题（可选）"
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
                <textarea
                  value={newPrompt}
                  onChange={(event) => setNewPrompt(event.target.value)}
                  placeholder="给这个子 Agent 的第一条消息…"
                  className="min-h-[128px] w-full resize-none rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={isStarting || availableAgents.length === 0}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Sparkles size={14} />
                  <span>{isStarting ? '创建中…' : createScopeLabel(createScope)}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 xl:border-b-0 xl:border-r">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">工作单元列表</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">当前范围共 {sessions.length} 个会话，按最近更新时间排序。</div>
              </div>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {activeSessionCount} 运行中
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {isLoading ? <div className="text-xs text-gray-400">加载会话中…</div> : null}
            {!isLoading && sessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 px-4 py-8 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                当前范围内暂无会话，可以先从左侧创建一个新的工作单元。
              </div>
            ) : null}
            <div className="space-y-3">
              {sessions.map((session) => {
                const isActive = session.sessionId === selectedSessionId;
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => selectSession(listScope, session.sessionId)}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${isActive
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/30'
                      : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800/80'
                      }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{session.title}</div>
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
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${statusTone(session.status)}`}>
                        {sessionStatusLabel(session.status)}
                      </span>
                    </div>
                    {session.lastResultPreview ? (
                      <div className="mt-2 line-clamp-3 text-xs text-gray-600 dark:text-gray-300">
                        {session.lastResultPreview}
                      </div>
                    ) : null}
                    <div className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
                      更新于 {formatDateTime(session.updatedAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col bg-gray-50 dark:bg-gray-950">
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
                      <span>{transportLabel(selectedSummary.transport)}</span>
                      <span>·</span>
                      <span>{scopeLabel(selectedSummary)}</span>
                      {selectedSummary.modelRef ? (
                        <>
                          <span>·</span>
                          <span>{selectedSummary.modelRef}</span>
                        </>
                      ) : null}
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
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    最近错误：{selectedSummary.lastError}
                  </div>
                ) : null}
                {selectedDetail?.transcriptError ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                    Transcript 加载异常：{selectedDetail.transcriptError}
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
                {isLoadingDetail ? <div className="text-sm text-gray-400">正在加载会话详情…</div> : null}
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
                  <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-4 py-8 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    当前会话暂无可展示的 transcript。
                  </div>
                ) : null}
              </div>

              <div className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
                <textarea
                  value={replyPrompt}
                  onChange={(event) => setReplyPrompt(event.target.value)}
                  placeholder={selectedSummary.status === 'closed' ? '该会话已关闭' : '继续给这个 Agent 发送消息…'}
                  disabled={selectedSummary.status === 'closed'}
                  className="min-h-[96px] w-full resize-none rounded-2xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:disabled:bg-gray-900/50"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
                    会话 ID：<span className="font-mono">{selectedSummary.sessionId}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={selectedSummary.status === 'closed' || isSending}
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
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
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">还没有选中工作单元</div>
                <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  你可以先在左侧选择一个外部 Agent 并创建工作单元，或者打开已有会话继续协作。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {localError || scopeError ? (
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
