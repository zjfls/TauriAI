import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InkPoint, InkState, InkStroke, InkToolKind } from "../types";
import { findInkBrushPreset } from "./brushes";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function computeMaxY(strokes: InkStroke[]): number {
  let maxY = 0;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.y > maxY) maxY = p.y;
    }
  }
  return maxY;
}

function computeMaxX(strokes: InkStroke[]): number {
  let maxX = 0;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x > maxX) maxX = p.x;
    }
  }
  return maxX;
}

function computeDesiredHeightPx(strokes: InkStroke[], viewportHeightPx: number, minHeightPx: number): number {
  const vh = Math.max(1, Math.round(viewportHeightPx));
  const base = Math.max(vh * 2, Math.round(minHeightPx || 0));
  const maxY = computeMaxY(strokes);
  return Math.max(base, Math.ceil(maxY + vh));
}

function scaleStrokes(
  strokes: InkStroke[],
  scale: number,
): InkStroke[] {
  if (!Number.isFinite(scale)) return strokes;
  if (Math.abs(scale - 1) < 1e-6) return strokes;
  return strokes.map((s) => ({
    ...s,
    size: s.size * scale,
    points: s.points.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale })),
  }));
}

type PointerSampleLike = {
  clientX: number;
  clientY: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
};

type CanvasRectLike = {
  left: number;
  top: number;
};

type ResolvedStrokeStyle = {
  isEraser: boolean;
  compositeOperation: GlobalCompositeOperation;
  strokeStyle: string;
  globalAlpha: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  baseSize: number;
  pressureSensitivity: number;
};

type InkPerfMetrics = {
  strokeStartedAtMs: number;
  moveEventCount: number;
  sampleCount: number;
  sampleTimeMs: number;
  drawTimeMs: number;
  presentCount: number;
  presentTimeMs: number;
  commitTimeMs: number;
};

const PAPER_COLOR = "#f6efdb";
const MIN_VALID_VIEWPORT_PX = 50;
const MAX_INK_CANVAS_DPR = 2;

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function createInkPerfMetrics(): InkPerfMetrics {
  return {
    strokeStartedAtMs: 0,
    moveEventCount: 0,
    sampleCount: 0,
    sampleTimeMs: 0,
    drawTimeMs: 0,
    presentCount: 0,
    presentTimeMs: 0,
    commitTimeMs: 0,
  };
}

function shouldLogInkPerf(): boolean {
  return typeof globalThis !== "undefined" && Boolean((globalThis as any).__TAURIAI_INK_DEBUG__);
}

function logInkPerf(metrics: InkPerfMetrics): void {
  if (!shouldLogInkPerf() || metrics.strokeStartedAtMs <= 0) return;
  const totalMs = Math.max(0, nowMs() - metrics.strokeStartedAtMs);
  const round = (value: number) => Number(value.toFixed(2));
  console.debug("[ink] stroke perf", {
    totalMs: round(totalMs),
    moveEventCount: metrics.moveEventCount,
    sampleCount: metrics.sampleCount,
    sampleTimeMs: round(metrics.sampleTimeMs),
    drawTimeMs: round(metrics.drawTimeMs),
    presentCount: metrics.presentCount,
    presentTimeMs: round(metrics.presentTimeMs),
    commitTimeMs: round(metrics.commitTimeMs),
  });
}

