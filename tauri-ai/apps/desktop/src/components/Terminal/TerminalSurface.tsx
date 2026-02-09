import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import type { TerminalScope } from '../../types';
import { useTerminalSessionStore } from '../../stores/terminalSessionStore';

const decodeBase64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

const getTheme = () => {
  return document.documentElement.classList.contains('dark')
    ? { background: '#0b0f19', foreground: '#e5e7eb' }
    : { background: '#ffffff', foreground: '#111827' };
};

export interface TerminalSurfaceHandle {
  connect: () => Promise<number | null>;
  disconnect: () => Promise<boolean>;
  reset: () => void;
  focus: () => void;
}

export interface TerminalSurfaceProps {
  scope: TerminalScope;
  workdir?: string | null;
  isActive?: boolean;
  autoConnect?: boolean;
  closeOnUnmount?: boolean;
  className?: string;
}

export const TerminalSurface = React.forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(
  (
    {
      scope,
      workdir = null,
      isActive = true,
      autoConnect = true,
      closeOnUnmount = true,
      className,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const activeRef = useRef<boolean>(isActive);
    const cancelledRef = useRef<boolean>(false);
    const timerRef = useRef<number | null>(null);
    const hadOutputRef = useRef<boolean>(false);
    const manuallyDisconnectedRef = useRef<boolean>(false);

    const scopeKey = useMemo(() => `${scope.kind}:${scope.id}`, [scope.kind, scope.id]);

    useEffect(() => {
      activeRef.current = isActive;
    }, [isActive]);

    const schedule = useCallback((delayMs: number) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => tickRef.current(), delayMs);
    }, []);

    const connect = useCallback(async (): Promise<number | null> => {
      manuallyDisconnectedRef.current = false;
      const sid = await useTerminalSessionStore.getState().ensureSession(scope, { workdir });
      schedule(0);
      return sid;
    }, [schedule, scope, workdir]);

    const disconnect = useCallback(async (): Promise<boolean> => {
      manuallyDisconnectedRef.current = true;
      const ok = await useTerminalSessionStore.getState().closeSession(scope);
      schedule(0);
      return ok;
    }, [schedule, scope]);

    const reset = useCallback(() => {
      try {
        termRef.current?.reset();
      } catch {
        // ignore
      }
    }, []);

    const focus = useCallback(() => {
      try {
        termRef.current?.focus();
      } catch {
        // ignore
      }
    }, []);

    React.useImperativeHandle(
      ref,
      () => ({
        connect,
        disconnect,
        reset,
        focus,
      }),
      [connect, disconnect, focus, reset]
    );

    // Create xterm instance.
    useEffect(() => {
      if (!isTauri()) return;
      if (!containerRef.current) return;
      if (termRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        scrollback: 5000,
        convertEol: true,
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        theme: getTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);

      termRef.current = term;
      fitRef.current = fit;

      // Fit once after mount; container may still be laying out.
      window.setTimeout(() => {
        try {
          fit.fit();
          if (activeRef.current) term.focus();
        } catch {
          // ignore
        }
      }, 30);

      const disposeData = term.onData((data) => {
        if (!isTauri()) return;
        // 用户输入视为显式交互：即使之前手动断开，也允许自动重连。
        manuallyDisconnectedRef.current = false;
        void useTerminalSessionStore.getState().write(scope, data);
        schedule(0);
      });

      // Observe container size changes (better than window resize for split panes / collapsing panels).
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          const fit = fitRef.current;
          if (!fit) return;
          try {
            fit.fit();
          } catch {
            // ignore
          }
        });
        ro.observe(containerRef.current);
        resizeObserverRef.current = ro;
      }

      // Theme sync: watch root class changes (dark/light).
      const mo = new MutationObserver(() => {
        const term = termRef.current;
        if (!term) return;
        try {
          term.options.theme = getTheme();
        } catch {
          // ignore
        }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

      return () => {
        disposeData.dispose();
        mo.disconnect();
        if (resizeObserverRef.current) {
          try {
            resizeObserverRef.current.disconnect();
          } catch {
            // ignore
          }
          resizeObserverRef.current = null;
        }
        try {
          term.dispose();
        } catch {
          // ignore
        }
        termRef.current = null;
        fitRef.current = null;
      };
    }, [schedule, scope, scopeKey]);

    // Read loop (single unified pump) — no duplicate loops anywhere else.
    const tickRef = useRef<() => void>(() => {});
    useEffect(() => {
      cancelledRef.current = false;

      const tick = async () => {
        if (cancelledRef.current) return;

        try {
          const term = termRef.current;
          if (!term) return;

          const sid = useTerminalSessionStore.getState().getSessionId(scope);
          if (!sid) {
            hadOutputRef.current = false;
            return;
          }

          const active = activeRef.current;
          const base64 = await useTerminalSessionStore.getState().readBase64(scope, {
            timeoutMs: active ? 900 : 0,
            maxBytes: 64 * 1024,
          });

          if (cancelledRef.current) return;
          if (base64) {
            const bytes = decodeBase64ToBytes(base64);
            term.write(bytes);
            hadOutputRef.current = true;
          } else {
            hadOutputRef.current = false;
          }
        } finally {
          if (cancelledRef.current) return;
          const active = activeRef.current;
          const had = hadOutputRef.current;
          // Adaptive polling:
          // - Active + output flowing: drain ASAP
          // - Active + idle: light polling
          // - Inactive: back off, but still drain occasionally to avoid unbounded buffer growth
          const nextDelay = active ? (had ? 0 : 120) : had ? 120 : 800;
          schedule(nextDelay);
        }
      };

      tickRef.current = tick;
      schedule(40);

      return () => {
        cancelledRef.current = true;
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    }, [schedule, scope, scopeKey]);

    // Auto-connect policy.
    useEffect(() => {
      if (!isTauri()) return;
      if (!autoConnect) return;
      if (!isActive) return;
      if (manuallyDisconnectedRef.current) return;
      void connect();
    }, [autoConnect, connect, isActive, scopeKey]);

    // When activated, fit+focus after layout settles (split resize / visibility toggle).
    useEffect(() => {
      if (!isTauri()) return;
      if (!isActive) return;
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      window.setTimeout(() => {
        try {
          fit.fit();
          term.focus();
        } catch {
          // ignore
        }
      }, 30);
    }, [isActive, scopeKey]);

    // Cleanup backend session on unmount (optional).
    useEffect(() => {
      return () => {
        if (!closeOnUnmount) return;
        void useTerminalSessionStore.getState().closeSession(scope);
      };
    }, [closeOnUnmount, scope, scopeKey]);

    return <div ref={containerRef} className={className || 'h-full w-full'} />;
  }
);

TerminalSurface.displayName = 'TerminalSurface';

export default TerminalSurface;

