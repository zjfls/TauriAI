import type { ActiveView } from '../types';

export type WindowBrandKind = 'chat' | 'workstudio' | 'other';

const CHAT_PREFIX = '【聊天】';
const WORKSTUDIO_PREFIX = '【Workstudio】';

const CHAT_PREFIX_RE = /^【聊天】\s*/;
const WORKSTUDIO_PREFIX_RE = /^【Workstudio】\s*/i;
const LEGACY_CHAT_PREFIX_RE = /^chat\b\s*[:：-]?\s*/i;
const LEGACY_WORKSTUDIO_PREFIX_RE = /^workstudio\b\s*[:：-]?\s*/i;

const trimWindowTitle = (title: string | null | undefined): string => (title ?? '').trim();

export const stripChatWindowTitlePrefix = (title: string | null | undefined): string => {
  const raw = trimWindowTitle(title);
  if (!raw) return '';
  return raw.replace(CHAT_PREFIX_RE, '').replace(LEGACY_CHAT_PREFIX_RE, '').trim();
};

export const stripWorkstudioWindowTitlePrefix = (title: string | null | undefined): string => {
  const raw = trimWindowTitle(title);
  if (!raw) return '';
  return raw.replace(WORKSTUDIO_PREFIX_RE, '').replace(LEGACY_WORKSTUDIO_PREFIX_RE, '').trim();
};

export const normalizeChatWindowTitle = (title: string | null | undefined): string => {
  const raw = stripChatWindowTitlePrefix(title);
  return raw ? `${CHAT_PREFIX} ${raw}` : `${CHAT_PREFIX} TauriAI`;
};

export const normalizeWorkstudioWindowTitle = (title: string | null | undefined): string => {
  const raw = stripWorkstudioWindowTitlePrefix(title);
  return raw ? `${WORKSTUDIO_PREFIX} ${raw}` : WORKSTUDIO_PREFIX;
};

export const resolveWindowBrandKind = (view: ActiveView | null | undefined, label: string | null | undefined): WindowBrandKind => {
  const normalizedView = (view ?? '').trim();
  const normalizedLabel = (label ?? '').trim();

  if (
    normalizedView === 'workstudio' ||
    normalizedLabel.startsWith('view-workstudio-') ||
    normalizedLabel.startsWith('view-workstudio-dir-')
  ) {
    return 'workstudio';
  }

  if (normalizedView && normalizedView !== 'chat') {
    return 'other';
  }

  if (
    !normalizedView ||
    normalizedView === 'chat' ||
    normalizedLabel === 'main' ||
    normalizedLabel.startsWith('view-chat-') ||
    normalizedLabel.startsWith('workspace-')
  ) {
    return 'chat';
  }

  return 'other';
};

const createIconCanvas = (size: number) => new Uint8Array(size * size * 4);

const setPixel = (
  rgba: Uint8Array,
  size: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255
) => {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
};

const fillRect = (
  rgba: Uint8Array,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number?]
) => {
  const [r, g, b, a = 255] = color;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(size, Math.ceil(x + width));
  const y1 = Math.min(size, Math.ceil(y + height));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      setPixel(rgba, size, px, py, r, g, b, a);
    }
  }
};

const fillRoundedRect = (
  rgba: Uint8Array,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: readonly [number, number, number, number?]
) => {
  const [r, g, b, a = 255] = color;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(size, Math.ceil(x + width));
  const y1 = Math.min(size, Math.ceil(y + height));
  const rr = Math.max(0, radius);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const dx = px < x + rr ? x + rr - px : px >= x + width - rr ? px - (x + width - rr - 1) : 0;
      const dy = py < y + rr ? y + rr - py : py >= y + height - rr ? py - (y + height - rr - 1) : 0;
      if (dx * dx + dy * dy <= rr * rr) {
        setPixel(rgba, size, px, py, r, g, b, a);
      }
    }
  }
};

const fillTriangle = (
  rgba: Uint8Array,
  size: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  color: readonly [number, number, number, number?]
) => {
  const [r, g, b, a = 255] = color;
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));

  const area =
    (p1.y - p2.y) * (p0.x - p2.x) +
    (p2.x - p1.x) * (p0.y - p2.y);
  if (area === 0) return;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const w0 = ((p1.y - p2.y) * (px - p2.x) + (p2.x - p1.x) * (py - p2.y)) / area;
      const w1 = ((p2.y - p0.y) * (px - p2.x) + (p0.x - p2.x) * (py - p2.y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
        setPixel(rgba, size, px, py, r, g, b, a);
      }
    }
  }
};

