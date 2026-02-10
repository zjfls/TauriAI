/**
 * McpConfigForm Component
 * MCP servers + MCP sets management
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Plus, Trash2, RefreshCw, Loader2 } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import type {
  AppConfig,
  McpServerEntry,
  McpServerTransportConfig,
  McpSetConfig,
  McpSetServerConfig,
} from '../../types';

type McpToolInfo = { name: string; description?: string; inputSchema: unknown };
type McpResourceInfo = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};
type McpTestResult = {
  success: boolean;
  message: string;
  tools: McpToolInfo[];
  resources?: McpResourceInfo[];
  resourcesError?: string;
};
type ImportMode = 'merge_overwrite' | 'merge_skip' | 'replace';

const formatError = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
};

const defaultStdioTransport = (): McpServerTransportConfig => ({
  transport: 'stdio',
  command: '',
  args: [],
  envVars: [],
});

// Default timeouts (ms)
// - startupTimeoutMs: initialize + tools/list + resources/list
// - toolTimeoutMs: tools/call + resources/read
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 6_000;

const defaultServerEntry = (): McpServerEntry => ({
  name: `mcp_${Date.now()}`,
  config: {
    transport: defaultStdioTransport(),
    enabled: true,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    enabledTools: [],
    disabledTools: [],
    enabledResources: [],
    disabledResources: [],
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

const parseKeyValueLines = (text: string): Record<string, string> | undefined => {
  const entries: Array<[string, string]> = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const idx = eq >= 0 ? eq : colon;
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    entries.push([key, value]);
  }
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
};

const joinKeyValueLines = (obj?: Record<string, string>) => {
  if (!obj) return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
};

const randomId = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = typeof crypto !== 'undefined' ? crypto : null;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    // ignore
  }
  return `${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
};

const exampleClaudeMcpServersJson = `{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
      "env": {
        "ALLOWED_PATHS": "/Users/me/projects"
      }
    },
    "weather-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}`;

const exampleTauriAiMcpJson = `{
  "servers": [
    {
      "name": "mcp_filesystem",
      "config": {
        "enabled": true,
        "enabledTools": [],
        "disabledTools": [],
        "transport": {
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
          "envVars": ["HOME"],
          "env": { "ALLOWED_PATHS": "/Users/me/projects" },
          "cwd": "/Users/me"
        }
      }
    },
    {
      "name": "mcp_weather",
      "config": {
        "enabled": true,
        "enabledTools": [],
        "disabledTools": [],
        "transport": {
          "transport": "streamable_http",
          "url": "https://api.example.com/mcp",
          "httpHeaders": { "Authorization": "Bearer YOUR_TOKEN" }
        }
      }
    }
  ],
  "sets": []
}`;

export const McpConfigForm: React.FC = () => {
  const { config, saveConfigDebounced, flushConfigSaves } = useConfigStore();
  const [activeTab, setActiveTab] = useState<'servers' | 'sets' | 'diag' | 'import'>('servers');
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [diagServerName, setDiagServerName] = useState<string | null>(null);
  const [toolPreview, setToolPreview] = useState<McpToolInfo[] | null>(null);
  const [resourcePreview, setResourcePreview] = useState<McpResourceInfo[] | null>(null);
  const [inlineDiagByServerKey, setInlineDiagByServerKey] = useState<
    Record<
      string,
      {
        lastTest?: McpTestResult;
        lastTools?: McpToolInfo[];
        lastToolsSource?: 'test' | 'tools';
        lastResources?: McpResourceInfo[];
        lastResourcesSource?: 'test' | 'resources';
      }
    >
  >({});
  // UI-only collapsed state. IMPORTANT: key it by stable UI key (not server.name, which is editable).
  const [collapsedByServer, setCollapsedByServer] = useState<Record<string, boolean>>({});
  const [importJsonText, setImportJsonText] = useState<string>(exampleClaudeMcpServersJson);
  const [importMode, setImportMode] = useState<ImportMode>('merge_overwrite');
  const [importStatus, setImportStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // React key 稳定性：server/set 的 name 是可编辑字段，不能直接用作 key，
  // 否则每次改名都会 remount -> 输入框丢焦点。
  const serverUiKeyByNameRef = useRef<Map<string, string>>(new Map());
  const setUiKeyByNameRef = useRef<Map<string, string>>(new Map());
  // UI-only cache: keep last remote URL when switching transports (avoid wiping user input).
  // Keyed by server UI key (stable even if server name is edited).
  const lastRemoteUrlByServerUiKeyRef = useRef<Map<string, string>>(new Map());

  const getServerUiKey = useCallback((name: string) => {
    const map = serverUiKeyByNameRef.current;
    const existing = map.get(name);
    if (existing) return existing;
    const id = `mcp_server:${randomId()}`;
    map.set(name, id);
    return id;
  }, []);

  const getSetUiKey = useCallback((name: string) => {
    const map = setUiKeyByNameRef.current;
    const existing = map.get(name);
    if (existing) return existing;
    const id = `mcp_set:${randomId()}`;
    map.set(name, id);
    return id;
  }, []);

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

  const save = (updated: AppConfig) => saveConfigDebounced(updated);

  const updateMcp = (next: AppConfig['mcp']) => {
    save({ ...config, mcp: next });
  };

  const mcp = config.mcp;

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setImportStatus({ ok: true, message: '已复制到剪贴板' });
    } catch (e) {
      setImportStatus({ ok: false, message: `复制失败：${String(e)}` });
    }
  };

  const normalizeImport = (
    json: unknown
  ): { servers: McpServerEntry[]; sets: McpSetConfig[]; warnings: string[] } => {
    const warnings: string[] = [];

    const asRecord = (v: unknown): Record<string, unknown> | null =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

    const root = asRecord(json);
    if (!root) return { servers: [], sets: [], warnings: ['JSON 必须是一个对象'] };

    const maybeMcp = asRecord(root.mcp) ?? root;

    // Claude Desktop / SDK format: { mcpServers: { name: { type, command, args, env, url, headers } } }
    const mcpServers = asRecord(maybeMcp.mcpServers);
    if (mcpServers) {
      const servers: McpServerEntry[] = [];
      for (const [name, cfgUnknown] of Object.entries(mcpServers)) {
        const cfg = asRecord(cfgUnknown);
        if (!cfg) continue;

        const rawType =
          cfg.type ??
          cfg.transport ??
          (cfg.command ? 'stdio' : undefined) ??
          (cfg.url ? 'http' : undefined) ??
          '';
        const type = String(rawType)
          .trim()
          .replace(/([a-z])([A-Z])/g, '$1_$2')
          .replace(/-/g, '_')
          .toLowerCase();
        const enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled);
        const enabledTools = Array.isArray(cfg.enabledTools) ? cfg.enabledTools.map(String) : [];
        const disabledTools = Array.isArray(cfg.disabledTools) ? cfg.disabledTools.map(String) : [];

        if (type === 'stdio' || (!type && cfg.command)) {
          const command = String(cfg.command ?? '');
          const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
          const env = asRecord(cfg.env) as Record<string, unknown> | null;
          const envStr: Record<string, string> | undefined = env
            ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
            : undefined;
          const cwd = cfg.cwd ? String(cfg.cwd) : undefined;

          servers.push({
            name,
            config: {
              enabled,
              startupTimeoutMs: cfg.startupTimeoutMs ? Number(cfg.startupTimeoutMs) : undefined,
              toolTimeoutMs: cfg.toolTimeoutMs ? Number(cfg.toolTimeoutMs) : undefined,
              enabledTools,
              disabledTools,
              transport: {
                transport: 'stdio',
                command,
                args,
                env: envStr,
                envVars: [],
                cwd,
              },
            },
          });
          continue;
        }

        const url = String(cfg.url ?? '');
        const headers = (asRecord(cfg.headers) ?? asRecord(cfg.httpHeaders)) as Record<string, unknown> | null;
        const httpHeaders: Record<string, string> | undefined = headers
          ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]))
          : undefined;
        const envHttpHeadersRaw = asRecord(cfg.envHttpHeaders) as Record<string, unknown> | null;
        const envHttpHeaders: Record<string, string> | undefined = envHttpHeadersRaw
          ? Object.fromEntries(Object.entries(envHttpHeadersRaw).map(([k, v]) => [k, String(v)]))
          : undefined;

        // legacy: "http" / "streamable-http" => streamable_http
        if (type === 'http' || type === 'streamable_http' || type === 'streamable') {
          servers.push({
            name,
            config: {
              enabled,
              enabledTools,
              disabledTools,
              transport: {
                transport: 'streamable_http',
                url,
                httpHeaders,
                envHttpHeaders,
              },
            },
          });
          continue;
        }

        // legacy: "sse" => sse transport（注意：不是 streamable_http）
        if (type === 'sse') {
          servers.push({
            name,
            config: {
              enabled,
              enabledTools,
              disabledTools,
              transport: {
                transport: 'sse',
                url,
                httpHeaders,
                envHttpHeaders,
              },
            },
          });
          continue;
        }

        warnings.push(`忽略 server '${name}': 未识别的 type='${type || '(empty)'}'`);
      }
      return { servers, sets: [], warnings };
    }

    // Native format: { servers: McpServerEntry[], sets: McpSetConfig[] } or nested under { mcp: ... }
    const serversArr = Array.isArray(maybeMcp.servers) ? maybeMcp.servers : null;
    const setsArr = Array.isArray(maybeMcp.sets) ? maybeMcp.sets : null;
    if (!serversArr && !setsArr) {
      return { servers: [], sets: [], warnings: ['未找到 mcpServers / servers / sets'] };
    }

    const servers: McpServerEntry[] = [];
    if (serversArr) {
      for (const s of serversArr) {
        const entry = asRecord(s);
        if (!entry) continue;
        const name = String(entry.name ?? '').trim();
        const cfg = asRecord(entry.config);
        const transportRaw = cfg ? asRecord(cfg.transport) : null;
        const transportType = transportRaw ? String(transportRaw.transport ?? '').trim() : '';

        if (!name || !cfg || !transportRaw || !transportType) continue;

        if (transportType !== 'stdio' && transportType !== 'streamable_http' && transportType !== 'sse') {
          warnings.push(`server '${name}': 忽略未知 transport='${transportType}'`);
          continue;
        }

        const transport: McpServerTransportConfig =
          transportType === 'stdio'
            ? {
                transport: 'stdio',
                command: String(transportRaw.command ?? ''),
                args: Array.isArray(transportRaw.args) ? transportRaw.args.map(String) : [],
                env: transportRaw.env ? (transportRaw.env as Record<string, string>) : undefined,
                envVars: Array.isArray(transportRaw.envVars) ? transportRaw.envVars.map(String) : [],
                cwd: transportRaw.cwd ? String(transportRaw.cwd) : undefined,
              }
            : transportType === 'streamable_http'
              ? {
                  transport: 'streamable_http',
                  url: String(transportRaw.url ?? ''),
                  bearerTokenEnvVar: transportRaw.bearerTokenEnvVar ? String(transportRaw.bearerTokenEnvVar) : undefined,
                  httpHeaders: transportRaw.httpHeaders
                    ? (transportRaw.httpHeaders as Record<string, string>)
                    : undefined,
                  envHttpHeaders: transportRaw.envHttpHeaders
                    ? (transportRaw.envHttpHeaders as Record<string, string>)
                    : undefined,
                }
              : {
                  transport: 'sse',
                  url: String(transportRaw.url ?? ''),
                  bearerTokenEnvVar: transportRaw.bearerTokenEnvVar ? String(transportRaw.bearerTokenEnvVar) : undefined,
                  httpHeaders: transportRaw.httpHeaders
                    ? (transportRaw.httpHeaders as Record<string, string>)
                    : undefined,
                  envHttpHeaders: transportRaw.envHttpHeaders
                    ? (transportRaw.envHttpHeaders as Record<string, string>)
                    : undefined,
                };

        servers.push({
          name,
          config: {
            enabled: cfg.enabled === undefined ? true : Boolean(cfg.enabled),
            startupTimeoutMs: cfg.startupTimeoutMs ? Number(cfg.startupTimeoutMs) : undefined,
            toolTimeoutMs: cfg.toolTimeoutMs ? Number(cfg.toolTimeoutMs) : undefined,
            enabledTools: Array.isArray(cfg.enabledTools) ? cfg.enabledTools.map(String) : [],
            disabledTools: Array.isArray(cfg.disabledTools) ? cfg.disabledTools.map(String) : [],
            enabledResources: Array.isArray((cfg as any).enabledResources)
              ? ((cfg as any).enabledResources as unknown[]).map((x) => String(x))
              : [],
            disabledResources: Array.isArray((cfg as any).disabledResources)
              ? ((cfg as any).disabledResources as unknown[]).map((x) => String(x))
              : [],
            transport,
          },
        });
      }
    }

    const sets: McpSetConfig[] = [];
    if (setsArr) {
      for (const setUnknown of setsArr) {
        const set = asRecord(setUnknown);
        if (!set) continue;
        const name = String(set.name ?? '').trim();
        if (!name) continue;
        const serversList = Array.isArray(set.servers) ? set.servers : [];
        const nextServers: McpSetServerConfig[] = [];
        for (const ssUnknown of serversList) {
          const ss = asRecord(ssUnknown);
          if (!ss) continue;
          const server = String(ss.server ?? '').trim();
          if (!server) continue;
          nextServers.push({
            server,
            enabled: ss.enabled === undefined ? true : Boolean(ss.enabled),
            enabledTools: Array.isArray(ss.enabledTools) ? ss.enabledTools.map(String) : [],
            disabledTools: Array.isArray(ss.disabledTools) ? ss.disabledTools.map(String) : [],
          });
        }
        sets.push({ name, servers: nextServers });
      }
    }

    return { servers, sets, warnings };
  };

  const runImport = () => {
    setImportStatus(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importJsonText);
    } catch (e) {
      setImportStatus({ ok: false, message: `JSON 解析失败：${String(e)}` });
      return;
    }

    const normalized = normalizeImport(parsed);
    if (normalized.servers.length === 0 && normalized.sets.length === 0) {
      setImportStatus({
        ok: false,
        message: `没有可导入的数据。${normalized.warnings.length ? normalized.warnings[0] : ''}`.trim(),
      });
      return;
    }

    const existingServers = mcp.servers;
    const existingSets = mcp.sets;

    const nextServers =
      importMode === 'replace'
        ? normalized.servers
        : (() => {
            const map = new Map(existingServers.map((s) => [s.name, s] as const));
            for (const s of normalized.servers) {
              if (map.has(s.name) && importMode === 'merge_skip') continue;
              map.set(s.name, s);
            }
            return [...map.values()];
          })();

    const nextSets =
      importMode === 'replace'
        ? normalized.sets
        : (() => {
            const map = new Map(existingSets.map((s) => [s.name, s] as const));
            for (const s of normalized.sets) {
              if (map.has(s.name) && importMode === 'merge_skip') continue;
              map.set(s.name, s);
            }
            return [...map.values()];
          })();

    if (importMode === 'replace') {
      serverUiKeyByNameRef.current = new Map();
      setUiKeyByNameRef.current = new Map();
      setTestResult(null);
      setToolPreview(null);
      setCollapsedByServer({});
    }

    updateMcp({ ...mcp, servers: nextServers, sets: nextSets });

    const warnText = normalized.warnings.length ? `（警告：${normalized.warnings.slice(0, 2).join('；')}）` : '';
    setImportStatus({
      ok: true,
      message: `导入完成：servers ${normalized.servers.length}，sets ${normalized.sets.length} ${warnText}`.trim(),
    });
  };

  /**
   * Upsert server entry.
   * - 重要：当用户在“name 输入框”编辑名字时，必须按“旧名字”定位原条目并原地更新，
   *   否则会在每次 keystroke 里 push 新条目（严重 bug：越打越多配置）。
   */
  const upsertServer = (server: McpServerEntry, previousName?: string) => {
    const nextName = server.name.trim();
    if (!nextName) return;

    const prevName = (previousName ?? server.name).trim();
    const servers = [...mcp.servers];
    const prevIdx = prevName ? servers.findIndex((s) => s.name === prevName) : -1;

    if (prevIdx >= 0) {
      if (prevName !== nextName && servers.some((s, idx) => idx !== prevIdx && s.name === nextName)) {
        return;
      }

      // 保持输入框不丢焦点：把旧 key 迁移到新名字
      if (prevName && prevName !== nextName) {
        const map = serverUiKeyByNameRef.current;
        const existing = map.get(prevName);
        if (existing && !map.has(nextName)) map.set(nextName, existing);
        map.delete(prevName);

        setCollapsedByServer((prev) => {
          if (!(prevName in prev)) return prev;
          const next = { ...prev };
          next[nextName] = next[prevName];
          delete next[prevName];
          return next;
        });
      }

      servers[prevIdx] = { ...server, name: nextName };
      const sets =
        prevName && prevName !== nextName
          ? mcp.sets.map((set) => ({
              ...set,
              servers: set.servers.map((ss) => (ss.server === prevName ? { ...ss, server: nextName } : ss)),
            }))
          : mcp.sets;
      updateMcp({ ...mcp, servers, sets });
      return;
    }

    const idx = servers.findIndex((s) => s.name === nextName);
    if (idx >= 0) servers[idx] = { ...server, name: nextName };
    else servers.push({ ...server, name: nextName });
    updateMcp({ ...mcp, servers });
  };

  const deleteServer = (name: string) => {
    const uiKey = serverUiKeyByNameRef.current.get(name);
    serverUiKeyByNameRef.current.delete(name);
    setCollapsedByServer((prev) => {
      if (!uiKey || !(uiKey in prev)) return prev;
      const next = { ...prev };
      delete next[uiKey];
      return next;
    });
    const servers = mcp.servers.filter((s) => s.name !== name);
    const sets = mcp.sets.map((set) => ({
      ...set,
      servers: set.servers.filter((ss) => ss.server !== name),
    }));
    updateMcp({ ...mcp, servers, sets });
  };

  const upsertSet = (set: McpSetConfig, previousName?: string) => {
    const nextName = set.name.trim();
    if (!nextName) return;

    const prevName = (previousName ?? set.name).trim();
    const sets = [...mcp.sets];
    const prevIdx = prevName ? sets.findIndex((s) => s.name === prevName) : -1;

    if (prevIdx >= 0) {
      if (prevName !== nextName && sets.some((s, idx) => idx !== prevIdx && s.name === nextName)) {
        return;
      }

      if (prevName && prevName !== nextName) {
        const map = setUiKeyByNameRef.current;
        const existing = map.get(prevName);
        if (existing && !map.has(nextName)) map.set(nextName, existing);
        map.delete(prevName);
      }

      sets[prevIdx] = { ...set, name: nextName };
      // 同步 agent.mcpSet 引用，避免 rename 后 agent 仍指向旧 set 名
      const agents =
        prevName && prevName !== nextName
          ? config.agents.map((a) => (a.mcpSet === prevName ? { ...a, mcpSet: nextName } : a))
          : config.agents;
      save({ ...config, agents, mcp: { ...mcp, sets } });
      return;
    }

    const idx = sets.findIndex((s) => s.name === nextName);
    if (idx >= 0) sets[idx] = { ...set, name: nextName };
    else sets.push({ ...set, name: nextName });
    updateMcp({ ...mcp, sets });
  };

  const deleteSet = (name: string) => {
    setUiKeyByNameRef.current.delete(name);
    updateMcp({ ...mcp, sets: mcp.sets.filter((s) => s.name !== name) });
  };

  const isRemoteTransport = (
    t: McpServerTransportConfig
  ): t is Extract<McpServerTransportConfig, { transport: 'streamable_http' | 'sse' }> =>
    t.transport === 'streamable_http' || t.transport === 'sse';

  const sseDeprecatedMigration = useMemo(() => {
    if (!diagServerName || !testResult || testResult.success) return null;
    const entry = mcp.servers.find((s) => s.name === diagServerName);
    if (!entry) return null;
    const t = entry.config.transport;
    if (t.transport !== 'sse') return null;

    const msg = testResult.message || '';
    const isDeprecated =
      /sse transport is deprecated/i.test(msg) || /deprecated in favor of streamable http/i.test(msg);
    if (!isDeprecated) return null;

    const endpointMatch = msg.match(/\"endpoint\"\\s*:\\s*\"([^\"]+)\"/i);
    const endpoint = endpointMatch?.[1] ?? '/mcp';

    let nextUrl = '';
    try {
      nextUrl = new URL(endpoint, t.url).toString();
    } catch {
      // heuristic fallback
      nextUrl = t.url.replace(/\/sse\/?$/i, '/mcp');
    }
    if (!nextUrl) return null;

    return { entry, nextUrl };
  }, [diagServerName, mcp.servers, testResult]);

  const connectServer = async (name: string, serverUiKey: string) => {
    setDiagServerName(name);
    setTestingServer(name);
    setToolPreview(null);
    setResourcePreview(null);
    try {
      await flushConfigSaves();
      const res = await invoke<McpTestResult>('test_mcp_server', { serverName: name });
      setTestResult(res);
      setToolPreview(res.tools ?? []);
      setResourcePreview(res.resources ?? []);
      setInlineDiagByServerKey((prev) => ({
        ...prev,
        [serverUiKey]: {
          lastTest: res,
          lastTools: res.tools ?? [],
          lastToolsSource: 'test',
          lastResources: res.resources ?? [],
          lastResourcesSource: 'test',
        },
      }));

      // Persist the latest discovery results so the tool/resource list is still available after restart
      // (without needing to reconnect each time).
      if (res.success) {
        const now = Date.now();
        const latest = useConfigStore.getState().config;
        if (latest) {
          const servers = (latest.mcp?.servers ?? []).map((s) => {
            if (s.name !== name) return s;
            const prevCache = s.cache;
            return {
              ...s,
              cache: {
                updatedAtMs: now,
                tools: (res.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
                // Keep previous resources on resources/list failure so we don't wipe a good cache.
                resources: res.resourcesError
                  ? prevCache?.resources ?? []
                  : (res.resources ?? []).map((r) => ({
                      uri: r.uri,
                      name: r.name,
                      title: r.title,
                      description: r.description,
                      mimeType: r.mimeType,
                      size: r.size,
                    })),
              },
            };
          });
          save({ ...latest, mcp: { ...latest.mcp, servers } });
        }
      }
    } catch (e) {
      const err = { success: false, message: formatError(e), tools: [], resources: [] as McpResourceInfo[] };
      setTestResult(err);
      setToolPreview([]);
      setResourcePreview([]);
      setInlineDiagByServerKey((prev) => ({
        ...prev,
        [serverUiKey]: {
          lastTest: err,
          lastTools: [],
          lastToolsSource: 'test',
          lastResources: [],
          lastResourcesSource: 'test',
        },
      }));
    } finally {
      setTestingServer(null);
    }
  };

  const migrateSseToStreamableHttpAndRetest = async () => {
    const info = sseDeprecatedMigration;
    if (!info) return;
    const { entry, nextUrl } = info;
    const t = entry.config.transport;
    if (t.transport !== 'sse') return;

    upsertServer({
      ...entry,
      config: {
        ...entry.config,
        transport: {
          transport: 'streamable_http',
          url: nextUrl,
          bearerTokenEnvVar: t.bearerTokenEnvVar,
          httpHeaders: t.httpHeaders,
          envHttpHeaders: t.envHttpHeaders,
        },
      },
    });

    await connectServer(entry.name, getServerUiKey(entry.name));
  };

  const isToolEnabled = (enabled: string[], disabled: string[], name: string) => {
    if (enabled.length > 0) return enabled.includes(name) && !disabled.includes(name);
    return !disabled.includes(name);
  };

  const toggleToolEnabled = (enabled: string[], disabled: string[], name: string, nextEnabled: boolean) => {
    const nextDisabled = new Set(disabled);
    if (enabled.length > 0) {
      const nextAllow = new Set(enabled);
      if (nextEnabled) nextAllow.add(name);
      else nextAllow.delete(name);
      if (nextEnabled) nextDisabled.delete(name);
      return { enabledTools: Array.from(nextAllow), disabledTools: Array.from(nextDisabled) };
    }
    if (nextEnabled) nextDisabled.delete(name);
    else nextDisabled.add(name);
    return { enabledTools: enabled, disabledTools: Array.from(nextDisabled) };
  };

  const isResourceEnabled = (enabled: string[], disabled: string[], uri: string) => {
    if (enabled.length > 0) return enabled.includes(uri) && !disabled.includes(uri);
    return !disabled.includes(uri);
  };

  const toggleResourceEnabled = (enabled: string[], disabled: string[], uri: string, nextEnabled: boolean) => {
    const nextDisabled = new Set(disabled);
    if (enabled.length > 0) {
      const nextAllow = new Set(enabled);
      if (nextEnabled) nextAllow.add(uri);
      else nextAllow.delete(uri);
      if (nextEnabled) nextDisabled.delete(uri);
      return { enabledResources: Array.from(nextAllow), disabledResources: Array.from(nextDisabled) };
    }
    if (nextEnabled) nextDisabled.delete(uri);
    else nextDisabled.add(uri);
    return { enabledResources: enabled, disabledResources: Array.from(nextDisabled) };
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
          <button
            type="button"
            onClick={() => setActiveTab('import')}
            className={[
              'px-3 py-1.5 text-sm transition-colors border-l border-gray-200 dark:border-gray-700',
              activeTab === 'import'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
            ].join(' ')}
          >
            导入
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
            {mcp.servers.map((server) => {
              const serverUiKey = getServerUiKey(server.name);
              const collapsed = collapsedByServer[serverUiKey] ?? false;
              const toggleCollapsed = () =>
                setCollapsedByServer((prev) => ({ ...prev, [serverUiKey]: !(prev[serverUiKey] ?? false) }));
              const inlineDiag = inlineDiagByServerKey[serverUiKey];
              const cachedTools = server.cache?.tools ?? [];
              const cachedResources = server.cache?.resources ?? [];
              const toolsForList = inlineDiag?.lastTools?.length ? inlineDiag.lastTools : cachedTools;
              const resourcesForList = inlineDiag?.lastResources?.length ? inlineDiag.lastResources : cachedResources;
              const toolsSource = inlineDiag?.lastTools?.length
                ? inlineDiag.lastToolsSource
                : cachedTools.length
                  ? 'cache'
                  : undefined;
              const resourcesSource = inlineDiag?.lastResources?.length
                ? inlineDiag.lastResourcesSource
                : cachedResources.length
                  ? 'cache'
                  : undefined;
              const lastTest = inlineDiag?.lastTest;
              const resourcesListError = lastTest?.resourcesError;
              const showInlineDiag = Boolean(
                lastTest || toolsForList.length || resourcesForList.length
              );

              const transportSummary =
                server.config.transport.transport === 'stdio'
                  ? `${server.config.transport.command || '(command)'} ${server.config.transport.args.join(' ')}`
                  : server.config.transport.url || '(url)';

              return (
                <div
                  key={serverUiKey}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={toggleCollapsed}
                        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
                        title={collapsed ? '展开' : '收起'}
                      >
                        <ChevronDown
                          size={18}
                          className={[
                            'transition-transform duration-150',
                            collapsed ? '-rotate-90' : '',
                          ].join(' ')}
                        />
                      </button>
                      <input
                        className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm w-56"
                        value={server.name}
                        onChange={(e) => upsertServer({ ...server, name: e.target.value }, server.name)}
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
                        onClick={() => connectServer(server.name, serverUiKey)}
                        disabled={testingServer === server.name}
                        className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg flex items-center gap-1 disabled:opacity-60"
                        title="连接（initialize + tools/list + resources/list）"
                      >
                        {testingServer === server.name ? (
                          <>
                            <Loader2 size={16} className="animate-spin" />
                            连接中…
                          </>
                        ) : (
                          <>
                            <RefreshCw size={16} />
                            连接
                          </>
                        )}
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

                  {collapsed && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                      <span className="font-mono">{server.config.transport.transport}</span>
                      <span className="truncate flex-1 min-w-0">{transportSummary}</span>
                    </div>
                  )}

                  {!collapsed && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">Transport</label>
                    <select
                      value={server.config.transport.transport}
                      onChange={(e) => {
                        const t = e.target.value as McpServerTransportConfig['transport'];
                        const prev = server.config.transport;
                        if (isRemoteTransport(prev)) {
                          lastRemoteUrlByServerUiKeyRef.current.set(serverUiKey, prev.url);
                        }
                        if (t === 'stdio') {
                          upsertServer({ ...server, config: { ...server.config, transport: defaultStdioTransport() } });
                        } else if (t === 'streamable_http') {
                          const cachedUrl = lastRemoteUrlByServerUiKeyRef.current.get(serverUiKey) ?? '';
                          const url = isRemoteTransport(prev) ? prev.url : cachedUrl;
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              transport: {
                                transport: 'streamable_http',
                                url,
                                bearerTokenEnvVar: isRemoteTransport(prev) ? prev.bearerTokenEnvVar : undefined,
                                httpHeaders: isRemoteTransport(prev) ? prev.httpHeaders : undefined,
                                envHttpHeaders: isRemoteTransport(prev) ? prev.envHttpHeaders : undefined,
                              },
                            },
                          });
                        } else {
                          const cachedUrl = lastRemoteUrlByServerUiKeyRef.current.get(serverUiKey) ?? '';
                          const url = isRemoteTransport(prev) ? prev.url : cachedUrl;
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              transport: {
                                transport: 'sse',
                                url,
                                bearerTokenEnvVar: isRemoteTransport(prev) ? prev.bearerTokenEnvVar : undefined,
                                httpHeaders: isRemoteTransport(prev) ? prev.httpHeaders : undefined,
                                envHttpHeaders: isRemoteTransport(prev) ? prev.envHttpHeaders : undefined,
                              },
                            },
                          });
                        }
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                    >
                      <option value="stdio">stdio</option>
                      <option value="streamable_http">streamable_http</option>
                      <option value="sse">sse</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-xs text-gray-500">Timeout（ms）</label>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <div className="text-[11px] text-gray-500">
                          启动/列工具（startupTimeoutMs，默认 {DEFAULT_STARTUP_TIMEOUT_MS}）
                        </div>
                        <input
                          type="number"
                          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                          placeholder={String(DEFAULT_STARTUP_TIMEOUT_MS)}
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
                          title="用于 initialize + tools/list + resources/list 等启动阶段请求"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-[11px] text-gray-500">
                          工具调用（toolTimeoutMs，默认 {DEFAULT_TOOL_TIMEOUT_MS}）
                        </div>
                        <input
                          type="number"
                          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                          placeholder={String(DEFAULT_TOOL_TIMEOUT_MS)}
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
                          title="用于 tools/call + resources/read 等工具执行阶段请求"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {server.config.transport.transport === 'stdio' ? (
                  <div className="space-y-3">
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
                                  args: e.target.value
                                    .split(' ')
                                    .map((s) => s.trim())
                                    .filter(Boolean),
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

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">cwd（可选）</label>
                        <input
                          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                          value={server.config.transport.cwd ?? ''}
                          onChange={(e) => {
                            const t = server.config.transport;
                            if (t.transport !== 'stdio') return;
                            const cwd = e.target.value.trim();
                            upsertServer({
                              ...server,
                              config: {
                                ...server.config,
                                transport: {
                                  transport: 'stdio',
                                  command: t.command,
                                  args: t.args,
                                  env: t.env,
                                  envVars: t.envVars,
                                  cwd: cwd ? cwd : undefined,
                                },
                              },
                            });
                          }}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">envVars（透传宿主环境变量名）</label>
                        <textarea
                          className="w-full h-20 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                          value={joinLines(server.config.transport.envVars)}
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
                                  args: t.args,
                                  env: t.env,
                                  envVars: splitLines(e.target.value),
                                  cwd: t.cwd,
                                },
                              },
                            });
                          }}
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500">env（KEY=VALUE，每行一条）</label>
                      <textarea
                        className="w-full h-24 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                        value={joinKeyValueLines(server.config.transport.env)}
                        onChange={(e) => {
                          const t = server.config.transport;
                          if (t.transport !== 'stdio') return;
                          const env = parseKeyValueLines(e.target.value);
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              transport: {
                                transport: 'stdio',
                                command: t.command,
                                args: t.args,
                                env,
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
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500">
                        url{server.config.transport.transport === 'sse' ? '（SSE endpoint）' : ''}
                      </label>
                      <input
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                        value={server.config.transport.url}
                        onChange={(e) => {
                          const t = server.config.transport;
                          if (!isRemoteTransport(t)) return;
                          lastRemoteUrlByServerUiKeyRef.current.set(serverUiKey, e.target.value);
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              transport: {
                                transport: t.transport,
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

                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500">bearerTokenEnvVar（可选）</label>
                      <input
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                        value={server.config.transport.bearerTokenEnvVar ?? ''}
                        onChange={(e) => {
                          const t = server.config.transport;
                          if (!isRemoteTransport(t)) return;
                          const v = e.target.value.trim();
                          upsertServer({
                            ...server,
                            config: {
                              ...server.config,
                              transport: {
                                transport: t.transport,
                                url: t.url,
                                bearerTokenEnvVar: v ? v : undefined,
                                httpHeaders: t.httpHeaders,
                                envHttpHeaders: t.envHttpHeaders,
                              },
                            },
                          });
                        }}
                        placeholder="例如：MCP_BEARER_TOKEN"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">httpHeaders（Header=Value）</label>
                        <textarea
                          className="w-full h-24 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                          value={joinKeyValueLines(server.config.transport.httpHeaders)}
                          onChange={(e) => {
                            const t = server.config.transport;
                            if (!isRemoteTransport(t)) return;
                            const httpHeaders = parseKeyValueLines(e.target.value);
                            upsertServer({
                              ...server,
                              config: {
                                ...server.config,
                                transport: {
                                  transport: t.transport,
                                  url: t.url,
                                  bearerTokenEnvVar: t.bearerTokenEnvVar,
                                  httpHeaders,
                                  envHttpHeaders: t.envHttpHeaders,
                                },
                              },
                            });
                          }}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">envHttpHeaders（Header=ENV_VAR）</label>
                        <textarea
                          className="w-full h-24 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs font-mono"
                          value={joinKeyValueLines(server.config.transport.envHttpHeaders)}
                          onChange={(e) => {
                            const t = server.config.transport;
                            if (!isRemoteTransport(t)) return;
                            const envHttpHeaders = parseKeyValueLines(e.target.value);
                            upsertServer({
                              ...server,
                              config: {
                                ...server.config,
                                transport: {
                                  transport: t.transport,
                                  url: t.url,
                                  bearerTokenEnvVar: t.bearerTokenEnvVar,
                                  httpHeaders: t.httpHeaders,
                                  envHttpHeaders,
                                },
                              },
                            });
                          }}
                          placeholder="例如：Authorization=MCP_BEARER_TOKEN"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {showInlineDiag && (
                  <div
                    className={[
                      'rounded-lg border p-3',
                      lastTest
                        ? lastTest.success
                          ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-200'
                          : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200'
                        : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-200',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm">
                        {lastTest ? (
                          <>
                            <span className="font-medium">
                              {lastTest.success ? '连接成功' : '连接失败'}
                            </span>
                            <span className="ml-2 break-all">{lastTest.message}</span>
                          </>
                        ) : (
                          <span className="font-medium">
                            已缓存：tools/list {cachedTools.length}，resources/list {cachedResources.length}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="text-xs rounded px-2 py-1 bg-white/70 hover:bg-white dark:bg-black/10 dark:hover:bg-black/20"
                        onClick={() => {
                          setInlineDiagByServerKey((prev) => {
                            if (!(serverUiKey in prev)) return prev;
                            const next = { ...prev };
                            delete next[serverUiKey];
                            return next;
                          });
                          // Also clear persisted discovery cache for this server.
                          upsertServer({ ...server, cache: undefined });
                        }}
                        title="清除该 server 的最近结果（同时清空缓存的 tools/resources 列表）"
                      >
                        清除
                      </button>
                    </div>

                    {toolsForList.length ? (
                      <div className="mt-2">
                        <div className="text-xs opacity-80">
                          tools/list：{toolsForList.length} 个
                          {toolsSource
                            ? `（来源：${toolsSource === 'cache' ? '缓存' : toolsSource === 'test' ? '连接' : '工具'}）`
                            : ''}
                        </div>
                        <div className="mt-1 max-h-40 overflow-auto text-xs">
                          <ul className="space-y-1">
                            {toolsForList.map((t) => (
                              <li key={t.name} className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={isToolEnabled(server.config.enabledTools, server.config.disabledTools, t.name)}
                                  onChange={(e) => {
                                    const next = toggleToolEnabled(
                                      server.config.enabledTools,
                                      server.config.disabledTools,
                                      t.name,
                                      e.target.checked
                                    );
                                    upsertServer({ ...server, config: { ...server.config, ...next } });
                                  }}
                                />
                                <div className="min-w-0">
                                  <div className="font-mono break-all">{t.name}</div>
                                  {t.description ? (
                                    <div className="opacity-80 break-all">{t.description}</div>
                                  ) : null}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : lastTest?.success ? (
                      <div className="mt-2 text-xs opacity-80">
                        tools/list 为空（常见原因：server 本身不提供 tools，或 server 未正确启动/鉴权/URL 配置错误）。
                      </div>
                    ) : null}

                    {(lastTest || resourcesForList.length) ? (
                      <div className="mt-3">
                        <div className="text-xs opacity-80">
                          resources/list：{resourcesForList.length} 个
                          {resourcesSource
                            ? `（来源：${resourcesSource === 'cache' ? '缓存' : resourcesSource === 'test' ? '连接' : '资源'}）`
                            : ''}
                        </div>
                        {resourcesListError ? (
                          <div className="mt-1 text-xs opacity-90 break-all">
                            resources/list 错误：{resourcesListError}
                          </div>
                        ) : null}
                        {resourcesForList.length ? (
                          <div className="mt-1 max-h-40 overflow-auto text-xs">
                            <ul className="space-y-1">
                              {resourcesForList.map((r) => {
                                const enabledResources = server.config.enabledResources ?? [];
                                const disabledResources = server.config.disabledResources ?? [];
                                return (
                                  <li key={r.uri} className="flex items-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="mt-0.5"
                                      checked={isResourceEnabled(enabledResources, disabledResources, r.uri)}
                                      onChange={(e) => {
                                        const next = toggleResourceEnabled(
                                          enabledResources,
                                          disabledResources,
                                          r.uri,
                                          e.target.checked
                                        );
                                        upsertServer({
                                          ...server,
                                          config: {
                                            ...server.config,
                                            enabledResources: next.enabledResources,
                                            disabledResources: next.disabledResources,
                                          },
                                        });
                                      }}
                                    />
                                    <div className="min-w-0">
                                      <div className="font-mono break-all">{r.uri}</div>
                                      {(r.title || r.description) && (
                                        <div className="opacity-80 break-all">
                                          {r.title ? `${r.title}${r.description ? ' - ' : ''}` : ''}
                                          {r.description ?? ''}
                                        </div>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : lastTest?.success ? (
                          <div className="mt-1 text-xs opacity-80">resources/list 为空</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
                    </div>
                  )}
                </div>
              );
            })}
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
                key={getSetUiKey(set.name)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <input
                    className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm w-72"
                    value={set.name}
                    onChange={(e) => upsertSet({ ...set, name: e.target.value }, set.name)}
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

      {/* Import */}
      {activeTab === 'import' && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-800 dark:text-white">JSON 导入 / 导出</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setImportJsonText(exampleClaudeMcpServersJson);
                  setImportStatus(null);
                }}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg"
              >
                Claude 示例
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportJsonText(exampleTauriAiMcpJson);
                  setImportStatus(null);
                }}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg"
              >
                TauriAI 示例
              </button>
              <button
                type="button"
                onClick={() => copyText(JSON.stringify(config.mcp, null, 2))}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg"
                title="复制当前 MCP 配置（本项目格式）"
              >
                复制当前
              </button>
              <button
                type="button"
                onClick={() => copyText(importJsonText)}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg"
                title="复制输入框内容"
              >
                复制 JSON
              </button>
            </div>
          </div>

          <div className="text-xs text-gray-500 dark:text-gray-400">
            支持导入两种格式：1）Claude/SDK 的 <span className="font-mono">mcpServers</span>；2）本项目的{' '}
            <span className="font-mono">servers/sets</span>（可包在 <span className="font-mono">mcp</span> 下）。
          </div>

          <textarea
            className="w-full h-72 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-mono"
            value={importJsonText}
            onChange={(e) => setImportJsonText(e.target.value)}
            spellCheck={false}
          />

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-700 dark:text-gray-300">导入方式</label>
              <select
                value={importMode}
                onChange={(e) => setImportMode(e.target.value as ImportMode)}
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
              >
                <option value="merge_overwrite">合并（同名覆盖）</option>
                <option value="merge_skip">合并（同名跳过）</option>
                <option value="replace">替换全部</option>
              </select>
            </div>

            <button
              type="button"
              onClick={runImport}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg"
            >
              导入
            </button>
          </div>

          {importStatus && (
            <div
              className={[
                'text-sm rounded-lg border p-2',
                importStatus.ok
                  ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-200'
                  : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200',
              ].join(' ')}
            >
              {importStatus.message}
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
                setResourcePreview(null);
              }}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg"
            >
              清空
            </button>
          </div>

	          {testingServer && (
	            <div className="text-sm text-gray-600 dark:text-gray-300 flex items-center gap-2">
	              <Loader2 size={16} className="animate-spin" />
	              {`正在连接：${testingServer}`}
	            </div>
	          )}

	          {!testResult && !toolPreview && !resourcePreview && (
	            <div className="text-sm text-gray-500 dark:text-gray-400">
	              在 Servers 页点击“连接”后，这里会显示结果。
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
              {sseDeprecatedMigration ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <span>检测到 SSE 已弃用，建议切换为 streamable_http：</span>
                  <span className="font-mono break-all">{sseDeprecatedMigration.nextUrl}</span>
                  <button
                    type="button"
                    onClick={migrateSseToStreamableHttpAndRetest}
                    className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700"
                  >
                    一键切换并重试
                  </button>
                </div>
              ) : null}
              {testResult.tools.length > 0 && (
                <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                  tools: {testResult.tools.map((t) => t.name).join(', ')}
                </div>
              )}
              {testResult.resources?.length ? (
                <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                  resources: {testResult.resources.length} 个
                </div>
              ) : null}
              {testResult.resourcesError ? (
                <div className="mt-1 text-xs text-gray-600 dark:text-gray-300 break-all">
                  resources/list 错误：{testResult.resourcesError}
                </div>
              ) : null}
            </div>
          )}

          {resourcePreview && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                resources/list: {resourcePreview.length} 个
                {diagServerName ? `（${diagServerName}）` : ''}
              </div>
              <div className="mt-2 text-xs text-gray-600 dark:text-gray-300 max-h-48 overflow-auto">
                <ul className="list-disc ml-4">
                  {resourcePreview.map((r) => (
                    <li key={r.uri}>
                      <span className="font-mono">{r.uri}</span>
                      {r.title ? ` - ${r.title}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {toolPreview && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                tools/list: {toolPreview.length} 个
                {diagServerName ? `（${diagServerName}）` : ''}
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
        <p className="text-xs text-gray-500">
          提示：配置改动会自动保存；点击“连接”会在执行前自动同步保存到后端。
        </p>
      </div>
    </div>
  );
};
