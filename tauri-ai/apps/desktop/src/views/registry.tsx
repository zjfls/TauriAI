import React from 'react';
import { MessageSquare, History, Settings, FileText, LayoutPanelLeft, ExternalLink, Globe, Terminal, NotebookPen } from 'lucide-react';
import type { ActiveView } from '../types';
import { ChatViewContainer } from './ChatViewContainer';
import { HistoryPanel } from '../components/History/HistoryPanel';
import { PracticeView } from '../components/Practice/PracticeView';
import { SettingsView } from '../components/Settings/SettingsView';
import { DocumentView } from '../components/Documents/DocumentView';
import { WorkstudioView } from '../components/Workstudio/WorkstudioView';
import { WebView } from '../components/Web/WebView';
import { TerminalView } from '../components/Terminal/TerminalView';
import { WindowTestView } from '../components/Test/WindowTestView';

export interface ViewDefinition {
  id: ActiveView;
  label: string;
  title: string;
  icon: React.ReactNode;
  render: () => React.ReactNode;
  // Whether to show in the left navigation.
  // Document views are opened via File menu / tab bar, not as permanent sidebar entries.
  inSidebar?: boolean;
}

export const VIEW_DEFINITIONS: ViewDefinition[] = [
  {
    id: 'chat',
    label: '聊天',
    title: 'TauriAI',
    icon: <MessageSquare size={20} />,
    render: () => <ChatViewContainer />,
    inSidebar: true,
  },
  {
    id: 'history',
    label: '历史',
    title: '历史记录',
    icon: <History size={20} />,
    render: () => <HistoryPanel />,
    inSidebar: true,
  },
  {
    id: 'practice',
    label: '练习',
    title: '练习',
    icon: <NotebookPen size={20} />,
    render: () => <PracticeView />,
    inSidebar: true,
  },
  {
    id: 'settings',
    label: '设置',
    title: '设置',
    icon: <Settings size={20} />,
    render: () => <SettingsView />,
    inSidebar: true,
  },
  {
    id: 'document',
    label: '文档',
    title: '文档',
    icon: <FileText size={20} />,
    render: () => <DocumentView />,
    inSidebar: false,
  },
  {
    id: 'workstudio',
    label: '工作区',
    title: 'Workstudio',
    icon: <LayoutPanelLeft size={20} />,
    render: () => <WorkstudioView />,
    inSidebar: false,
  },
  {
    id: 'web',
    label: '网页',
    title: 'Web',
    icon: <Globe size={20} />,
    render: () => <WebView />,
    inSidebar: false,
  },
  {
    id: 'terminal',
    label: '终端',
    title: 'Terminal',
    icon: <Terminal size={20} />,
    render: () => <TerminalView />,
    inSidebar: false,
  },
  {
    id: 'window_test',
    label: '窗口测试',
    title: 'Window Test',
    icon: <ExternalLink size={20} />,
    render: () => <WindowTestView />,
    inSidebar: false,
  },
];

export const getViewDefinition = (viewId: ActiveView) =>
  VIEW_DEFINITIONS.find((v) => v.id === viewId);
