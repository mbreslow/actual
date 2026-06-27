import * as asyncStorage from '#platform/server/asyncStorage';
import { fetch } from '#platform/server/fetch';
import { logger } from '#platform/server/log';
import { getServer } from '#server/server-config';
import { currentDay } from '#shared/months';
import type { TransactionEntity } from '#types/models';
import type {
  LLMClassificationConfig,
  LLMClassificationProvider,
} from '#types/prefs';

type CategoryForPrompt = {
  id: string;
  name: string;
  groupName: string;
  hints: string;
};

type TransactionForPrompt = {
  id: number;
  date: string;
  payee: string;
  importedPayee: string;
  notes: string;
  amount: number;
  account: string;
};

type Classification = {
  id: number;
  categoryId: string;
  confidence: number;
  reason: string;
};

type TransactionClassificationTarget = {
  trans: TransactionEntity;
  match?: TransactionEntity | null;
  subtransactions?: TransactionEntity[] | null;
};

type ClassificationCandidate = {
  trans: TransactionEntity;
  accountName: string;
  payeeName: string;
};

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/api/chat';

function integerToAmount(amount: number): number {
  return amount / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const providerDefaults = {
  ollama: {
    model: 'llama3.1',
    endpoint: DEFAULT_OLLAMA_ENDPOINT,
  },
  openai: {
    model: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  anthropic: {
    model: 'claude-3-5-haiku-latest',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  google: {
    model: 'gemini-2.5-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  },
  googleVertex: {
    model: 'gemini-2.5-flash',
    endpoint: 'https://aiplatform.googleapis.com/v1',
  },
  amazonBedrock: {
    model: 'us.anthropic.claude-sonnet-4-6',
    endpoint: 'https://bedrock-runtime.{region}.amazonaws.com',
  },
} satisfies Record<
  LLMClassificationProvider,
  { model: string; endpoint: string }
>;

function isConfigured(
  config?: LLMClassificationConfig,
): config is Required<Pick<LLMClassificationConfig, 'provider'>> &
  LLMClassificationConfig {
  if (!config?.provider) {
    return false;
  }

  if (config.provider === 'ollama') {
    return true;
  }

  return Boolean(config.apiKey);
}

async function loadConfig(): Promise<LLMClassificationConfig | undefined> {
  const asyncStorage = await import('#platform/server/asyncStorage');
  return asyncStorage.getItem('llmClassificationConfig');
}

async function getEnabled(accountId: string): Promise<boolean> {
  const db = await import('#server/db');
  const row = await db.first<{ value?: string | null }>(
    'SELECT value FROM preferences WHERE id = ?',
    [`sync-llm-classify-${accountId}`],
  );

  return String(row?.value ?? 'false') === 'true';
}

async function getGloballyEnabled(): Promise<boolean> {
  const db = await import('#server/db');
  const row = await db.first<{ value?: string | null }>(
    'SELECT value FROM preferences WHERE id = ?',
    ['llmClassificationEnabled'],
  );

  return String(row?.value ?? 'false') === 'true';
}

export function parseClassificationHints(raw: string | null | undefined) {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
        .map(([categoryId, hints]) => [categoryId, hints.trim()]),
    );
  } catch {
    return {};
  }
}

async function getCategories(): Promise<CategoryForPrompt[]> {
  const db = await import('#server/db');
  const [categories, hintsRow] = await Promise.all([
    db.all<Omit<CategoryForPrompt, 'hints'>>(
      `SELECT c.id, c.name, cg.name AS groupName
       FROM categories c
       JOIN category_groups cg ON cg.id = c.cat_group
      WHERE c.tombstone = 0
        AND c.hidden = 0
        AND cg.tombstone = 0
        AND cg.hidden = 0
      ORDER BY cg.is_income, cg.sort_order, c.sort_order, c.id`,
    ),
    db.first<{ value?: string | null }>(
      'SELECT value FROM preferences WHERE id = ?',
      ['llmClassificationHints'],
    ),
  ]);
  const hintsByCategory = parseClassificationHints(hintsRow?.value);

  return categories.map(category => ({
    ...category,
    hints: hintsByCategory[category.id] || '',
  }));
}

export function getSystemPrompt(categories: CategoryForPrompt[]): string {
  return `You classify personal bank transactions into exactly one allowed Actual Budget category.

Allowed categories are JSON objects with id, name, groupName, and hints:
${JSON.stringify(categories)}

Rules:
- Return valid JSON only.
- Use exactly this shape: {"classifications":[{"id":1,"categoryId":"category-id","confidence":0.92,"reason":"Short reason"}]}
- categoryId must be exactly one allowed category id.
- confidence must be a number from 0 to 1.
- reason must be brief and based only on payee, imported payee, notes, amount, date, and account.
- hints are user-provided descriptions of what each category means in this budget. Prefer these hints over generic merchant assumptions when they are relevant.
- Treat broad catch-all categories such as Flexible Spending, Miscellaneous, Other, General, or Everything Else as a last resort. Use a more specific allowed category when the payee, imported payee, notes, or hints clearly indicate one.
- Classify refunds or credits by the underlying merchant/category, not by the sign of the amount.
- When uncertain, choose the closest allowed category and lower the confidence.`;
}

function getUserPrompt(transactions: TransactionForPrompt[]): string {
  return `Classify these transactions:\n${JSON.stringify(transactions)}`;
}

function getSchema(categoryIds: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer' },
            categoryId: { type: 'string', enum: categoryIds },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
          },
          required: ['id', 'categoryId', 'confidence', 'reason'],
        },
      },
    },
    required: ['classifications'],
  };
}

function stripUnsupportedGoogleSchemaFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUnsupportedGoogleSchemaFields);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, childValue]) => [
        key,
        stripUnsupportedGoogleSchemaFields(childValue),
      ]),
  );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Model returned invalid JSON: ${raw.slice(0, 500)}`);
    }
    return JSON.parse(jsonMatch[0]);
  }
}

export function parseClassifications(
  raw: string,
  expectedIds: Set<number>,
  categoryIds: Set<string>,
): Map<number, Classification> {
  const parsed = parseJson(raw);
  const items =
    parsed && typeof parsed === 'object' && 'classifications' in parsed
      ? (parsed as { classifications: unknown }).classifications
      : parsed;

  if (!Array.isArray(items)) {
    throw new Error(`Model JSON is missing a classifications array`);
  }

  const results = new Map<number, Classification>();
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const id = Number(record.id);
    if (!Number.isInteger(id) || !expectedIds.has(id)) {
      continue;
    }

    const categoryId = getString(record.categoryId)?.trim() || '';
    if (!categoryIds.has(categoryId)) {
      throw new Error(`Invalid category id for transaction ${id}`);
    }

    const confidenceRaw = Number(record.confidence ?? 0);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0;

    results.set(id, {
      id,
      categoryId,
      confidence,
      reason: getString(record.reason)?.trim() || '',
    });
  }

  const missing = [...expectedIds].filter(id => !results.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Model did not classify transaction ids: ${missing.join(', ')}`,
    );
  }

  return results;
}

async function fetchJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const server = getServer();
  const isOllama = url.includes('11434');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    if (server && !isOllama) {
      const userToken = await asyncStorage.getItem('user-token');
      const proxyUrl = `${server.BASE_SERVER}/llm-proxy`;
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ACTUAL-TOKEN': userToken || '',
        },
        body: JSON.stringify({
          url,
          method: 'POST',
          headers,
          body,
        }),
        signal: controller.signal,
      });
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM provider returned HTTP ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

function textFromProviderResponse(
  provider: LLMClassificationProvider,
  body: unknown,
): string | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }

  switch (provider) {
    case 'ollama': {
      return getString(asRecord(record.message)?.content);
    }
    case 'openai': {
      const choice = asRecord(getArray(record.choices)[0]);
      return getString(asRecord(choice?.message)?.content);
    }
    case 'anthropic': {
      const textPart = getArray(record.content)
        .map(asRecord)
        .find(part => part?.type === 'text');
      return getString(textPart?.text);
    }
    case 'google':
    case 'googleVertex': {
      const candidate = asRecord(getArray(record.candidates)[0]);
      const content = asRecord(candidate?.content);
      const part = asRecord(getArray(content?.parts)[0]);
      return getString(part?.text);
    }
    case 'amazonBedrock': {
      const output = asRecord(record.output);
      const message = asRecord(output?.message);
      const textPart = getArray(message?.content)
        .map(asRecord)
        .find(part => typeof part?.text === 'string');
      return getString(textPart?.text);
    }
    default:
      return undefined;
  }
}

