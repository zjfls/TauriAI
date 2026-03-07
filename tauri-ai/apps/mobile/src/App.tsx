import { useCallback, useEffect, useMemo, useState } from "react";
import { useLayoutSize } from "./lib/breakpoints";
import { PhoneShell } from "./shell/PhoneShell";
import { TabletShell, loadShellPrefs, saveShellPrefs } from "./shell/TabletShell";
import type { RootTab } from "./shell/types";
import { ConversationList } from "./components/ConversationList";
import { PracticeQuizList } from "./components/PracticeQuizList";
import { useConversationStore } from "./stores/conversationStore";
import { useChatComposerStore } from "./stores/chatComposerStore";
import { ChatPage } from "./pages/ChatPage";
import { HistoryPage } from "./pages/HistoryPage";
import { PracticePage } from "./pages/PracticePage";
import { SettingsPage } from "./pages/SettingsPage";
import { NewConversationModal } from "./ui/NewConversationModal";
import { usePracticeStore } from "../../common/src/practice/store";

export default function App() {
  const layout = useLayoutSize();
  const [tab, setTab] = useState<RootTab>("chat");

  const prefs = useMemo(() => loadShellPrefs(), []);
  const [listVisible, setListVisible] = useState<boolean>(prefs.listVisible);
  const [newConversationOpen, setNewConversationOpen] = useState(false);

  useEffect(() => {
    saveShellPrefs({ listVisible });
  }, [listVisible]);

  const { conversations, activeConversationId, createConversation, setActiveConversation, deleteConversation } =
    useConversationStore();
  const setChatComposerDraft = useChatComposerStore((s) => s.setDraft);

  const { quizzes, activeQuizId, createQuiz, setActiveQuiz, deleteQuiz } = usePracticeStore();

  const handleCopyQuestionToChat = useCallback(
    (content: string) => {
      const normalized = content.trim();
      if (!normalized) return;
      const targetConversationId = activeConversationId ?? conversations[0]?.id ?? createConversation();
      setChatComposerDraft(targetConversationId, normalized);
      setActiveConversation(targetConversationId);
      setTab("chat");
    },
    [activeConversationId, conversations, createConversation, setActiveConversation, setChatComposerDraft],
  );

  const list =
    tab === "practice" ? (
      <PracticeQuizList
        quizzes={quizzes}
        activeId={activeQuizId}
        onCreate={() => {
          const id = createQuiz({ title: "新练习" });
          setActiveQuiz(id);
        }}
        onSelect={(id) => {
          setActiveQuiz(id);
          setTab("practice");
        }}
        onDelete={(id) => deleteQuiz(id)}
      />
    ) : (
      <ConversationList
        conversations={conversations}
        activeId={activeConversationId}
        onCreate={() => setNewConversationOpen(true)}
        onSelect={(id) => {
          setActiveConversation(id);
          setTab("chat");
        }}
        onDelete={(id) => deleteConversation(id)}
      />
    );

  const detail =
    tab === "chat" ? (
      <ChatPage onNewConversation={() => setNewConversationOpen(true)} />
    ) : tab === "history" ? (
      <HistoryPage
        onNewConversation={() => setNewConversationOpen(true)}
        onNavigateChat={() => setTab("chat")}
      />
    ) : tab === "practice" ? (
      <PracticePage onCopyQuestionToChat={handleCopyQuestionToChat} />
    ) : (
      <SettingsPage />
    );

  const shell =
    layout === "compact" ? (
      <PhoneShell tab={tab} onTabChange={setTab}>
        {detail}
      </PhoneShell>
    ) : (
      <TabletShell
        tab={tab}
        onTabChange={(t) => {
          setTab(t);
          if (t === "settings") {
            setListVisible(false);
          } else if (layout === "expanded") {
            setListVisible(true);
          }
        }}
        listVisible={listVisible && tab !== "settings"}
        onToggleList={() => setListVisible((v) => !v)}
        onNewConversation={
          tab === "chat" || tab === "history" ? () => setNewConversationOpen(true) : undefined
        }
        listPaneClassName={tab === "practice" ? "w-[240px]" : undefined}
        list={list}
        detail={detail}
      />
    );

  return (
    <>
      {shell}
      <NewConversationModal
        open={newConversationOpen}
        onClose={() => setNewConversationOpen(false)}
        onCreate={(agentName) => {
          const id = createConversation({ agentName });
          setActiveConversation(id);
          setTab("chat");
          setNewConversationOpen(false);
        }}
      />
    </>
  );
}
