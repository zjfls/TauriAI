/**
 * HistoryPanel Component
 * Displays conversation history list with selection, multi-select and batch deletion
 * Requirements: 7.3, 7.4, 8.1, 8.2, 8.3, 8.4
 */

import React, { useState, useCallback, useRef } from 'react';
import { MessageSquare, Trash2, Edit2, Check, X, Plus } from 'lucide-react';
import { useConversationStore } from '../../stores/conversationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { useUIStore } from '../../stores/uiStore';
import type { Conversation } from '../../types';

/**
 * Format date for display
 * - Today: HH:mm
 * - Yesterday: 昨天 HH:mm
 * - Day before yesterday: 前天 HH:mm
 * - Within this year: MM-DD HH:mm
 * - Over a year: YYYY-MM-DD HH:mm
 */
const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  // Within 12 hours
  if (diff >= 0 && diff < 12 * 60 * 60 * 1000) {
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours}小时前`;
    return `${hours}小时${mins}分钟前`;
  }

  // Get time string in HH:mm format
  const timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Get start of today, yesterday, day before yesterday
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const dayBeforeYesterdayStart = new Date(todayStart.getTime() - 2 * 24 * 60 * 60 * 1000);

  if (date >= todayStart) {
    // Today but > 12 hours ago (unlikely given 12h check, but distinct logic)
    return timeStr;
  } else if (date >= yesterdayStart) {
    // Yesterday
    return `昨天 ${timeStr}`;
  } else if (date >= dayBeforeYesterdayStart) {
    // Day before yesterday
    return `前天 ${timeStr}`;
  } else if (date.getFullYear() === now.getFullYear()) {
    // Same year: MM-DD HH:mm
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${timeStr}`;
  } else {
    // Different year: YYYY-MM-DD HH:mm
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day} ${timeStr}`;
  }
};

const getNativeModifierState = (e: React.MouseEvent, key: 'Shift' | 'Control' | 'Meta') => {
  const native = e.nativeEvent as unknown as MouseEvent;
  if (native && typeof native.getModifierState === 'function') {
    return native.getModifierState(key);
  }
  return false;
};

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  isSelected: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onSelect: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
}

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation,
  isActive,
  isSelected,
  onMouseDown,
  onSelect,
  onDelete,
  onRename,
}) => {
  const { config } = useConfigStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title);
  const [showActions, setShowActions] = useState(false);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(conversation.title);
    setIsEditing(true);
  };

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editTitle.trim() && editTitle !== conversation.title) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(conversation.title);
    setIsEditing(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (editTitle.trim() && editTitle !== conversation.title) {
        onRename(editTitle.trim());
      }
      setIsEditing(false);
    } else if (e.key === 'Escape') {
      setEditTitle(conversation.title);
      setIsEditing(false);
    }
  };

  return (
    <div
      className={`
        group relative flex items-center gap-3 px-3 py-3 rounded-lg cursor-pointer
        transition-colors duration-150
        ${isSelected
          ? 'bg-blue-100 dark:bg-blue-900/50 border border-blue-300 dark:border-blue-700'
          : isActive
            ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent'
        }
      `}
      onMouseDown={onMouseDown}
      onClick={onSelect}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Checkbox for multi-select */}
      <div className={`
        flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center
        transition-colors
        ${isSelected
          ? 'bg-blue-500 border-blue-500 text-white'
          : 'border-gray-300 dark:border-gray-600'
        }
      `}>
        {isSelected && <Check size={12} />}
      </div>

      {/* Icon */}
      <div className={`
        flex-shrink-0 p-2 rounded-lg
        ${isActive
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-800 dark:text-blue-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
        }
      `}>
        <MessageSquare size={16} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
        ) : (
          <>
            <h3 className={`
              text-sm font-medium truncate
              ${isActive
                ? 'text-blue-700 dark:text-blue-300'
                : 'text-gray-800 dark:text-gray-200'
              }
            `}>
              {conversation.title}
            </h3>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatDate(conversation.updatedAt)}
              </span>
              {conversation.agentName && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
                  {config?.agents?.find(a => a.name === conversation.agentName)?.displayName || conversation.agentName}
                </span>
              )}
              {conversation.modelRef && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400 truncate max-w-[120px]" title={conversation.modelRef}>
                  {conversation.modelRef.split('/').pop()}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      {isEditing ? (
        <div className="flex items-center gap-1">
          <button
            onClick={handleSaveEdit}
            className="p-1.5 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30"
            title="保存"
          >
            <Check size={14} />
          </button>
          <button
            onClick={handleCancelEdit}
            className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
            title="取消"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        showActions && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleStartEdit}
              className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300"
              title="重命名"
            >
              <Edit2 size={14} />
            </button>
            <button
              onClick={handleDelete}
              className="p-1.5 rounded text-gray-500 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      )}
    </div>
  );
};


export const HistoryPanel: React.FC = () => {
  const {
    conversations,
    currentConversationId,
    deleteConversation,
    updateConversationTitle,
  } = useConversationStore();

  const { openHistoricalConversation, createSession } = useSessionStore();
  const { config } = useConfigStore();
  const { setActiveView } = useUIStore();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);

  const modifierSnapshotRef = useRef<{ ctrl: boolean; shift: boolean } | null>(null);

  const handleItemMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, textarea, a')) {
      return;
    }
    modifierSnapshotRef.current = {
      ctrl: e.ctrlKey || e.metaKey || getNativeModifierState(e, 'Control') || getNativeModifierState(e, 'Meta'),
      shift: e.shiftKey || getNativeModifierState(e, 'Shift'),
    };
  }, []);

  // Handle item click with Ctrl/Shift multi-select
  const handleItemClick = useCallback(async (e: React.MouseEvent, conversation: Conversation, index: number) => {
    const snapshot = modifierSnapshotRef.current;
    modifierSnapshotRef.current = null;

    const isCtrlPressed = snapshot?.ctrl ?? (e.ctrlKey || e.metaKey || getNativeModifierState(e, 'Control') || getNativeModifierState(e, 'Meta'));
    const isShiftPressed = snapshot?.shift ?? (e.shiftKey || getNativeModifierState(e, 'Shift'));

    if (isCtrlPressed) {
      e.preventDefault();
      // Ctrl+Click: Toggle single item
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(conversation.id)) {
          newSet.delete(conversation.id);
        } else {
          newSet.add(conversation.id);
        }
        return newSet;
      });
      setLastSelectedIndex(index);
    } else if (isShiftPressed) {
      e.preventDefault();
      if (lastSelectedIndex === null) {
        // Shift+Click without anchor: select current item only.
        setSelectedIds(new Set([conversation.id]));
        setLastSelectedIndex(index);
        return;
      }
      // Shift+Click: Range select
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeIds = conversations.slice(start, end + 1).map(c => c.id);
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        rangeIds.forEach(id => newSet.add(id));
        return newSet;
      });
    } else {
      // Normal click: Open historical conversation in a new session
      // Requirements: 8.1, 8.2, 8.3, 8.4
      setSelectedIds(new Set());
      setLastSelectedIndex(index);
      try {
        await openHistoricalConversation(conversation.id);
        setActiveView('chat');
      } catch (error) {
        console.error('Failed to open historical conversation:', error);
      }
    }
  }, [conversations, lastSelectedIndex, openHistoricalConversation, setActiveView]);

  const handleDeleteConversation = async (id: string) => {
    if (deleteConfirmId === id) {
      await deleteConversation(id);
      setDeleteConfirmId(null);
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    } else {
      setDeleteConfirmId(id);
      setTimeout(() => setDeleteConfirmId(null), 3000);
    }
  };

  const handleBatchDelete = async () => {
    if (!showBatchDeleteConfirm) {
      setShowBatchDeleteConfirm(true);
      setTimeout(() => setShowBatchDeleteConfirm(false), 3000);
      return;
    }

    // Delete all selected
    for (const id of selectedIds) {
      await deleteConversation(id);
    }
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  };

  const handleRenameConversation = async (id: string, newTitle: string) => {
    await updateConversationTitle(id, newTitle);
  };

  const handleNewConversation = async () => {
    try {
      // Use default agent to create new session
      const defaultAgentName = config?.defaultAgent || config?.agents?.[0]?.name || '';
      if (!defaultAgentName) {
        console.error('No agent configured');
        return;
      }
      await createSession(defaultAgentName);
      setActiveView('chat');
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  };

  const handleSelectAll = () => {
    if (selectedIds.size === conversations.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(conversations.map(c => c.id)));
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
          对话历史
        </h2>
        <button
          onClick={handleNewConversation}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
        >
          <Plus size={16} />
          新对话
        </button>
      </div>

      {/* Multi-select toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-3">
            <span className="text-sm text-blue-700 dark:text-blue-300">
              已选择 {selectedIds.size} 项
            </span>
            <button
              onClick={handleSelectAll}
              className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
            >
              {selectedIds.size === conversations.length ? '取消全选' : '全选'}
            </button>
            <button
              onClick={handleClearSelection}
              className="text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
            >
              清除选择
            </button>
          </div>
          <button
            onClick={handleBatchDelete}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${showBatchDeleteConfirm
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
              }`}
          >
            <Trash2 size={14} />
            {showBatchDeleteConfirm ? '确认删除' : '批量删除'}
          </button>
        </div>
      )}

      {/* Help text */}
      {conversations.length > 0 && selectedIds.size === 0 && (
        <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
          提示：Ctrl+点击多选，Shift+点击范围选择
        </div>
      )}

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="p-4 rounded-full bg-gray-100 dark:bg-gray-800 mb-4">
              <MessageSquare size={32} className="text-gray-400" />
            </div>
            <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
              暂无对话记录
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              开始一个新对话来与 AI 交流
            </p>
            <button
              onClick={handleNewConversation}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              <Plus size={16} />
              开始新对话
            </button>
          </div>
        ) : (
          conversations.map((conversation, index) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isActive={conversation.id === currentConversationId}
              isSelected={selectedIds.has(conversation.id)}
              onMouseDown={handleItemMouseDown}
              onSelect={(e) => handleItemClick(e, conversation, index)}
              onDelete={() => handleDeleteConversation(conversation.id)}
              onRename={(newTitle) => handleRenameConversation(conversation.id, newTitle)}
            />
          ))
        )}
      </div>

      {/* Delete Confirmation Toast */}
      {deleteConfirmId && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 px-4 py-2 bg-red-600 text-white text-sm rounded-lg shadow-lg">
          再次点击删除按钮确认删除
        </div>
      )}
    </div>
  );
};

export default HistoryPanel;
