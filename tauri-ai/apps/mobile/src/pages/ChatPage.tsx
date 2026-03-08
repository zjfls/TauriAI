import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type TouchEvent } from "react";
import { Brain, Camera, FileText, ListOrdered, LoaderCircle, Mic, Paperclip, Plus, RotateCcw, Search, SendHorizontal, X } from "lucide-react";
import { isTauriRuntime, tauriInvoke, tauriListen, type UnlistenFn } from "../lib/tauri";
import { clsx } from "../lib/clsx";
import { useLayoutSize } from "../lib/breakpoints";
import { loadChatRenderMode } from "../lib/chatRenderPrefs";
import { getAssistantMessageBlocks } from "../lib/messageBlocks";
import { Button } from "../ui/Button";
import { PendingAssistantBlock, ThinkingBlock, ToolCallBlock, WebSearchBlock } from "../ui/ChatBlocks";
import { ChatOutlineDrawer } from "../ui/ChatOutlineDrawer";
import { Input } from "../ui/Input";
import { RichText } from "../ui/RichText";
import { Select } from "../ui/Select";
import { loadChatDraftAttachments, MOBILE_SUPPORTED_TEXT_EXTENSIONS, toAttachmentContentParts, type DraftChatAttachment } from "../lib/chatAttachments";
import { collectSpeechSegments, ensureMicrophonePermission, getSpeechRecognitionConstructor, mapMicrophonePermissionError, mapVoiceInputError, mergeVoiceText, supportsVoiceInput, type BrowserSpeechRecognition } from "../lib/voiceInput";
import type { ChatContentPart, ChatMessage, ThinkingMode } from "../types/chat";
import { useConversationStore } from "../stores/conversationStore";
import { useChatComposerStore } from "../stores/chatComposerStore";
import { filterNonPracticeAgents } from "../../../common/src/agentUtils";

type MobileChatStreamPayload = {
  streamId: string;
  conversationId: string;
  assistantMessageId: string;
  kind:
    | "delta"
    | "thinking"
    | "web_search"
    | "tool_calls"
    | "tool_result"
    | "done"
    | "error"
    | "canceled";
  delta?: string;
  content?: string;
  thinking?: string;
  data?: any;
  error?: string;
};

type SendOptions = {
  content?: string;
  contentParts?: ChatContentPart[];
  baseMessages?: ChatMessage[];
};

type RetryContext = {
  baseMessages: ChatMessage[];
  userContent: string;
  userContentParts?: ChatContentPart[];
};

type StreamingAssistantState = {
  messageId: string;
  showThinkingLabel: boolean;
};

type ProviderType =
  | "openai"
  | "openai_compatible"
  | "openai_responses"
  | "anthropic"
  | "google"
  | "ollama";

type ModelCapabilities = {
  thinking: boolean;
  vision: boolean;
  functionCalling: boolean;
  webSearch: boolean;
};

type ChatModelProfile = {
  modelRef: string;
  providerType?: ProviderType;
  providerName: string;
  modelName: string;
  capabilities: ModelCapabilities;
  useReasoningEffort: boolean;
};

type ModelOption = {
  value: string;
  label: string;
};

type ChatAttachmentPart = Exclude<ChatContentPart, { type: "text" }>;

type VoiceInputState = "idle" | "requesting" | "listening" | "processing";

const MOBILE_ATTACHMENT_ACCEPT = ["image/*", "application/pdf", ...MOBILE_SUPPORTED_TEXT_EXTENSIONS].join(",");

function isChatAttachmentPart(part: ChatContentPart): part is ChatAttachmentPart {
  return part.type !== "text";
}

