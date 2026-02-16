/**
 * CodeIntelligenceConfigForm
 * Configure LSP/AST settings for Workstudio
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { useConfigStore } from '../../stores/configStore';
import { lspDetectServer } from '../../services';
import type { AppConfig, LspServerConfig } from '../../types';

const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}> = ({ checked, onChange, title }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 rounded-full transition-colors ${
      checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
    }`}
    title={title}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-5' : ''
      }`}
    />
  </button>
);

const parseLines = (text: string) =>
  text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

const envToLines = (env: Record<string, string>) =>
  Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

const parseEnvLines = (text: string): { env: Record<string, string>; errors: string[] } => {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  const lines = parseLines(text);
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx <= 0) {
      errors.push(`无效 env 行（缺少 KEY=VALUE）：${line}`);
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) {
      errors.push(`无效 env 行（KEY 为空）：${line}`);
      continue;
    }
    env[key] = value;
  }
  return { env, errors };
};

const safeStringify = (v: unknown) => {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return '{}';
  }
};

const defaultServer = (): LspServerConfig => ({
  languageId: 'rust',
  enabled: true,
  command: 'rust-analyzer',
  // rust-analyzer 默认使用 stdio 通信；无需 `--stdio`（部分版本会报 unknown flag）。
  args: [],
  env: {},
  initializationOptions: {},
  settings: {},
});

export const CodeIntelligenceConfigForm: React.FC = () => {
  const { config, saveConfigDebounced } = useConfigStore();
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  const [autoConfigBusy, setAutoConfigBusy] = useState(false);
  const [autoConfigMessage, setAutoConfigMessage] = useState<string | null>(null);
  const [autoConfigError, setAutoConfigError] = useState<string | null>(null);

  const [argsDraft, setArgsDraft] = useState('');
  const [envDraft, setEnvDraft] = useState('');
  const [initOptionsDraft, setInitOptionsDraft] = useState('');
  const [settingsDraft, setSettingsDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);

  const servers = config?.codeIntelligence?.lspServers ?? [];
  const selectedServer = servers[selectedIndex] ?? null;

  const save = (updated: AppConfig) => saveConfigDebounced(updated, 400);

  useEffect(() => {
    if (!config) return;
    if (servers.length === 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex < 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= servers.length) {
      setSelectedIndex(Math.max(0, servers.length - 1));
    }
  }, [config, servers.length, selectedIndex]);

  // Sync drafts when selection changes
  useEffect(() => {
    if (!selectedServer) {
      setArgsDraft('');
      setEnvDraft('');
      setInitOptionsDraft('{}');
      setSettingsDraft('{}');
      setJsonError(null);
      setEnvError(null);
      setAutoConfigMessage(null);
      setAutoConfigError(null);
      return;
    }
    setArgsDraft((selectedServer.args ?? []).join('\n'));
    setEnvDraft(envToLines(selectedServer.env ?? {}));
    setInitOptionsDraft(safeStringify(selectedServer.initializationOptions ?? {}));
    setSettingsDraft(safeStringify(selectedServer.settings ?? {}));
    setJsonError(null);
    setEnvError(null);
  }, [selectedServer?.languageId, selectedServer?.command, selectedServer?.enabled, selectedIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear one-click status when switching between server configs (avoid stale messages).
  useEffect(() => {
    setAutoConfigMessage(null);
    setAutoConfigError(null);
  }, [selectedIndex]);

  const serverLabels = useMemo(() => {
    return servers.map((s, idx) => {
      const lang = (s.languageId || '').trim() || '(未设置语言)';
      const cmd = (s.command || '').trim() || '(未设置命令)';
      const disabled = s.enabled ? '' : '（禁用）';
      return { idx, label: `${lang}${disabled}`, sub: cmd };
    });
  }, [servers]);

  if (!config) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const updateConfig = (updater: (cfg: AppConfig) => AppConfig) => {
    save(updater(config));
  };

  const updateServer = (idx: number, updater: (s: LspServerConfig) => LspServerConfig) => {
    const current = servers[idx];
    if (!current) return;
    const nextServers = servers.map((s, i) => (i === idx ? updater(s) : s));
    updateConfig((cfg) => ({
      ...cfg,
      codeIntelligence: { ...cfg.codeIntelligence, lspServers: nextServers },
    }));
  };

  const commitAdvancedDrafts = () => {
    if (!selectedServer) return;

    const envParsed = parseEnvLines(envDraft);
    if (envParsed.errors.length > 0) {
      setEnvError(envParsed.errors[0] ?? 'env 解析失败');
      return;
    }
    setEnvError(null);

    let initOptions: unknown = {};
    let settings: unknown = {};
    try {
      initOptions = JSON.parse(initOptionsDraft || '{}');
      settings = JSON.parse(settingsDraft || '{}');
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
      return;
    }
    setJsonError(null);

    const args = parseLines(argsDraft);

    updateServer(selectedIndex, (s) => ({
      ...s,
      args,
      env: envParsed.env,
      initializationOptions: initOptions,
      settings,
    }));
  };

  const addServer = () => {
    const created = defaultServer();
    updateConfig((cfg) => ({
      ...cfg,
      codeIntelligence: {
        ...cfg.codeIntelligence,
        lspServers: [...(cfg.codeIntelligence?.lspServers ?? []), created],
      },
    }));
    setSelectedIndex(servers.length);
  };

  const deleteSelected = () => {
    if (!selectedServer) return;
    if (!confirm(`确定删除该 LSP 配置吗？（${selectedServer.languageId || 'unknown'}）`)) return;
    const nextServers = servers.filter((_, i) => i !== selectedIndex);
    updateConfig((cfg) => ({
      ...cfg,
      codeIntelligence: { ...cfg.codeIntelligence, lspServers: nextServers },
    }));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
  };

  const autoConfigureSelected = async () => {
    if (!selectedServer) return;
    const lang = String(selectedServer.languageId || '').trim();
    if (!lang) {
      setAutoConfigError('languageId 为空');
      return;
    }
    if (lang !== 'rust') {
      setAutoConfigError(`暂仅支持 rust：${lang}`);
      return;
    }

    setAutoConfigBusy(true);
    setAutoConfigMessage(null);
    setAutoConfigError(null);
    try {
      const res = await lspDetectServer({ languageId: lang });
      const foundCmd = String(res?.command || '').trim();
      if (!foundCmd) {
        setAutoConfigError('未找到可执行文件（返回 command 为空）');
        return;
      }

      const recommendedArgs = Array.isArray(res?.args) ? res.args.map((x) => String(x || '').trim()).filter(Boolean) : [];

      updateServer(selectedIndex, (s) => {
        const existingArgs = Array.isArray(s.args) ? s.args : [];
        const nextArgs = existingArgs.length === 0 && recommendedArgs.length > 0 ? recommendedArgs : existingArgs;
        return { ...s, enabled: true, command: foundCmd, args: nextArgs };
      });

      // Keep drafts in sync so user can immediately看到变化。
      setArgsDraft((prev) => {
        const current = parseLines(prev);
        if (current.length === 0 && recommendedArgs.length > 0) {
          return recommendedArgs.join('\n');
        }
        return prev;
      });

      const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
      const via = String(res?.via || '').trim();
      setAutoConfigMessage(
        `已自动配置 rust-analyzer：${foundCmd}${via ? `（via=${via}）` : ''}${warnings.length > 0 ? `；警告：${warnings.join(' | ')}` : ''}`
      );
    } catch (e) {
      setAutoConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoConfigBusy(false);
    }
  };

  const autoConfigureRustFromEmpty = async () => {
    if (!config) return;
    if (servers.length !== 0) return;

    setAutoConfigBusy(true);
    setAutoConfigMessage(null);
    setAutoConfigError(null);
    try {
      const res = await lspDetectServer({ languageId: 'rust' });
      const foundCmd = String(res?.command || '').trim();
      if (!foundCmd) {
        setAutoConfigError('未找到可执行文件（返回 command 为空）');
        return;
      }

      const recommendedArgs = Array.isArray(res?.args) ? res.args.map((x) => String(x || '').trim()).filter(Boolean) : [];

      const nextServer: LspServerConfig = {
        languageId: 'rust',
        enabled: true,
        command: foundCmd,
        // rust-analyzer 默认使用 stdio 通信；无需 `--stdio`（部分版本会报 unknown flag）。
        args: recommendedArgs,
        env: {},
        initializationOptions: {},
        settings: {},
      };

      const currentCi = config.codeIntelligence ?? { enabled: true, lspServers: [] };
      saveConfigDebounced(
        {
          ...config,
          codeIntelligence: {
            ...currentCi,
            enabled: true,
            lspServers: [nextServer],
          },
        },
        0
      );

      const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
      const via = String(res?.via || '').trim();
      setAutoConfigMessage(
        `已自动配置 rust-analyzer：${foundCmd}${via ? `（via=${via}）` : ''}${warnings.length > 0 ? `；警告：${warnings.join(' | ')}` : ''}`
      );
    } catch (e) {
      setAutoConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoConfigBusy(false);
    }
  };

  const pickCommandForSelected = async () => {
    if (!selectedServer) return;
    setAutoConfigMessage(null);
    setAutoConfigError(null);

    const selected = await openDialog({ title: '选择 LSP 可执行文件', multiple: false, directory: false });
    if (!selected || Array.isArray(selected)) return;
    const command = String(selected || '').trim();
    if (!command) return;

    updateServer(selectedIndex, (s) => {
      const existingArgs = Array.isArray(s.args) ? s.args : [];
      return { ...s, enabled: true, command, args: existingArgs };
    });
    setAutoConfigMessage(`已选择命令：${command}`);
  };

  return (
    <div className="flex gap-6 h-full">
      {/* Left list */}
      <div className="w-72 flex-shrink-0 flex flex-col">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-800 dark:text-white">LSP 配置</div>
          <button
            type="button"
            onClick={addServer}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            title="新增一条 LSP 配置"
          >
            <Plus size={14} />
            新增
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
          <div className="min-w-0">
            <div className="text-xs text-gray-500 dark:text-gray-400">总开关</div>
            <div className="text-sm text-gray-800 dark:text-gray-100">启用代码智能</div>
          </div>
          <Toggle
            checked={config.codeIntelligence?.enabled ?? true}
            onChange={(enabled) =>
              updateConfig((cfg) => ({
                ...cfg,
                codeIntelligence: { ...cfg.codeIntelligence, enabled },
              }))
            }
          />
        </div>

        <div className="flex-1 space-y-1 overflow-auto">
          {serverLabels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 px-3 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <div>暂无 LSP 配置，点击右上角“新增”添加，或直接一键配置 rust-analyzer。</div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void autoConfigureRustFromEmpty()}
                  disabled={autoConfigBusy}
                  className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                  title="自动探测 rust-analyzer 并创建默认 Rust LSP 配置"
                >
                  {autoConfigBusy ? '配置中...' : '一键配置 Rust'}
                </button>
              </div>
              {autoConfigMessage && (
                <div className="mt-2 text-xs text-green-700 dark:text-green-300">{autoConfigMessage}</div>
              )}
              {autoConfigError && (
                <div className="mt-2 text-xs text-red-600 dark:text-red-300">{autoConfigError}</div>
              )}
            </div>
          ) : (
            serverLabels.map((it) => (
              <button
                key={it.idx}
                type="button"
                className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                  selectedIndex === it.idx
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
                onClick={() => setSelectedIndex(it.idx)}
              >
                <div className="truncate text-sm font-medium">{it.label}</div>
                <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{it.sub}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right editor */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl space-y-6">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-white">Code Intelligence</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              这里配置 Workstudio 的代码智能能力：后端启动 LSP 进程（stdio），前端 Monaco 通过 LSP 提供转到定义/引用等功能。
            </p>
          </div>

          {!selectedServer ? (
            <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
              请选择左侧一条 LSP 配置，或点击“新增”。
            </div>
          ) : (
            <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-white">LSP Server</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    修改后自动保存；高级字段建议在完成编辑后点击“应用高级配置”。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={deleteSelected}
                  className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200 dark:hover:bg-red-900/30"
                  title="删除该 LSP 配置"
                >
                  <Trash2 size={16} />
                  删除
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">启用</label>
                  <Toggle
                    checked={Boolean(selectedServer.enabled)}
                    onChange={(enabled) => updateServer(selectedIndex, (s) => ({ ...s, enabled }))}
                    title="是否启用该语言的 LSP"
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">语言 ID</label>
                  <input
                    type="text"
                    value={selectedServer.languageId ?? ''}
                    onChange={(e) => {
                      setAutoConfigMessage(null);
                      setAutoConfigError(null);
                      updateServer(selectedIndex, (s) => ({ ...s, languageId: e.target.value }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    placeholder="rust / python / cpp ..."
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">启动命令</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void pickCommandForSelected()}
                      disabled={autoConfigBusy}
                      className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                      title="选择 LSP 可执行文件（例如 rust-analyzer.exe）"
                    >
                      选择文件
                    </button>
                    <button
                      type="button"
                      onClick={() => void autoConfigureSelected()}
                      disabled={autoConfigBusy || String(selectedServer.languageId || '').trim() !== 'rust'}
                      className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                      title={String(selectedServer.languageId || '').trim() === 'rust' ? '自动探测 rust-analyzer 并填入绝对路径' : '暂仅支持 rust 一键配置'}
                    >
                      {autoConfigBusy ? '配置中...' : '一键配置'}
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={selectedServer.command ?? ''}
                  onChange={(e) => {
                    setAutoConfigMessage(null);
                    setAutoConfigError(null);
                    updateServer(selectedIndex, (s) => ({ ...s, command: e.target.value }));
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  placeholder="rust-analyzer / pylsp / clangd ..."
                />
                {autoConfigMessage && (
                  <div className="text-xs text-green-700 dark:text-green-300">{autoConfigMessage}</div>
                )}
                {autoConfigError && (
                  <div className="text-xs text-red-600 dark:text-red-300">{autoConfigError}</div>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">参数（每行一个）</label>
                <textarea
                  value={argsDraft}
                  onChange={(e) => setArgsDraft(e.target.value)}
                  className="min-h-[92px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  placeholder="（可留空；每行一个参数）"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">环境变量（每行 KEY=VALUE）</label>
                <textarea
                  value={envDraft}
                  onChange={(e) => setEnvDraft(e.target.value)}
                  className="min-h-[92px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  placeholder="RUSTUP_TOOLCHAIN=stable"
                />
                {envError && (
                  <div className="text-xs text-red-600 dark:text-red-300">{envError}</div>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">initializationOptions（JSON）</label>
                <textarea
                  value={initOptionsDraft}
                  onChange={(e) => setInitOptionsDraft(e.target.value)}
                  className="min-h-[120px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">settings（JSON，用于 workspace/configuration）</label>
                <textarea
                  value={settingsDraft}
                  onChange={(e) => setSettingsDraft(e.target.value)}
                  className="min-h-[140px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                />
                {jsonError && (
                  <div className="text-xs text-red-600 dark:text-red-300">{jsonError}</div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={commitAdvancedDrafts}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  title="解析并应用 args/env/JSON 配置"
                >
                  应用高级配置
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
