/**
 * McpConfigForm Component
 * MCP servers + MCP sets management
 */

import React, { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Trash2, RefreshCw, Save } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type {
  AppConfig,
  McpServerEntry,
  McpServerTransportConfig,
  McpSetConfig,
  McpSetServerConfig,
} from '../../types';

type McpToolInfo = { name: string; description?: string; inputSchema: unknown };
type McpTestResult = { success: boolean; message: string; tools: McpToolInfo[] };

const defaultStdioTransport = (): McpServerTransportConfig => ({
  transport: 'stdio',
  command: '',
  args: [],
  envVars: [],
});

const defaultServerEntry = (): McpServerEntry => ({
  name: `mcp_${Date.now()}`,
  config: {
    transport: defaultStdioTransport(),
    enabled: true,
    enabledTools: [],
    disabledTools: [],
  },
});

const defaultSet = (): McpSetConfig => ({
  name: `mcp_set_${Date.now()}`,
  servers: [],
});

const defaultSetServer = (server: string): McpSetServerConfig => ({
  server,
  enabled: true,
  enabledTools: [],
  disabledTools: [],
});

const joinLines = (lines: string[]) => lines.join('\n');
const splitLines = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

export const McpConfigForm: React.FC = () => {
  const { config, saveConfig } = useConfigStore();
  const [activeTab, setActiveTab] = useState<'servers' | 'sets' | 'diag'>('servers');
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [toolPreviewServer, setToolPreviewServer] = useState<string | null>(null);
  const [toolPreview, setToolPreview] = useState<McpToolInfo[] | null>(null);

  const serverNames = useMemo(
    () => (config?.mcp?.servers ?? []).map((s) => s.name),
    [config?.mcp?.servers]
  );

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500 dark:text-gray-400">加载配置中...</p>
      </div>
    );
  }

  const save = (updated: AppConfig) => saveConfig(updated);

  const updateMcp = (next: AppConfig['mcp']) => {
    save({ ...config, mcp: next });
  };

  const mcp = config.mcp;

  const upsertServer = (server: McpServerEntry) => {
    const name = server.name.trim();
    if (!name) return;
    const servers = [...mcp.servers];
    const idx = servers.findIndex((s) => s.name === name);
    if (idx >= 0) servers[idx] = { ...server, name };
    else servers.push({ ...server, name });
    updateMcp({ ...mcp, servers });
  };

  const deleteServer = (name: string) => {
    const servers = mcp.servers.filter((s) => s.name !== name);
    const sets = mcp.sets.map((set) => ({
      ...set,
      servers: set.servers.filter((ss) => ss.server !== name),
    }));
    updateMcp({ ...mcp, servers, sets });
  };

  const upsertSet = (set: McpSetConfig) => {
    const name = set.name.trim();
    if (!name) return;
    const sets = [...mcp.sets];
    const idx = sets.findIndex((s) => s.name === name);
    if (idx >= 0) sets[idx] = { ...set, name };
    else sets.push({ ...set, name });
    updateMcp({ ...mcp, sets });
  };

  const deleteSet = (name: string) => {
    updateMcp({ ...mcp, sets: mcp.sets.filter((s) => s.name !== name) });
  };

  const testServer = async (name: string) => {
    setTestingServer(name);
    setTestResult(null);
    try {
      const res = await invoke<McpTestResult>('test_mcp_server', { serverName: name });
      setTestResult(res);
    } catch (e) {
      setTestResult({ success: false, message: String(e), tools: [] });
    } finally {
      setTestingServer(null);
    }
  };

  const previewTools = async (name: string) => {
    setToolPreviewServer(name);
    setToolPreview(null);
    try {
      const tools = await invoke<McpToolInfo[]>('list_mcp_server_tools', { serverName: name });
      setToolPreview(tools);
    } catch (e) {
      setToolPreview([]);
      setTestResult({ success: false, message: String(e), tools: [] });
    } finally {
      setToolPreviewServer(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-white">MCP 设置</h2>
        <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setActiveTab('servers')}
            className={[
              'px-3 py-1.5 text-sm transition-colors',
              activeTab === 'servers'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
            ].join(' ')}
          >
            Servers（{mcp.servers.length}）
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sets')}
            className={[
              'px-3 py-1.5 text-sm transition-colors border-l border-gray-200 dark:border-gray-700',
              activeTab === 'sets'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
            ].join(' ')}
          >
            Sets（{mcp.sets.length}）
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('diag')}
            className={[
              'px-3 py-1.5 text-sm transition-colors border-l border-gray-200 dark:border-gray-700',
              activeTab === 'diag'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
            ].join(' ')}
          >
            调试
          </button>
        </div>
      </div>

      {/* Servers */}
      {activeTab === 'servers' && (
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-800 dark:text-white">MCP Servers</h3>
          <button
            onClick={() => upsertServer(defaultServerEntry())}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg flex items-center gap-1"
          >
            <Plus size={16} />
            添加
          </button>
        </div>

        {mcp.servers.length === 0 ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">暂无 MCP server</div>
        ) : (
          <div className="space-y-3">
            {mcp.servers.map((server) => (
              <div
                key={server.name}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm w-56"
                      value={server.name}
                      onChange={(e) => upsertServer({ ...server, name: e.target.value })}
                      placeholder="server name (a-zA-Z0-9_-)"
                    />
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={server.config.enabled}
                        onChange={(e) =>
                          upsertServer({ ...server, config: { ...server.config, enabled: e.target.checked } })
                        }
                      />
                      启用
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => previewTools(server.name)}
                      className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700 rounded-lg flex items-center gap-1"
                      title="拉取 tools/list"
                    >
                      <RefreshCw size={16} />
                      工具
                    </button>
                    <button
                      onClick={() => testServer(server.name)}
                      disabled={testingServer === server.name}
                      className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg flex items-center gap-1 disabled:opacity-60"
                      title="测试连接"
                    >
                      <RefreshCw size={16} />
                      测试
                    </button>
                    <button
                      onClick={() => deleteServer(server.name)}
                      className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg flex items-center gap-1"
                      title="删除"
                    >
                      <Trash2 size={16} />
                      删除
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">Transport</label>
                    <select
                      value={server.config.transport.transport}
                      onChange={(e) => {
                        const t = e.target.value as McpServerTransportConfig['transport'];
                        if (t === 'stdio') {
                          upsertServer({ ...server, config: { ...server.config, transport: defaultStdioTransport() } });
                        } else {
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              transport: { transport: 'streamable_http', url: '' },
                            },
                          });
                        }
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                    >
                      <option value="stdio">stdio</option>
                      <option value="streamable_http">streamable_http</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">Timeout（ms）</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                        placeholder="startupTimeoutMs"
                        value={server.config.startupTimeoutMs ?? ''}
                        onChange={(e) =>
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              startupTimeoutMs: e.target.value ? Number(e.target.value) : undefined,
                            },
                          })
                        }
                      />
                      <input
                        type="number"
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                        placeholder="toolTimeoutMs"
                        value={server.config.toolTimeoutMs ?? ''}
                        onChange={(e) =>
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              toolTimeoutMs: e.target.value ? Number(e.target.value) : undefined,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                </div>

                {server.config.transport.transport === 'stdio' ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500">command</label>
	                      <input
	                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
	                        value={server.config.transport.command}
	                        onChange={(e) => {
	                          const t = server.config.transport;
	                          if (t.transport !== 'stdio') return;
	                          upsertServer({
	                            ...server,
	                            config: {
	                              ...server.config,
	                              transport: {
	                                transport: 'stdio',
	                                command: e.target.value,
	                                args: t.args,
	                                env: t.env,
	                                envVars: t.envVars,
	                                cwd: t.cwd,
	                              },
	                            },
	                          });
	                        }}
	                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500">args（用空格分隔）</label>
	                      <input
	                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
	                        value={server.config.transport.args.join(' ')}
	                        onChange={(e) => {
	                          const t = server.config.transport;
	                          if (t.transport !== 'stdio') return;
	                          upsertServer({
	                            ...server,
	                            config: {
	                              ...server.config,
	                              transport: {
	                                transport: 'stdio',
	                                command: t.command,
	                                args: e.target.value.split(' ').map((s) => s.trim()).filter(Boolean),
	                                env: t.env,
	                                envVars: t.envVars,
	                                cwd: t.cwd,
	                              },
	                            },
	                          });
	                        }}
	                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">url</label>
	                    <input
	                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
	                      value={server.config.transport.url}
	                      onChange={(e) => {
	                        const t = server.config.transport;
	                        if (t.transport !== 'streamable_http') return;
	                        upsertServer({
	                          ...server,
	                          config: {
	                            ...server.config,
	                            transport: {
	                              transport: 'streamable_http',
	                              url: e.target.value,
	                              bearerTokenEnvVar: t.bearerTokenEnvVar,
	                              httpHeaders: t.httpHeaders,
	                              envHttpHeaders: t.envHttpHeaders,
	                            },
	                          },
	                        });
	                      }}
	                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">enabledTools（空=全部允许）</label>
                    <textarea
                      className="w-full h-24 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                      value={joinLines(server.config.enabledTools)}
                      onChange={(e) =>
                        upsertServer({
                          ...server,
                          config: { ...server.config, enabledTools: splitLines(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">disabledTools</label>
                    <textarea
                      className="w-full h-24 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                      value={joinLines(server.config.disabledTools)}
                      onChange={(e) =>
                        upsertServer({
                          ...server,
                          config: { ...server.config, disabledTools: splitLines(e.target.value) },
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Sets */}
      {activeTab === 'sets' && (
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-800 dark:text-white">MCP Sets</h3>
          <button
            onClick={() => upsertSet(defaultSet())}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg flex items-center gap-1"
          >
            <Plus size={16} />
            添加
          </button>
        </div>

        {mcp.sets.length === 0 ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">暂无 MCP set</div>
        ) : (
          <div className="space-y-3">
            {mcp.sets.map((set) => (
              <div
                key={set.name}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <input
                    className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm w-72"
                    value={set.name}
                    onChange={(e) => upsertSet({ ...set, name: e.target.value })}
                    placeholder="set name"
                  />
                  <button
                    onClick={() => deleteSet(set.name)}
                    className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg flex items-center gap-1"
                    title="删除"
                  >
                    <Trash2 size={16} />
                    删除
                  </button>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Servers</div>
                    <select
                      className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                      value=""
                      onChange={(e) => {
                        const server = e.target.value;
                        if (!server) return;
                        if (set.servers.some((s) => s.server === server)) return;
                        upsertSet({ ...set, servers: [...set.servers, defaultSetServer(server)] });
                      }}
                    >
                      <option value="">添加 server…</option>
                      {serverNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  {set.servers.length === 0 ? (
                    <div className="text-sm text-gray-500 dark:text-gray-400">该 set 暂未包含任何 server</div>
                  ) : (
                    <div className="space-y-3">
                      {set.servers.map((ss) => (
                        <div key={ss.server} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-medium text-gray-800 dark:text-white">{ss.server}</div>
                              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                <input
                                  type="checkbox"
                                  checked={ss.enabled}
                                  onChange={(e) => {
                                    const next = set.servers.map((x) =>
                                      x.server === ss.server ? { ...x, enabled: e.target.checked } : x
                                    );
                                    upsertSet({ ...set, servers: next });
                                  }}
                                />
                                启用
                              </label>
                            </div>
                            <button
                              onClick={() => {
                                const next = set.servers.filter((x) => x.server !== ss.server);
                                upsertSet({ ...set, servers: next });
                              }}
                              className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                            >
                              移除
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-3 mt-3">
                            <div className="space-y-1">
                              <label className="block text-xs text-gray-500">enabledTools（空=全部允许）</label>
                              <textarea
                                className="w-full h-20 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                                value={joinLines(ss.enabledTools)}
                                onChange={(e) => {
                                  const next = set.servers.map((x) =>
                                    x.server === ss.server ? { ...x, enabledTools: splitLines(e.target.value) } : x
                                  );
                                  upsertSet({ ...set, servers: next });
                                }}
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="block text-xs text-gray-500">disabledTools</label>
                              <textarea
                                className="w-full h-20 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                                value={joinLines(ss.disabledTools)}
                                onChange={(e) => {
                                  const next = set.servers.map((x) =>
                                    x.server === ss.server ? { ...x, disabledTools: splitLines(e.target.value) } : x
                                  );
                                  upsertSet({ ...set, servers: next });
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Diagnostics */}
      {activeTab === 'diag' && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-800 dark:text-white">调试</h3>
            <button
              onClick={() => {
                setTestResult(null);
                setToolPreview(null);
              }}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg"
            >
              清空
            </button>
          </div>

          {!testResult && !toolPreview && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              在 Servers 页点击“测试/工具”后，这里会显示结果。
            </div>
          )}

          {testResult && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <div className="text-sm">
                <span className={testResult.success ? 'text-green-600' : 'text-red-600'}>
                  {testResult.success ? '成功' : '失败'}
                </span>
                <span className="ml-2 text-gray-700 dark:text-gray-300">{testResult.message}</span>
              </div>
              {testResult.tools.length > 0 && (
                <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                  tools: {testResult.tools.map((t) => t.name).join(', ')}
                </div>
              )}
            </div>
          )}

          {toolPreview && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                tools/list: {toolPreview.length} 个
                {toolPreviewServer ? `（${toolPreviewServer}）` : ''}
              </div>
              <div className="mt-2 text-xs text-gray-600 dark:text-gray-300 max-h-48 overflow-auto">
                <ul className="list-disc ml-4">
                  {toolPreview.map((t) => (
                    <li key={t.name}>
                      <span className="font-mono">{t.name}</span>
                      {t.description ? ` - ${t.description}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={() => saveConfig(config)}
          className="px-3 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg flex items-center gap-2"
          title="保存当前配置"
        >
          <Save size={16} />
          保存配置
        </button>
        <p className="mt-2 text-xs text-gray-500">
          提示：测试连接/拉取工具会读取后端当前保存的配置；如果你刚编辑了配置，建议先点“保存配置”。
        </p>
      </div>
    </div>
  );
};
