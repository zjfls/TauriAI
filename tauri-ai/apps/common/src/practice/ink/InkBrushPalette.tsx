import { useEffect, useRef } from "react";
import type { InkStroke } from "../types";
import type { InkBrushPreset } from "./brushes";
import { drawInkStroke, PAPER_COLOR } from "./rendering";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildPreviewStroke(
  brush: InkBrushPreset,
  color: string,
  width: number,
  height: number,
): InkStroke {
  const marginX = 8;
  const usableWidth = Math.max(12, width - marginX * 2);
  const centerY = height * 0.56;
  const isDiagonal =
    brush.tipProfile === "brush_calligraphy" ||
    brush.tipProfile === "marker_chisel" ||
    brush.tipProfile === "highlighter";
  const isTextured =
    brush.tipProfile === "pencil_hard" ||
    brush.tipProfile === "pencil_soft" ||
    brush.tipProfile === "charcoal_dry" ||
    brush.tipProfile === "brush_gouache" ||
    brush.tipProfile === "spray_soft";
  const count = brush.tipProfile === "spray_soft" ? 12 : 9;
  const points = Array.from({ length: count }, (_, index) => {
    const t = count <= 1 ? 0 : index / (count - 1);
    const arc = Math.sin(t * Math.PI) * height * (isTextured ? 0.16 : 0.12);
    const diagonal = isDiagonal ? (t - 0.5) * height * 0.24 : (t - 0.5) * height * 0.08;
    const wobble = isTextured ? Math.sin(t * Math.PI * 2) * height * 0.04 : 0;
    return {
      x: marginX + usableWidth * t,
      y: centerY - arc + diagonal + wobble,
      t: index,
      pressure:
        brush.tipProfile === "highlighter"
          ? 0.68
          : clamp(0.32 + Math.sin(t * Math.PI) * 0.58, 0.2, 1),
    };
  });

  return {
    id: `preview:${brush.id}:${color}`,
    tool: brush.tool,
    color,
    size: clamp(4.6 * brush.sizeScale, 2.5, brush.tipProfile === "highlighter" ? 16 : 12),
    opacity: brush.opacity,
    pressureSensitivity: brush.pressureSensitivity,
    blendMode: brush.blendMode,
    lineCap: brush.lineCap,
    lineJoin: brush.lineJoin,
    brushId: brush.id,
    points,
  };
}

export type InkBrushPreviewProps = {
  brush: InkBrushPreset;
  color?: string;
  className?: string;
  width?: number;
  height?: number;
};

export function InkBrushPreview({
  brush,
  color = "#111827",
  className,
  width = 60,
  height = 26,
}: InkBrushPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, width, height);
    drawInkStroke(ctx, buildPreviewStroke(brush, color, width, height));
  }, [brush, color, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className={cx("rounded-md border border-black/5 bg-[#f6efdb]", className)}
      aria-hidden="true"
    />
  );
}

export type InkBrushPaletteProps = {
  brushes: InkBrushPreset[];
  selectedBrushId: string;
  onSelect: (brushId: string) => void;
  color?: string;
  className?: string;
  compact?: boolean;
};

export function InkBrushPalette({
  brushes,
  selectedBrushId,
  onSelect,
  color = "#111827",
  className,
  compact = false,
}: InkBrushPaletteProps) {
  return (
    <div
      className={cx(
        "flex items-stretch gap-2 overflow-x-auto pb-1 scrollbar-hidden",
        className,
      )}
      role="radiogroup"
      aria-label="选择笔刷"
    >
      {brushes.map((brush) => {
        const selected = brush.id === selectedBrushId;
        return (
          <button
            key={brush.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={brush.label}
            className={cx(
              "shrink-0 rounded-xl border text-left transition-colors",
              compact ? "w-[78px] p-2" : "w-[96px] p-2.5",
              selected
                ? "border-indigo-400 bg-indigo-50 text-indigo-700 shadow-[0_0_0_1px_rgba(129,140,248,0.18)] dark:bg-indigo-500/15 dark:text-indigo-100"
                : "border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 dark:border-gray-700 dark:bg-gray-900/70 dark:text-gray-100 dark:hover:border-indigo-400/40 dark:hover:bg-gray-800/80",
            )}
            onClick={() => onSelect(brush.id)}
          >
            <InkBrushPreview
              brush={brush}
              color={color}
              width={compact ? 56 : 72}
              height={compact ? 22 : 28}
              className="w-full"
            />
            <div
              className={cx(
                "mt-1 truncate text-center font-medium",
                compact ? "text-[11px]" : "text-xs",
              )}
            >
              {brush.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}
