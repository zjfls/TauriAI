import React, { useState, useEffect, useRef } from 'react';
import { X, Copy, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

export interface GlobalErrorEventDetail {
    id: string;
    title: string;
    message: string;
    stack?: string;
}

type DbLockSnapshot = {
    op: string;
    acquiredAtMs: number;
    heldForMs: number;
};

type DbLockParsed = {
    timeoutMs?: number;
    op?: string;
    holderOp?: string;
    heldForMs?: number;
};

const parseDbLockInfo = (message: string): DbLockParsed | null => {
    if (!message.includes('DB lock 超时')) return null;
    const out: DbLockParsed = {};

    const timeoutMatch = /DB lock 超时（(\d+)ms）/.exec(message);
    if (timeoutMatch) out.timeoutMs = Number(timeoutMatch[1]);

    const opMatch = /操作=([^\s；\n]+)/.exec(message);
    if (opMatch) out.op = opMatch[1];

    const holderMatch = /当前持锁操作=([^；\n]+)/.exec(message);
    if (holderMatch) out.holderOp = holderMatch[1];

    const heldMatch = /已持锁=(\d+)ms/.exec(message);
    if (heldMatch) out.heldForMs = Number(heldMatch[1]);

    return out;
};

const renderMessageWithHighlights = (message: string) => {
    const lines = message.split('\n');
    return (
        <div className="whitespace-pre-wrap break-words">
            {lines.map((line, idx) => {
                const isTimeout = line.includes('DB lock 超时');
                const isHolder = line.includes('当前持锁操作=');
                const isHeld = line.includes('已持锁=');
                const cls = isTimeout
                    ? 'text-red-700 dark:text-red-300 font-semibold'
                    : isHolder || isHeld
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-gray-700 dark:text-gray-300';
                return (
                    <div key={idx} className={cls}>
                        {line}
                    </div>
                );
            })}
        </div>
    );
};

export const GlobalErrorModal = () => {
    const [errors, setErrors] = useState<(GlobalErrorEventDetail & { x: number; y: number })[]>([]);
    const [dbLockSnapshots, setDbLockSnapshots] = useState<Record<string, DbLockSnapshot | null>>({});

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

    // Lightweight "DB lock monitor": while any modal contains a DB lock timeout,
    // poll the backend snapshot periodically to help users identify the stuck op.
    useEffect(() => {
        const lockedIds = errors
            .filter((e) => Boolean(parseDbLockInfo(e.message)))
            .map((e) => e.id);
        if (lockedIds.length === 0) return;

        let disposed = false;
        let failCount = 0;

        const tick = async () => {
            try {
                const snap = await invoke<DbLockSnapshot | null>('get_db_lock_snapshot');
                if (disposed) return;
                failCount = 0;
                setDbLockSnapshots((prev) => {
                    const next: Record<string, DbLockSnapshot | null> = { ...prev };
                    for (const id of lockedIds) next[id] = snap;
                    return next;
                });
            } catch {
                if (disposed) return;
                failCount += 1;
            }
        };

        const intervalMs = 1000;
        void tick();
        const timer = window.setInterval(() => {
            // simple backoff on repeated failures (avoid spinning on environments where invoke is unavailable)
            if (failCount >= 3) return;
            void tick();
        }, intervalMs);

        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [errors]);

    const closeError = (id: string) => {
        setErrors(prev => prev.filter(err => err.id !== id));
        setDbLockSnapshots(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
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
                        {(() => {
                            const dbLock = parseDbLockInfo(err.message);
                            const snap = dbLockSnapshots[err.id] ?? null;
                            const shouldShowDbLockPanel = Boolean(dbLock);
                            return (
                                <>
                                    {shouldShowDbLockPanel && (
                                        <div className="mb-4 p-3 rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-900/10">
                                            <div className="text-xs font-semibold text-amber-800 dark:text-amber-200 mb-2 uppercase tracking-wider">
                                                DB 锁超时诊断
                                            </div>
                                            <div className="text-sm text-amber-900 dark:text-amber-100 space-y-1">
                                                <div>
                                                    <span className="font-medium">请求操作：</span>
                                                    <span className="font-mono">{dbLock?.op ?? 'unknown'}</span>
                                                    {typeof dbLock?.timeoutMs === 'number' && (
                                                        <span className="ml-2 text-amber-800/80 dark:text-amber-200/80">
                                                            超时 {dbLock.timeoutMs}ms
                                                        </span>
                                                    )}
                                                </div>
                                                {dbLock?.holderOp && (
                                                    <div>
                                                        <span className="font-medium">当前持锁：</span>
                                                        <span className="font-mono">{dbLock.holderOp}</span>
                                                        {typeof dbLock?.heldForMs === 'number' && (
                                                            <span className="ml-2 text-amber-800/80 dark:text-amber-200/80">
                                                                已持锁 {dbLock.heldForMs}ms
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="pt-2 flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            try {
                                                                const v = await invoke<DbLockSnapshot | null>('get_db_lock_snapshot');
                                                                setDbLockSnapshots(prev => ({ ...prev, [err.id]: v }));
                                                            } catch {
                                                                setDbLockSnapshots(prev => ({ ...prev, [err.id]: null }));
                                                            }
                                                        }}
                                                        className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-700 border border-amber-200 dark:border-amber-900/50 rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors shadow-sm text-amber-900 dark:text-amber-100"
                                                    >
                                                        刷新当前锁状态
                                                    </button>
                                                    {snap && (
                                                        <div className="text-xs text-amber-900/80 dark:text-amber-100/80">
                                                            <span className="font-medium">实时持锁：</span>
                                                            <span className="font-mono">{snap.op}</span>
                                                            <span className="ml-2">已持锁 {snap.heldForMs}ms</span>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="pt-2 text-xs text-amber-900/70 dark:text-amber-100/70">
                                                    建议：若“实时持锁”长期不变，说明某个持锁操作卡住（CPU 解析过重或锁内做了 IO）。可据此回溯对应操作名。
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="mb-4">
                                        {shouldShowDbLockPanel ? renderMessageWithHighlights(err.message) : (
                                            <div className="whitespace-pre-wrap break-words">{err.message}</div>
                                        )}
                                    </div>
                                </>
                            );
                        })()}

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
