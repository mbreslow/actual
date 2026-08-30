// @vitest-environment jsdom

import { beforeAll, describe, expect, test, vi } from 'vitest';

import type { getProviderModels as getProviderModelsType } from './llm-models';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'linux' },
  });
});

let getProviderModels: typeof getProviderModelsType;

describe('LLM provider model lists', () => {
  beforeAll(async () => {
    ({ getProviderModels } = await import('./llm-models'));
  });

  test('sorts Anthropic models by created_at newest first', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      data: [
        { id: 'claude-old', created_at: '2024-01-01T00:00:00Z' },
        { id: 'claude-new', created_at: '2025-01-01T00:00:00Z' },
      ],
    });

    await expect(
      getProviderModels({
        provider: 'anthropic',
        apiKey: 'anthropic-key',
        fetchJson,
      }),
    ).resolves.toEqual(['claude-new', 'claude-old']);

    expect(fetchJson).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      'GET',
      {
        'x-api-key': 'anthropic-key',
        'anthropic-version': '2023-06-01',
      },
    );
  });

  test('sorts OpenAI models by created newest first without local filtering', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      data: [
        { id: 'legacy-model', created: 10 },
        { id: 'new-model', created: 20 },
      ],
    });

    await expect(
      getProviderModels({
        provider: 'openai',
        apiKey: 'openai-key',
        endpoint: 'https://api.openai.com/v1/models',
        fetchJson,
      }),
    ).resolves.toEqual(['new-model', 'legacy-model']);
  });

  test('filters Google models to generateContent entries', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      models: [
        {
          name: 'models/gemini-1.5-pro',
          supportedGenerationMethods: ['countTokens'],
        },
        {
          name: 'models/gemini-2.5-flash',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    });

    await expect(
      getProviderModels({
        provider: 'google',
        apiKey: 'google-key',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        fetchJson,
      }),
    ).resolves.toEqual(['gemini-2.5-flash']);
  });

  test('sorts Ollama local tags by modified_at newest first', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      models: [
        { name: 'llama3:latest', modified_at: '2024-01-01T00:00:00Z' },
        { name: 'mistral:latest', modified_at: '2025-01-01T00:00:00Z' },
      ],
    });

    await expect(
      getProviderModels({
        provider: 'ollama',
        endpoint: 'http://localhost:11434/api/chat',
        fetchJson,
      }),
    ).resolves.toEqual(['mistral:latest', 'llama3:latest']);

    expect(fetchJson).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      'GET',
    );
  });
});
