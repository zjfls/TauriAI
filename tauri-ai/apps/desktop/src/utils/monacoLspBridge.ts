import type * as Monaco from 'monaco-editor';

import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { astDocumentSymbols, lspNotify, lspRequest, lspShutdownWorkstudio } from '../services';
import type { CodeIntelligenceSettings } from '../types';

export type OpenInWorkstudioTarget = {
  filePath: string;
  line?: number | null;
  column?: number | null;
  endLine?: number | null;
  endColumn?: number | null;
};

export type MonacoLspBridge = {
  dispose: () => void;
};

const isFileUri = (uri: string) => uri.startsWith('file://');

const lspPos = (pos: Monaco.Position) => ({
  line: pos.lineNumber - 1,
  character: pos.column - 1,
});

const lspRange = (range: Monaco.IRange) => ({
  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
});

const monacoRangeFromLsp = (range: any): Monaco.IRange => ({
  startLineNumber: (range?.start?.line ?? 0) + 1,
  startColumn: (range?.start?.character ?? 0) + 1,
  endLineNumber: (range?.end?.line ?? 0) + 1,
  endColumn: (range?.end?.character ?? 0) + 1,
});

const monacoUri = (monaco: typeof Monaco, uri: string) => {
  try {
    return monaco.Uri.parse(String(uri));
  } catch {
    return monaco.Uri.parse('file:///');
  }
};

const getEnabledServerLanguageIds = (cfg: CodeIntelligenceSettings | null | undefined) => {
  const out = new Set<string>();
  for (const s of cfg?.lspServers ?? []) {
    const lang = (s.languageId ?? '').trim();
    if (!lang) continue;
    out.add(lang);
  }
  // 给一些常见语言兜底：即使用户没配，也允许以后热更新配置后立即生效
  out.add('rust');
  out.add('python');
  out.add('cpp');
  out.add('c');
  out.add('lua');
  return Array.from(out);
};

const isCodeIntelEnabled = (cfg: CodeIntelligenceSettings | null | undefined) => Boolean(cfg?.enabled);

const isLspEnabled = (
  cfg: CodeIntelligenceSettings | null | undefined,
  languageId: string,
  isLanguageEnabled?: (languageId: string) => boolean
) => {
  if (!isCodeIntelEnabled(cfg)) return false;
  const lang = (languageId ?? '').trim();
  if (!lang) return false;
  if (typeof isLanguageEnabled === 'function' && !isLanguageEnabled(lang)) return false;
  const servers = cfg?.lspServers ?? [];
  return servers.some((s) => s.enabled && s.languageId === lang && String(s.command || '').trim());
};

