import { useUIStore } from '../stores/uiStore';
import { openOrFocusViewWindow } from './viewWindow';
import { useWindowLayoutStore } from '../stores/windowLayoutStore';
import { practiceTabId, useWorkspaceTabStore } from '../stores/workspaceTabStore';

export const PRACTICE_TAB_TITLE = '练习';
export const PRACTICE_WINDOW_LABEL = 'view-practice-main';

export const openPracticeWorkspaceTab = () => {
  const tabId = practiceTabId();
  useWorkspaceTabStore.getState().upsertPracticeTab();
  const layout = useWindowLayoutStore.getState();
  const preferredPaneId = layout.getPreferredPaneId({ tabId });
  layout.openTabInPane(preferredPaneId, tabId);
  useUIStore.getState().setActiveView('chat');
};

export const openPracticeWindow = async () => {
  return openOrFocusViewWindow('practice', PRACTICE_TAB_TITLE, {
    label: PRACTICE_WINDOW_LABEL,
    noDefaultSession: true,
  });
};
