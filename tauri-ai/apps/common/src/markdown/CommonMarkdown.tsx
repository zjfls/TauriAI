import { memo, useMemo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkGemoji from "remark-gemoji";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import DOMPurify from "dompurify";

import "katex/dist/katex.min.css";

interface ProtectedContent {
  text: string;
  blocks: Map<string, string>;
}

// 修复“表格被压平成一行”的常见错误：
// 例如：
// | A | B ||---|---|| 1 | 2 || 3 | 4 |
// 会被修复为：
// | A | B |
// |---|---|
// | 1 | 2 |
// | 3 | 4 |
//
// 仅在“整行看起来像 GFM 表格且包含分隔行”时触发，避免影响普通文本中的 `||`。
function repairFlattenedGfmTableRows(text: string): string {
  if (!text || !text.includes("||")) return text;

  const lines = text.split("\n");
  let changed = false;

  const repaired = lines.map((line) => {
    if (!line.includes("||")) return line;
    if (!line.trimStart().startsWith("|")) return line;
    if (!/\|\s*:?-{3,}/.test(line)) return line;

    const pipeCount = (line.match(/\|/g) ?? []).length;
    if (pipeCount < 6) return line;

    const next = line.replace(/\|\|/g, "|\n|");
    if (next !== line) changed = true;
    return next;
  });

  return changed ? repaired.join("\n") : text;
}

// Protect LaTeX / Mermaid / code blocks before DOMPurify processing.
// This prevents DOMPurify from escaping < > & inside these expressions.
// It also normalizes \[...\] and \(...\) to $$...$$ and $...$ so markdown won't eat the backslashes.
function protectContent(content: string): ProtectedContent {
  const blocks = new Map<string, string>();
  let counter = 0;
  let result = content ?? "";

  const generatePlaceholder = () => `%%PROTECTED_BLOCK_${counter++}_${Date.now()}%%`;

  // Mermaid fences first (may contain arrows / symbols that look like HTML)
  result = result.replace(/```mermaid\s*([\s\S]*?)```/g, (match) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, match);
    return placeholder;
  });

  // plot/mafs fences (avoid "math" which conflicts with remarkMath)
  result = result.replace(/```(?:plot|mafs|json\s+mafs)\s*([\s\S]*?)```/g, (match) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, match);
    return placeholder;
  });

  // All other fenced code blocks
  result = result.replace(/```[^\n]*\s*[\s\S]*?```/g, (match) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, match);
    return placeholder;
  });

  // Inline code spans
  result = result.replace(/`[^`\n]+`/g, (match) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, match);
    return placeholder;
  });

  // Block math: $$...$$
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, match);
    return placeholder;
  });

  // \[...\] -> $$...$$
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, `$$${inner}$$`);
    return placeholder;
  });

  // \(...\) -> $...$
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => {
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, `$${inner}$`);
    return placeholder;
  });

  // Inline math: $...$ (single line, non-greedy). Skip currency like "$5".
  result = result.replace(/\$([^\$\n]+?)\$/g, (match, inner) => {
    if (/^\d+(\.\d+)?$/.test(String(inner).trim())) return match;
    const placeholder = generatePlaceholder();
    blocks.set(placeholder, match);
    return placeholder;
  });

  return { text: result, blocks };
}

function restoreContent(content: string, blocks: Map<string, string>): string {
  let result = content ?? "";
  blocks.forEach((original, placeholder) => {
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), () => original);

    // Also handle HTML-escaped placeholder (extra safety)
    const htmlEscaped = placeholder
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (htmlEscaped !== placeholder) {
      const escapedHtml = htmlEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escapedHtml, "g"), () => original);
    }
  });
  return result;
}

export function preprocessMarkdown(content: string): string {
  const { text: protectedText, blocks } = protectContent(content ?? "");
  const normalized = repairFlattenedGfmTableRows(protectedText);

  const sanitized = DOMPurify.sanitize(normalized, {
    ADD_TAGS: ["details", "summary", "kbd", "mark", "sub", "sup"],
    ADD_ATTR: ["open"],
  });

  let result = restoreContent(sanitized, blocks);
  result = result.replace(/&amp;/g, "&");
  return result;
}

export type CommonMarkdownProps = {
  content: string;
  components?: Components;
};

// 缓存：避免长对话滚动/窗口化渲染时，重复对同一段文本做 DOMPurify + 预处理。
// - 只缓存“中等长度”文本，避免把超长内容长期留在内存里
// - LRU（Map 的迭代顺序即插入顺序）：命中时移动到末尾
const PREPROCESS_CACHE_MAX_ENTRIES = 200;
const PREPROCESS_CACHE_MAX_INPUT_CHARS = 120_000;
const preprocessCache = new Map<string, string>();

function getPreprocessCache(input: string): string | null {
  const hit = preprocessCache.get(input);
  if (hit === undefined) return null;
  preprocessCache.delete(input);
  preprocessCache.set(input, hit);
  return hit;
}

function setPreprocessCache(input: string, processed: string): void {
  if (input.length > PREPROCESS_CACHE_MAX_INPUT_CHARS) return;
  if (preprocessCache.has(input)) preprocessCache.delete(input);
  preprocessCache.set(input, processed);
  while (preprocessCache.size > PREPROCESS_CACHE_MAX_ENTRIES) {
    const oldest = preprocessCache.keys().next().value as string | undefined;
    if (!oldest) break;
    preprocessCache.delete(oldest);
  }
}

const urlTransform = (value: string): string => {
  const url = (value ?? "").trim();
  if (!url) return url;

  // Allow our internal file-open link scheme.
  if (/^tauri-ai:/i.test(url)) return url;

  // Allow Windows absolute paths in markdown links, e.g.:
  // - E:/work/TauriAI/foo.rs
  // - E:\work\TauriAI\foo.rs
  if (/^[A-Za-z]:[\\/]/.test(url)) return url;

  // Preserve default sanitization for everything else.
  return defaultUrlTransform(url);
};

export const CommonMarkdown = memo(function CommonMarkdown({ content, components }: CommonMarkdownProps) {
  const processed = useMemo(() => {
    const raw = content ?? "";
    if (!raw) return "";
    const cached = getPreprocessCache(raw);
    if (cached !== null) return cached;
    const next = preprocessMarkdown(raw);
    setPreprocessCache(raw, next);
    return next;
  }, [content]);

  const katexOptions = useMemo(
    () => ({
      throwOnError: false,
      errorColor: "#cc0000",
    }),
    []
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
      rehypePlugins={[[rehypeKatex, katexOptions], rehypeRaw]}
      components={components}
      urlTransform={urlTransform}
    >
      {processed}
    </ReactMarkdown>
  );
});
