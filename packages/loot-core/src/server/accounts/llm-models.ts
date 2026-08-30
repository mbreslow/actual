import type { LLMClassificationProvider } from '#types/prefs';

type ProviderModelListArgs = {
  provider: LLMClassificationProvider;
  apiKey?: string;
  endpoint?: string;
  fetchJson: (
    url: string,
    method: 'GET',
    headers?: Record<string, string>,
  ) => Promise<unknown>;
};

function parseDate(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function stripGoogleModelPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice(7) : name;
}

function compareGoogleModels(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

export async function getProviderModels({
  provider,
  apiKey,
  endpoint,
  fetchJson,
}: ProviderModelListArgs): Promise<string[]> {
  if (provider === 'anthropic') {
    if (!apiKey) {
      return [];
    }

    const json = await fetchJson('https://api.anthropic.com/v1/models', 'GET', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });
    const data = (json as { data?: Array<{ id: string; created_at?: string }> })
      .data;

    return (data || [])
      .sort((a, b) => parseDate(b.created_at) - parseDate(a.created_at))
      .map(item => item.id);
  }

  if (provider === 'openai') {
    if (!apiKey) {
      return [];
    }

    const json = await fetchJson(
      'https://api.openai.com/v1/models',
      'GET',
      {
        Authorization: `Bearer ${apiKey}`,
      },
    );
    const data = (json as { data?: Array<{ id: string; created?: number }> })
      .data;

    return (data || [])
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map(item => item.id);
  }

  if (provider === 'google') {
    if (!apiKey) {
      return [];
    }

    const baseUrl =
      endpoint || 'https://generativelanguage.googleapis.com/v1beta';
    const json = await fetchJson(
      `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`,
      'GET',
    );
    const models = (
      json as {
        models?: Array<{
          name: string;
          supportedGenerationMethods?: string[];
        }>;
      }
    ).models;

    return (models || [])
      .filter(item =>
        item.supportedGenerationMethods?.includes('generateContent'),
      )
      .map(item => stripGoogleModelPrefix(item.name))
      .sort(compareGoogleModels);
  }

  if (provider === 'ollama') {
    let tagsUrl = 'http://localhost:11434/api/tags';
    if (endpoint) {
      try {
        const url = new URL(endpoint);
        url.pathname = '/api/tags';
        tagsUrl = url.toString();
      } catch {
        // Keep the default Ollama tags URL when the configured endpoint is not a URL.
      }
    }

    const json = await fetchJson(tagsUrl, 'GET');
    const models = (
      json as { models?: Array<{ name: string; modified_at?: string }> }
    ).models;

    return (models || [])
      .sort((a, b) => parseDate(b.modified_at) - parseDate(a.modified_at))
      .map(item => item.name);
  }

  return [];
}
