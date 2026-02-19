import type * as Monaco from 'monaco-editor';

import { isTauri } from '@tauri-apps/api/core';

import { aiCodeCompletion } from '../services';
import type { AiCompletionSettings, CodeIntelligenceSettings } from '../types';

export type MonacoAiCompletionBridge = {
  dispose: () => void;
};

type AiCompletionItem = { label: string; insertText: string };
type AiCompletionRunResult = { items: AiCompletionItem[] };

const COMMON_LANGUAGE_IDS = [
  'typescript',
  'javascript',
  'json',
  'css',
  'html',
  'markdown',
  'plaintext',
  'python',
  'rust',
  'cpp',
  'c',
  'lua',
  'toml',
  'yaml',
  'shell',
] as const;

const getAiCompletionSettings = (cfg: CodeIntelligenceSettings | null | undefined): AiCompletionSettings | null => {
  const raw = (cfg as any)?.aiCompletion as AiCompletionSettings | undefined;
  if (!raw) return null;
  if (!raw.enabled) return null;
  return raw;
};

const normalizeQueueScope = (scope: unknown): 'global' | 'language' => {
  const s = String(scope ?? '').trim();
  return s === 'language' ? 'language' : 'global';
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const getModelFilePath = (model: Monaco.editor.ITextModel): string => {
  const uriAny = model.uri as any;
  const fsPath = typeof uriAny?.fsPath === 'string' ? uriAny.fsPath : '';
  if (fsPath) return fsPath;
  const path = typeof uriAny?.path === 'string' ? uriAny.path : '';
  if (path) return path;
  return model.uri.toString();
};

const extractPrefixSuffix = (
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  maxPrefixChars: number,
  maxSuffixChars: number
) => {
  const value = model.getValue();
  const offset = model.getOffsetAt(position);
  const start = Math.max(0, offset - maxPrefixChars);
  const end = Math.min(value.length, offset + maxSuffixChars);
  return {
    prefix: value.slice(start, offset),
    suffix: value.slice(offset, end),
  };
};

const stripLeadingOverlap = (leftContext: string, insertText: string): string => {
  const leftTail = leftContext.slice(-512);
  const max = Math.min(leftTail.length, insertText.length);
  for (let len = max; len > 0; len -= 1) {
    if (leftTail.endsWith(insertText.slice(0, len))) {
      return insertText.slice(len);
    }
  }
  return insertText;
};

const truncateChars = (text: string, maxChars: number): string => {
  const max = Math.max(0, Math.floor(maxChars));
  if (max === 0) return '';
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}…`;
};

const buildCompletionPreview = (insertText: string, maxChars: number): string => {
  const raw = String(insertText ?? '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => Boolean(l));
  if (lines.length === 0) return 'AI';
  const joined =
    lines.length === 1
      ? lines[0]!
      : lines.length === 2
        ? `${lines[0]!} ⏎ ${lines[1]!}`
        : `${lines[0]!} ⏎ ${lines[1]!} ⏎ …`;
  return truncateChars(joined, maxChars);
};

const buildCompletionDocumentation = (languageId: string, insertText: string): Monaco.IMarkdownString => {
  const lang = String(languageId ?? '').trim();
  const raw = String(insertText ?? '').trimEnd();
  const maxDocChars = 24_000;
  const clipped = Array.from(raw).length > maxDocChars;
  const body = clipped ? truncateChars(raw, maxDocChars) : raw;
  const fence = lang || '';
  const value = `\`\`\`${fence}\n${body}\n\`\`\`${clipped ? '\n\n（内容过长，已截断）' : ''}`;
  return { value };
};

const delayOrCancel = (ms: number, token: Monaco.CancellationToken): Promise<boolean> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve(!token.isCancellationRequested);
      return;
    }
    const t = window.setTimeout(() => resolve(!token.isCancellationRequested), ms);
    token.onCancellationRequested(() => {
      window.clearTimeout(t);
      resolve(false);
    });
  });

type QueueTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  // When a task gets replaced before it runs, resolve it to an "empty" value to avoid hanging promises.
  resolveEmpty: () => void;
};

