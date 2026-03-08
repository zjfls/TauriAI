import type { InkPoint, InkState, InkStroke } from "../types";
import {
  findInkBrushPreset,
  type InkBrushPreset,
  type InkBrushRotationMode,
  type InkBrushTextureKind,
  type InkBrushTipProfile,
  type InkBrushTipShape,
} from "./brushes";

export type InkBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type InkPaperTemplate = "blank" | "ruled" | "grid";

export type InkStrokeRuntime = {
  style: ResolvedInkBrushStyle;
  carry: number;
  stampIndex: number;
  seed: number;
  lastAngleRad: number;
  flatNibSweep: boolean;
};

type Point2D = {
  x: number;
  y: number;
};

type ResolvedInkBrushStyle = {
  brush: InkBrushPreset;
  isEraser: boolean;
  compositeOperation: GlobalCompositeOperation;
  color: string;
  baseAlpha: number;
  baseSize: number;
  pressureSensitivity: number;
  spacingPx: number;
  hardness: number;
  flow: number;
  aspectRatio: number;
  baseAngleRad: number;
  rotationMode: InkBrushRotationMode;
  tipShape: InkBrushTipShape;
  tipProfile: InkBrushTipProfile;
  textureKind: InkBrushTextureKind;
  textureStrength: number;
  scatterPx: number;
  jitterPx: number;
  pressureToOpacity: number;
  stampNoise: number;
};

const MAX_STROKE_SIZE = 64;
const TIP_CANVAS_SIZE = 96;
export const PAPER_COLOR = "#f6efdb";

const TIP_CACHE = new Map<string, HTMLCanvasElement>();

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hash01(seed: number, index: number, salt: number): number {
  const value = Math.sin(seed * 0.00037 + index * 12.9898 + salt * 78.233) * 43758.5453123;
  return value - Math.floor(value);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolatePoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    t: Math.round(lerp(a.t, b.t, t)),
    pressure:
      typeof a.pressure === "number" || typeof b.pressure === "number"
        ? lerp(a.pressure ?? 0.5, b.pressure ?? 0.5, t)
        : undefined,
    tiltX:
      typeof a.tiltX === "number" || typeof b.tiltX === "number"
        ? lerp(a.tiltX ?? 0, b.tiltX ?? 0, t)
        : undefined,
    tiltY:
      typeof a.tiltY === "number" || typeof b.tiltY === "number"
        ? lerp(a.tiltY ?? 0, b.tiltY ?? 0, t)
        : undefined,
    twist:
      typeof a.twist === "number" || typeof b.twist === "number"
        ? lerp(a.twist ?? 0, b.twist ?? 0, t)
        : undefined,
  };
}

function parseCssColor(color: string): { r: number; g: number; b: number } {
  const input = color.trim();
  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const raw = hex[1]!.toLowerCase();
    if (raw.length === 3) {
      return {
        r: parseInt(raw[0]! + raw[0]!, 16),
        g: parseInt(raw[1]! + raw[1]!, 16),
        b: parseInt(raw[2]! + raw[2]!, 16),
      };
    }
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }

  const rgb = input.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i,
  );
  if (rgb) {
    return {
      r: clamp(Number(rgb[1]), 0, 255),
      g: clamp(Number(rgb[2]), 0, 255),
      b: clamp(Number(rgb[3]), 0, 255),
    };
  }

  return { r: 17, g: 24, b: 39 };
}

function tipEdgeAlpha(distance: number, hardness: number): number {
  if (distance >= 1) return 0;
  const edgeStart = clamp(hardness, 0.04, 0.98);
  if (distance <= edgeStart) return 1;
  const t = clamp((distance - edgeStart) / Math.max(0.02, 1 - edgeStart), 0, 1);
  const eased = 1 - t * t * (3 - 2 * t);
  return clamp(eased, 0, 1);
}

function ellipseDistance(x: number, y: number, radiusX: number, radiusY: number): number {
  return Math.sqrt((x / radiusX) ** 2 + (y / radiusY) ** 2);
}

function superEllipseDistance(
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  power: number,
): number {
  return (
    Math.abs(x / radiusX) ** power + Math.abs(y / radiusY) ** power
  ) ** (1 / power);
}

