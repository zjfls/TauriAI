import type { InkToolKind } from "../types";

export type InkBrushBlendMode = "source-over" | "multiply";
export type InkBrushLineCap = "round" | "butt" | "square";
export type InkBrushLineJoin = "round" | "bevel" | "miter";

export type InkBrushPreset = {
  id: string;
  label: string;
  tool: InkToolKind;
  sizeScale: number;
  opacity: number;
  pressureSensitivity: number;
  blendMode: InkBrushBlendMode;
  lineCap: InkBrushLineCap;
  lineJoin: InkBrushLineJoin;
};

export const INK_BRUSH_PRESETS: InkBrushPreset[] = [
  {
    id: "pen_smooth",
    label: "流畅钢笔",
    tool: "pen",
    sizeScale: 1,
    opacity: 1,
    pressureSensitivity: 0.22,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "pen_ballpoint",
    label: "圆珠笔",
    tool: "pen",
    sizeScale: 0.9,
    opacity: 1,
    pressureSensitivity: 0.02,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "pen_monoline",
    label: "单线笔",
    tool: "pen",
    sizeScale: 1.02,
    opacity: 1,
    pressureSensitivity: 0,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "pen_fineliner",
    label: "针管笔",
    tool: "pen",
    sizeScale: 0.78,
    opacity: 1,
    pressureSensitivity: 0.08,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "brush_calligraphy",
    label: "书写笔刷",
    tool: "pen",
    sizeScale: 1.35,
    opacity: 0.95,
    pressureSensitivity: 0.72,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "marker_soft",
    label: "马克笔",
    tool: "pen",
    sizeScale: 1.65,
    opacity: 0.82,
    pressureSensitivity: 0.05,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "highlighter",
    label: "荧光笔",
    tool: "pen",
    sizeScale: 2.6,
    opacity: 0.3,
    pressureSensitivity: 0,
    blendMode: "multiply",
    lineCap: "square",
    lineJoin: "round",
  },
  {
    id: "pencil_hard",
    label: "硬铅笔",
    tool: "pencil",
    sizeScale: 0.8,
    opacity: 0.52,
    pressureSensitivity: 0.16,
    blendMode: "source-over",
    lineCap: "butt",
    lineJoin: "miter",
  },
  {
    id: "pencil_soft",
    label: "软铅笔",
    tool: "pencil",
    sizeScale: 1.1,
    opacity: 0.58,
    pressureSensitivity: 0.42,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
  {
    id: "eraser_soft",
    label: "柔边橡皮",
    tool: "eraser",
    sizeScale: 1.6,
    opacity: 1,
    pressureSensitivity: 0,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
  },
];

export const DEFAULT_INK_BRUSH_ID = INK_BRUSH_PRESETS[0]?.id ?? "pen_smooth";

const PRESET_BY_ID = new Map(INK_BRUSH_PRESETS.map((preset) => [preset.id, preset] as const));

export function findInkBrushPreset(brushId: string | undefined | null): InkBrushPreset | undefined {
  if (!brushId) return undefined;
  return PRESET_BY_ID.get(brushId);
}
