import React, { useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { AgentSessionsWorkspace } from '../AgentSessions/AgentSessionsWorkspace';
import type { AgentSessionScope } from '../../types';

interface AgentSessionsPanelProps {
  conversationId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const AgentSessionsPanel: React.FC<AgentSessionsPanelProps> = ({
  conversationId,
  isOpen,
  onClose,
}) => {
  const setActiveView = useUIStore((state) => state.setActiveView);

  if (!isOpen) return null;

  const scope = useMemo<AgentSessionScope>(() => ({ kind: 'conversation', id: conversationId }), [conversationId]);

  return (
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="absolute inset-x-8 bottom-8 top-16 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <AgentSessionsWorkspace
          listScope={scope}
          createScope={scope}
          title="当前对话子 Agent"
          embedded
          onClose={onClose}
          onOpenManager={() => {
            setActiveView('agent_sessions');
            onClose();
          }}
        />
      </div>
    </div>
  );
};

export default AgentSessionsPanel;