function readCanvasRect(canvas: HTMLCanvasElement): CanvasRectLike {
  const rect = canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

function getPointFromPointerSample(
  e: PointerSampleLike,
  rect: CanvasRectLike,
): InkPoint {
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const tiltX = typeof e.tiltX === "number" ? e.tiltX : undefined;
  const tiltY = typeof e.tiltY === "number" ? e.tiltY : undefined;
  const pressure = typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : undefined;
  const twist = typeof (e as any).twist === "number" ? (e as any).twist : undefined;
  return { x, y, t: Date.now(), pressure, tiltX, tiltY, twist };
}

function resolveStrokeStyle(stroke: InkStroke): ResolvedStrokeStyle {
  const needsBrushFallback =
    stroke.opacity == null ||
    stroke.pressureSensitivity == null ||
    stroke.blendMode == null ||
    stroke.lineCap == null ||
    stroke.lineJoin == null;
  const brush = needsBrushFallback ? findInkBrushPreset(stroke.brushId) : undefined;
  const isEraser = stroke.tool === "eraser";
  return {
    isEraser,
    compositeOperation: isEraser ? "destination-out" : (stroke.blendMode ?? brush?.blendMode ?? "source-over"),
    strokeStyle: isEraser
      ? "rgba(0,0,0,1)"
      : (typeof stroke.color === "string" && stroke.color.trim() ? stroke.color : "#111827"),
    globalAlpha: isEraser ? 1 : clamp(stroke.opacity ?? brush?.opacity ?? (stroke.tool === "pencil" ? 0.65 : 1), 0.05, 1),
    lineCap: stroke.lineCap ?? brush?.lineCap ?? "round",
    lineJoin: stroke.lineJoin ?? brush?.lineJoin ?? "round",
    baseSize: clamp(stroke.size, 0.5, 64),
    pressureSensitivity: clamp(stroke.pressureSensitivity ?? brush?.pressureSensitivity ?? 0, 0, 1),
  };
}

function applyStrokeStyle(ctx: CanvasRenderingContext2D, style: ResolvedStrokeStyle): void {
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.strokeStyle = style.strokeStyle;
  ctx.globalAlpha = style.globalAlpha;
  ctx.lineCap = style.lineCap;
  ctx.lineJoin = style.lineJoin;
}

function drawStrokeSegment(
  ctx: CanvasRenderingContext2D,
  style: ResolvedStrokeStyle,
  a: InkPoint,
  b: InkPoint,
) {
  const rawPressure =
    (typeof b.pressure === "number" && b.pressure > 0 ? b.pressure : undefined) ??
    (typeof a.pressure === "number" && a.pressure > 0 ? a.pressure : undefined) ??
    0.5;
  const pressure = clamp(rawPressure, 0.1, 1);
  const width =
    style.isEraser
      ? style.baseSize
      : Math.max(0.5, style.baseSize * (1 - style.pressureSensitivity + style.pressureSensitivity * pressure));

  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function redrawAll(
  ctx: CanvasRenderingContext2D,
  strokes: InkStroke[],
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  for (const s of strokes) {
    const pts = s.points;
    if (pts.length < 2) continue;
    const style = resolveStrokeStyle(s);
    applyStrokeStyle(ctx, style);
    for (let i = 1; i < pts.length; i += 1) {
      drawStrokeSegment(ctx, style, pts[i - 1]!, pts[i]!);
    }
  }
}

function redrawPaperBackground(
  ctx: CanvasRenderingContext2D,
  template: "blank" | "ruled" | "grid",
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, w, h);

  if (template === "blank") return;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = template === "grid" ? "rgba(148,120,72,0.22)" : "rgba(148,120,72,0.30)";
  ctx.beginPath();

  if (template === "grid") {
    const step = 24;
    for (let x = 0; x <= w; x += step) {
      const xx = Math.round(x) + 0.5;
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, h);
    }
    for (let y = 0; y <= h; y += step) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
    }
  } else {
    const step = 28;
    for (let y = 0; y <= h; y += step) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
    }
  }

  ctx.stroke();
  ctx.restore();
}

export function createEmptyInkState(): InkState {
  return { width: 0, height: 0, strokes: [] };
}

export function createDefaultInkState(viewportWidth: number, viewportHeight: number): InkState {
  const w = Math.max(1, Math.round(viewportWidth));
  const h = Math.max(1, Math.round(viewportHeight * 2));
  return { width: w, height: h, strokes: [] };
}

function preparePreviewInk(value: InkState, targetWidth: number): { strokes: InkStroke[]; minHeight: number } {
  const safeWidth = Math.max(1, Math.round(targetWidth));
  const sourceWidth = Number.isFinite(value.width) ? value.width : 0;
  const sourceHeight = Math.max(0, Number.isFinite(value.height) ? value.height : 0);

  if (sourceWidth >= MIN_VALID_VIEWPORT_PX) {
    const scale = safeWidth / sourceWidth;
    if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-6) {
      return { strokes: value.strokes, minHeight: sourceHeight };
    }
    return {
      strokes: scaleStrokes(value.strokes, scale),
      minHeight: sourceHeight * scale,
    };
  }

  const maxX = computeMaxX(value.strokes);
  const maxY = computeMaxY(value.strokes);
  const looksNormalized = maxX <= MIN_VALID_VIEWPORT_PX && maxY <= MIN_VALID_VIEWPORT_PX;
  if (!looksNormalized) {
    return { strokes: value.strokes, minHeight: sourceHeight };
  }

  const scale = safeWidth / Math.max(1, sourceWidth);
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-6) {
    return { strokes: value.strokes, minHeight: sourceHeight };
  }
  return {
    strokes: scaleStrokes(value.strokes, scale),
    minHeight: sourceHeight > 0 ? sourceHeight * scale : sourceHeight,
  };
}

