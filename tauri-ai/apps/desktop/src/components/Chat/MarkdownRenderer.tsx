import React, { useDeferredValue, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import mermaid from 'mermaid';
import { Copy, Check, FileCode2, Image as ImageIcon } from 'lucide-react';
import { MathBlock } from './MathBlock';
import type { Workstudio } from '../../types';
import type { ParsedFileReference } from '../../utils/fileReference';
import { parseFileReferenceToken } from '../../utils/fileReference';
import { useWebTabStore } from '../../stores/webTabStore';
import { useWindowLayoutStore } from '../../stores/windowLayoutStore';
import { webTabId as toWorkspaceWebTabId } from '../../stores/workspaceTabStore';
import { CommonMarkdown } from '../../../../common/src/markdown/CommonMarkdown';

// Initialize mermaid with math support
mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
  // Prefer fixed-size diagrams and let the container handle horizontal scrolling.
  // This avoids diagrams becoming overly narrow when the message bubble is constrained by other content.
  flowchart: { useMaxWidth: false },
  sequence: { useMaxWidth: false },
  gantt: { useMaxWidth: false },
  class: { useMaxWidth: false },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
  // Force KaTeX CSS rendering for consistent cross-browser math display
  forceLegacyMathML: true,
  suppressErrorRendering: false,
});

// Prism 语言按需注册：确保 ```tsx / ```typescriptreact 的代码块能高亮
// （react-syntax-highlighter 的 ESM Prism 版本不会默认包含所有语言定义）
try {
  (SyntaxHighlighter as any).registerLanguage?.('typescript', typescript);
  (SyntaxHighlighter as any).registerLanguage?.('tsx', tsx);
  (SyntaxHighlighter as any).registerLanguage?.('jsx', jsx);
  // 常见 fence 别名兼容
  (SyntaxHighlighter as any).registerLanguage?.('typescriptreact', tsx);
} catch {
  // ignore: best-effort
}

// ============================================================================
// Mermaid SVG Cache - prevents re-rendering identical diagrams
// ============================================================================
const mermaidCache = new Map<string, string>();
const MERMAID_CACHE_MAX_ENTRIES = 120;
let mermaidIdCounter = 0;

const MarkdownDetailsSummary: React.FC<any> = ({ children, ...props }: any) => (
  <summary
    className="cursor-pointer rounded-t-lg bg-gray-100 px-4 py-2 font-medium dark:bg-gray-800"
    {...props}
  >
    {children}
  </summary>
);

