export type ChatRole = "user" | "assistant" | "system";

export type WebSearchEvent = {
  id: string;
  status: string;
  action?: unknown;
};

export type ToolCallEvent = {
  id: string;
  name: string;
  arguments: string;
  output?: string;
  error?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  webSearch?: WebSearchEvent[];
  toolCalls?: ToolCallEvent[];
  createdAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  agentName?: string;
  updatedAt: number;
  messages: ChatMessage[];
};
