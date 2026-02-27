import type { AnsiColorMode, AnsiRenderMode } from '../types';

export interface AnsiPalette {
  normal: string[];
  bright: string[];
}

interface AnsiPaletteColor {
  kind: 'palette';
  index: number;
  bright: boolean;
}

interface AnsiIndexedColor {
  kind: 'index';
  index: number;
}

interface AnsiRgbColor {
  kind: 'rgb';
  r: number;
  g: number;
  b: number;
}

type AnsiColor = AnsiPaletteColor | AnsiIndexedColor | AnsiRgbColor;

export interface AnsiState {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  hidden: boolean;
  strikethrough: boolean;
}

export interface AnsiSegment {
  text: string;
  state: AnsiState;
}

const DEFAULT_STATE: AnsiState = {
  fg: undefined,
  bg: undefined,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  hidden: false,
  strikethrough: false,
};

const ANSI_PALETTES: Record<'xterm' | 'vscode-dark' | 'vscode-light', AnsiPalette> = {
  xterm: {
    normal: [
      '#000000',
      '#cd0000',
      '#00cd00',
      '#cdcd00',
      '#0000ee',
      '#cd00cd',
      '#00cdcd',
      '#e5e5e5',
    ],
    bright: [
      '#7f7f7f',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#5c5cff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ],
  },
  'vscode-dark': {
    normal: [
      '#000000',
      '#cd3131',
      '#0dbc79',
      '#e5e510',
      '#2472c8',
      '#bc3fbc',
      '#11a8cd',
      '#e5e5e5',
    ],
    bright: [
      '#666666',
      '#f14c4c',
      '#23d18b',
      '#f5f543',
      '#3b8eea',
      '#d670d6',
      '#29b8db',
      '#ffffff',
    ],
  },
  'vscode-light': {
    normal: [
      '#000000',
      '#cd3131',
      '#00bc00',
      '#949800',
      '#2266b0',
      '#bc05bc',
      '#0598bc',
      '#555555',
    ],
    bright: [
      '#666666',
      '#cd3131',
      '#14ce14',
      '#b5ba00',
      '#2266b0',
      '#bc05bc',
      '#0598bc',
      '#a5a5a5',
    ],
  },
};

export const normalizeAnsiRenderMode = (value?: string): AnsiRenderMode => {
  if (value === 'raw' || value === 'strip' || value === 'color') {
    return value;
  }
  return 'color';
};

export const normalizeAnsiColorMode = (value?: string): AnsiColorMode => {
  if (value === 'xterm' || value === 'vscode-dark' || value === 'vscode-light' || value === 'auto') {
    return value;
  }
  return 'auto';
};

export const resolveAnsiPalette = (
  mode: AnsiColorMode,
  theme: 'light' | 'dark'
): AnsiPalette => {
  const normalized = normalizeAnsiColorMode(mode);
  if (normalized === 'auto') {
    return theme === 'dark' ? ANSI_PALETTES['vscode-dark'] : ANSI_PALETTES['vscode-light'];
  }
  if (normalized === 'xterm') {
    return ANSI_PALETTES.xterm;
  }
  return ANSI_PALETTES[normalized];
};

const cloneState = (state: AnsiState): AnsiState => ({
  fg: state.fg ? { ...state.fg } : undefined,
  bg: state.bg ? { ...state.bg } : undefined,
  bold: state.bold,
  dim: state.dim,
  italic: state.italic,
  underline: state.underline,
  inverse: state.inverse,
  hidden: state.hidden,
  strikethrough: state.strikethrough,
});

const resetState = (state: AnsiState) => {
  state.fg = undefined;
  state.bg = undefined;
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
  state.inverse = false;
  state.hidden = false;
  state.strikethrough = false;
};

const clampByte = (value: number) => Math.max(0, Math.min(255, value));

const rgbString = (r: number, g: number, b: number) =>
  `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`;

const resolveIndexedColor = (index: number) => {
  if (index < 16) {
    return null;
  }
  if (index >= 16 && index <= 231) {
    const idx = index - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return rgbString(steps[r], steps[g], steps[b]);
  }
  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10;
    return rgbString(level, level, level);
  }
  return null;
};

const resolveAnsiColor = (
  color: AnsiColor | undefined,
  palette: AnsiPalette,
  bold: boolean,
  dim: boolean
) => {
  if (!color) return undefined;
  if (color.kind === 'palette') {
    const useBright = color.bright || (bold && !color.bright && !dim);
    const set = useBright ? palette.bright : palette.normal;
    return set[color.index];
  }
  if (color.kind === 'rgb') {
    return rgbString(color.r, color.g, color.b);
  }
  const idx = color.index;
  if (idx < 8) {
    return palette.normal[idx];
  }
  if (idx < 16) {
    return palette.bright[idx - 8];
  }
  return resolveIndexedColor(idx) || undefined;
};

