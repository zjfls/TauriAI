import type { Message } from '../types';

/**
 * Backend persists multi-turn artifacts (blocks/turns) into `message.meta` for DB compatibility.
 * This helper lifts them to top-level fields so the UI can render them consistently.
 */
export function hydrateMessageFromBackend(message: Message): Message {
  const meta: any = (message as any).meta;

  const blocks = (message as any).blocks ?? meta?.blocks;
  const rawTurns = (message as any).turns ?? meta?.turns;

  // Default behavior: do NOT keep debugInfo inline for history initialization.
  // DebugInfo can be large; we load it on demand when the user clicks "Debug".
  const turns = Array.isArray(rawTurns)
    ? rawTurns.map((t: any) => {
        const hasDebugInfo = Boolean(t?.hasDebugInfo ?? t?.has_debug_info ?? t?.debugInfo ?? t?.debug_info);
        // Strip debug payloads to keep memory/initial parse costs low.
        const { debugInfo: _debugInfo, debug_info: _debug_info, ...rest } = t ?? {};
        return {
          ...rest,
          ...(hasDebugInfo ? { hasDebugInfo: true } : {}),
        };
      })
    : rawTurns;

  // Also drop meta.blocks/meta.turns to avoid retaining duplicate (and potentially heavy) payloads.
  const sanitizedMeta =
    meta && typeof meta === 'object'
      ? (() => {
          const next = { ...meta };
          delete next.blocks;
          delete next.turns;
          return next;
        })()
      : meta;

  return {
    ...message,
    meta: (sanitizedMeta ?? message.meta) as any,
    blocks: blocks ?? message.blocks,
    turns: turns ?? message.turns,
  };
}

export function hydrateMessagesFromBackend(messages: Message[]): Message[] {
  return messages.map(hydrateMessageFromBackend);
}
