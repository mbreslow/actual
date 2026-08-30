import { readFileSync } from 'node:fs';

import * as api from '@actual-app/api';
import type { LLMClassificationConfig } from '@actual-app/api';

import type { CliGlobalOpts } from '#config';
import { withConnection } from '#connection';
import { parseBoolEnv } from '#utils';

export type BankSyncWorkerOptions = {
  account?: string;
  once?: boolean;
  runOnStart?: boolean;
  schedule?: string;
  timezone?: string;
  llmConfigFile?: string;
};

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_SCHEDULE = '06:00';
const DEFAULT_TIMEZONE = 'America/New_York';
const MAX_TIMEOUT_MS = 2_147_483_647;
const LLM_PROVIDERS = new Set([
  'ollama',
  'openai',
  'anthropic',
  'google',
  'googleVertex',
  'amazonBedrock',
]);

function parseSchedule(schedule: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule);
  if (!match) {
    throw new Error(
      `Invalid bank sync schedule "${schedule}". Expected HH:mm in 24-hour time.`,
    );
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function assertValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid bank sync timezone "${timezone}".`);
  }
}

function getTimeZoneParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function getTimeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = getTimeZoneParts(date, timezone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtc - date.getTime();
}

function zonedLocalTimeToUtc(
  localDate: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timezone: string,
): Date {
  const localAsUtc = Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day,
    time.hour,
    time.minute,
    0,
  );
  let utc = localAsUtc - getTimeZoneOffsetMs(new Date(localAsUtc), timezone);
  utc = localAsUtc - getTimeZoneOffsetMs(new Date(utc), timezone);
  return new Date(utc);
}

function addLocalDays(
  localDate: { year: number; month: number; day: number },
  days: number,
) {
  const date = new Date(
    Date.UTC(localDate.year, localDate.month - 1, localDate.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function getNextDailyRunAt({
  now = new Date(),
  schedule,
  timezone,
}: {
  now?: Date;
  schedule: string;
  timezone: string;
}): Date {
  assertValidTimeZone(timezone);
  const time = parseSchedule(schedule);
  const today = getTimeZoneParts(now, timezone);
  let candidate = zonedLocalTimeToUtc(today, time, timezone);
  if (candidate.getTime() <= now.getTime()) {
    candidate = zonedLocalTimeToUtc(addLocalDays(today, 1), time, timezone);
  }
  return candidate;
}

function envFlag(name: string): boolean | undefined {
  return parseBoolEnv(process.env[name], name);
}

function readStringEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  return parsed;
}

function validateLLMClassificationConfig(
  config: unknown,
): LLMClassificationConfig {
  if (
    !isRecord(config) ||
    typeof config.provider !== 'string' ||
    !LLM_PROVIDERS.has(config.provider)
  ) {
    throw new Error(
      'Invalid LLM classification config: missing or unsupported provider.',
    );
  }

  if (config.provider !== 'ollama' && !config.apiKey) {
    throw new Error(
      'Invalid LLM classification config: apiKey is required for this provider.',
    );
  }

  const stringKeys = [
    'model',
    'endpoint',
    'apiKey',
    'vertexProjectId',
    'vertexLocation',
    'bedrockRegion',
  ];
  const numberKeys = ['timeoutMs', 'batchSize'];
  for (const key of stringKeys) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new Error(
        `Invalid LLM classification config: ${key} must be a string.`,
      );
    }
  }
  for (const key of numberKeys) {
    if (config[key] !== undefined && typeof config[key] !== 'number') {
      throw new Error(
        `Invalid LLM classification config: ${key} must be a number.`,
      );
    }
  }
  if (config.apiKeys !== undefined) {
    if (
      !isRecord(config.apiKeys) ||
      Object.values(config.apiKeys).some(value => typeof value !== 'string')
    ) {
      throw new Error(
        'Invalid LLM classification config: apiKeys must contain only strings.',
      );
    }
  }

  return config;
}

function loadLLMClassificationConfig(
  filePath: string | undefined,
): LLMClassificationConfig | undefined {
  if (!filePath) return undefined;
  return validateLLMClassificationConfig(readJsonFile(filePath));
}

export function resolveWorkerOptions(options: BankSyncWorkerOptions) {
  const schedule =
    options.schedule ?? process.env.ACTUAL_DAILY_SYNC_TIME ?? DEFAULT_SCHEDULE;
  const timezone =
    options.timezone ??
    process.env.ACTUAL_DAILY_SYNC_TIMEZONE ??
    process.env.TZ ??
    DEFAULT_TIMEZONE;
  const runOnStart = options.runOnStart
    ? true
    : (envFlag('RUN_ON_START') ?? true);
  const llmConfigFile =
    options.llmConfigFile ??
    readStringEnv('ACTUAL_LLM_CLASSIFICATION_CONFIG_FILE');

  parseSchedule(schedule);
  assertValidTimeZone(timezone);

  return {
    account: options.account,
    once: options.once ?? false,
    runOnStart,
    schedule,
    timezone,
    llmConfigFile,
  };
}

function workerLog(message: string) {
  process.stderr.write(`[bank-sync-worker] ${message}\n`);
}

export async function runBankSyncOnce(
  globalOpts: CliGlobalOpts,
  options: Pick<BankSyncWorkerOptions, 'account' | 'llmConfigFile'> = {},
) {
  const startedAt = new Date();
  workerLog(`run started at ${startedAt.toISOString()}`);
  await withConnection(
    globalOpts,
    async () => {
      const llmClassificationConfig = loadLLMClassificationConfig(
        options.llmConfigFile,
      );
      if (llmClassificationConfig) {
        await api.saveGlobalPrefs({ llmClassificationConfig });
        workerLog(
          `LLM classification config loaded for provider ${llmClassificationConfig.provider}`,
        );
      }

      await api.runBankSync(
        options.account ? { accountId: options.account } : undefined,
      );
    },
    { mutates: true },
  );
  workerLog(
    `run finished at ${new Date().toISOString()} (${Date.now() - startedAt.getTime()}ms)`,
  );
}

export async function runBankSyncWorker(
  globalOpts: CliGlobalOpts,
  options: BankSyncWorkerOptions,
): Promise<void> {
  const workerOptions = resolveWorkerOptions(options);

  if (workerOptions.once) {
    await runBankSyncOnce(globalOpts, {
      account: workerOptions.account,
      llmConfigFile: workerOptions.llmConfigFile,
    });
    return;
  }

  let activeTimer: Timer | null = null;

  const scheduleNext = () => {
    const nextRunAt = getNextDailyRunAt({
      schedule: workerOptions.schedule,
      timezone: workerOptions.timezone,
    });
    const delay = Math.min(
      Math.max(0, nextRunAt.getTime() - Date.now()),
      MAX_TIMEOUT_MS,
    );

    workerLog(
      `next run scheduled for ${nextRunAt.toISOString()} (${workerOptions.schedule} ${workerOptions.timezone})`,
    );

    activeTimer = setTimeout(() => {
      void executeAndReschedule();
    }, delay);
  };

  const stop = () => {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
  };

  const executeAndReschedule = async () => {
    stop();
    try {
      await runBankSyncOnce(globalOpts, {
        account: workerOptions.account,
        llmConfigFile: workerOptions.llmConfigFile,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      workerLog(`run failed: ${message}`);
    } finally {
      scheduleNext();
    }
  };

  let finishShutdown: () => void;
  const shutdown = new Promise<void>(resolve => {
    finishShutdown = resolve;
  });

  process.once('SIGINT', () => {
    stop();
    process.exitCode = 130;
    finishShutdown();
  });
  process.once('SIGTERM', () => {
    stop();
    process.exitCode = 143;
    finishShutdown();
  });

  if (workerOptions.runOnStart) {
    await executeAndReschedule();
  } else {
    scheduleNext();
  }

  await shutdown;
}
