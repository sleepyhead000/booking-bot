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
import { detectChallenge } from '../src/core/challenge.js';
import type { Notifier, NotifyMessage } from '../src/notify/index.js';
import { initLogger, closeLogger } from '../src/util/logger.js';
import { ensureSamplePdf } from '../demo/pdf.js';

/**
 * Anti-bot challenge path, end-to-end.
 *
 * The demo portal is started with DEMO_CHALLENGE=1, which injects a full-page
 * overlay on every page that clears itself after a few seconds — exactly the
 * shape of an interactive Turnstile/Cloudflare interstitial that resolves on
 * its own. The bot must (a) notice it, (b) refuse to click through it, and
 * (c) proceed once it clears.
 */

const PORT = 4300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const OTP = '123456';
const AUTOCLEAR_MS = 4000;

let workDir: string;
let manager: BrowserManager;
let serverModule: { server?: { close(cb: () => void): void } } | undefined;
const sent: NotifyMessage[] = [];

const recorder: Notifier = {
  id: 'recorder',
  async send(msg) {
    sent.push(msg);
  },
};

function makeConfig(sessionDir: string): Config {
  return applyOverrides({
    adapter: 'reference',
    browser: { headless: true },
    session: { dir: sessionDir, maxAgeMinutes: 60 },
    monitor: { minIntervalMs: 300, maxIntervalMs: 600, backoffMaxMs: 1200, maxEmptyCycles: 0 },
    booking: {
      dateFrom: null,
      dateTo: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      applicantFile: join(workDir, 'applicant.json'),
    },
    otp: { timeoutSec: 20, maxAttempts: 2 },
    notify: { console: false, telegram: false },
    solver: { provider: 'manual', timeoutSec: 45 },
    logging: { level: 'error', dir: join(workDir, 'logs') },
  });
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/dev/state`);
      if (res.ok) {
        const state = (await res.json()) as { challenge?: boolean };
        if (state.challenge === true) return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`demo portal (challenge mode) did not start on ${BASE}`);
}

beforeAll(async () => {
  process.env.DEMO_PORT = String(PORT);
  process.env.DEMO_HOST = '127.0.0.1';
  process.env.DEMO_FIXED_OTP = OTP;
  process.env.DEMO_SLOT_RELEASE_MS = '400';
  process.env.DEMO_INITIAL_RELEASES = '6';
  process.env.DEMO_CHALLENGE = '1';
  process.env.DEMO_CHALLENGE_AUTOCLEAR_MS = String(AUTOCLEAR_MS);
  process.env.REFERENCE_BASE_URL = BASE;
  process.env.BOT_USERNAME = 'challenge-bot';
  process.env.BOT_PASSWORD = 'correct-horse';
  process.env.OTP_CODE = OTP;
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';

  workDir = mkdtempSync(join(tmpdir(), 'bot-challenge-'));
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

describe('anti-bot challenge handling', () => {
  it('detects the challenge overlay while it is present', async () => {
    const context = await manager.newContext({});
    const page = await context.newPage();
    try {
      await page.goto(BASE, { waitUntil: 'load' });
      const task = await detectChallenge(page);
      expect(task).not.toBeNull();
      expect(task!.kind).toBe('turnstile');
      expect(task!.url).toContain(BASE);
      // It must also clear itself — otherwise nothing downstream could proceed.
      await page.waitForSelector('#challenge-page', { state: 'detached', timeout: AUTOCLEAR_MS + 5000 });
      expect(await detectChallenge(page)).toBeNull();
    } finally {
      await context.close();
    }
  }, 40_000);

  it('notices the challenge, waits it out, and still completes the run', async () => {
    const config = makeConfig(join(workDir, 'sessions'));
    const adapter = await loadAdapter('reference');
    const session = new SessionStore(config);
    const application = loadApplication(config);

    const runner = new BookingRunner({
      config,
      adapter,
      notifier: recorder,
      session,
      manager,
      filter: {
        dateFrom: config.booking.dateFrom,
        dateTo: config.booking.dateTo,
        weekdays: config.booking.weekdays,
      },
      credentials: { username: process.env.BOT_USERNAME, password: process.env.BOT_PASSWORD },
      application,
    });

    const result = await runner.run('inspect');

    expect(result.status).toBe('inspect');
    expect(Array.isArray(result.slots)).toBe(true);

    // The bot must have observed and reported the blockage, not silently
    // clicked through the overlay.
    const challengeMsgs = sent.filter((m) => m.title.startsWith('Challenge detected'));
    expect(challengeMsgs.length).toBeGreaterThan(0);
    expect(challengeMsgs[0]!.body).toContain('startup');
  }, 180_000);
});