function getChatAttachmentParts(parts?: ChatContentPart[]): ChatAttachmentPart[] {
  return Array.isArray(parts) ? parts.filter(isChatAttachmentPart) : [];
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function summarizeAttachmentParts(parts?: ChatContentPart[]): string {
  const attachments = getChatAttachmentParts(parts);
  if (attachments.length === 0) return "";

  let imageCount = 0;
  const labels: string[] = [];
  for (const part of attachments) {
    if (part.type === "image") {
      imageCount += 1;
      continue;
    }
    if (part.type === "pdf_document") {
      labels.push(`PDF:${part.filename}${part.totalPages > 0 ? `(${part.totalPages}页)` : ""}`);
      continue;
    }
    labels.push(part.filename);
  }

  if (imageCount > 0) {
    labels.unshift(`${imageCount} 张图片`);
  }
  return labels.join(" · ");
}

function buildUserMessagePreview(message: ChatMessage): string {
  const text = message.content.replace(/\s+/g, " ").trim();
  if (text) return text;
  const attachments = summarizeAttachmentParts(message.contentParts);
  return attachments || "（空消息）";
}

function buildUserMessageDetail(message: ChatMessage): string | null {
  const sections: string[] = [];
  const text = message.content.trim();
  if (text) {
    sections.push(text);
  }

  const attachments = getChatAttachmentParts(message.contentParts);
  if (attachments.length > 0) {
    sections.push(
      [
        "附件：",
        ...attachments.map((part) => {
          if (part.type === "image") return "- 图片";
          if (part.type === "pdf_document") {
            return `- PDF：${part.filename}${part.totalPages > 0 ? `（${part.totalPages} 页）` : ""}`;
          }
          return `- 文件：${part.filename}`;
        }),
      ].join("\n"),
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

function ensureModelCapabilities(value: any): ModelCapabilities {
  const caps = value && typeof value === "object" ? value : {};
  return {
    thinking: Boolean(caps.thinking),
    vision: Boolean(caps.vision),
    functionCalling: Boolean(caps.functionCalling ?? caps.function_calling),
    webSearch: Boolean(caps.webSearch ?? caps.web_search),
  };
}

function resolveModelRefFromConfig(cfg: any, agentName?: string | null): string | null {
  const agents: any[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
  const providers: any[] = Array.isArray(cfg?.providers) ? cfg.providers : [];
  const trimmedAgentName = String(agentName ?? "").trim();

  const findAgentRef = (name: string) => {
    const agent = agents.find(
      (item) =>
        item &&
        typeof item === "object" &&
        String(item.name ?? "").trim() === name &&
        (typeof item.enabled === "boolean" ? item.enabled : true),
    );
    const modelRef = String(agent?.modelRef ?? "").trim();
    return modelRef || null;
  };

  if (trimmedAgentName) {
    const byAgent = findAgentRef(trimmedAgentName);
    if (byAgent) return byAgent;
  }

  const currentModelRef = String(cfg?.currentModelRef ?? "").trim();
  if (currentModelRef) return currentModelRef;

  const currentAgent = String(cfg?.currentAgent ?? "").trim();
  if (currentAgent) {
    const byCurrentAgent = findAgentRef(currentAgent);
    if (byCurrentAgent) return byCurrentAgent;
  }

  const defaultAgent = String(cfg?.defaultAgent ?? "").trim();
  if (defaultAgent) {
    const byDefaultAgent = findAgentRef(defaultAgent);
    if (byDefaultAgent) return byDefaultAgent;
  }

  for (const provider of providers) {
    if (!provider || typeof provider !== "object") continue;
    if (provider.enabled === false) continue;
    const providerName = String(provider.name ?? "").trim();
    const firstModel = Array.isArray(provider.models) ? provider.models[0] : undefined;
    const modelName = String(firstModel?.name ?? "").trim();
    if (providerName && modelName) return `${providerName}/${modelName}`;
  }

  return null;
}

function resolveChatModelProfileFromRef(cfg: any, modelRef?: string | null): ChatModelProfile | null {
  const normalizedModelRef = String(modelRef ?? "").trim();
  if (!normalizedModelRef) return null;

  const [providerName, modelName] = normalizedModelRef.split("/");
  const providers: any[] = Array.isArray(cfg?.providers) ? cfg.providers : [];
  const provider = providers.find(
    (item) => item && typeof item === "object" && String(item.name ?? "").trim() === providerName,
  );
  const model = Array.isArray(provider?.models)
    ? provider.models.find((item: any) => String(item?.name ?? "").trim() === modelName)
    : null;
  if (!provider || !model) return null;

  return {
    modelRef: normalizedModelRef,
    providerType: provider.type as ProviderType | undefined,
    providerName,
    modelName,
    capabilities: ensureModelCapabilities(model.capabilities),
    useReasoningEffort: Boolean(model.useReasoningEffort),
  };
}

function resolveEffectiveModelRef(
  cfg: any,
  explicitModelRef?: string | null,
  agentName?: string | null,
): string | null {
  const explicitProfile = resolveChatModelProfileFromRef(cfg, explicitModelRef);
  if (explicitProfile) return explicitProfile.modelRef;
  return resolveModelRefFromConfig(cfg, agentName);
}

function resolveChatModelProfile(
  cfg: any,
  explicitModelRef?: string | null,
  agentName?: string | null,
): ChatModelProfile | null {
  const explicitProfile = resolveChatModelProfileFromRef(cfg, explicitModelRef);
  if (explicitProfile) return explicitProfile;

  const fallbackModelRef = resolveModelRefFromConfig(cfg, agentName);
  if (!fallbackModelRef) return null;
  return resolveChatModelProfileFromRef(cfg, fallbackModelRef);
}

function isResponsesProtocol(providerType?: ProviderType, useReasoningEffort?: boolean): boolean {
  return (
    providerType === "openai_responses" ||
    providerType === "google" ||
    Boolean(useReasoningEffort)
  );
}

function getDefaultThinkingMode(
  providerType?: ProviderType,
  useReasoningEffort?: boolean,
): ThinkingMode {
  return isResponsesProtocol(providerType, useReasoningEffort) ? "medium" : true;
}

function normalizeThinkingMode(
  value: ThinkingMode | undefined,
  providerType?: ProviderType,
  useReasoningEffort?: boolean,
): ThinkingMode {
  if (isResponsesProtocol(providerType, useReasoningEffort)) {
    const multiLevel =
      value === undefined
        ? getDefaultThinkingMode(providerType, useReasoningEffort)
        : typeof value === "boolean"
          ? value
            ? "medium"
            : null
          : value;
    if (providerType === "google" && multiLevel === "xhigh") {
      return "high";
    }
    return multiLevel;
  }

  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  return value !== null;
}

function findRetryContext(messages: ChatMessage[], assistantMessageId: string): RetryContext | null {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex <= 0) return null;
  if (messages[assistantIndex]?.role !== "assistant") return null;

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== "user") continue;
    const attachments = getChatAttachmentParts(candidate.contentParts);
    if (!candidate.content.trim() && attachments.length === 0) continue;
    return {
      baseMessages: messages.slice(0, index),
      userContent: candidate.content,
      userContentParts: attachments.length > 0 ? attachments : undefined,
    };
  }

  return null;
}

function findRetryAssistantMessageId(messages: ChatMessage[], userMessageId: string): string | null {
  const userIndex = messages.findIndex((message) => message.id === userMessageId);
  if (userIndex < 0) return null;
  if (messages[userIndex]?.role !== "user") return null;

  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate) continue;
    if (candidate.role === "user") return null;
    if (candidate.role === "assistant") {
      return findRetryContext(messages, candidate.id) ? candidate.id : null;
    }
  }

  return null;
}

