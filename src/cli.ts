#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, loadEnv, secrets, type LoadOptions } from './config/load.js';
import type { Config, TargetFilter } from './config/schema.js';
import { loadApplication } from './config/applicant.js';
import { initLogger, closeLogger, logger } from './util/logger.js';
import { LockFile } from './util/lockfile.js';
import { BotError, toBotError } from './util/errors.js';
import { loadAdapter, listAdapters } from './adapter/registry.js';
import { BrowserManager } from './core/browser.js';
import { SessionStore } from './core/session.js';
import { BookingRunner, type RunMode, type RunResult } from './core/runner.js';
import { runDoctor } from './core/doctor.js';
import { createNotifier } from './notify/factory.js';
import { availableSolvers } from './solver/registry.js';

interface GlobalOpts {
  config?: string;
  set?: string[];
  headed?: boolean;
  adapter?: string;
  dateFrom?: string;
  dateTo?: string;
  weekdays?: string;
  logLevel?: string;
  lock?: boolean;
}

function buildOverrides(opts: GlobalOpts): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const entry of opts.set ?? []) {
    const idx = entry.indexOf('=');
    if (idx <= 0) throw new BotError('config', `--set expects path=value, got "${entry}"`);
    overrides[entry.slice(0, idx)] = coerce(entry.slice(idx + 1));
  }
  if (opts.headed) overrides['browser.headless'] = false;
  if (opts.adapter) overrides.adapter = opts.adapter;
  if (opts.logLevel) overrides['logging.level'] = opts.logLevel;
  return overrides;
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

function buildConfig(opts: GlobalOpts): Config {
  const loadOpts: LoadOptions = { overrides: buildOverrides(opts) };
  if (opts.config) loadOpts.configPath = opts.config;
  return loadConfig(loadOpts);
}

function buildFilter(config: Config, opts: GlobalOpts): TargetFilter {
  const weekdays = opts.weekdays
    ? opts.weekdays
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : config.booking.weekdays;

  return {
    dateFrom: opts.dateFrom ?? config.booking.dateFrom,
    dateTo: opts.dateTo ?? config.booking.dateTo,
    weekdays,
  };
}

/** Shared bootstrap for every command that touches a browser. */
async function withRuntime<T>(
  opts: GlobalOpts,
  fn: (ctx: {
    config: Config;
    lock: LockFile;
  }) => Promise<T>,
): Promise<T> {
  const config = buildConfig(opts);
  initLogger({ level: config.logging.level, dir: config.logging.dir });
  const lock = new LockFile();
  if (opts.lock !== false) lock.acquire();
  try {
    return await fn({ config, lock });
  } finally {
    lock.release();
    await closeLogger();
  }
}

async function runBooking(opts: GlobalOpts & { mode: RunMode; skipApplication?: boolean }): Promise<RunResult> {
  return withRuntime(opts, async ({ config }) => {
    loadEnv();
    const adapter = await loadAdapter(config.adapter);
    const filter = buildFilter(config, opts);
    const notifier = createNotifier(config);
    const session = new SessionStore(config);
    const manager = new BrowserManager(config);
    const application = opts.skipApplication ? { fields: {}, documents: [] } : loadApplication(config);

    const controller = new AbortController();
    let shuttingDown = false;
    const onSigint = () => {
      if (shuttingDown) process.exit(130);
      shuttingDown = true;
      logger().warn('shutdown requested — finishing current step (Ctrl+C again to force)');
      controller.abort();
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigint);

    const runner = new BookingRunner({
      config,
      adapter,
      notifier,
      session,
      manager,
      filter,
      credentials: { username: secrets.username, password: secrets.password },
      application,
      signal: controller.signal,
    });

    try {
      return await runner.run(opts.mode);
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
      await manager.close();
    }
  });
}

function report(result: RunResult): number {
  switch (result.status) {
    case 'booked':
      console.log(`\n✔ Booked: ${result.slot?.label ?? 'unknown slot'}`);
      return 0;
    case 'inspect':
      console.log(`\n${result.slots?.length ?? 0} matching slot(s) — ${result.detail ?? ''}`);
      for (const s of result.slots ?? []) console.log(`  • ${s.label}`);
      return (result.slots?.length ?? 0) > 0 ? 0 : 2;
    case 'no-slot':
      console.log(`\nNo matching slot. ${result.detail ?? ''} (cycles: ${result.cycles})`);
      return 2;
    case 'cancelled':
      console.log('\nCancelled.');
      return 130;
  }
}

