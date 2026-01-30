export type ConversationViewState = {
  startIndex: number;
  visibleCount: number;
  scrollTop: number;
  isAtBottom: boolean;
  userScrolledAway: boolean;
  anchorMessageId?: string;
  anchorViewportTop?: number;
};

const viewStateByConversationKey = new Map<string, ConversationViewState>();
const forceScrollToBottomOnceKeys = new Set<string>();

export const getConversationViewState = (conversationKey: string): ConversationViewState | undefined => {
  if (!conversationKey) return undefined;
  return viewStateByConversationKey.get(conversationKey);
};

export const setConversationViewState = (conversationKey: string, state: ConversationViewState): void => {
  if (!conversationKey) return;
  viewStateByConversationKey.set(conversationKey, state);
};

export const clearConversationViewState = (conversationKey: string): void => {
  if (!conversationKey) return;
  viewStateByConversationKey.delete(conversationKey);
};

export const requestConversationScrollToBottomOnce = (conversationKey: string): void => {
  if (!conversationKey) return;
  forceScrollToBottomOnceKeys.add(conversationKey);
};

export const consumeConversationScrollToBottomOnce = (conversationKey: string): boolean => {
  if (!conversationKey) return false;
  const hit = forceScrollToBottomOnceKeys.has(conversationKey);
  if (hit) forceScrollToBottomOnceKeys.delete(conversationKey);
  return hit;
};
