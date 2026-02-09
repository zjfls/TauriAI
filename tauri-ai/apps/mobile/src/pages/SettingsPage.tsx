import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isTauriRuntime, tauriInvoke } from "../lib/tauri";
import { Bot, Palette, Plug, Server, Shield, Sliders, Sparkles, Wrench } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ModelPickerModal } from "../ui/ModelPickerModal";
import { SecretInput } from "../ui/SecretInput";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { loadChatRenderMode, saveChatRenderMode, type ChatRenderMode } from "../lib/chatRenderPrefs";

type ProviderType =
  | "openai"
  | "openai_compatible"
  | "openai_responses"
  | "anthropic"
  | "google"
  | "ollama";

type AppConfig = any;

type ModelDraft = {
  name: string;
  originalName: string;
  temperature: number;
  temperatureEnabled: boolean;
  maxTokens: number | null;
  topP: number | null;
  topPEnabled: boolean;
  capabilities: Record<string, unknown>;
};

type ProviderDraft = {
  name: string;
  originalName: string;
  displayName: string;
  type: ProviderType;
  apiBase: string;
  apiKey: string;
  enabled: boolean;
  models: ModelDraft[];
};

type AgentType = "chat" | "tool";

type AgentDraft = {
  name: string;
  originalName: string;
  displayName: string;
  description?: string;
  enabled?: boolean;
  type?: AgentType;
  modelRef: string;
  systemPrompt?: string;
};

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function buildDefaultModel(name: string): ModelDraft {
  return {
    name,
    originalName: name,
    temperature: 0.7,
    temperatureEnabled: true,
    maxTokens: null,
    topP: null,
    topPEnabled: true,
    capabilities: {},
  };
}

function ensureProvidersDraft(providers: any[]): ProviderDraft[] {
  const list = Array.isArray(providers) ? providers : [];
  return list
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      const models: unknown[] = Array.isArray(p.models) ? (p.models as unknown[]) : [];
      const name = String(p.name ?? "").trim() || newId("provider");
      return {
        name,
        originalName: name,
        displayName: String(p.displayName ?? p.name ?? "").trim() || "Provider",
        type: (p.type as ProviderType) ?? "openai_compatible",
        apiBase: String(p.apiBase ?? "").trim(),
        apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
        enabled: typeof p.enabled === "boolean" ? p.enabled : true,
        models: models
          .filter((m: unknown) => m && typeof m === "object")
          .map((m: any) => {
            const modelName = String(m?.name ?? "").trim();
            return {
              name: modelName,
              originalName: modelName,
            temperature: typeof m?.temperature === "number" ? m.temperature : 0.7,
            temperatureEnabled:
              typeof m?.temperatureEnabled === "boolean" ? m.temperatureEnabled : true,
            maxTokens: typeof m?.maxTokens === "number" ? m.maxTokens : null,
            topP: typeof m?.topP === "number" ? m.topP : null,
            topPEnabled: typeof m?.topPEnabled === "boolean" ? m.topPEnabled : true,
            capabilities: (m?.capabilities as Record<string, unknown>) ?? {},
            } satisfies ModelDraft;
          })
          .filter((m: ModelDraft) => m.name),
      } satisfies ProviderDraft;
    })
    .filter((p) => p.name);
}

