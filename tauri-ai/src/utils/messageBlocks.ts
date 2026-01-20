import type { Message, MessageBlock } from '../types';

export function getAssistantMessageBlocks(message: Message): MessageBlock[] {
  // 兼容/迁移辅助：
  // - 新架构希望 assistant 输出走 blocks
  // - 老数据/老版本仍可能只有 content/thinking
  // 这里做“从旧字段推导 blocks”，保证 UI 渲染入口统一。
  if (message.role !== 'assistant') return [];

  if (message.blocks && message.blocks.length > 0) {
    return message.blocks;
  }

  const blocks: MessageBlock[] = [];

  if (message.thinking && message.thinking.trim().length > 0) {
    blocks.push({
      id: 'assistant_thinking',
      type: 'thinking',
      text: message.thinking,
    });
  }

  if (message.content && message.content.trim().length > 0) {
    blocks.push({
      id: 'assistant_text',
      type: 'text',
      format: 'markdown',
      text: message.content,
    });
  }

  return blocks;
}
