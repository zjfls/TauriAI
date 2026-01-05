/**
 * HistoryPanel Component
 * Displays conversation history list with selection and deletion
 * Requirements: 7.3, 7.4
 */

import React, { useEffect, useState } from 'react';
import { MessageSquare, Trash2, Edit2, Check, X, Plus } from 'lucide-react';
import { useConversationStore } from '../../stores/conversationStore';
import { useUIStore } from '../../stores/uiStore';
import type { Conversation } from '../../types';

/**
 * Format date for display
 */
const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return '昨天';
  } else if (diffDays < 7) {
    return `${diffDays}天前`;
  } else {
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }
};

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
}

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onRename,
}) => {
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
        ${isActive
          ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
          : 'hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent'
        }
      `}
      onClick={onSelect}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
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
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {formatDate(conversation.updatedAt)}
            </p>
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
    loadConversations,
    deleteConversation,
    updateConversationTitle,
    setCurrentConversation,
    createConversation,
  } = useConversationStore();

  const { setActiveView } = useUIStore();

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleSelectConversation = (conversation: Conversation) => {
    setCurrentConversation(conversation.id);
    setActiveView('chat');
  };

  const handleDeleteConversation = async (id: string) => {
    if (deleteConfirmId === id) {
      await deleteConversation(id);
      setDeleteConfirmId(null);
    } else {
      setDeleteConfirmId(id);
      // Auto-clear confirmation after 3 seconds
      setTimeout(() => setDeleteConfirmId(null), 3000);
    }
  };

  const handleRenameConversation = async (id: string, newTitle: string) => {
    await updateConversationTitle(id, newTitle);
  };

  const handleNewConversation = async () => {
    await createConversation();
    setActiveView('chat');
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
          conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isActive={conversation.id === currentConversationId}
              onSelect={() => handleSelectConversation(conversation)}
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
