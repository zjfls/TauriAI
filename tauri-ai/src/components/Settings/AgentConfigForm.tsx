/**
 * AgentConfigForm Component
 * Form for managing AI agents
 */

import React, { useState, useEffect } from 'react';
import { Plus, Star, Search, Copy } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type { Agent, AgentType, AskForApproval, FormatPromptType, SandboxPolicy, SecurityPolicyConfig } from '../../types';

const defaultAgent: Agent = {
  name: '',
  type: 'chat',
  displayName: '',
  description: '',
  modelRef: '',
  systemPrompt: '',
  formatType: 'chat',
  reinjectThinking: false,
  workspaceSupport: undefined,
};

export const AgentConfigForm: React.FC = () => {
  const { config, addAgent, updateAgent, deleteAgent, setDefaultAgent, getModelOptions } = useConfigStore();
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const agents = config?.agents || [];
  const defaultAgentName = config?.defaultAgent || '';
  const modelOptions = getModelOptions();
  const toolsetOptions = (config?.tools?.toolsets ?? []).map((t) => ({ label: t.name, value: t.name }));

  const filteredAgents = agents.filter(a =>
    a.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    if (agents.length > 0 && !selectedAgentName) {
      setSelectedAgentName(agents[0].name);
    }
  }, [agents, selectedAgentName]);

  const handleSelectAgent = (name: string) => {
    setSelectedAgentName(name);
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleCreateNew = () => {
    setIsCreating(true);
    setEditingAgent({ ...defaultAgent, name: `agent_${Date.now()}` });
    setSelectedAgentName(null);
  };

  const handleEdit = () => {
    const agent = agents.find(a => a.name === selectedAgentName);
    if (agent) {
      setEditingAgent({ ...agent });
    }
  };

  const handleSave = () => {
    if (!editingAgent || !editingAgent.displayName.trim()) return;
    if (isCreating) {
      addAgent(editingAgent);
      setSelectedAgentName(editingAgent.name);
    } else {
      updateAgent(editingAgent);
    }
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleDelete = () => {
    if (!selectedAgentName) return;
    if (confirm('确定要删除这个智能体吗？')) {
      deleteAgent(selectedAgentName);
      setSelectedAgentName(agents.find(a => a.name !== selectedAgentName)?.name || null);
    }
  };

  const nextUniqueAgentName = (baseName: string) => {
    const existing = new Set(agents.map((a) => a.name));
    const cleanedBase = baseName.trim() || 'agent';
    let candidate = `${cleanedBase}_copy`;
    let i = 2;
    while (existing.has(candidate)) {
      candidate = `${cleanedBase}_copy${i}`;
      i += 1;
    }
    return candidate;
  };

  const handleDuplicate = () => {
    if (editingAgent) return;
    const agent = agents.find((a) => a.name === selectedAgentName);
    if (!agent) return;

    const duplicated: Agent = {
      ...agent,
      name: nextUniqueAgentName(agent.name),
      displayName: agent.displayName ? `${agent.displayName}（复制）` : `${agent.name}（复制）`,
    };

    addAgent(duplicated);
    setSelectedAgentName(duplicated.name);
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleSetDefault = () => {
    if (selectedAgentName) {
      setDefaultAgent(selectedAgentName);
    }
  };

  const currentAgent = editingAgent || agents.find(a => a.name === selectedAgentName);

  return (
    <div className="flex gap-6 h-full">
      {/* Agent List */}
      <div className="w-64 flex-shrink-0 flex flex-col">
        <div className="mb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索智能体..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 space-y-1 overflow-auto">
          {filteredAgents.map((agent) => (
            <div
              key={agent.name}
              onClick={() => handleSelectAgent(agent.name)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedAgentName === agent.name && !isCreating
                  ? 'bg-blue-100 dark:bg-blue-900/50'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
            >
              <span className="text-sm truncate">{agent.displayName}</span>
              {agent.name === defaultAgentName && (
                <Star size={14} className="text-yellow-500 fill-yellow-500" />
              )}
            </div>
          ))}
          {isCreating && (
            <div className="px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-sm">
              新建智能体
            </div>
          )}
        </div>

        <button
          onClick={handleCreateNew}
          className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:border-blue-500 hover:text-blue-500 transition-colors"
        >
          <Plus size={16} />
          <span className="text-sm">添加智能体</span>
        </button>
      </div>

      {/* Agent Form */}
      <div className="flex-1 min-w-0">
        {currentAgent ? (
          <AgentForm
            agent={currentAgent}
            isEditing={!!editingAgent}
            isDefault={currentAgent.name === defaultAgentName}
            modelOptions={modelOptions}
            toolsetOptions={toolsetOptions}
            securityPolicies={config?.security?.policies ?? []}
            defaultSecurityPolicyName={config?.security?.defaultPolicy ?? ''}
            onEdit={handleEdit}
            onDuplicate={handleDuplicate}
            onSave={handleSave}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onSetDefault={handleSetDefault}
            onFieldChange={(field, value) =>
              setEditingAgent((prev) => (prev ? { ...prev, [field]: value } : prev))
            }
          />
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-500">
            {agents.length === 0 ? '点击添加第一个智能体' : '选择一个智能体'}
          </div>
        )}
      </div>
    </div>
  );
};

interface AgentFormProps {
  agent: Agent;
  isEditing: boolean;
  isDefault: boolean;
  modelOptions: { label: string; value: string }[];
  toolsetOptions: { label: string; value: string }[];
  securityPolicies: SecurityPolicyConfig[];
  defaultSecurityPolicyName: string;
  onEdit: () => void;
  onDuplicate: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onFieldChange: (field: keyof Agent, value: any) => void;
}

const AgentForm: React.FC<AgentFormProps> = ({
  agent,
  isEditing,
  isDefault,
  modelOptions,
  toolsetOptions,
  securityPolicies,
  defaultSecurityPolicyName,
  onEdit,
  onDuplicate,
  onSave,
  onCancel,
  onDelete,
  onSetDefault,
  onFieldChange,
}) => {
  const agentTypeOptions: { value: AgentType; label: string }[] = [
    { value: 'chat', label: 'Chat' },
    { value: 'tool', label: '工具' },
  ];

  const effectiveType: AgentType = (agent.type ?? 'chat') as AgentType;
  const supportsToolset = effectiveType === 'tool';
  const effectiveWorkspaceSupport = supportsToolset ? (agent.workspaceSupport ?? true) : false;

  const effectiveToolsetOptions = (() => {
    if (!agent.toolset) return toolsetOptions;
    if (toolsetOptions.some((o) => o.value === agent.toolset)) return toolsetOptions;
    return [{ value: agent.toolset, label: `（不存在）${agent.toolset}` }, ...toolsetOptions];
  })();

  const formatOptions: { value: FormatPromptType; label: string }[] = [
    { value: 'chat', label: 'Chat (富文本)' },
    { value: 'plain', label: '纯文本' },
    { value: 'json', label: 'JSON' },
    { value: 'none', label: '无格式' },
  ];

  const sandboxSummary = (policy: SandboxPolicy) => {
    switch (policy.type) {
      case 'read-only':
        return '只读';
      case 'workspace-write':
        return '工作区可写';
      case 'external-sandbox':
        return '外部沙盒';
      case 'danger-full-access':
        return '完全访问';
      default:
        return '未知';
    }
  };

  const approvalSummary = (policy: AskForApproval) => {
    switch (policy) {
      case 'untrusted':
        return 'Untrusted（更谨慎）';
      case 'on-failure':
        return 'On Failure（失败再问）';
      case 'on-request':
        return 'On Request（模型决定）';
      case 'never':
        return 'Never（永不询问）';
      default:
        return '未知';
    }
  };

  const globalDefaultPolicy =
    securityPolicies.find((p) => p.name === defaultSecurityPolicyName) ??
    securityPolicies[0] ?? {
      name: defaultSecurityPolicyName || 'default',
      sandboxPolicy: { type: 'workspace-write', writableRoots: [], networkAccess: true } as SandboxPolicy,
      approvalPolicy: 'on-request' as AskForApproval,
      trustedCommands: [],
    };

  const baseSecurityPolicy =
    securityPolicies.find((p) => p.name === (agent.securityPolicy ?? '')) ?? globalDefaultPolicy;

  const effectiveSandboxPolicy: SandboxPolicy = agent.sandboxPolicy ?? baseSecurityPolicy.sandboxPolicy;
  const effectiveApprovalPolicy: AskForApproval = agent.approvalPolicy ?? baseSecurityPolicy.approvalPolicy;

  const defaultPolicyForType = (type: SandboxPolicy['type']): SandboxPolicy => {
    switch (type) {
      case 'read-only':
        return { type: 'read-only' };
      case 'danger-full-access':
        return { type: 'danger-full-access' };
      case 'external-sandbox':
        return { type: 'external-sandbox', networkAccess: 'restricted' };
      case 'workspace-write':
      default:
        return {
          type: 'workspace-write',
          writableRoots: [],
          networkAccess: true,
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            {agent.displayName || '智能体配置'}
          </h2>
          {isDefault && (
            <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 rounded">
              默认
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">取消</button>
              <button onClick={onSave} className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg">保存</button>
            </>
          ) : (
            <>
              {!isDefault && (
                <button onClick={onSetDefault} className="px-3 py-1.5 text-sm text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/30 rounded-lg">
                  设为默认
                </button>
              )}
              <button
                onClick={onDuplicate}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg flex items-center gap-1"
                title="复制智能体"
              >
                <Copy size={14} />
                复制
              </button>
              <button onClick={onEdit} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">编辑</button>
              <button onClick={onDelete} className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg">删除</button>
            </>
          )}
        </div>
      </div>

      {/* Form Fields */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">显示名称</label>
            <input
              type="text"
              value={agent.displayName}
              onChange={(e) => onFieldChange('displayName', e.target.value)}
              disabled={!isEditing}
              placeholder="例如：默认助手"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">使用模型</label>
            <select
              value={agent.modelRef}
              onChange={(e) => onFieldChange('modelRef', e.target.value)}
              disabled={!isEditing}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              <option value="">选择模型</option>
              {modelOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">智能体类型</label>
            <select
              value={effectiveType}
              onChange={(e) => {
                const nextType = e.target.value as AgentType;
                onFieldChange('type', nextType);
                if (nextType !== 'tool') {
                  onFieldChange('toolset', undefined);
                  onFieldChange('workspaceSupport', undefined);
                }
              }}
              disabled={!isEditing}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              {agentTypeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Toolset</label>
            <select
              value={agent.toolset ?? ''}
              onChange={(e) => onFieldChange('toolset', e.target.value || undefined)}
              disabled={!isEditing || !supportsToolset}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            >
              <option value="">（默认：不绑定 toolset）</option>
              {effectiveToolsetOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              {supportsToolset ? '未绑定时默认 allow_all（再由工具权限过滤）。' : '仅 Tool 类型可绑定 toolset。'}
            </p>
          </div>
        </div>

        {supportsToolset && (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">WorkSpaceSupport</label>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={effectiveWorkspaceSupport}
                onChange={(e) => onFieldChange('workspaceSupport', e.target.checked)}
                disabled={!isEditing}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                启用工作区/Workstudio（默认开启）
              </span>
            </div>
            <p className="text-xs text-gray-500">
              开启后：Tool 智能体会绑定一个工作目录（支持多个文件夹），并在提示词中明确当前工作目录。
            </p>
          </div>
        )}

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">安全策略</label>
          <select
            value={agent.securityPolicy ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              onFieldChange('securityPolicy', v ? v : undefined);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（默认：使用全局默认策略 - {globalDefaultPolicy.name}）</option>
            {securityPolicies.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}（{sandboxSummary(p.sandboxPolicy)} / {approvalSummary(p.approvalPolicy)}）
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500">生效策略：{baseSecurityPolicy.name}</p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            审批策略（AskForApproval）
          </label>
          <select
            value={agent.approvalPolicy ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              onFieldChange('approvalPolicy', v ? (v as AskForApproval) : undefined);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（默认：使用安全策略 - {approvalSummary(baseSecurityPolicy.approvalPolicy)}）</option>
            <option value="untrusted">Untrusted</option>
            <option value="on-failure">On Failure</option>
            <option value="on-request">On Request</option>
            <option value="never">Never</option>
          </select>
          <p className="text-xs text-gray-500">生效策略：{approvalSummary(effectiveApprovalPolicy)}</p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">沙盒策略</label>
          <select
            value={agent.sandboxPolicy?.type ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                onFieldChange('sandboxPolicy', undefined);
                return;
              }
              const type = v as SandboxPolicy['type'];
              const nextPolicy =
                baseSecurityPolicy.sandboxPolicy.type === type
                  ? baseSecurityPolicy.sandboxPolicy
                  : defaultPolicyForType(type);
              onFieldChange('sandboxPolicy', nextPolicy);
            }}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            <option value="">（默认：使用安全策略 - {sandboxSummary(baseSecurityPolicy.sandboxPolicy)}）</option>
            <option value="read-only">Read Only（只读）</option>
            <option value="workspace-write">Workspace Write（工作区可写）</option>
            <option value="danger-full-access">Full Access（完全访问）</option>
          </select>
          <p className="text-xs text-gray-500">
            生效策略：{sandboxSummary(effectiveSandboxPolicy)}。Read Only 会禁用 apply_patch 与 PTY 交互式终端。
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">最大 Turn 数</label>
          <input
            type="number"
            min={1}
            value={agent.maxTurns ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                onFieldChange('maxTurns', undefined);
                return;
              }
              const n = Number(v);
              onFieldChange('maxTurns', Number.isFinite(n) ? Math.max(1, Math.floor(n)) : undefined);
            }}
            disabled={!isEditing}
            placeholder="例如：10000"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
          <p className="text-xs text-gray-500">
            {supportsToolset ? 'Tool 类型会进行多 Turn 循环；未设置时后端默认 10000。' : '一般 Chat 类型默认单 Turn。'}
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">描述</label>
          <input
            type="text"
            value={agent.description || ''}
            onChange={(e) => onFieldChange('description', e.target.value)}
            disabled={!isEditing}
            placeholder="简短描述这个智能体的用途"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">系统提示词</label>
            {agent.systemPrompt && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(agent.systemPrompt);
                }}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                title="复制系统提示词"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                复制
              </button>
            )}
          </div>
          <textarea
            value={agent.systemPrompt}
            onChange={(e) => onFieldChange('systemPrompt', e.target.value)}
            disabled={!isEditing}
            placeholder="设置 AI 的行为和角色..."
            rows={6}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800 resize-none"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">输出格式</label>
          <select
            value={agent.formatType}
            onChange={(e) => onFieldChange('formatType', e.target.value as FormatPromptType)}
            disabled={!isEditing}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
          >
            {formatOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">思考回灌</label>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={agent.reinjectThinking ?? false}
              onChange={(e) => onFieldChange('reinjectThinking', e.target.checked)}
              disabled={!isEditing}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              将 thinking 作为文本写入同一 Task 的下一轮上下文
            </span>
          </div>
          <p className="text-xs text-gray-500">
            默认关闭：thinking 只用于 UI/调试展示；开启会增加上下文长度，并可能影响模型输出风格。
          </p>
        </div>
      </div>
    </div>
  );
};

export default AgentConfigForm;