const program = new Command();

program
  .name('booking-bot')
  .description('Portal-agnostic web booking & slot monitoring bot')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to YAML config', 'config/default.yaml')
  .option('-s, --set <path=value>', 'override a config value (repeatable)', collect, [])
  .option('--headed', 'run with a visible browser window')
  .option('-a, --adapter <id>', 'portal adapter to use')
  .option('--date-from <YYYY-MM-DD>', 'earliest acceptable date')
  .option('--date-to <YYYY-MM-DD>', 'latest acceptable date')
  .option('--weekdays <list>', 'comma-separated weekdays, e.g. 1,2,3,4,5')
  .option('--log-level <level>', 'trace|debug|info|warn|error|fatal')
  .option('--no-lock', 'allow concurrent instances (disables the single-run lock)');

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

program
  .command('doctor')
  .description('launch a browser and verify the stealth/detection surface')
  .option('--url <url>', 'optional page to navigate to for an external probe')
  .action(async (cmdOpts: { url?: string }, command: Command) => {
    const opts = command.optsWithGlobals() as GlobalOpts;
    const config = buildConfig(opts);
    initLogger({ level: config.logging.level, dir: config.logging.dir });
    const results = await runDoctor(config, { url: cmdOpts.url, headed: opts.headed === true });

    let failed = 0;
    console.log('\nbot doctor');
    console.log('──────────');
    for (const r of results) {
      if (!r.pass) failed++;
      console.log(`${r.pass ? '✔' : '✘'} ${r.name.padEnd(34)} ${r.detail}`);
    }
    console.log(
      failed === 0
        ? '\nAll checks passed.'
        : `\n${failed} check(s) failed — the site can likely detect this browser.`,
    );
    await closeLogger();
    process.exit(failed === 0 ? 0 : 1);
  });

program
  .command('login')
  .description('authenticate interactively and persist the session (never books)')
  .action(async (_cmdOpts, command: Command) => {
    const opts = command.optsWithGlobals() as GlobalOpts;
    try {
      const config = buildConfig(opts);
      await runBooking({ ...opts, mode: 'inspect', skipApplication: true });
      console.log(`\n✔ Authenticated — session stored in ${config.session.dir}`);
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('inspect')
  .description('authenticate and print currently matching availability, then exit')
  .action(async (_cmdOpts, command: Command) => {
    const opts = command.optsWithGlobals() as GlobalOpts;
    try {
      const result = await runBooking({ ...opts, mode: 'inspect' });
      process.exit(report(result));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('run')
  .description('single pass: check availability once and book if something matches')
  .action(async (_cmdOpts, command: Command) => {
    const opts = command.optsWithGlobals() as GlobalOpts;
    try {
      const result = await runBooking({ ...opts, mode: 'once' });
      process.exit(report(result));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('monitor')
  .description('poll continuously until a target slot appears, then book it')
  .action(async (_cmdOpts, command: Command) => {
    const opts = command.optsWithGlobals() as GlobalOpts;
    try {
      const result = await runBooking({ ...opts, mode: 'monitor' });
      process.exit(report(result));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('info')
  .description('show resolved configuration and available adapters/solvers')
  .action((_cmdOpts, command: Command) => {
    const opts = command.optsWithGlobals() as GlobalOpts;
    const config = buildConfig(opts);
    console.log(
      JSON.stringify(
        {
          adapter: config.adapter,
          availableAdapters: listAdapters(),
          availableSolvers: availableSolvers(),
          browser: config.browser,
          monitor: config.monitor,
          booking: config.booking,
          notify: config.notify,
          secrets: {
            username: secrets.username ? 'set' : 'missing',
            password: secrets.password ? 'set' : 'missing',
            proxy: secrets.proxyUrl ? 'set' : 'none',
            telegram: secrets.telegramToken && secrets.telegramChatId ? 'set' : 'not configured',
            solverKey: secrets.solverApiKey ? 'set' : 'none',
          },
        },
        null,
        2,
      ),
    );
  });

function fail(err: unknown): never {
  const e = toBotError(err);
  console.error(`\n✘ ${e.kind}: ${e.message}`);
  process.exit(e.kind === 'config' ? 64 : 1);
}

program.parseAsync(process.argv).catch(fail);
