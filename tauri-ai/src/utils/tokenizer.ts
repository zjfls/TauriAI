/**
 * Token counting utilities using gpt-tokenizer
 * Provides accurate token estimation for OpenAI-compatible models
 */

import { encode } from 'gpt-tokenizer';

/**
 * Count tokens in a text string using BPE tokenizer
 * Works well for OpenAI and OpenAI-compatible models (DeepSeek, SiliconFlow, etc.)
 */
export const countTokens = (text: string): number => {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Fallback to rough estimation if encoding fails
    return estimateTokensFallback(text);
  }
};

/**
 * Fallback token estimation when tokenizer fails
 * Uses simple heuristic: ~4 chars per token for English, ~1.5 for Chinese
 */
const estimateTokensFallback = (text: string): number => {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
};