function generateMermaidId(): string {
  return `mermaid-${++mermaidIdCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

function getMermaidCache(key: string): string | null {
  const hit = mermaidCache.get(key);
  if (hit === undefined) return null;
  mermaidCache.delete(key);
  mermaidCache.set(key, hit);
  return hit;
}

function setMermaidCache(key: string, svg: string): void {
  if (!key) return;
  if (mermaidCache.has(key)) mermaidCache.delete(key);
  mermaidCache.set(key, svg);
  while (mermaidCache.size > MERMAID_CACHE_MAX_ENTRIES) {
    const oldest = mermaidCache.keys().next().value as string | undefined;
    if (!oldest) break;
    mermaidCache.delete(oldest);
  }
}

// Simple hash function for cache keys
function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Avoid stack overflow by chunking.
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function blobToPngBase64(blob: Blob): Promise<string> {
  // Prefer FileReader: avoids large JS string concatenations for big images.
  if (typeof FileReader !== 'undefined') {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
      reader.onload = () => {
        const res = reader.result;
        if (typeof res === 'string') resolve(res);
        else reject(new Error('Invalid FileReader result'));
      };
      reader.readAsDataURL(blob);
    });
    const idx = dataUrl.indexOf(',');
    if (idx >= 0) return dataUrl.slice(idx + 1);
    return dataUrl;
  }

  // Fallback: ArrayBuffer -> base64
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return uint8ArrayToBase64(bytes);
}

function utf8StringToBase64(input: string): string {
  try {
    if (typeof TextEncoder !== 'undefined') {
      return uint8ArrayToBase64(new TextEncoder().encode(input));
    }
  } catch {
    // ignore
  }

  // Fallback: encodeURIComponent -> btoa (works for most cases, but may be slow for huge strings)
  return btoa(unescape(encodeURIComponent(input)));
}

function addMermaidInitDirective(code: string, init: Record<string, unknown>): string {
  const initLine = `%%{init: ${JSON.stringify(init)} }%%`;
  const normalized = code.replace(/\r\n/g, '\n');

  // Preserve YAML frontmatter (must be first in the diagram definition)
  // https://mermaid.js.org/config/theming.html#frontmatter
  const fm = normalized.match(/^\s*---\s*\n[\s\S]*?\n---\s*\n/);
  if (fm?.[0]) {
    return `${fm[0]}${initLine}\n${normalized.slice(fm[0].length)}`;
  }

  return `${initLine}\n${normalized}`;
}

function patchSvgForExport(svgText: string, width: number, height: number): string {
  // Some WebViews fail to rasterize SVG with percentage dimensions or missing XML namespaces.
  // Ensure root <svg> has explicit width/height and xmlns so it can be loaded as an image.
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return svgText.replace(/<svg\b([^>]*)>/i, (_full, rawAttrs: string) => {
    let attrs = rawAttrs ?? '';

    // Remove any existing width/height (including percentage) to avoid "0x0" intrinsic size.
    attrs = attrs.replace(/\swidth\s*=\s*"[^"]*"/i, '');
    attrs = attrs.replace(/\sheight\s*=\s*"[^"]*"/i, '');

    // Ensure namespaces for standalone serialization.
    if (!/\sxmlns\s*=\s*"/i.test(attrs)) {
      attrs += ' xmlns="http://www.w3.org/2000/svg"';
    }
    if (/\sxlink:href\s*=\s*"/i.test(svgText) && !/\sxmlns:xlink\s*=\s*"/i.test(attrs)) {
      attrs += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    }

    attrs += ` width="${w}" height="${h}"`;
    return `<svg${attrs}>`;
  });
}

const isTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
};

const isOpenFileDebugEnabled = (): boolean => {
  try {
    return window.localStorage.getItem('tauri-ai:debug:open_file') === '1';
  } catch {
    return false;
  }
};

const isOpenFileVerboseEnabled = (): boolean => {
  try {
    return window.localStorage.getItem('tauri-ai:debug:open_file:verbose') === '1';
  } catch {
    return false;
  }
};

const IMPORTANT_OPEN_FILE_LOGS = new Set<string>([
  'click:fileRef',
  'openFileReference:skipped_missing_context',
  'openOrFocusWorkstudioWindow:begin',
  'openFileReference:failed',
  'openFilePath skipped: missing workstudio context',
  'openFilePath failed',
]);

const dbgOpenFile = (
  msg: string,
  meta?: Record<string, unknown>
) => {
  if (!isOpenFileDebugEnabled()) return;
  if (!isOpenFileVerboseEnabled() && !IMPORTANT_OPEN_FILE_LOGS.has(msg)) return;
  const ts = new Date().toISOString();
  // Keep logs easy to grep.
  // eslint-disable-next-line no-console
  console.log(`[open_file][MarkdownRenderer][${ts}] ${msg}`, meta ?? {});
};

async function getMermaidSvgCacheFromDisk(key: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  if (!key.trim()) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const out = await invoke<unknown>('get_mermaid_svg_cache', { key });
    if (typeof out !== 'string') return null;
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
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_mermaid_svg_cache', { key, svg });
  } catch {
    // ignore (cache is best-effort)
  }
}

// ============================================================================
// Components
// ============================================================================

interface MarkdownRendererProps {
  content: string;
  conversationId?: string | null;
  workstudioId?: string | null;
}

interface CodeBlockProps {
  language: string;
  code: string;
}

const CodeBlock = React.memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [forceHighlight, setForceHighlight] = useState(false);
  const isLarge = code.length > 20_000;
  const useHighlight = forceHighlight || !isLarge;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg max-w-full">
      <div className="flex items-center justify-between bg-gray-800 px-4 py-2 text-xs text-gray-400">
        <span className="font-mono">{language || 'text'}</span>
        <div className="flex items-center gap-1.5">
          {isLarge ? (
            <button
              onClick={() => setForceHighlight((v) => !v)}
              className="rounded px-2.5 py-1 hover:bg-gray-700 hover:text-gray-200 transition-colors"
              title={useHighlight ? '关闭语法高亮（更省资源）' : '启用语法高亮（可能更耗时）'}
            >
              <span className="text-xs">{useHighlight ? '纯文本' : '高亮'}</span>
            </button>
          ) : null}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 hover:bg-gray-700 hover:text-gray-200 transition-colors"
            title={copied ? "已复制!" : "复制代码"}
          >
            {copied ? (
              <>
                <Check size={14} />
                <span className="text-xs">已复制</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span className="text-xs">复制</span>
              </>
            )}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto scrollbar-visible">
        {useHighlight ? (
          <SyntaxHighlighter
            language={language || 'text'}
            style={oneDark}
            customStyle={{ margin: 0, borderRadius: '0 0 0.5rem 0.5rem', fontSize: '0.875rem' }}
            wrapLines={false}
            wrapLongLines={false}
          >
            {code}
          </SyntaxHighlighter>
        ) : (
          <pre className="m-0 whitespace-pre bg-[#282c34] p-4 font-mono text-sm text-gray-100">{code}</pre>
        )}
      </div>
    </div>
  );
});

interface MermaidBlockProps {
  code: string;
  tryOpenFileReferenceToken?: (token: string) => boolean;
}

function parseFileReferenceTokenFromHref(hrefRaw: string): string | null {
  const href = hrefRaw.trim();
  if (!href) return null;

  // 支持自定义 scheme：`tauri-ai://open-file?ref=<encoded-token>`。
  // 其中 token 格式与行内 code 一致：
  // `src/app.ts:42`、`src/runtime/events.rs#L10C2`、`a/src/foo.rs#L9-L12` 等。
  try {
    const url = new URL(href);
    if (url.protocol === 'tauri-ai:' && url.hostname === 'open-file') {
      const ref = url.searchParams.get('ref');
      if (!ref) return null;
      // URLSearchParams.get 已做 decode；这里再做一次容错（避免调用方 double-encode）
      try {
        return decodeURIComponent(ref).trim();
      } catch {
        return ref.trim();
      }
    }
  } catch {
    // ignore: 不是合法 URL（可能是相对路径/我们自己的 token）
  }

  // 也允许直接把 token 当 href：`src/app.ts:42` / `src/runtime/events.rs#L10`
  // 如果是标准 URL（https://...），则不当作文件引用。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(href)) {
    return href;
  }

  return null;
}

function looksLikeFilePath(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (t.length > 800) return false;
  if (/[\r\n\t]/.test(t)) return false;
  // Disallow URLs (but keep Windows paths like C:\...)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return false;

  const normalized = t.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  const lower = base.toLowerCase();

  // Common source file suffixes; keep this list tight to avoid treating random labels as paths.
  const exts = [
    '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inl', '.ipp', '.ixx', '.cppm',
    '.rs', '.ts', '.tsx', '.js', '.jsx', '.json', '.toml', '.yaml', '.yml', '.md', '.markdown',
    '.py', '.java', '.go', '.kt', '.kts', '.swift', '.m', '.mm',
  ];
  if (exts.some((e) => lower.endsWith(e))) return true;

  // Fallback: absolute paths or repo-like paths that contain a directory separator.
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return true;
  if (normalized.includes('/')) return true;

  return false;
}

