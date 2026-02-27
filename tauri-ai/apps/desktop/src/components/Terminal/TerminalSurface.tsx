import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import type { AnsiColorMode, TerminalScope } from '../../types';
import { useTerminalSessionStore } from '../../stores/terminalSessionStore';
import { useConfigStore } from '../../stores/configStore';
import { resolveAnsiPalette } from '../../utils/ansi';

const decodeBase64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

const getTheme = (ansiColorMode: AnsiColorMode = 'auto') => {
  const isDark = document.documentElement.classList.contains('dark');
  const palette = resolveAnsiPalette(ansiColorMode, isDark ? 'dark' : 'light');
  // NOTE: xterm's default cursor color is close to white; in light mode that can become invisible.
  // Always set an explicit cursor color for contrast.
  const base = isDark
    ? {
        background: '#0b0f19',
        foreground: '#e5e7eb',
        cursor: '#e5e7eb',
        cursorAccent: '#0b0f19',
        selectionBackground: 'rgba(148, 163, 184, 0.35)',
      }
    : {
        background: '#ffffff',
        foreground: '#111827',
        cursor: '#111827',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(17, 24, 39, 0.18)',
      };

  return {
    ...base,
    black: palette.normal[0],
    red: palette.normal[1],
    green: palette.normal[2],
    yellow: palette.normal[3],
    blue: palette.normal[4],
    magenta: palette.normal[5],
    cyan: palette.normal[6],
    white: palette.normal[7],
    brightBlack: palette.bright[0],
    brightRed: palette.bright[1],
    brightGreen: palette.bright[2],
    brightYellow: palette.bright[3],
    brightBlue: palette.bright[4],
    brightMagenta: palette.bright[5],
    brightCyan: palette.bright[6],
    brightWhite: palette.bright[7],
  };
};

