import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wrench } from 'lucide-react';

import { probeExternalAgents } from '../../services/configService';
import { useConfigStore } from '../../stores/configStore';
import type {
  AppConfig,
  ExternalAgentConfig,
  ExternalAgentProbeInfo,
  ExternalAgentTransportType,
  ToolSetConfig,
} from '../../types';

const transportLabel: Record<ExternalAgentTransportType, string> = {
  headless: 'Headless',
  codex_cli: 'Codex CLI',
  claude_code: 'Claude Code',
};

const commandSourceLabel: Record<string, string> = {
  env: '环境变量',
  path: 'PATH',
  sidecar: 'Sidecar',
  missing: '未发现',
};

const createFallbackAgentConfig = (
  name: string,
  transportType: ExternalAgentTransportType = 'headless'
): ExternalAgentConfig => ({
  name,
  enabled: false,
  displayName: name,
  description: undefined,
  taskUsage: undefined,
  remoteAgentName: undefined,
  modelRef: undefined,
  runMode: undefined,
  thinking: undefined,
  defaultTimeoutMs: 120000,
  transport: {
    type: transportType,
    command: undefined,
    args: [],
    env: {},
    envVars: [],
    cwd: undefined,
  },
});

const normalizeAgentConfig = (agent: ExternalAgentConfig): ExternalAgentConfig => ({
  ...agent,
  enabled: agent.enabled ?? true,
  transport: {
    type: agent.transport?.type ?? 'headless',
    command: agent.transport?.command,
    args: agent.transport?.args ?? [],
    env: agent.transport?.env ?? {},
    envVars: agent.transport?.envVars ?? [],
    cwd: agent.transport?.cwd,
  },
});

const mergeAgentConfig = (
  base: ExternalAgentConfig,
  patch: Partial<ExternalAgentConfig>
): ExternalAgentConfig => ({
  ...base,
  ...patch,
  transport: {
    ...base.transport,
    ...(patch.transport ?? {}),
  },
});

interface SubAgentRow {
  name: string;
  probe?: ExternalAgentProbeInfo;
  config: ExternalAgentConfig;
}

const getRecommendedToolset = (toolsets: ToolSetConfig[]): ToolSetConfig | undefined =>
  toolsets.find((toolset) => toolset.name === '一般AGENT') ?? toolsets[0];

