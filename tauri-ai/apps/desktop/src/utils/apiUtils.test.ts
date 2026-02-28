/**
 * API Utils Tests
 * Tests for API protocol detection and utility functions
 */

import { describe, it, expect } from 'vitest';
import { getApiProtocol, getDefaultThinkingMode } from './apiUtils';
import type { Provider } from '../types';

describe('apiUtils', () => {
  describe('getApiProtocol', () => {
    it('returns "responses" for openai_responses provider', () => {
      const providers: Provider[] = [
        {
          name: 'openai_responses',
          displayName: 'OpenAI Responses',
          type: 'openai_responses',
          apiBase: 'https://api.openai.com/v1',
          enabled: true,
          models: [],
        },
      ];

      const result = getApiProtocol('openai_responses/o1', providers);
      expect(result).toBe('responses');
    });

    it('returns "chat_completions" for openai provider', () => {
      const providers: Provider[] = [
        {
          name: 'openai',
          displayName: 'OpenAI',
          type: 'openai',
          apiBase: 'https://api.openai.com/v1',
          enabled: true,
          models: [],
        },
      ];

      const result = getApiProtocol('openai/gpt-4', providers);
      expect(result).toBe('chat_completions');
    });

    it('returns "chat_completions" for anthropic provider', () => {
      const providers: Provider[] = [
        {
          name: 'anthropic',
          displayName: 'Anthropic',
          type: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          enabled: true,
          models: [],
        },
      ];

      const result = getApiProtocol('anthropic/claude-3', providers);
      expect(result).toBe('chat_completions');
    });

    it('returns "chat_completions" for ollama provider', () => {
      const providers: Provider[] = [
        {
          name: 'ollama',
          displayName: 'Ollama',
          type: 'ollama',
          apiBase: 'http://localhost:11434',
          enabled: true,
          models: [],
        },
      ];

      const result = getApiProtocol('ollama/llama2', providers);
      expect(result).toBe('chat_completions');
    });

    it('returns "chat_completions" for openai_compatible provider', () => {
      const providers: Provider[] = [
        {
          name: 'deepseek',
          displayName: 'DeepSeek',
          type: 'openai_compatible',
          apiBase: 'https://api.deepseek.com/v1',
          enabled: true,
          models: [],
        },
      ];

      const result = getApiProtocol('deepseek/deepseek-v3', providers);
      expect(result).toBe('chat_completions');
    });

    it('returns "chat_completions" when provider not found', () => {
      const providers: Provider[] = [];
      const result = getApiProtocol('unknown/model', providers);
      expect(result).toBe('chat_completions');
    });

    it('returns "chat_completions" for invalid modelRef format', () => {
      const providers: Provider[] = [];
      const result = getApiProtocol('invalid-format', providers);
      expect(result).toBe('chat_completions');
    });

    it('handles multiple providers correctly', () => {
      const providers: Provider[] = [
        {
          name: 'openai',
          displayName: 'OpenAI',
          type: 'openai',
          apiBase: 'https://api.openai.com/v1',
          enabled: true,
          models: [],
        },
        {
          name: 'openai_responses',
          displayName: 'OpenAI Responses',
          type: 'openai_responses',
          apiBase: 'https://api.openai.com/v1',
          enabled: true,
          models: [],
        },
        {
          name: 'anthropic',
          displayName: 'Anthropic',
          type: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          enabled: true,
          models: [],
        },
      ];

      expect(getApiProtocol('openai/gpt-4', providers)).toBe('chat_completions');
      expect(getApiProtocol('openai_responses/o1', providers)).toBe('responses');
      expect(getApiProtocol('anthropic/claude-3', providers)).toBe('chat_completions');
    });
  });

  describe('getDefaultThinkingMode', () => {
    it('returns true for chat_completions protocol', () => {
      const result = getDefaultThinkingMode('chat_completions');
      expect(result).toBe(true);
    });

    it('returns "medium" for responses protocol', () => {
      const result = getDefaultThinkingMode('responses');
      expect(result).toBe('medium');
    });
  });
});