function roundRectDistance(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const innerWidth = Math.max(0.001, halfWidth - radius);
  const innerHeight = Math.max(0.001, halfHeight - radius);
  const qx = Math.abs(x) - innerWidth;
  const qy = Math.abs(y) - innerHeight;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const sdf = outside + inside - radius;
  const scale = Math.max(radius, Math.min(halfWidth, halfHeight), 0.001);
  return 1 + sdf / scale;
}

function linearBoundaryDistance(
  value: number,
  limit: number,
  softness: number,
): number {
  return 1 + (value - limit) / Math.max(0.001, softness);
}

function coordinateNoise(
  seed: number,
  x: number,
  y: number,
  frequency: number,
  salt: number,
): number {
  const qx = Math.round((x + 1.5) * frequency * 43);
  const qy = Math.round((y + 1.5) * frequency * 41);
  return hash01(seed, qx * 92821 + qy * 68917, salt);
}

function tipDistanceForProfile(
  profile: InkBrushTipProfile,
  x: number,
  y: number,
  seed: number,
): number {
  const fineNoise = coordinateNoise(seed, x, y, 1.8, 13);
  const coarseNoise = coordinateNoise(seed, x, y, 0.9, 29);

  switch (profile) {
    case "pen_smooth":
      return ellipseDistance(x, y, 0.92, 0.92);
    case "pen_fineliner":
      return superEllipseDistance(x, y, 0.78, 0.78, 2.6) + (fineNoise - 0.5) * 0.015;
    case "pen_monoline":
      return superEllipseDistance(x, y, 0.84, 0.84, 4.4);
    case "brush_calligraphy": {
      const sx = x + y * 0.58;
      const base = roundRectDistance(sx, y, 0.86, 0.24, 0.12);
      const lead = linearBoundaryDistance(sx * 0.92 + y * 0.16, 0.86, 0.15);
      const tail = linearBoundaryDistance(-sx * 0.8 + y * 0.08, 0.98, 0.22);
      return Math.max(base, lead, tail);
    }
    case "marker_soft": {
      const sx = x + y * 0.14;
      return roundRectDistance(sx, y, 0.82, 0.44, 0.28) + (fineNoise - 0.5) * 0.012;
    }
    case "marker_chisel": {
      const sx = x + y * 0.54;
      const base = roundRectDistance(sx, y, 0.88, 0.26, 0.08);
      const lead = linearBoundaryDistance(sx * 0.96 + y * 0.14, 0.84, 0.12);
      const tail = linearBoundaryDistance(-sx * 0.82 + y * 0.1, 0.97, 0.14);
      return Math.max(base, lead, tail);
    }
    case "highlighter": {
      const sx = x + y * 0.18;
      return roundRectDistance(sx, y, 0.96, 0.2, 0.12);
    }
    case "pencil_hard": {
      const theta = Math.atan2(y, x);
      const forward = Math.max(0, Math.sin(theta));
      const side = Math.abs(Math.cos(theta));
      const radius = 0.54 + forward * 0.2 - side * 0.06;
      return Math.hypot(x * 1.04, y * 0.98) / Math.max(0.18, radius) + (fineNoise - 0.5) * 0.035;
    }
    case "pencil_soft": {
      const theta = Math.atan2(y, x);
      const forward = Math.max(0, Math.sin(theta));
      const backward = Math.max(0, -Math.sin(theta));
      const radius = 0.64 + forward * 0.12 - backward * 0.08 - Math.abs(Math.cos(theta)) * 0.04;
      const base = Math.hypot(x * 1.06, y) / Math.max(0.22, radius);
      const wornBack = linearBoundaryDistance(-y, 0.74, 0.22);
      return Math.max(base, wornBack) + (fineNoise - 0.5) * 0.055;
    }
    case "brush_gouache": {
      const sx = x + y * 0.08;
      const base = roundRectDistance(sx, y, 0.72, 0.48, 0.18);
      const fringe = y > 0 ? (coarseNoise - 0.5) * 0.16 * (0.35 + y) : 0;
      return base + fringe + (fineNoise - 0.5) * 0.06;
    }
    case "charcoal_dry": {
      const sx = x + y * 0.22;
      const base = superEllipseDistance(sx, y, 0.78, 0.62, 1.48);
      const chips = (coarseNoise - 0.5) * 0.22 + (fineNoise - 0.5) * 0.1;
      return base + chips;
    }
    case "spray_soft": {
      const cloud = ellipseDistance(x, y, 0.84, 0.84);
      return cloud + (coarseNoise - 0.5) * 0.26 + (fineNoise - 0.5) * 0.12;
    }
    case "eraser_soft":
      return ellipseDistance(x, y, 0.94, 0.94);
    case "eraser_hard":
      return roundRectDistance(x, y, 0.82, 0.5, 0.06);
  }
}

