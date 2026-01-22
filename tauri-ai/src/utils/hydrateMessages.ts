import type { Message } from '../types';

/**
 * Backend persists multi-turn artifacts (blocks/turns) into `message.meta` for DB compatibility.
 * This helper lifts them to top-level fields so the UI can render them consistently.
 */
export function hydrateMessageFromBackend(message: Message): Message {
  const meta: any = (message as any).meta;

  const blocks = (message as any).blocks ?? meta?.blocks;
  const turns = (message as any).turns ?? meta?.turns;

  return {
    ...message,
    blocks: blocks ?? message.blocks,
    turns: turns ?? message.turns,
  };
}

export function hydrateMessagesFromBackend(messages: Message[]): Message[] {
  return messages.map(hydrateMessageFromBackend);
}