export type InkPreviewProps = {
  value: InkState;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  template?: "blank" | "ruled" | "grid";
  swallowInteractions?: boolean;
};

export function InkPreview({
  value,
  className,
  viewportClassName,
  contentClassName,
  template = "ruled",
  swallowInteractions = true,
}: InkPreviewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize((prev) => {
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        if (prev.w === w && prev.h === h) return prev;
        return { w, h };
      });
    };

    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setViewportSize((prev) => {
        const w = Math.max(1, Math.round(box.width));
        const h = Math.max(1, Math.round(box.height));
        if (prev.w === w && prev.h === h) return prev;
        return { w, h };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const desiredContentWidth = useMemo(() => {
    const measured = Math.max(0, Math.round(viewportSize.w));
    if (measured >= MIN_VALID_VIEWPORT_PX) return measured;
    const fallback = Number.isFinite(value.width) ? value.width : 0;
    if (fallback >= MIN_VALID_VIEWPORT_PX) return fallback;
    return Math.max(1, measured);
  }, [value.width, viewportSize.w]);

  const preview = useMemo(() => preparePreviewInk(value, desiredContentWidth), [desiredContentWidth, value]);

  const desiredContentHeight = useMemo(() => {
    return computeDesiredHeightPx(preview.strokes, viewportSize.h, preview.minHeight);
  }, [preview, viewportSize.h]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, MAX_INK_CANVAS_DPR);
    const w = Math.max(1, Math.round(desiredContentWidth));
    const h = Math.max(1, Math.round(desiredContentHeight));

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    let ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawPaperBackground(ctx, template, w, h);
    redrawAll(ctx, preview.strokes, w, h);
  }, [desiredContentHeight, desiredContentWidth, preview, template]);

  const swallowPreviewInteraction = useCallback((event: React.SyntheticEvent<HTMLDivElement>) => {
    if (!swallowInteractions) return;
    event.preventDefault();
    event.stopPropagation();
  }, [swallowInteractions]);

  return (
    <div className={cx("relative h-full w-full", className)}>
      <div
        ref={viewportRef}
        className={cx("relative h-full w-full overflow-hidden rounded-lg border border-black/10", viewportClassName)}
        style={{ backgroundColor: PAPER_COLOR }}
      >
        <div
          className={cx("relative w-full", contentClassName)}
          style={{ height: `${desiredContentHeight}px` }}
        >
          <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 block pointer-events-none" />
        </div>
        {swallowInteractions ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-[1] rounded-lg"
            style={{ touchAction: "none" }}
            onPointerDown={swallowPreviewInteraction}
            onPointerMove={swallowPreviewInteraction}
            onPointerUp={swallowPreviewInteraction}
            onPointerCancel={swallowPreviewInteraction}
            onTouchStart={swallowPreviewInteraction}
            onTouchMove={swallowPreviewInteraction}
            onTouchEnd={swallowPreviewInteraction}
            onWheel={swallowPreviewInteraction}
            onContextMenu={swallowPreviewInteraction}
          />
        ) : null}
      </div>
    </div>
  );
}

export type ScrollableInkPadProps = {
  value: InkState;
  onChange: (next: InkState, committed: boolean) => void;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  template?: "blank" | "ruled" | "grid";
  tool?: InkToolKind;
  brushId?: string;
  penColor?: string;
  penSize?: number;
  disabled?: boolean;
};