export const attachMonacoLspBridge = (opts: {
  monaco: typeof Monaco;
  workstudioId: string;
  openFile: (target: OpenInWorkstudioTarget) => Promise<void>;
  getConfig: () => CodeIntelligenceSettings | null | undefined;
  isLanguageEnabled?: (languageId: string) => boolean;
}): MonacoLspBridge => {
  const { monaco, workstudioId, openFile, getConfig, isLanguageEnabled } = opts;
  if (!isTauri()) {
    return { dispose: () => {} };
  }

  const disposables: Monaco.IDisposable[] = [];
  const openedUris = new Set<string>();
  const modelListeners = new Map<string, Monaco.IDisposable[]>();

  const ensureOpen = async (model: Monaco.editor.ITextModel) => {
    const uri = model.uri.toString();
    if (!isFileUri(uri)) return;
    const languageId = model.getLanguageId();
    const cfg = getConfig();
    if (!isLspEnabled(cfg, languageId, isLanguageEnabled)) return;

    if (openedUris.has(uri)) return;
    openedUris.add(uri);

    try {
      await lspNotify({
        workstudioId,
        languageId,
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId,
            version: model.getVersionId(),
            text: model.getValue(),
          },
        },
      });
    } catch (e) {
      openedUris.delete(uri);
      throw e;
    }
  };

  const sendChange = async (model: Monaco.editor.ITextModel, changes: any[]) => {
    const uri = model.uri.toString();
    if (!isFileUri(uri)) return;
    const languageId = model.getLanguageId();
    const cfg = getConfig();
    if (!isLspEnabled(cfg, languageId, isLanguageEnabled)) return;

    try {
      await ensureOpen(model);
    } catch {
      return;
    }

    const contentChanges = (changes ?? []).map((c) => ({
      range: lspRange(c.range),
      rangeLength: c.rangeLength,
      text: c.text,
    }));

    try {
      await lspNotify({
        workstudioId,
        languageId,
        method: 'textDocument/didChange',
        params: {
          textDocument: {
            uri,
            version: model.getVersionId(),
          },
          contentChanges,
        },
      });
    } catch {
      // ignore
    }
  };

  const sendClose = async (model: Monaco.editor.ITextModel) => {
    const uri = model.uri.toString();
    if (!isFileUri(uri)) return;
    const languageId = model.getLanguageId();
    if (!openedUris.has(uri)) return;
    openedUris.delete(uri);

    try {
      await lspNotify({
        workstudioId,
        languageId,
        method: 'textDocument/didClose',
        params: {
          textDocument: { uri },
        },
      });
    } catch {
      // ignore
    }
  };

  // Ensure existing models are opened (best-effort)
  for (const model of monaco.editor.getModels()) {
    void ensureOpen(model).catch(() => {});
  }

  disposables.push(
    monaco.editor.onDidCreateModel((model) => {
      const uri = model.uri.toString();
      void ensureOpen(model).catch(() => {});

      const listeners: Monaco.IDisposable[] = [];
      listeners.push(
        model.onDidChangeContent((e) => {
          void sendChange(model, e.changes).catch(() => {});
        })
      );
      listeners.push(
        model.onWillDispose(() => {
          void sendClose(model).catch(() => {});
          const ls = modelListeners.get(uri);
          if (ls) {
            for (const d of ls) d.dispose();
          }
          modelListeners.delete(uri);
        })
      );
      modelListeners.set(uri, listeners);
    })
  );

  // Handle go-to-definition opening external resource
  disposables.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selectionOrPosition) => {
        try {
          const fsPath = (resource as any)?.fsPath ?? resource.path ?? '';
          if (!fsPath) return false;

          const toTarget = (): OpenInWorkstudioTarget => {
            if (!selectionOrPosition) return { filePath: fsPath };
            if ((selectionOrPosition as any).startLineNumber) {
              const r = selectionOrPosition as Monaco.IRange;
              return {
                filePath: fsPath,
                line: r.startLineNumber,
                column: r.startColumn,
                endLine: r.endLineNumber,
                endColumn: r.endColumn,
              };
            }
            const p = selectionOrPosition as Monaco.IPosition;
            return { filePath: fsPath, line: p.lineNumber, column: p.column };
          };

          await openFile(toTarget());
          return true;
        } catch (e) {
          console.error('[LSP][openCodeEditor] failed:', e);
          return false;
        }
      },
    })
  );

  // LSP -> Monaco notifications (diagnostics, logs, etc)
  let unlisten: null | (() => void) = null;
  void listen('lsp:event', (event) => {
    const payload = (event as any)?.payload as any;
    if (!payload) return;
    if (payload.workstudioId !== workstudioId) return;
    if (payload.type === 'stderr') {
      // eslint-disable-next-line no-console
      console.debug('[LSP][stderr]', { languageId: payload.languageId, line: payload.line });
      return;
    }
    if (payload.type === 'exited') {
      console.warn('[LSP][exited]', payload);
      return;
    }
    if (payload.type !== 'notification') return;
    if (payload.method === 'textDocument/publishDiagnostics') {
      const uriStr = String(payload.params?.uri ?? '');
      if (!uriStr) return;
      const uri = monacoUri(monaco, uriStr);
      const model = monaco.editor.getModel(uri);
      if (!model) return;

      const diagnostics = Array.isArray(payload.params?.diagnostics) ? payload.params.diagnostics : [];
      const markers = diagnostics.map((d: any) => {
        const range = d?.range ?? null;
        const mr = range ? monacoRangeFromLsp(range) : null;
        const severity = Number(d?.severity ?? 3);
        const message = String(d?.message ?? '');
        return {
          severity:
            severity === 1
              ? monaco.MarkerSeverity.Error
              : severity === 2
                ? monaco.MarkerSeverity.Warning
                : severity === 4
                  ? monaco.MarkerSeverity.Hint
                  : monaco.MarkerSeverity.Info,
          message,
          startLineNumber: mr?.startLineNumber ?? 1,
          startColumn: mr?.startColumn ?? 1,
          endLineNumber: mr?.endLineNumber ?? 1,
          endColumn: mr?.endColumn ?? 1,
          source: payload.languageId ?? 'lsp',
        } satisfies Monaco.editor.IMarkerData;
      });

      monaco.editor.setModelMarkers(model, `lsp:${payload.languageId ?? 'unknown'}`, markers);
    }
  })
    .then((fn) => {
      unlisten = fn;
    })
    .catch(() => {});

  // Providers (Definition/References/Hover/Completion/etc)
  const registerProvidersForLanguage = (languageId: string) => {
    const lang = (languageId ?? '').trim();
    if (!lang) return;

    disposables.push(
      monaco.languages.registerDefinitionProvider(lang, {
        provideDefinition: async (model, position, token) => {
          if (token.isCancellationRequested) return null;
          const cfg = getConfig();
          if (!isLspEnabled(cfg, model.getLanguageId(), isLanguageEnabled)) return null;

          const uri = model.uri.toString();
          if (!isFileUri(uri)) return null;
          await ensureOpen(model);

          try {
            const result = await lspRequest<any>({
              workstudioId,
              languageId: model.getLanguageId(),
              method: 'textDocument/definition',
              params: { textDocument: { uri }, position: lspPos(position) },
            });
            return toMonacoDefinition(monaco, result);
          } catch {
            return null;
          }
        },
      })
    );

    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(lang, {
        provideTypeDefinition: async (model, position, token) => {
          if (token.isCancellationRequested) return null;
          const cfg = getConfig();
          if (!isLspEnabled(cfg, model.getLanguageId(), isLanguageEnabled)) return null;

          const uri = model.uri.toString();
          if (!isFileUri(uri)) return null;
          await ensureOpen(model);

          try {
            const result = await lspRequest<any>({
              workstudioId,
              languageId: model.getLanguageId(),
              method: 'textDocument/typeDefinition',
              params: { textDocument: { uri }, position: lspPos(position) },
            });
            return toMonacoDefinition(monaco, result);
          } catch {
            return null;
          }
        },
      })
    );

    disposables.push(
      monaco.languages.registerReferenceProvider(lang, {
        provideReferences: async (model, position, context, token) => {
          if (token.isCancellationRequested) return [];
          const cfg = getConfig();
          if (!isLspEnabled(cfg, model.getLanguageId(), isLanguageEnabled)) return [];

          const uri = model.uri.toString();
          if (!isFileUri(uri)) return [];
          await ensureOpen(model);

          try {
            const result = await lspRequest<any>({
              workstudioId,
              languageId: model.getLanguageId(),
              method: 'textDocument/references',
              params: {
                textDocument: { uri },
                position: lspPos(position),
                context: { includeDeclaration: Boolean(context?.includeDeclaration) },
              },
            });

            const items = Array.isArray(result) ? result : [];
            return items
              .filter((x) => x && x.uri && x.range)
              .map((loc: any) => ({
                uri: monacoUri(monaco, loc.uri),
                range: monacoRangeFromLsp(loc.range),
              }));
          } catch {
            return [];
          }
        },
      })
    );

    disposables.push(
      monaco.languages.registerHoverProvider(lang, {
        provideHover: async (model, position, token) => {
          if (token.isCancellationRequested) return null;
          const cfg = getConfig();
          if (!isLspEnabled(cfg, model.getLanguageId(), isLanguageEnabled)) return null;

          const uri = model.uri.toString();
          if (!isFileUri(uri)) return null;
          await ensureOpen(model);

          try {
            const result = await lspRequest<any>({
              workstudioId,
              languageId: model.getLanguageId(),
              method: 'textDocument/hover',
              params: { textDocument: { uri }, position: lspPos(position) },
            });

            const contents = lspHoverToMarkdown(result?.contents ?? null);
            if (contents.length === 0) return null;
            const range = result?.range ? monacoRangeFromLsp(result.range) : undefined;
            return {
              contents: contents.map((c) => ({ value: c })),
              range,
            };
          } catch {
            return null;
          }
        },
      })
    );

    disposables.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.', ':', '>', '<', '"', "'", '/', '@', '#'],
        provideCompletionItems: async (model, position, _context, token) => {
          if (token.isCancellationRequested) return { suggestions: [] };
          const cfg = getConfig();
          if (!isLspEnabled(cfg, model.getLanguageId(), isLanguageEnabled)) return { suggestions: [] };

          const uri = model.uri.toString();
          if (!isFileUri(uri)) return { suggestions: [] };
          await ensureOpen(model);

          try {
            const result = await lspRequest<any>({
              workstudioId,
              languageId: model.getLanguageId(),
              method: 'textDocument/completion',
              params: { textDocument: { uri }, position: lspPos(position) },
            });

            const items = Array.isArray(result)
              ? result
              : Array.isArray(result?.items)
                ? result.items
                : [];

            const word = model.getWordUntilPosition(position);
            const defaultRange: Monaco.IRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };

            const suggestions = items.map((it: any) => {
              const label = String(it?.label ?? '');
              const insertText = String(it?.insertText ?? label);
              const detail = typeof it?.detail === 'string' ? it.detail : undefined;
              const documentation = it?.documentation;
              const docText =
                typeof documentation === 'string'
                  ? documentation
                  : typeof documentation?.value === 'string'
                    ? documentation.value
                    : undefined;

              const textEdit = it?.textEdit ?? null;
              const editRange =
                textEdit?.range
                  ? monacoRangeFromLsp(textEdit.range)
                  : textEdit?.replace
                    ? monacoRangeFromLsp(textEdit.replace)
                    : textEdit?.insert
                      ? monacoRangeFromLsp(textEdit.insert)
                      : null;
              return {
                label,
                kind: lspCompletionKindToMonaco(it?.kind, monaco),
                insertText: textEdit?.newText ? String(textEdit.newText) : insertText,
                range: editRange ?? defaultRange,
                detail,
                documentation: docText ? { value: docText } : undefined,
              } satisfies Monaco.languages.CompletionItem;
            });

            return { suggestions };
          } catch {
            return { suggestions: [] };
          }
        },
      })
    );

    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(lang, {
        provideDocumentSymbols: async (model, _token) => {
          const cfg = getConfig();
          if (!isCodeIntelEnabled(cfg)) return [];
          const uri = model.uri.toString();
          if (!isFileUri(uri)) return [];
          const lspEnabled = isLspEnabled(cfg, model.getLanguageId(), isLanguageEnabled);
          if (lspEnabled) {
            await ensureOpen(model);
          }

          if (lspEnabled) {
            try {
              const result = await lspRequest<any>({
                workstudioId,
                languageId: model.getLanguageId(),
                method: 'textDocument/documentSymbol',
                params: { textDocument: { uri } },
              });
              const docs = lspDocumentSymbolsToMonaco(monaco, result);
              if (docs.length > 0) return docs;
            } catch {
              // ignore and fallback to AST
            }
          }

          try {
            const syms = await astDocumentSymbols({ languageId: model.getLanguageId(), text: model.getValue() });
            return astDocumentSymbolsToMonaco(monaco, syms);
          } catch {
            return [];
          }
        },
      })
    );
  };

  for (const lang of getEnabledServerLanguageIds(getConfig())) {
    registerProvidersForLanguage(lang);
  }

  return {
    dispose: () => {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      for (const ls of modelListeners.values()) {
        for (const d of ls) d.dispose();
      }
      modelListeners.clear();
      openedUris.clear();
      unlisten?.();
      void lspShutdownWorkstudio(workstudioId);
    },
  };
};

