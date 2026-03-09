import { isTauri } from '@tauri-apps/api/core';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';

const CLEAR_CONVERSATION_DIALOG_TITLE = '\u6e05\u7a7a\u5f53\u524d\u4f1a\u8bdd';
const DEFAULT_CONVERSATION_TITLE = '\u5f53\u524d\u4f1a\u8bdd';

export function buildClearConversationConfirmMessage(title?: string | null): string {
  const displayTitle = title?.trim() ? title : DEFAULT_CONVERSATION_TITLE;
  return `\u786e\u5b9a\u6e05\u7a7a\u5f53\u524d\u4f1a\u8bdd\u5417\uff1f\n\n${displayTitle}\n\n\u8fd9\u4f1a\u5220\u9664\u5f53\u524d\u4f1a\u8bdd\u7684\u5168\u90e8\u6d88\u606f\u548c\u8349\u7a3f\uff0c\u4e0d\u53ef\u64a4\u9500\u3002`;
}

export async function confirmClearConversation(title?: string | null): Promise<boolean> {
  const message = buildClearConversationConfirmMessage(title);

  if (typeof window === 'undefined') return true;

  if (!isTauri()) {
    return window.confirm(message);
  }

  return confirmDialog(message, {
    title: CLEAR_CONVERSATION_DIALOG_TITLE,
    kind: 'warning',
    okLabel: '\u6e05\u7a7a',
    cancelLabel: '\u53d6\u6d88',
  });
}
