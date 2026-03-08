import type { InkToolKind } from "../types";

export type InkBrushBlendMode = "source-over" | "multiply";
export type InkBrushLineCap = "round" | "butt" | "square";
export type InkBrushLineJoin = "round" | "bevel" | "miter";
export type InkBrushTipShape =
  | "round"
  | "marker"
  | "chisel"
  | "pencil"
  | "charcoal"
  | "spray";
export type InkBrushTipProfile =
  | "pen_smooth"
  | "pen_fineliner"
  | "pen_monoline"
  | "brush_calligraphy"
  | "marker_soft"
  | "marker_chisel"
  | "highlighter"
  | "pencil_hard"
  | "pencil_soft"
  | "brush_gouache"
  | "charcoal_dry"
  | "spray_soft"
  | "eraser_soft"
  | "eraser_hard";
export type InkBrushRotationMode = "none" | "direction" | "tilt";
export type InkBrushTextureKind =
  | "none"
  | "grain"
  | "dry"
  | "chalk"
  | "speckle";

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
  tipShape: InkBrushTipShape;
  tipProfile: InkBrushTipProfile;
  rotationMode: InkBrushRotationMode;
  textureKind: InkBrushTextureKind;
  spacing: number;
  hardness: number;
  flow: number;
  aspectRatio: number;
  angle: number;
  scatter: number;
  jitter: number;
  textureStrength: number;
  pressureToOpacity: number;
  stampNoise: number;
};

function defineBrushPreset(
  preset: Pick<
    InkBrushPreset,
    | "id"
    | "label"
    | "tool"
    | "sizeScale"
    | "opacity"
    | "pressureSensitivity"
    | "blendMode"
    | "lineCap"
    | "lineJoin"
  > &
    Partial<
      Pick<
        InkBrushPreset,
        | "tipShape"
        | "tipProfile"
        | "rotationMode"
        | "textureKind"
        | "spacing"
        | "hardness"
        | "flow"
        | "aspectRatio"
        | "angle"
        | "scatter"
        | "jitter"
        | "textureStrength"
        | "pressureToOpacity"
        | "stampNoise"
      >
    >,
): InkBrushPreset {
  return {
    tipShape: "round",
    tipProfile: "pen_smooth",
    rotationMode: "none",
    textureKind: "none",
    spacing: 0.2,
    hardness: 0.82,
    flow: 1,
    aspectRatio: 1,
    angle: 0,
    scatter: 0,
    jitter: 0,
    textureStrength: 0,
    pressureToOpacity: 0,
    stampNoise: 0,
    ...preset,
  };
}