export function ScrollableInkPad({
  value,
  onChange,
  className,
  viewportClassName,
  contentClassName,
  template = "ruled",
  tool = "pen",
  brushId,
  penColor = "#111827",
  penSize = 3,
  disabled,
}: ScrollableInkPadProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const strokeCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  const lastPointRef = useRef<InkPoint | null>(null);
  const activeStrokeIdRef = useRef<string | null>(null);
  const activeStrokeRef = useRef<InkStroke | null>(null);
  const touchScrollRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);
  const canvasRectRef = useRef<CanvasRectLike | null>(null);
  const activeStrokeStyleRef = useRef<ResolvedStrokeStyle | null>(null);
  const inkPerfRef = useRef<InkPerfMetrics>(createInkPerfMetrics());

  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [inking, setInking] = useState(false);

  const [draft, setDraft] = useState<InkState>(value);
  const draftRef = useRef<InkState>(value);

  const refreshCanvasRect = useCallback((): CanvasRectLike | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      canvasRectRef.current = null;
      return null;
    }
    const rect = readCanvasRect(canvas);
    canvasRectRef.current = rect;
    return rect;
  }, []);

  const getCanvasRect = useCallback((): CanvasRectLike | null => {
    return canvasRectRef.current ?? refreshCanvasRect();
  }, [refreshCanvasRect]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize((prev) => {
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        if (prev.w === w && prev.h === h) return prev;
        return { w, h };
      });
      canvasRectRef.current = null;
    };

    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setViewportSize((prev) => {
        const w = Math.max(1, Math.round(box.width));
        const h = Math.max(1, Math.round(box.height));
        if (prev.w === w && prev.h === h) return prev;
        return { w, h };
      });
      canvasRectRef.current = null;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const invalidateRect = () => {
      canvasRectRef.current = null;
    };
    viewport.addEventListener("scroll", invalidateRect, { passive: true });
    window.addEventListener("scroll", invalidateRect, { passive: true });
    window.addEventListener("resize", invalidateRect, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", invalidateRect);
      window.removeEventListener("scroll", invalidateRect);
      window.removeEventListener("resize", invalidateRect);
    };
  }, []);

  const desiredContentHeight = useMemo(() => {
    return computeDesiredHeightPx(draft.strokes, viewportSize.h, value.height || 0);
  }, [draft.strokes, value.height, viewportSize.h]);

  const desiredContentWidth = useMemo(() => {
    const measured = Math.max(0, Math.round(viewportSize.w));
    if (measured >= MIN_VALID_VIEWPORT_PX) return measured;
    const fallback = Number.isFinite(value.width) ? value.width : 0;
    if (fallback >= MIN_VALID_VIEWPORT_PX) return fallback;
    return Math.max(1, measured);
  }, [value.width, viewportSize.w]);

  const redrawBackgroundLayer = useCallback(
    (w = Math.max(1, Math.round(desiredContentWidth)), h = Math.max(1, Math.round(desiredContentHeight))) => {
      const ctx = backgroundCtxRef.current;
      if (!ctx) return;
      redrawPaperBackground(ctx, template, w, h);
    },
    [desiredContentHeight, desiredContentWidth, template],
  );

  const redrawStrokeLayer = useCallback(
    (strokes: InkStroke[], w = Math.max(1, Math.round(desiredContentWidth)), h = Math.max(1, Math.round(desiredContentHeight))) => {
      const ctx = strokeCtxRef.current;
      if (!ctx) return;
      const start = nowMs();
      redrawAll(ctx, strokes, w, h);
      const perf = inkPerfRef.current;
      perf.presentCount += 1;
      perf.presentTimeMs += nowMs() - start;
    },
    [desiredContentHeight, desiredContentWidth],
  );

  // Sync from controlled value when not inking.
  useEffect(() => {
    if (inking) return;
    setDraft(value);
    draftRef.current = value;
    const w = Math.max(1, Math.round(desiredContentWidth));
    const h = Math.max(1, Math.round(desiredContentHeight));
    redrawStrokeLayer(value.strokes, w, h);
  }, [desiredContentHeight, desiredContentWidth, inking, redrawStrokeLayer, value]);

  const commitDraft = useMemo(() => {
    return () => {
      const commitStartedAt = nowMs();
      const raw = draftRef.current;
      const rawWidth = Number.isFinite(raw.width) ? raw.width : 0;
      // When the viewport is being hidden / torn down, ResizeObserver can transiently report 0 width.
      // Avoid committing a bogus width=1 that can later break scaling heuristics.
      const commitWidth =
        desiredContentWidth < MIN_VALID_VIEWPORT_PX && rawWidth >= MIN_VALID_VIEWPORT_PX
          ? rawWidth
          : desiredContentWidth;
      const committed: InkState = {
        ...raw,
        width: commitWidth,
        height: computeDesiredHeightPx(
          raw.strokes,
          viewportSize.h,
          Math.max(
            0,
            Number.isFinite(raw.height) ? raw.height : 0,
            Number.isFinite(value.height) ? value.height : 0,
          ),
        ),
        strokes: [...raw.strokes],
      };
      dirtyRef.current = false;
      draftRef.current = committed;
      if (mountedRef.current) setDraft(committed);
      onChange(committed, true);
      const perf = inkPerfRef.current;
      perf.commitTimeMs += nowMs() - commitStartedAt;
      logInkPerf(perf);
    };
  }, [desiredContentWidth, onChange, value.height, viewportSize.h]);

  // Flush draft when the app is backgrounded / view is torn down.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState === "hidden" && dirtyRef.current) {
        commitDraft();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (dirtyRef.current) commitDraft();
    };
  }, [commitDraft]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // When viewport width changes, scale existing strokes into the new coordinate space.
  useEffect(() => {
    if (inking) return;
    const w = desiredContentWidth;
    if (!w) return;

    const prev = draftRef.current;
    const prevW = Number.isFinite(prev.width) ? prev.width : 0;

    // Ignore transient "collapsed" sizes (e.g., during fullscreen close/unmount) to avoid destructively
    // scaling strokes down to near-zero.
    if (w < MIN_VALID_VIEWPORT_PX) return;

    if (prevW < MIN_VALID_VIEWPORT_PX) {
      const maxX = computeMaxX(prev.strokes);
      const maxY = computeMaxY(prev.strokes);
      const looksNormalized = maxX <= MIN_VALID_VIEWPORT_PX && maxY <= MIN_VALID_VIEWPORT_PX;

      // If the saved ink width is bogus but points are already in px space, just fix the metadata width.
      if (!looksNormalized) {
        const nextHeight = computeDesiredHeightPx(
          prev.strokes,
          viewportSize.h,
          Math.max(0, Number.isFinite(prev.height) ? prev.height : 0),
        );
        const next: InkState = { width: w, height: nextHeight, strokes: [...prev.strokes] };
        setDraft(next);
        draftRef.current = next;
        onChange(next, true);
        redrawStrokeLayer(next.strokes, Math.max(1, Math.round(w)), Math.max(1, Math.round(nextHeight)));
        return;
      }

      // Heal "normalized" strokes (0..1) back into the current viewport coordinate space.
      const safePrevW = Math.max(1, prevW);
      const scale = w / safePrevW;
      if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-6) return;

      const scaled = scaleStrokes(prev.strokes, scale);
      const nextHeight = computeDesiredHeightPx(
        scaled,
        viewportSize.h,
        Math.max(0, (Number.isFinite(prev.height) ? prev.height : 0) * scale),
      );
      const next: InkState = { width: w, height: nextHeight, strokes: scaled };
      setDraft(next);
      draftRef.current = next;
      onChange(next, true);
      redrawStrokeLayer(next.strokes, Math.max(1, Math.round(w)), Math.max(1, Math.round(nextHeight)));
      return;
    }

    if (Math.abs(prevW - w) < 1) return;

    const scale = w / prevW;
    if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-6) return;

    const scaled = scaleStrokes(prev.strokes, scale);
    const nextHeight = computeDesiredHeightPx(
      scaled,
      viewportSize.h,
      Math.max(0, (Number.isFinite(prev.height) ? prev.height : 0) * scale),
    );
    const next: InkState = { width: w, height: nextHeight, strokes: scaled };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
    redrawStrokeLayer(next.strokes, Math.max(1, Math.round(w)), Math.max(1, Math.round(nextHeight)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desiredContentWidth, inking, redrawStrokeLayer, viewportSize.h]);

  // Setup layered canvases: paper/background and visible stroke layer.
  useLayoutEffect(() => {
    const strokeCanvas = canvasRef.current;
    const backgroundCanvas = backgroundCanvasRef.current;
    if (!strokeCanvas || !backgroundCanvas) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, MAX_INK_CANVAS_DPR);
    const w = Math.max(1, Math.round(desiredContentWidth));
    const h = Math.max(1, Math.round(desiredContentHeight));

    backgroundCanvas.width = w * dpr;
    backgroundCanvas.height = h * dpr;
    backgroundCanvas.style.width = `${w}px`;
    backgroundCanvas.style.height = `${h}px`;

    let backgroundCtx = backgroundCanvas.getContext("2d", { alpha: false });
    if (!backgroundCtx) backgroundCtx = backgroundCanvas.getContext("2d");
    if (!backgroundCtx) return;
    backgroundCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    backgroundCtxRef.current = backgroundCtx;

    strokeCanvas.width = w * dpr;
    strokeCanvas.height = h * dpr;
    strokeCanvas.style.width = `${w}px`;
    strokeCanvas.style.height = `${h}px`;

    let strokeCtx = strokeCanvas.getContext("2d", { alpha: true });
    if (!strokeCtx) strokeCtx = strokeCanvas.getContext("2d");
    if (!strokeCtx) return;
    strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strokeCtxRef.current = strokeCtx;

    redrawBackgroundLayer(w, h);
    redrawStrokeLayer(draftRef.current.strokes, w, h);
    canvasRectRef.current = null;
  }, [desiredContentWidth, desiredContentHeight, redrawBackgroundLayer, redrawStrokeLayer]);

  const beginStroke = (p: InkPoint) => {
    const brush = findInkBrushPreset(brushId);
    const strokeTool = brush?.tool ?? tool;
    const strokeSize = Math.max(0.5, penSize * (brush?.sizeScale ?? 1));
    const id = newId("stroke");
    const stroke: InkStroke = {
      id,
      tool: strokeTool,
      color: penColor,
      size: strokeSize,
      brushId: brush?.id,
      opacity: brush?.opacity,
      pressureSensitivity: brush?.pressureSensitivity,
      blendMode: brush?.blendMode,
      lineCap: brush?.lineCap,
      lineJoin: brush?.lineJoin,
      points: [p],
    };
    activeStrokeIdRef.current = id;
    activeStrokeRef.current = stroke;
    activeStrokeStyleRef.current = resolveStrokeStyle(stroke);
    inkPerfRef.current = {
      ...createInkPerfMetrics(),
      strokeStartedAtMs: nowMs(),
      sampleCount: 1,
    };
    const strokeCtx = strokeCtxRef.current;
    if (strokeCtx && activeStrokeStyleRef.current) {
      applyStrokeStyle(strokeCtx, activeStrokeStyleRef.current);
    }
    const prev = draftRef.current;
    const next: InkState = {
      ...prev,
      width: desiredContentWidth,
      height: desiredContentHeight,
      strokes: [...prev.strokes, stroke],
    };
    dirtyRef.current = true;
    draftRef.current = next;
    setDraft(next);
  };

  const appendPoint = (p: InkPoint) => {
    const strokeId = activeStrokeIdRef.current;
    if (!strokeId) return;
    const strokeCtx = strokeCtxRef.current;
    const last = lastPointRef.current;
    const stroke = activeStrokeRef.current;
    if (!stroke || stroke.id !== strokeId) return;

    stroke.points.push(p);
    dirtyRef.current = true;

    const style = activeStrokeStyleRef.current ?? resolveStrokeStyle(stroke);
    activeStrokeStyleRef.current = style;
    if (strokeCtx && last) {
      applyStrokeStyle(strokeCtx, style);
      drawStrokeSegment(strokeCtx, style, last, p);
    }
  };

  const endStroke = () => {
    activeStrokeIdRef.current = null;
    activeStrokeRef.current = null;
    activeStrokeStyleRef.current = null;
    lastPointRef.current = null;
  };

  const endTouchScroll = () => {
    touchScrollRef.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (e.pointerType === "touch") {
      if (drawingRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const viewport = viewportRef.current;
      if (!viewport) return;

      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      touchScrollRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startScrollLeft: viewport.scrollLeft,
        startScrollTop: viewport.scrollTop,
      };
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (disabled) return;

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    e.preventDefault();
    e.stopPropagation();

    const rect = refreshCanvasRect();
    if (!rect) return;
    const p = getPointFromPointerSample(e.nativeEvent, rect);
    drawingRef.current = true;
    setInking(true);
    beginStroke(p);
    lastPointRef.current = p;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const touchScroll = touchScrollRef.current;
    if (touchScroll && touchScroll.pointerId === e.pointerId) {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = touchScroll.startScrollLeft - (e.clientX - touchScroll.startClientX);
      viewport.scrollTop = touchScroll.startScrollTop - (e.clientY - touchScroll.startClientY);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.pointerType === "touch") {
      if (drawingRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (!drawingRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = getCanvasRect();
    if (!rect) return;

    const perf = inkPerfRef.current;
    perf.moveEventCount += 1;

    const sampleStartedAt = nowMs();
    const nativeEvent = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const sampleEvents =
      typeof nativeEvent.getCoalescedEvents === "function"
        ? nativeEvent.getCoalescedEvents()
        : [];
    const sourceEvents = sampleEvents.length > 0 ? sampleEvents : [nativeEvent];
    const points = sourceEvents.map((event) => getPointFromPointerSample(event, rect));
    perf.sampleCount += points.length;
    perf.sampleTimeMs += nowMs() - sampleStartedAt;

    const drawStartedAt = nowMs();
    for (const point of points) {
      const last = lastPointRef.current;
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.5) {
        continue;
      }
      appendPoint(point);
      lastPointRef.current = point;
    }
    perf.drawTimeMs += nowMs() - drawStartedAt;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const touchScroll = touchScrollRef.current;
    if (touchScroll && touchScroll.pointerId === e.pointerId) {
      endTouchScroll();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!drawingRef.current) return;
    drawingRef.current = false;
    setInking(false);
    e.preventDefault();
    e.stopPropagation();
    endStroke();
    if (dirtyRef.current) commitDraft();
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const touchScroll = touchScrollRef.current;
    if (touchScroll && touchScroll.pointerId === e.pointerId) {
      endTouchScroll();
      return;
    }

    if (!drawingRef.current) return;
    drawingRef.current = false;
    setInking(false);
    endStroke();
    // iOS/WKWebView may emit pointercancel for gestures / app backgrounding.
    // Commit to avoid losing the last stroke.
    if (dirtyRef.current) commitDraft();
  };

  const clear = () => {
    if (disabled) return;
    const next: InkState = { width: desiredContentWidth, height: desiredContentHeight, strokes: [] };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
    redrawStrokeLayer(next.strokes, Math.max(1, Math.round(desiredContentWidth)), Math.max(1, Math.round(desiredContentHeight)));
  };

  const undo = () => {
    if (disabled) return;
    const nextStrokes = draft.strokes.slice(0, Math.max(0, draft.strokes.length - 1));
    const next: InkState = { ...draft, width: desiredContentWidth, height: desiredContentHeight, strokes: nextStrokes };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
    redrawStrokeLayer(next.strokes, Math.max(1, Math.round(desiredContentWidth)), Math.max(1, Math.round(desiredContentHeight)));
  };

  return (
    <div className={cx("relative h-full w-full", className)}>
      <div
        ref={viewportRef}
        className={cx(
          "h-full w-full overflow-y-auto overscroll-contain rounded-lg border border-black/10",
          viewportClassName,
        )}
        style={{ WebkitOverflowScrolling: "touch" } as any}
      >
        <div
          className={cx("relative w-full", contentClassName)}
          style={{ height: `${desiredContentHeight}px` }}
        >
          <canvas
            ref={backgroundCanvasRef}
            aria-hidden="true"
            className="absolute inset-0 block pointer-events-none"
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 block"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            // Disable native touch scrolling on canvas so pen/palm gestures never drag the outer page.
            // Finger scrolling is handled by updating the internal viewport scroll position.
            style={{ backgroundColor: "transparent", touchAction: "none" }}
          />
        </div>
      </div>

      <div className="absolute right-2 top-2 flex items-center gap-2">
        <button
          type="button"
          className="h-8 px-2 rounded-md bg-black/5 hover:bg-black/10 text-xs text-black/80"
          onClick={undo}
          disabled={disabled || draft.strokes.length === 0}
          title="撤销"
        >
          撤销
        </button>
        <button
          type="button"
          className="h-8 px-2 rounded-md bg-black/5 hover:bg-black/10 text-xs text-black/80"
          onClick={clear}
          disabled={disabled || draft.strokes.length === 0}
          title="清空"
        >
          清空
        </button>
      </div>
    </div>
  );
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
