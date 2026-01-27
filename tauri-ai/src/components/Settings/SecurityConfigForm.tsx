/**
 * SecurityConfigForm Component
 * Configure sandbox/security policies (multiple profiles)
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Plus, Search, Star, Trash2 } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig, AskForApproval, NetworkAccess, SandboxPolicy, SecurityPolicyConfig } from '../../types';

const Toggle: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}> = ({ checked, disabled, onChange, title }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 rounded-full transition-colors ${
      checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
    } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    title={title}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-5' : ''
      }`}
    />
  </button>
);

const policySummary = (policy: SandboxPolicy) => {
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

const defaultSandboxPolicyForType = (type: SandboxPolicy['type']): SandboxPolicy => {
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

const parseRoots = (text: string) =>
  text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

const nextUniqueName = (existing: Set<string>, base: string) => {
  const cleaned = base.trim() || 'policy';
  if (!existing.has(cleaned)) return cleaned;
  let i = 2;
  while (existing.has(`${cleaned}_${i}`)) i += 1;
  return `${cleaned}_${i}`;
};

export const SecurityConfigForm: React.FC = () => {
  const { config, saveConfig } = useConfigStore();
  const [selectedPolicyName, setSelectedPolicyName] = useState<string | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<SecurityPolicyConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [trustToolDraft, setTrustToolDraft] = useState('shell_command');
  const [trustCommandDraft, setTrustCommandDraft] = useState('');

  const policies = config?.security?.policies ?? [];
  const defaultPolicyName = config?.security?.defaultPolicy ?? policies[0]?.name ?? '';

  const filteredPolicies = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return policies;
    return policies.filter((p) => p.name.toLowerCase().includes(q));
  }, [policies, searchQuery]);

  useEffect(() => {
    if (isCreating) return;
    if (filteredPolicies.length === 0) return;
    if (selectedPolicyName) return;
    setSelectedPolicyName(filteredPolicies[0].name);
  }, [filteredPolicies, selectedPolicyName, isCreating]);

  useEffect(() => {
    setTrustToolDraft('shell_command');
    setTrustCommandDraft('');
  }, [selectedPolicyName, isCreating, editingPolicy]);

  if (!config) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const isEditing = Boolean(editingPolicy);
  const currentPolicy =
    editingPolicy ?? policies.find((p) => p.name === selectedPolicyName) ?? null;

  const save = (updated: AppConfig) => {
    saveConfig(updated);
  };

  const ensureSecurityShape = (cfg: AppConfig): AppConfig => {
    const nextPolicies = cfg.security?.policies?.length ? cfg.security.policies : policies;
    const nextDefault =
      cfg.security?.defaultPolicy || defaultPolicyName || nextPolicies[0]?.name || 'default';
    return {
      ...cfg,
      security: {
        policies: nextPolicies,
        defaultPolicy: nextDefault,
      },
    };
  };

  const handleCreate = () => {
    const existing = new Set(policies.map((p) => p.name));
    const name = nextUniqueName(existing, `policy_${Date.now()}`);
    setIsCreating(true);
    setSelectedPolicyName(null);
    setEditingPolicy({
      name,
      sandboxPolicy: defaultSandboxPolicyForType('workspace-write'),
      approvalPolicy: 'on-request',
      trustedCommands: [],
    });
  };

  const handleEdit = () => {
    if (!selectedPolicyName) return;
    const policy = policies.find((p) => p.name === selectedPolicyName);
    if (!policy) return;
    setEditingPolicy({
      ...policy,
      sandboxPolicy: { ...policy.sandboxPolicy },
      trustedCommands: [...(policy.trustedCommands ?? [])],
    });
    setIsCreating(false);
  };

  const handleCancel = () => {
    setEditingPolicy(null);
    setIsCreating(false);
  };

  const handleSave = () => {
    if (!editingPolicy) return;
    const name = editingPolicy.name.trim();
    if (!name) return;

    const originalName = isCreating ? null : selectedPolicyName;
    const nameChanged = Boolean(originalName && originalName !== name);
    const nameConflicts = policies.some((p) => p.name === name && p.name !== originalName);
    if (nameConflicts) {
      alert('策略名称已存在，请换一个名称');
      return;
    }

    const nextPolicies = (() => {
      if (isCreating) {
        return [...policies, { ...editingPolicy, name }];
      }
      return policies.map((p) => (p.name === originalName ? { ...editingPolicy, name } : p));
    })();

    const nextDefaultPolicy = (() => {
      if (defaultPolicyName === originalName && nameChanged) return name;
      if (!defaultPolicyName) return nextPolicies[0]?.name ?? name;
      return defaultPolicyName;
    })();

    const nextAgents = nameChanged
      ? config.agents.map((a) =>
          a.securityPolicy === originalName ? { ...a, securityPolicy: name } : a
        )
      : config.agents;

    save(
      ensureSecurityShape({
        ...config,
        security: { policies: nextPolicies, defaultPolicy: nextDefaultPolicy },
        agents: nextAgents,
      })
    );

    setEditingPolicy(null);
    setIsCreating(false);
    setSelectedPolicyName(name);
  };

  const handleDelete = () => {
    if (!selectedPolicyName) return;
    if (policies.length <= 1) {
      alert('至少需要保留一个安全策略');
      return;
    }
    if (!confirm(`确定要删除安全策略「${selectedPolicyName}」吗？相关智能体会自动回退到默认策略。`))
      return;

    const nextPolicies = policies.filter((p) => p.name !== selectedPolicyName);
    const nextDefaultPolicy =
      defaultPolicyName === selectedPolicyName ? nextPolicies[0]?.name ?? '' : defaultPolicyName;
    const nextAgents = config.agents.map((a) =>
      a.securityPolicy === selectedPolicyName ? { ...a, securityPolicy: undefined } : a
    );

    save(
      ensureSecurityShape({
        ...config,
        security: { policies: nextPolicies, defaultPolicy: nextDefaultPolicy },
        agents: nextAgents,
      })
    );

    setEditingPolicy(null);
    setIsCreating(false);
    setSelectedPolicyName(nextPolicies[0]?.name ?? null);
  };

  const handleSetDefault = () => {
    if (!selectedPolicyName) return;
    save(
      ensureSecurityShape({
        ...config,
        security: { policies, defaultPolicy: selectedPolicyName },
      })
    );
  };

  const handleDuplicate = () => {
    if (!selectedPolicyName) return;
    if (isEditing) return;
    const policy = policies.find((p) => p.name === selectedPolicyName);
    if (!policy) return;

    const existing = new Set(policies.map((p) => p.name));
    const nextName = nextUniqueName(existing, `${policy.name}_copy`);
    const duplicated: SecurityPolicyConfig = {
      ...policy,
      name: nextName,
      sandboxPolicy: { ...policy.sandboxPolicy },
      trustedCommands: [...(policy.trustedCommands ?? [])],
    };

    save(
      ensureSecurityShape({
        ...config,
        security: { policies: [...policies, duplicated], defaultPolicy: defaultPolicyName },
      })
    );

    setSelectedPolicyName(nextName);
    setEditingPolicy(null);
    setIsCreating(false);
  };

  const onFieldChange = <K extends keyof SecurityPolicyConfig>(field: K, value: SecurityPolicyConfig[K]) => {
    if (!isEditing || !editingPolicy) return;
    setEditingPolicy({ ...editingPolicy, [field]: value });
  };

  const onSandboxTypeChange = (type: SandboxPolicy['type']) => {
    if (!isEditing || !editingPolicy) return;
    const next = defaultSandboxPolicyForType(type);
    onFieldChange('sandboxPolicy', next);
  };

  const addTrustedCommand = () => {
    if (!isEditing || !editingPolicy) return;
    const tool = trustToolDraft.trim();
    const command = trustCommandDraft.trim();
    if (!tool || !command) return;

    const existing = editingPolicy.trustedCommands ?? [];
    const already = existing.some((t) => t.tool === tool && t.command === command);
    if (already) {
      setTrustCommandDraft('');
      return;
    }
    onFieldChange('trustedCommands', [...existing, { tool, command }]);
    setTrustCommandDraft('');
  };

  const removeTrustedCommand = (index: number) => {
    if (!isEditing || !editingPolicy) return;
    const existing = editingPolicy.trustedCommands ?? [];
    onFieldChange(
      'trustedCommands',
      existing.filter((_, i) => i !== index)
    );
  };

  return (
    <div className="flex h-full gap-6">
      {/* Policy List */}
      <div className="flex w-64 flex-shrink-0 flex-col">
        <div className="mb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索策略..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-700"
            />
          </div>
        </div>

        <div className="flex-1 space-y-1 overflow-auto">
          {filteredPolicies.map((p) => (
            <div
              key={p.name}
              onClick={() => {
                if (isEditing) return;
                setSelectedPolicyName(p.name);
              }}
              className={`flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 transition-colors ${
                selectedPolicyName === p.name && !isCreating
                  ? 'bg-blue-100 dark:bg-blue-900/50'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700'
              } ${isEditing ? 'opacity-60 cursor-not-allowed' : ''}`}
              title={`${policySummary(p.sandboxPolicy)} / ${approvalSummary(p.approvalPolicy)}`}
            >
              <span className="truncate text-sm">{p.name}</span>
              {p.name === defaultPolicyName ? (
                <Star size={14} className="fill-yellow-500 text-yellow-500" />
              ) : (
                <span className="text-xs text-gray-500">{policySummary(p.sandboxPolicy)}</span>
              )}
            </div>
          ))}
          {isCreating && (
            <div className="rounded-lg bg-blue-100 px-3 py-2 text-sm dark:bg-blue-900/50">
              新建策略
            </div>
          )}
        </div>

        <button
          onClick={handleCreate}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-2 text-gray-500 transition-colors hover:border-blue-500 hover:text-blue-500 dark:border-gray-600"
        >
          <Plus size={16} />
          <span className="text-sm">添加策略</span>
        </button>
      </div>

      {/* Right Panel */}
      <div className="flex-1 overflow-auto">
        {!currentPolicy ? (
          <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">
            {policies.length === 0 ? '请先添加一个安全策略' : '请选择一个安全策略'}
          </div>
        ) : (
          <div className="max-w-2xl space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {currentPolicy.name || '安全策略'}
                </h2>
                {currentPolicy.name === defaultPolicyName && (
                  <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                    默认
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      onClick={handleCancel}
                      className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleSave}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                    >
                      保存
                    </button>
                  </>
                ) : (
                  <>
                    {currentPolicy.name !== defaultPolicyName && (
                      <button
                        onClick={handleSetDefault}
                        className="rounded-lg px-3 py-1.5 text-sm text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/30"
                      >
                        设为默认
                      </button>
                    )}
                    <button
                      onClick={handleDuplicate}
                      className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                      title="复制策略"
                    >
                      <Copy size={14} />
                      复制
                    </button>
                    <button
                      onClick={handleEdit}
                      className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      编辑
                    </button>
                    <button
                      onClick={handleDelete}
                      className="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      <span className="inline-flex items-center gap-1">
                        <Trash2 size={14} />
                        删除
                      </span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Fields */}
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  策略名称
                </label>
                <input
                  type="text"
                  value={currentPolicy.name}
                  onChange={(e) => onFieldChange('name', e.target.value)}
                  disabled={!isEditing}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  审批策略（AskForApproval）
                </label>
                <select
                  value={currentPolicy.approvalPolicy}
                  onChange={(e) => onFieldChange('approvalPolicy', e.target.value as AskForApproval)}
                  disabled={!isEditing}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                >
                  <option value="untrusted">Untrusted</option>
                  <option value="on-failure">On Failure</option>
                  <option value="on-request">On Request</option>
                  <option value="never">Never</option>
                </select>
                <p className="text-xs text-gray-500">当前：{approvalSummary(currentPolicy.approvalPolicy)}</p>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  沙盒策略
                </label>
                <select
                  value={currentPolicy.sandboxPolicy.type}
                  onChange={(e) => onSandboxTypeChange(e.target.value as SandboxPolicy['type'])}
                  disabled={!isEditing}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                >
                  <option value="read-only">Read Only（只读）</option>
                  <option value="workspace-write">Workspace Write（工作区可写）</option>
                  <option value="danger-full-access">Full Access（完全访问）</option>
                  <option value="external-sandbox">External Sandbox（外部沙盒）</option>
                </select>
                <p className="text-xs text-gray-500">当前：{policySummary(currentPolicy.sandboxPolicy)}</p>
              </div>

              {currentPolicy.sandboxPolicy.type === 'danger-full-access' && (
                <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-900/50 dark:bg-orange-900/20">
                  <p className="text-sm text-orange-800 dark:text-orange-200">
                    Full Access：允许在系统任意位置写入/执行命令。请仅在你信任当前任务与模型输出时开启。
                  </p>
                </div>
              )}

              {currentPolicy.sandboxPolicy.type === 'external-sandbox' && (
                <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    网络访问
                  </label>
                  <select
                    value={(currentPolicy.sandboxPolicy.networkAccess ?? 'restricted') as NetworkAccess}
                    onChange={(e) =>
                      onFieldChange('sandboxPolicy', {
                        type: 'external-sandbox',
                        networkAccess: e.target.value as NetworkAccess,
                      })
                    }
                    disabled={!isEditing}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                  >
                    <option value="restricted">Restricted（受限）</option>
                    <option value="enabled">Enabled（允许）</option>
                  </select>
                </div>
              )}

              {currentPolicy.sandboxPolicy.type === 'workspace-write' && (
                <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        允许网络访问
                      </label>
                      <p className="text-xs text-gray-500">默认开启（策略层标记）。</p>
                    </div>
                    <Toggle
                      checked={Boolean(currentPolicy.sandboxPolicy.networkAccess)}
                      disabled={!isEditing}
                      onChange={(next) =>
                        onFieldChange('sandboxPolicy', { ...currentPolicy.sandboxPolicy, networkAccess: next })
                      }
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      额外可写目录（每行一个）
                    </label>
                    <textarea
                      rows={4}
                      value={(currentPolicy.sandboxPolicy.writableRoots ?? []).join('\n')}
                      onChange={(e) =>
                        onFieldChange('sandboxPolicy', {
                          ...currentPolicy.sandboxPolicy,
                          writableRoots: parseRoots(e.target.value),
                        })
                      }
                      disabled={!isEditing}
                      className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-700 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                      placeholder="例如：D:\\work\\extra\n/opt/data"
                    />
                    <p className="text-xs text-gray-500">
                      Workstudio 主目录与附加目录无需填写，已自动视为可写根目录。
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    信任命令（Trust）
                  </label>
                  <span className="text-xs text-gray-500">
                    {(currentPolicy.trustedCommands ?? []).length}
                  </span>
                </div>

                {(currentPolicy.trustedCommands ?? []).length === 0 ? (
                  <p className="text-xs text-gray-500">暂无信任命令。</p>
                ) : (
                  <div className="space-y-2">
                    {(currentPolicy.trustedCommands ?? []).map((t, idx) => (
                      <div
                        key={`${t.tool}:${t.command}:${idx}`}
                        className="flex items-start justify-between gap-3 rounded border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs text-gray-700 dark:text-gray-200">
                            {t.tool}
                          </div>
                          <div className="mt-0.5 break-words font-mono text-xs text-gray-600 dark:text-gray-300">
                            {t.command}
                          </div>
                        </div>
                        {isEditing ? (
                          <button
                            type="button"
                            onClick={() => removeTrustedCommand(idx)}
                            className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                            title="移除"
                          >
                            <Trash2 size={14} />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}

                {isEditing ? (
                  <div className="flex flex-col gap-2 pt-2">
                    <div className="flex gap-2">
                      <select
                        value={trustToolDraft}
                        onChange={(e) => setTrustToolDraft(e.target.value)}
                        className="w-44 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700"
                      >
                        <option value="shell_command">shell_command</option>
                        <option value="exec_command">exec_command</option>
                        <option value="exec_command_persistent">exec_command_persistent</option>
                      </select>
                      <input
                        type="text"
                        value={trustCommandDraft}
                        onChange={(e) => setTrustCommandDraft(e.target.value)}
                        placeholder="例如：git status"
                        className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-700"
                      />
                      <button
                        type="button"
                        onClick={addTrustedCommand}
                        disabled={!trustCommandDraft.trim()}
                        className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60 hover:bg-blue-700"
                      >
                        添加
                      </button>
                    </div>
                    <p className="text-xs text-gray-500">
                      提示：在 Untrusted 模式下，命中的命令会自动通过审批（无需弹窗）。
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SecurityConfigForm;