const applySgrCodes = (state: AnsiState, codes: number[]) => {
  if (codes.length === 0) {
    resetState(state);
    return;
  }

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];

    if (code === 0) {
      resetState(state);
      continue;
    }

    if (code === 1) {
      state.bold = true;
      continue;
    }
    if (code === 2) {
      state.dim = true;
      continue;
    }
    if (code === 3) {
      state.italic = true;
      continue;
    }
    if (code === 4) {
      state.underline = true;
      continue;
    }
    if (code === 7) {
      state.inverse = true;
      continue;
    }
    if (code === 8) {
      state.hidden = true;
      continue;
    }
    if (code === 9) {
      state.strikethrough = true;
      continue;
    }
    if (code === 22) {
      state.bold = false;
      state.dim = false;
      continue;
    }
    if (code === 23) {
      state.italic = false;
      continue;
    }
    if (code === 24) {
      state.underline = false;
      continue;
    }
    if (code === 27) {
      state.inverse = false;
      continue;
    }
    if (code === 28) {
      state.hidden = false;
      continue;
    }
    if (code === 29) {
      state.strikethrough = false;
      continue;
    }
    if (code === 39) {
      state.fg = undefined;
      continue;
    }
    if (code === 49) {
      state.bg = undefined;
      continue;
    }
    if (code >= 30 && code <= 37) {
      state.fg = { kind: 'palette', index: code - 30, bright: false };
      continue;
    }
    if (code >= 90 && code <= 97) {
      state.fg = { kind: 'palette', index: code - 90, bright: true };
      continue;
    }
    if (code >= 40 && code <= 47) {
      state.bg = { kind: 'palette', index: code - 40, bright: false };
      continue;
    }
    if (code >= 100 && code <= 107) {
      state.bg = { kind: 'palette', index: code - 100, bright: true };
      continue;
    }
    if (code === 38 || code === 48) {
      const isForeground = code === 38;
      const mode = codes[i + 1];
      if (mode === 5 && codes[i + 2] !== undefined) {
        const value = clampByte(codes[i + 2]);
        const color: AnsiColor =
          value < 8
            ? { kind: 'palette', index: value, bright: false }
            : value < 16
              ? { kind: 'palette', index: value - 8, bright: true }
              : { kind: 'index', index: value };
        if (isForeground) {
          state.fg = color;
        } else {
          state.bg = color;
        }
        i += 2;
      } else if (mode === 2 && codes[i + 4] !== undefined) {
        const color = {
          kind: 'rgb',
          r: clampByte(codes[i + 2]),
          g: clampByte(codes[i + 3]),
          b: clampByte(codes[i + 4]),
        } as const;
        if (isForeground) {
          state.fg = color;
        } else {
          state.bg = color;
        }
        i += 4;
      }
    }
  }
};

export const parseAnsi = (input: string): AnsiSegment[] => {
  if (!input) return [];

  const segments: AnsiSegment[] = [];
  const state: AnsiState = { ...DEFAULT_STATE };
  let buffer = '';

  let i = 0;
  const len = input.length;
  while (i < len) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x1b) {
      buffer += input[i];
      i += 1;
      continue;
    }

    if (buffer) {
      segments.push({ text: buffer, state: cloneState(state) });
      buffer = '';
    }

    i += 1;
    if (i >= len) break;
    const next = input.charCodeAt(i);

    if (next === 0x5b) {
      i += 1;
      const start = i;
      let final = '';
      while (i < len) {
        const code = input.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          final = input[i];
          i += 1;
          break;
        }
        i += 1;
      }
      if (!final) {
        break;
      }
      if (final === 'm') {
        const paramText = input.slice(start, i - 1);
        const parts = paramText.length ? paramText.split(';') : ['0'];
        const codes = parts
          .map((part) => (part === '' ? 0 : Number.parseInt(part, 10)))
          .filter((value) => Number.isFinite(value)) as number[];
        applySgrCodes(state, codes);
      }
      continue;
    }

    if (next === 0x5d) {
      i += 1;
      while (i < len) {
        const code = input.charCodeAt(i);
        if (code === 0x07) {
          i += 1;
          break;
        }
        if (code === 0x1b && i + 1 < len && input.charCodeAt(i + 1) === 0x5c) {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  if (buffer) {
    segments.push({ text: buffer, state: cloneState(state) });
  }

  return segments;
};

export const resolveAnsiStyle = (state: AnsiState, palette: AnsiPalette) => {
  const style: Record<string, string | number> = {};
  let fg = resolveAnsiColor(state.fg, palette, state.bold, state.dim);
  let bg = resolveAnsiColor(state.bg, palette, state.bold, state.dim);

  if (state.inverse) {
    const tmp = fg;
    fg = bg;
    bg = tmp;
  }

  if (state.hidden) {
    style.color = 'transparent';
  } else if (fg) {
    style.color = fg;
  }

  if (bg) {
    style.backgroundColor = bg;
  }

  if (state.bold) {
    style.fontWeight = 600;
  }
  if (state.italic) {
    style.fontStyle = 'italic';
  }

  const decorations: string[] = [];
  if (state.underline) {
    decorations.push('underline');
  }
  if (state.strikethrough) {
    decorations.push('line-through');
  }
  if (decorations.length > 0) {
    style.textDecoration = decorations.join(' ');
  }

  if (state.dim) {
    style.opacity = 0.75;
  }

  return style;
};
