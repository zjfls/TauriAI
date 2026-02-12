import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InkPoint, InkState, InkStroke } from "../types";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
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
  scaleX: number,
  scaleY: number,
): InkStroke[] {
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return strokes;
  if (Math.abs(scaleX - 1) < 1e-6 && Math.abs(scaleY - 1) < 1e-6) return strokes;
  return strokes.map((s) => ({
    ...s,
    size: s.size * Math.max(scaleX, scaleY),
    points: s.points.map((p) => ({ ...p, x: p.x * scaleX, y: p.y * scaleY })),
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
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
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
  penColor = "#111827",
  penSize = 3,
  disabled,
}: ScrollableInkPadProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<InkPoint | null>(null);
  const activeStrokeIdRef = useRef<string | null>(null);

  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [inking, setInking] = useState(false);

  const [draft, setDraft] = useState<InkState>(value);
  const draftRef = useRef<InkState>(value);

  // Sync from controlled value when not inking.
  useEffect(() => {
    if (inking) return;
    setDraft(value);
    draftRef.current = value;
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

  // When viewport size changes, scale existing strokes into the new coordinate space.
  useEffect(() => {
    if (inking) return;
    const w = desiredContentWidth;
    const h = desiredContentHeight;
    if (!w || !h) return;
    const prevW = value.width || w;
    const prevH = value.height || h;
    const needScale = Math.abs(prevW - w) >= 1 || Math.abs(prevH - h) >= 1;
    if (!needScale) return;
    const sx = w / prevW;
    const sy = h / prevH;
    const scaled = scaleStrokes(value.strokes, sx, sy);
    const next: InkState = { width: w, height: h, strokes: scaled };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desiredContentWidth, desiredContentHeight]);

  // Setup canvas devicePixelRatio scaling.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(desiredContentWidth));
    const h = Math.max(1, Math.round(desiredContentHeight));

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxRef.current = ctx;

    redrawAll(ctx, draftRef.current.strokes, w, h);
  }, [desiredContentWidth, desiredContentHeight]);

  // Re-draw on committed draft change.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const w = Math.max(1, Math.round(desiredContentWidth));
    const h = Math.max(1, Math.round(desiredContentHeight));
    redrawAll(ctx, draft.strokes, w, h);
  }, [draft.strokes, desiredContentWidth, desiredContentHeight]);

  const templateBg = useMemo(() => {
    if (template === "grid") {
      return {
        backgroundColor: "white",
        backgroundImage:
          "linear-gradient(to right, rgba(17,24,39,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(17,24,39,0.08) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      } as React.CSSProperties;
    }
    if (template === "ruled") {
      return {
        backgroundColor: "white",
        backgroundImage: "linear-gradient(to bottom, rgba(17,24,39,0.10) 1px, transparent 1px)",
        backgroundSize: "100% 28px",
      } as React.CSSProperties;
    }
    return { backgroundColor: "white" } as React.CSSProperties;
  }, [template]);

  const beginStroke = (p: InkPoint) => {
    const id = newId("stroke");
    const stroke: InkStroke = {
      id,
      tool: "pen",
      color: penColor,
      size: penSize,
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
    draftRef.current = next;
    setDraft(next);
  };

  const appendPoint = (p: InkPoint) => {
    const strokeId = activeStrokeIdRef.current;
    if (!strokeId) return;
    const ctx = ctxRef.current;
    const last = lastPointRef.current;

    const nextState = draftRef.current;
    const idx = nextState.strokes.findIndex((s) => s.id === strokeId);
    if (idx < 0) return;

    const stroke = nextState.strokes[idx]!;
    stroke.points.push(p);

    if (ctx && last) {
      drawStrokeSegment(ctx, stroke, last, p);
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

    const raw = draftRef.current;
    const committed: InkState = {
      ...raw,
      width: desiredContentWidth,
      height: computeDesiredHeightPx(raw.strokes, viewportSize.h, Math.max(value.height || 0, raw.height || 0)),
      strokes: [...raw.strokes],
    };
    draftRef.current = committed;
    setDraft(committed);
    onChange(committed, true);
  };

  const onPointerCancel = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setInking(false);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.touchAction = "pan-y";
    endStroke();
    // Do not commit on cancel.
  };

  const clear = () => {
    if (disabled) return;
    const next: InkState = { width: desiredContentWidth, height: desiredContentHeight, strokes: [] };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
  };

  const undo = () => {
    if (disabled) return;
    const nextStrokes = draft.strokes.slice(0, Math.max(0, draft.strokes.length - 1));
    const next: InkState = { ...draft, width: desiredContentWidth, height: desiredContentHeight, strokes: nextStrokes };
    setDraft(next);
    draftRef.current = next;
    onChange(next, true);
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
          style={{ height: `${desiredContentHeight}px`, ...templateBg }}
        >
          <canvas
            ref={canvasRef}
            className="block"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            // Let finger pan vertically when not writing; we toggle to `none` during pen write.
            style={{ touchAction: inking ? "none" : "pan-y" }}
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
