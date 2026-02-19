import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

function getPointFromEvent(
  e: React.PointerEvent<HTMLCanvasElement>,
  rect: DOMRect,
): InkPoint {
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const tiltX = typeof e.tiltX === "number" ? e.tiltX : undefined;
  const tiltY = typeof e.tiltY === "number" ? e.tiltY : undefined;
  const pressure = typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : undefined;
  const twist = typeof (e as any).twist === "number" ? (e as any).twist : undefined;
  return { x, y, t: Date.now(), pressure, tiltX, tiltY, twist };
}

function drawStrokeSegment(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  a: InkPoint,
  b: InkPoint,
) {
  const brush = findInkBrushPreset(stroke.brushId);
  const pressureSensitivity = clamp(stroke.pressureSensitivity ?? brush?.pressureSensitivity ?? 0, 0, 1);
  const opacity = clamp(stroke.opacity ?? brush?.opacity ?? (stroke.tool === "pencil" ? 0.65 : 1), 0.05, 1);
  const lineCap = stroke.lineCap ?? brush?.lineCap ?? "round";
  const lineJoin = stroke.lineJoin ?? brush?.lineJoin ?? "round";
  const blendMode = stroke.blendMode ?? brush?.blendMode ?? "source-over";
  const baseSize = clamp(stroke.size, 0.5, 64);
  const rawPressure =
    (typeof b.pressure === "number" && b.pressure > 0 ? b.pressure : undefined) ??
    (typeof a.pressure === "number" && a.pressure > 0 ? a.pressure : undefined) ??
    0.5;
  const pressure = clamp(rawPressure, 0.1, 1);
  const width =
    stroke.tool === "eraser"
      ? baseSize
      : Math.max(0.5, baseSize * (1 - pressureSensitivity + pressureSensitivity * pressure));

  ctx.save();
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.globalAlpha = 1;
  } else {
    ctx.globalCompositeOperation = blendMode;
    ctx.strokeStyle = typeof stroke.color === "string" && stroke.color.trim() ? stroke.color : "#111827";
    ctx.globalAlpha = opacity;
  }
  ctx.lineWidth = width;
  ctx.lineCap = lineCap;
  ctx.lineJoin = lineJoin;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
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
    for (let i = 1; i < pts.length; i += 1) {
      drawStrokeSegment(ctx, s, pts[i - 1]!, pts[i]!);
    }
  }
}

