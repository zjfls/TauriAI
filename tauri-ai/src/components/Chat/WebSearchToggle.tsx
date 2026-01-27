/**
 * WebSearchToggle Component
 * Toggle button for enabling/disabling built-in web search
 */

import React from 'react';
import { Globe } from 'lucide-react';

interface WebSearchToggleProps {
    enabled: boolean;
    onToggle: () => void;
    disabled?: boolean;
    mode?: 'native' | 'tool';
    details?: string;
}

/**
 * WebSearchToggle - Simple toggle button for web search capability
 * 
 * @param enabled - Whether web search is currently enabled
 * @param onToggle - Callback when toggle is clicked
 * @param disabled - Whether the toggle is disabled
 */
export const WebSearchToggle: React.FC<WebSearchToggleProps> = ({
    enabled,
    onToggle,
    disabled = false,
    mode,
    details,
}) => {
    const modeLabel = mode === 'native' ? '模型内置' : mode === 'tool' ? '本地工具' : '';
    const title = (() => {
        const base = enabled ? '搜索已开启，点击关闭' : '搜索已关闭，点击开启';
        const parts = [base];
        if (modeLabel) parts.push(`模式：${modeLabel}`);
        if (details) parts.push(details);
        return parts.join('｜');
    })();

    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={disabled}
            className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${enabled
                    ? 'bg-blue-100 text-blue-600 border-blue-300 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-700'
                    : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700 dark:hover:bg-gray-700'
                } disabled:cursor-not-allowed disabled:opacity-50`}
            title={title}
            aria-pressed={enabled}
        >
            <Globe size={12} />
            <span>搜索</span>
        </button>
    );
};

export default WebSearchToggle;
