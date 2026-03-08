import { useUIStore } from '../stores/uiStore';
import { useWindowLayoutStore } from '../stores/windowLayoutStore';
import { practiceTabId, useWorkspaceTabStore } from '../stores/workspaceTabStore';

export const PRACTICE_TAB_TITLE = '练习';

export const openPracticeWorkspaceTab = () => {
  const tabId = practiceTabId();
  useWorkspaceTabStore.getState().upsertPracticeTab();
  const layout = useWindowLayoutStore.getState();
  const preferredPaneId = layout.getPreferredPaneId({ tabId });
  layout.openTabInPane(preferredPaneId, tabId);
  useUIStore.getState().setActiveView('chat');
};
