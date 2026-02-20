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

export type ChatMessageBlock =
  | {
      id: string;
      type: "text";
      format: "markdown" | "plain";
      text: string;
    }
  | {
      id: string;
      type: "thinking";
      text: string;
    }
  | {
      id: string;
      type: "web_search";
      event: WebSearchEvent;
    }
  | {
      id: string;
      type: "tool_call";
      call: ToolCallEvent;
    };

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  webSearch?: WebSearchEvent[];
  toolCalls?: ToolCallEvent[];
  blocks?: ChatMessageBlock[];
  createdAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  agentName?: string;
  updatedAt: number;
  messages: ChatMessage[];
};