export function getProviderRequest({
  config,
  systemPrompt,
  userPrompt,
  categoryIds,
}: {
  config: LLMClassificationConfig & {
    provider: LLMClassificationProvider;
  };
  systemPrompt: string;
  userPrompt: string;
  categoryIds: string[];
}): { url: string; body: unknown; headers: Record<string, string> } {
  const defaults = providerDefaults[config.provider];
  const model = config.model || defaults.model;
  const endpoint = config.endpoint || defaults.endpoint;
  const schema = getSchema(categoryIds);
  const googleSchema = stripUnsupportedGoogleSchemaFields(schema);

  switch (config.provider) {
    case 'ollama':
      return {
        url: endpoint,
        headers: {},
        body: {
          model,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_ctx: 8192 },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
      };
    case 'openai':
      return {
        url: endpoint,
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: {
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'transaction_classifications',
              strict: true,
              schema,
            },
          },
        },
      };
    case 'anthropic':
      return {
        url: endpoint,
        headers: {
          'x-api-key': config.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: {
          model,
          max_tokens: 4096,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          output_config: {
            format: {
              type: 'json_schema',
              name: 'transaction_classifications',
              schema,
            },
          },
        },
      };
    case 'google': {
      const url = `${endpoint}/models/${model}:generateContent?key=${encodeURIComponent(
        config.apiKey || '',
      )}`;
      return {
        url,
        headers: {},
        body: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: googleSchema,
          },
        },
      };
    }
    case 'googleVertex': {
      const location = config.vertexLocation || 'us-central1';
      const projectId = config.vertexProjectId || '';
      const url = `${endpoint}/projects/${encodeURIComponent(
        projectId,
      )}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${encodeURIComponent(config.apiKey || '')}`;
      return {
        url,
        headers: {},
        body: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: googleSchema,
          },
        },
      };
    }
    case 'amazonBedrock': {
      const region = config.bedrockRegion || 'us-east-1';
      const baseUrl = endpoint.replace('{region}', region);
      return {
        url: `${baseUrl}/model/${encodeURIComponent(model)}/converse`,
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: {
          system: [{ text: systemPrompt }],
          messages: [{ role: 'user', content: [{ text: userPrompt }] }],
          inferenceConfig: { temperature: 0, maxTokens: 4096 },
          additionalModelRequestFields: {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'transaction_classifications',
                schema,
              },
            },
          },
        },
      };
    }
    default:
      throw new Error('Unsupported LLM provider');
  }
}

