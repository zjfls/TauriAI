import type { ChatMessage, ChatMessageBlock } from "../types/chat";

export function getAssistantMessageBlocks(message: ChatMessage): ChatMessageBlock[] {
  if (message.role !== "assistant") return [];

  if (Array.isArray(message.blocks) && message.blocks.length > 0) {
    return message.blocks;
  }

  const blocks: ChatMessageBlock[] = [];

  if (message.thinking && message.thinking.trim().length > 0) {
    blocks.push({
      id: `thinking_${message.id}`,
      type: "thinking",
      text: message.thinking,
    });
  }

  if (message.content && message.content.trim().length > 0) {
    blocks.push({
      id: `text_${message.id}`,
      type: "text",
      format: "markdown",
      text: message.content,
    });
  }

  if (Array.isArray(message.webSearch)) {
    for (const ev of message.webSearch) {
      if (!ev?.id) continue;
      blocks.push({
        id: `web_${ev.id}`,
        type: "web_search",
        event: ev,
      });
    }
  }

  if (Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      if (!call?.id) continue;
      blocks.push({
        id: `tool_${call.id}`,
        type: "tool_call",
        call,
      });
    }
  }

  return blocks;
}