export const INK_BRUSH_PRESETS: InkBrushPreset[] = [
  defineBrushPreset({
    id: "pen_smooth",
    label: "流畅钢笔",
    tool: "pen",
    sizeScale: 1,
    opacity: 1,
    pressureSensitivity: 0.2,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "round",
    tipProfile: "pen_smooth",
    spacing: 0.16,
    hardness: 0.96,
    flow: 1,
    pressureToOpacity: 0.08,
  }),
  defineBrushPreset({
    id: "pen_fineliner",
    label: "针管笔",
    tool: "pen",
    sizeScale: 0.72,
    opacity: 1,
    pressureSensitivity: 0.06,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "round",
    tipProfile: "pen_fineliner",
    spacing: 0.12,
    hardness: 0.98,
    flow: 1,
    pressureToOpacity: 0.02,
  }),
  defineBrushPreset({
    id: "pen_monoline",
    label: "单线笔",
    tool: "pen",
    sizeScale: 1,
    opacity: 1,
    pressureSensitivity: 0,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "round",
    tipProfile: "pen_monoline",
    spacing: 0.14,
    hardness: 0.95,
    flow: 1,
  }),
  defineBrushPreset({
    id: "brush_calligraphy",
    label: "书法笔",
    tool: "pen",
    sizeScale: 1.28,
    opacity: 0.96,
    pressureSensitivity: 0.82,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "chisel",
    tipProfile: "brush_calligraphy",
    rotationMode: "direction",
    spacing: 0.075,
    hardness: 0.82,
    flow: 0.95,
    aspectRatio: 2.35,
    angle: 20,
    jitter: 0.003,
    pressureToOpacity: 0.16,
    stampNoise: 0.012,
  }),
  defineBrushPreset({
    id: "marker_soft",
    label: "马克笔",
    tool: "pen",
    sizeScale: 1.55,
    opacity: 0.82,
    pressureSensitivity: 0.08,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "marker",
    tipProfile: "marker_soft",
    rotationMode: "direction",
    spacing: 0.11,
    hardness: 0.76,
    flow: 0.78,
    aspectRatio: 1.5,
    angle: 14,
    textureKind: "dry",
    textureStrength: 0.08,
    pressureToOpacity: 0.08,
    stampNoise: 0.03,
  }),
  defineBrushPreset({
    id: "marker_chisel",
    label: "斜头马克笔",
    tool: "pen",
    sizeScale: 1.72,
    opacity: 0.86,
    pressureSensitivity: 0.06,
    blendMode: "source-over",
    lineCap: "square",
    lineJoin: "round",
    tipShape: "chisel",
    tipProfile: "marker_chisel",
    rotationMode: "none",
    spacing: 0.06,
    hardness: 0.74,
    flow: 0.84,
    aspectRatio: 2.2,
    angle: 28,
    textureKind: "none",
    textureStrength: 0,
    stampNoise: 0.02,
  }),
  defineBrushPreset({
    id: "highlighter",
    label: "荧光笔",
    tool: "pen",
    sizeScale: 2.5,
    opacity: 0.34,
    pressureSensitivity: 0,
    blendMode: "multiply",
    lineCap: "square",
    lineJoin: "round",
    tipShape: "marker",
    tipProfile: "highlighter",
    rotationMode: "none",
    spacing: 0.05,
    hardness: 0.62,
    flow: 0.56,
    aspectRatio: 2.8,
    angle: 12,
    pressureToOpacity: 0,
  }),
  defineBrushPreset({
    id: "pencil_hard",
    label: "硬铅笔",
    tool: "pencil",
    sizeScale: 0.84,
    opacity: 0.64,
    pressureSensitivity: 0.2,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "pencil",
    tipProfile: "pencil_hard",
    rotationMode: "direction",
    spacing: 0.11,
    hardness: 0.72,
    flow: 0.68,
    aspectRatio: 1.08,
    textureKind: "grain",
    textureStrength: 0.42,
    jitter: 0.04,
    pressureToOpacity: 0.16,
    stampNoise: 0.18,
  }),
  defineBrushPreset({
    id: "pencil_soft",
    label: "软铅笔",
    tool: "pencil",
    sizeScale: 1.08,
    opacity: 0.7,
    pressureSensitivity: 0.44,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "pencil",
    tipProfile: "pencil_soft",
    rotationMode: "direction",
    spacing: 0.1,
    hardness: 0.56,
    flow: 0.62,
    aspectRatio: 1.14,
    textureKind: "grain",
    textureStrength: 0.74,
    jitter: 0.05,
    pressureToOpacity: 0.24,
    stampNoise: 0.24,
  }),
  defineBrushPreset({
    id: "brush_gouache",
    label: "厚涂笔",
    tool: "pen",
    sizeScale: 1.42,
    opacity: 0.88,
    pressureSensitivity: 0.36,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "marker",
    tipProfile: "brush_gouache",
    rotationMode: "direction",
    spacing: 0.13,
    hardness: 0.58,
    flow: 0.76,
    aspectRatio: 1.24,
    textureKind: "dry",
    textureStrength: 0.34,
    jitter: 0.06,
    pressureToOpacity: 0.18,
    stampNoise: 0.16,
  }),
  defineBrushPreset({
    id: "charcoal_dry",
    label: "炭笔",
    tool: "pencil",
    sizeScale: 1.36,
    opacity: 0.62,
    pressureSensitivity: 0.52,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "charcoal",
    tipProfile: "charcoal_dry",
    rotationMode: "direction",
    spacing: 0.08,
    hardness: 0.34,
    flow: 0.5,
    aspectRatio: 1.38,
    textureKind: "chalk",
    textureStrength: 0.92,
    scatter: 0.06,
    jitter: 0.18,
    pressureToOpacity: 0.28,
    stampNoise: 0.42,
  }),
  defineBrushPreset({
    id: "spray_soft",
    label: "喷笔",
    tool: "pen",
    sizeScale: 1.42,
    opacity: 0.52,
    pressureSensitivity: 0.08,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "spray",
    tipProfile: "spray_soft",
    spacing: 0.16,
    hardness: 0.2,
    flow: 0.52,
    textureKind: "speckle",
    textureStrength: 0.72,
    scatter: 0.34,
    jitter: 0.1,
    pressureToOpacity: 0.12,
    stampNoise: 0.12,
  }),
  defineBrushPreset({
    id: "eraser_soft",
    label: "柔边橡皮",
    tool: "eraser",
    sizeScale: 1.6,
    opacity: 1,
    pressureSensitivity: 0,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "round",
    tipProfile: "eraser_soft",
    spacing: 0.12,
    hardness: 0.28,
    flow: 1,
  }),
  defineBrushPreset({
    id: "eraser_hard",
    label: "硬边橡皮",
    tool: "eraser",
    sizeScale: 1.22,
    opacity: 1,
    pressureSensitivity: 0,
    blendMode: "source-over",
    lineCap: "round",
    lineJoin: "round",
    tipShape: "marker",
    tipProfile: "eraser_hard",
    spacing: 0.1,
    hardness: 0.88,
    flow: 1,
    aspectRatio: 1.12,
  }),
];

export const DEFAULT_INK_BRUSH_ID = INK_BRUSH_PRESETS[0]?.id ?? "pen_smooth";

const PRESET_BY_ID = new Map(INK_BRUSH_PRESETS.map((preset) => [preset.id, preset] as const));

export function findInkBrushPreset(
  brushId: string | undefined | null,
): InkBrushPreset | undefined {
  if (!brushId) return undefined;
  return PRESET_BY_ID.get(brushId);
}

export function getInkBrushMenuLabel(preset: InkBrushPreset): string {
  switch (preset.tipProfile) {
    case "pen_smooth":
    case "pen_monoline":
      return `圆·${preset.label}`;
    case "pen_fineliner":
      return `细·${preset.label}`;
    case "brush_calligraphy":
    case "marker_chisel":
      return `斜·${preset.label}`;
    case "marker_soft":
    case "highlighter":
    case "brush_gouache":
      return `平·${preset.label}`;
    case "pencil_hard":
    case "pencil_soft":
      return `铅·${preset.label}`;
    case "charcoal_dry":
      return `炭·${preset.label}`;
    case "spray_soft":
      return `喷·${preset.label}`;
    case "eraser_soft":
      return `柔橡·${preset.label}`;
    case "eraser_hard":
      return `硬橡·${preset.label}`;
  }
}
