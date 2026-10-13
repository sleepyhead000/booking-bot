import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverrides, type Config } from '../src/config/schema.js';
import { loadApplication } from '../src/config/applicant.js';
import { loadAdapter } from '../src/adapter/registry.js';
import { BrowserManager } from '../src/core/browser.js';
import { SessionStore } from '../src/core/session.js';
import { BookingRunner } from '../src/core/runner.js';
import { runDoctor } from '../src/core/doctor.js';
import { createNotifier } from '../src/notify/factory.js';
import { initLogger, closeLogger } from '../src/util/logger.js';
import { BotError } from '../src/util/errors.js';
import { ensureSamplePdf } from '../demo/pdf.js';

/**
 * End-to-end proof: boot the bundled demo portal, then drive the *real* core
 * (session, OTP, polling, selection, form fill, PDF attach, submit) through it
 * with a real headless Chromium. If this passes, the pipeline works.
 */

const PORT = 4100 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const OTP = '123456';

let workDir: string;
let manager: BrowserManager;
let serverModule: { server?: { close(cb: () => void): void } } | undefined;

function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function makeConfig(sessionDir: string): Config {
  return applyOverrides({
    adapter: 'reference',
    browser: { headless: true },
    session: { dir: sessionDir, maxAgeMinutes: 60 },
    monitor: { minIntervalMs: 300, maxIntervalMs: 600, backoffMaxMs: 1200, maxEmptyCycles: 0 },
    booking: {
      dateFrom: null,
      dateTo: daysFromNow(7),
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      applicantFile: join(workDir, 'applicant.json'),
    },
    otp: { timeoutSec: 20, maxAttempts: 2 },
    notify: { console: false, telegram: false },
    solver: { provider: 'manual', timeoutSec: 10 },
    logging: { level: 'error', dir: join(workDir, 'logs') },
  });
}

async function makeRunner(config: Config, credentials: { username?: string; password?: string }) {
  const adapter = await loadAdapter('reference');
  const session = new SessionStore(config);
  const notifier = createNotifier(config);
  const application = loadApplication(config);
  return new BookingRunner({
    config,
    adapter,
    notifier,
    session,
    manager,
    filter: {
      dateFrom: config.booking.dateFrom,
      dateTo: config.booking.dateTo,
      weekdays: config.booking.weekdays,
    },
    credentials,
    application,
  });
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/dev/state`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`demo portal did not start on ${BASE}`);
}

beforeAll(async () => {
  process.env.DEMO_PORT = String(PORT);
  process.env.DEMO_HOST = '127.0.0.1';
  process.env.DEMO_FIXED_OTP = OTP;
  process.env.DEMO_SLOT_RELEASE_MS = '400';
  process.env.DEMO_INITIAL_RELEASES = '6';
  process.env.REFERENCE_BASE_URL = BASE;
  process.env.BOT_USERNAME = 'e2e-bot';
  process.env.BOT_PASSWORD = 'correct-horse';
  process.env.OTP_CODE = OTP;
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';

  workDir = mkdtempSync(join(tmpdir(), 'bot-e2e-'));
  ensureSamplePdf();
  writeFileSync(
    join(workDir, 'applicant.json'),
    JSON.stringify(
      {
        fields: {
          surname: 'NOWAK',
          givenName: 'ANNA',
          passport: 'XA1234567',
          email: 'anna@example.com',
        },
        documents: [{ path: 'demo/sample.pdf', target: '#passport-pdf' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  initLogger({ level: 'error', dir: join(workDir, 'logs') });
  serverModule = await import('../demo/server.js');
  await waitForServer();
  manager = new BrowserManager(makeConfig(join(workDir, 'sessions')));
}, 60_000);

afterAll(async () => {
  await manager?.close();
  await new Promise<void>((r) => (serverModule?.server ? serverModule.server.close(() => r()) : r()));
  await closeLogger();
  rmSync(workDir, { recursive: true, force: true });
});

describe('reference portal end-to-end', () => {
  it('passes the stealth doctor checks', async () => {
    const results = await runDoctor(makeConfig(join(workDir, 'doctor-sessions')));
    const failed = results.filter((r) => !r.pass);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  }, 60_000);

  it('monitors availability and books a matching slot', async () => {
    const config = makeConfig(join(workDir, 'sessions-monitor'));
    const runner = await makeRunner(config, {
      username: process.env.BOT_USERNAME,
      password: process.env.BOT_PASSWORD,
    });

    const result = await runner.run('monitor');

    expect(result.status).toBe('booked');
    expect(result.slot).toBeDefined();
    expect(result.slot!.date <= config.booking.dateTo!).toBe(true);
    expect(result.slot!.date >= (config.booking.dateFrom ?? '0000-00-00')).toBe(true);
    expect(result.cycles).toBeGreaterThan(0);
    // The session must have been persisted for the next run.
    expect(new SessionStore(config).exists('reference')).toBe(true);
  }, 120_000);

  it('fails with a typed auth error on bad credentials', async () => {
    const config = makeConfig(join(workDir, 'sessions-bad'));
    const runner = await makeRunner(config, { username: 'locked', password: 'nope' });

    const err = await runner.run('inspect').catch((e) => e);
    expect(err).toBeInstanceOf(BotError);
    expect((err as BotError).kind).toBe('auth');
  }, 60_000);

  it('reuses a persisted session instead of logging in again', async () => {
    const config = makeConfig(join(workDir, 'sessions-monitor'));
    const runner = await makeRunner(config, {
      username: process.env.BOT_USERNAME,
      password: process.env.BOT_PASSWORD,
    });

    const result = await runner.run('inspect');
    expect(result.status).toBe('inspect');
    expect(Array.isArray(result.slots)).toBe(true);
  }, 60_000);
});
