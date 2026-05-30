// @vitest-environment jsdom

import { beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'linux' },
  });
});

let parseClassifications: (
  raw: string,
  expectedIds: Set<number>,
  categoryIds: Set<string>,
) => Map<number, unknown>;
let getProviderRequest: (params: {
  config: {
    provider:
      | 'ollama'
      | 'openai'
      | 'anthropic'
      | 'google'
      | 'googleVertex'
      | 'amazonBedrock';
    endpoint: string;
    apiKey: string;
    model: string;
    vertexProjectId: string;
    vertexLocation: string;
    bedrockRegion: string;
  };
  systemPrompt: string;
  userPrompt: string;
  categoryIds: string[];
}) => { url: string; body: unknown };
let getSystemPrompt: (
  categories: Array<{
    id: string;
    name: string;
    groupName: string;
    hints: string;
  }>,
) => string;
let parseClassificationHints: (
  raw: string | null | undefined,
) => Record<string, string>;

describe('LLM bank sync classifier', () => {
  beforeAll(async () => {
    const classifier = await import('./llm-classifier');
    parseClassifications = classifier.parseClassifications;
    getProviderRequest = classifier.getProviderRequest;
    getSystemPrompt = classifier.getSystemPrompt;
    parseClassificationHints = classifier.parseClassificationHints;
  });

  test('parses valid classifications and clamps confidence', () => {
    const results = parseClassifications(
      JSON.stringify({
        classifications: [
          {
            id: 1,
            categoryId: 'cat-food',
            confidence: 2,
            reason: 'Grocery merchant',
          },
        ],
      }),
      new Set([1]),
      new Set(['cat-food']),
    );

    expect(results.get(1)).toEqual({
      id: 1,
      categoryId: 'cat-food',
      confidence: 1,
      reason: 'Grocery merchant',
    });
  });

  test('rejects invalid categories', () => {
    expect(() =>
      parseClassifications(
        JSON.stringify({
          classifications: [
            {
              id: 1,
              categoryId: 'missing',
              confidence: 0.8,
              reason: 'Unknown',
            },
          ],
        }),
        new Set([1]),
        new Set(['cat-food']),
      ),
    ).toThrow(/Invalid category id/);
  });

  test('rejects missing transaction ids', () => {
    expect(() =>
      parseClassifications(
        JSON.stringify({ classifications: [] }),
        new Set([1]),
        new Set(['cat-food']),
      ),
    ).toThrow(/did not classify/);
  });

  test.each([
    ['ollama', 'http://localhost:11434/api/chat'],
    ['openai', 'https://api.openai.com/v1/chat/completions'],
    ['anthropic', 'https://api.anthropic.com/v1/messages'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta'],
    ['googleVertex', 'https://aiplatform.googleapis.com/v1'],
    ['amazonBedrock', 'https://bedrock-runtime.{region}.amazonaws.com'],
  ] as const)('builds a %s provider request', (provider, endpoint) => {
    const request = getProviderRequest({
      config: {
        provider,
        endpoint,
        apiKey: 'key',
        model: 'model',
        vertexProjectId: 'project',
        vertexLocation: 'us-central1',
        bedrockRegion: 'us-east-1',
      },
      systemPrompt: 'system cat-food',
      userPrompt: 'user',
      categoryIds: ['cat-food'],
    });

    expect(request.url).toContain(
      provider === 'amazonBedrock'
        ? 'bedrock-runtime.us-east-1.amazonaws.com'
        : endpoint,
    );
    expect(JSON.stringify(request.body)).toContain('cat-food');
  });

  test('omits unsupported additionalProperties fields from Google response schema', () => {
    const request = getProviderRequest({
      config: {
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'key',
        model: 'gemini-flash-lite-latest',
        vertexProjectId: '',
        vertexLocation: '',
        bedrockRegion: '',
      },
      systemPrompt: 'system',
      userPrompt: 'user',
      categoryIds: ['cat-food'],
    });

    expect(JSON.stringify(request.body)).not.toContain('additionalProperties');
  });

  test('includes category hints in the system prompt', () => {
    const prompt = getSystemPrompt([
      {
        id: 'flexible',
        name: 'Flexible Spending',
        groupName: 'Usual Expenses',
        hints: 'movies, entertainment, activities',
      },
      {
        id: 'dining',
        name: 'Dining Out',
        groupName: 'Usual Expenses',
        hints: '',
      },
    ]);

    expect(prompt).toContain('"hints":"movies, entertainment, activities"');
    expect(prompt).toContain('"hints":""');
    expect(prompt).toContain(
      'Prefer these hints over generic merchant assumptions',
    );
  });

  test('parses classification hints and ignores invalid values', () => {
    expect(
      parseClassificationHints(
        JSON.stringify({
          flexible: 'movies, entertainment, activities',
          dining: '',
          invalid: 123,
        }),
      ),
    ).toEqual({
      flexible: 'movies, entertainment, activities',
      dining: '',
    });
    expect(parseClassificationHints('not json')).toEqual({});
    expect(parseClassificationHints(JSON.stringify(['movies']))).toEqual({});
  });
});