export function ChatPage({
  onNewConversation,
  onReturnToPractice,
  returnToPracticeLabel,
}: {
  onNewConversation?: () => void;
  onReturnToPractice?: () => void;
  returnToPracticeLabel?: string;
}) {
  const layout = useLayoutSize();
  const {
    conversations,
    activeConversationId,
    appendMessage,
    appendMessageDelta,
    appendThinkingDelta,
    upsertWebSearchEvent,
    setToolCalls,
    setToolCallResult,
    finalizeMessage,
    patchConversation,
    replaceConversationMessages,
  } = useConversationStore();
  const conversation = useMemo(() => {
    const c =
      (activeConversationId && conversations.find((x) => x.id === activeConversationId)) ||
      conversations[0];
    return c;
  }, [activeConversationId, conversations]);
  const composerDrafts = useChatComposerStore((s) => s.drafts);
  const setComposerDraft = useChatComposerStore((s) => s.setDraft);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingAssistantState, setStreamingAssistantState] = useState<StreamingAssistantState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fallbackAgentName, setFallbackAgentName] = useState<string>("");
  const [agentLabels, setAgentLabels] = useState<Record<string, string>>({});
  const [configSnapshot, setConfigSnapshot] = useState<any>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeStreamRef = useRef<{
    streamId: string;
    conversationId: string;
    assistantMessageId: string;
  } | null>(null);
  const messageNodeByIdRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const touchGestureRef = useRef<{ startX: number; startY: number } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [selectedRequestMessageId, setSelectedRequestMessageId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceBaseInputRef = useRef("");
  const [draftAttachments, setDraftAttachments] = useState<DraftChatAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [voiceInputState, setVoiceInputState] = useState<VoiceInputState>("idle");
  const [voiceError, setVoiceError] = useState("");

  const messages = conversation?.messages ?? [];
  const conversationDraft = conversation?.id ? composerDrafts[conversation.id] ?? "" : "";

  const updateInput = useCallback(
    (next: string) => {
      setInput(next);
      if (conversation?.id) {
        setComposerDraft(conversation.id, next);
      }
    },
    [conversation?.id, setComposerDraft],
  );
  const outlineItems = useMemo(() => {
    const items: Array<{ messageId: string; index: number; preview: string }> = [];
    let index = 0;
    for (const m of messages) {
      if (m.role !== "user") continue;
      index += 1;
      const preview = buildUserMessagePreview(m).slice(0, 96);
      items.push({
        messageId: m.id,
        index,
        preview: preview || "（空消息）",
      });
    }
    return items;
  }, [messages]);

  const selectedOutlineFullText = useMemo(() => {
    if (!selectedRequestMessageId) return null;
    const msg = messages.find((m) => m.id === selectedRequestMessageId && m.role === "user");
    return msg ? buildUserMessageDetail(msg) : null;
  }, [messages, selectedRequestMessageId]);

  // 读取渲染模式（默认 rich）。不做 memo，方便 Settings 修改后即时生效。
  const renderMode = loadChatRenderMode();

  useEffect(() => {
    setInput(conversationDraft);
  }, [conversation?.id, conversationDraft]);

  useEffect(() => {
    if (outlineItems.length === 0) {
      if (selectedRequestMessageId !== null) setSelectedRequestMessageId(null);
      return;
    }
    const exists = selectedRequestMessageId
      ? outlineItems.some((item) => item.messageId === selectedRequestMessageId)
      : false;
    if (!exists) {
      setSelectedRequestMessageId(outlineItems[outlineItems.length - 1]?.messageId ?? null);
    }
  }, [outlineItems, selectedRequestMessageId]);

  useEffect(() => {
    setOutlineOpen(false);
  }, [conversation?.id, layout]);

  const loadConfig = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const cfg = await tauriInvoke<any>("get_app_config");

      setConfigSnapshot(cfg);
      const list: any[] = filterNonPracticeAgents(Array.isArray(cfg?.agents) ? cfg.agents : []);
      const def = String(cfg?.defaultAgent ?? cfg?.default_agent ?? "").trim();
      const resolvedFallback =
        (def && list.some((agent: any) => String(agent?.name ?? "").trim() === def) ? def : "") ||
        String(list[0]?.name ?? "").trim();
      setFallbackAgentName(resolvedFallback);

      const next: Record<string, string> = {};
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const name = String((a as any).name ?? "").trim();
        if (!name) continue;
        const displayName = String((a as any).displayName ?? (a as any).display_name ?? name).trim();
        next[name] = displayName || name;
      }
      setAgentLabels(next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 从设置页返回时刷新一次配置，确保 Agent/Model 展示与后端一致。
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void loadConfig();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadConfig]);

  const activeAgentName = conversation?.agentName || fallbackAgentName || "";
  const activeAgentLabel = activeAgentName ? agentLabels[activeAgentName] || activeAgentName : "";
  const modelOptions = useMemo<ModelOption[]>(() => {
    const providers: any[] = Array.isArray(configSnapshot?.providers) ? configSnapshot.providers : [];
    const options: ModelOption[] = [];
    for (const provider of providers) {
      if (!provider || typeof provider !== "object") continue;
      if (provider.enabled === false) continue;
      const providerName = String(provider.name ?? "").trim();
      const providerLabel = String(provider.displayName ?? provider.name ?? "").trim() || providerName;
      const models: any[] = Array.isArray(provider.models) ? provider.models : [];
      for (const model of models) {
        const modelName = String(model?.name ?? "").trim();
        if (!providerName || !modelName) continue;
        options.push({
          value: `${providerName}/${modelName}`,
          label: `${providerLabel} / ${modelName}`,
        });
      }
    }
    return options;
  }, [configSnapshot]);
  const activeModelProfile = useMemo(
    () => resolveChatModelProfile(configSnapshot, conversation?.modelRef, activeAgentName),
    [configSnapshot, conversation?.modelRef, activeAgentName],
  );
  const selectedModelRef = useMemo(() => {
    const explicitModelRef = String(conversation?.modelRef ?? "").trim();
    if (explicitModelRef && modelOptions.some((option) => option.value === explicitModelRef)) {
      return explicitModelRef;
    }
    return activeModelProfile?.modelRef ?? "";
  }, [conversation?.modelRef, activeModelProfile?.modelRef, modelOptions]);
  const activeModelLabel = useMemo(() => {
    const matched = modelOptions.find((option) => option.value === selectedModelRef);
    return matched?.label ?? activeModelProfile?.modelName ?? "未选择模型";
  }, [activeModelProfile?.modelName, modelOptions, selectedModelRef]);
  const supportsThinking = activeModelProfile?.capabilities.thinking ?? false;
  const supportsVision = activeModelProfile?.capabilities.vision ?? false;
  const supportsWebSearch = activeModelProfile?.capabilities.webSearch ?? false;
  const showThinkingLevelSelector = isResponsesProtocol(
    activeModelProfile?.providerType,
    activeModelProfile?.useReasoningEffort,
  );
  const effectiveThinkingMode = useMemo(
    () =>
      supportsThinking
        ? normalizeThinkingMode(
            conversation?.thinkingMode,
            activeModelProfile?.providerType,
            activeModelProfile?.useReasoningEffort,
          )
        : undefined,
    [
      activeModelProfile?.providerType,
      activeModelProfile?.useReasoningEffort,
      conversation?.thinkingMode,
      supportsThinking,
    ],
  );
  const effectiveWebSearchEnabled = supportsWebSearch
    ? conversation?.webSearchEnabled ?? true
    : false;
  const voiceInputSupported = useMemo(() => supportsVoiceInput(), []);
  const isVoiceInputBusy = voiceInputState !== "idle";
  const voiceStatusText =
    voiceInputState === "requesting"
      ? "正在请求麦克风权限…"
      : voiceInputState === "processing"
        ? "正在整理语音…"
        : voiceInputState === "listening"
          ? "正在听写，点击麦克风结束"
          : "";

  const maybeGenerateConversationTitle = useCallback(
    async (conversationId: string, assistantContent: string) => {
      if (!isTauriRuntime()) return;

      const state = useConversationStore.getState();
      const target = state.conversations.find((c) => c.id === conversationId);
      if (!target) return;
      if (!target.title.startsWith("新对话")) return;

      const latestAssistant = [...target.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const toolRoundCount = Array.isArray(latestAssistant?.toolCalls)
        ? latestAssistant.toolCalls.length
        : 0;

      const shouldGenerate =
        target.messages.length >= 3 ||
        assistantContent.trim().length >= 100 ||
        toolRoundCount >= 2;
      if (!shouldGenerate) return;

      const requestMessages = target.messages.slice(0, 6).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      if (requestMessages.length === 0) return;

      try {
        const resolvedModelRef = resolveEffectiveModelRef(
          configSnapshot,
          target.modelRef,
          target.agentName || fallbackAgentName || null,
        );
        const rawTitle = await tauriInvoke<string>("mobile_generate_title", {
          messages: requestMessages,
          agentName: target.agentName || fallbackAgentName || null,
          modelRef: resolvedModelRef,
        });

        const title = String(rawTitle ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 48);
        if (!title) return;
        state.setTitle(conversationId, title);
      } catch {
        // ignore
      }
    },
    [configSnapshot, fallbackAgentName],
  );

  const bindMessageNode = useCallback((messageId: string, node: HTMLDivElement | null) => {
    if (!node) {
      messageNodeByIdRef.current.delete(messageId);
      return;
    }
    messageNodeByIdRef.current.set(messageId, node);
  }, []);

  const scrollToMessage = useCallback((messageId: string) => {
    const node = messageNodeByIdRef.current.get(messageId);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handleOutlineSelect = useCallback(
    (messageId: string) => {
      setSelectedRequestMessageId(messageId);
      scrollToMessage(messageId);
      setOutlineOpen(false);
    },
    [scrollToMessage],
  );

  const handleTouchStartCapture = (event: TouchEvent<HTMLDivElement>) => {
    if (layout !== "compact") return;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchGestureRef.current = { startX: touch.clientX, startY: touch.clientY };
  };

  const handleTouchEndCapture = (event: TouchEvent<HTMLDivElement>) => {
    if (layout !== "compact") return;
    const start = touchGestureRef.current;
    touchGestureRef.current = null;
    if (!start || event.changedTouches.length !== 1) return;

    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.startX;
    const dy = touch.clientY - start.startY;

    if (Math.abs(dx) < 44) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.2) return;

    if (!outlineOpen) {
      if (start.startX <= 24 && dx > 56) {
        setOutlineOpen(true);
      }
      return;
    }

    if (dx < -56) {
      setOutlineOpen(false);
    }
  };

  useEffect(() => {
    setDraftAttachments([]);
    setAttachmentError("");
    setAttachmentBusy(false);
    setVoiceError("");
    setVoiceInputState("idle");
  }, [conversation?.id]);

  const openAttachmentPicker = useCallback(() => {
    if (sending || attachmentBusy) return;
    fileInputRef.current?.click();
  }, [attachmentBusy, sending]);

  const openCameraPicker = useCallback(() => {
    if (sending || attachmentBusy || !supportsVision) return;
    cameraInputRef.current?.click();
  }, [attachmentBusy, sending, supportsVision]);

  const removeDraftAttachment = useCallback((attachmentId: string) => {
    setDraftAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const handleAttachmentInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;

      setAttachmentBusy(true);
      setAttachmentError("");
      try {
        const { attachments, warnings } = await loadChatDraftAttachments(files, {
          allowImages: supportsVision,
        });
        if (attachments.length > 0) {
          setDraftAttachments((prev) => [...prev, ...attachments]);
        }
        if (warnings.length > 0) {
          setAttachmentError(warnings.join("；"));
        }
      } catch (error) {
        setAttachmentError(String(error instanceof Error ? error.message : error));
      } finally {
        setAttachmentBusy(false);
      }
    },
    [supportsVision],
  );

  const stopVoiceInput = useCallback((mode: "stop" | "abort" = "stop") => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setVoiceInputState("idle");
      return;
    }
    setVoiceInputState("processing");
    try {
      if (mode === "abort") {
        recognition.abort();
      } else {
        recognition.stop();
      }
    } catch {
      recognitionRef.current = null;
      setVoiceInputState("idle");
    }
  }, []);

  const handleVoiceToggle = useCallback(async () => {
    if (sending || attachmentBusy) return;
    if (recognitionRef.current) {
      stopVoiceInput("stop");
      return;
    }

    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setVoiceError("当前系统 WebView 不支持语音听写，请升级系统 WebView/Chrome 后重试。");
      return;
    }

    setVoiceError("");
    setVoiceInputState("requesting");
    try {
      await ensureMicrophonePermission();
    } catch (error) {
      setVoiceInputState("idle");
      setVoiceError(mapMicrophonePermissionError(error));
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    voiceBaseInputRef.current = input;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh-CN";

    recognition.onstart = () => {
      setVoiceInputState("listening");
      setVoiceError("");
    };
    recognition.onresult = (event) => {
      const { finalTranscript, interimTranscript } = collectSpeechSegments(event);
      updateInput(mergeVoiceText(voiceBaseInputRef.current, finalTranscript, interimTranscript));
      setVoiceInputState("listening");
    };
    recognition.onerror = (event) => {
      const message = mapVoiceInputError(event.error);
      recognitionRef.current = null;
      setVoiceInputState("idle");
      if (message) {
        setVoiceError(message);
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setVoiceInputState("idle");
    };

    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setVoiceInputState("idle");
      setVoiceError(String(error instanceof Error ? error.message : error) || "启动语音输入失败");
    }
  }, [attachmentBusy, input, sending, stopVoiceInput, updateInput]);

  useEffect(() => {
    if (conversation?.id == null) return;
    if (!recognitionRef.current) {
      setVoiceInputState("idle");
      return;
    }
    stopVoiceInput("abort");
  }, [conversation?.id, stopVoiceInput]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const insertDollar = () => {
    if (sending) return;
    const el = inputRef.current;
    const current = input;
    if (!el) {
      updateInput(current ? `${current}$` : "$");
      return;
    }

    const start = typeof el.selectionStart === "number" ? el.selectionStart : current.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : current.length;
    const next = current.slice(0, start) + "$" + current.slice(end);
    updateInput(next);

    requestAnimationFrame(() => {
      try {
        el.focus();
        const pos = start + 1;
        el.setSelectionRange(pos, pos);
      } catch {
        // ignore
      }
    });
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const cleanupStream = async (cancelBackend: boolean) => {
    const active = activeStreamRef.current;
    activeStreamRef.current = null;
    setStreamingAssistantState(null);
    const unlisten = unlistenRef.current;
    unlistenRef.current = null;
    if (unlisten) unlisten();
    if (cancelBackend && active && isTauriRuntime()) {
      try {
        await tauriInvoke<void>("mobile_chat_stream_cancel", { streamId: active.streamId });
      } catch {
        // ignore
      }
    }
  };

  // 切换会话/卸载页面时：取消正在进行的流式输出，避免 token 串到别的对话。
  useEffect(() => {
    return () => {
      void cleanupStream(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id]);

  const send = useCallback(
    async (options?: SendOptions) => {
      if (!conversation) return;
      if (sending || attachmentBusy || isVoiceInputBusy) return;

      const rawContent = options?.content ?? input;
      const content = rawContent.trim();
      const contentParts = options?.contentParts ?? toAttachmentContentParts(draftAttachments);
      if (!content && contentParts.length === 0) return;

      let assistantMessageId: string | null = null;
      const baseMessages = options?.baseMessages ?? messages;
      const requestThinkingMode = supportsThinking
        ? effectiveThinkingMode === undefined
          ? true
          : effectiveThinkingMode
        : null;
      const requestWebSearchEnabled = supportsWebSearch ? effectiveWebSearchEnabled : null;
      const showThinkingLabel = requestThinkingMode !== false && requestThinkingMode != null;

      const userMessage: ChatMessage = {
        id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        role: "user",
        content,
        contentParts: contentParts.length > 0 ? contentParts : undefined,
        createdAt: Date.now(),
      };
      appendMessage(conversation.id, userMessage);
      if (options?.content === undefined) {
        updateInput("");
        setDraftAttachments([]);
        setAttachmentError("");
      }
      setSending(true);
      queueMicrotask(scrollToBottom);

      try {
        if (!isTauriRuntime()) {
          appendMessage(conversation.id, {
            id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            role: "assistant",
            content: "当前在浏览器预览模式，无法调用 Tauri 后端。请在 App 内运行。",
            createdAt: Date.now(),
          });
          return;
        }

        assistantMessageId = `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        appendMessage(conversation.id, {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
        });

        const history = [...baseMessages, userMessage].slice(-40).map((message) => ({
          role: message.role,
          content: message.content,
          contentParts: Array.isArray(message.contentParts) && message.contentParts.length > 0 ? message.contentParts : undefined,
        }));
        const streamId = `s_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        await cleanupStream(true);
        setStreamingAssistantState({
          messageId: assistantMessageId,
          showThinkingLabel,
        });

        unlistenRef.current = await tauriListen<MobileChatStreamPayload>(
          "mobile_chat_stream",
          (payload) => {
            if (!payload || payload.streamId !== streamId) return;
            if (payload.conversationId !== conversation.id) return;
            if (assistantMessageId && payload.assistantMessageId !== assistantMessageId) return;

            if (payload.kind === "delta") {
              if (payload.delta && assistantMessageId) {
                appendMessageDelta(conversation.id, assistantMessageId, payload.delta);
              }
              return;
            }

            if (payload.kind === "thinking") {
              if (payload.delta && assistantMessageId) {
                appendThinkingDelta(conversation.id, assistantMessageId, payload.delta);
              }
              return;
            }

            if (payload.kind === "web_search") {
              const id = String(payload.data?.id ?? "").trim();
              const status = String(payload.data?.status ?? "").trim();
              const action = payload.data?.action;
              if (assistantMessageId && id) {
                upsertWebSearchEvent(conversation.id, assistantMessageId, { id, status, action });
              }
              return;
            }

            if (payload.kind === "tool_calls") {
              const calls = Array.isArray(payload.data?.calls) ? payload.data.calls : [];
              if (assistantMessageId && calls.length > 0) {
                setToolCalls(
                  conversation.id,
                  assistantMessageId,
                  calls
                    .map((call: any) => ({
                      id: String(call?.id ?? "").trim(),
                      name: String(call?.name ?? "").trim(),
                      arguments: String(call?.arguments ?? ""),
                    }))
                    .filter((call: any) => call.id && call.name),
                );
              }
              return;
            }

            if (payload.kind === "tool_result") {
              const id = String(payload.data?.id ?? "").trim();
              const name = payload.data?.name != null ? String(payload.data.name).trim() : undefined;
              const output = payload.data?.output != null ? String(payload.data.output) : undefined;
              const error = payload.data?.error != null ? String(payload.data.error) : undefined;
              if (assistantMessageId && id) {
                setToolCallResult(conversation.id, assistantMessageId, { id, name, output, error });
              }
              return;
            }

            if (payload.kind === "done") {
              const final = payload.content ?? "";
              if (assistantMessageId) {
                const patch: { content: string; thinking?: string } = { content: final };
                if (typeof payload.thinking === "string" && payload.thinking.trim()) {
                  patch.thinking = payload.thinking;
                }
                finalizeMessage(conversation.id, assistantMessageId, patch);
                void maybeGenerateConversationTitle(conversation.id, final);
              }
              setSending(false);
              void cleanupStream(false);
              return;
            }

            if (payload.kind === "canceled") {
              setSending(false);
              void cleanupStream(false);
              return;
            }

            if (payload.kind === "error") {
              if (assistantMessageId) {
                finalizeMessage(conversation.id, assistantMessageId, {
                  content: `请求失败：${payload.error ? String(payload.error) : "未知错误"}`,
                });
              }
              setSending(false);
              void cleanupStream(false);
            }
          },
        );

        activeStreamRef.current = {
          streamId,
          conversationId: conversation.id,
          assistantMessageId: assistantMessageId ?? "",
        };

        await tauriInvoke<void>("mobile_chat_stream_start", {
          streamId,
          conversationId: conversation.id,
          assistantMessageId: assistantMessageId!,
          messages: history,
          agentName: conversation.agentName || fallbackAgentName || null,
          modelRef: selectedModelRef || null,
          thinkingMode: requestThinkingMode,
          webSearchEnabled: requestWebSearchEnabled,
        });
      } catch (error) {
        if (assistantMessageId) {
          finalizeMessage(conversation.id, assistantMessageId, {
            content: `请求失败：${String(error)}`,
          });
        } else {
          appendMessage(conversation.id, {
            id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            role: "assistant",
            content: `请求失败：${String(error)}`,
            createdAt: Date.now(),
          });
        }
      } finally {
        if (activeStreamRef.current == null) {
          setSending(false);
          setStreamingAssistantState(null);
        }
      }
    },
    [
      appendMessage,
      appendMessageDelta,
      appendThinkingDelta,
      attachmentBusy,
      cleanupStream,
      conversation,
      draftAttachments,
      isVoiceInputBusy,
      effectiveThinkingMode,
      effectiveWebSearchEnabled,
      fallbackAgentName,
      finalizeMessage,
      input,
      maybeGenerateConversationTitle,
      messages,
      selectedModelRef,
      sending,
      setToolCallResult,
      setToolCalls,
      supportsThinking,
      supportsWebSearch,
      upsertWebSearchEvent,
    ],
  );

  const handleRetryMessage = useCallback(
    async (assistantMessageId: string) => {
      if (!conversation || sending) return;
      const retryContext = findRetryContext(messages, assistantMessageId);
      if (!retryContext) return;
      replaceConversationMessages(conversation.id, retryContext.baseMessages);
      await send({
        content: retryContext.userContent,
        contentParts: retryContext.userContentParts,
        baseMessages: retryContext.baseMessages,
      });
    },
    [conversation, messages, replaceConversationMessages, send, sending],
  );

  return (
    <div
      className="relative h-full flex flex-col overflow-x-hidden"
      onTouchStartCapture={handleTouchStartCapture}
      onTouchEndCapture={handleTouchEndCapture}
    >
      {layout === "compact" ? (
        <div className="safe-top border-b border-white/10 bg-white/5">
          <div className="h-12 flex items-center justify-between px-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{conversation?.title ?? "Chat"}</div>
              <div className="text-[11px] text-white/60 truncate">
                {activeAgentLabel ? `Agent: ${activeAgentLabel}` : "Agent: 未选择"}
              </div>
              <div className="text-[11px] text-white/45 truncate">
                {`Model: ${activeModelLabel}`}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className={clsx("gap-1 px-2", outlineOpen ? "bg-white/10" : "")}
                onClick={() => setOutlineOpen((v) => !v)}
                title={outlineOpen ? "隐藏消息目录" : "显示消息目录"}
              >
                <ListOrdered size={16} />
                <span className="text-[10px] leading-none">{outlineItems.length}</span>
              </Button>
              {onNewConversation ? (
                <Button size="sm" variant="ghost" onClick={onNewConversation} title="新建对话">
                  <Plus size={16} />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {layout === "compact" ? (
        <ChatOutlineDrawer
          open={outlineOpen}
          items={outlineItems}
          selectedMessageId={selectedRequestMessageId}
          selectedFullText={selectedOutlineFullText}
          onClose={() => setOutlineOpen(false)}
          onToggle={() => setOutlineOpen((v) => !v)}
          onSelect={handleOutlineSelect}
        />
      ) : null}

      {onReturnToPractice && returnToPracticeLabel ? (
        <div className="border-b border-white/10 bg-indigo-500/10 px-3 py-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-300/25 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100 transition-colors hover:bg-indigo-500/20"
            onClick={onReturnToPractice}
          >
            <RotateCcw size={14} />
            <span>{returnToPracticeLabel}</span>
          </button>
        </div>
      ) : null}

      {modelOptions.length > 0 ? (
        <div className="border-b border-white/10 bg-white/5 px-3 py-2 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-white/45">模型</div>
              <div className="text-xs text-white/65 truncate">{activeModelLabel}</div>
            </div>
            <div className="w-[min(64vw,280px)] max-w-[280px] shrink-0">
              <Select
                value={selectedModelRef}
                disabled={sending}
                onChange={(event) => {
                  if (!conversation) return;
                  patchConversation(conversation.id, {
                    modelRef: event.target.value || undefined,
                  });
                }}
              >
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      ) : null}

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-none overflow-x-hidden p-3 space-y-3"
      >
        {messages.map((m) => {
          const assistantBlocks = m.role === "assistant" ? getAssistantMessageBlocks(m) : [];
          const isStreamingAssistant =
            sending && m.id === streamingAssistantState?.messageId;
          const showPendingAssistantBubble =
            m.role === "assistant" && isStreamingAssistant && assistantBlocks.length === 0;
          const retryAssistantMessageId =
            m.role === "user" ? findRetryAssistantMessageId(messages, m.id) : null;
          const userAttachments = m.role === "user" ? getChatAttachmentParts(m.contentParts) : [];

          return (
            <div
              key={m.id}
              ref={(node) => bindMessageNode(m.id, node)}
              className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              {m.role === "assistant" ? (
                <div className="max-w-[85%] w-full min-w-0 space-y-2 overflow-x-hidden">
                  {assistantBlocks.map((b) => {
                    if (b.type === "thinking") {
                      return (
                        <ThinkingBlock
                          key={b.id}
                          text={b.text}
                          isStreaming={isStreamingAssistant}
                        />
                      );
                    }

                    if (b.type === "web_search") {
                      return (
                        <WebSearchBlock
                          key={b.id}
                          status={b.event.status}
                          action={b.event.action}
                          isStreaming={
                            sending &&
                            b.event.status !== "completed" &&
                            b.event.status !== "failed"
                          }
                        />
                      );
                    }

                    if (b.type === "tool_call") {
                      return (
                        <ToolCallBlock
                          key={b.id}
                          name={b.call.name}
                          args={b.call.arguments}
                          output={b.call.output}
                          error={b.call.error}
                        />
                      );
                    }

                    return (
                      <div
                        key={b.id}
                        className={clsx(
                          "rounded-2xl px-3 py-2 text-sm break-words border overflow-x-hidden min-w-0",
                          "bg-white/5 border-white/10",
                        )}
                      >
                        {renderMode === "rich" ? (
                          <RichText content={b.text} />
                        ) : (
                          <div className="whitespace-pre-wrap break-words">{b.text}</div>
                        )}
                      </div>
                    );
                  })}

                  {showPendingAssistantBubble ? (
                    <PendingAssistantBlock
                      label={streamingAssistantState?.showThinkingLabel ? "思考中…" : "正在回复…"}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="max-w-[85%] min-w-0 space-y-1.5">
                  <div
                    className={clsx(
                      "min-w-0 rounded-2xl px-3 py-2 text-sm break-words border overflow-x-hidden",
                      "bg-indigo-500/20 border-indigo-400/30",
                    )}
                  >
                    {userAttachments.length > 0 ? (
                      <div className="mb-2 flex flex-wrap justify-end gap-2">
                        {userAttachments.map((part, index) => {
                          if (part.type === "image") {
                            return (
                              <img
                                key={`${m.id}_att_${index}`}
                                src={part.url}
                                alt="用户附件"
                                className="h-16 w-16 rounded-lg border border-indigo-200/20 object-cover bg-black/20"
                              />
                            );
                          }

                          return (
                            <div
                              key={`${m.id}_att_${index}`}
                              className="inline-flex max-w-full items-center gap-2 rounded-full border border-indigo-200/20 bg-black/20 px-3 py-1 text-[11px] text-indigo-50/90"
                            >
                              <FileText size={12} />
                              <span className="truncate max-w-[180px]">
                                {part.type === "pdf_document"
                                  ? `${part.filename}${part.totalPages > 0 ? ` · ${part.totalPages} 页` : ""}`
                                  : part.filename}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {m.content.trim() ? (
                      renderMode === "rich" ? (
                        <RichText content={m.content} />
                      ) : (
                        <div className="whitespace-pre-wrap break-words">{m.content}</div>
                      )
                    ) : userAttachments.length === 0 ? (
                      <div className="text-white/70">（空消息）</div>
                    ) : null}
                  </div>

                  {!sending && retryAssistantMessageId ? (
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 rounded px-2 text-[10px] text-white/75"
                        onClick={() => void handleRetryMessage(retryAssistantMessageId)}
                        title="重试该轮"
                      >
                        <RotateCcw size={12} />
                        <span>重试</span>
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="safe-bottom border-t border-white/10 bg-[#0b1220] p-2 space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept={MOBILE_ATTACHMENT_ACCEPT}
          onChange={handleAttachmentInputChange}
        />
        <input
          ref={cameraInputRef}
          type="file"
          className="hidden"
          accept="image/*"
          capture="environment"
          onChange={handleAttachmentInputChange}
        />

        {draftAttachments.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto pb-0.5">
            {draftAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/80"
              >
                {attachment.kind === "image" ? (
                  <img
                    src={attachment.contentPart.url}
                    alt={attachment.label}
                    className="h-7 w-7 rounded-md object-cover bg-black/20"
                  />
                ) : (
                  <FileText size={12} className="shrink-0 text-white/70" />
                )}
                <div className="min-w-0">
                  <div className="max-w-[140px] truncate">{attachment.label}</div>
                  <div className="text-[10px] text-white/45">
                    {attachment.kind === "pdf"
                      ? `${attachment.totalPages} 页 · ${formatAttachmentBytes(attachment.size)}`
                      : formatAttachmentBytes(attachment.size)}
                  </div>
                </div>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/5 text-white/65"
                  onClick={() => removeDraftAttachment(attachment.id)}
                  title="移除附件"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {attachmentBusy ? (
          <div className="flex items-center gap-1 text-[11px] text-white/55">
            <LoaderCircle size={12} className="animate-spin" />
            <span>正在处理附件…</span>
          </div>
        ) : null}

        {attachmentError ? <div className="text-[11px] text-amber-200">{attachmentError}</div> : null}
        {voiceStatusText ? (
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/80">
            <span
              className={clsx(
                "inline-block h-2 w-2 rounded-full",
                voiceInputState === "listening" ? "bg-rose-400 animate-pulse" : "bg-amber-300 animate-pulse",
              )}
            />
            <span>{voiceStatusText}</span>
          </div>
        ) : null}
        {voiceError ? <div className="text-[11px] text-red-300">{voiceError}</div> : null}

        <div className="flex items-end gap-2">
          <button
            type="button"
            className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
            onClick={openAttachmentPicker}
            disabled={sending || attachmentBusy || isVoiceInputBusy}
            title={supportsVision ? "添加图片、文本文件或 PDF" : "添加文本文件或 PDF"}
          >
            <Paperclip size={16} />
            {draftAttachments.length > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-indigo-500 px-1 text-[10px] text-white">
                {draftAttachments.length}
              </span>
            ) : null}
          </button>

          {supportsVision ? (
            <button
              type="button"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
              onClick={openCameraPicker}
              disabled={sending || attachmentBusy || isVoiceInputBusy}
              title="拍照"
            >
              <Camera size={16} />
            </button>
          ) : null}

          <button
            type="button"
            className={clsx(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50",
              isVoiceInputBusy
                ? "border-rose-300/40 bg-rose-500/20 text-rose-100"
                : "border-white/10 bg-white/5 text-white/80 hover:bg-white/10",
            )}
            onClick={() => void handleVoiceToggle()}
            disabled={sending || attachmentBusy || voiceInputState === "requesting" || voiceInputState === "processing"}
            title={isVoiceInputBusy ? "结束语音输入" : voiceInputSupported ? "语音输入" : "当前设备不支持语音输入"}
          >
            {voiceInputState === "processing" ? <LoaderCircle size={16} className="animate-spin" /> : <Mic size={16} />}
          </button>

          {supportsThinking ? (
            showThinkingLevelSelector ? (
              <div className="relative w-[76px] shrink-0">
                <Brain size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-white/55" />
                <Select
                  className="h-10 w-full shrink-0 pl-7 pr-1 text-[13px]"
                  aria-label="思考级别"
                  title="思考级别"
                  value={typeof effectiveThinkingMode === "string" ? effectiveThinkingMode ?? "" : ""}
                  disabled={sending || attachmentBusy || isVoiceInputBusy || !conversation}
                  onChange={(e) => {
                    if (!conversation) return;
                    const value = e.target.value;
                    patchConversation(conversation.id, {
                      thinkingMode: (value === "" ? null : value) as ThinkingMode,
                    });
                  }}
                >
                  <option value="">关</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  {activeModelProfile?.providerType !== "google" ? <option value="xhigh">超</option> : null}
                </Select>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className={clsx(
                  "h-10 w-10 shrink-0 px-0",
                  effectiveThinkingMode ? "bg-violet-500/20 text-violet-100" : "text-white/70",
                )}
                disabled={sending || attachmentBusy || isVoiceInputBusy || !conversation}
                onClick={() => {
                  if (!conversation) return;
                  patchConversation(conversation.id, {
                    thinkingMode: Boolean(effectiveThinkingMode) ? false : true,
                  });
                }}
                title={effectiveThinkingMode ? "关闭思考" : "开启思考"}
              >
                <Brain size={14} />
              </Button>
            )
          ) : null}

          {supportsWebSearch ? (
            <Button
              size="sm"
              variant="ghost"
              className={clsx(
                "h-10 w-10 shrink-0 px-0",
                effectiveWebSearchEnabled ? "bg-amber-500/20 text-amber-100" : "text-white/70",
              )}
              disabled={sending || attachmentBusy || isVoiceInputBusy || !conversation}
              onClick={() => {
                if (!conversation) return;
                patchConversation(conversation.id, {
                  webSearchEnabled: !effectiveWebSearchEnabled,
                });
              }}
              title={effectiveWebSearchEnabled ? "关闭搜索" : "开启搜索"}
            >
              <Search size={14} />
            </Button>
          ) : null}

          <div className="flex-1 min-w-0">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                updateInput(e.target.value);
                if (voiceError) setVoiceError("");
              }}
              placeholder={voiceInputState === "listening" ? "正在听写…" : attachmentBusy ? "附件处理中…" : sending ? "发送中…" : "输入消息…"}
              disabled={sending || attachmentBusy || voiceInputState === "requesting"}
              readOnly={isVoiceInputBusy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>

          <Button
            variant="ghost"
            className="h-10 w-9 shrink-0 px-0 font-mono"
            onClick={insertDollar}
            disabled={sending || attachmentBusy || isVoiceInputBusy}
            title="插入 $"
          >
            $
          </Button>

          <Button
            className="h-10 w-10 shrink-0 px-0"
            onClick={() => void send()}
            disabled={sending || attachmentBusy || isVoiceInputBusy || (!input.trim() && draftAttachments.length === 0)}
            title="发送"
          >
            <SendHorizontal size={18} />
          </Button>
        </div>
      </div>
    </div>
  );
}