class LatestTaskQueue<T> {
  private inFlight: Promise<void> | null = null;
  private pending: QueueTask<T> | null = null;

  constructor(private readonly emptyValue: () => T) {}

  enqueue(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        run,
        resolve,
        reject,
        resolveEmpty: () => resolve(this.emptyValue()),
      };

      if (!this.inFlight) {
        this.start(task);
        return;
      }

      // Replace pending (only keep latest). Resolve the old one to avoid leaks.
      if (this.pending) {
        this.pending.resolveEmpty();
      }
      this.pending = task;
    });
  }

  private start(task: QueueTask<T>) {
    this.inFlight = (async () => {
      try {
        const value = await task.run();
        task.resolve(value);
      } catch (e) {
        task.reject(e);
      } finally {
        this.inFlight = null;
        const next = this.pending;
        this.pending = null;
        if (next) {
          this.start(next);
        }
      }
    })();
  }
}

export const attachMonacoAiCompletionBridge = (opts: {
  monaco: typeof Monaco;
  workstudioId: string;
  getConfig: () => CodeIntelligenceSettings | null | undefined;
}): MonacoAiCompletionBridge => {
  const { monaco, workstudioId, getConfig } = opts;
  if (!isTauri()) {
    return { dispose: () => {} };
  }

  const disposables: Monaco.IDisposable[] = [];
  const queueByKey = new Map<string, LatestTaskQueue<AiCompletionRunResult>>();

  const getQueue = (cfg: AiCompletionSettings, languageId: string) => {
    const scope = normalizeQueueScope(cfg.queueScope);
    const key = scope === 'language' ? `lang:${languageId}` : 'global';
    const existing = queueByKey.get(key);
    if (existing) return existing;
    const created = new LatestTaskQueue<AiCompletionRunResult>(() => ({ items: [] }));
    queueByKey.set(key, created);
    return created;
  };

  const isInlineEnabled = (cfg: AiCompletionSettings) => Boolean(cfg.inlineEnabled);
  const isListEnabled = (cfg: AiCompletionSettings) => Boolean(cfg.listEnabled);

  const isAutoInlineAllowed = (cfg: AiCompletionSettings) => {
    const mode = String(cfg.triggerMode ?? '').trim();
    return mode === 'auto' || mode === 'hybrid' || mode === '';
  };

  const registerProvidersForLanguage = (lang: string) => {
    // Inline ghost completion
    const inlineProvider: Monaco.languages.InlineCompletionsProvider = {
      provideInlineCompletions: async (model, position, context, token) => {
        if (token.isCancellationRequested) return { items: [] };
        const rootCfg = getConfig();
        const cfg = getAiCompletionSettings(rootCfg);
        if (!cfg || !isInlineEnabled(cfg)) return { items: [] };

        const languageId = model.getLanguageId();
        const filePath = getModelFilePath(model);

        // Automatic trigger respects triggerMode.
        if (context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Automatic) {
          if (!isAutoInlineAllowed(cfg)) return { items: [] };
          const debounceMs = clampInt(cfg.debounceMs, 0, 5_000, 350);
          const ok = await delayOrCancel(debounceMs, token);
          if (!ok) return { items: [] };
        }

        const maxPrefixChars = clampInt(cfg.maxPrefixChars, 0, 200_000, 8_000);
        const maxSuffixChars = clampInt(cfg.maxSuffixChars, 0, 200_000, 2_000);
        const { prefix, suffix } = extractPrefixSuffix(model, position, maxPrefixChars, maxSuffixChars);

        const queue = getQueue(cfg, languageId);
        const result = await queue.enqueue(async () => {
          const count = 1;
          try {
            const resp = await aiCodeCompletion({
              workstudioId,
              languageId,
              filePath,
              prefix,
              suffix,
              count,
            });
            return { items: resp.items };
          } catch (err) {
            console.warn('[Workstudio][AI Completion] inline request failed:', err);
            return { items: [] };
          }
        });

        const lineContent = model.getLineContent(position.lineNumber);
        const linePrefix = lineContent.slice(0, Math.max(0, position.column - 1));
        const isEol = position.column === lineContent.length + 1;

        const items = (result.items ?? [])
          .map((it) => {
            const rawInsertText = String((it as any)?.insertText ?? '');
            const insertText = stripLeadingOverlap(linePrefix, rawInsertText);
            if (!insertText) return null;
            if (insertText.includes('\n') && !isEol) return null;
            return {
              insertText,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column,
                endColumn: position.column,
              },
            } satisfies Monaco.languages.InlineCompletion;
          })
          .filter(Boolean) as Monaco.languages.InlineCompletion[];

        return { items };
      },
      freeInlineCompletions: () => {},
    };

    // 某些 monaco 版本运行时会调用 disposeInlineCompletions（而不是 freeInlineCompletions）。
    // 这里提供兼容别名，避免未处理的 Promise rejection。
    (inlineProvider as any).disposeInlineCompletions = () => {};

    disposables.push(monaco.languages.registerInlineCompletionsProvider(lang, inlineProvider as any));

    // Ctrl+Space completion list
    disposables.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems: async (model, position, context, token) => {
          if (token.isCancellationRequested) return { suggestions: [] };
          const rootCfg = getConfig();
          const cfg = getAiCompletionSettings(rootCfg);
          if (!cfg || !isListEnabled(cfg)) return { suggestions: [] };

          // Only respond to explicit invocation (Ctrl+Space).
          if (context.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke) {
            return { suggestions: [] };
          }

          const languageId = model.getLanguageId();
          const filePath = getModelFilePath(model);
          const wordUntil = model.getWordUntilPosition(position);
          const currentWord = String(wordUntil?.word ?? '');
          const maxPrefixChars = clampInt(cfg.maxPrefixChars, 0, 200_000, 8_000);
          const maxSuffixChars = clampInt(cfg.maxSuffixChars, 0, 200_000, 2_000);
          const { prefix, suffix } = extractPrefixSuffix(model, position, maxPrefixChars, maxSuffixChars);

          const count = clampInt(cfg.listSuggestionCount, 1, 8, 3);
          const queue = getQueue(cfg, languageId);
          const result = await queue.enqueue(async () => {
            try {
              const resp = await aiCodeCompletion({
                workstudioId,
                languageId,
                filePath,
                prefix,
                suffix,
                count,
              });
              return { items: resp.items };
            } catch (err) {
              console.warn('[Workstudio][AI Completion] list request failed:', err);
              return { items: [] };
            }
          });

          const lineContent = model.getLineContent(position.lineNumber);
          const linePrefix = lineContent.slice(0, Math.max(0, position.column - 1));
          const defaultRange: Monaco.IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column,
            endColumn: position.column,
          };

          const suggestions = (result.items ?? [])
            .map((it, idx) => {
              const rawInsertText = String((it as any)?.insertText ?? '');
              const insertText = stripLeadingOverlap(linePrefix, rawInsertText);
              if (!insertText) return null;
              const preview = buildCompletionPreview(insertText, 120);
              return {
                label: { label: preview, description: 'AI' },
                kind: monaco.languages.CompletionItemKind.User,
                insertText,
                range: defaultRange,
                documentation: buildCompletionDocumentation(languageId, insertText),
                sortText: `0_ai_${String(idx).padStart(2, '0')}`,
                // Monaco 会按“当前光标处的 word 前缀”过滤建议项；
                // 用 filterText 强制让 AI 建议在任何前缀下都可见（再靠 sortText 排到最前）。
                filterText: currentWord,
              } satisfies Monaco.languages.CompletionItem;
            })
            .filter(Boolean) as Monaco.languages.CompletionItem[];

          return { suggestions };
        },
      })
    );
  };

  const languageIds = (() => {
    const ids = new Set<string>();
    for (const id of COMMON_LANGUAGE_IDS) ids.add(id);
    try {
      const langs = (monaco.languages as any)?.getLanguages?.() ?? [];
      for (const l of langs) {
        const id = String((l as any)?.id ?? '').trim();
        if (id) ids.add(id);
      }
    } catch {
      // ignore
    }
    return Array.from(ids);
  })();

  for (const lang of languageIds) {
    registerProvidersForLanguage(lang);
  }

  return {
    dispose: () => {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      queueByKey.clear();
    },
  };
};