function looksLikeWebUrl(href: string): boolean {
  const raw = (href ?? '').trim();
  if (!raw) return false;
  if (/[\r\n\t]/.test(raw)) return false;
  if (raw.startsWith('about:')) return true;
  if (raw.startsWith('//')) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  // Basic heuristic: common "www." style links; keep tight to avoid capturing file paths.
  if (/^www\.[^\s]+$/i.test(raw)) return true;
  return false;
}

function sanitizeMermaidSvg(svg: string): string {
  // Mermaid 在 securityLevel=loose 时可能生成内联事件处理器或不安全的 href；
  // 这里做最小清洗，避免 WebView 默认行为（例如 window.open / 导航）抢走点击。
  // 注意：这不是通用 SVG sanitizer，仅用于本项目 Mermaid 输出的“安全减损”。
  let out = svg;
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');

  // Strip javascript:/data: links
  out = out.replace(/\s(href|xlink:href)\s*=\s*"(?:(?:javascript|data):[^"]*)"/gi, '');
  out = out.replace(/\s(href|xlink:href)\s*=\s*'(?:(?:javascript|data):[^']*)'/gi, '');
  return out;
}

function findNearestAnchorWithLink(start: Element): SVGElement | HTMLAnchorElement | null {
  let cur: Element | null = start;
  while (cur) {
    if (cur.tagName.toLowerCase() === 'a') {
      const href =
        cur.getAttribute('href') ??
        cur.getAttribute('xlink:href') ??
        cur.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') ??
        '';
      if (href && href.trim().length > 0) return cur as any;
    }
    cur = cur.parentElement;
  }
  return null;
}

function isProbablyWindows(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as any).userAgentData?.platform ?? navigator.platform ?? '';
  return /win/i.test(String(platform));
}

async function svgStringToPngBlob(svgText: string, width: number, height: number): Promise<Blob> {
  const svgWithHeader = svgText.trimStart().startsWith('<?xml')
    ? svgText
    : `<?xml version="1.0" encoding="UTF-8"?>\n${svgText}`;

  const svgBlob = new Blob([svgWithHeader], { type: 'image/svg+xml' });
  const blobUrl = URL.createObjectURL(svgBlob);

  // Some WebViews fail to load blob: SVG URLs for Image(). Use a data: URL fallback.
  let dataUrl: string | null = null;
  try {
    dataUrl = `data:image/svg+xml;base64,${utf8StringToBase64(svgWithHeader)}`;
  } catch {
    dataUrl = null;
  }

  try {
    const loadImage = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new window.Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load SVG image'));
        image.src = src;
      });

    let img: HTMLImageElement;
    try {
      img = await loadImage(blobUrl);
    } catch (err) {
      if (!dataUrl) throw err;
      img = await loadImage(dataUrl);
    }

    const dpr = window.devicePixelRatio || 1;
    let pixelWidth = Math.max(1, Math.round(width * dpr));
    let pixelHeight = Math.max(1, Math.round(height * dpr));

    // Avoid generating extremely large clipboard images (can be slow / OOM).
    const maxSide = 4096;
    const maxArea = 4096 * 4096;
    let scale = 1;
    if (pixelWidth > maxSide || pixelHeight > maxSide) {
      scale = Math.min(scale, maxSide / pixelWidth, maxSide / pixelHeight);
    }
    if (pixelWidth * pixelHeight > maxArea) {
      scale = Math.min(scale, Math.sqrt(maxArea / (pixelWidth * pixelHeight)));
    }
    if (scale < 1) {
      pixelWidth = Math.max(1, Math.round(pixelWidth * scale));
      pixelHeight = Math.max(1, Math.round(pixelHeight * scale));
    }

    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context not available');

    // Fill background for better readability when pasting into other apps.
    const isDark = document.documentElement.classList.contains('dark');
    ctx.fillStyle = isDark ? '#111827' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to create PNG blob'));
        },
        'image/png',
        0.92
      );
    });

    return pngBlob;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function renderMermaidSvgForExport(code: string): Promise<string> {
  const exportId = generateMermaidId();
  const exportCode = addMermaidInitDirective(code, { htmlLabels: false });
  const { svg } = await mermaid.render(exportId, exportCode);
  return sanitizeMermaidSvg(svg);
}

