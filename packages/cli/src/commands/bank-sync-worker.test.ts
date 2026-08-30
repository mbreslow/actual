import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as api from '@actual-app/api';

import { withConnection } from '#connection';

import {
  getNextDailyRunAt,
  resolveWorkerOptions,
  runBankSyncOnce,
} from './bank-sync-worker';

vi.mock('@actual-app/api', () => ({
  runBankSync: vi.fn().mockResolvedValue(undefined),
  saveGlobalPrefs: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('#connection', () => ({
  withConnection: vi.fn(async (_globalOpts, fn) => fn({})),
}));

describe('bank sync worker scheduling', () => {
  it('runs immediately by default and supports an environment opt-out', () => {
    const originalRunOnStart = process.env.RUN_ON_START;
    try {
      delete process.env.RUN_ON_START;
      expect(resolveWorkerOptions({}).runOnStart).toBe(true);

      process.env.RUN_ON_START = 'false';
      expect(resolveWorkerOptions({}).runOnStart).toBe(false);
    } finally {
      if (originalRunOnStart === undefined) {
        delete process.env.RUN_ON_START;
      } else {
        process.env.RUN_ON_START = originalRunOnStart;
      }
    }
  });

  it('schedules later today when the local run time has not passed', () => {
    const nextRunAt = getNextDailyRunAt({
      now: new Date('2026-06-27T09:00:00.000Z'),
      schedule: '06:00',
      timezone: 'America/New_York',
    });

    expect(nextRunAt.toISOString()).toBe('2026-06-27T10:00:00.000Z');
  });

  it('schedules tomorrow when the local run time has already passed', () => {
    const nextRunAt = getNextDailyRunAt({
      now: new Date('2026-06-27T11:00:00.000Z'),
      schedule: '06:00',
      timezone: 'America/New_York',
    });

    expect(nextRunAt.toISOString()).toBe('2026-06-28T10:00:00.000Z');
  });

  it('uses the timezone offset for the scheduled local time', () => {
    const nextRunAt = getNextDailyRunAt({
      now: new Date('2026-01-10T09:00:00.000Z'),
      schedule: '06:00',
      timezone: 'America/New_York',
    });

    expect(nextRunAt.toISOString()).toBe('2026-01-10T11:00:00.000Z');
  });

  it('rejects invalid schedules', () => {
    expect(() =>
      getNextDailyRunAt({
        now: new Date('2026-06-27T09:00:00.000Z'),
        schedule: '6am',
        timezone: 'America/New_York',
      }),
    ).toThrow(/Expected HH:mm/);
  });

  it('loads LLM classification config before running bank sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actual-cli-worker-'));
    try {
      const configPath = join(dir, 'llm-config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          provider: 'openai',
          model: 'gpt-4o-mini',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          apiKey: 'secret',
          timeoutMs: 180000,
          batchSize: 12,
        }),
      );

      await runBankSyncOnce(
        { serverUrl: 'http://test', password: 'pw', syncId: 'sync-1' },
        { llmConfigFile: configPath },
      );

      expect(withConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        { mutates: true },
      );
      expect(api.saveGlobalPrefs).toHaveBeenCalledWith({
        llmClassificationConfig: expect.objectContaining({
          provider: 'openai',
          apiKey: 'secret',
        }),
      });
      expect(api.runBankSync).toHaveBeenCalledWith(undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
