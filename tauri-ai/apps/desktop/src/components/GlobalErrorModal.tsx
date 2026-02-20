import React, { useState, useEffect, useRef } from 'react';
import { X, Copy, AlertTriangle } from 'lucide-react';

export interface GlobalErrorEventDetail {
    id: string;
    title: string;
    message: string;
    stack?: string;
}

export const GlobalErrorModal = () => {
    const [errors, setErrors] = useState<(GlobalErrorEventDetail & { x: number; y: number })[]>([]);

    useEffect(() => {
        const handleGlobalError = (e: Event) => {
            const customEvent = e as CustomEvent<GlobalErrorEventDetail>;
            setErrors(prev => {
                // Double-check limit (handled mainly in errorUtils)
                if (prev.length >= 3) return prev;
                // Cascade dialog position by offset
                const offset = prev.length * 30;
                return [...prev, { ...customEvent.detail, x: Math.max(0, 100 + offset), y: Math.max(0, 100 + offset) }];
            });
        };

        window.addEventListener('tauriai:global-error', handleGlobalError);
        return () => window.removeEventListener('tauriai:global-error', handleGlobalError);
    }, []);

    const closeError = (id: string) => {
        setErrors(prev => prev.filter(err => err.id !== id));
        window.dispatchEvent(new CustomEvent('tauriai:global-error-closed', { detail: { id } }));
    };

    const [copiedId, setCopiedId] = useState<string | null>(null);

    const copyDetail = (err: GlobalErrorEventDetail) => {
        const text = `[${err.title}]\n${err.message}\n\nStack:\n${err.stack || 'No stack trace available.'}`;
        navigator.clipboard.writeText(text).then(() => {
            setCopiedId(err.id);
            setTimeout(() => setCopiedId(null), 2000);
        });
    };

    // Dragging logic securely bound via pointer capture
    const dragRef = useRef<{ id: string, startX: number, startY: number, initialX: number, initialY: number } | null>(null);

    const handlePointerDown = (e: React.PointerEvent, id: string, ix: number, iy: number) => {
        // Only drag with left click
        if (e.button !== 0) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { id, startX: e.clientX, startY: e.clientY, initialX: ix, initialY: iy };
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragRef.current) return;
        const { id, startX, startY, initialX, initialY } = dragRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        setErrors(prev => prev.map(err => err.id === id ? { ...err, x: initialX + dx, y: initialY + dy } : err));
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (dragRef.current) {
            try {
                (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch (err) {
                // ignore
            }
            dragRef.current = null;
        }
    };

    if (errors.length === 0) return null;

    return (
        <div className="fixed inset-0 z-[99999] pointer-events-none">
            {errors.map(err => (
                <div
                    key={err.id}
                    className="absolute pointer-events-auto bg-white dark:bg-gray-800 shadow-2xl border border-red-500/30 rounded-lg w-[500px] max-w-[90vw] max-h-[85vh] flex flex-col overflow-hidden"
                    style={{ transform: `translate(${err.x}px, ${err.y}px)` }}
                >
                    {/* Header (Draggable) */}
                    <div
                        className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/30 cursor-grab active:cursor-grabbing select-none"
                        onPointerDown={(e) => handlePointerDown(e, err.id, err.x, err.y)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                    >
                        <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-medium overflow-hidden">
                            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                            <span className="truncate">{err.title}</span>
                        </div>
                        <button
                            onClick={() => closeError(err.id)}
                            className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded-md transition-colors text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 flex-shrink-0"
                            title="关闭"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Main Error Content */}
                    <div className="p-4 overflow-y-auto flex-1 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                        <div className="mb-4 whitespace-pre-wrap break-words">{err.message}</div>

                        {err.stack && (
                            <div className="mt-4">
                                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">详细调用栈 (Stack Trace)</div>
                                <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-md border border-gray-100 dark:border-gray-800 overflow-x-auto whitespace-pre-wrap font-mono text-gray-600 dark:text-gray-300 select-text">
                                    {err.stack}
                                </pre>
                            </div>
                        )}
                    </div>

                    {/* Footer Actions */}
                    <div className="p-3 bg-gray-50 dark:bg-gray-800/80 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2 shrink-0">
                        <button
                            onClick={() => copyDetail(err)}
                            className="px-4 py-2 flex items-center gap-1.5 text-sm font-medium bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors shadow-sm text-gray-700 dark:text-gray-200"
                        >
                            <Copy className="w-4 h-4" />
                            {copiedId === err.id ? '已复制 ✔' : '复制详情 (Copy)'}
                        </button>
                        <button
                            onClick={() => closeError(err.id)}
                            className="px-5 py-2 text-sm font-medium bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors shadow-sm"
                        >
                            关闭 (Close)
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
};
