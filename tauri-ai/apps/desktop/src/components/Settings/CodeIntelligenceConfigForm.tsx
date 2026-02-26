/**
 * CodeIntelligenceConfigForm
 * Configure LSP/AST settings for Workstudio
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { SHORTCUT_ACTIONS, detectShortcutPlatform, normalizeKeybindingString } from '../../shortcuts';
import { useConfigStore } from '../../stores/configStore';
import { lspDetectServer } from '../../services';
import type {
  AiCompletionQueueScope,
  AiCompletionSettings,
  AiCompletionTriggerMode,
  AppConfig,
  FolderAnalysisSettings,
  LspServerConfig,
  SymbolAnalysisSettings,
  ThinkingLevel,
} from '../../types';

const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}> = ({ checked, onChange, title }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    title={title}
  >
    <span
      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''
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

const defaultAiCompletionSettings = (): AiCompletionSettings => ({
  enabled: false,
  agentRef: '',
  chatWithAgentRef: '',
  inlineEnabled: true,
  listEnabled: true,
  triggerMode: 'hybrid',
  queueScope: 'global',
  debounceMs: 350,
  timeoutMs: 2500,
  maxTokens: 8192,
  temperature: 0.2,
  maxPrefixChars: 8000,
  maxSuffixChars: 2000,
  includeProjectContext: true,
  listSuggestionCount: 3,
});

const defaultSymbolAnalysisSettings = (): SymbolAnalysisSettings => ({
  enabled: false,
  agentRef: '',
  concurrency: 2,
  additionalAgents: [],
  bulkExcludeVariables: true,
  timeoutMs: 20000,
  maxTokens: 8192,
  temperature: 0.2,
  includeProjectContext: true,
});

const defaultFolderAnalysisSettings = (): FolderAnalysisSettings => ({
  enabled: false,
  agentRef: '',
  concurrency: 1,
  additionalAgents: [],
  timeoutMs: 30000,
  maxTokens: 8192,
  temperature: 0.2,
  includeProjectContext: true,
  maxDepth: 3,
  maxFiles: 200,
  maxTotalBytes: 5000000,
  includeHidden: false,
  ignoreGlobs: ['**/.git/**', '**/node_modules/**', '**/target/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.turbo/**'],
});

const AUTO_DETECT_LANGUAGE_ORDER = ['rust', 'python', 'go', 'cpp', 'c', 'lua'] as const;
const AUTO_DETECT_LANGUAGE_SET = new Set<string>(AUTO_DETECT_LANGUAGE_ORDER);
const AUTO_DETECT_LANGUAGE_LABEL: Record<string, string> = {
  rust: 'rust-analyzer',
  python: 'pyright-langserver',
  go: 'gopls',
  cpp: 'clangd',
  c: 'clangd',
  lua: 'lua-language-server',
};

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


  const aiCompletion: AiCompletionSettings = config?.codeIntelligence?.aiCompletion ?? defaultAiCompletionSettings();
  const symbolAnalysis: SymbolAnalysisSettings =
    config?.codeIntelligence?.symbolAnalysis ?? defaultSymbolAnalysisSettings();
  const folderAnalysis: FolderAnalysisSettings =
    config?.codeIntelligence?.folderAnalysis ?? defaultFolderAnalysisSettings();

  const getToolAgents = () => {
    const agents = config?.agents ?? [];
    return agents.filter((a) => (a.type === 'tool' || a.isSystem) && a.workspaceSupport === true);
  };
  const toolAgents = getToolAgents();

  const keyboardShortcuts = config?.general?.keyboardShortcuts;
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const aiSuggestShortcutLabel = useMemo(() => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === 'workstudio.triggerSuggest') ?? null;
    if (!def) return '';
    const userRaw =
      shortcutPlatform === 'mac'
        ? keyboardShortcuts?.mac?.['workstudio.triggerSuggest']
        : keyboardShortcuts?.windows?.['workstudio.triggerSuggest'];
    const raw = userRaw ?? (shortcutPlatform === 'mac' ? def.defaultMac : def.defaultWindows);
    return normalizeKeybindingString(String(raw || ''), shortcutPlatform) ?? '';
  }, [keyboardShortcuts, shortcutPlatform]);

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

  const updateAiCompletion = (updater: (s: AiCompletionSettings) => AiCompletionSettings) => {
    updateConfig((cfg) => {
      const prev = cfg.codeIntelligence?.aiCompletion ?? defaultAiCompletionSettings();
      return {
        ...cfg,
        codeIntelligence: { ...cfg.codeIntelligence, aiCompletion: updater(prev) },
      };
    });
  };

  const updateSymbolAnalysis = (updater: (s: SymbolAnalysisSettings) => SymbolAnalysisSettings) => {
    updateConfig((cfg) => {
      const prev = cfg.codeIntelligence?.symbolAnalysis ?? defaultSymbolAnalysisSettings();
      return {
        ...cfg,
        codeIntelligence: { ...cfg.codeIntelligence, symbolAnalysis: updater(prev) },
      };
    });
  };

  const updateFolderAnalysis = (updater: (s: FolderAnalysisSettings) => FolderAnalysisSettings) => {
    updateConfig((cfg) => {
      const prev = cfg.codeIntelligence?.folderAnalysis ?? defaultFolderAnalysisSettings();
      return {
        ...cfg,
        codeIntelligence: { ...cfg.codeIntelligence, folderAnalysis: updater(prev) },
      };
    });
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

  const deleteSelected = async () => {
    if (!selectedServer) return;
    const ok = await Promise.resolve(
      window.confirm(`确定删除该 LSP 配置吗？（${selectedServer.languageId || 'unknown'}）`)
    );
    if (!ok) return;
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
    if (!AUTO_DETECT_LANGUAGE_SET.has(lang)) {
      setAutoConfigError(`暂不支持该语言的一键探测：${lang}（支持：${AUTO_DETECT_LANGUAGE_ORDER.join(' / ')}）`);
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
      const label = AUTO_DETECT_LANGUAGE_LABEL[lang] ?? lang;
      setAutoConfigMessage(
        `已自动配置 ${label}：${foundCmd}${via ? `（via=${via}）` : ''}${warnings.length > 0 ? `；警告：${warnings.join(' | ')}` : ''}`
      );
    } catch (e) {
      setAutoConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoConfigBusy(false);
    }
  };

  const autoConfigureRecommendedFromEmpty = async () => {
    if (!config) return;
    if (servers.length !== 0) return;

    setAutoConfigBusy(true);
    setAutoConfigMessage(null);
    setAutoConfigError(null);
    try {
      const detected: LspServerConfig[] = [];
      const failures: string[] = [];

      for (const languageId of AUTO_DETECT_LANGUAGE_ORDER) {
        try {
          const res = await lspDetectServer({ languageId });
          const foundCmd = String(res?.command || '').trim();
          if (!foundCmd) {
            failures.push(`${languageId}: 返回 command 为空`);
            continue;
          }
          const recommendedArgs = Array.isArray(res?.args) ? res.args.map((x) => String(x || '').trim()).filter(Boolean) : [];
          detected.push({
            languageId,
            enabled: true,
            command: foundCmd,
            args: recommendedArgs,
            env: {},
            initializationOptions: {},
            settings: {},
          });
        } catch (e) {
          failures.push(`${languageId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (detected.length === 0) {
        setAutoConfigError(`未探测到可用语言服务器。${failures.length > 0 ? `失败详情：${failures.join(' | ')}` : ''}`);
        return;
      }

      const currentCi = config.codeIntelligence ?? { enabled: true, lspServers: [] };
      saveConfigDebounced(
        {
          ...config,
          codeIntelligence: {
            ...currentCi,
            enabled: true,
            lspServers: detected,
          },
        },
        0
      );

      setAutoConfigMessage(
        `已自动配置：${detected.map((s) => `${s.languageId}=${s.command}`).join('；')}`
      );
      if (failures.length > 0) {
        setAutoConfigError(`部分语言未探测成功：${failures.join(' | ')}`);
      }
      setSelectedIndex(0);
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
              <div>暂无 LSP 配置，点击右上角“新增”添加，或直接一键配置推荐语言（Rust/Python/Go/C++/Lua）。</div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void autoConfigureRecommendedFromEmpty()}
                  disabled={autoConfigBusy}
                  className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                  title="自动探测常见语言服务器并创建默认配置"
                >
                  {autoConfigBusy ? '配置中...' : '一键配置推荐语言'}
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
                className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${selectedIndex === it.idx
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
              这里配置 Workstudio 的代码智能能力：LSP（转到定义/引用/诊断等）与 AI Completion（幽灵补全 + 建议列表）。
            </p>
          </div>

          {/* LSP */}
          <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-white">LSP</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  用于控制 LSP 的部分功能开关，便于排查/调试 AI Completion。
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
              <div className="min-w-0">
                <div className="text-xs text-gray-500 dark:text-gray-400">Completion</div>
                <div className="text-sm text-gray-800 dark:text-gray-100">启用 LSP 建议列表</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  关闭后不会再向 LSP 请求 completion（仍保留 hover/跳转/诊断等能力）。
                </div>
              </div>
              <Toggle
                checked={config.codeIntelligence?.lspCompletionEnabled ?? true}
                onChange={(lspCompletionEnabled) =>
                  updateConfig((cfg) => ({
                    ...cfg,
                    codeIntelligence: { ...cfg.codeIntelligence, lspCompletionEnabled },
                  }))
                }
                title="是否启用 LSP completion 建议列表（用于调试 AI Completion）"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
              <div className="min-w-0">
                <div className="text-xs text-gray-500 dark:text-gray-400">Monaco</div>
                <div className="text-sm text-gray-800 dark:text-gray-100">启用本地词汇建议</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  关闭后 Suggest 列表不会再显示来自当前/已打开文件内容的词汇补全（不依赖 LSP）。
                </div>
              </div>
              <Toggle
                checked={config.codeIntelligence?.monacoWordSuggestionsEnabled ?? true}
                onChange={(monacoWordSuggestionsEnabled) =>
                  updateConfig((cfg) => ({
                    ...cfg,
                    codeIntelligence: { ...cfg.codeIntelligence, monacoWordSuggestionsEnabled },
                  }))
                }
                title="是否启用 Monaco 内置的词汇建议（用于调试 AI Completion）"
              />
            </div>
          </div>

          {/* AI Completion */}
          <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-white">AI Completion</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  幽灵补全（Inline）+ 建议列表（快捷键触发）。建议先选好模型再打开总开关。
                </div>
              </div>
              <Toggle
                checked={Boolean(aiCompletion.enabled)}
                onChange={(enabled) => updateAiCompletion((s) => ({ ...s, enabled }))}
                title="启用 AI 补全"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">代码补全：绑定智能体</label>
                <select
                  value={aiCompletion.agentRef ?? ''}
                  onChange={(e) => updateAiCompletion((s) => ({ ...s, agentRef: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="">（系统默认：代码补全）</option>
                  {toolAgents.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.displayName || opt.name} {opt.name.startsWith('__system_') ? '(系统)' : ''}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  用于幽灵补全和 Ctrl+Space 弹出的建议列表。
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">代码对话 (Chat With)：绑定智能体</label>
                <select
                  value={aiCompletion.chatWithAgentRef ?? ''}
                  onChange={(e) => updateAiCompletion((s) => ({ ...s, chatWithAgentRef: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="">（系统默认：代码对话）</option>
                  {toolAgents.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.displayName || opt.name} {opt.name.startsWith('__system_') ? '(系统)' : ''}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  用于编辑器内联对话（选中代码片段提问）。
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">触发模式</label>
                <select
                  value={(aiCompletion.triggerMode ?? 'hybrid') as AiCompletionTriggerMode}
                  onChange={(e) =>
                    updateAiCompletion((s) => ({ ...s, triggerMode: e.target.value as AiCompletionTriggerMode }))
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="hybrid">Hybrid（推荐：幽灵自动 + 列表手动）</option>
                  <option value="auto">Auto（幽灵自动）</option>
                  <option value="manual">Manual（仅手动触发）</option>
                </select>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  注意：建议列表只会在用户显式调用时请求 AI（避免打字时刷屏）。
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                <div className="min-w-0">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Inline</div>
                  <div className="text-sm text-gray-800 dark:text-gray-100">幽灵补全</div>
                </div>
                <Toggle
                  checked={Boolean(aiCompletion.inlineEnabled)}
                  onChange={(inlineEnabled) => updateAiCompletion((s) => ({ ...s, inlineEnabled }))}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                <div className="min-w-0">
                  <div className="text-xs text-gray-500 dark:text-gray-400">List</div>
                  <div className="text-sm text-gray-800 dark:text-gray-100">
                    AI 建议列表{aiSuggestShortcutLabel ? `（${aiSuggestShortcutLabel}）` : '（快捷键）'}
                  </div>
                </div>
                <Toggle
                  checked={Boolean(aiCompletion.listEnabled)}
                  onChange={(listEnabled) => updateAiCompletion((s) => ({ ...s, listEnabled }))}
                />
              </div>
            </div>

            <details className="rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                高级参数（延迟 / 超时 / Token / 上下文）
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">请求队列作用域</label>
                  <select
                    value={(aiCompletion.queueScope ?? 'global') as AiCompletionQueueScope}
                    onChange={(e) =>
                      updateAiCompletion((s) => ({ ...s, queueScope: e.target.value as AiCompletionQueueScope }))
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  >
                    <option value="global">Global（默认：全局单队列）</option>
                    <option value="language">Language（按语言队列，减少互相阻塞）</option>
                  </select>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    全局队列更省资源，但建议列表可能被正在进行的幽灵请求阻塞。
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">列表候选条数</label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={aiCompletion.listSuggestionCount ?? 3}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(1, Math.min(8, Math.floor(n))) : 3;
                      updateAiCompletion((s) => ({ ...s, listSuggestionCount: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">自动触发去抖（ms）</label>
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    value={aiCompletion.debounceMs ?? 350}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.floor(n))) : 350;
                      updateAiCompletion((s) => ({ ...s, debounceMs: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">超时（ms）</label>
                  <input
                    type="number"
                    min={200}
                    max={30000}
                    value={aiCompletion.timeoutMs ?? 2500}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(200, Math.min(30000, Math.floor(n))) : 2500;
                      updateAiCompletion((s) => ({ ...s, timeoutMs: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxTokens</label>
                  <input
                    type="number"
                    min={16}
                    max={32768}
                    value={aiCompletion.maxTokens ?? 8192}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(16, Math.min(32768, Math.floor(n))) : 8192;
                      updateAiCompletion((s) => ({ ...s, maxTokens: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">temperature</label>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={aiCompletion.temperature ?? 0.2}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0.2;
                      updateAiCompletion((s) => ({ ...s, temperature: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxPrefixChars</label>
                  <input
                    type="number"
                    min={0}
                    max={200000}
                    value={aiCompletion.maxPrefixChars ?? 8000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(200000, Math.floor(n))) : 8000;
                      updateAiCompletion((s) => ({ ...s, maxPrefixChars: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxSuffixChars</label>
                  <input
                    type="number"
                    min={0}
                    max={200000}
                    value={aiCompletion.maxSuffixChars ?? 2000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(200000, Math.floor(n))) : 2000;
                      updateAiCompletion((s) => ({ ...s, maxSuffixChars: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                <div className="min-w-0">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Context</div>
                  <div className="text-sm text-gray-800 dark:text-gray-100">发送项目上下文</div>
                </div>
                <Toggle
                  checked={Boolean(aiCompletion.includeProjectContext)}
                  onChange={(includeProjectContext) => updateAiCompletion((s) => ({ ...s, includeProjectContext }))}
                  title="允许把 projectRoot/filePath 等信息带给模型"
                />
              </div>
            </details>
          </div>

          {/* Symbol Analysis */}
          <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-white">符号分析</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Workstudio Outline 右键“分析类/函数/变量”等会发起大模型请求。建议先选好模型再打开总开关。
                </div>
              </div>
              <Toggle
                checked={Boolean(symbolAnalysis.enabled)}
                onChange={(enabled) => updateSymbolAnalysis((s) => ({ ...s, enabled }))}
                title="启用符号分析"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">绑定智能体</label>
                <select
                  value={symbolAnalysis.agentRef ?? ''}
                  onChange={(e) => updateSymbolAnalysis((s) => ({ ...s, agentRef: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="">（系统默认：符号分析）</option>
                  {toolAgents.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.displayName || opt.name} {opt.name.startsWith('__system_') ? '(系统)' : ''}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  指定处理符号分析的大模型（支持在智能体设置页添加自定义 Tool 智能体）。
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">并发上限</label>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={symbolAnalysis.concurrency ?? 2}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const next = Number.isFinite(n) ? Math.max(1, Math.min(64, Math.floor(n))) : 2;
                    updateSymbolAnalysis((s) => ({ ...s, concurrency: next }));
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                />
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  控制“默认绑定智能体”同时跑多少个符号分析任务；并发越大越快，但更占用模型/网络资源。
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-100">附加智能体（多模型 / 多并发）</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    可添加多个 Tool 智能体并分别设置并发上限；Workstudio 会在这些智能体之间调度，提升批量分析速度。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateSymbolAnalysis((s) => ({
                      ...s,
                      additionalAgents: [...(s.additionalAgents ?? []), { agentRef: '', concurrency: 1 }],
                    }))
                  }
                  className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                  title="新增一条附加智能体配置"
                >
                  <Plus size={14} />
                  新增
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {(symbolAnalysis.additionalAgents ?? []).length === 0 ? (
                  <div className="text-xs text-gray-500 dark:text-gray-400">（未配置附加智能体）</div>
                ) : (
                  (symbolAnalysis.additionalAgents ?? []).map((row, idx) => (
                    <div
                      key={`symbolAnalysis.additionalAgents:${idx}`}
                      className="grid grid-cols-1 gap-2 md:grid-cols-12 md:items-end"
                    >
                      <div className="md:col-span-7 space-y-1">
                        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">智能体</label>
                        <select
                          value={row.agentRef ?? ''}
                          onChange={(e) => {
                            const agentRef = e.target.value;
                            updateSymbolAnalysis((s) => {
                              const next = [...(s.additionalAgents ?? [])];
                              next[idx] = { ...(next[idx] ?? { agentRef: '', concurrency: 1 }), agentRef };
                              return { ...s, additionalAgents: next };
                            });
                          }}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        >
                          <option value="">（请选择）</option>
                          {toolAgents.map((opt) => (
                            <option key={opt.name} value={opt.name}>
                              {opt.displayName || opt.name} {opt.name.startsWith('__system_') ? '(系统)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="md:col-span-3 space-y-1">
                        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">并发</label>
                        <input
                          type="number"
                          min={1}
                          max={64}
                          value={row.concurrency ?? 1}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            const concurrency = Number.isFinite(n) ? Math.max(1, Math.min(64, Math.floor(n))) : 1;
                            updateSymbolAnalysis((s) => {
                              const next = [...(s.additionalAgents ?? [])];
                              next[idx] = { ...(next[idx] ?? { agentRef: '', concurrency: 1 }), concurrency };
                              return { ...s, additionalAgents: next };
                            });
                          }}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        />
                      </div>

                      <div className="md:col-span-2">
                        <button
                          type="button"
                          onClick={() =>
                            updateSymbolAnalysis((s) => ({
                              ...s,
                              additionalAgents: (s.additionalAgents ?? []).filter((_, i) => i !== idx),
                            }))
                          }
                          className="flex w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200 dark:hover:bg-red-900/30"
                          title="移除该附加智能体配置"
                        >
                          <Trash2 size={14} />
                          移除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
              <div className="min-w-0">
                <div className="text-xs text-gray-500 dark:text-gray-400">批量解析</div>
                <div className="text-sm text-gray-800 dark:text-gray-100">全部解析时跳过变量/字段</div>
                <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                  变量/字段数量可能很多；开启后“全部解析”只分析类/结构/函数等（不影响右键单个变量的分析）。
                </div>
              </div>
              <Toggle
                checked={symbolAnalysis.bulkExcludeVariables !== false}
                onChange={(bulkExcludeVariables) => updateSymbolAnalysis((s) => ({ ...s, bulkExcludeVariables }))}
                title="全部解析时跳过变量/字段"
              />
            </div>

            <details className="rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                高级参数（超时 / Token / 温度）
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">超时（ms）</label>
                  <input
                    type="number"
                    min={2000}
                    max={180000}
                    value={symbolAnalysis.timeoutMs ?? 20000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(2000, Math.min(180000, Math.floor(n))) : 20000;
                      updateSymbolAnalysis((s) => ({ ...s, timeoutMs: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxTokens</label>
                  <input
                    type="number"
                    min={256}
                    max={65536}
                    value={symbolAnalysis.maxTokens ?? 8192}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(256, Math.min(65536, Math.floor(n))) : 8192;
                      updateSymbolAnalysis((s) => ({ ...s, maxTokens: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">温度</label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={2}
                    value={symbolAnalysis.temperature ?? 0.2}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0.2;
                      updateSymbolAnalysis((s) => ({ ...s, temperature: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Context</div>
                    <div className="text-sm text-gray-800 dark:text-gray-100">发送项目上下文</div>
                  </div>
                  <Toggle
                    checked={Boolean(symbolAnalysis.includeProjectContext)}
                    onChange={(includeProjectContext) =>
                      updateSymbolAnalysis((s) => ({ ...s, includeProjectContext }))
                    }
                    title="是否在分析请求里包含 filePath / projectRoot 等信息"
                  />
                </div>
              </div>
            </details>
          </div>

          {/* Folder Analysis */}
          <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-white">文件夹分析</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Workstudio Explorer 右键“分析文件夹/重新分析/查看分析”等会发起大模型请求，并把结果落盘用于文件夹上色。
                </div>
              </div>
              <Toggle
                checked={Boolean(folderAnalysis.enabled)}
                onChange={(enabled) => updateFolderAnalysis((s) => ({ ...s, enabled }))}
                title="启用文件夹分析"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">绑定智能体</label>
                <select
                  value={folderAnalysis.agentRef ?? ''}
                  onChange={(e) => updateFolderAnalysis((s) => ({ ...s, agentRef: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="">（系统默认：文件夹分析）</option>
                  {toolAgents.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.displayName || opt.name} {opt.name.startsWith('__system_') ? '(系统)' : ''}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  指定处理“文件夹分析”的智能体（支持在智能体设置页添加自定义 Tool 智能体）。
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">并发上限</label>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={folderAnalysis.concurrency ?? 1}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const next = Number.isFinite(n) ? Math.max(1, Math.min(64, Math.floor(n))) : 1;
                    updateFolderAnalysis((s) => ({ ...s, concurrency: next }));
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                />
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  控制“默认绑定智能体”同时跑多少个文件夹分析任务；并发越大越快，但更占用模型/网络资源。
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">思考强度（可选）</label>
              <select
                value={String(folderAnalysis.thinkingLevel ?? '')}
                onChange={(e) => {
                  const v = String(e.target.value || '').trim();
                  const next: ThinkingLevel | undefined =
                    v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' ? (v as ThinkingLevel) : undefined;
                  updateFolderAnalysis((s) => ({ ...s, thinkingLevel: next }));
                }}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                <option value="">（无 / 默认）</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                用于 OpenAI Responses API 的 reasoning.effort；其它协议会按“有/无”做近似映射。
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-100">附加智能体（多模型 / 多并发）</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    可添加多个 Tool 智能体并分别设置并发上限；Workstudio 会在这些智能体之间调度，提升批量分析速度。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateFolderAnalysis((s) => ({
                      ...s,
                      additionalAgents: [...(s.additionalAgents ?? []), { agentRef: '', concurrency: 1 }],
                    }))
                  }
                  className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                  title="新增一条附加智能体配置"
                >
                  <Plus size={14} />
                  新增
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {(folderAnalysis.additionalAgents ?? []).length === 0 ? (
                  <div className="text-xs text-gray-500 dark:text-gray-400">（未配置附加智能体）</div>
                ) : (
                  (folderAnalysis.additionalAgents ?? []).map((row, idx) => (
                    <div
                      key={`folderAnalysis.additionalAgents:${idx}`}
                      className="grid grid-cols-1 gap-2 md:grid-cols-12 md:items-end"
                    >
                      <div className="md:col-span-7 space-y-1">
                        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">智能体</label>
                        <select
                          value={row.agentRef ?? ''}
                          onChange={(e) => {
                            const agentRef = e.target.value;
                            updateFolderAnalysis((s) => {
                              const next = [...(s.additionalAgents ?? [])];
                              next[idx] = { ...(next[idx] ?? { agentRef: '', concurrency: 1 }), agentRef };
                              return { ...s, additionalAgents: next };
                            });
                          }}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        >
                          <option value="">（请选择）</option>
                          {toolAgents.map((opt) => (
                            <option key={opt.name} value={opt.name}>
                              {opt.displayName || opt.name} {opt.name.startsWith('__system_') ? '(系统)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="md:col-span-3 space-y-1">
                        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">并发</label>
                        <input
                          type="number"
                          min={1}
                          max={64}
                          value={row.concurrency ?? 1}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            const concurrency = Number.isFinite(n) ? Math.max(1, Math.min(64, Math.floor(n))) : 1;
                            updateFolderAnalysis((s) => {
                              const next = [...(s.additionalAgents ?? [])];
                              next[idx] = { ...(next[idx] ?? { agentRef: '', concurrency: 1 }), concurrency };
                              return { ...s, additionalAgents: next };
                            });
                          }}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        />
                      </div>

                      <div className="md:col-span-2">
                        <button
                          type="button"
                          onClick={() =>
                            updateFolderAnalysis((s) => ({
                              ...s,
                              additionalAgents: (s.additionalAgents ?? []).filter((_, i) => i !== idx),
                            }))
                          }
                          className="flex w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200 dark:hover:bg-red-900/30"
                          title="移除该附加智能体配置"
                        >
                          <Trash2 size={14} />
                          移除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <details className="rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                高级参数（超时 / Token / 温度 / 采集限制）
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">超时（ms）</label>
                  <input
                    type="number"
                    min={2000}
                    max={180000}
                    value={folderAnalysis.timeoutMs ?? 30000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(2000, Math.min(180000, Math.floor(n))) : 30000;
                      updateFolderAnalysis((s) => ({ ...s, timeoutMs: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxTokens</label>
                  <input
                    type="number"
                    min={256}
                    max={65536}
                    value={folderAnalysis.maxTokens ?? 8192}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(256, Math.min(65536, Math.floor(n))) : 8192;
                      updateFolderAnalysis((s) => ({ ...s, maxTokens: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">温度</label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={2}
                    value={folderAnalysis.temperature ?? 0.2}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0.2;
                      updateFolderAnalysis((s) => ({ ...s, temperature: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Context</div>
                    <div className="text-sm text-gray-800 dark:text-gray-100">发送项目上下文</div>
                  </div>
                  <Toggle
                    checked={Boolean(folderAnalysis.includeProjectContext)}
                    onChange={(includeProjectContext) =>
                      updateFolderAnalysis((s) => ({ ...s, includeProjectContext }))
                    }
                    title="是否在分析请求里包含 projectRoot/workstudioMainFolder 等信息"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxDepth</label>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={folderAnalysis.maxDepth ?? 3}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(50, Math.floor(n))) : 3;
                      updateFolderAnalysis((s) => ({ ...s, maxDepth: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxFiles</label>
                  <input
                    type="number"
                    min={0}
                    max={20000}
                    value={folderAnalysis.maxFiles ?? 200}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(20000, Math.floor(n))) : 200;
                      updateFolderAnalysis((s) => ({ ...s, maxFiles: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">maxTotalBytes</label>
                  <input
                    type="number"
                    min={0}
                    max={500000000}
                    value={folderAnalysis.maxTotalBytes ?? 5000000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = Number.isFinite(n) ? Math.max(0, Math.min(500000000, Math.floor(n))) : 5000000;
                      updateFolderAnalysis((s) => ({ ...s, maxTotalBytes: next }));
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Hidden</div>
                    <div className="text-sm text-gray-800 dark:text-gray-100">包含隐藏文件</div>
                  </div>
                  <Toggle
                    checked={Boolean(folderAnalysis.includeHidden)}
                    onChange={(includeHidden) => updateFolderAnalysis((s) => ({ ...s, includeHidden }))}
                    title="是否允许分析时包含 . 开头的隐藏文件"
                  />
                </div>
              </div>

              <div className="mt-3 space-y-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">ignoreGlobs（每行一条）</label>
                <textarea
                  rows={5}
                  value={(folderAnalysis.ignoreGlobs ?? []).join('\n')}
                  onChange={(e) => {
                    const ignoreGlobs = parseLines(e.target.value);
                    updateFolderAnalysis((s) => ({ ...s, ignoreGlobs }));
                  }}
                  className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  placeholder="例如：**/node_modules/**"
                />
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  用于提示模型尽量忽略这些路径；不影响你手动在 Explorer 打开的文件。
                </div>
              </div>
            </details>
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
                    placeholder="rust / python / go / cpp / c / lua ..."
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
                      disabled={autoConfigBusy}
                      className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                      title="自动探测该语言服务器并填入绝对路径"
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
                  placeholder="rust-analyzer / pyright-langserver / pylsp / clangd / lua-language-server ..."
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