const drawLine = (
  rgba: Uint8Array,
  size: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  thickness: number,
  color: readonly [number, number, number, number?]
) => {
  const [r, g, b, a = 255] = color;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = Math.round(from.x + dx * t);
    const y = Math.round(from.y + dy * t);
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        if (ox * ox + oy * oy > radius * radius + 1) continue;
        setPixel(rgba, size, x + ox, y + oy, r, g, b, a);
      }
    }
  }
};

const drawGlyph = (
  rgba: Uint8Array,
  size: number,
  glyph: string[],
  x: number,
  y: number,
  scale: number,
  color: readonly [number, number, number, number?]
) => {
  for (let gy = 0; gy < glyph.length; gy++) {
    const row = glyph[gy] ?? '';
    for (let gx = 0; gx < row.length; gx++) {
      if (row[gx] !== '1') continue;
      fillRect(rgba, size, x + gx * scale, y + gy * scale, scale, scale, color);
    }
  }
};

const drawChatIcon = (rgba: Uint8Array, size: number) => {
  const bgTop: [number, number, number, number] = [37, 99, 235, 255];
  const bgBottom: [number, number, number, number] = [59, 130, 246, 255];

  fillRoundedRect(rgba, size, 2, 2, size - 4, size - 4, 8, bgTop);
  fillRoundedRect(rgba, size, 4, 4, size - 8, size - 8, 7, bgBottom);
  fillRoundedRect(rgba, size, 7, 8, 18, 12, 4, [255, 255, 255, 255]);
  fillTriangle(rgba, size, { x: 12, y: 18 }, { x: 16, y: 24 }, { x: 19, y: 18 }, [255, 255, 255, 255]);
  fillRect(rgba, size, 11, 13, 2, 2, [37, 99, 235, 255]);
  fillRect(rgba, size, 15, 13, 2, 2, [37, 99, 235, 255]);
  fillRect(rgba, size, 19, 13, 2, 2, [37, 99, 235, 255]);
};

const drawWorkstudioIcon = (rgba: Uint8Array, size: number) => {
  const bgTop: [number, number, number, number] = [5, 150, 105, 255];
  const bgBottom: [number, number, number, number] = [16, 185, 129, 255];

  fillRoundedRect(rgba, size, 2, 2, size - 4, size - 4, 8, bgTop);
  fillRoundedRect(rgba, size, 4, 4, size - 8, size - 8, 7, bgBottom);
  drawLine(rgba, size, { x: 12, y: 10 }, { x: 8, y: 16 }, 3, [255, 255, 255, 255]);
  drawLine(rgba, size, { x: 8, y: 16 }, { x: 12, y: 22 }, 3, [255, 255, 255, 255]);
  drawLine(rgba, size, { x: 20, y: 10 }, { x: 24, y: 16 }, 3, [255, 255, 255, 255]);
  drawLine(rgba, size, { x: 24, y: 16 }, { x: 20, y: 22 }, 3, [255, 255, 255, 255]);
  drawLine(rgba, size, { x: 18, y: 9 }, { x: 14, y: 23 }, 2, [209, 250, 229, 255]);
};

const drawDevBadge = (rgba: Uint8Array, size: number) => {
  fillRoundedRect(rgba, size, size - 12, 1, 11, 11, 3, [239, 68, 68, 255]);
  drawGlyph(
    rgba,
    size,
    ['110', '101', '101', '101', '110'],
    size - 10,
    4,
    1,
    [255, 255, 255, 255]
  );
};

export const createWindowBrandIconRgba = (
  kind: WindowBrandKind,
  size = 32,
  opts?: { devBadge?: boolean }
): Uint8Array => {
  const rgba = createIconCanvas(size);
  if (kind === 'workstudio') {
    drawWorkstudioIcon(rgba, size);
  } else {
    drawChatIcon(rgba, size);
  }
  if (opts?.devBadge) {
    drawDevBadge(rgba, size);
  }
  return rgba;
};
