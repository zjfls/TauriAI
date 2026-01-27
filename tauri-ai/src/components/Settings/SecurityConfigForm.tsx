/**
 * SecurityConfigForm Component
 * Configure sandbox/security policy
 */

import React from 'react';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig, AskForApproval, NetworkAccess, SandboxPolicy } from '../../types';

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
    className={`relative w-11 h-6 rounded-full transition-colors ${
      checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
    } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
    title={title}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
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
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
};

const parseRoots = (text: string) =>
  text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

export const SecurityConfigForm: React.FC = () => {
  const { config, saveConfig } = useConfigStore();

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const sandboxPolicy: SandboxPolicy =
    config.security?.sandboxPolicy ?? defaultPolicyForType('workspace-write');
  const approvalPolicy: AskForApproval = config.security?.approvalPolicy ?? 'on-request';

  const save = (next: Partial<AppConfig['security']>) => {
    const updatedConfig: AppConfig = {
      ...config,
      security: {
        ...(config.security ?? { sandboxPolicy, approvalPolicy }),
        sandboxPolicy,
        approvalPolicy,
        ...next,
      },
    };
    saveConfig(updatedConfig);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          审批策略（AskForApproval）
        </label>
        <select
          value={approvalPolicy}
          onChange={(e) => save({ approvalPolicy: e.target.value as AskForApproval })}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
        >
          <option value="untrusted">Untrusted</option>
          <option value="on-failure">On Failure</option>
          <option value="on-request">On Request</option>
          <option value="never">Never</option>
        </select>
        <p className="text-xs text-gray-500">当前：{approvalSummary(approvalPolicy)}。</p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">沙盒策略</label>
          <select
          value={sandboxPolicy.type}
          onChange={(e) =>
            save({ sandboxPolicy: defaultPolicyForType(e.target.value as SandboxPolicy['type']) })
          }
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
        >
          <option value="read-only">Read Only（只读）</option>
          <option value="workspace-write">Workspace Write（工作区可写）</option>
          <option value="danger-full-access">Full Access（完全访问）</option>
          <option value="external-sandbox">External Sandbox（外部沙盒）</option>
        </select>
        <p className="text-xs text-gray-500">
          当前：{policySummary(sandboxPolicy)}。工作区可写会把 Workstudio 挂载的目录全部视为可写根目录。
        </p>
      </div>

      {sandboxPolicy.type === 'read-only' && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Read Only：禁止写文件与交互式终端（PTY）。推荐使用 <code className="font-mono">read_file/list_dir/rg</code> 进行只读操作。
          </p>
        </div>
      )}

      {sandboxPolicy.type === 'danger-full-access' && (
        <div className="rounded-lg border border-orange-200 dark:border-orange-900/50 p-4 bg-orange-50 dark:bg-orange-900/20">
          <p className="text-sm text-orange-800 dark:text-orange-200">
            Full Access：允许在系统任意位置写入/执行命令。请仅在你信任当前任务与模型输出时开启。
          </p>
        </div>
      )}

      {sandboxPolicy.type === 'external-sandbox' && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800 space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">网络访问</label>
          <select
            value={(sandboxPolicy.networkAccess ?? 'restricted') as NetworkAccess}
            onChange={(e) =>
              save({
                sandboxPolicy: {
                  type: 'external-sandbox',
                  networkAccess: e.target.value as NetworkAccess,
                },
              })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
          >
            <option value="restricted">Restricted（禁网/受限）</option>
            <option value="enabled">Enabled（允许）</option>
          </select>
          <p className="text-xs text-gray-500">用于标记“进程已在外部沙盒内运行”的场景。</p>
        </div>
      )}

      {sandboxPolicy.type === 'workspace-write' && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">允许网络访问</label>
              <p className="text-xs text-gray-500">默认关闭。开启后，模型可通过终端命令访问网络（仅策略层约束）。</p>
            </div>
            <Toggle
              checked={Boolean(sandboxPolicy.networkAccess)}
              onChange={(next) =>
                save({ sandboxPolicy: { ...sandboxPolicy, networkAccess: next } })
              }
            />
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">额外可写目录（每行一个）</label>
            <textarea
              rows={4}
              value={(sandboxPolicy.writableRoots ?? []).join('\n')}
              onChange={(e) =>
                save({
                  sandboxPolicy: { ...sandboxPolicy, writableRoots: parseRoots(e.target.value) },
                })
              }
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 resize-none font-mono text-sm"
              placeholder="例如：D:\\work\\extra\n/opt/data"
            />
            <p className="text-xs text-gray-500">
              Workstudio 主目录与附加目录无需填写，已自动视为可写根目录。
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">排除 TMPDIR</label>
              <p className="text-xs text-gray-500">开启后，不把用户 TMPDIR 环境目录加入默认可写根目录。</p>
            </div>
            <Toggle
              checked={Boolean(sandboxPolicy.excludeTmpdirEnvVar)}
              onChange={(next) =>
                save({ sandboxPolicy: { ...sandboxPolicy, excludeTmpdirEnvVar: next } })
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">排除 /tmp（Unix）</label>
              <p className="text-xs text-gray-500">仅在 Linux/macOS 有意义。</p>
            </div>
            <Toggle
              checked={Boolean(sandboxPolicy.excludeSlashTmp)}
              onChange={(next) =>
                save({ sandboxPolicy: { ...sandboxPolicy, excludeSlashTmp: next } })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default SecurityConfigForm;
