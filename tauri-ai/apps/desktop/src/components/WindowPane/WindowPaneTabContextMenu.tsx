import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceTabId } from '../../stores/workspaceTabStore';

export interface WindowPaneTabContextMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  tabIds: WorkspaceTabId[];
  targetId: WorkspaceTabId;

  canDockToOtherWindow?: boolean;
  onDockToOtherWindow?: () => void;

  canOpenInNewWindow: boolean;
  onOpenInNewWindow: () => void;

  onCloseCurrent: () => void;
  onCloseOthers: () => void;
  onCloseToLeft: () => void;
  onCloseToRight: () => void;

  onClose: () => void;
}

export const WindowPaneTabContextMenu: React.FC<WindowPaneTabContextMenuProps> = ({
  visible,
  position,
  tabIds,
  targetId,
  canDockToOtherWindow,
  onDockToOtherWindow,
  canOpenInNewWindow,
  onOpenInNewWindow,
  onCloseCurrent,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  useEffect(() => {
    setAdjustedPosition(position);
  }, [position.x, position.y]);

  // Click outside closes menu
  useEffect(() => {
    if (!visible) return;
    const onMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onMouseDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [visible, onClose]);

  // Escape closes menu
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, onClose]);

  // Boundary detection
  useEffect(() => {
    if (!visible) return;
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = position.x;
    let y = position.y;
    if (x + rect.width > vw) x = Math.max(8, vw - rect.width - 8);
    if (y + rect.height > vh) y = Math.max(8, vh - rect.height - 8);
    if (x !== adjustedPosition.x || y !== adjustedPosition.y) {
      setAdjustedPosition({ x, y });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, position.x, position.y]);

  if (!visible) return null;

  const totalTabs = tabIds.length;
  const targetIndex = tabIds.indexOf(targetId);
  const isOnlyTab = totalTabs <= 1;
  const isLeftmost = targetIndex <= 0;
  const isRightmost = targetIndex < 0 || targetIndex >= totalTabs - 1;

  const Item: React.FC<{
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }> = ({ label, disabled, onClick }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick();
        onClose();
      }}
      className={[
        'w-full px-4 py-2 text-left text-sm transition-colors',
        disabled
          ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer',
      ].join(' ')}
    >
      {label}
    </button>
  );

  const Divider = () => <div className="my-1 border-t border-gray-200 dark:border-gray-700" />;

  const showDock = typeof onDockToOtherWindow === 'function';

  return (
    <div
      ref={menuRef}
      className="fixed z-50"
      style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px` }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[200px]">
        {showDock && (
          <Item
            label="停靠到其他窗口"
            disabled={!canDockToOtherWindow}
            onClick={onDockToOtherWindow!}
          />
        )}
        <Item label="在新窗口打开" disabled={!canOpenInNewWindow} onClick={onOpenInNewWindow} />
        <Item label="关闭" onClick={onCloseCurrent} />
        <Divider />
        <Item label="关闭其他会话" disabled={isOnlyTab} onClick={onCloseOthers} />
        <Item label="关闭左边会话" disabled={isLeftmost} onClick={onCloseToLeft} />
        <Item label="关闭右边会话" disabled={isRightmost} onClick={onCloseToRight} />
      </div>
    </div>
  );
};

export default WindowPaneTabContextMenu;

