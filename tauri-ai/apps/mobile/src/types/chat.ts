export type ChatRole = "user" | "assistant" | "system";

export type ImageDetail = "auto" | "low" | "high";

export type ChatTextContentPart = {
  type: "text";
  text: string;
};

export type ChatImageContentPart = {
  type: "image";
  url: string;
  detail?: ImageDetail;
};

export type ChatTextFileContentPart = {
  type: "text_file";
  filename: string;
  content: string;
};

export type ChatPdfPage = {
  pageNumber: number;
  text: string;
  image: string;
};

export type ChatPdfMetadata = {
  title?: string;
  author?: string;
  createdAt?: string;
  producer?: string;
  subject?: string;
  keywords?: string;
};

export type ChatPdfDocumentContentPart = {
  type: "pdf_document";
  filename: string;
  pages: ChatPdfPage[];
  totalPages: number;
  metadata?: ChatPdfMetadata;
};

export type ChatContentPart =
  | ChatTextContentPart
  | ChatImageContentPart
  | ChatTextFileContentPart
  | ChatPdfDocumentContentPart;

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

export type ThinkingMode = boolean | "low" | "medium" | "high" | "xhigh" | null;

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  contentParts?: ChatContentPart[];
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
  modelRef?: string;
  thinkingMode?: ThinkingMode;
  webSearchEnabled?: boolean;
  updatedAt: number;
  messages: ChatMessage[];
};
