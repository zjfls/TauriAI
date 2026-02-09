import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, SendHorizontal } from "lucide-react";
import { isTauriRuntime, tauriInvoke, tauriListen, type UnlistenFn } from "../lib/tauri";
import { clsx } from "../lib/clsx";
import { useLayoutSize } from "../lib/breakpoints";
import { loadChatRenderMode } from "../lib/chatRenderPrefs";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { RichText } from "../ui/RichText";
import type { ChatMessage } from "../types/chat";
import { useConversationStore } from "../stores/conversationStore";

type MobileChatStreamPayload = {
  streamId: string;
  conversationId: string;
  assistantMessageId: string;
  kind: "delta" | "thinking" | "done" | "error" | "canceled";
  delta?: string;
  content?: string;
  thinking?: string;
  error?: string;
};

export function ChatPage({ onNewConversation }: { onNewConversation?: () => void }) {
  const layout = useLayoutSize();
  const { conversations, activeConversationId, appendMessage, appendMessageDelta, setMessageContent } =
    useConversationStore();
  const conversation = useMemo(() => {
    const c =
      (activeConversationId && conversations.find((x) => x.id === activeConversationId)) ||
      conversations[0];
    return c;
  }, [activeConversationId, conversations]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [fallbackAgentName, setFallbackAgentName] = useState<string>("");
  const [agentLabels, setAgentLabels] = useState<Record<string, string>>({});
  const [appConfig, setAppConfig] = useState<any | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeStreamRef = useRef<{
    streamId: string;
    conversationId: string;
    assistantMessageId: string;
  } | null>(null);

  const messages = conversation?.messages ?? [];
  // 读取渲染模式（默认 rich）。不做 memo，方便 Settings 修改后即时生效。
  const renderMode = loadChatRenderMode();

  const loadConfig = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const cfg = await tauriInvoke<any>("get_app_config");
      setAppConfig(cfg ?? null);

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

  const activeModelName = useMemo(() => {
    const cfg = appConfig;
    if (!cfg || typeof cfg !== "object") return "";

    const parseModelRef = (modelRef: unknown): { provider: string; model: string } | null => {
      const v = String(modelRef ?? "").trim();
      if (!v) return null;
      const idx = v.indexOf("/");
      if (idx <= 0) return null;
      const provider = v.slice(0, idx).trim();
      const model = v.slice(idx + 1).trim();
      if (!provider || !model) return null;
      return { provider, model };
    };

    const agents: any[] = Array.isArray(cfg.agents) ? cfg.agents : [];
    const providers: any[] = Array.isArray(cfg.providers) ? cfg.providers : [];

    const agentName = activeAgentName.trim();
    if (agentName) {
      const agent = agents.find((a) => a && typeof a === "object" && a.enabled !== false && String(a.name) === agentName);
      const ref = parseModelRef(agent?.modelRef ?? agent?.model_ref);
      if (ref) return ref.model;
    }

    const ref1 = parseModelRef(cfg.currentModelRef ?? cfg.current_model_ref);
    if (ref1) return ref1.model;

    const currentAgent = String(cfg.currentAgent ?? cfg.current_agent ?? "").trim();
    if (currentAgent) {
      const agent = agents.find((a) => a && typeof a === "object" && a.enabled !== false && String(a.name) === currentAgent);
      const ref = parseModelRef(agent?.modelRef ?? agent?.model_ref);
      if (ref) return ref.model;
    }

    const defAgent = String(cfg.defaultAgent ?? cfg.default_agent ?? "").trim();
    if (defAgent) {
      const agent = agents.find((a) => a && typeof a === "object" && a.enabled !== false && String(a.name) === defAgent);
      const ref = parseModelRef(agent?.modelRef ?? agent?.model_ref);
      if (ref) return ref.model;
    }

    for (const p of providers) {
      if (!p || typeof p !== "object") continue;
      if (p.enabled === false) continue;
      const models: any[] = Array.isArray(p.models) ? p.models : [];
      const m = models[0];
      const providerName = String(p.name ?? "").trim();
      const modelName = String(m?.name ?? "").trim();
      if (providerName && modelName) return modelName;
    }

    return "";
  }, [appConfig, activeAgentName]);

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

          if (p.kind === "delta" || p.kind === "thinking") {
            if (p.delta && assistantMessageId) {
              appendMessageDelta(conversation.id, assistantMessageId, p.delta);
            }
            queueMicrotask(scrollToBottom);
            return;
          }

          if (p.kind === "done") {
            const final = p.content ?? "";
            if (assistantMessageId) setMessageContent(conversation.id, assistantMessageId, final);
            setSending(false);
            void cleanupStream(false);
            queueMicrotask(scrollToBottom);
            return;
          }

          if (p.kind === "canceled") {
            setSending(false);
            void cleanupStream(false);
            return;
          }

          if (p.kind === "error") {
            if (assistantMessageId) {
              setMessageContent(
                conversation.id,
                assistantMessageId,
                `请求失败：${p.error ? String(p.error) : "未知错误"}`,
              );
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
        setMessageContent(conversation.id, assistantMessageId, `请求失败：${String(e)}`);
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
        queueMicrotask(scrollToBottom);
      }
    }
  };

  return (
    <div className="h-full flex flex-col overflow-x-hidden">
      {layout === "compact" ? (
        <div className="safe-top border-b border-white/10 bg-white/5">
          <div className="h-12 flex items-center justify-between px-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{conversation?.title ?? "Chat"}</div>
              <div className="text-[11px] text-white/60 truncate">
                {activeAgentLabel
                  ? `Agent: ${activeAgentLabel}${activeModelName ? ` · ${activeModelName}` : ""}`
                  : "Agent: 未选择"}
              </div>
            </div>
            {onNewConversation ? (
              <Button size="sm" variant="ghost" onClick={onNewConversation} title="新建对话">
                <Plus size={16} />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-3">
        {messages.map((m) => (
          <div
            key={m.id}
            className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}
          >
            <div
              className={clsx(
                "max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words border overflow-x-hidden",
                m.role === "user"
                  ? "bg-indigo-500/20 border-indigo-400/30"
                  : "bg-white/5 border-white/10",
              )}
            >
              {renderMode === "rich" ? (
                <RichText content={m.content} />
              ) : (
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="safe-bottom border-t border-white/10 bg-[#0b1220] p-2">
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <Input
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
          <Button onClick={() => void send()} disabled={sending || !input.trim()}>
            <SendHorizontal size={18} />
          </Button>
        </div>
      </div>
    </div>
  );
}
