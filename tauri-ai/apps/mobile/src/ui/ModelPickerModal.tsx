import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { clsx } from "../lib/clsx";
import { isTauriRuntime, tauriInvoke } from "../lib/tauri";
import { Button } from "./Button";

type ProviderType =
  | "openai"
  | "openai_compatible"
  | "openai_responses"
  | "anthropic"
  | "google"
  | "ollama";

type ModelInfo = { id: string; ownedBy?: string | null };

function groupModels(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const parts = model.id.split(/[-_]/);
    let groupName = parts[0];
    if (parts.length > 1 && /^v?\d/.test(parts[1])) groupName = `${parts[0]}-${parts[1]}`;
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(model);
  }
  return groups;
}

type Props = {
  open: boolean;
  providerDisplayName: string;
  providerType: ProviderType;
  apiBase: string;
  apiKey: string;
  existingModelNames: string[];
  onClose: () => void;
  onAddModels: (modelNames: string[]) => void;
};

export function ModelPickerModal({
  open,
  providerDisplayName,
  providerType,
  apiBase,
  apiKey,
  existingModelNames,
  onClose,
  onAddModels,
}: Props) {
  const existingModels = useMemo(() => new Set(existingModelNames), [existingModelNames]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, searchQuery]);

  const grouped = useMemo(() => groupModels(filteredModels), [filteredModels]);

  const refresh = async () => {
    if (!isTauriRuntime()) {
      setError("当前是浏览器预览，无法拉取模型。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const list = await tauriInvoke<Array<{ id: string; owned_by?: string | null }>>(
        "fetch_provider_models",
        {
          providerType,
          apiBase,
          apiKey: apiKey ? apiKey : null,
        },
      );
      const next = list.map((m) => ({ id: m.id, ownedBy: m.owned_by ?? null }));
      setModels(next);
      setExpandedGroups(new Set(groupModels(next).keys()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSearchQuery("");
    setSelectedModels(new Set());
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const toggleGroup = (name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleModel = (id: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllInGroup = (groupName: string) => {
    const list = grouped.get(groupName) ?? [];
    setSelectedModels((prev) => {
      const next = new Set(prev);
      const available = list.filter((m) => !existingModels.has(m.id));
      const allSelected = available.every((m) => next.has(m.id));
      if (allSelected) available.forEach((m) => next.delete(m.id));
      else available.forEach((m) => next.add(m.id));
      return next;
    });
  };

  const addSingle = (id: string) => {
    onAddModels([id]);
    setSelectedModels((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addSelected = () => {
    const list = Array.from(selectedModels);
    if (list.length === 0) return;
    onAddModels(list);
    setSelectedModels(new Set());
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(920px,calc(100vw-24px))] h-[min(86vh,820px)] rounded-xl border border-white/10 bg-[#0b1220] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div className="text-base font-semibold">{providerDisplayName} 模型</div>
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

        <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
          <div className="flex-1 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              placeholder="搜索模型 ID 或名称"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full rounded-md bg-white/5 border border-white/10 pl-9 pr-3 text-sm outline-none focus:border-indigo-400"
            />
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="h-10 w-10 inline-flex items-center justify-center rounded-md border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-50"
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={18} className={clsx(loading && "animate-spin")} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-white/70">
              <Loader2 size={20} className="animate-spin" />
              <span className="ml-2 text-sm">加载中…</span>
            </div>
          ) : error ? (
            <div className="text-sm text-red-300 py-8">{error}</div>
          ) : filteredModels.length === 0 ? (
            <div className="text-sm text-white/60 py-8">
              {searchQuery.trim() ? "没有匹配的模型" : "没有可用的模型"}
            </div>
          ) : (
            <div className="space-y-2">
              {Array.from(grouped.entries()).map(([groupName, list]) => (
                <div key={groupName} className="rounded-lg border border-white/10 overflow-hidden">
                  <div
                    className="px-3 py-2 bg-white/5 hover:bg-white/10 cursor-pointer flex items-center justify-between"
                    onClick={() => toggleGroup(groupName)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {expandedGroups.has(groupName) ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                      <div className="text-sm font-medium truncate">{groupName}</div>
                      <div className="text-[11px] text-white/70 bg-white/10 px-1.5 py-0.5 rounded">
                        {list.length}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-indigo-200 hover:text-indigo-100 px-2 py-1 rounded hover:bg-white/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        selectAllInGroup(groupName);
                      }}
                    >
                      全选
                    </button>
                  </div>

                  {expandedGroups.has(groupName) ? (
                    <div className="divide-y divide-white/5">
                      {list.map((m) => {
                        const isExisting = existingModels.has(m.id);
                        const isSelected = selectedModels.has(m.id);
                        return (
                          <div
                            key={m.id}
                            className={clsx(
                              "px-3 py-2 flex items-center justify-between hover:bg-white/5",
                              isExisting && "opacity-60",
                            )}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <button
                                type="button"
                                onClick={() => (!isExisting ? toggleModel(m.id) : undefined)}
                                disabled={isExisting}
                                className={clsx(
                                  "h-5 w-5 rounded border inline-flex items-center justify-center",
                                  isExisting
                                    ? "bg-green-500/20 border-green-500/40 text-green-200"
                                    : isSelected
                                      ? "bg-indigo-500 border-indigo-500 text-white"
                                      : "border-white/20 hover:border-indigo-400",
                                )}
                                aria-label="选择模型"
                              >
                                {(isExisting || isSelected) && <Check size={14} />}
                              </button>
                              <div className="text-sm truncate">{m.id}</div>
                            </div>
                            {!isExisting ? (
                              <button
                                type="button"
                                onClick={() => addSingle(m.id)}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-white/60 hover:text-white hover:bg-white/10"
                                title="添加"
                                aria-label="添加"
                              >
                                <Plus size={18} />
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-white/10 space-y-2">
          <div className="text-sm text-white/60">已选择 {selectedModels.size} 个模型</div>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="ghost" className="w-full" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              className="w-full"
              onClick={addSelected}
              disabled={selectedModels.size === 0}
            >
              添加选中 ({selectedModels.size})
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