function applyProfileTexture(
  alpha: number,
  profile: InkBrushTipProfile,
  x: number,
  y: number,
  edge: number,
  seed: number,
): number {
  const micro = coordinateNoise(seed, x, y, 3.8, 37);
  const fiber = coordinateNoise(seed, x * 0.78 + y * 0.32, y * 1.12 - x * 0.18, 7.6, 43);
  const coarse = coordinateNoise(seed, x, y, 1.25, 47);
  const stripe = 0.5 + 0.5 * Math.sin((x * 7.8 + y * 2.2 + micro * 1.8) * Math.PI);

  switch (profile) {
    case "pen_smooth":
      return alpha;
    case "pen_fineliner":
      return alpha * (0.96 + micro * 0.05);
    case "pen_monoline":
      return alpha * (0.97 + micro * 0.03);
    case "brush_calligraphy": {
      const fiberGain = 0.982 + stripe * 0.02;
      const edgeFeather = 1 - edge * 0.03;
      return alpha * clamp(fiberGain * edgeFeather, 0, 1.005);
    }
    case "marker_soft": {
      const streak = 0.94 + stripe * 0.06;
      const soak = 0.96 + coarse * 0.03;
      return alpha * clamp(streak * soak, 0, 1);
    }
    case "marker_chisel": {
      const band = 0.92 + stripe * 0.08;
      const nib = 0.96 + (1 - edge) * 0.03;
      return alpha * clamp(band * nib, 0, 1);
    }
    case "highlighter": {
      const band = 0.92 + stripe * 0.06;
      const translucent = 0.92 + coarse * 0.06;
      return alpha * clamp(band * translucent, 0, 0.98);
    }
    case "pencil_hard": {
      const scratch = fiber > 0.62 ? 1 : 0.46 + fiber * 0.54;
      const grain = 0.54 + micro * 0.46;
      return alpha * clamp(scratch * grain, 0, 1);
    }
    case "pencil_soft": {
      const graphite = 0.4 + micro * 0.6;
      const clump = coarse > 0.8 ? 0.84 : 1;
      return alpha * clamp(graphite * clump, 0, 1);
    }
    case "brush_gouache": {
      const bristle = 0.82 + stripe * 0.18;
      const paintLoad = 0.86 + coarse * 0.16;
      return alpha * clamp(bristle * paintLoad, 0, 1);
    }
    case "charcoal_dry": {
      const dust = 0.34 + micro * 0.66;
      const breakage = coarse < 0.22 ? 0.18 : 0.74 + fiber * 0.34;
      return alpha * clamp(dust * breakage, 0, 1);
    }
    case "spray_soft": {
      const droplet = micro > 0.62 ? 1 : 0.08 + micro * 0.16;
      const cloud = 0.56 + coarse * 0.44;
      return alpha * clamp(droplet * cloud, 0, 1);
    }
    case "eraser_soft":
    case "eraser_hard":
      return alpha;
  }
}

function profileSizeNoise(
  profile: InkBrushTipProfile,
  seed: number,
  stampIndex: number,
): number {
  const noise = hash01(seed, stampIndex, 53);

  switch (profile) {
    case "brush_calligraphy":
    case "marker_soft":
    case "marker_chisel":
    case "highlighter":
      return 0.992 + noise * 0.016;
    case "pencil_hard":
      return 0.93 + noise * 0.12;
    case "pencil_soft":
      return 0.88 + noise * 0.2;
    case "brush_gouache":
      return 0.9 + noise * 0.2;
    case "charcoal_dry":
      return 0.8 + noise * 0.32;
    case "spray_soft":
      return 0.94 + noise * 0.1;
    default:
      return 1;
  }
}

