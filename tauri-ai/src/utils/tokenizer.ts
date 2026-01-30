/**
 * Token counting utilities using gpt-tokenizer
 * Provides accurate token estimation for OpenAI-compatible models
 */

import { encode } from 'gpt-tokenizer';

const MAX_EXACT_TOKENIZE_CHARS = 200_000;

const countChineseChars = (text: string): number => {
  let chineseChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) chineseChars++;
  }
  return chineseChars;
};

/**
 * Fast token estimation (linear-time heuristic)
 * Uses ~4 chars per token for English, ~1.5 for Chinese
 */
export const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const chineseChars = countChineseChars(text);
  const otherChars = Math.max(0, text.length - chineseChars);
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
};

/**
 * Fast token estimation for multiple texts without BPE encoding.
 */
export const estimateTokensForTexts = (texts: string[], separator = '\n'): number => {
  if (!texts.length) return 0;

  let totalLen = 0;
  let chineseChars = 0;
  for (const t of texts) {
    if (!t) continue;
    totalLen += t.length;
    chineseChars += countChineseChars(t);
  }

  if (texts.length > 1 && separator) {
    totalLen += separator.length * (texts.length - 1);
    chineseChars += countChineseChars(separator) * (texts.length - 1);
  }

  if (totalLen === 0) return 0;
  const otherChars = Math.max(0, totalLen - chineseChars);
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
};

/**
 * Count tokens in a text string using BPE tokenizer.
 * Works well for OpenAI and OpenAI-compatible models (DeepSeek, SiliconFlow, etc.)
 */
export const countTokens = (text: string): number => {
  if (!text) return 0;
  // gpt-tokenizer 在超长文本上可能导致 UI 明显卡顿；这里对极端长度直接使用快速估算
  if (text.length > MAX_EXACT_TOKENIZE_CHARS) {
    return estimateTokens(text);
  }
  try {
    return encode(text).length;
  } catch {
    // Fallback to rough estimation if encoding fails
    return estimateTokens(text);
  }
};

/**
 * Count tokens for multiple texts without concatenating a huge string.
 * - When total length is small enough, join once and use tokenizer for better accuracy.
 * - When too large, fallback to a linear-time heuristic to avoid UI freezes / memory spikes.
 */
export const countTokensForTexts = (texts: string[], separator = '\n'): number => {
  if (!texts.length) return 0;

  const cleaned = texts.map((t) => t || '');
  const totalLen = cleaned.reduce((sum, t) => sum + t.length, 0);

  if (totalLen === 0) return 0;

  if (totalLen <= MAX_EXACT_TOKENIZE_CHARS) {
    return countTokens(cleaned.join(separator));
  }

  return estimateTokensForTexts(cleaned, separator);
};
