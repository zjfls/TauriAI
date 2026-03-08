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

type PracticeReturnTarget = {
  quizId: string;
  questionId: string;
  questionNumber: number;
  scrollTop: number;
};

export default function App() {
  const layout = useLayoutSize();
  const [tab, setTab] = useState<RootTab>("chat");

  const prefs = useMemo(() => loadShellPrefs(), []);
  const [listVisible, setListVisible] = useState<boolean>(prefs.listVisible);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [practiceReturnTarget, setPracticeReturnTarget] = useState<PracticeReturnTarget | null>(null);

  useEffect(() => {
    saveShellPrefs({ listVisible });
  }, [listVisible]);

  const navigateToTab = useCallback(
    (next: RootTab) => {
      setTab(next);
      if (layout === "compact") return;
      if (next === "settings") {
        setListVisible(false);
      } else if (layout === "expanded") {
        setListVisible(true);
      }
    },
    [layout],
  );

  const { conversations, activeConversationId, createConversation, setActiveConversation, deleteConversation } =
    useConversationStore();
  const setChatComposerDraft = useChatComposerStore((s) => s.setDraft);

  const { quizzes, activeQuizId, createQuiz, setActiveQuiz, deleteQuiz } = usePracticeStore();

  const handleCopyQuestionToChat = useCallback(
    ({
      content,
      returnTarget,
    }: {
      content: string;
      returnTarget: PracticeReturnTarget;
    }) => {
      const normalized = content.trim();
      if (!normalized) return;
      const targetConversationId = activeConversationId ?? conversations[0]?.id ?? createConversation();
      setPracticeReturnTarget(returnTarget);
      setChatComposerDraft(targetConversationId, normalized);
      setActiveConversation(targetConversationId);
      navigateToTab("chat");
    },
    [
      activeConversationId,
      conversations,
      createConversation,
      navigateToTab,
      setActiveConversation,
      setChatComposerDraft,
    ],
  );

  const consumePracticeReturnTarget = useCallback(() => {
    setPracticeReturnTarget(null);
  }, []);

  const handleReturnToPractice = useCallback(() => {
    if (!practiceReturnTarget) return;
    setActiveQuiz(practiceReturnTarget.quizId);
    navigateToTab("practice");
  }, [navigateToTab, practiceReturnTarget, setActiveQuiz]);

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
          navigateToTab("practice");
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
          navigateToTab("chat");
        }}
        onDelete={(id) => deleteConversation(id)}
      />
    );

  const detail =
    tab === "chat" ? (
      <ChatPage
        onNewConversation={() => setNewConversationOpen(true)}
        onReturnToPractice={practiceReturnTarget ? handleReturnToPractice : undefined}
        returnToPracticeLabel={
          practiceReturnTarget ? `返回第 ${practiceReturnTarget.questionNumber} 题` : undefined
        }
      />
    ) : tab === "history" ? (
      <HistoryPage
        onNewConversation={() => setNewConversationOpen(true)}
        onNavigateChat={() => navigateToTab("chat")}
      />
    ) : tab === "practice" ? (
      <PracticePage
        onCopyQuestionToChat={handleCopyQuestionToChat}
        pendingReturnTarget={practiceReturnTarget}
        onPendingReturnConsumed={consumePracticeReturnTarget}
      />
    ) : (
      <SettingsPage />
    );

  const shell =
    layout === "compact" ? (
      <PhoneShell tab={tab} onTabChange={navigateToTab}>
        {detail}
      </PhoneShell>
    ) : (
      <TabletShell
        tab={tab}
        onTabChange={navigateToTab}
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
          navigateToTab("chat");
          setNewConversationOpen(false);
        }}
      />
    </>
  );
}