export const SubAgentConfigForm: React.FC = () => {
  const { config, saveConfig, saveConfigDebounced } = useConfigStore();
  const [probeResults, setProbeResults] = useState<ExternalAgentProbeInfo[]>([]);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState(false);

  const runProbe = async () => {
    setIsProbing(true);
    setProbeError(null);
    try {
      const result = await probeExternalAgents();
      setProbeResults(result);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsProbing(false);
    }
  };

  useEffect(() => {
    void runProbe();
  }, []);

  const configuredAgents = config?.externalAgents?.agents ?? [];
  const enabledAgents = useMemo(
    () =>
      (config?.agents ?? []).filter((agent) => agent.enabled !== false && agent.name !== '__practice__'),
    [config]
  );

  const rows = useMemo<SubAgentRow[]>(() => {
    const probeMap = new Map(probeResults.map((probe) => [probe.name, probe]));
    const knownRows = probeResults.map((probe) => {
      const configured = configuredAgents.find((agent) => agent.name === probe.name);
      return {
        name: probe.name,
        probe,
        config: normalizeAgentConfig(configured ?? probe.suggestedConfig),
      } satisfies SubAgentRow;
    });

    const extraRows = configuredAgents
      .filter((agent) => !probeMap.has(agent.name))
      .map((agent) => ({
        name: agent.name,
        config: normalizeAgentConfig(agent),
      } satisfies SubAgentRow));

    return [...knownRows, ...extraRows];
  }, [configuredAgents, probeResults]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const toolsets = config.tools?.toolsets ?? [];
  const recommendedToolset = getRecommendedToolset(toolsets);
  const hasAgentRunTool = toolsets.some((toolset) => toolset.tools.includes('agent_run'));
  const hasAgentSessionTool = toolsets.some((toolset) => toolset.tools.includes('agent_session'));

  const commitConfig = (updatedConfig: AppConfig, immediate = false) => {
    if (immediate) {
      void saveConfig(updatedConfig);
      return;
    }
    saveConfigDebounced(updatedConfig);
  };

  const updateExternalAgent = (
    name: string,
    updater: (agent: ExternalAgentConfig) => ExternalAgentConfig,
    immediate = false
  ) => {
    const existingAgents = config.externalAgents?.agents ?? [];
    const row = rows.find((item) => item.name === name);
    const base = normalizeAgentConfig(
      existingAgents.find((agent) => agent.name === name) ??
        row?.probe?.suggestedConfig ??
        row?.config ??
        createFallbackAgentConfig(name)
    );
    const nextAgent = normalizeAgentConfig(updater(base));
    const nextAgents = existingAgents.some((agent) => agent.name === name)
      ? existingAgents.map((agent) => (agent.name === name ? nextAgent : agent))
      : [...existingAgents, nextAgent];

    commitConfig(
      {
        ...config,
        externalAgents: {
          agents: nextAgents,
        },
      },
      immediate
    );
  };

  const enableExternalAgentTools = () => {
    if (!recommendedToolset) return;
    const nextToolsets = toolsets.map((toolset) => {
      if (toolset.name !== recommendedToolset.name) {
        return toolset;
      }
      return {
        ...toolset,
        tools: Array.from(new Set([...toolset.tools, 'agent_run', 'agent_session'])),
      };
    });
    void saveConfig({
      ...config,
      tools: {
        ...config.tools,
        toolsets: nextToolsets,
      },
    });
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">子agent</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              管理可被父 Agent 调用的外部程序。启用后，模型可通过
              <code className="mx-1 font-mono">agent_run</code>
              与
              <code className="mx-1 font-mono">agent_session</code>
              使用这些程序。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={isProbing}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isProbing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            一键探知环境
          </button>
        </div>
        {probeError ? (
          <div className="mt-3 flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{probeError}</span>
          </div>
        ) : null}
      </div>

      {(!hasAgentRunTool || !hasAgentSessionTool) && recommendedToolset ? (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
          <div className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">当前 toolset 还没有完整暴露子agent工具</div>
              <div>
                推荐把
                <code className="mx-1 font-mono">agent_run</code>
                与
                <code className="mx-1 font-mono">agent_session</code>
                加入
                <code className="mx-1 font-mono">{recommendedToolset.name}</code>
                。
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={enableExternalAgentTools}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            <Wrench size={16} />
            补齐推荐 toolset
          </button>
        </div>
      ) : null}

      <div className="space-y-4">
        {rows.map((row) => {
          const agent = row.config;
          const probe = row.probe;
          const commandPlaceholder = probe?.commandPath || '留空表示自动探测';
          const isHeadless = agent.transport.type === 'headless';
          const detectWarning = agent.enabled && !probe?.detected && !agent.transport.command;

          return (
            <div
              key={row.name}
              className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                      {agent.displayName || row.name}
                    </h4>
                    <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                      {transportLabel[agent.transport.type]}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        probe?.detected
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {probe?.detected ? '已探测' : '未探测'}
                    </span>
                    {probe?.sessionMode ? (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        {probe.sessionMode === 'native' ? '原生会话' : '回放会话'}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-300 break-all">
                    <div>
                      调用名：<code className="font-mono">{row.name}</code>
                    </div>
                    <div>
                      程序：<code className="font-mono">{probe?.programName || agent.transport.command || row.name}</code>
                      {probe ? (
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                          来源：{commandSourceLabel[probe.commandSource] ?? probe.commandSource}
                        </span>
                      ) : null}
                    </div>
                    {probe?.commandPath ? (
                      <div>探测路径：<code className="font-mono">{probe.commandPath}</code></div>
                    ) : null}
                    {probe?.version ? <div>版本：{probe.version}</div> : null}
                    {agent.description ? <div>{agent.description}</div> : null}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    updateExternalAgent(
                      row.name,
                      (current) => {
                        const defaultHeadlessTarget =
                          current.remoteAgentName || config.defaultAgent || enabledAgents[0]?.name;
                        return mergeAgentConfig(current, {
                          enabled: !current.enabled,
                          remoteAgentName:
                            current.transport.type === 'headless'
                              ? defaultHeadlessTarget
                              : current.remoteAgentName,
                        });
                      },
                      true
                    );
                  }}
                  className={`relative inline-flex w-12 h-7 rounded-full transition-colors ${
                    agent.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                  title={agent.enabled ? '已启用' : '已禁用'}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${
                      agent.enabled ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </div>

              {detectWarning ? (
                <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                  <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                  <span>当前未探测到该程序，且没有填写自定义命令路径；启用后调用很可能直接失败。</span>
                </div>
              ) : probe?.detected ? (
                <div className="flex items-start gap-2 text-sm text-green-700 dark:text-green-300 rounded-lg bg-green-50 dark:bg-green-950/30 px-3 py-2">
                  <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
                  <span>
                    该程序已可调用，支持
                    {probe.supportsRun ? '单次调用' : '—'}
                    {probe.supportsSession ? ' / 持久会话' : ''}。
                  </span>
                </div>
              ) : null}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {isHeadless ? (
                  <label className="space-y-1 md:col-span-2">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      委托到的 TauriAI 智能体
                    </span>
                    <select
                      value={agent.remoteAgentName ?? ''}
                      onChange={(event) => {
                        const value = event.target.value.trim() || undefined;
                        updateExternalAgent(
                          row.name,
                          (current) => mergeAgentConfig(current, { remoteAgentName: value }),
                          true
                        );
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                    >
                      <option value="">请选择</option>
                      {enabledAgents.map((enabledAgent) => (
                        <option key={enabledAgent.name} value={enabledAgent.name}>
                          {enabledAgent.displayName} ({enabledAgent.name})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label className="space-y-1">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    自定义命令路径
                  </span>
                  <input
                    type="text"
                    value={agent.transport.command ?? ''}
                    onChange={(event) => {
                      const value = event.target.value.trim() || undefined;
                      updateExternalAgent(
                        row.name,
                        (current) =>
                          mergeAgentConfig(current, {
                            transport: {
                              ...current.transport,
                              command: value,
                            },
                          })
                      );
                    }}
                    placeholder={commandPlaceholder}
                    autoCorrect="off"
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                  />
                </label>

                <label className="space-y-1">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    默认模型
                  </span>
                  <input
                    type="text"
                    value={agent.modelRef ?? ''}
                    onChange={(event) => {
                      const value = event.target.value.trim() || undefined;
                      updateExternalAgent(
                        row.name,
                        (current) => mergeAgentConfig(current, { modelRef: value })
                      );
                    }}
                    placeholder={agent.transport.type === 'claude_code' ? '例如：sonnet' : '留空表示使用程序默认模型'}
                    autoCorrect="off"
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                  />
                </label>

                {isHeadless ? (
                  <label className="space-y-1">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      默认 run_mode
                    </span>
                    <input
                      type="text"
                      value={agent.runMode ?? ''}
                      onChange={(event) => {
                        const value = event.target.value.trim() || undefined;
                        updateExternalAgent(
                          row.name,
                          (current) => mergeAgentConfig(current, { runMode: value })
                        );
                      }}
                      placeholder="例如：chat / agent-custom"
                      autoCorrect="off"
                      autoCapitalize="off"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                    />
                  </label>
                ) : null}

                <label className="space-y-1">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    默认超时（毫秒）
                  </span>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={agent.defaultTimeoutMs ?? 120000}
                    onChange={(event) => {
                      const raw = Number(event.target.value);
                      const value = Number.isFinite(raw) && raw > 0 ? raw : 120000;
                      updateExternalAgent(
                        row.name,
                        (current) => mergeAgentConfig(current, { defaultTimeoutMs: value })
                      );
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SubAgentConfigForm;
