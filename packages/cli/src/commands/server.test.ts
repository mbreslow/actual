import { Command } from 'commander';

import { runBankSyncWorker } from './bank-sync-worker';
import { registerServerCommand } from './server';

vi.mock('@actual-app/api', () => ({
  runBankSync: vi.fn().mockResolvedValue(undefined),
  saveGlobalPrefs: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('#connection', () => ({
  withConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./bank-sync-worker', () => ({
  runBankSyncWorker: vi.fn().mockResolvedValue(undefined),
}));

function program() {
  const p = new Command();
  p.exitOverride();
  p.option('--server-url <url>');
  p.option('--password <password>');
  p.option('--sync-id <id>');
  p.option('--format <fmt>');
  registerServerCommand(p);
  return p;
}

describe('actual server bank-sync-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the scheduled bank sync worker with command options', async () => {
    await program().parseAsync([
      'node',
      'actual',
      '--server-url',
      'http://test',
      '--password',
      'pw',
      '--sync-id',
      'sync-1',
      'server',
      'bank-sync-worker',
      '--account',
      'acct-1',
      '--schedule',
      '07:30',
      '--timezone',
      'Europe/London',
      '--llm-config-file',
      '/run/secrets/llm.json',
      '--run-on-start',
    ]);

    expect(runBankSyncWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'http://test',
        password: 'pw',
        syncId: 'sync-1',
      }),
      expect.objectContaining({
        account: 'acct-1',
        schedule: '07:30',
        timezone: 'Europe/London',
        llmConfigFile: '/run/secrets/llm.json',
        runOnStart: true,
      }),
    );
  });
});
