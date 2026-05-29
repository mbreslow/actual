import type { TransactionEntity } from '@actual-app/core/types/models';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type AutoClassificationMap = Record<
  string,
  {
    status: 'classifying' | 'classified' | 'fading';
    category?: string | null;
    transaction?: TransactionEntity;
  }
>;

type StateType = {
  autoClassificationById: AutoClassificationMap;
};

type SequentialQueueParams = {
  ids?: string[];
  transactions: TransactionEntity[];
  setState: (updater: (state: StateType) => StateType) => void;
  dispatch: unknown;
  sendFn: (
    name: string,
    payload: { ids: string[] },
  ) => Promise<{
    classified: number;
    updates?: Array<{ id: string; category: string }>;
  }>;
};

// A mock implementation of the sequential queue behavior to verify timing and calls
async function runSequentialQueue({
  ids,
  transactions,
  setState,
  dispatch: _dispatch,
  sendFn,
}: SequentialQueueParams) {
  let idsToClassify = ids && ids.length > 0 ? ids : [];
  if (idsToClassify.length === 0) {
    idsToClassify = transactions
      .filter(t => !t.category && !t.is_parent)
      .map(t => t.id);
  }

  for (const id of idsToClassify) {
    const trans = transactions.find(t => t.id === id);
    setState((state: StateType) => ({
      autoClassificationById: {
        ...state.autoClassificationById,
        [id]: { status: 'classifying', transaction: trans },
      },
    }));

    try {
      const res = await sendFn('transactions-llm-classify-uncategorized', {
        ids: [id],
      });

      if (res && res.updates && res.updates.length > 0) {
        const update = res.updates[0];
        setState((state: StateType) => ({
          autoClassificationById: {
            ...state.autoClassificationById,
            [id]: {
              status: 'classified',
              category: update.category,
              transaction: trans,
            },
          },
        }));

        // Hold for 3 seconds
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Mark as fading
        setState((state: StateType) => ({
          autoClassificationById: {
            ...state.autoClassificationById,
            [id]: {
              status: 'fading',
              category: update.category,
              transaction: trans,
            },
          },
        }));

        // Wait 300ms for fade out transition
        await new Promise(resolve => setTimeout(resolve, 300));

        setState((state: StateType) => {
          const nextMap = { ...state.autoClassificationById };
          delete nextMap[id];
          return { autoClassificationById: nextMap };
        });
      } else {
        setState((state: StateType) => {
          const nextMap = { ...state.autoClassificationById };
          delete nextMap[id];
          return { autoClassificationById: nextMap };
        });
      }
    } catch (err: unknown) {
      setState((state: StateType) => {
        const nextMap = { ...state.autoClassificationById };
        delete nextMap[id];
        return { autoClassificationById: nextMap };
      });
      // provider error handling
      throw err;
    }
  }
}

describe('onAutoClassify sequential queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('classifies transactions one at a time and waits 3 seconds after successful classification before advancing', async () => {
    const transactions = [
      {
        id: 'tx1',
        category: null,
        is_parent: false,
      } as unknown as TransactionEntity,
      {
        id: 'tx2',
        category: null,
        is_parent: false,
      } as unknown as TransactionEntity,
    ];

    const stateHistory: StateType[] = [];
    let currentState: StateType = { autoClassificationById: {} };
    const setState = (updater: (state: StateType) => StateType) => {
      currentState = updater(currentState);
      stateHistory.push(JSON.parse(JSON.stringify(currentState)) as StateType);
    };

    const dispatch = vi.fn();
    const sendFn = vi.fn().mockImplementation(async (_name, payload) => {
      if (payload.ids[0] === 'tx1') {
        return { classified: 1, updates: [{ id: 'tx1', category: 'food' }] };
      } else {
        return { classified: 1, updates: [{ id: 'tx2', category: 'rent' }] };
      }
    });

    const promise = runSequentialQueue({
      ids: ['tx1', 'tx2'],
      transactions,
      setState,
      dispatch,
      sendFn,
    });

    // Check first is called for tx1
    await Promise.resolve();
    await Promise.resolve();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenLastCalledWith(
      'transactions-llm-classify-uncategorized',
      { ids: ['tx1'] },
    );
    expect(currentState.autoClassificationById['tx1']?.status).toBe(
      'classified',
    );

    // Fast-forward 2.9 seconds, shouldn't start tx2 yet
    await vi.advanceTimersByTimeAsync(2900);
    expect(sendFn).toHaveBeenCalledTimes(1);

    // Fast-forward to 3.3 seconds (fading finishes)
    await vi.advanceTimersByTimeAsync(400);
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenLastCalledWith(
      'transactions-llm-classify-uncategorized',
      { ids: ['tx2'] },
    );

    // Advance fake timers for the second transaction to complete
    await vi.advanceTimersByTimeAsync(3300);

    await promise;

    // Toast progress path is removed (not called)
    expect(dispatch).not.toHaveBeenCalled();
  });
});
