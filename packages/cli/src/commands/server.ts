import * as api from '@actual-app/api';
import { Option } from 'commander';
import type { Command } from 'commander';

import { withConnection } from '#connection';
import { printOutput } from '#output';

import { runBankSyncWorker } from './bank-sync-worker';

export function registerServerCommand(program: Command) {
  const server = program.command('server').description('Server utilities');

  server
    .command('version')
    .description('Get server version')
    .action(async () => {
      const opts = program.opts();
      await withConnection(
        opts,
        async () => {
          const version = await api.getServerVersion();
          printOutput({ version }, opts.format);
        },
        { mutates: false, skipBudget: true },
      );
    });

  server
    .command('get-id')
    .description('Get entity ID by name')
    .addOption(
      new Option('--type <type>', 'Entity type')
        .choices(['accounts', 'categories', 'payees', 'schedules'])
        .makeOptionMandatory(),
    )
    .requiredOption('--name <name>', 'Entity name')
    .action(async cmdOpts => {
      const opts = program.opts();
      await withConnection(
        opts,
        async () => {
          const id = await api.getIDByName(cmdOpts.type, cmdOpts.name);
          printOutput(
            { id, type: cmdOpts.type, name: cmdOpts.name },
            opts.format,
          );
        },
        { mutates: false },
      );
    });

  server
    .command('bank-sync')
    .description('Run bank synchronization')
    .option('--account <id>', 'Specific account ID to sync')
    .action(async cmdOpts => {
      const opts = program.opts();
      await withConnection(
        opts,
        async () => {
          const args = cmdOpts.account
            ? { accountId: cmdOpts.account }
            : undefined;
          await api.runBankSync(args);
          printOutput({ success: true }, opts.format);
        },
        { mutates: true },
      );
    });

  server
    .command('bank-sync-worker')
    .description('Run bank synchronization on a daily schedule')
    .option('--account <id>', 'Specific account ID to sync')
    .option(
      '--schedule <HH:mm>',
      'Daily run time in 24-hour time (env: ACTUAL_DAILY_SYNC_TIME; default: 06:00)',
    )
    .option(
      '--timezone <iana>',
      'IANA timezone for --schedule (env: ACTUAL_DAILY_SYNC_TIMEZONE; default: America/New_York)',
    )
    .option(
      '--run-on-start',
      'Run immediately before waiting for the next scheduled run (env: RUN_ON_START)',
      false,
    )
    .option(
      '--llm-config-file <path>',
      'JSON file containing LLM classification config (env: ACTUAL_LLM_CLASSIFICATION_CONFIG_FILE)',
    )
    .option('--once', 'Run once and exit', false)
    .action(async cmdOpts => {
      const opts = program.opts();
      await runBankSyncWorker(opts, cmdOpts);
    });
}