function applyTexture(
  alpha: number,
  textureKind: InkBrushTextureKind,
  textureStrength: number,
  noise: number,
  edge: number,
): number {
  if (textureKind === "none" || textureStrength <= 0) return alpha;

  if (textureKind === "grain") {
    const gain = 0.62 + noise * 0.7;
    return alpha * (1 - textureStrength * 0.72 + gain * textureStrength * 0.72);
  }

  if (textureKind === "dry") {
    const edgeBoost = 0.35 + edge * 0.8;
    const dry = clamp((noise - 0.16) / 0.84, 0, 1);
    return alpha * clamp(1 - textureStrength * edgeBoost + dry * textureStrength, 0, 1);
  }

  if (textureKind === "chalk") {
    const chalk = noise > 0.3 ? 1 : noise * 0.55;
    const voids = noise < 0.12 ? 0.18 : 1;
    return alpha * clamp((0.32 + chalk * 0.95) * voids * (1 - textureStrength) + chalk * textureStrength, 0, 1);
  }

  if (textureKind === "speckle") {
    const threshold = 0.72 - textureStrength * 0.45;
    return noise >= threshold ? alpha : alpha * noise * 0.18;
  }

  return alpha;
}

function getTipCanvas(style: ResolvedInkBrushStyle): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;

  const cacheKey = [
    style.tipProfile,
    style.tipShape,
    style.hardness.toFixed(3),
    style.textureKind,
    style.textureStrength.toFixed(3),
    style.isEraser ? "eraser" : style.color,
  ].join(":");
  const cached = TIP_CACHE.get(cacheKey);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = TIP_CANVAS_SIZE;
  canvas.height = TIP_CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const image = ctx.createImageData(TIP_CANVAS_SIZE, TIP_CANVAS_SIZE);
  const data = image.data;
  const { r, g, b } = style.isEraser
    ? { r: 255, g: 255, b: 255 }
    : parseCssColor(style.color);
  const seed = hashString(cacheKey);

  for (let y = 0; y < TIP_CANVAS_SIZE; y += 1) {
    const ny = ((y + 0.5) / TIP_CANVAS_SIZE) * 2 - 1;
    for (let x = 0; x < TIP_CANVAS_SIZE; x += 1) {
      const nx = ((x + 0.5) / TIP_CANVAS_SIZE) * 2 - 1;
      const index = (y * TIP_CANVAS_SIZE + x) * 4;
      const distance = clamp(tipDistanceForProfile(style.tipProfile, nx, ny, seed), 0, 2);
      let alpha = tipEdgeAlpha(distance, style.hardness);
      if (alpha <= 0) continue;

      const noise = hash01(seed, x + y * TIP_CANVAS_SIZE, 17);
      const edge = clamp(distance, 0, 1);
      alpha = applyTexture(
        alpha,
        style.textureKind,
        style.textureStrength,
        noise,
        edge,
      );
      alpha = applyProfileTexture(alpha, style.tipProfile, nx, ny, edge, seed);
      if (alpha <= 0.003) continue;

      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = Math.round(clamp(alpha, 0, 1) * 255);
    }
  }

  ctx.putImageData(image, 0, 0);
  TIP_CACHE.set(cacheKey, canvas);
  return canvas;
}

function fallbackBrushPreset(stroke: InkStroke): InkBrushPreset {

  return {
    id: `${stroke.tool}_fallback`,
    label: stroke.tool,
    tool: stroke.tool,
    sizeScale: 1,
    opacity: stroke.tool === "pencil" ? 0.62 : 1,
    pressureSensitivity: stroke.pressureSensitivity ?? 0,
    blendMode: stroke.blendMode ?? "source-over",
    lineCap: stroke.lineCap ?? "round",
    lineJoin: stroke.lineJoin ?? "round",
    tipShape: stroke.tool === "pencil" ? "pencil" : stroke.tool === "eraser" ? "round" : "round",
    tipProfile:
      stroke.tool === "pencil"
        ? "pencil_soft"
        : stroke.tool === "eraser"
          ? "eraser_soft"
          : "pen_smooth",
    rotationMode: stroke.tool === "pencil" ? "direction" : "none",
    textureKind: stroke.tool === "pencil" ? "grain" : "none",
    spacing: stroke.tool === "pencil" ? 0.11 : 0.18,
    hardness: stroke.tool === "pencil" ? 0.58 : stroke.tool === "eraser" ? 0.3 : 0.9,
    flow: stroke.tool === "pencil" ? 0.58 : 1,
    aspectRatio: 1,
    angle: 0,
    scatter: 0,
    jitter: stroke.tool === "pencil" ? 0.04 : 0,
    textureStrength: stroke.tool === "pencil" ? 0.52 : 0,
    pressureToOpacity: stroke.tool === "pencil" ? 0.2 : 0,
    stampNoise: stroke.tool === "pencil" ? 0.12 : 0,
  };
}

