import type * as Monaco from 'monaco-editor';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';

let configured = false;

export const setupMonaco = (monaco: typeof Monaco) => {
  if (configured) return;
  configured = true;

  // Vite worker wiring for Monaco.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MonacoEnvironment = {
    getWorker: (_: unknown, label: string) => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TsWorker();
      return new EditorWorker();
    },
  };

  // Basic Rust syntax highlighting (Monarch).
  // Monaco doesn't ship Rust by default; this provides a reasonable baseline.
  monaco.languages.register({ id: 'rust' });
  monaco.languages.setMonarchTokensProvider('rust', {
    symbols: /[=><!~?:&|+\-*/^%]+/,
    keywords: [
      'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn',
      'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref',
      'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
      'use', 'where', 'while', 'async', 'await', 'dyn',
    ],
    typeKeywords: ['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'bool', 'char', 'str'],
    tokenizer: {
      root: [
        [/\/\*\*/, 'comment.doc', '@doccomment'],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/\/.*/, 'comment.doc'],
        [/\/\/!.*/, 'comment.doc'],
        [/\/\/.*/, 'comment'],

        [/r#*\"/, 'string', '@rawstring'],
        [/b?\"/, 'string', '@string'],
        [/\'([^\\']|\\.)\'/, 'string'],

        [/\b0[xX][0-9a-fA-F_]+\b/, 'number.hex'],
        [/\b0[bB][01_]+\b/, 'number.binary'],
        [/\b0[oO][0-7_]+\b/, 'number.octal'],
        [/\b\d[\d_]*(\.\d[\d_]*)?([eE][+\-]?\d[\d_]*)?\b/, 'number'],

        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@default': 'identifier',
          },
        }],

        [/[{}()\[\]]/, '@brackets'],
        [/[<>]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
        [/[=+\-*/%&|^!~?:]/, 'operator'],
      ],
      comment: [
        [/[^\/*]+/, 'comment' ],
        [/\*\//, 'comment', '@pop' ],
        [/[\/*]/, 'comment' ],
      ],
      doccomment: [
        [/[^\/*]+/, 'comment.doc' ],
        [/\*\//, 'comment.doc', '@pop' ],
        [/[\/*]/, 'comment.doc' ],
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/\"/, 'string', '@pop'],
      ],
      rawstring: [
        [/[^"]+/, 'string'],
        [/\"#*/, 'string', '@pop'],
      ],
    },
  });
};
