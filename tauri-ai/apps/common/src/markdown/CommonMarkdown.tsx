import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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

  const sanitized = DOMPurify.sanitize(protectedText, {
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

export function CommonMarkdown({ content, components }: CommonMarkdownProps) {
  const processed = useMemo(() => preprocessMarkdown(content), [content]);

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
    >
      {processed}
    </ReactMarkdown>
  );
}