const toMonacoDefinition = (monaco: typeof Monaco, result: any): Monaco.languages.Definition | null => {
  if (!result) return null;

  const toLoc = (loc: any): Monaco.languages.Location | null => {
    if (!loc?.uri || !loc?.range) return null;
    return {
      uri: monacoUri(monaco, loc.uri),
      range: monacoRangeFromLsp(loc.range),
    };
  };

  const toLink = (link: any): Monaco.languages.LocationLink | null => {
    if (!link?.targetUri || !link?.targetRange) return null;
    return {
      originSelectionRange: link.originSelectionRange ? monacoRangeFromLsp(link.originSelectionRange) : undefined,
      uri: monacoUri(monaco, link.targetUri),
      range: monacoRangeFromLsp(link.targetRange),
      targetSelectionRange: link.targetSelectionRange
        ? monacoRangeFromLsp(link.targetSelectionRange)
        : monacoRangeFromLsp(link.targetRange),
    };
  };

  if (Array.isArray(result)) {
    // Location[] | LocationLink[]
    const links = result.map(toLink).filter(Boolean) as Monaco.languages.LocationLink[];
    if (links.length > 0) return links;
    const locs = result.map(toLoc).filter(Boolean) as Monaco.languages.Location[];
    return locs.length > 0 ? locs : null;
  }

  // single Location
  if (result.uri && result.range) {
    const loc = toLoc(result);
    return loc ? [loc] : null;
  }
  // single LocationLink
  if (result.targetUri && result.targetRange) {
    const link = toLink(result);
    return link ? [link] : null;
  }

  return null;
};

