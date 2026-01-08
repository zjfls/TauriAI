import React from 'react';
import { AlertCircle } from 'lucide-react';
import { Message } from '../../types';
import { MessageToolbar } from './MessageToolbar';
import { MarkdownRenderer } from './MarkdownRenderer';
// We will import standard list of actions or dispatchers later, 
// for now we pass the handler prop.

interface ErrorBubbleProps {
    message: Message;
    onAction?: (action: any) => void; // We'll refine this execution handler
}

export const ErrorBubble: React.FC<ErrorBubbleProps> = ({ message, onAction }) => {
    // Using useUIStore statically or passed down? 
    // Ideally, the handler logic should be higher up, but for the toolbar we need a way to execute.

    return (
        <div className="flex gap-3 px-4 py-4 justify-center">
            <div className="relative w-full max-w-2xl rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-900/20">
                <div className="flex gap-3">
                    <div className="shrink-0 text-red-500 dark:text-red-400">
                        <AlertCircle size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="prose prose-red prose-sm dark:prose-invert max-w-none text-red-800 dark:text-red-200">
                            <MarkdownRenderer content={message.content} />
                        </div>

                        {/* Toolbar Area */}
                        {message.actions && message.actions.length > 0 && (
                            <div className="mt-3">
                                <MessageToolbar
                                    actions={message.actions}
                                    onAction={(action) => onAction && onAction(action)}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