function parseModelRef(modelRef: string | undefined | null): { provider: string; model: string } | null {
  const v = String(modelRef ?? "").trim();
  if (!v) return null;
  const idx = v.indexOf("/");
  if (idx <= 0) return null;
  const provider = v.slice(0, idx).trim();
  const model = v.slice(idx + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

export function SettingsPage() {
  const [status, setStatus] = useState<string>("未加载");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [chatRenderMode, setChatRenderMode] = useState<ChatRenderMode>(() => loadChatRenderMode());

  type SettingsTab =
    | "providers"
    | "agents"
    | "tools"
    | "mcp"
    | "skills"
    | "security"
    | "appearance"
    | "general";

  const tabs: Array<{ id: SettingsTab; icon: ReactNode; label: string }> = [
    { id: "providers", icon: <Server size={16} />, label: "提供商" },
    { id: "agents", icon: <Bot size={16} />, label: "智能体" },
    { id: "tools", icon: <Wrench size={16} />, label: "工具" },
    { id: "mcp", icon: <Plug size={16} />, label: "MCP" },
    { id: "skills", icon: <Sparkles size={16} />, label: "Skills" },
    { id: "security", icon: <Shield size={16} />, label: "安全" },
    { id: "appearance", icon: <Palette size={16} />, label: "外观" },
    { id: "general", icon: <Sliders size={16} />, label: "通用" },
  ];

  const [providers, setProviders] = useState<ProviderDraft[]>([
    {
      name: "default",
      originalName: "default",
      displayName: "Default",
      type: "openai_compatible",
      apiBase: "https://api.openai.com/v1",
      apiKey: "",
      enabled: true,
      models: [buildDefaultModel("gpt-4o-mini")],
    },
  ]);
  const [activeProviderName, setActiveProviderName] = useState<string>("default");
  const [activeModelName, setActiveModelName] = useState<string>("gpt-4o-mini");
  const [newModelName, setNewModelName] = useState<string>("");

  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [activeAgentName, setActiveAgentName] = useState<string>("");
  const [defaultAgentName, setDefaultAgentName] = useState<string>("");

  const [showModelPicker, setShowModelPicker] = useState(false);

  const runtime = useMemo(() => (isTauriRuntime() ? "Tauri" : "Web"), []);

  const [view, setView] = useState<"home" | SettingsTab>(() => {
    try {
      const v = localStorage.getItem("tauri_ai_mobile_settings_view");
      if (v && tabs.some((t) => t.id === v)) return v as SettingsTab;
    } catch {
      // ignore
    }
    return "home";
  });

  useEffect(() => {
    try {
      if (view !== "home") localStorage.setItem("tauri_ai_mobile_settings_view", view);
    } catch {
      // ignore
    }
  }, [view]);

  useEffect(() => {
    saveChatRenderMode(chatRenderMode);
  }, [chatRenderMode]);

  const modelRefOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const p of providers) {
      for (const m of p.models) {
        const value = `${p.name}/${m.name}`;
        out.push({ value, label: `${p.displayName || p.name} / ${m.name}` });
      }
    }
    return out;
  }, [providers]);

  const activeProvider = useMemo(
    () => providers.find((p) => p.name === activeProviderName) ?? providers[0],
    [providers, activeProviderName],
  );
  const activeModel = useMemo(
    () => activeProvider?.models.find((m) => m.name === activeModelName) ?? activeProvider?.models[0],
    [activeProvider, activeModelName],
  );
  const selectedModelRef = useMemo(() => {
    if (!activeProvider || !activeModel) return "";
    return `${activeProvider.name}/${activeModel.name}`;
  }, [activeProvider, activeModel]);

  const activeAgent = useMemo(
    () => agents.find((a) => a.name === activeAgentName) ?? agents[0],
    [agents, activeAgentName],
  );

  const load = async () => {
    if (!isTauriRuntime()) {
      setStatus("当前是浏览器预览，无法读取后端配置。");
      return;
    }
    setLoading(true);
    setStatus("正在读取配置…");
    try {
      const cfg = await tauriInvoke<AppConfig>("get_app_config");

      const nextProviders = ensureProvidersDraft(cfg?.providers ?? []);
      if (nextProviders.length > 0) {
        setProviders(nextProviders);
      }

      const cfgAgents: any[] = cfg?.agents ?? [];
      const nextAgents = cfgAgents
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
          name: String(a.name ?? ""),
          originalName: String(a.name ?? ""),
          displayName: String(a.displayName ?? a.name ?? ""),
          description: a.description ? String(a.description) : undefined,
          enabled: typeof a.enabled === "boolean" ? a.enabled : true,
          type: (a.type as AgentType) ?? "chat",
          modelRef: String(a.modelRef ?? ""),
          systemPrompt: a.systemPrompt ? String(a.systemPrompt) : "",
        }))
        .filter((a) => a.name.trim());

      setAgents(nextAgents);
      const nextDefaultAgent = String(cfg?.defaultAgent ?? "");
      const nextCurrentAgent = String(cfg?.currentAgent ?? "");
      const firstEnabledAgent = nextAgents.find((a) => a.enabled !== false)?.name || "";
      const resolvedDefaultAgent = nextDefaultAgent || firstEnabledAgent || nextAgents[0]?.name || "";
      setDefaultAgentName(resolvedDefaultAgent);
      setActiveAgentName(nextCurrentAgent || resolvedDefaultAgent || nextAgents[0]?.name || "");

      const candidateModelRef =
        cfg?.currentModelRef ||
        (nextCurrentAgent &&
          nextAgents.find((a) => a.enabled !== false && a.name === nextCurrentAgent)?.modelRef) ||
        (nextDefaultAgent &&
          nextAgents.find((a) => a.enabled !== false && a.name === nextDefaultAgent)?.modelRef) ||
        "";
      const parsed = parseModelRef(candidateModelRef);
      const list = nextProviders.length > 0 ? nextProviders : providers;
      const first = list[0];

      const targetProviderName =
        (parsed && list.find((p) => p.name === parsed.provider)?.name) || first?.name || "default";
      const targetProvider = list.find((p) => p.name === targetProviderName) || first;
      const targetModelName =
        (parsed && targetProvider?.models.find((m) => m.name === parsed.model)?.name) ||
        targetProvider?.models[0]?.name ||
        "";

      setActiveProviderName(targetProviderName);
      setActiveModelName(targetModelName);

      setStatus("配置已加载");
    } catch (e) {
      setStatus(`读取失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (providers.length === 0) return;
    const provider = providers.find((p) => p.name === activeProviderName) ?? providers[0];
    if (!provider) return;
    if (provider.name !== activeProviderName) setActiveProviderName(provider.name);
    const model = provider.models.find((m) => m.name === activeModelName);
    if (!model) setActiveModelName(provider.models[0]?.name ?? "");
  }, [providers, activeProviderName, activeModelName]);

  useEffect(() => {
    if (agents.length === 0) {
      if (activeAgentName) setActiveAgentName("");
      return;
    }
    const found = agents.find((a) => a.name === activeAgentName);
    if (!found) setActiveAgentName(agents[0].name);
  }, [agents, activeAgentName]);

  useEffect(() => {
    if (agents.length === 0) {
      if (defaultAgentName) setDefaultAgentName("");
      return;
    }
    if (defaultAgentName && agents.some((a) => a.name === defaultAgentName)) return;
    const firstEnabled = agents.find((a) => a.enabled !== false)?.name;
    setDefaultAgentName(firstEnabled || agents[0].name);
  }, [agents, defaultAgentName]);

  const test = async () => {
    if (!isTauriRuntime()) return;
    if (!activeProvider || !activeModel) return;
    setStatus("正在测试连接…");
    try {
      const resp = await tauriInvoke<{ success: boolean; message: string; responseTimeMs?: number }>(
        "test_connection",
        {
          providerType: activeProvider.type,
          apiBase: activeProvider.apiBase,
          apiKey: activeProvider.apiKey ? activeProvider.apiKey : null,
          modelName: activeModel.name,
        },
      );
      setStatus(
        resp.success
          ? `连接成功（${resp.responseTimeMs ?? "?"}ms）`
          : `连接失败：${resp.message}`,
      );
    } catch (e) {
      setStatus(`测试失败：${String(e)}`);
    }
  };

  const save = async () => {
    if (!isTauriRuntime()) return;
    setSaving(true);
    setStatus("正在保存…");
    try {
      const cfg = await tauriInvoke<AppConfig>("get_app_config");
      const existingProviders: any[] = Array.isArray(cfg?.providers) ? cfg.providers : [];
      const existingAgents: any[] = Array.isArray(cfg?.agents) ? cfg.agents : [];

      const next: AppConfig = { ...cfg };
      next.providers = providers.map((p) => {
        const existing = existingProviders.find((x) => x && typeof x === "object" && String(x.name) === p.originalName);
        const base: any = existing && typeof existing === "object" ? { ...existing } : {};
        base.name = p.name;
        base.displayName = p.displayName;
        base.type = p.type;
        base.apiBase = p.apiBase;
        base.apiKey = p.apiKey ? p.apiKey : null;
        base.enabled = p.enabled !== false;

        const existingModels: any[] = Array.isArray(existing?.models) ? existing.models : [];
        const existingByName = new Map(existingModels.map((m) => [String(m?.name ?? ""), m]));
        base.models = p.models.map((m) => {
          const existingModel = existingByName.get(m.originalName);
          const mb: any = existingModel && typeof existingModel === "object" ? { ...existingModel } : {};
          mb.name = m.name;
          mb.temperature = typeof mb.temperature === "number" ? mb.temperature : m.temperature;
          mb.temperatureEnabled =
            typeof mb.temperatureEnabled === "boolean" ? mb.temperatureEnabled : m.temperatureEnabled;
          mb.maxTokens = typeof mb.maxTokens === "number" ? mb.maxTokens : m.maxTokens;
          mb.topP = typeof mb.topP === "number" ? mb.topP : m.topP;
          mb.topPEnabled = typeof mb.topPEnabled === "boolean" ? mb.topPEnabled : m.topPEnabled;
          mb.capabilities =
            mb.capabilities && typeof mb.capabilities === "object" ? mb.capabilities : (m.capabilities ?? {});
          return mb;
        });
        return base;
      });

      // Agent skeleton: merge into existing objects to preserve fields we don't edit on mobile.
      next.agents = agents.map((a) => {
        const existing = existingAgents.find((x) => x && typeof x === "object" && String(x.name) === a.originalName);
        const base: any = existing && typeof existing === "object" ? { ...existing } : {};
        base.name = a.name;
        base.displayName = a.displayName || a.name;
        if (a.description !== undefined) base.description = a.description ? a.description : null;
        base.enabled = a.enabled !== false;
        if (a.type) base.type = a.type;
        base.modelRef = a.modelRef;
        base.systemPrompt = a.systemPrompt ?? "";
        return base;
      });

      // Default agent is used as the basis for new conversations (mobile/desktop).
      next.defaultAgent = defaultAgentName || "";

      // Prefer agent-selected modelRef when available; otherwise fall back to provider/model selection.
      const nextAgents = next.agents as Array<{ name: string; modelRef?: string | null }>;
      const current = next.currentAgent
        ? nextAgents.find((a) => a.name === next.currentAgent)
        : undefined;
      const def = next.defaultAgent ? nextAgents.find((a) => a.name === next.defaultAgent) : undefined;
      const agentModelRef = (current?.modelRef ?? def?.modelRef) ?? undefined;
      const fallbackModelRef = selectedModelRef || modelRefOptions[0]?.value || "";
      next.currentModelRef = (agentModelRef && agentModelRef.trim()) || fallbackModelRef || null;

      await tauriInvoke<void>("save_app_config", { config: next });
      setStatus("已保存");
    } catch (e) {
      setStatus(`保存失败：${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden p-3 safe-top space-y-3">
      {view === "home" ? (
        <>
          <div>
            <div className="text-lg font-semibold">设置</div>
            <div className="text-xs text-white/60 mt-1">Runtime: {runtime}</div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setView(t.id);
                }}
                className="h-14 min-w-0 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors flex items-center gap-3 px-3"
              >
                <span className="text-white/80">{t.icon}</span>
                <span className="text-sm truncate">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
            <div className="text-sm font-medium text-white/90">聊天渲染</div>
            <div className="space-y-2">
              <label className="text-xs text-white/70">文本显示</label>
              <Select
                value={chatRenderMode}
                onChange={(e) => {
                  const v = e.target.value;
                  setChatRenderMode(v === "plain" ? "plain" : "rich");
                }}
              >
                <option value="rich">富文本（Markdown）</option>
                <option value="plain">纯文本</option>
              </Select>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <div className="text-lg font-semibold">
              {tabs.find((t) => t.id === view)?.label ?? "设置"}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="ghost" className="w-full" onClick={() => setView("home")}>
                返回
              </Button>
              <Button size="sm" className="w-full" onClick={() => void save()} disabled={saving}>
                {saving ? <Spinner /> : "保存"}
              </Button>
            </div>
          </div>
        </>
      )}

      {view === "providers" ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-3">
          <div className="grid grid-cols-1 gap-2">
            <label className="text-xs text-white/70">当前 Provider</label>
            <div className="space-y-2">
              <Select
                value={activeProvider?.name ?? ""}
                onChange={(e) => {
                  const nextName = e.target.value;
                  setActiveProviderName(nextName);
                  const p = providers.find((x) => x.name === nextName);
                  setActiveModelName(p?.models[0]?.name ?? "");
                }}
              >
                {providers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.displayName || p.name}
                  </option>
                ))}
              </Select>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    const base = `provider_${Date.now()}`;
                    const used = new Set(providers.map((p) => p.name));
                    let name = base;
                    let n = 1;
                    while (used.has(name)) {
                      n += 1;
                      name = `${base}_${n}`;
                    }
                    const next: ProviderDraft = {
                      name,
                      originalName: name,
                      displayName: "New Provider",
                      type: "openai_compatible",
                      apiBase: "https://api.openai.com/v1",
                      apiKey: "",
                      enabled: true,
                      models: [],
                    };
                    setProviders((prev) => [...prev, next]);
                    setActiveProviderName(name);
                    setActiveModelName("");
                    setStatus("已新增 Provider（别忘了点保存）");
                  }}
                >
                  添加
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    if (!activeProvider) return;
                    if (
                      !confirm(
                        `删除 Provider：${activeProvider.displayName || activeProvider.name} ?`,
                      )
                    )
                      return;
                    setProviders((prev) => {
                      const next = prev.filter((p) => p.name !== activeProvider.name);
                      const first = next[0];
                      setActiveProviderName(first?.name ?? "");
                      setActiveModelName(first?.models[0]?.name ?? "");
                      return next.length > 0
                        ? next
                        : [
                            {
                              name: "default",
                              originalName: "default",
                              displayName: "Default",
                              type: "openai_compatible",
                              apiBase: "https://api.openai.com/v1",
                              apiKey: "",
                              enabled: true,
                              models: [buildDefaultModel("gpt-4o-mini")],
                            },
                          ];
                    });
                  }}
                  disabled={providers.length <= 1}
                >
                  删除
                </Button>
              </div>
            </div>

            {activeProvider ? (
              <>
                <label className="text-xs text-white/70 mt-2">Display Name</label>
                <Input
                  value={activeProvider.displayName}
                  onChange={(e) =>
                    setProviders((prev) =>
                      prev.map((p) =>
                        p.name === activeProvider.name
                          ? { ...p, displayName: e.target.value }
                          : p,
                      ),
                    )
                  }
                />

                <label className="text-xs text-white/70 mt-2">Type</label>
                <Select
                  value={activeProvider.type}
                  onChange={(e) =>
                    setProviders((prev) =>
                      prev.map((p) =>
                        p.name === activeProvider.name
                          ? { ...p, type: e.target.value as any }
                          : p,
                      ),
                    )
                  }
                >
                  <option value="openai_compatible">openai_compatible</option>
                  <option value="openai">openai</option>
                  <option value="openai_responses">openai_responses</option>
                  <option value="anthropic">anthropic</option>
                  <option value="google">google</option>
                  <option value="ollama">ollama</option>
                </Select>

                <label className="text-xs text-white/70 mt-2">API Base</label>
                <Input
                  value={activeProvider.apiBase}
                  onChange={(e) =>
                    setProviders((prev) =>
                      prev.map((p) =>
                        p.name === activeProvider.name ? { ...p, apiBase: e.target.value } : p,
                      ),
                    )
                  }
                />

                <label className="text-xs text-white/70 mt-2">API Key（可选）</label>
                <SecretInput
                  value={activeProvider.apiKey}
                  onChange={(e) =>
                setProviders((prev) =>
                  prev.map((p) =>
                    p.name === activeProvider.name ? { ...p, apiKey: e.target.value } : p,
                  ),
                )
              }
                placeholder="sk-..."
              />

              <label className="text-xs text-white/70 mt-2">当前 Model</label>
              <div className="space-y-2">
                <Select
                  value={activeModel?.name ?? ""}
                  onChange={(e) => setActiveModelName(e.target.value)}
                >
                  {activeProvider.models.length === 0 ? (
                    <option value="">（暂无模型）</option>
                  ) : null}
                  {activeProvider.models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </Select>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      if (!activeModel) return;
                      setProviders((prev) =>
                        prev.map((p) => {
                          if (p.name !== activeProvider.name) return p;
                          const nextModels = p.models.filter((m) => m.name !== activeModel.name);
                          return { ...p, models: nextModels };
                        }),
                      );
                    }}
                    disabled={!activeModel}
                  >
                    删除
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() => setShowModelPicker(true)}
                    disabled={!activeProvider}
                  >
                    获取模型
                  </Button>
                </div>
              </div>

              <label className="text-xs text-white/70 mt-2">添加 Model</label>
              <div className="space-y-2">
                <Input
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder="例如：glm-4.7 / gpt-4o-mini"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    const name = newModelName.trim();
                    if (!name) return;
                    setProviders((prev) =>
                      prev.map((p) => {
                        if (p.name !== activeProvider.name) return p;
                        if (p.models.some((m) => m.name === name)) return p;
                        return { ...p, models: [...p.models, buildDefaultModel(name)] };
                      }),
                    );
                    setActiveModelName(name);
                    setNewModelName("");
                  }}
                >
                  添加
                </Button>
              </div>
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading || saving}>
              {loading ? <Spinner /> : "重新加载"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void test()} disabled={saving}>
              测试连接
            </Button>
          </div>
        </div>
      ) : null}

      {view === "agents" ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-3">
          <div className="grid grid-cols-1 gap-2">
            <label className="text-xs text-white/70">默认 Agent（新对话默认）</label>
            <Select
              value={defaultAgentName}
              onChange={(e) => setDefaultAgentName(e.target.value)}
              disabled={agents.length === 0}
            >
              {agents.length === 0 ? <option value="">（暂无 Agent）</option> : null}
              {agents.filter((a) => a.enabled !== false).length === 0 ? (
                <option value="">（没有启用的 Agent）</option>
              ) : null}
              {agents
                .filter((a) => a.enabled !== false)
                .map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.displayName || a.name}
                  </option>
                ))}
            </Select>

            <label className="text-xs text-white/70 mt-2">选择要配置的 Agent</label>
            <Select
              value={activeAgentName}
              onChange={(e) => setActiveAgentName(e.target.value)}
              disabled={agents.length === 0}
            >
              {agents.length === 0 ? <option value="">（暂无 Agent）</option> : null}
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.displayName || a.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => {
                const nextNameBase = "mobile-agent";
                const used = new Set(agents.map((a) => a.name));
                let n = 1;
                let name = `${nextNameBase}-${n}`;
                while (used.has(name)) {
                  n += 1;
                  name = `${nextNameBase}-${n}`;
                }
                const modelRef = selectedModelRef || modelRefOptions[0]?.value || "";
                setAgents((prev) => [
                  ...prev,
                  {
                    name,
                    originalName: name,
                    displayName: "Mobile Agent",
                    type: "chat",
                    enabled: true,
                    modelRef,
                    systemPrompt: "",
                  },
                ]);
                setActiveAgentName(name);
                setStatus("已新增一个 Agent（别忘了点保存）");
              }}
            >
              新增 Agent
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              disabled={!activeAgent}
              onClick={() => {
                if (!activeAgent) return;
                if (!confirm(`删除 Agent：${activeAgent.displayName || activeAgent.name} ?`)) return;
                setAgents((prev) => prev.filter((a) => a.name !== activeAgent.name));
                setStatus("已删除 Agent（别忘了点保存）");
              }}
            >
              删除
            </Button>
          </div>

          {activeAgent ? (
            <div className="rounded-lg border border-white/10 bg-[#0b1220] p-3">
              <div className="text-sm font-medium">{activeAgent.displayName || activeAgent.name}</div>

              <div className="grid grid-cols-1 gap-2 mt-3">
                <label className="text-xs text-white/70">Name</label>
                <Input
                  value={activeAgent.name}
                  onChange={(e) => {
                    const nextName = e.target.value.trim();
                    const oldName = activeAgent.name;
                    if (!nextName) return;
                    if (agents.some((x) => x.name === nextName && x.name !== oldName)) {
                      setStatus(`Agent name 已存在：${nextName}`);
                      return;
                    }
                    setAgents((prev) =>
                      prev.map((x) => (x.name === oldName ? { ...x, name: nextName } : x)),
                    );
                    setActiveAgentName(nextName);
                    if (defaultAgentName === oldName) setDefaultAgentName(nextName);
                  }}
                />

                <label className="text-xs text-white/70 mt-2">Display Name</label>
                <Input
                  value={activeAgent.displayName}
                  onChange={(e) =>
                    setAgents((prev) =>
                      prev.map((x) =>
                        x.name === activeAgent.name ? { ...x, displayName: e.target.value } : x,
                      ),
                    )
                  }
                />

                <label className="text-xs text-white/70 mt-2">Type</label>
                <Select
                  value={activeAgent.type ?? "chat"}
                  onChange={(e) =>
                    setAgents((prev) =>
                      prev.map((x) =>
                        x.name === activeAgent.name ? { ...x, type: e.target.value as any } : x,
                      ),
                    )
                  }
                >
                  <option value="chat">chat</option>
                  <option value="tool">tool</option>
                </Select>

                <label className="text-xs text-white/70 mt-2">Model Ref</label>
                {modelRefOptions.length > 0 ? (
                  <Select
                    value={activeAgent.modelRef}
                    onChange={(e) =>
                      setAgents((prev) =>
                        prev.map((x) =>
                          x.name === activeAgent.name ? { ...x, modelRef: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    {modelRefOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={activeAgent.modelRef}
                    onChange={(e) =>
                      setAgents((prev) =>
                        prev.map((x) =>
                          x.name === activeAgent.name ? { ...x, modelRef: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="provider/model"
                  />
                )}

                <label className="text-xs text-white/70 mt-2">System Prompt</label>
                <textarea
                  className="min-h-24 w-full max-w-full rounded-md bg-white/5 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
                  value={activeAgent.systemPrompt ?? ""}
                  onChange={(e) =>
                    setAgents((prev) =>
                      prev.map((x) =>
                        x.name === activeAgent.name ? { ...x, systemPrompt: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder="You are a helpful assistant..."
                />
              </div>
            </div>
          ) : (
            <div className="text-sm text-white/60">暂无 Agent，点击“新增 Agent”创建一个。</div>
          )}
        </div>
      ) : null}

      {view !== "home" && view !== "providers" && view !== "agents" ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
          <div className="text-sm font-medium">该模块移动端暂未实现</div>
        </div>
      ) : null}

      <ModelPickerModal
        open={showModelPicker}
        providerDisplayName={activeProvider?.displayName || activeProvider?.name || "Provider"}
        providerType={(activeProvider?.type as any) ?? "openai_compatible"}
        apiBase={activeProvider?.apiBase ?? ""}
        apiKey={activeProvider?.apiKey ?? ""}
        existingModelNames={activeProvider?.models.map((m) => m.name) ?? []}
        onClose={() => setShowModelPicker(false)}
        onAddModels={(modelNames) => {
          if (!activeProvider) return;
          const toAdd = modelNames.map((s) => String(s).trim()).filter(Boolean);
          if (toAdd.length === 0) return;
          setProviders((prev) =>
            prev.map((p) => {
              if (p.name !== activeProvider.name) return p;
              const existing = new Set(p.models.map((m) => m.name));
              const nextModels = [...p.models];
              for (const name of toAdd) {
                if (existing.has(name)) continue;
                nextModels.push(buildDefaultModel(name));
              }
              return { ...p, models: nextModels };
            }),
          );
          if (!activeModelName) setActiveModelName(toAdd[0]);
          setStatus(`已添加模型：${toAdd.slice(0, 3).join(", ")}${toAdd.length > 3 ? "…" : ""}`);
        }}
      />

      <div className="text-xs text-white/70 break-words">状态：{status}</div>
    </div>
  );
}
