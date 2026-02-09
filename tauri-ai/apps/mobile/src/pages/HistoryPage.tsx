import { useConversationStore } from "../stores/conversationStore";
import { ConversationList } from "../components/ConversationList";

export function HistoryPage({
  onNewConversation,
  onNavigateChat,
}: {
  onNewConversation: () => void;
  onNavigateChat: () => void;
}) {
  const { conversations, activeConversationId, setActiveConversation, deleteConversation } =
    useConversationStore();

  return (
    <div className="h-full overflow-x-hidden">
      <ConversationList
        conversations={conversations}
        activeId={activeConversationId}
        onCreate={onNewConversation}
        onSelect={(id) => {
          setActiveConversation(id);
          onNavigateChat();
        }}
        onDelete={(id) => deleteConversation(id)}
      />
    </div>
  );
}