function resolveInkBrushStyle(stroke: InkStroke): ResolvedInkBrushStyle {
  const preset = findInkBrushPreset(stroke.brushId) ?? fallbackBrushPreset(stroke);
  const isEraser = stroke.tool === "eraser" || preset.tool === "eraser";
  const baseAlpha = isEraser
    ? 1
    : clamp(stroke.opacity ?? preset.opacity ?? (stroke.tool === "pencil" ? 0.62 : 1), 0.04, 1);
  const baseSize = clamp(
    typeof stroke.size === "number" && Number.isFinite(stroke.size)
      ? stroke.size
      : preset.sizeScale,
    0.5,
    MAX_STROKE_SIZE,
  );

  return {
    brush: preset,
    isEraser,
    compositeOperation: isEraser
      ? "destination-out"
      : (stroke.blendMode ?? preset.blendMode ?? "source-over"),
    color:
      typeof stroke.color === "string" && stroke.color.trim()
        ? stroke.color
        : "#111827",
    baseAlpha,
    baseSize,
    pressureSensitivity: clamp(
      stroke.pressureSensitivity ?? preset.pressureSensitivity ?? 0,
      0,
      1,
    ),
    spacingPx: Math.max(0.8, baseSize * clamp(preset.spacing, 0.05, 0.6)),
    hardness: clamp(preset.hardness, 0.04, 0.99),
    flow: clamp(preset.flow, 0.05, 1),
    aspectRatio: Math.max(0.35, preset.aspectRatio || 1),
    baseAngleRad: degreesToRadians(preset.angle || 0),
    rotationMode: preset.rotationMode ?? "none",
    tipShape: preset.tipShape ?? "round",
    tipProfile: preset.tipProfile ?? "pen_smooth",
    textureKind: preset.textureKind ?? "none",
    textureStrength: clamp(preset.textureStrength ?? 0, 0, 1),
    scatterPx: Math.max(0, baseSize * (preset.scatter ?? 0)),
    jitterPx: Math.max(0, baseSize * (preset.jitter ?? 0)),
    pressureToOpacity: clamp(preset.pressureToOpacity ?? 0, 0, 1),
    stampNoise: clamp(preset.stampNoise ?? 0, 0, 1),
  };
}

function strokePressure(style: ResolvedInkBrushStyle, point: InkPoint): number {
  if (style.isEraser) return 1;
  return clamp(point.pressure ?? 0.5, 0.1, 1);
}

function strokeDabSize(style: ResolvedInkBrushStyle, point: InkPoint): number {
  if (style.isEraser) return style.baseSize;
  const pressure = strokePressure(style, point);
  return Math.max(
    0.5,
    style.baseSize *
      (1 - style.pressureSensitivity + style.pressureSensitivity * pressure),
  );
}

function isFlatNibProfile(profile: InkBrushTipProfile): boolean {
  return profile === "highlighter" || profile === "marker_chisel";
}

function resolveDabMetrics(
  style: ResolvedInkBrushStyle,
  point: InkPoint,
  seed: number,
  stampIndex: number,
): { pressure: number; size: number; alpha: number } {
  const pressure = strokePressure(style, point);
  const size =
    strokeDabSize(style, point) *
    profileSizeNoise(style.tipProfile, seed, stampIndex);
  const pressureAlpha =
    1 - style.pressureToOpacity + style.pressureToOpacity * pressure;
  const alphaNoise =
    1 - style.stampNoise +
    style.stampNoise * (0.62 + hash01(seed, stampIndex, 11) * 0.76);
  const alpha = clamp(
    style.baseAlpha * style.flow * pressureAlpha * alphaNoise,
    0.02,
    1,
  );
  return { pressure, size, alpha };
}

function resolveDabDimensions(
  style: ResolvedInkBrushStyle,
  size: number,
): { width: number; height: number } {
  if (style.aspectRatio >= 1) {
    return { width: size * style.aspectRatio, height: size };
  }
  return { width: size, height: size / Math.max(0.25, style.aspectRatio) };
}

