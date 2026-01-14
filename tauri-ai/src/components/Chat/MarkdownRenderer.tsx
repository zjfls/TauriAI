import React, { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { Copy, Check } from 'lucide-react';
import 'katex/dist/katex.min.css';

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
});

// ============================================================================
// Mermaid SVG Cache - prevents re-rendering identical diagrams
// ============================================================================
const mermaidCache = new Map<string, string>();
let mermaidIdCounter = 0;

function generateMermaidId(): string {
  return `mermaid-${++mermaidIdCounter}-${Math.random().toString(36).slice(2, 9)}`;
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

// ============================================================================
// Components
// ============================================================================

interface MarkdownRendererProps {
  content: string;
}

interface CodeBlockProps {
  language: string;
  code: string;
}


const CodeBlock = React.memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg">
      <div className="flex items-center justify-between bg-gray-800 px-4 py-2 text-xs text-gray-400">
        <span>{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-2 py-1 hover:bg-gray-700 hover:text-gray-200"
          title="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: '0 0 0.5rem 0.5rem', fontSize: '0.875rem' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

interface MermaidBlockProps {
  code: string;
}

const MermaidBlock = React.memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scale, setScale] = useState(1.5);
  
  const cacheKey = useMemo(() => hashCode(code.trim()), [code]);

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
    
    const cleanCode = code.trim().replace(/\r\n/g, '\n');
    
    if (!cleanCode) {
      setError('Empty diagram code');
      return;
    }

    const cached = mermaidCache.get(cacheKey);
    if (cached) {
      setSvg(cached);
      setError('');
      return;
    }

    const renderDiagram = async () => {
      try {
        const renderId = generateMermaidId();
        await mermaid.parse(cleanCode);
        
        if (cancelled) return;

        const { svg: renderedSvg } = await mermaid.render(renderId, cleanCode);
        
        if (cancelled) return;
        
        mermaidCache.set(cacheKey, renderedSvg);
        setSvg(renderedSvg);
        setError('');
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
  }, [code, cacheKey]);

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

  return (
    <>
      <div
        className="my-2 overflow-x-auto rounded-lg bg-gray-100 dark:bg-gray-700/50 p-4 cursor-zoom-in"
        onClick={() => setIsFullscreen(true)}
        title="点击放大查看"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      
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
            className="w-[90vw] h-[85vh] mt-12 overflow-auto bg-white dark:bg-gray-800 rounded-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{ transform: `scale(${scale})`, transformOrigin: 'top left', marginBottom: `${(scale - 1) * 100}%` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          
          <button
            className="absolute top-4 right-4 px-4 py-2 bg-white dark:bg-gray-700 rounded shadow hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
            onClick={() => setIsFullscreen(false)}
          >
            关闭
          </button>
        </div>
      )}
    </>
  );
});


// ============================================================================
// Main MarkdownRenderer Component
// ============================================================================

export const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  // Preprocess: normalize LaTeX delimiters (only convert paired delimiters)
  const preprocessed = useMemo(() => {
    let result = content;
    
    // Convert paired \[...\] to $$...$$ (block math)
    result = result.replace(/\\\[([\s\S]*?)\\\]/g, '\n$$\n$1\n$$\n');
    
    // Convert paired \(...\) to $...$ (inline math)
    result = result.replace(/\\\(([\s\S]*?)\\\)/g, ' $$$1$$ ');
    
    return result;
  }, [content]);

  // Sanitize HTML content to prevent XSS
  const sanitized = useMemo(() => {
    return DOMPurify.sanitize(preprocessed, {
      ADD_TAGS: ['details', 'summary', 'kbd', 'mark'],
      ADD_ATTR: ['open'],
    });
  }, [preprocessed]);

  // Memoize components object to prevent recreation on each render
  const components = useMemo(() => ({
    code({ className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match?.[1] || '';
      const codeStr = String(children).replace(/\n$/, '');

      if (language === 'mermaid') {
        return <MermaidBlock code={codeStr} />;
      }

      if (match || codeStr.includes('\n')) {
        return <CodeBlock language={language} code={codeStr} />;
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
    details: ({ children, ...props }: any) => (
      <details
        className="my-2 rounded-lg border border-gray-200 dark:border-gray-700"
        {...props}
      >
        {children}
      </details>
    ),
    summary: ({ children, ...props }: any) => (
      <summary
        className="cursor-pointer rounded-t-lg bg-gray-100 px-4 py-2 font-medium dark:bg-gray-800"
        {...props}
      >
        {children}
      </summary>
    ),
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
  }), []);

  // KaTeX options: don't throw on error, show red text for errors
  const katexOptions = useMemo(() => ({
    throwOnError: false,
    errorColor: '#cc0000',
  }), []);

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-transparent prose-pre:p-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions], rehypeRaw]}
        components={components}
      >
        {sanitized}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
