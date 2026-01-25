/**
 * Sidebar Component
 * Navigation sidebar with icons for chat, history, and settings
 * Requirements: 2.1
 */

import React from 'react';
import { PanelLeftClose, PanelLeft } from 'lucide-react';
import type { ActiveView } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { VIEW_DEFINITIONS } from '../../views/registry';

interface SidebarProps {
  activeView: ActiveView;
  onViewChange: (view: ActiveView) => void;
  expanded: boolean;
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  expanded: boolean;
}

const NavItem: React.FC<NavItemProps> = ({ icon, label, active, onClick, expanded }) => {
  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors
        ${active
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
        }
      `}
      title={label}
    >
      <span className="flex-shrink-0">{icon}</span>
      {expanded && (
        <span className="text-sm font-medium truncate">{label}</span>
      )}
    </button>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onViewChange,
  expanded,
}) => {
  const { toggleSidebar } = useUIStore();

  const navItems = VIEW_DEFINITIONS.filter((def) => def.inSidebar !== false).map((def) => ({
    view: def.id,
    icon: def.icon,
    label: def.label,
  }));

  return (
    <aside
      className={`
        flex flex-col h-full bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700
        transition-all duration-200 ease-in-out flex-shrink-0
        ${expanded ? 'w-48' : 'w-16'}
      `}
    >
      {/* Logo / Brand Area */}
      <div className="flex items-center justify-between h-14 px-3 border-b border-gray-200 dark:border-gray-700">
        {expanded && (
          <span className="text-lg font-semibold text-gray-800 dark:text-white">
            TauriAI
          </span>
        )}
        <button
          onClick={toggleSidebar}
          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title={expanded ? '收起侧边栏' : '展开侧边栏'}
        >
          {expanded ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
        </button>
      </div>

      {/* Navigation Items */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => (
          <NavItem
            key={item.view}
            icon={item.icon}
            label={item.label}
            active={activeView === item.view}
            onClick={() => onViewChange(item.view)}
            expanded={expanded}
          />
        ))}
      </nav>

      {/* Bottom Section - Version or User Info */}
      <div className="p-3 border-t border-gray-200 dark:border-gray-700">
        {expanded ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
            v0.1.0 MVP
          </p>
        ) : (
          <div className="w-2 h-2 mx-auto rounded-full bg-green-500" title="在线" />
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
