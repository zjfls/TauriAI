import type * as Monaco from 'monaco-editor';

import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import 'monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsContribution';
import 'monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution';
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints';
import 'monaco-editor/esm/vs/editor/contrib/rename/browser/rename';
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch';
import { setupMonacoEnvironment } from './monacoEnv';

let configured = false;

export const setupMonaco = (monaco: typeof Monaco) => {
  setupMonacoEnvironment();
  if (configured) return;
  configured = true;

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
