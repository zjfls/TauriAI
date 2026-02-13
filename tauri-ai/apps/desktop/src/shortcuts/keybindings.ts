import type { ShortcutPlatform } from './registry';

export const detectShortcutPlatform = (): ShortcutPlatform => {
  if (typeof navigator === 'undefined') return 'windows';
  const platform = (navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  if (platform.includes('mac') || ua.includes('mac os')) return 'mac';
  return 'windows';
};

const MOD_ALIASES: Record<string, 'Cmd' | 'Ctrl' | 'Alt' | 'Shift'> = {
  cmd: 'Cmd',
  command: 'Cmd',
  meta: 'Cmd',
  '⌘': 'Cmd',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  '⌃': 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  '⌥': 'Alt',
  shift: 'Shift',
  '⇧': 'Shift',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  comma: ',',
  minus: '-',
  _: '-',
  '–': '-', // en dash
  '－': '-', // fullwidth hyphen-minus
};

// Prefer KeyboardEvent.code for certain punctuation keys so shortcuts remain stable across keyboard layouts.
const KEY_CODE_ALIASES: Record<string, string> = {
  Minus: '-',
  NumpadSubtract: '-',
  // Zoom-in defaults typically use "Ctrl/Cmd + =" (with Shift producing "+") so we canonicalize to "=".
  Equal: '=',
  NumpadAdd: '=',
};

export const isModifierOnlyKey = (key: string): boolean => {
  return key === 'Shift' || key === 'Control' || key === 'Meta' || key === 'Alt';
};

export const normalizeKeyName = (rawKey: string): string => {
  const k = (rawKey || '').trim();
  if (!k) return '';

  const lower = k.toLowerCase();
  if (lower in KEY_ALIASES) return KEY_ALIASES[lower];

  // Common DOM keys
  if (k === ' ') return 'Space';

  // Letters: normalize to upper-case (A-Z)
  if (k.length === 1 && k >= 'a' && k <= 'z') return k.toUpperCase();
  return k;
};

export interface ParsedKeybinding {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export const normalizeKeybindingString = (raw: string, platform: ShortcutPlatform): string | null => {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  const parts = trimmed
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);

  let cmd = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = '';

  for (const p of parts) {
    const lower = p.toLowerCase();
    const mod = MOD_ALIASES[lower];
    if (mod) {
      if (mod === 'Cmd') cmd = true;
      if (mod === 'Ctrl') ctrl = true;
      if (mod === 'Alt') alt = true;
      if (mod === 'Shift') shift = true;
      continue;
    }
    key = p;
  }

  const normalizedKey = normalizeKeyName(key);
  if (!normalizedKey) return null;
  if (isModifierOnlyKey(normalizedKey)) return null;

  const mods: string[] = [];
  if (cmd) mods.push('Cmd');
  if (ctrl) mods.push('Ctrl');
  if (alt) mods.push(platform === 'mac' ? 'Option' : 'Alt');
  if (shift) mods.push('Shift');

  return mods.length ? `${mods.join('+')}+${normalizedKey}` : normalizedKey;
};

export const eventToKeybindingString = (event: KeyboardEvent, platform: ShortcutPlatform): string | null => {
  const codeAlias = KEY_CODE_ALIASES[event.code] || '';
  const key = codeAlias ? normalizeKeyName(codeAlias) : normalizeKeyName(event.key);
  if (!key) return null;
  if (isModifierOnlyKey(key)) return null;

  const mods: string[] = [];
  if (platform === 'mac' && event.metaKey) mods.push('Cmd');
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push(platform === 'mac' ? 'Option' : 'Alt');
  if (event.shiftKey) mods.push('Shift');

  return mods.length ? `${mods.join('+')}+${key}` : key;
};

export const isEditableElement = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el) return false;

  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as any).isContentEditable) return true;

  // xterm.js uses a hidden textarea inside the terminal root
  if (el.closest?.('.xterm')) return true;

  return false;
};
