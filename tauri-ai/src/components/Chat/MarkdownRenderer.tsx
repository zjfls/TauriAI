import { useState, useEffect, useRef } from 'react';
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
  theme: 'dark',
  securityLevel: 'loose',
});

interface MarkdownRendererProps {
  content: string;
}

interface CodeBlockProps {
  language: string;
  code: string;
}

function CodeBlock({ language, code }: CodeBlockProps) {
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
}

interface MermaidBlockProps {
  code: string;
}

// Counter for unique mermaid IDs
let mermaidIdCounter = 0;

function MermaidBlock({ code }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const idRef = useRef<string>(`mermaid-${++mermaidIdCounter}-${Date.now()}`);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      // Clean up the code - trim whitespace and normalize line endings
      const cleanCode = code.trim().replace(/\r\n/g, '\n');
      
      if (!cleanCode) {
        setError('Empty diagram code');
        return;
      }

      try {
        // Validate syntax first
        await mermaid.parse(cleanCode);
        
        if (cancelled) return;

        // Render the diagram
        const { svg: renderedSvg } = await mermaid.render(idRef.current, cleanCode);
        
        if (cancelled) return;
        
        setSvg(renderedSvg);
        setError('');
      } catch (err) {
        if (cancelled) return;
        
        const errorMsg = err instanceof Error ? err.message : 'Failed to render diagram';
        console.warn('[Mermaid] Parse/render error:', errorMsg, '\nCode:', cleanCode);
        setError(errorMsg);
      }
    };

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="my-2 rounded-lg bg-red-900/20 p-4 text-red-400">
        <p className="text-sm font-medium">Mermaid 渲染失败</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs opacity-70">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-2 flex justify-center rounded-lg bg-gray-800/50 p-4">
        <span className="text-gray-400 text-sm">Loading diagram...</span>
      </div>
    );
  }

  return (
    <div
      className="my-2 flex justify-center overflow-x-auto rounded-lg bg-gray-800/50 p-4 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  // Preprocess: normalize LaTeX delimiters
  // Convert \[ ... \] to $$ ... $$ (block math)
  // Convert \( ... \) to $ ... $ (inline math)
  const preprocessed = content
    .replace(/\\\[/g, '$$')
    .replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$');

  // Sanitize HTML content to prevent XSS
  const sanitized = DOMPurify.sanitize(preprocessed, {
    ADD_TAGS: ['details', 'summary', 'kbd', 'mark'],
    ADD_ATTR: ['open'],
  });

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-transparent prose-pre:p-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeStr = String(children).replace(/\n$/, '');
            const language = match?.[1] || '';

            // Handle mermaid diagrams
            if (language === 'mermaid') {
              return <MermaidBlock code={codeStr} />;
            }

            // Block code
            if (match || codeStr.includes('\n')) {
              return <CodeBlock language={language} code={codeStr} />;
            }

            // Inline code
            return (
              <code
                className="rounded bg-gray-100 px-1.5 py-0.5 text-sm dark:bg-gray-700"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          // Style HTML tags
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          kbd: ({ children, ...props }: any) => (
            <kbd
              className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-700"
              {...props}
            >
              {children}
            </kbd>
          ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mark: ({ children, ...props }: any) => (
            <mark
              className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-800 dark:text-yellow-100"
              {...props}
            >
              {children}
            </mark>
          ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          details: ({ children, ...props }: any) => (
            <details
              className="my-2 rounded-lg border border-gray-200 dark:border-gray-700"
              {...props}
            >
              {children}
            </details>
          ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          summary: ({ children, ...props }: any) => (
            <summary
              className="cursor-pointer rounded-t-lg bg-gray-100 px-4 py-2 font-medium dark:bg-gray-800"
              {...props}
            >
              {children}
            </summary>
          ),
          // Table styling
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="bg-gray-100 px-4 py-2 text-left text-sm font-semibold dark:bg-gray-800">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-t border-gray-200 px-4 py-2 text-sm dark:border-gray-700">
              {children}
            </td>
          ),
        }}
      >
        {sanitized}
      </ReactMarkdown>
    </div>
  );
}
