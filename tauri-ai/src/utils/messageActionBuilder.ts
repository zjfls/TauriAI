import { Action, Message } from '../types';

export function buildMessageActions(message: Message): Action[] {
    const actions: Action[] = [];

    // 1. Inherit backend injected actions
    if (message.actions) {
        actions.push(...message.actions);
    }

    // 2. Add Frontend Default Actions based on Role
    if (message.role === 'assistant') {
        // Ensure we don't duplicate if backend already sent them (though typically backend sends specific ones)
        if (!actions.find(a => a.action_type === 'copy')) {
            actions.push({
                id: 'copy_default',
                label: '复制',
                icon: 'Copy',
                action_type: 'copy',
                payload: message.content
            });
        }

        if (!actions.find(a => a.action_type === 'retry')) {
            actions.push({
                id: 'retry_default',
                label: '重试',
                icon: 'RotateCcw',
                action_type: 'retry'
            });
        }
    } else if (message.role === 'user') {
        if (!actions.find(a => a.action_type === 'copy')) {
            actions.push({
                id: 'copy_default',
                label: '复制',
                icon: 'Copy',
                action_type: 'copy',
                payload: message.content
            });
        }

        // Add undo action for user messages - allows undoing to this point
        if (!actions.find(a => a.action_type === 'undo')) {
            actions.push({
                id: 'undo_default',
                label: '撤回',
                icon: 'Undo2',
                action_type: 'undo',
                // Payload contains messageId and content for undo operation
                payload: JSON.stringify({ messageId: message.id, content: message.content })
            });
        }
    }

    return actions;
}
