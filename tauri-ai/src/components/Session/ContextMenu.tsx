/**
 * ContextMenu Component
 * Right-click context menu for session tabs with batch close operations
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import React, { useRef, useEffect, useState } from 'react';

/**
 * Menu item configuration
 */
export interface MenuItemConfig {
  label: string;           // 菜单项显示文本
  action: () => void;      // 点击时执行的操作
  disabled: boolean;       // 是否禁用
  divider?: boolean;       // 是否在此项后显示分隔线
}

/**
 * ContextMenu component props
 */
export interface ContextMenuProps {
  visible: boolean;                    // 菜单是否可见
  position: { x: number; y: number };  // 菜单显示位置（鼠标坐标）
  targetSessionId: string;             // 被右键点击的 session ID
  targetSessionIndex: number;          // 被右键点击的 session 在列表中的索引
  totalSessions: number;               // 总 session 数量
  onClose: () => void;                 // 关闭菜单的回调函数
  onCloseOthers: () => void;           // 关闭其他标签页的回调
  onCloseToLeft: () => void;           // 关闭左侧标签页的回调
  onCloseToRight: () => void;          // 关闭右侧标签页的回调
  onCloseCurrent: () => void;          // 关闭当前标签页的回调
}

/**
 * ContextMenu component
 * Displays a context menu with session management options
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({
  visible,
  position,
  targetSessionIndex,
  totalSessions,
  onClose,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onCloseCurrent,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // 如果菜单不可见，不渲染任何内容
  if (!visible) {
    return null;
  }

  // 边界检测和位置调整
  useEffect(() => {
    if (!menuRef.current || !visible) {
      return;
    }

    const menuRect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = position.x;
    let adjustedY = position.y;

    // 检测是否超出右边界，如果超出则向左调整
    if (position.x + menuRect.width > viewportWidth) {
      adjustedX = viewportWidth - menuRect.width - 8; // 8px 边距
      // 确保不会超出左边界
      if (adjustedX < 8) {
        adjustedX = 8;
      }
    }

    // 检测是否超出下边界，如果超出则向上调整
    if (position.y + menuRect.height > viewportHeight) {
      adjustedY = viewportHeight - menuRect.height - 8; // 8px 边距
      // 确保不会超出上边界
      if (adjustedY < 8) {
        adjustedY = 8;
      }
    }

    // 只在位置需要调整时更新状态
    if (adjustedX !== adjustedPosition.x || adjustedY !== adjustedPosition.y) {
      setAdjustedPosition({ x: adjustedX, y: adjustedY });
    }
  }, [visible, position.x, position.y]); // 移除 adjustedPosition 依赖以避免无限循环

  // 点击外部区域关闭菜单 (需求 1.2)
  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    // 延迟添加监听器，避免立即触发
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [visible, onClose]);

  // Escape 键关闭菜单 (需求 1.3)
  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscapeKey);

    return () => {
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [visible, onClose]);

  // 点击外部区域关闭菜单 (Requirement 1.2)
  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    // 使用 setTimeout 延迟添加监听器，避免立即触发
    // 因为打开菜单的右键点击事件可能会冒泡到 document
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [visible, onClose]);

  // Escape 键关闭菜单 (Requirement 1.3)
  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscapeKey);

    return () => {
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [visible, onClose]);

  // 计算菜单项的禁用状态
  const isOnlySession = totalSessions === 1;
  const isLeftmost = targetSessionIndex === 0;
  const isRightmost = targetSessionIndex === totalSessions - 1;

  // 定义菜单项配置
  const menuItems: MenuItemConfig[] = [
    {
      label: '关闭其他标签页',
      action: onCloseOthers,
      disabled: isOnlySession,
    },
    {
      label: '关闭左侧标签页',
      action: onCloseToLeft,
      disabled: isLeftmost,
    },
    {
      label: '关闭右侧标签页',
      action: onCloseToRight,
      disabled: isRightmost,
    },
    {
      label: '关闭当前标签页',
      action: onCloseCurrent,
      disabled: false,
      divider: true,
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50"
      style={{
        left: `${adjustedPosition.x}px`,
        top: `${adjustedPosition.y}px`,
      }}
    >
      {/* 菜单容器 */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[180px]">
        {menuItems.map((item, index) => (
          <React.Fragment key={index}>
            <button
              onClick={item.action}
              disabled={item.disabled}
              className={`
                w-full px-4 py-2 text-left text-sm transition-colors
                ${item.disabled
                  ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                  : 'text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer'
                }
              `}
            >
              {item.label}
            </button>
            {item.divider && index < menuItems.length - 1 && (
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export default ContextMenu;