function strokeDabAngle(
  runtime: InkStrokeRuntime,
  point: InkPoint,
  segmentAngleRad: number,
): number {
  const style = runtime.style;
  let angle = style.baseAngleRad;

  if (style.rotationMode === "direction") {
    angle += segmentAngleRad;
  } else if (style.rotationMode === "tilt") {
    if (typeof point.twist === "number" && Number.isFinite(point.twist)) {
      angle += degreesToRadians(point.twist);
    } else if (
      typeof point.tiltX === "number" &&
      Number.isFinite(point.tiltX) &&
      typeof point.tiltY === "number" &&
      Number.isFinite(point.tiltY)
    ) {
      angle += Math.atan2(point.tiltY, point.tiltX);
    } else {
      angle += segmentAngleRad;
    }
  }

  return angle;
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
): void {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const safeRadius = Math.min(radius, halfWidth, halfHeight);
  ctx.beginPath();
  ctx.moveTo(-halfWidth + safeRadius, -halfHeight);
  ctx.lineTo(halfWidth - safeRadius, -halfHeight);
  ctx.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + safeRadius);
  ctx.lineTo(halfWidth, halfHeight - safeRadius);
  ctx.quadraticCurveTo(halfWidth, halfHeight, halfWidth - safeRadius, halfHeight);
  ctx.lineTo(-halfWidth + safeRadius, halfHeight);
  ctx.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - safeRadius);
  ctx.lineTo(-halfWidth, -halfHeight + safeRadius);
  ctx.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + safeRadius, -halfHeight);
  ctx.closePath();
}

function drawFlatNibDab(
  ctx: CanvasRenderingContext2D,
  runtime: InkStrokeRuntime,
  x: number,
  y: number,
  angle: number,
  width: number,
  height: number,
  alpha: number,
): void {
  const style = runtime.style;
  const profile = style.tipProfile;
  const radius =
    profile === "highlighter"
      ? Math.max(1.2, height * 0.42)
      : Math.max(1.2, Math.min(width, height) * 0.28);

  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.globalAlpha = style.isEraser ? 1 : alpha;
  ctx.translate(x, y);
  if (Math.abs(angle) > 0.0001) {
    ctx.rotate(angle);
  }
  ctx.fillStyle = style.isEraser ? "rgba(255,255,255,1)" : style.color;
  traceRoundedRect(ctx, width, height, radius);
  ctx.fill();
  ctx.restore();
}

function rectangleCorners(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  angle: number,
): Point2D[] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ];

  return corners.map((corner) => ({
    x: centerX + corner.x * cos - corner.y * sin,
    y: centerY + corner.x * sin + corner.y * cos,
  }));
}

