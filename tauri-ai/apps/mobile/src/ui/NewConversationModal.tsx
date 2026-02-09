import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { clsx } from "../lib/clsx";
import { isTauriRuntime, tauriInvoke } from "../lib/tauri";
import { Button } from "./Button";
import { Select } from "./Select";
import { Spinner } from "./Spinner";

type AgentOption = {
  name: string;
  displayName: string;
  enabled: boolean;
};

function ensureAgentOptions(cfg: any): AgentOption[] {
  const list: any[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
  return list
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      name: String(a.name ?? "").trim(),
      displayName: String(a.displayName ?? a.name ?? "").trim(),
      enabled: typeof a.enabled === "boolean" ? a.enabled : true,
    }))
    .filter((a) => a.name);
}

function pickDefaultAgentName(cfg: any, agents: AgentOption[]): string {
  const enabled = agents.filter((a) => a.enabled !== false);
  const def = String(cfg?.defaultAgent ?? "").trim();
  if (def && enabled.some((a) => a.name === def)) return def;
  const cur = String(cfg?.currentAgent ?? "").trim();
  if (cur && enabled.some((a) => a.name === cur)) return cur;
  return enabled[0]?.name || agents[0]?.name || "";
}

export function NewConversationModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (agentName: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled !== false), [agents]);
  const [selectedAgentName, setSelectedAgentName] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setAgents([]);
    setSelectedAgentName("");

    const load = async () => {
      if (!isTauriRuntime()) {
        setError("当前是浏览器预览模式，无法读取后端配置。请在 App 内运行。");
        return;
      }
      setLoading(true);
      try {
        const cfg = await tauriInvoke<any>("get_app_config");
        const nextAgents = ensureAgentOptions(cfg);
        setAgents(nextAgents);
        setSelectedAgentName(pickDefaultAgentName(cfg, nextAgents));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [open]);

  if (!open) return null;

  const canCreate = !loading && !!selectedAgentName;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(520px,calc(100vw-24px))] rounded-xl border border-white/10 bg-[#0b1220] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div className="text-base font-semibold">新建对话</div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-white/70 hover:text-white hover:bg-white/10"
            aria-label="关闭"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="space-y-2">
            <label className="text-xs text-white/70">选择 Agent</label>
            {loading ? (
              <div className="h-10 rounded-md border border-white/10 bg-white/5 px-3 flex items-center gap-2 text-sm text-white/70">
                <Spinner />
                <span>正在加载…</span>
              </div>
            ) : enabledAgents.length > 0 ? (
              <Select value={selectedAgentName} onChange={(e) => setSelectedAgentName(e.target.value)}>
                {enabledAgents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.displayName || a.name}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="text-sm text-white/60">
                未找到可用的 Agent，请先在 Settings → 智能体 中创建/启用一个。
              </div>
            )}
          </div>

          {error ? <div className={clsx("text-sm", "text-red-300")}>{error}</div> : null}
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (!canCreate) return;
              onCreate(selectedAgentName);
            }}
            disabled={!canCreate}
          >
            创建
          </Button>
        </div>
      </div>
    </div>
  );
}