const PAPER_COLOR = "#f6efdb";

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
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const strokeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  const lastPointRef = useRef<InkPoint | null>(null);
  const activeStrokeIdRef = useRef<string | null>(null);
  const presentRafRef = useRef<number | null>(null);

  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [inking, setInking] = useState(false);

  const [draft, setDraft] = useState<InkState>(value);
  const draftRef = useRef<InkState>(value);

  // Sync from controlled value when not inking.
  useEffect(() => {
    if (inking) return;
    setDraft(value);
    draftRef.current = value;
    const strokeCtx = strokeCtxRef.current;
    if (strokeCtx) {
      const w = Math.max(1, Math.round(desiredContentWidth));
      const h = Math.max(1, Math.round(desiredContentHeight));
      redrawAll(strokeCtx, value.strokes, w, h);
      schedulePresent();
    }
  }, [inking, value]);

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

  const desiredContentHeight = useMemo(() => {
    return computeDesiredHeightPx(draft.strokes, viewportSize.h, value.height || 0);
  }, [draft.strokes, value.height, viewportSize.h]);

  const desiredContentWidth = useMemo(() => Math.max(1, viewportSize.w), [viewportSize.w]);

  const presentComposite = useMemo(() => {
    return () => {
      const ctx = ctxRef.current;
      const strokeCanvas = strokeCanvasRef.current;
      if (!ctx || !strokeCanvas) return;

      const w = Math.max(1, Math.round(desiredContentWidth));
      const h = Math.max(1, Math.round(desiredContentHeight));
      redrawPaperBackground(ctx, template, w, h);
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.drawImage(strokeCanvas, 0, 0, w, h);
      ctx.restore();
    };
  }, [desiredContentHeight, desiredContentWidth, template]);

  const schedulePresent = useMemo(() => {
    return () => {
      if (typeof requestAnimationFrame === "undefined") {
        presentComposite();
        return;
      }
      if (presentRafRef.current != null) return;
      presentRafRef.current = requestAnimationFrame(() => {
        presentRafRef.current = null;
        presentComposite();
      });
    };
  }, [presentComposite]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (presentRafRef.current != null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(presentRafRef.current);
      }
    };
  }, []);

  const commitDraft = useMemo(() => {
    return () => {
      const raw = draftRef.current;
      const committed: InkState = {
        ...raw,
        width: desiredContentWidth,
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

  // When viewport width changes, scale existing strokes into the new coordinate space.
  useEffect(() => {
    if (inking) return;
    const w = desiredContentWidth;
    if (!w) return;

    const prev = draftRef.current;
    const prevW = Number.isFinite(prev.width) ? prev.width : 0;
    const safePrevW = prevW >= 50 ? prevW : w;
    if (Math.abs(safePrevW - w) < 1) return;

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
    const strokeCtx = strokeCtxRef.current;
    if (strokeCtx) {
      redrawAll(strokeCtx, next.strokes, Math.max(1, Math.round(w)), Math.max(1, Math.round(nextHeight)));
      schedulePresent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desiredContentWidth, inking, viewportSize.h]);

  // Setup canvas devicePixelRatio scaling.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(desiredContentWidth));
    const h = Math.max(1, Math.round(desiredContentHeight));

    if (!strokeCanvasRef.current && typeof document !== "undefined") {
      strokeCanvasRef.current = document.createElement("canvas");
    }
    const strokeCanvas = strokeCanvasRef.current;
    if (!strokeCanvas) return;

    strokeCanvas.width = w * dpr;
    strokeCanvas.height = h * dpr;
    let strokeCtx = strokeCanvas.getContext("2d", { alpha: true });
    if (!strokeCtx) strokeCtx = strokeCanvas.getContext("2d");
    if (!strokeCtx) return;
    strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strokeCtxRef.current = strokeCtx;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    let ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxRef.current = ctx;

    redrawAll(strokeCtx, draftRef.current.strokes, w, h);
    presentComposite();
  }, [desiredContentWidth, desiredContentHeight, presentComposite]);

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

    const nextState = draftRef.current;
    const idx = nextState.strokes.findIndex((s) => s.id === strokeId);
    if (idx < 0) return;

    const stroke = nextState.strokes[idx]!;
    stroke.points.push(p);
    dirtyRef.current = true;

    if (strokeCtx && last) {
      drawStrokeSegment(strokeCtx, stroke, last, p);
      schedulePresent();
    }
  };

  const endStroke = () => {
    activeStrokeIdRef.current = null;
    lastPointRef.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    // Finger scrolls; pen/mouse writes.
    if (e.pointerType === "touch") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    canvas.style.touchAction = "none";
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const p = getPointFromEvent(e, rect);
    drawingRef.current = true;
    setInking(true);
    beginStroke(p);
    lastPointRef.current = p;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const p = getPointFromEvent(e, rect);
    const last = lastPointRef.current;
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return;
    appendPoint(p);
    lastPointRef.current = p;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setInking(false);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.touchAction = "pan-y";
    e.preventDefault();
    endStroke();
    if (dirtyRef.current) commitDraft();
  };

  const onPointerCancel = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setInking(false);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.touchAction = "pan-y";
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
    const strokeCtx = strokeCtxRef.current;
    if (strokeCtx) {
      redrawAll(strokeCtx, next.strokes, Math.max(1, Math.round(desiredContentWidth)), Math.max(1, Math.round(desiredContentHeight)));
      schedulePresent();
    }
  };

  const undo = () => {
    if (disabled) return;
    const nextStrokes = draft.strokes.slice(0, Math.max(0, draft.strokes.length - 1));
    const next: InkState = { ...draft, width: desiredContentWidth, height: desiredContentHeight, strokes: nextStrokes };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
    const strokeCtx = strokeCtxRef.current;
    if (strokeCtx) {
      redrawAll(strokeCtx, next.strokes, Math.max(1, Math.round(desiredContentWidth)), Math.max(1, Math.round(desiredContentHeight)));
      schedulePresent();
    }
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
            ref={canvasRef}
            className="relative block"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            // Let finger pan vertically when not writing; we toggle to `none` during pen write.
            style={{ backgroundColor: "transparent", touchAction: inking ? "none" : "pan-y" }}
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
