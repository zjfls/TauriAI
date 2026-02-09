export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  agentName?: string;
  updatedAt: number;
  messages: ChatMessage[];
};
