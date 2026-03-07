import React, { useMemo } from 'react';
import { AgentSessionsWorkspace } from './AgentSessionsWorkspace';
import type { AgentSessionScope } from '../../types';

export const AgentSessionsView: React.FC = () => {
  const createScope = useMemo<AgentSessionScope>(
    () => ({ kind: 'standalone', id: 'global' }),
    []
  );

  return (
    <AgentSessionsWorkspace
      listScope={null}
      createScope={createScope}
      title="子 Agent 工作台"
    />
  );
};

export default AgentSessionsView;
