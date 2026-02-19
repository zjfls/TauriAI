import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { ListOrdered, Plus, SendHorizontal } from "lucide-react";
import { isTauriRuntime, tauriInvoke, tauriListen, type UnlistenFn } from "../lib/tauri";
import { clsx } from "../lib/clsx";
import { useLayoutSize } from "../lib/breakpoints";
import { loadChatRenderMode } from "../lib/chatRenderPrefs";
import { Button } from "../ui/Button";
import { ThinkingBlock, ToolCallBlock, WebSearchBlock } from "../ui/ChatBlocks";
import { ChatOutlineDrawer } from "../ui/ChatOutlineDrawer";
import { Input } from "../ui/Input";
import { RichText } from "../ui/RichText";
import type { ChatMessage } from "../types/chat";
import { useConversationStore } from "../stores/conversationStore";

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

export function ChatPage({ onNewConversation }: { onNewConversation?: () => void }) {
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
  } = useConversationStore();
  const conversation = useMemo(() => {
    const c =
      (activeConversationId && conversations.find((x) => x.id === activeConversationId)) ||
      conversations[0];
    return c;
  }, [activeConversationId, conversations]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fallbackAgentName, setFallbackAgentName] = useState<string>("");
  const [agentLabels, setAgentLabels] = useState<Record<string, string>>({});
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

  const messages = conversation?.messages ?? [];
  const outlineItems = useMemo(() => {
    const items: Array<{ messageId: string; index: number; preview: string }> = [];
    let index = 0;
    for (const m of messages) {
      if (m.role !== "user") continue;
      index += 1;
      const preview = m.content.replace(/\s+/g, " ").trim().slice(0, 96);
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
    return msg?.content ?? null;
  }, [messages, selectedRequestMessageId]);

  // 读取渲染模式（默认 rich）。不做 memo，方便 Settings 修改后即时生效。
  const renderMode = loadChatRenderMode();

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

      const def = String(cfg?.defaultAgent ?? cfg?.default_agent ?? "").trim();
      if (def) setFallbackAgentName(def);

      const next: Record<string, string> = {};
      const list: any[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
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
        const rawTitle = await tauriInvoke<string>("mobile_generate_title", {
          messages: requestMessages,
          agentName: target.agentName || fallbackAgentName || null,
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
    [fallbackAgentName],
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

  const insertDollar = () => {
    if (sending) return;
    const el = inputRef.current;
    const current = input;
    if (!el) {
      setInput(current ? `${current}$` : "$");
      return;
    }

    const start = typeof el.selectionStart === "number" ? el.selectionStart : current.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : current.length;
    const next = current.slice(0, start) + "$" + current.slice(end);
    setInput(next);

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

  const send = async () => {
    if (!conversation) return;
    const content = input.trim();
    if (!content) return;
    if (sending) return;

    let assistantMessageId: string | null = null;

    const userMessage: ChatMessage = {
      id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role: "user",
      content,
      createdAt: Date.now(),
    };
    appendMessage(conversation.id, userMessage);
    setInput("");
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

      // 创建一个 assistant 占位消息，后续流式 token 会追加到它上面。
      assistantMessageId = `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      appendMessage(conversation.id, {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      });

      const history = [...messages, userMessage].slice(-40).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const streamId = `s_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await cleanupStream(true);

      unlistenRef.current = await tauriListen<MobileChatStreamPayload>(
        "mobile_chat_stream",
        (p) => {
          if (!p || p.streamId !== streamId) return;
          if (p.conversationId !== conversation.id) return;
          if (assistantMessageId && p.assistantMessageId !== assistantMessageId) return;

          if (p.kind === "delta") {
            if (p.delta && assistantMessageId) {
              appendMessageDelta(conversation.id, assistantMessageId, p.delta);
            }
            return;
          }

          if (p.kind === "thinking") {
            if (p.delta && assistantMessageId) {
              appendThinkingDelta(conversation.id, assistantMessageId, p.delta);
            }
            return;
          }

          if (p.kind === "web_search") {
            const id = String(p.data?.id ?? "").trim();
            const status = String(p.data?.status ?? "").trim();
            const action = p.data?.action;
            if (assistantMessageId && id) {
              upsertWebSearchEvent(conversation.id, assistantMessageId, { id, status, action });
            }
            return;
          }

          if (p.kind === "tool_calls") {
            const calls = Array.isArray(p.data?.calls) ? p.data.calls : [];
            if (assistantMessageId && calls.length > 0) {
              setToolCalls(
                conversation.id,
                assistantMessageId,
                calls
                  .map((c: any) => ({
                    id: String(c?.id ?? "").trim(),
                    name: String(c?.name ?? "").trim(),
                    arguments: String(c?.arguments ?? ""),
                  }))
                  .filter((c: any) => c.id && c.name),
              );
            }
            return;
          }

          if (p.kind === "tool_result") {
            const id = String(p.data?.id ?? "").trim();
            const output = p.data?.output != null ? String(p.data.output) : undefined;
            const error = p.data?.error != null ? String(p.data.error) : undefined;
            if (assistantMessageId && id) {
              setToolCallResult(conversation.id, assistantMessageId, { id, output, error });
            }
            return;
          }

          if (p.kind === "done") {
            const final = p.content ?? "";
            if (assistantMessageId) {
              const patch: { content: string; thinking?: string } = { content: final };
              if (typeof p.thinking === "string" && p.thinking.trim()) {
                patch.thinking = p.thinking;
              }
              finalizeMessage(conversation.id, assistantMessageId, patch);
              void maybeGenerateConversationTitle(conversation.id, final);
            }
            setSending(false);
            void cleanupStream(false);
            return;
          }

          if (p.kind === "canceled") {
            setSending(false);
            void cleanupStream(false);
            return;
          }

          if (p.kind === "error") {
            if (assistantMessageId) {
              finalizeMessage(conversation.id, assistantMessageId, {
                content: `请求失败：${p.error ? String(p.error) : "未知错误"}`,
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
      });

      // 后续由 event 推送更新；这里不再等待完整响应。
    } catch (e) {
      if (assistantMessageId) {
        finalizeMessage(conversation.id, assistantMessageId, { content: `请求失败：${String(e)}` });
      } else {
        appendMessage(conversation.id, {
          id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: `请求失败：${String(e)}`,
          createdAt: Date.now(),
        });
      }
    } finally {
      // sending 的关闭由 done/error/canceled 事件驱动；这里兜底，防止 start 之前抛错导致卡住。
      if (activeStreamRef.current == null) {
        setSending(false);
      }
    }
  };

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

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-none overflow-x-hidden p-3 space-y-3"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            ref={(node) => bindMessageNode(m.id, node)}
            className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}
          >
            {m.role === "assistant" ? (
              <div className="max-w-[85%] w-full min-w-0 space-y-2 overflow-x-hidden">
                {m.thinking ? (
                  <ThinkingBlock
                    text={m.thinking}
                    isStreaming={sending && m.id === activeStreamRef.current?.assistantMessageId}
                  />
                ) : null}
                {Array.isArray(m.webSearch) && m.webSearch.length > 0
                  ? m.webSearch.map((w) => (
                      <WebSearchBlock
                        key={w.id}
                        status={w.status}
                        action={w.action}
                        isStreaming={sending && w.status !== "completed" && w.status !== "failed"}
                      />
                    ))
                  : null}
                {Array.isArray(m.toolCalls) && m.toolCalls.length > 0
                  ? m.toolCalls.map((t) => (
                      <ToolCallBlock
                        key={t.id}
                        name={t.name}
                        args={t.arguments}
                        output={t.output}
                        error={t.error}
                      />
                    ))
                  : null}

                <div
                  className={clsx(
                    "rounded-2xl px-3 py-2 text-sm break-words border overflow-x-hidden min-w-0",
                    "bg-white/5 border-white/10",
                  )}
                >
                  {renderMode === "rich" ? (
                    <RichText content={m.content} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  )}
                </div>
              </div>
            ) : (
              <div
                className={clsx(
                  "max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-sm break-words border overflow-x-hidden",
                  "bg-indigo-500/20 border-indigo-400/30",
                )}
              >
                {renderMode === "rich" ? (
                  <RichText content={m.content} />
                ) : (
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="safe-bottom border-t border-white/10 bg-[#0b1220] p-2">
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={sending ? "发送中…" : "输入消息…"}
              disabled={sending}
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
            className="w-10 shrink-0 font-mono"
            onClick={insertDollar}
            disabled={sending}
            title="插入 $"
          >
            $
          </Button>
          <Button onClick={() => void send()} disabled={sending || !input.trim()}>
            <SendHorizontal size={18} />
          </Button>
        </div>
      </div>
    </div>
  );
}
