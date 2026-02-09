import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";

// Initialize mermaid once (shared between desktop & mobile bundles independently).
mermaid.initialize({
  startOnLoad: false,
  theme: "neutral",
  securityLevel: "loose",
  // Desktop historically prefers fixed-size diagrams with horizontal scroll;
  // mobile can additionally "fit" via SVG patching at render-time.
  flowchart: { useMaxWidth: false },
  sequence: { useMaxWidth: false },
  gantt: { useMaxWidth: false },
  class: { useMaxWidth: false },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
  forceLegacyMathML: true,
  suppressErrorRendering: false,
});

// Cache identical diagrams in-memory to avoid repeated render cost.
const mermaidCache = new Map<string, string>();
let mermaidIdCounter = 0;

function generateMermaidId(): string {
  return `mermaid-${++mermaidIdCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

function sanitizeMermaidSvg(svg: string): string {
  let out = svg;
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\s(href|xlink:href)\s*=\s*"(?:(?:javascript|data):[^"]*)"/gi, "");
  out = out.replace(/\s(href|xlink:href)\s*=\s*'(?:(?:javascript|data):[^']*)'/gi, "");
  return out;
}

function findNearestAnchorWithLink(start: Element): SVGElement | HTMLAnchorElement | null {
  let cur: Element | null = start;
  while (cur) {
    if (cur.tagName.toLowerCase() === "a") {
      const href =
        cur.getAttribute("href") ??
        cur.getAttribute("xlink:href") ??
        (cur as any).getAttributeNS?.("http://www.w3.org/1999/xlink", "href") ??
        "";
      if (href && href.trim().length > 0) return cur as any;
    }
    cur = cur.parentElement;
  }
  return null;
}

async function getMermaidSvgCacheFromDisk(key: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  if (!key.trim()) return null;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const out = await invoke<unknown>("get_mermaid_svg_cache", { key });
    if (typeof out !== "string") return null;
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

async function setMermaidSvgCacheToDisk(key: string, svg: string): Promise<void> {
  if (!isTauriRuntime()) return;
  if (!key.trim()) return;
  if (!svg.trim()) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_mermaid_svg_cache", { key, svg });
  } catch {
    // ignore (best-effort)
  }
}

function makeSvgResponsive(svgText: string): string {
  // Only attempt if viewBox exists; otherwise keep width/height to avoid 0x0 rendering.
  if (!/viewBox\s*=\s*"/i.test(svgText)) return svgText;

  return svgText.replace(/<svg\b([^>]*)>/i, (_full, rawAttrs: string) => {
    let attrs = rawAttrs ?? "";

    // Remove explicit width/height so CSS can fit container.
    attrs = attrs.replace(/\swidth\s*=\s*"[^"]*"/gi, "");
    attrs = attrs.replace(/\sheight\s*=\s*"[^"]*"/gi, "");

    if (!/\spreserveAspectRatio\s*=\s*"/i.test(attrs)) {
      attrs += ' preserveAspectRatio="xMidYMid meet"';
    }

    // Merge/append style.
    const styleMatch = attrs.match(/\sstyle\s*=\s*"([^"]*)"/i);
    if (styleMatch) {
      const existing = styleMatch[1];
      const next = `${existing};max-width:100%;height:auto;`.replace(/;;+/g, ";");
      attrs = attrs.replace(/\sstyle\s*=\s*"([^"]*)"/i, ` style="${next}"`);
    } else {
      attrs += ' style="max-width:100%;height:auto;"';
    }

    return `<svg${attrs}>`;
  });
}

export type MermaidBlockProps = {
  code: string;
  mode?: "desktop" | "mobile";
  onLinkClickHref?: (href: string) => boolean;
};

export function MermaidBlock({ code, mode = "desktop", onLinkClickHref }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const cleanCode = useMemo(() => code.trim().replace(/\r\n/g, "\n"), [code]);
  const cacheKey = useMemo(() => hashCode(cleanCode), [cleanCode]);

  useEffect(() => {
    let cancelled = false;

    if (!cleanCode) {
      setError("Empty diagram code");
      return;
    }

    const cached = mermaidCache.get(cacheKey);
    if (cached) {
      setSvg(cached);
      setError("");
      return;
    }

    const renderDiagram = async () => {
      try {
        const diskSvg = await getMermaidSvgCacheFromDisk(cacheKey);
        if (cancelled) return;

        if (diskSvg) {
          const cleaned = sanitizeMermaidSvg(diskSvg);
          const displaySvg = mode === "mobile" ? makeSvgResponsive(cleaned) : cleaned;
          mermaidCache.set(cacheKey, displaySvg);
          setSvg(displaySvg);
          setError("");
          return;
        }

        const renderId = generateMermaidId();
        await mermaid.parse(cleanCode);
        if (cancelled) return;

        const { svg: renderedSvg } = await mermaid.render(renderId, cleanCode);
        if (cancelled) return;

        const cleaned = sanitizeMermaidSvg(renderedSvg);
        const displaySvg = mode === "mobile" ? makeSvgResponsive(cleaned) : cleaned;
        mermaidCache.set(cacheKey, displaySvg);
        setSvg(displaySvg);
        setError("");

        // Best-effort disk cache (store the cleaned original, not the responsive-patched one)
        void setMermaidSvgCacheToDisk(cacheKey, cleaned);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to render diagram";
        // eslint-disable-next-line no-console
        console.warn("[Mermaid] Parse/render error:", msg);
        setError(msg);
      }
    };

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, cleanCode, mode]);

  const handleSvgClickCapture = useCallback(
    (e: any) => {
      const el = (e?.target ?? null) as Element | null;
      if (!el) return;
      const anchor = findNearestAnchorWithLink(el);
      if (!anchor) return;

      const hrefRaw =
        anchor.getAttribute("href") ??
        anchor.getAttribute("xlink:href") ??
        (anchor as any).getAttributeNS?.("http://www.w3.org/1999/xlink", "href") ??
        "";
      if (!hrefRaw.trim()) return;
      if (!onLinkClickHref) return;

      const handled = onLinkClickHref(hrefRaw);
      if (!handled) return;

      e.preventDefault?.();
      e.stopPropagation?.();
    },
    [onLinkClickHref]
  );

  if (error) {
    return (
      <div className="my-2 rounded-lg bg-red-900/20 p-4 text-red-400">
        <p className="text-sm font-medium">Mermaid 渲染失败</p>
        <p className="mt-1 text-xs opacity-70">{error}</p>
        <pre className="mt-2 overflow-x-hidden whitespace-pre-wrap text-xs opacity-70 bg-red-900/10 p-2 rounded">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-2 flex justify-center rounded-lg bg-gray-100 dark:bg-gray-700/50 p-4 min-h-[100px]">
        <span className="text-gray-400 text-sm">Loading diagram...</span>
      </div>
    );
  }

  const containerClassName =
    mode === "mobile"
      ? "w-full overflow-x-hidden rounded-lg bg-gray-100 dark:bg-gray-700/50 p-4 flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
      : "w-full overflow-x-auto rounded-lg bg-gray-100 dark:bg-gray-700/50 p-4 cursor-zoom-in flex justify-center [&_svg]:max-w-none";

  return (
    <>
      <div className="group relative my-2 w-full">
        <div
          ref={containerRef}
          className={containerClassName}
          onClickCapture={handleSvgClickCapture}
          onClick={(e) => {
            if (e.defaultPrevented) return;
            setIsFullscreen(true);
          }}
          title={mode === "mobile" ? "点击放大查看" : "点击放大查看"}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="w-[92vw] h-[85vh] mt-10 overflow-auto bg-white dark:bg-gray-800 rounded-lg p-4"
            onClick={(e) => e.stopPropagation()}
            onClickCapture={handleSvgClickCapture}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <div className="absolute top-4 right-4">
            <button
              type="button"
              className="px-4 py-2 bg-white dark:bg-gray-700 rounded shadow hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              onClick={() => setIsFullscreen(false)}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
}