function crossProduct(origin: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: Point2D[]): Point2D[] {
  if (points.length <= 1) return points;

  const sorted = [...points].sort((a, b) => {
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
  const lower: Point2D[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      crossProduct(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point2D[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]!;
    while (
      upper.length >= 2 &&
      crossProduct(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function drawFlatNibSweep(
  ctx: CanvasRenderingContext2D,
  runtime: InkStrokeRuntime,
  from: InkPoint,
  to: InkPoint,
  segmentAngleRad: number,
): void {
  const style = runtime.style;
  const fromMetrics = resolveDabMetrics(style, from, runtime.seed, runtime.stampIndex);
  const toMetrics = resolveDabMetrics(style, to, runtime.seed, runtime.stampIndex + 1);
  const angle = strokeDabAngle(runtime, to, segmentAngleRad);
  const fromDimensions = resolveDabDimensions(style, fromMetrics.size);
  const toDimensions = resolveDabDimensions(style, toMetrics.size);
  const hull = convexHull([
    ...rectangleCorners(from.x, from.y, fromDimensions.width, fromDimensions.height, angle),
    ...rectangleCorners(to.x, to.y, toDimensions.width, toDimensions.height, angle),
  ]);

  if (hull.length < 3) {
    drawFlatNibDab(
      ctx,
      runtime,
      to.x,
      to.y,
      angle,
      toDimensions.width,
      toDimensions.height,
      toMetrics.alpha,
    );
    return;
  }

  const alpha = clamp((fromMetrics.alpha + toMetrics.alpha) / 2, 0.02, 1);
  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.globalAlpha = style.isEraser ? 1 : alpha;
  ctx.fillStyle = style.isEraser ? "rgba(255,255,255,1)" : style.color;
  ctx.beginPath();
  ctx.moveTo(hull[0]!.x, hull[0]!.y);
  for (let index = 1; index < hull.length; index += 1) {
    ctx.lineTo(hull[index]!.x, hull[index]!.y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSprayDab(
  ctx: CanvasRenderingContext2D,
  runtime: InkStrokeRuntime,
  x: number,
  y: number,
  size: number,
  alpha: number,
): void {
  const style = runtime.style;
  const particleCount = Math.max(14, Math.round(12 + size * 2.4));
  const maxRadius = Math.max(1.4, size * 0.78);
  const coreSize = Math.max(0.7, size * 0.26);

  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.fillStyle = style.color;
  ctx.translate(x, y);

  for (let particle = 0; particle < particleCount; particle += 1) {
    const index = runtime.stampIndex * 37 + particle;
    const theta = hash01(runtime.seed, index, 61) * Math.PI * 2;
    const radius = Math.pow(hash01(runtime.seed, index, 67), 0.6) * maxRadius;
    const dropletSize = Math.max(0.45, coreSize * (0.45 + hash01(runtime.seed, index, 71) * 1.15));
    const particleAlpha = alpha * (0.18 + hash01(runtime.seed, index, 73) * 0.16);
    ctx.globalAlpha = clamp(particleAlpha, 0.03, 0.36);
    ctx.beginPath();
    ctx.arc(Math.cos(theta) * radius, Math.sin(theta) * radius, dropletSize, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = clamp(alpha * 0.28, 0.08, 0.45);
  ctx.beginPath();
  ctx.arc(0, 0, coreSize, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDab(
  ctx: CanvasRenderingContext2D,
  runtime: InkStrokeRuntime,
  point: InkPoint,
  segmentAngleRad: number,
): void {
  const style = runtime.style;
  const { size, alpha } = resolveDabMetrics(
    style,
    point,
    runtime.seed,
    runtime.stampIndex,
  );
  const jitterX =
    (hash01(runtime.seed, runtime.stampIndex, 17) - 0.5) * 2 * style.jitterPx;
  const jitterY =
    (hash01(runtime.seed, runtime.stampIndex, 23) - 0.5) * 2 * style.jitterPx;
  const scatterTheta = hash01(runtime.seed, runtime.stampIndex, 29) * Math.PI * 2;
  const scatterRadius =
    Math.sqrt(hash01(runtime.seed, runtime.stampIndex, 31)) * style.scatterPx;
  const x = point.x + jitterX + Math.cos(scatterTheta) * scatterRadius;
  const y = point.y + jitterY + Math.sin(scatterTheta) * scatterRadius;
  const angle = strokeDabAngle(runtime, point, segmentAngleRad);
  runtime.lastAngleRad = angle;

  if (style.tipProfile === "spray_soft") {
    drawSprayDab(ctx, runtime, x, y, size, alpha);
    return;
  }

  const { width: drawWidth, height: drawHeight } = resolveDabDimensions(
    style,
    size,
  );

  if (isFlatNibProfile(style.tipProfile)) {
    drawFlatNibDab(ctx, runtime, x, y, angle, drawWidth, drawHeight, alpha);
    return;
  }

  const tip = getTipCanvas(style);

  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.globalAlpha = style.isEraser ? 1 : alpha;
  ctx.translate(x, y);
  if (Math.abs(angle) > 0.0001) {
    ctx.rotate(angle);
  }

  if (tip) {
    ctx.drawImage(tip, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  } else {
    ctx.fillStyle = style.isEraser ? "rgba(255,255,255,1)" : style.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, drawWidth / 2, drawHeight / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function createInkStrokeRuntime(
  stroke: InkStroke,
  options?: { flatNibSweep?: boolean },
): InkStrokeRuntime {
  const style = resolveInkBrushStyle(stroke);
  return {
    style,
    carry: 0,
    stampIndex: 0,
    seed: hashString(`${stroke.id}:${stroke.brushId ?? style.brush.id}`),
    lastAngleRad: style.baseAngleRad,
    flatNibSweep: options?.flatNibSweep ?? true,
  };
}

export function drawInkStrokePoint(
  ctx: CanvasRenderingContext2D,
  runtime: InkStrokeRuntime,
  point: InkPoint,
): void {
  drawDab(ctx, runtime, point, runtime.lastAngleRad);
  runtime.stampIndex += 1;
  runtime.carry = 0;
}

export function drawInkStrokeSegmentRuntime(
  ctx: CanvasRenderingContext2D,
  runtime: InkStrokeRuntime,
  from: InkPoint,
  to: InkPoint,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 0.001) return;

  const segmentAngle = Math.atan2(dy, dx);
  if (runtime.flatNibSweep && isFlatNibProfile(runtime.style.tipProfile)) {
    drawFlatNibSweep(ctx, runtime, from, to, segmentAngle);
    runtime.stampIndex += 1;
    runtime.carry = 0;
    runtime.lastAngleRad = segmentAngle;
    return;
  }

  const spacing = runtime.style.spacingPx;
  let consumed = 0;
  let carry = runtime.carry;

  while (carry + (length - consumed) >= spacing) {
    const needed = spacing - carry;
    const travel = consumed + needed;
    const t = clamp(travel / length, 0, 1);
    const point = interpolatePoint(from, to, t);
    drawDab(ctx, runtime, point, segmentAngle);
    runtime.stampIndex += 1;
    consumed = travel;
    carry = 0;
  }

  runtime.carry = carry + (length - consumed);
  runtime.lastAngleRad = segmentAngle;
}

export function drawInkStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
): void {
  const points = Array.isArray(stroke.points) ? stroke.points : [];
  if (points.length === 0) return;

  const runtime = createInkStrokeRuntime(stroke);
  drawInkStrokePoint(ctx, runtime, points[0]!);

  for (let index = 1; index < points.length; index += 1) {
    drawInkStrokeSegmentRuntime(ctx, runtime, points[index - 1]!, points[index]!);
  }

  if (points.length > 1 && isFlatNibProfile(runtime.style.tipProfile)) {
    drawInkStrokePoint(ctx, runtime, points[points.length - 1]!);
  }
}

export function drawAllStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: InkStroke[],
): void {
  for (const stroke of strokes) {
    drawInkStroke(ctx, stroke);
  }
}

export function redrawAll(
  ctx: CanvasRenderingContext2D,
  strokes: InkStroke[],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  drawAllStrokes(ctx, strokes);
}

export function redrawPaperBackground(
  ctx: CanvasRenderingContext2D,
  template: InkPaperTemplate,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);

  if (template === "blank") return;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle =
    template === "grid"
      ? "rgba(148,120,72,0.22)"
      : "rgba(148,120,72,0.30)";
  ctx.beginPath();

  if (template === "grid") {
    const step = 24;
    for (let x = 0; x <= width; x += step) {
      const xx = Math.round(x) + 0.5;
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, height);
    }
    for (let y = 0; y <= height; y += step) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(width, yy);
    }
  } else {
    const step = 28;
    for (let y = 0; y <= height; y += step) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(width, yy);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function estimateStrokePadding(style: ResolvedInkBrushStyle): number {
  const majorAxis = style.aspectRatio >= 1
    ? style.baseSize * style.aspectRatio
    : style.baseSize / Math.max(0.25, style.aspectRatio);
  return majorAxis * 0.72 + style.scatterPx + style.jitterPx + 4;
}

export function computeInkBounds(strokes: InkStroke[]): InkBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const stroke of strokes) {
    const points = Array.isArray(stroke.points) ? stroke.points : [];
    if (points.length === 0) continue;
    const padding = estimateStrokePadding(resolveInkBrushStyle(stroke));
    for (const point of points) {
      minX = Math.min(minX, point.x - padding);
      minY = Math.min(minY, point.y - padding);
      maxX = Math.max(maxX, point.x + padding);
      maxY = Math.max(maxY, point.y + padding);
    }
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

export async function renderInkStateToDataUrl(
  ink: InkState,
  options?: {
    margin?: number;
    backgroundColor?: string;
    maxEdge?: number;
  },
): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const strokes = Array.isArray(ink?.strokes) ? ink.strokes : [];
  if (strokes.length === 0) return null;
  const bounds = computeInkBounds(strokes);
  if (!bounds) return null;

  const margin = options?.margin ?? 24;
  const backgroundColor = options?.backgroundColor ?? "#ffffff";
  const maxEdge = options?.maxEdge ?? 1536;
  const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX + margin * 2));
  const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY + margin * 2));
  const scale = Math.max(width, height) > maxEdge ? maxEdge / Math.max(width, height) : 1;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, outWidth / scale, outHeight / scale);
  ctx.translate(margin - bounds.minX, margin - bounds.minY);
  drawAllStrokes(ctx, strokes);
  return canvas.toDataURL("image/png");
}