const lspHoverToMarkdown = (contents: any): string[] => {
  if (!contents) return [];
  // MarkupContent
  if (typeof contents === 'object' && typeof contents.value === 'string') {
    return [String(contents.value)];
  }
  // MarkedString
  if (typeof contents === 'string') return [contents];
  // MarkedString[]
  if (Array.isArray(contents)) {
    return contents
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c.value === 'string') return String(c.value);
        return '';
      })
      .filter(Boolean);
  }
  return [];
};

const lspCompletionKindToMonaco = (kind: any, monaco: typeof Monaco): Monaco.languages.CompletionItemKind => {
  const k = Number(kind ?? 0);
  // LSP CompletionItemKind: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#completionItemKind
  switch (k) {
    case 2:
      return monaco.languages.CompletionItemKind.Method;
    case 3:
      return monaco.languages.CompletionItemKind.Function;
    case 4:
      return monaco.languages.CompletionItemKind.Constructor;
    case 5:
      return monaco.languages.CompletionItemKind.Field;
    case 6:
      return monaco.languages.CompletionItemKind.Variable;
    case 7:
      return monaco.languages.CompletionItemKind.Class;
    case 8:
      return monaco.languages.CompletionItemKind.Interface;
    case 9:
      return monaco.languages.CompletionItemKind.Module;
    case 10:
      return monaco.languages.CompletionItemKind.Property;
    case 11:
      return monaco.languages.CompletionItemKind.Unit;
    case 12:
      return monaco.languages.CompletionItemKind.Value;
    case 13:
      return monaco.languages.CompletionItemKind.Enum;
    case 14:
      return monaco.languages.CompletionItemKind.Keyword;
    case 15:
      return monaco.languages.CompletionItemKind.Snippet;
    case 16:
      return monaco.languages.CompletionItemKind.Color;
    case 17:
      return monaco.languages.CompletionItemKind.File;
    case 18:
      return monaco.languages.CompletionItemKind.Reference;
    case 19:
      return monaco.languages.CompletionItemKind.Folder;
    case 20:
      return monaco.languages.CompletionItemKind.EnumMember;
    case 21:
      return monaco.languages.CompletionItemKind.Constant;
    case 22:
      return monaco.languages.CompletionItemKind.Struct;
    case 23:
      return monaco.languages.CompletionItemKind.Event;
    case 24:
      return monaco.languages.CompletionItemKind.Operator;
    case 25:
      return monaco.languages.CompletionItemKind.TypeParameter;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
};

const lspSymbolKindToMonaco = (kind: any, monaco: typeof Monaco): Monaco.languages.SymbolKind => {
  const k = Number(kind ?? 0);
  // LSP SymbolKind: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
  switch (k) {
    case 2:
      return monaco.languages.SymbolKind.Module;
    case 3:
      return monaco.languages.SymbolKind.Namespace;
    case 4:
      return monaco.languages.SymbolKind.Package;
    case 5:
      return monaco.languages.SymbolKind.Class;
    case 6:
      return monaco.languages.SymbolKind.Method;
    case 7:
      return monaco.languages.SymbolKind.Property;
    case 8:
      return monaco.languages.SymbolKind.Field;
    case 9:
      return monaco.languages.SymbolKind.Constructor;
    case 10:
      return monaco.languages.SymbolKind.Enum;
    case 11:
      return monaco.languages.SymbolKind.Interface;
    case 12:
      return monaco.languages.SymbolKind.Function;
    case 13:
      return monaco.languages.SymbolKind.Variable;
    case 14:
      return monaco.languages.SymbolKind.Constant;
    case 15:
      return monaco.languages.SymbolKind.String;
    case 16:
      return monaco.languages.SymbolKind.Number;
    case 17:
      return monaco.languages.SymbolKind.Boolean;
    case 18:
      return monaco.languages.SymbolKind.Array;
    case 19:
      return monaco.languages.SymbolKind.Object;
    case 20:
      return monaco.languages.SymbolKind.Key;
    case 21:
      return monaco.languages.SymbolKind.Null;
    case 22:
      return monaco.languages.SymbolKind.EnumMember;
    case 23:
      return monaco.languages.SymbolKind.Struct;
    case 24:
      return monaco.languages.SymbolKind.Event;
    case 25:
      return monaco.languages.SymbolKind.Operator;
    case 26:
      return monaco.languages.SymbolKind.TypeParameter;
    default:
      return monaco.languages.SymbolKind.File;
  }
};

const lspDocumentSymbolsToMonaco = (monaco: typeof Monaco, result: any): Monaco.languages.DocumentSymbol[] => {
  // LSP can return DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat)
  if (!result) return [];

  const toDoc = (ds: any): Monaco.languages.DocumentSymbol => ({
    name: String(ds?.name ?? ''),
    detail: typeof ds?.detail === 'string' ? ds.detail : '',
    kind: lspSymbolKindToMonaco(ds?.kind, monaco),
    tags: [],
    range: monacoRangeFromLsp(ds?.range ?? {}),
    selectionRange: monacoRangeFromLsp(ds?.selectionRange ?? ds?.range ?? {}),
    children: Array.isArray(ds?.children) ? ds.children.map(toDoc) : [],
  });

  // If has location field -> SymbolInformation
  if (Array.isArray(result) && result.length > 0 && result[0]?.location) {
    return (result as any[]).map((si) => ({
      name: String(si?.name ?? ''),
      detail: '',
      kind: lspSymbolKindToMonaco(si?.kind, monaco),
      tags: [],
      range: monacoRangeFromLsp(si?.location?.range ?? {}),
      selectionRange: monacoRangeFromLsp(si?.location?.range ?? {}),
      children: [],
    }));
  }

  if (Array.isArray(result)) {
    return result.map(toDoc);
  }
  return [];
};

const astKindToMonaco = (kind: string, monaco: typeof Monaco): Monaco.languages.SymbolKind => {
  const k = (kind ?? '').toLowerCase();
  switch (k) {
    case 'function':
      return monaco.languages.SymbolKind.Function;
    case 'method':
      return monaco.languages.SymbolKind.Method;
    case 'class':
      return monaco.languages.SymbolKind.Class;
    case 'struct':
      return monaco.languages.SymbolKind.Struct;
    case 'enum':
      return monaco.languages.SymbolKind.Enum;
    case 'trait':
    case 'interface':
      return monaco.languages.SymbolKind.Interface;
    case 'module':
      return monaco.languages.SymbolKind.Module;
    case 'const':
      return monaco.languages.SymbolKind.Constant;
    case 'static':
    case 'variable':
      return monaco.languages.SymbolKind.Variable;
    case 'type':
      return monaco.languages.SymbolKind.TypeParameter;
    case 'macro':
      return monaco.languages.SymbolKind.Event;
    case 'impl':
      return monaco.languages.SymbolKind.Object;
    default:
      return monaco.languages.SymbolKind.File;
  }
};

const astDocumentSymbolsToMonaco = (monaco: typeof Monaco, syms: any): Monaco.languages.DocumentSymbol[] => {
  const list = Array.isArray(syms) ? syms : [];
  const toDoc = (s: any): Monaco.languages.DocumentSymbol => ({
    name: String(s?.name ?? ''),
    detail: '',
    kind: astKindToMonaco(String(s?.kind ?? ''), monaco),
    tags: [],
    range: monacoRangeFromLsp(s?.range ?? {}),
    selectionRange: monacoRangeFromLsp(s?.selectionRange ?? s?.range ?? {}),
    children: Array.isArray(s?.children) ? s.children.map(toDoc) : [],
  });
  return list.map(toDoc);
};
