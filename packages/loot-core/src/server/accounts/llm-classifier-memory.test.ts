// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';

import {
  classifyBankSyncTransactions,
  classifyExistingUncategorizedTransactions,
} from './llm-classifier';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'linux', userAgent: 'node' },
  });
});

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
});

async function prepareDatabase() {
  await db.insertCategoryGroup({ id: 'group1', name: 'group1', is_income: 1 });
  const groceries = await db.insertCategory({
    id: 'groceries',
    name: 'Groceries',
    cat_group: 'group1',
    is_income: 0,
  });
  const diningOut = await db.insertCategory({
    id: 'dining-out',
    name: 'Dining Out',
    cat_group: 'group1',
    is_income: 0,
  });

  const accountId = await db.insertAccount({
    id: 'one',
    name: 'Test Account',
    offbudget: 0,
  });

  const payeeId = await db.insertPayee({
    id: 'payee1',
    name: 'Kroger',
  });

  return { accountId, groceries, diningOut, payeeId };
}

describe('LLM Classifier Memory', () => {
  test('learns and recalls user classification overrides', async () => {
    const { accountId, groceries, diningOut, payeeId } =
      await prepareDatabase();

    // 1. Create a transaction that was categorized by AI
    const txId = await db.insertTransaction({
      account: accountId,
      amount: -1234,
      date: '2020-01-01',
      payee: payeeId,
      imported_payee: 'KROGER STORE 123',
      category: groceries,
      categorization_source: 'ai',
      categorization_date: '2026-05-29',
      categorization_note: 'AI classified',
    });

    const insertedTx = await db.select('transactions', txId);
    expect(insertedTx.categorization_source).toBe('ai');

    // 2. User overrides the category (groceries -> dining-out)
    await batchUpdateTransactions({
      updated: [
        {
          id: txId,
          category: diningOut,
        },
      ],
    });

    // 3. Verify a memory was stored in the database
    const memories = await db.all<{
      id: string;
      imported_payee: string;
      payee_name: string;
      category_id: string;
      tombstone: number;
    }>('SELECT * FROM ai_classification_memories');

    expect(memories.length).toBe(1);
    expect(memories[0]).toEqual({
      id: 'KROGER STORE 123::Kroger',
      imported_payee: 'KROGER STORE 123',
      payee_name: 'Kroger',
      category_id: diningOut,
      tombstone: 0,
    });

    // 4. Set up mock config for LLM Classification so we can run classification
    await db.update('preferences', {
      id: 'llmClassificationEnabled',
      value: 'true',
    });
    vi.mocked(asyncStorage.getItem).mockResolvedValue({
      provider: 'ollama',
      model: 'test-model',
    });

    // Mock fetch to ensure no LLM calls are made if memory bypass works
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({})));

    // 5. Create a new similar transaction that is uncategorized
    const similarTxId = await db.insertTransaction({
      account: accountId,
      amount: -5500,
      date: '2020-01-02',
      payee: payeeId,
      imported_payee: 'KROGER STORE 123',
      category: null,
    });

    // 6. Run auto-classification
    await classifyExistingUncategorizedTransactions({
      ids: [similarTxId],
    });

    // Verify LLM fetch was bypassed
    expect(fetchMock).not.toHaveBeenCalled();

    // Verify similar transaction was correctly categorized using the stored memory
    const classifiedTx = await db.select('transactions', similarTxId);
    expect(classifiedTx.category).toBe(diningOut);
    expect(classifiedTx.categorization_source).toBe('ai');
    expect(classifiedTx.categorization_note).toBe(
      'Classified based on previous user correction',
    );

    fetchMock.mockRestore();
  });

  test('manual uncategorized classification requires the global setting', async () => {
    const { accountId, payeeId } = await prepareDatabase();
    const txId = await db.insertTransaction({
      account: accountId,
      amount: -1234,
      date: '2020-01-01',
      payee: payeeId,
      imported_payee: 'KROGER STORE 123',
      category: null,
    });

    await expect(
      classifyExistingUncategorizedTransactions({ ids: [txId] }),
    ).rejects.toThrow('LLM transaction categorization is disabled.');
  });

  test('bank sync classification requires global and account enablement', async () => {
    const { accountId, payeeId } = await prepareDatabase();
    vi.mocked(asyncStorage.getItem).mockResolvedValue({
      provider: 'ollama',
      model: 'test-model',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({})));

    const trans = {
      id: 'tx1',
      account: accountId,
      amount: -1234,
      date: '2020-01-01',
      payee: payeeId,
      imported_payee: 'KROGER STORE 123',
    };

    await db.update('preferences', {
      id: `sync-llm-classify-${accountId}`,
      value: 'true',
    });
    await classifyBankSyncTransactions(accountId, [{ trans }]);
    expect(fetchMock).not.toHaveBeenCalled();

    await db.update('preferences', {
      id: 'llmClassificationEnabled',
      value: 'true',
    });
    await db.update('preferences', {
      id: `sync-llm-classify-${accountId}`,
      value: 'false',
    });
    await classifyBankSyncTransactions(accountId, [{ trans }]);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  test('clearing/removing the category deletes the memory', async () => {
    const { accountId, groceries, diningOut, payeeId } =
      await prepareDatabase();

    // 1. Create transaction categorized by AI
    const txId = await db.insertTransaction({
      account: accountId,
      amount: -1234,
      date: '2020-01-01',
      payee: payeeId,
      imported_payee: 'KROGER STORE 123',
      category: groceries,
      categorization_source: 'ai',
    });

    // 2. User overrides (groceries -> dining-out)
    await batchUpdateTransactions({
      updated: [{ id: txId, category: diningOut }], // triggers learn override
    });

    let memories = await db.all('SELECT * FROM ai_classification_memories');
    expect(memories.length).toBe(1);

    // 3. Create another transaction categorized by AI with same payee
    const txId2 = await db.insertTransaction({
      account: accountId,
      amount: -1235,
      date: '2020-01-01',
      payee: payeeId,
      imported_payee: 'KROGER STORE 123',
      category: groceries,
      categorization_source: 'ai',
    });

    // 4. User clears the category on the second AI transaction (sets to null)
    await batchUpdateTransactions({
      updated: [{ id: txId2, category: null as unknown as string }],
    });

    // Verify memory was deleted
    memories = await db.all('SELECT * FROM ai_classification_memories');
    expect(memories.length).toBe(0);
  });
});