const MermaidBlock = React.memo(function MermaidBlock({ code, tryOpenFileReferenceToken }: MermaidBlockProps) {
	const [svg, setSvg] = useState<string>('');
	const [error, setError] = useState<string>('');
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [scale, setScale] = useState(1.5);

		const [copiedText, setCopiedText] = useState(false);
		const [copiedImage, setCopiedImage] = useState(false);
		const [isCopyingImage, setIsCopyingImage] = useState(false);
		const containerRef = useRef<HTMLDivElement | null>(null);
		const fullscreenScrollRef = useRef<HTMLDivElement | null>(null);
		const fullscreenPanRef = useRef<{
			active: boolean;
			pointerId: number | null;
			startX: number;
			startY: number;
			startScrollLeft: number;
			startScrollTop: number;
			moved: boolean;
			blockNextClickUntilMs: number;
			pendingScrollLeft: number;
			pendingScrollTop: number;
			rafId: number | null;
		}>({
			active: false,
			pointerId: null,
			startX: 0,
			startY: 0,
			startScrollLeft: 0,
			startScrollTop: 0,
			moved: false,
			blockNextClickUntilMs: 0,
			pendingScrollLeft: 0,
			pendingScrollTop: 0,
			rafId: null,
		});

  const cleanCode = useMemo(() => code.trim().replace(/\r\n/g, '\n'), [code]);
  const cacheKey = useMemo(() => hashCode(cleanCode), [cleanCode]);

  // ESC key to close fullscreen
  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    let cancelled = false;

    if (!cleanCode) {
      setError('Empty diagram code');
      return;
    }

    const cached = getMermaidCache(cacheKey);
    if (cached) {
      setSvg(cached);
      setError('');
      return;
    }

    const renderDiagram = async () => {
      try {
        const diskSvg = await getMermaidSvgCacheFromDisk(cacheKey);

        if (cancelled) return;

        if (diskSvg) {
          const cleaned = sanitizeMermaidSvg(diskSvg);
          setMermaidCache(cacheKey, cleaned);
          setSvg(cleaned);
          setError('');
          return;
        }

        const renderId = generateMermaidId();
        await mermaid.parse(cleanCode);

        if (cancelled) return;

        const { svg: renderedSvg } = await mermaid.render(renderId, cleanCode);

        if (cancelled) return;

        const cleaned = sanitizeMermaidSvg(renderedSvg);
        setMermaidCache(cacheKey, cleaned);
        setSvg(cleaned);
        setError('');

        // Best-effort 落盘缓存（不阻塞 UI）
        void setMermaidSvgCacheToDisk(cacheKey, cleaned);
      } catch (err) {
        if (cancelled) return;

        const errorMsg = err instanceof Error ? err.message : 'Failed to render diagram';
        console.warn('[Mermaid] Parse/render error:', errorMsg);
        setError(errorMsg);
      }
    };

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [cleanCode, cacheKey]);

  const handleCopyText = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(cleanCode);
        setCopiedText(true);
        window.setTimeout(() => setCopiedText(false), 2000);
      } catch (err) {
        console.warn('[Mermaid] Failed to copy text:', err);
      }
    },
    [cleanCode]
  );

  const handleCopyImage = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        setIsCopyingImage(true);

        const svgEl = (containerRef.current?.querySelector('svg') ?? null) as SVGSVGElement | null;
        const svgSourceRaw = svgEl ? new XMLSerializer().serializeToString(svgEl) : svg;

        let width = 0;
        let height = 0;

        if (svgEl) {
          const rect = svgEl.getBoundingClientRect();
          width = rect.width;
          height = rect.height;

          if ((!width || !height) && svgEl.viewBox?.baseVal) {
            width = width || svgEl.viewBox.baseVal.width;
            height = height || svgEl.viewBox.baseVal.height;
          }
        }

        if (!width || !height) {
          const widthMatch = svgSourceRaw.match(/width=\"([\d.]+)(?:px)?\"/i);
          const heightMatch = svgSourceRaw.match(/height=\"([\d.]+)(?:px)?\"/i);
          if (!width && widthMatch) width = Number.parseFloat(widthMatch[1]);
          if (!height && heightMatch) height = Number.parseFloat(heightMatch[1]);
        }

        if (!width || !height) {
          const viewBoxMatch = svgSourceRaw.match(/viewBox=\"([^\"]+)\"/i);
          if (viewBoxMatch) {
            const parts = viewBoxMatch[1].trim().split(/\s+/).map((v) => Number.parseFloat(v));
            if (parts.length === 4) {
              width = width || parts[2];
              height = height || parts[3];
            }
          }
        }

        if (!Number.isFinite(width) || width <= 0) width = 800;
        if (!Number.isFinite(height) || height <= 0) height = 600;

        let svgSource = patchSvgForExport(svgSourceRaw, width, height);
        let pngBlob: Blob | null = null;
        let lastPngErr: unknown = null;

        try {
          pngBlob = await svgStringToPngBlob(svgSource, width, height);
        } catch (err) {
          lastPngErr = err;
        }

        // Windows WebView2 can be picky about rasterizing Mermaid SVGs (esp. those with <foreignObject> labels).
        // As a fallback, re-render the diagram with `htmlLabels: false` to produce a simpler SVG for export.
        if (!pngBlob && isProbablyWindows()) {
          try {
            const exportSvg = await renderMermaidSvgForExport(cleanCode);
            svgSource = patchSvgForExport(exportSvg, width, height);
            pngBlob = await svgStringToPngBlob(svgSource, width, height);
          } catch (err) {
            lastPngErr = err;
          }
        }

        if (!pngBlob) {
          throw (lastPngErr instanceof Error ? lastPngErr : new Error('Failed to create PNG'));
        }

        // Prefer OS-native clipboard in Tauri to ensure pasting behaves like a screenshot (esp. macOS WKWebView).
        let copied = false;

        if (isTauriRuntime()) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const pngBase64 = await blobToPngBase64(pngBlob);
            try {
              await invoke('clipboard_write_png_base64', { pngBase64 });
            } catch (err) {
              // Compatibility fallback: accept snake_case key as well.
              await invoke('clipboard_write_png_base64', { png_base64: pngBase64 } as any);
            }
            copied = true;
          } catch (tauriErr) {
            console.warn('[Mermaid] Tauri clipboard image copy failed, fallback to Web API:', tauriErr);
          }
        }

        if (!copied) {
          const clipboardWrite = (navigator.clipboard as any)?.write as undefined | ((data: any[]) => Promise<void>);
          const ClipboardItemCtor = (window as any).ClipboardItem as any;
          if (!clipboardWrite || !ClipboardItemCtor) {
            throw new Error('Clipboard image API not supported');
          }
          await clipboardWrite([new ClipboardItemCtor({ 'image/png': pngBlob })]);
          copied = true;
        }

        setCopiedImage(true);
        window.setTimeout(() => setCopiedImage(false), 2000);
      } catch (err) {
        console.warn('[Mermaid] Failed to copy image:', err);

        // Fallback: copy SVG text so user can still paste something usable.
        try {
          await navigator.clipboard.writeText(svg);
          setCopiedImage(true);
          window.setTimeout(() => setCopiedImage(false), 2000);
        } catch (fallbackErr) {
          console.warn('[Mermaid] Fallback copy SVG failed:', fallbackErr);
        }
      } finally {
        setIsCopyingImage(false);
      }
    },
    [svg, cleanCode]
  );

		// Fullscreen mouse pan handlers（基于原生 scrollTop/scrollLeft；仅鼠标，避免干扰触屏惯性滚动）
		const handleFullscreenPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
			if (e.pointerType && e.pointerType !== 'mouse') return;
			if (e.button !== 0) return;
			if (!e.isPrimary) return;
			const scroller = fullscreenScrollRef.current;
			if (!scroller) return;

			// 如果点在链接上，优先保留点击语义（文件引用等）
			const target = e.target as Element | null;
			if (target && findNearestAnchorWithLink(target)) return;

			// 避免在滚动条区域误触发拖拽平移
			const rect = scroller.getBoundingClientRect();
			const sbW = scroller.offsetWidth - scroller.clientWidth;
			const sbH = scroller.offsetHeight - scroller.clientHeight;
			if (sbW > 0 && e.clientX >= rect.right - sbW - 2) return;
			if (sbH > 0 && e.clientY >= rect.bottom - sbH - 2) return;

			const st = fullscreenPanRef.current;
			st.active = true;
			st.pointerId = e.pointerId;
			st.startX = e.clientX;
			st.startY = e.clientY;
			st.startScrollLeft = scroller.scrollLeft;
			st.startScrollTop = scroller.scrollTop;
			st.moved = false;
			st.blockNextClickUntilMs = 0;
			st.pendingScrollLeft = scroller.scrollLeft;
			st.pendingScrollTop = scroller.scrollTop;

			try {
				scroller.setPointerCapture(e.pointerId);
			} catch {
				// ignore
			}
		}, []);

		const handleFullscreenPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
			const st = fullscreenPanRef.current;
			if (!st.active) return;
			if (st.pointerId !== e.pointerId) return;

			const scroller = fullscreenScrollRef.current;
			if (!scroller) return;

			const dx = e.clientX - st.startX;
			const dy = e.clientY - st.startY;
			if (!st.moved && (Math.abs(dx) >= 3 || Math.abs(dy) >= 3)) {
				st.moved = true;
			}
			if (!st.moved) return;

			st.pendingScrollLeft = st.startScrollLeft - dx;
			st.pendingScrollTop = st.startScrollTop - dy;
			st.blockNextClickUntilMs = Date.now() + 400;

			if (st.rafId === null) {
				st.rafId = requestAnimationFrame(() => {
					const next = fullscreenPanRef.current;
					next.rafId = null;
					const sc = fullscreenScrollRef.current;
					if (!sc) return;
					sc.scrollLeft = next.pendingScrollLeft;
					sc.scrollTop = next.pendingScrollTop;
				});
			}

			// Prevent click-through when panning.
			e.preventDefault();
		}, []);

		const handleFullscreenPointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
			const st = fullscreenPanRef.current;
			if (st.pointerId !== e.pointerId) return;

			st.active = false;
			st.pointerId = null;

			const scroller = fullscreenScrollRef.current;
			if (scroller && st.moved) {
				scroller.scrollLeft = st.pendingScrollLeft;
				scroller.scrollTop = st.pendingScrollTop;
			}

			st.moved = false;

			if (st.rafId !== null) {
				cancelAnimationFrame(st.rafId);
				st.rafId = null;
			}

			if (!scroller) return;
			try {
				scroller.releasePointerCapture(e.pointerId);
			} catch {
				// ignore
			}
		}, []);

		const handleFullscreenClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
			const st = fullscreenPanRef.current;
			if (!st.blockNextClickUntilMs) return;
			if (Date.now() > st.blockNextClickUntilMs) {
				st.blockNextClickUntilMs = 0;
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			st.blockNextClickUntilMs = 0;
		}, []);

		if (error) {
			return (
				<div className="my-2 rounded-lg bg-red-900/20 p-4 text-red-400">
					<p className="text-sm font-medium">Mermaid 渲染失败</p>
				<p className="mt-1 text-xs opacity-70">{error}</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs opacity-70 bg-red-900/10 p-2 rounded">{code}</pre>
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

  const handleSvgClickCapture = (e: React.SyntheticEvent) => {
    const el = e.target as Element | null;
    if (!el) return;
    const anchor = findNearestAnchorWithLink(el);
    if (!anchor) return;

    const hrefRaw =
      anchor.getAttribute('href') ??
      anchor.getAttribute('xlink:href') ??
      anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      '';

    const token = parseFileReferenceTokenFromHref(hrefRaw);
    if (!token) return;
    if (!tryOpenFileReferenceToken) return;

    const handled = tryOpenFileReferenceToken(token);
    if (!handled) return;

    // IMPORTANT: 用 capture 阶段拦截，避免 Mermaid 生成的 target/onclick 先于外层 onClick 执行。
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <div className="group relative my-2 w-full">
        <div
          className={[
            'absolute right-2 top-2 z-10 flex items-center gap-2',
            'opacity-0 pointer-events-none transition-opacity',
            'group-hover:opacity-100 group-hover:pointer-events-auto',
            'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
          ].join(' ')}
        >
          <button
            type="button"
            className="flex items-center gap-1.5 rounded bg-white/90 dark:bg-gray-800/90 px-2.5 py-1 text-xs text-gray-700 dark:text-gray-200 shadow hover:bg-white dark:hover:bg-gray-800 transition-colors"
            onClick={handleCopyText}
            title={copiedText ? '已复制 Mermaid 文本' : '复制 Mermaid 文本'}
          >
            {copiedText ? <Check size={14} /> : <Copy size={14} />}
            <span className="text-xs">{copiedText ? '已复制' : '复制文本'}</span>
          </button>

          <button
            type="button"
            disabled={isCopyingImage}
            className="flex items-center gap-1.5 rounded bg-white/90 dark:bg-gray-800/90 px-2.5 py-1 text-xs text-gray-700 dark:text-gray-200 shadow hover:bg-white dark:hover:bg-gray-800 transition-colors disabled:opacity-60"
            onClick={handleCopyImage}
            title={copiedImage ? '已复制图片（或已复制 SVG 作为兜底）' : '复制 Mermaid 图片'}
          >
            {copiedImage ? <Check size={14} /> : <ImageIcon size={14} />}
            <span className="text-xs">{isCopyingImage ? '复制中…' : copiedImage ? '已复制' : '复制图片'}</span>
          </button>
        </div>

        <div
          ref={containerRef}
          className="w-full overflow-x-auto rounded-lg bg-gray-100 dark:bg-gray-700/50 p-4 cursor-zoom-in flex justify-center [&_svg]:max-w-none"
          onClickCapture={handleSvgClickCapture}
          onClick={(e) => {
            // 如果点的是链接，就不进入全屏（否则“链接不可用”）。
            if (e.defaultPrevented) return;
            setIsFullscreen(true);
          }}
          title="点击放大查看"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {/* Fullscreen Modal */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setIsFullscreen(false)}
          onWheel={(e) => {
            if (e.ctrlKey) {
              e.preventDefault();
              setScale(s => {
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                return Math.min(4, Math.max(0.5, s + delta));
              });
            }
          }}
        >
          {/* Zoom Controls */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white dark:bg-gray-700 rounded-lg shadow px-3 py-2">
            <button
              className="px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-600 text-lg font-bold"
              onClick={(e) => { e.stopPropagation(); setScale(s => Math.max(0.5, s - 0.25)); }}
            >
              −
            </button>
            <span className="min-w-[60px] text-center text-sm">{Math.round(scale * 100)}%</span>
            <button
              className="px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-600 text-lg font-bold"
              onClick={(e) => { e.stopPropagation(); setScale(s => Math.min(4, s + 0.25)); }}
            >
              +
            </button>
            <button
              className="ml-2 px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-600 text-sm"
              onClick={(e) => { e.stopPropagation(); setScale(1); }}
            >
              重置
            </button>
            <span className="ml-2 text-xs text-gray-500">Ctrl+滚轮缩放</span>
          </div>

					<div
						ref={fullscreenScrollRef}
						className="w-[90vw] h-[85vh] mt-12 overflow-auto bg-white dark:bg-gray-800 rounded-lg p-6 select-none cursor-grab active:cursor-grabbing"
						onClick={(e) => e.stopPropagation()}
						onPointerDown={handleFullscreenPointerDown}
						onPointerMove={handleFullscreenPointerMove}
						onPointerUp={handleFullscreenPointerUpOrCancel}
						onPointerCancel={handleFullscreenPointerUpOrCancel}
						onClickCapture={handleFullscreenClickCapture}
					>
						<div
							style={{ transform: `scale(${scale})`, transformOrigin: 'top left', marginBottom: `${(scale - 1) * 100}%` }}
              onClickCapture={handleSvgClickCapture}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>

          <div className="absolute top-4 right-4 flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-2 bg-white dark:bg-gray-700 rounded shadow hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors text-sm"
              onClick={handleCopyText}
              title={copiedText ? '已复制 Mermaid 文本' : '复制 Mermaid 文本'}
            >
              {copiedText ? '已复制文本' : '复制文本'}
            </button>
            <button
              type="button"
              className="px-3 py-2 bg-white dark:bg-gray-700 rounded shadow hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors text-sm disabled:opacity-60"
              disabled={isCopyingImage}
              onClick={handleCopyImage}
              title={copiedImage ? '已复制图片（或已复制 SVG 作为兜底）' : '复制 Mermaid 图片'}
            >
              {isCopyingImage ? '复制中…' : copiedImage ? '已复制图片' : '复制图片'}
            </button>
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
});

// ============================================================================
// Main MarkdownRenderer Component
// ============================================================================

export const MarkdownRenderer = React.memo(function MarkdownRendererImpl({ content, conversationId, workstudioId }: MarkdownRendererProps) {
  // 高频更新（例如 streaming）时，markdown 解析/高亮很容易成为主线程热点。
  // 用 deferred value 把昂贵的渲染降为低优先级，减少“每次增量都重解析”的抖动。
  const deferredContent = useDeferredValue(content);
  const renderContent = content.length > 800 ? deferredContent : content;

  const openFileReference = useCallback(async (ref: ParsedFileReference) => {
    if (!isTauriRuntime()) return;

    try {
      let windowLabel: string | null = null;
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        windowLabel = getCurrentWebviewWindow().label;
      } catch {
        windowLabel = null;
      }

      dbgOpenFile('click:fileRef', {
        fromWindowLabel: windowLabel,
        conversationId: conversationId ?? null,
        workstudioId: workstudioId ?? null,
        ref,
      });

      const [{ invoke }, { openOrFocusWorkstudioWindow }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('../../utils/viewWindow'),
      ]);

      let resolvedWorkstudioId: string | null = workstudioId ?? null;
      let ws: Workstudio | null = null;

      if (!resolvedWorkstudioId && conversationId) {
        dbgOpenFile('ensure_workstudio_for_conversation:begin', { conversationId, fromWindowLabel: windowLabel });
        ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
        resolvedWorkstudioId = ws.id;
        dbgOpenFile('ensure_workstudio_for_conversation:ok', { workstudioId: resolvedWorkstudioId, mainFolder: ws.mainFolder });
      }

      if (!resolvedWorkstudioId) {
        console.warn('openFileReference skipped: missing workstudio context');
        dbgOpenFile('openFileReference:skipped_missing_context', {
          fromWindowLabel: windowLabel,
          conversationId: conversationId ?? null,
          workstudioId: workstudioId ?? null,
          ref,
        });
        return;
      }

      if (!ws) {
        try {
          ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId: resolvedWorkstudioId });
        } catch {
          // ignore
        }
      }

      // If the provided workstudioId is stale (e.g. merged by mainFolder de-dup), fall back to
      // resolving from conversation binding so we always target the canonical id.
      if (!ws && conversationId) {
        try {
          dbgOpenFile('ensure_workstudio_for_conversation:fallback', {
            conversationId,
            fromWindowLabel: windowLabel,
            attemptedWorkstudioId: resolvedWorkstudioId,
          });
          ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
          resolvedWorkstudioId = ws.id;
        } catch {
          // ignore
        }
      }

      const title = ws ? `Workstudio: ${ws.mainFolder}` : 'Workstudio';
      dbgOpenFile('openOrFocusWorkstudioWindow:begin', {
        fromWindowLabel: windowLabel,
        title,
        workstudioId: resolvedWorkstudioId,
        mainFolder: ws?.mainFolder ?? null,
        filePath: ref.filePath,
        line: ref.line,
        column: ref.column,
        endLine: ref.endLine,
        endColumn: ref.endColumn,
      });
      await openOrFocusWorkstudioWindow(title, {
        workstudioId: resolvedWorkstudioId,
        mainFolder: ws?.mainFolder ?? null,
        filePath: ref.filePath,
        line: ref.line,
        column: ref.column,
        endLine: ref.endLine,
        endColumn: ref.endColumn,
      });
      dbgOpenFile('openOrFocusWorkstudioWindow:done', { fromWindowLabel: windowLabel, workstudioId: resolvedWorkstudioId });
    } catch (error) {
      console.warn('openFileReference failed:', error);
      dbgOpenFile('openFileReference:failed', { error: String(error) });
    }
  }, [conversationId, workstudioId]);

  const openFilePath = useCallback(
    async (filePath: string): Promise<void> => {
      if (!isTauriRuntime()) return;

      try {
        const [{ invoke }, { openOrFocusWorkstudioWindow }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('../../utils/viewWindow'),
        ]);

        let resolvedWorkstudioId: string | null = workstudioId ?? null;
        let ws: Workstudio | null = null;

        if (!resolvedWorkstudioId && conversationId) {
          ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
          resolvedWorkstudioId = ws.id;
        }

        if (!resolvedWorkstudioId) {
          console.warn('openFilePath skipped: missing workstudio context');
          return;
        }

        if (!ws) {
          try {
            ws = await invoke<Workstudio | null>('get_workstudio', { workstudioId: resolvedWorkstudioId });
          } catch {
            // ignore
          }
        }

        if (!ws && conversationId) {
          try {
            ws = await invoke<Workstudio>('ensure_workstudio_for_conversation', { conversationId });
            resolvedWorkstudioId = ws.id;
          } catch {
            // ignore
          }
        }

      const title = ws ? `Workstudio: ${ws.mainFolder}` : 'Workstudio';
      await openOrFocusWorkstudioWindow(title, {
        workstudioId: resolvedWorkstudioId,
        mainFolder: ws?.mainFolder ?? null,
        filePath,
      });
    } catch (error) {
      console.warn('openFilePath failed:', error);
    }
    },
    [conversationId, workstudioId]
  );

  const tryOpenFileReferenceToken = useCallback(
    (token: string): boolean => {
      const ref = parseFileReferenceToken(token);
      if (ref) {
        void openFileReference(ref);
        return true;
      }

      // Mermaid click(...) 允许没有行号的文件路径：只要像路径就打开文件。
      if (looksLikeFilePath(token)) {
        void openFilePath(token.trim());
        return true;
      }

      return false;
    },
    [openFilePath, openFileReference]
  );

  // Memoize components object to prevent recreation on each render
 	  const components = useMemo(() => ({
    a: ({ href, children, ...props }: any) => {
      const hrefStr = typeof href === 'string' ? href : '';
      const tauri = isTauriRuntime();
      const token = hrefStr ? parseFileReferenceTokenFromHref(hrefStr) : null;
      const fileRef = token ? parseFileReferenceToken(token) : null;
      const filePathToken = !fileRef && token && looksLikeFilePath(token) ? token.trim() : null;
      const canOpenFileRef = Boolean(fileRef) && tauri && Boolean(conversationId || workstudioId);
      const canOpenFilePath = Boolean(filePathToken) && tauri && Boolean(conversationId || workstudioId);
      const canOpenWebTab = tauri && looksLikeWebUrl(hrefStr);

      // 非 Tauri 环境：保持原生链接行为（浏览器预览/测试环境）。
      if (!tauri) {
        return (
          <a href={hrefStr} {...props}>
            {children}
          </a>
        );
      }

      const computedTitle = (() => {
        if (fileRef) {
          const base = fileRef.filePath;
          const start = fileRef.column ? `${fileRef.line}:${fileRef.column}` : `${fileRef.line}`;
          if (typeof fileRef.endLine === 'number') {
            const end = fileRef.endColumn ? `${fileRef.endLine}:${fileRef.endColumn}` : `${fileRef.endLine}`;
            return `打开 ${base} (${start}-${end})`;
          }
          return `打开 ${base} (${start})`;
        }
        if (filePathToken) {
          return `打开 ${filePathToken}`;
        }
        if (canOpenWebTab) return hrefStr;
        return undefined;
      })();
      const title = (props as any)?.title ?? computedTitle;

      return (
        <a
          href={hrefStr}
          {...props}
          title={title}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (fileRef) {
              if (!canOpenFileRef) return;
              void openFileReference(fileRef);
              return;
            }
            if (filePathToken) {
              if (!canOpenFilePath) return;
              void openFilePath(filePathToken);
              return;
            }
            if (canOpenWebTab) {
              const id = useWebTabStore.getState().openWebTab(hrefStr, { activate: true });
              useWindowLayoutStore.getState().openTabInFocusedPane(toWorkspaceWebTabId(id));
            }
          }}
        >
          {children}
        </a>
      );
    },
    code({ inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match?.[1] || '';
      const codeStr = String(children).replace(/\n$/, '');

      if (language === 'mermaid') {
        return <MermaidBlock code={codeStr} tryOpenFileReferenceToken={tryOpenFileReferenceToken} />;
      }

      if (language === 'plot' || language === 'mafs' || (language === 'json' && className?.includes('mafs'))) {
        return <MathBlock code={codeStr} />;
      }

      if (match || codeStr.includes('\n')) {
        return <CodeBlock language={language} code={codeStr} />;
      }

      const fileRef = parseFileReferenceToken(codeStr);
      if (fileRef) {
        const tauri = isTauriRuntime();
        const canOpen = tauri && Boolean(conversationId || workstudioId);
        const title = !tauri
          ? '仅桌面端可用'
          : !canOpen
            ? '缺少工作区上下文（先打开一个对话/工作区）'
            : fileRef.column
              ? `打开 ${fileRef.filePath}:${fileRef.line}:${fileRef.column}`
              : `打开 ${fileRef.filePath}:${fileRef.line}`;

        const baseName = (() => {
          const normalized = fileRef.filePath.replace(/[\\/]+/g, '/');
          return normalized.split('/').pop() || fileRef.filePath;
        })();

        const lineLabel = (() => {
          const start = fileRef.column ? `${fileRef.line}:${fileRef.column}` : `${fileRef.line}`;
          if (typeof fileRef.endLine === 'number') {
            const end = fileRef.endColumn ? `${fileRef.endLine}:${fileRef.endColumn}` : `${fileRef.endLine}`;
            return `line ${start}-${end}`;
          }
          return `line ${start}`;
        })();

        return (
          <button
            type="button"
            disabled={!canOpen}
            aria-label={codeStr}
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-sm font-mono text-blue-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-900/30 dark:text-blue-200"
            title={title}
            onClick={() => {
              if (!canOpen) return;
              void openFileReference(fileRef);
            }}
          >
            <FileCode2 size={14} className="shrink-0 opacity-80" />
            <span className="truncate">{baseName}</span>
            <span className="shrink-0 opacity-70">({lineLabel})</span>
          </button>
        );
      }

      return (
        <code
          className="rounded bg-gray-100 px-1.5 py-0.5 text-sm dark:bg-gray-700"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }: any) {
      return <>{children}</>;
    },
    kbd: ({ children, ...props }: any) => (
      <kbd
        className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-700"
        {...props}
      >
        {children}
      </kbd>
    ),
    mark: ({ children, ...props }: any) => (
      <mark
        className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-800 dark:text-yellow-100"
        {...props}
      >
        {children}
      </mark>
    ),
    details: ({ children, ...props }: any) => {
      const parts = React.Children.toArray(children);
      const isSummary = (p: unknown): p is React.ReactElement =>
        React.isValidElement(p) &&
        (p.type === 'summary' || p.type === MarkdownDetailsSummary);

      let summaryPart: React.ReactElement | null = null;
      const bodyParts: React.ReactNode[] = [];
      for (const p of parts) {
        if (!summaryPart && isSummary(p)) {
          summaryPart = p;
          continue;
        }
        bodyParts.push(p);
      }

      const bodyText = bodyParts.filter((p) => typeof p === 'string').join('');
      const bodyNodes = bodyParts.filter((p) => typeof p !== 'string');
      const hasBodyMarkdown = bodyText.trim().length > 0;

      return (
        <details
          className="my-2 rounded-lg border border-gray-200 dark:border-gray-700"
          {...props}
        >
          {summaryPart ?? <MarkdownDetailsSummary>详情</MarkdownDetailsSummary>}
          {(hasBodyMarkdown || bodyNodes.length > 0) && (
            <div className="px-4 py-3">
              {hasBodyMarkdown && (
                <MarkdownRenderer
                  content={bodyText}
                  conversationId={conversationId}
                  workstudioId={workstudioId}
                />
              )}
              {bodyNodes.length > 0 && <div className={hasBodyMarkdown ? 'mt-2' : ''}>{bodyNodes}</div>}
            </div>
          )}
        </details>
      );
    },
    summary: MarkdownDetailsSummary,
    table: ({ children }: any) => (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {children}
        </table>
      </div>
    ),
    th: ({ children }: any) => (
      <th className="bg-gray-100 px-4 py-2 text-left text-sm font-semibold dark:bg-gray-800">
        {children}
      </th>
    ),
    td: ({ children }: any) => (
      <td className="border-t border-gray-200 px-4 py-2 text-sm dark:border-gray-700">
        {children}
      </td>
    ),
  }), [conversationId, openFileReference, tryOpenFileReferenceToken, workstudioId]);

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-transparent prose-pre:p-0">
      <CommonMarkdown content={renderContent} components={components} />
    </div>
  );
});

export default MarkdownRenderer;
