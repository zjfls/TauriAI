import type { KeyboardShortcutActionId } from '../types';

export type ShortcutPlatform = 'mac' | 'windows';

export interface ShortcutActionDefinition {
  id: KeyboardShortcutActionId;
  title: string;
  description: string;
  category: '应用' | '会话' | 'Chat' | 'Workstudio' | 'Web' | '文档';
  defaultMac: string;
  defaultWindows: string;
  /** Whether this shortcut is safe to run while typing in an input/textarea/terminal. */
  allowWhenTyping?: boolean;
}

export const SHORTCUT_ACTIONS: ShortcutActionDefinition[] = [
  {
    id: 'app.openSettings',
    title: '打开设置',
    description: '跳转到设置页面（Preferences/Settings）',
    category: '应用',
    defaultMac: 'Cmd+,',
    defaultWindows: 'Ctrl+,',
    allowWhenTyping: true,
  },
  {
    id: 'app.openHistory',
    title: '打开历史',
    description: '跳转到历史对话列表（参考浏览器 History 习惯）',
    category: '应用',
    defaultMac: 'Cmd+Y',
    defaultWindows: 'Ctrl+Shift+H',
    allowWhenTyping: true,
  },
  {
    id: 'app.openDevtools',
    title: '打开开发者工具',
    description: '打开当前窗口 DevTools（仅在 dev/允许 devtools 的构建可用）',
    category: '应用',
    defaultMac: 'Cmd+Option+I',
    defaultWindows: 'Ctrl+Shift+I',
    allowWhenTyping: true,
  },
  {
    id: 'session.new',
    title: '新建会话',
    description: '创建一个新的聊天会话（类似浏览器新标签）',
    category: '会话',
    defaultMac: 'Cmd+T',
    defaultWindows: 'Ctrl+T',
  },
  {
    id: 'session.clone',
    title: '克隆当前对话',
    description: '克隆当前会话对应的对话（生成一个新会话并打开）',
    category: '会话',
    defaultMac: 'Cmd+Shift+D',
    defaultWindows: 'Ctrl+Shift+D',
    // 这是“会话级”操作，允许在输入/编辑时也能触发，避免表现为“偶发无效”。
    allowWhenTyping: true,
  },
  {
    id: 'session.close',
    title: '关闭当前会话',
    description: '关闭当前激活会话（类似关闭标签页）',
    category: '会话',
    defaultMac: 'Cmd+Shift+W',
    defaultWindows: 'Ctrl+Shift+W',
  },
  {
    id: 'session.next',
    title: '下一个会话',
    description: '切换到下一个会话（在当前 Pane 内循环）',
    category: '会话',
    defaultMac: 'Ctrl+Tab',
    defaultWindows: 'Ctrl+Tab',
    allowWhenTyping: true,
  },
  {
    id: 'session.previous',
    title: '上一个会话',
    description: '切换到上一个会话（在当前 Pane 内循环）',
    category: '会话',
    defaultMac: 'Ctrl+Shift+Tab',
    defaultWindows: 'Ctrl+Shift+Tab',
    allowWhenTyping: true,
  },
  {
    id: 'chat.abortGeneration',
    title: '停止生成',
    description: '中止当前会话的生成/运行',
    category: 'Chat',
    defaultMac: 'Escape',
    defaultWindows: 'Escape',
    allowWhenTyping: true,
  },
  {
    id: 'chat.openWorkstudio',
    title: '打开 Workstudio',
    description: '在聊天中打开/聚焦当前会话的 Workstudio（需要该会话启用 workspace）',
    category: 'Chat',
    defaultMac: 'Cmd+W',
    defaultWindows: 'Ctrl+W',
    allowWhenTyping: true,
  },
  {
    id: 'chat.toggleOutline',
    title: '显示/隐藏消息目录',
    description: '切换聊天左侧的“消息目录”面板（默认收起，通过快捷键或点击滑动展开）',
    category: 'Chat',
    defaultMac: 'Cmd+Option+O',
    defaultWindows: 'Ctrl+Alt+O',
    allowWhenTyping: true,
  },
  {
    id: 'chat.toggleScrollNavigator',
    title: '显示/隐藏滚动导航条',
    description: '切换聊天右侧的快速滚动导航条显示状态（更不遮挡内容）',
    category: 'Chat',
    defaultMac: 'Cmd+Option+Shift+H',
    defaultWindows: 'Ctrl+Alt+Shift+H',
    allowWhenTyping: true,
  },
  {
    id: 'workstudio.fileSearch',
    title: '文件搜索（Workstudio）',
    description: '打开 Workstudio 文件搜索面板（类似 VS Code 快速打开）',
    category: 'Workstudio',
    defaultMac: 'Cmd+P',
    defaultWindows: 'Ctrl+P',
    allowWhenTyping: true,
  },
  {
    id: 'workstudio.navigateBack',
    title: '后退（Workstudio）',
    description: '返回到上一个浏览位置（文件/行号）',
    category: 'Workstudio',
    // VS Code-like defaults:
    // - macOS: Ctrl+-（避免占用 Cmd+[ / Cmd+]，与编辑器缩进常用快捷键冲突）
    // - Windows: Alt+Left
    defaultMac: 'Ctrl+-',
    defaultWindows: 'Alt+Left',
    allowWhenTyping: true,
  },
  {
    id: 'workstudio.navigateForward',
    title: '前进（Workstudio）',
    description: '前进到下一个浏览位置（文件/行号）',
    category: 'Workstudio',
    defaultMac: 'Ctrl+Shift+-',
    defaultWindows: 'Alt+Right',
    allowWhenTyping: true,
  },
  {
    id: 'document.save',
    title: '保存文档',
    description: '保存当前文档（若未选择路径会弹出保存对话框）',
    category: '文档',
    defaultMac: 'Cmd+S',
    defaultWindows: 'Ctrl+S',
    allowWhenTyping: true,
  },
  {
    id: 'web.focusAddressBar',
    title: '聚焦地址栏（Web）',
    description: '把焦点移动到 Web 地址栏（类似浏览器 Ctrl/Cmd+L）',
    category: 'Web',
    defaultMac: 'Cmd+L',
    defaultWindows: 'Ctrl+L',
    allowWhenTyping: true,
  },
  {
    id: 'web.reload',
    title: '刷新（Web）',
    description: '刷新 Web 标签页',
    category: 'Web',
    defaultMac: 'Cmd+R',
    defaultWindows: 'Ctrl+R',
    allowWhenTyping: true,
  },
];

export const DEFAULT_SHORTCUTS_MAC: Record<KeyboardShortcutActionId, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultMac])
) as Record<KeyboardShortcutActionId, string>;

export const DEFAULT_SHORTCUTS_WINDOWS: Record<KeyboardShortcutActionId, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultWindows])
) as Record<KeyboardShortcutActionId, string>;

export const getDefaultShortcut = (platform: ShortcutPlatform, actionId: KeyboardShortcutActionId): string => {
  return platform === 'mac' ? DEFAULT_SHORTCUTS_MAC[actionId] : DEFAULT_SHORTCUTS_WINDOWS[actionId];
};

