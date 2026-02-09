import { useEffect, useMemo, useState } from "react";
import { useLayoutSize } from "./lib/breakpoints";
import { PhoneShell } from "./shell/PhoneShell";
import { TabletShell, loadShellPrefs, saveShellPrefs } from "./shell/TabletShell";
import type { RootTab } from "./shell/types";
import { ConversationList } from "./components/ConversationList";
import { useConversationStore } from "./stores/conversationStore";
import { ChatPage } from "./pages/ChatPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { NewConversationModal } from "./ui/NewConversationModal";

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

  const list = (
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
        onNewConversation={() => setNewConversationOpen(true)}
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
