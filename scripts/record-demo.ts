/**
 * Record the README demo.
 *
 * Boots the bundled demo portal, drives the *real* core (BookingRunner) in
 * monitor mode with Chromium video capture, and writes a .webm that
 * `npm run demo:encode` turns into the MP4 embedded in the README.
 *
 *   npm run demo:record      # produces .demo-capture/session.webm
 *   npm run demo:encode      # converts it to docs/demo.mp4
 *
 * The video is a genuine recording of the bot working — no mock, no cuts.
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOverrides, type Config } from '../src/config/schema.js';
import { loadApplication } from '../src/config/applicant.js';
import { loadAdapter } from '../src/adapter/registry.js';
import { BrowserManager } from '../src/core/browser.js';
import { SessionStore } from '../src/core/session.js';
import { BookingRunner } from '../src/core/runner.js';
import { nullNotifier } from '../src/notify/index.js';
import { initLogger, closeLogger } from '../src/util/logger.js';
import { ensureSamplePdf } from '../demo/pdf.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.DEMO_PORT ?? 4173);
const BASE = `http://127.0.0.1:${PORT}`;
const OTP = '123456';
const CAPTURE_DIR = join(ROOT, '.demo-capture');
const OUT_WEBM = join(CAPTURE_DIR, 'session.webm');

type DemoServer = { server?: { close(cb: () => void): void } };

/** Everything the demo portal and the adapter read at import time. */
process.env.DEMO_PORT = String(PORT);
process.env.DEMO_HOST = '127.0.0.1';
process.env.DEMO_FIXED_OTP = OTP;
// Start with an empty calendar so the video shows the bot *waiting*, then
// watching slots arrive — the behaviour that matters.
process.env.DEMO_INITIAL_RELEASES = '0';
process.env.DEMO_SLOT_RELEASE_MS = '1200';
process.env.REFERENCE_BASE_URL = BASE;
process.env.BOT_USERNAME = 'demo-bot';
process.env.BOT_PASSWORD = 'correct-horse';
process.env.OTP_CODE = OTP;
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

function configFor(workDir: string): Config {
  return applyOverrides({
    adapter: 'reference',
    browser: { headless: true, viewport: [1280, 720], timezoneId: 'UTC' },
    session: { dir: join(workDir, 'sessions'), maxAgeMinutes: 30 },
    monitor: { minIntervalMs: 700, maxIntervalMs: 1400, backoffMaxMs: 2000, maxEmptyCycles: 0 },
    booking: {
      dateFrom: null,
      dateTo: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      applicantFile: join(workDir, 'applicant.json'),
    },
    otp: { timeoutSec: 30, maxAttempts: 2 },
    notify: { console: false, telegram: false },
    solver: { provider: 'manual', timeoutSec: 30 },
    logging: { level: 'error', dir: join(workDir, 'logs') },
  });
}

async function waitForDemo(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/dev/state`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`demo portal did not start on ${BASE}`);
}

async function main(): Promise<void> {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'demo-record-'));
  ensureSamplePdf();
  writeFileSync(
    join(workDir, 'applicant.json'),
    JSON.stringify(
      {
        fields: {
          surname: 'KOWALSKA',
          givenName: 'MARIA',
          passport: 'XA9876543',
          email: 'maria@example.com',
        },
        documents: [{ path: 'demo/sample.pdf', target: '#passport-pdf' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  initLogger({ level: 'error', dir: join(workDir, 'logs') });
  console.log(`starting demo portal on ${BASE} …`);
  const demo = (await import('../demo/server.js')) as DemoServer;
  await waitForDemo();

  const config = configFor(workDir);
  const adapter = await loadAdapter('reference');
  const manager = new BrowserManager(config);

  const runner = new BookingRunner({
    config,
    adapter,
    notifier: nullNotifier,
    session: new SessionStore(config),
    manager,
    filter: {
      dateFrom: config.booking.dateFrom,
      dateTo: config.booking.dateTo,
      weekdays: config.booking.weekdays,
    },
    credentials: { username: process.env.BOT_USERNAME, password: process.env.BOT_PASSWORD },
    application: loadApplication(config),
    contextOptions: { recordVideo: { dir: CAPTURE_DIR, size: [1280, 720] } },
  });

  try {
    const started = Date.now();
    const result = await runner.run('monitor');
    console.log(`\nresult: ${result.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (result.status === 'booked') console.log(`slot:   ${result.slot?.label}`);
  } finally {
    await manager.close();
    if (demo.server) await new Promise<void>((r) => demo.server!.close(() => r()));
    await closeLogger();
  }

  // Playwright finalises the file when the context closes.
  const produced = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.webm'));
  const latest = produced.map((f) => join(CAPTURE_DIR, f)).sort((a, b) => a.localeCompare(b)).at(-1);
  if (!latest) throw new Error('no .webm was produced — did the browser context close?');
  copyFileSync(latest, OUT_WEBM);
  rmSync(workDir, { recursive: true, force: true });

  console.log(`\ncapture: ${OUT_WEBM}`);
  console.log('next:    npm run demo:encode   → docs/demo.mp4');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
