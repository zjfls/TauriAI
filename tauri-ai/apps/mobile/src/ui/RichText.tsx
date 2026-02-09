import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { clsx } from "../lib/clsx";

const mdComponents: Components = {
  p: ({ children }) => <p className="my-1 leading-relaxed break-words">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-indigo-200 underline break-words"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 pl-5 list-disc space-y-1 break-words">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 pl-5 list-decimal space-y-1 break-words">{children}</ol>,
  li: ({ children }) => <li className="break-words">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 pl-3 border-l-2 border-white/15 text-white/80">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-white/10" />,
  h1: ({ children }) => <h1 className="text-base font-semibold my-2 break-words">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold my-2 break-words">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-medium my-2 break-words">{children}</h3>,
  img: ({ src, alt }) => (
    <img src={src ?? ""} alt={alt ?? ""} className="max-w-full h-auto rounded-lg my-2" />
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-hidden">
      <table className="w-full table-fixed border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/5">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-white/10 px-2 py-1 text-left text-xs font-medium break-words">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-white/10 px-2 py-1 text-xs align-top break-words">{children}</td>
  ),
  pre: ({ children }) => (
    <pre className="my-2 rounded-lg bg-black/30 border border-white/10 p-2 overflow-x-hidden whitespace-pre-wrap break-words text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: (props) => {
    const { inline, className, children, ...rest } = props as {
      inline?: boolean;
      className?: string;
      children?: any;
      [key: string]: unknown;
    };
    if (inline) {
      return (
        <code
          className={clsx(
            "px-1 py-0.5 rounded bg-black/30 border border-white/10",
            "text-[0.85em] break-words",
          )}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={clsx("break-words", className)} {...rest}>
        {children}
      </code>
    );
  },
};

export function RichText({ content, className }: { content: string; className?: string }) {
  const text = typeof content === "string" ? content : String(content ?? "");
  return (
    <div className={clsx("max-w-full overflow-x-hidden break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={mdComponents}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