const patchXtermRenderServiceDimensions = (term: XTerm) => {
  // xterm 的 RenderService.dimensions getter 在 renderer 已释放时会直接访问
  // `this._renderer.value.dimensions`，从而抛出：
  //   undefined is not an object (evaluating 'this._renderer.value.dimensions')
  // 这通常发生在 React 严格模式/快速卸载/布局抖动下，存在“dispose 后仍有异步刷新回调”。
  //
  // 这里做一个非常保守的实例级补丁：
  // - renderer 存在：返回真实 dimensions，并缓存一份
  // - renderer 不存在：返回缓存的 dimensions（或零值兜底），避免全局错误干扰 UI
  try {
    const core = (term as any)?._core;
    const renderService = core?._renderService;
    if (!renderService) return;
    if ((renderService as any).__tauriai_patched_dimensions) return;
    Object.defineProperty(renderService, '__tauriai_patched_dimensions', {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false,
    });

    let cached: any = null;
    try {
      const current = renderService?._renderer?.value?.dimensions;
      if (current) cached = current;
    } catch {
      // ignore
    }

    Object.defineProperty(renderService, 'dimensions', {
      configurable: true,
      enumerable: true,
      get() {
        try {
          const dims = (this as any)?._renderer?.value?.dimensions;
          if (dims) {
            cached = dims;
            return dims;
          }
        } catch {
          // ignore
        }

        if (cached) return cached;

        // 最后的兜底：结构尽量完整，避免后续访问再抛错。
        return {
          css: {
            canvas: { width: 0, height: 0 },
            cell: { width: 0, height: 0 },
            viewport: { width: 0, height: 0 },
          },
          device: {
            canvas: { width: 0, height: 0 },
            cell: { width: 0, height: 0 },
            viewport: { width: 0, height: 0 },
          },
        };
      },
    });
  } catch {
    // ignore
  }
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
    const fitOnceTimerRef = useRef<number | null>(null);
    const activateFitTimerRef = useRef<number | null>(null);
    const hadOutputRef = useRef<boolean>(false);
    const manuallyDisconnectedRef = useRef<boolean>(false);
    const termGenRef = useRef<number>(0);
    const writeChainRef = useRef<Promise<void>>(Promise.resolve());
    const tickInFlightRef = useRef<boolean>(false);
    const tickPendingRef = useRef<boolean>(false);
    const resizeTimerRef = useRef<number | null>(null);
    const lastPtySizeRef = useRef<{ cols: number; rows: number } | null>(null);

    const ansiColorMode = useConfigStore((s) => (s.config?.general?.ansiColorMode ?? 'auto') as AnsiColorMode);
    const ansiColorModeRef = useRef<AnsiColorMode>(ansiColorMode);
    useEffect(() => {
      ansiColorModeRef.current = ansiColorMode;
      const term = termRef.current;
      if (!term) return;
      try {
        term.options.theme = getTheme(ansiColorModeRef.current);
      } catch {
        // ignore
      }
    }, [ansiColorMode]);

    // Important: `scope` is frequently passed as an inline object literal by parents.
    // If we depend on the object identity, React re-renders (e.g. chat streaming) would
    // repeatedly tear down and recreate the terminal, causing massive jank.
    const stableScope: TerminalScope = useMemo(() => ({ kind: scope.kind, id: scope.id }), [scope.kind, scope.id]);
    const scopeKey = useMemo(() => `${stableScope.kind}:${stableScope.id}`, [stableScope.kind, stableScope.id]);

    useEffect(() => {
      activeRef.current = isActive;
    }, [isActive]);

    const schedule = useCallback((delayMs: number) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => tickRef.current(), delayMs);
    }, []);

    const enqueueWrite = useCallback((term: XTerm, gen: number, bytes: Uint8Array) => {
      // xterm.write 的刷新是异步的；为了避免在 dispose 后仍有 pending refresh 触发，
      // 这里把写入串行化，并在卸载时等待最后一次写入完成后再 dispose。
      writeChainRef.current = writeChainRef.current
        .catch(() => {
          // keep chain alive even if a previous write failed
        })
        .then(
          () =>
            new Promise<void>((resolve) => {
              // 防止 stale term（StrictMode/卸载/重建）上的写入。
              if (termGenRef.current !== gen) return resolve();
              if (termRef.current !== term) return resolve();
              try {
                term.write(bytes, resolve);
              } catch {
                resolve();
              }
            })
        );
    }, []);

    const connect = useCallback(async (): Promise<number | null> => {
      manuallyDisconnectedRef.current = false;
      const term = termRef.current;
      const initialSize =
        term && term.cols > 0 && term.rows > 0 ? { cols: term.cols, rows: term.rows } : undefined;
      const sid = await useTerminalSessionStore
        .getState()
        .ensureSession(stableScope, { workdir, initialSize });
      schedule(0);
      // Keep backend PTY size in sync with xterm so shells like PowerShell (PSReadLine)
      // can render/calculate cursor positions correctly (especially on Windows).
      if (sid && term && term.cols > 0 && term.rows > 0) {
        lastPtySizeRef.current = { cols: term.cols, rows: term.rows };
        void useTerminalSessionStore.getState().resize(stableScope, { cols: term.cols, rows: term.rows });
      }
      return sid;
    }, [schedule, stableScope, workdir]);

    const disconnect = useCallback(async (): Promise<boolean> => {
      manuallyDisconnectedRef.current = true;
      const ok = await useTerminalSessionStore.getState().closeSession(stableScope);
      schedule(0);
      return ok;
    }, [schedule, stableScope]);

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

      termGenRef.current += 1;

      const term = new XTerm({
        cursorBlink: true,
        scrollback: 5000,
        // Windows ConPTY already uses CRLF; avoid double-converting and cursor drift.
        convertEol: !(typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)),
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        theme: getTheme(ansiColorModeRef.current),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      let isOpened = false;

      const scheduleResize = () => {
        const t = termRef.current;
        if (!t) return;
        const cols = t.cols;
        const rows = t.rows;
        if (!cols || !rows) return;
        const prev = lastPtySizeRef.current;
        if (prev && prev.cols === cols && prev.rows === rows) return;
        lastPtySizeRef.current = { cols, rows };
        void useTerminalSessionStore.getState().resize(stableScope, { cols, rows });
      };

      const tryOpenAndFit = () => {
        if (!containerRef.current) return;
        if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) {
          return;
        }

        if (!isOpened) {
          try {
            term.open(containerRef.current);
            isOpened = true;
            termRef.current = term;
            fitRef.current = fit;
            patchXtermRenderServiceDimensions(term);
          } catch (e) {
            console.warn('Failed to open xterm:', e);
            return;
          }
        }

        // Fit after opened and confirmed visible
        try {
          if (term.element) {
            fit.fit();
            // Sync backend PTY size after fit so the shell's idea of rows/cols matches xterm.
            // Debounce to avoid spamming resize on rapid layout changes.
            if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
            const gen = termGenRef.current;
            resizeTimerRef.current = window.setTimeout(() => {
              if (termGenRef.current !== gen) return;
              scheduleResize();
            }, 30);
          }
        } catch (e) {
          console.warn('xterm fit error on resize/mount:', e);
        }
      };

      // Try immediately
      tryOpenAndFit();

      // If successfully opened, optionally focus
      window.setTimeout(() => {
        if (isOpened && activeRef.current && term.element) {
          try { term.focus(); } catch (e) { /* ignore */ }
        }
      }, 30);

      const disposeData = term.onData((data) => {
        if (!isTauri()) return;
        // 用户输入视为显式交互：即使之前手动断开，也允许自动重连。
        manuallyDisconnectedRef.current = false;
        void useTerminalSessionStore.getState().write(stableScope, data);
        schedule(0);
      });

      // Observe container size changes. This will also lazy-open the terminal when it finally gets dimensions.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          tryOpenAndFit();
        });
        ro.observe(containerRef.current);
        resizeObserverRef.current = ro;
      }

      // Theme sync: watch root class changes (dark/light).
      const mo = new MutationObserver(() => {
        const term = termRef.current;
        if (!term) return;
        try {
          term.options.theme = getTheme(ansiColorModeRef.current);
        } catch {
          // ignore
        }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

      return () => {
        // Invalidate all pending callbacks (StrictMode will mount/unmount twice in dev).
        termGenRef.current += 1;
        if (resizeTimerRef.current) {
          window.clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = null;
        }
        if (fitOnceTimerRef.current) {
          window.clearTimeout(fitOnceTimerRef.current);
          fitOnceTimerRef.current = null;
        }
        if (activateFitTimerRef.current) {
          window.clearTimeout(activateFitTimerRef.current);
          activateFitTimerRef.current = null;
        }
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

        // 关键：
        // - 等待最后一次 write 完成（flush write buffer）
        // - 再延迟至少 1-2 帧让 xterm 内部 RAF 刷新跑完
        // 否则可能出现 xterm 的 Viewport/_innerRefresh 在 dispose 后继续执行，
        // 触发 RenderService.dimensions 访问空 renderer（_renderer.value 为 undefined）。
        termRef.current = null;
        fitRef.current = null;
        void writeChainRef.current.finally(() => {
          const disposeNow = () => {
            try {
              term.dispose();
            } catch {
              // ignore
            }
          };

          // xterm 内部会用 requestAnimationFrame 做 viewport / render 刷新。
          // 若此处立即 dispose，RAF 可能在下一帧触发并访问已释放的 renderer。
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => disposeNow()));
          } else {
            setTimeout(disposeNow, 0);
          }
        });
      };
    }, [enqueueWrite, schedule, stableScope, scopeKey]);

    // Read loop (single unified pump) — no duplicate loops anywhere else.
    const tickRef = useRef<() => void>(() => { });
    useEffect(() => {
      cancelledRef.current = false;

      const tick = async () => {
        if (cancelledRef.current) return;
        if (tickInFlightRef.current) {
          tickPendingRef.current = true;
          return;
        }
        tickInFlightRef.current = true;

        try {
          const term = termRef.current;
          if (!term) return;
          const gen = termGenRef.current;

          const sid = useTerminalSessionStore.getState().getSessionId(stableScope);
          if (!sid) {
            hadOutputRef.current = false;
            return;
          }

          const active = activeRef.current;
          const base64 = await useTerminalSessionStore.getState().readBase64(stableScope, {
            timeoutMs: active ? 900 : 0,
            maxBytes: 64 * 1024,
          });

          if (cancelledRef.current) return;
          if (base64) {
            const bytes = decodeBase64ToBytes(base64);
            enqueueWrite(term, gen, bytes);
            hadOutputRef.current = true;
          } else {
            hadOutputRef.current = false;
          }
        } finally {
          tickInFlightRef.current = false;
          if (cancelledRef.current) return;
          if (tickPendingRef.current) {
            tickPendingRef.current = false;
            schedule(0);
            return;
          }
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
        tickPendingRef.current = false;
        tickInFlightRef.current = false;
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    }, [enqueueWrite, schedule, stableScope, scopeKey]);

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
      if (activateFitTimerRef.current) window.clearTimeout(activateFitTimerRef.current);
      const gen = termGenRef.current;
      activateFitTimerRef.current = window.setTimeout(() => {
        if (termGenRef.current !== gen) return;
        try {
          if (containerRef.current && containerRef.current.clientWidth > 0 && term.element) {
            fit.fit();
          }
          term.focus();
        } catch (e) {
          console.warn('xterm fit/focus error on active:', e);
        }
      }, 30);
    }, [isActive, scopeKey]);

    // Cleanup backend session on unmount (optional).
    useEffect(() => {
      return () => {
        if (!closeOnUnmount) return;
        void useTerminalSessionStore.getState().closeSession(stableScope);
      };
    }, [closeOnUnmount, stableScope, scopeKey]);

    return <div ref={containerRef} className={className || 'h-full w-full'} />;
  }
);

TerminalSurface.displayName = 'TerminalSurface';

export default TerminalSurface;