async function classifyBatch({
  config,
  categories,
  transactions,
}: {
  config: LLMClassificationConfig & {
    provider: LLMClassificationProvider;
  };
  categories: CategoryForPrompt[];
  transactions: TransactionForPrompt[];
}): Promise<Map<number, Classification>> {
  const categoryIds = categories.map(category => category.id);
  const categoryIdSet = new Set(categoryIds);
  const expectedIds = new Set(transactions.map(transaction => transaction.id));
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const request = getProviderRequest({
      config,
      systemPrompt: getSystemPrompt(categories),
      userPrompt: getUserPrompt(transactions),
      categoryIds,
    });
    const body = await fetchJson(
      request.url,
      request.body,
      request.headers,
      config.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
    const text = textFromProviderResponse(config.provider, body);
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('LLM provider response did not include text content');
    }

    try {
      return parseClassifications(text, expectedIds, categoryIdSet);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(JSON.stringify(lastError));
}

async function classifyCandidates(
  candidates: ClassificationCandidate[],
  config: LLMClassificationConfig & {
    provider: LLMClassificationProvider;
  },
  categories: CategoryForPrompt[],
  { replaceExisting = false }: { replaceExisting?: boolean } = {},
): Promise<
  Array<
    Pick<
      TransactionEntity,
      | 'id'
      | 'category'
      | 'categorization_source'
      | 'categorization_date'
      | 'categorization_note'
    >
  >
> {
  const updates: Array<
    Pick<
      TransactionEntity,
      | 'id'
      | 'category'
      | 'categorization_source'
      | 'categorization_date'
      | 'categorization_note'
    >
  > = [];

  const db = await import('#server/db');
  let memories: Array<{
    imported_payee: string | null;
    payee_name: string | null;
    category_id: string;
  }> = [];
  try {
    memories = await db.all<{
      imported_payee: string | null;
      payee_name: string | null;
      category_id: string;
    }>(
      'SELECT imported_payee, payee_name, category_id FROM ai_classification_memories WHERE tombstone = 0',
    );
  } catch (error) {
    logger.warn(
      'Failed to read ai_classification_memories, using empty memory:',
      error,
    );
  }

  const importedPayeeMap = new Map<string, string>();
  const payeeNameMap = new Map<string, string>();
  for (const memory of memories) {
    if (memory.imported_payee) {
      importedPayeeMap.set(memory.imported_payee, memory.category_id);
    }
    if (memory.payee_name) {
      payeeNameMap.set(memory.payee_name, memory.category_id);
    }
  }

  const llmCandidates: ClassificationCandidate[] = [];
  for (const candidate of candidates) {
    let matchedCategoryId: string | undefined;
    if (candidate.trans.imported_payee) {
      matchedCategoryId = importedPayeeMap.get(candidate.trans.imported_payee);
    }
    if (!matchedCategoryId && candidate.payeeName) {
      matchedCategoryId = payeeNameMap.get(candidate.payeeName);
    }

    if (matchedCategoryId) {
      const update = {
        id: candidate.trans.id,
        category: matchedCategoryId,
        categorization_source: 'ai',
        categorization_date: currentDay(),
        categorization_note: 'Classified based on previous user correction',
      } satisfies (typeof updates)[number];
      candidate.trans.category = update.category;
      candidate.trans.categorization_source = update.categorization_source;
      candidate.trans.categorization_date = update.categorization_date;
      candidate.trans.categorization_note = update.categorization_note;
      updates.push(update);
    } else {
      llmCandidates.push(candidate);
    }
  }

  if (llmCandidates.length === 0) {
    return updates;
  }

  const batchSize = Math.max(
    1,
    Math.min(config.batchSize || DEFAULT_BATCH_SIZE, 50),
  );

  for (let start = 0; start < llmCandidates.length; start += batchSize) {
    const chunk = llmCandidates.slice(start, start + batchSize);
    const promptTransactions = chunk.map((candidate, index) =>
      buildPromptTransaction({
        index: start + index + 1,
        transaction: candidate.trans,
        accountName: candidate.accountName,
        payeeName: candidate.payeeName,
      }),
    );
    const results = await classifyBatch({
      config,
      categories,
      transactions: promptTransactions,
    });

    chunk.forEach((candidate, index) => {
      const id = start + index + 1;
      const result = results.get(id);
      if (result && (replaceExisting || !candidate.trans.category)) {
        const update = {
          id: candidate.trans.id,
          category: result.categoryId,
          categorization_source: 'ai',
          categorization_date: currentDay(),
          categorization_note: result.reason,
        } satisfies (typeof updates)[number];
        candidate.trans.category = update.category;
        candidate.trans.categorization_source = update.categorization_source;
        candidate.trans.categorization_date = update.categorization_date;
        candidate.trans.categorization_note = update.categorization_note;
        updates.push(update);
      }
    });
  }

  return updates;
}

function buildPromptTransaction({
  index,
  transaction,
  accountName,
  payeeName,
}: {
  index: number;
  transaction: TransactionEntity;
  accountName: string;
  payeeName: string;
}): TransactionForPrompt {
  return {
    id: index,
    date: transaction.date,
    payee: payeeName,
    importedPayee: transaction.imported_payee || '',
    notes: transaction.notes || '',
    amount: integerToAmount(transaction.amount),
    account: accountName,
  };
}

export async function classifyBankSyncTransactions(
  accountId: string,
  targets: TransactionClassificationTarget[],
): Promise<void> {
  const [globalEnabled, accountEnabled] = await Promise.all([
    getGloballyEnabled(),
    getEnabled(accountId),
  ]);
  if (!globalEnabled || !accountEnabled) {
    return;
  }

  const config = await loadConfig();
  if (!isConfigured(config)) {
    return;
  }

  const candidates = targets.filter(
    ({ trans, match, subtransactions }) =>
      !match &&
      !trans.tombstone &&
      !trans.category &&
      !trans.transfer_id &&
      !trans.starting_balance_flag &&
      (!subtransactions || subtransactions.length === 0),
  );
  if (candidates.length === 0) {
    return;
  }

  const [account, categories, payees] = await Promise.all([
    import('#server/db').then(db => db.select('accounts', accountId)),
    getCategories(),
    import('#server/db').then(db => db.getPayees()),
  ]);

  if (categories.length === 0) {
    return;
  }

  const payeeNames = new Map(payees.map(payee => [payee.id, payee.name]));

  try {
    const updates = await classifyCandidates(
      candidates.map(candidate => ({
        trans: candidate.trans,
        accountName: account.name,
        payeeName: candidate.trans.payee
          ? payeeNames.get(candidate.trans.payee) || ''
          : '',
      })),
      config,
      categories,
    );
    const updatesByTransaction = new Map(
      updates.map(update => [update.id, update]),
    );
    candidates.forEach(candidate => {
      const update = updatesByTransaction.get(candidate.trans.id);
      if (update) {
        candidate.trans.category = update.category;
        candidate.trans.categorization_source = update.categorization_source;
        candidate.trans.categorization_date = update.categorization_date;
        candidate.trans.categorization_note = update.categorization_note;
      }
    });
  } catch (error) {
    logger.warn('Skipping LLM transaction classification:', error);
  }
}

export async function classifyExistingUncategorizedTransactions({
  ids = [],
  replaceExisting = false,
}: {
  ids?: string[];
  replaceExisting?: boolean;
} = {}): Promise<{
  classified: number;
  updates?: Array<
    Pick<
      TransactionEntity,
      | 'id'
      | 'category'
      | 'categorization_source'
      | 'categorization_date'
      | 'categorization_note'
    >
  >;
}> {
  const enabled = await getGloballyEnabled();
  if (!enabled) {
    throw new Error('LLM transaction categorization is disabled.');
  }

  const config = await loadConfig();
  if (!isConfigured(config)) {
    throw new Error('LLM transaction categorization is not configured.');
  }

  const db = await import('#server/db');
  const selectedIds = ids.filter(id => !id.includes('preview/'));
  const selectedFilter =
    selectedIds.length > 0
      ? `AND t.id IN (${selectedIds.map(() => '?').join(', ')})`
      : '';
  const categoryFilter =
    replaceExisting && selectedIds.length > 0 ? '' : 'AND t.category IS NULL';
  const [categories, payees, accounts, transactions] = await Promise.all([
    getCategories(),
    db.getPayees(),
    db.getAccounts(),
    db.all<TransactionEntity>(
      `SELECT t.*
         FROM v_transactions_internal t
         JOIN accounts a ON a.id = t.account
        WHERE a.offbudget = 0
          ${categoryFilter}
          AND t.is_parent = 0
          AND t.tombstone = 0
          AND t.transfer_id IS NULL
          AND COALESCE(t.starting_balance_flag, 0) = 0
          ${selectedFilter}
        ORDER BY t.date DESC, t.sort_order DESC, t.id`,
      selectedIds,
    ),
  ]);

  if (categories.length === 0 || transactions.length === 0) {
    return { classified: 0, updates: [] };
  }

  const payeeNames = new Map(payees.map(payee => [payee.id, payee.name]));
  const accountNames = new Map(
    accounts.map(account => [account.id, account.name]),
  );
  const candidates = transactions.map(trans => ({
    trans,
    accountName: accountNames.get(trans.account) || '',
    payeeName: trans.payee ? payeeNames.get(trans.payee) || '' : '',
  }));

  try {
    const updated = await classifyCandidates(candidates, config, categories, {
      replaceExisting,
    });
    if (updated.length > 0) {
      const { batchUpdateTransactions } = await import('#server/transactions');
      await batchUpdateTransactions({ updated, runTransfers: false });
    }

    return { classified: updated.length, updates: updated };
  } catch (error) {
    logger.warn('Skipping LLM transaction classification:', error);
    throw error;
  }
}

export async function learnClassificationOverrides(
  overrides: Array<{ previous: TransactionEntity; updated: TransactionEntity }>,
): Promise<void> {
  const db = await import('#server/db');
  const payees = await db.getPayees();
  const payeeNames = new Map(payees.map(payee => [payee.id, payee.name]));

  for (const { previous, updated } of overrides) {
    const importedPayee =
      updated.imported_payee || previous.imported_payee || '';
    const payeeId = updated.payee || previous.payee;
    const payeeName = payeeId ? payeeNames.get(payeeId) || '' : '';

    if (!importedPayee && !payeeName) {
      continue;
    }

    const id = `${importedPayee}::${payeeName}`;

    if (!updated.category) {
      db.runQuery('DELETE FROM ai_classification_memories WHERE id = ?', [id]);
    } else {
      db.runQuery(
        `INSERT OR REPLACE INTO ai_classification_memories (id, imported_payee, payee_name, category_id, tombstone)
         VALUES (?, ?, ?, ?, 0)`,
        [id, importedPayee, payeeName, updated.category],
      );
    }
  }
}
