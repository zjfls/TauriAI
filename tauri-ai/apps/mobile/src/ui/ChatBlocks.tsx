import { useMemo, useState } from "react";
import { Brain, ChevronDown, ChevronRight, LoaderCircle, Search, Wrench } from "lucide-react";

function safeParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function PendingAssistantBlock({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80">
      <div className="flex items-center gap-2">
        <LoaderCircle size={16} className="shrink-0 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function ThinkingBlock({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const [open, setOpen] = useState(Boolean(isStreaming));
  if (!text) return null;

  return (
    <div className="rounded-lg border border-purple-200 bg-purple-50 text-purple-900 dark:border-purple-800 dark:bg-purple-900/25 dark:text-purple-100 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-purple-800 dark:text-purple-200 hover:bg-purple-100/80 dark:hover:bg-purple-900/40"
      >
        <Brain size={16} className="shrink-0" />
        <span className="font-medium">{isStreaming ? "思考中…" : "思考过程"}</span>
        {isStreaming ? <span className="ml-1 h-2 w-2 rounded-full bg-purple-500 animate-pulse" /> : null}
        <span className="ml-auto">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </button>
      {open ? (
        <div className="border-t border-purple-200 dark:border-purple-800 px-3 py-2 text-sm">
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{text}</div>
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(status: string): string {
  switch ((status || "").toLowerCase()) {
    case "in_progress":
      return "准备中";
    case "searching":
      return "搜索中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "done":
      return "已完成";
    default:
      return status || "unknown";
  }
}

export function WebSearchBlock({
  status,
  action,
  isStreaming,
}: {
  status: string;
  action?: unknown;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(isStreaming));

  const info = useMemo(() => {
    if (!open) return null;
    if (action == null) return null;

    const parsed = typeof action === "string" ? safeParseJson(action) : action;
    if (!parsed || typeof parsed !== "object") {
      const txt = parsed == null ? "" : String(parsed);
      return { queryItems: [], url: undefined, pattern: undefined, sources: [], raw: txt ? txt : undefined };
    }

    const a = parsed as any;
    const pickString = (...values: Array<unknown>) =>
      values.find((v) => typeof v === "string") as string | undefined;
    const pickStringArray = (...values: Array<unknown>) => {
      const arr = values.find((v) => Array.isArray(v)) as Array<unknown> | undefined;
      return arr?.filter((q): q is string => typeof q === "string");
    };

    const query = pickString(a.query, a.search_query, a.searchQuery);
    const queries = pickStringArray(a.queries, a.search_queries, a.searchQueries);
    const openPage = a.open_page ?? a.openPage ?? a.page;
    const findInPage = a.find_in_page ?? a.findInPage ?? a.find;
    const url = pickString(a.url, openPage?.url, findInPage?.url, a.page_url, a.pageUrl, a.href, a.link);
    const pattern = pickString(a.pattern, findInPage?.pattern, findInPage?.query, a.text);
    const sources = Array.isArray(a.sources)
      ? (a.sources as Array<{ url?: unknown }>)
          .map((s) => (typeof s?.url === "string" ? s.url : null))
          .filter((u): u is string => typeof u === "string")
      : [];

    const queryItems = (queries?.length ? queries : query ? [query] : []).filter(
      (q): q is string => typeof q === "string" && q.trim().length > 0,
    );

    return { queryItems, url, pattern, sources, raw: stringify(parsed) };
  }, [action, open]);

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-900/25 dark:text-blue-100 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-blue-800 dark:text-blue-200 hover:bg-blue-100/80 dark:hover:bg-blue-900/40"
      >
        <Search size={16} className="shrink-0" />
        <span className="font-medium">联网搜索：{statusLabel(status)}</span>
        {isStreaming && status !== "completed" ? (
          <span className="ml-1 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
        ) : null}
        <span className="ml-auto">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </button>

      {open ? (
        <div className="border-t border-blue-200 dark:border-blue-800 px-3 py-2 text-sm space-y-2">
          {!info ? <div className="text-xs text-blue-700 dark:text-blue-300">暂无可展示信息</div> : null}

          {info?.queryItems?.length ? (
            <div>
              <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">queries</div>
              <ul className="list-disc pl-5">
                {info.queryItems.map((q) => (
                  <li key={q} className="break-words">
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {info?.url ? (
            <div className="break-words">
              <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">url</span>
              <span>{info.url}</span>
            </div>
          ) : null}

          {info?.pattern ? (
            <div className="break-words">
              <span className="mr-2 text-xs font-medium text-blue-700 dark:text-blue-300">pattern</span>
              <span>{info.pattern}</span>
            </div>
          ) : null}

          {info?.sources?.length ? (
            <div>
              <div className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">sources</div>
              <ul className="list-disc pl-5">
                {info.sources.map((u: string) => (
                  <li key={u} className="break-words">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {info?.raw ? (
            <details className="rounded border border-blue-200/60 bg-white/40 dark:border-blue-800/60 dark:bg-blue-950/20 px-2 py-1">
              <summary className="text-xs text-blue-700 dark:text-blue-300 cursor-pointer select-none">
                原始数据
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs">{info.raw}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ToolCallBlock({
  name,
  args,
  output,
  error,
}: {
  name: string;
  args: string;
  output?: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const badge = error ? "失败" : output ? "完成" : "执行中";

  const prettyArgs = useMemo(() => {
    const parsed = safeParseJson(args || "");
    return typeof parsed === "string" ? parsed : stringify(parsed);
  }, [args]);

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-100 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-amber-900 dark:text-amber-100 hover:bg-amber-100/80 dark:hover:bg-amber-900/40"
      >
        <Wrench size={16} className="shrink-0" />
        <span className="font-medium break-all">{name}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="rounded bg-amber-200/60 dark:bg-amber-800/60 px-2 py-0.5 text-[10px] font-medium">
            {badge}
          </span>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {open ? (
        <div className="border-t border-amber-200 dark:border-amber-800 px-3 py-2 text-xs space-y-2">
          <div>
            <div className="mb-1 font-medium text-amber-900/80 dark:text-amber-200">args</div>
            <pre className="whitespace-pre-wrap break-words">{prettyArgs}</pre>
          </div>
          {error ? (
            <div>
              <div className="mb-1 font-medium text-red-700 dark:text-red-300">error</div>
              <pre className="whitespace-pre-wrap break-words text-red-700 dark:text-red-200">{error}</pre>
            </div>
          ) : null}
          {output ? (
            <div>
              <div className="mb-1 font-medium text-amber-900/80 dark:text-amber-200">output</div>
              <pre className="whitespace-pre-wrap break-words">{output}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

