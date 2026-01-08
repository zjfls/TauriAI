import React from 'react';
import * as LucideIcons from 'lucide-react';
import { Action } from '../../types';

interface MessageToolbarProps {
    actions: Action[];
    onAction: (action: Action) => void;
}

export const MessageToolbar: React.FC<MessageToolbarProps> = ({ actions, onAction }) => {
    if (!actions || actions.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2 mt-2">
            {actions.map((action) => {
                // Dynamic icon resolution
                const IconComponent = action.icon
                    ? (LucideIcons[action.icon as keyof typeof LucideIcons] as React.ElementType)
                    : null;

                // Style mapping
                const styleClass =
                    action.style === 'primary'
                        ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50'
                        : action.style === 'danger'
                            ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700';

                return (
                    <button
                        key={action.id}
                        onClick={() => onAction(action)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${styleClass}`}
                        title={action.label}
                    >
                        {IconComponent && <IconComponent size={14} />}
                        <span>{action.label}</span>
                    </button>
                );
            })}
        </div>
    );
};
