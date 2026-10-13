import type { Page } from 'playwright';
import type {
  ApplicationData,
  Credentials,
  DocumentAttachment,
  PortalAdapter,
  Slot,
} from '../types.js';
import { humanClick, humanType, think } from '../../core/human.js';
import { detectChallenge } from '../../core/challenge.js';
import { ApiSniffer } from '../../monitor/api-sniff.js';
import { attachAll, resolveDocuments } from '../../documents/pdf.js';
import { BotError } from '../../util/errors.js';
import { logger } from '../../util/logger.js';

const BASE_URL = (process.env.REFERENCE_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');

const SELECTORS = {
  username: '#username',
  password: '#password',
  loginButton: '#login-button',
  loginError: '#login-error',
  otpInput: '#code',
  otpButton: '#otp-button',
  otpError: '#otp-error',
  resendButton: '#resend-button',
  refreshButton: '[data-testid="refresh-slots"]',
  calendar: '[data-testid="calendar"]',
  selection: '[data-testid="selection"]',
  submitButton: '#submit-button',
  formError: '#form-error',
  confirmation: '[data-testid="confirmation"]',
  fileInfo: '[data-testid="file-info"]',
} as const;

/** Payload shape of the demo portal's `GET /api/slots`. */
interface SlotsPayload {
  slots: Array<{ id: string; date: string; time: string; label?: string }>;
}

function toSlots(payload: SlotsPayload): Slot[] {
  if (!payload || !Array.isArray(payload.slots)) return [];
  return payload.slots.map((s) => ({
    id: s.id,
    date: s.date,
    time: s.time,
    label: s.label ?? `${s.date} ${s.time}`,
    meta: { source: 'api' },
  }));
}

/** Per-page API sniffer, so concurrent contexts never see each other's traffic. */
const sniffers = new WeakMap<Page, ApiSniffer<Slot[]>>();

/**
 * Reference adapter — drives the bundled demo portal (npm run demo).
 *
 * It exists to prove the core end-to-end and to serve as the worked example
 * for porting to a real site: copy this folder, replace the selectors and the
 * page order, and the rest of the bot (session, polling, OTP, notifications,
 * challenge handling) keeps working unchanged.
 */
export const adapter: PortalAdapter = {
  id: 'reference',
  displayName: 'Reference demo portal',
  baseUrl: BASE_URL,
  authenticatedMarker: SELECTORS.refreshButton,

  async prepare(page: Page): Promise<void> {
    // Watch the portal's own availability API — the fast path for polling.
    const sniffer = new ApiSniffer<Slot[]>(page, /\/api\/slots(\?|$)/, (body) =>
      toSlots(body as SlotsPayload),
    );
    sniffer.start();
    sniffers.set(page, sniffer);
  },

  async login(page: Page, creds: Credentials): Promise<void> {
    const username = creds.username?.trim();
    const password = creds.password;
    if (!username || !password) {
      throw new BotError('auth', 'BOT_USERNAME / BOT_PASSWORD are not set (see .env.example)', {
        retryable: false,
      });
    }

    // Only navigate if we are not already on the entry page: a redundant
    // goto() would re-run every page script (and re-trigger any challenge)
    // after the runner has just cleared it.
    if (new URL(page.url()).pathname !== '/') {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    }
    await think(200, 600);

    await humanType(page, SELECTORS.username, username);
    await humanType(page, SELECTORS.password, password);

    const loginResponse = page.waitForResponse(
      (r) => r.url().includes('/api/login') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await humanClick(page, SELECTORS.loginButton);

    const resp = await loginResponse;
    const body = (await resp.json().catch(() => ({}))) as { error?: string; status?: string };
    if (!resp.ok()) {
      throw new BotError('auth', body.error ?? `login rejected (HTTP ${resp.status()})`, {
        retryable: false,
      });
    }

    await page.waitForURL('**/otp', { timeout: 15_000 }).catch(() => undefined);
    logger().debug('credentials accepted, OTP step reached');
  },

  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      const res = await page.request.get(`${BASE_URL}/api/me`);
      if (!res.ok()) return false;
      const data = (await res.json()) as { authed?: boolean };
      return Boolean(data.authed);
    } catch {
      return false;
    }
  },

  async isOtpPromptVisible(page: Page): Promise<boolean> {
    const loc = page.locator(SELECTORS.otpInput).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },

  async submitOtp(page: Page, code: string): Promise<void> {
    await humanType(page, SELECTORS.otpInput, code);

    const response = page.waitForResponse(
      (r) => r.url().includes('/api/otp') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await humanClick(page, SELECTORS.otpButton);

    const resp = await response;
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    if (!resp.ok()) {
      throw new BotError('otp', body.error ?? `code rejected (HTTP ${resp.status()})`, {
        retryable: false,
      });
    }
    await page.waitForURL('**/book', { timeout: 15_000 });
    await page.locator(SELECTORS.refreshButton).first().waitFor({ state: 'visible', timeout: 15_000 });
  },

  async requestNewOtp(page: Page): Promise<void> {
    const btn = page.locator(SELECTORS.resendButton).first();
    if ((await btn.count()) === 0) return;
    await humanClick(page, btn);
    await think(200, 500);
  },

  async getSlots(page: Page): Promise<Slot[]> {
    const sniffer = sniffers.get(page);

    // Make sure we are on the calendar before poking it.
    if (!page.url().includes('/book')) {
      await page.goto(`${BASE_URL}/book`, { waitUntil: 'domcontentloaded' });
      await page.locator(SELECTORS.refreshButton).first().waitFor({ state: 'visible', timeout: 15_000 });
    }

    const refresh = page.locator(SELECTORS.refreshButton).first();
    if ((await refresh.count()) > 0) {
      const next = sniffer ? sniffer.awaitNext(8000) : Promise.resolve(null);
      try {
        await humanClick(page, refresh);
      } catch (err) {
        logger().debug({ err }, 'refresh click failed, falling back to DOM scrape');
      }
      const payload = await next;
      if (payload) return payload;
    }

    return scrapeSlotsFromDom(page);
  },

  async selectSlot(page: Page, slot: Slot, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const day = page.locator(`.day[data-date="${slot.date}"]`).first();

    if ((await day.count()) === 0) {
      logger().debug({ slot: slot.label }, 'date cell not present');
      return false;
    }
    await humanClick(page, day);
    await think(150, 450);

    const time = page.locator(`.time[data-slot-id="${slot.id}"]`).first();
    try {
      await time.waitFor({ state: 'visible', timeout: Math.max(1000, deadline - Date.now()) });
    } catch {
      logger().debug({ slot: slot.label }, 'time chip not offered — slot likely taken');
      return false;
    }

    await humanClick(page, time);
    const selection = await page.locator(SELECTORS.selection).first().textContent().catch(() => null);
    const ok = Boolean(selection?.includes('Selected'));
    logger().debug({ slot: slot.label, ok }, 'slot selection result');
    return ok;
  },

  async fillApplication(page: Page, app: ApplicationData): Promise<void> {
    const map: Array<[keyof typeof app.fields | string, string]> = [
      ['surname', '#surname'],
      ['givenName', '#givenName'],
      ['passport', '#passport'],
      ['email', '#email'],
    ];

    for (const [field, selector] of map) {
      const value = app.fields[field];
      if (value === undefined || value === '') continue;
      await humanType(page, selector, value);
    }

    const missing = map
      .filter(([field]) => !String(app.fields[field] ?? '').trim())
      .map(([field]) => field);
    if (missing.length) {
      throw new BotError('form', `missing application fields: ${missing.join(', ')}`, {
        retryable: false,
      });
    }
  },

  async attachDocuments(page: Page, docs: DocumentAttachment[]): Promise<void> {
    const resolved = resolveDocuments(docs);
    await attachAll(page, resolved, async (file) => {
      const info = await page
        .locator(SELECTORS.fileInfo)
        .first()
        .textContent()
        .catch(() => null);
      return Boolean(info && info.includes(file.name));
    });
  },

  async submitApplication(page: Page): Promise<void> {
    const response = page.waitForResponse(
      (r) => r.url().includes('/api/book') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await humanClick(page, SELECTORS.submitButton);

    const resp = await response;
    const body = (await resp.json().catch(() => ({}))) as { error?: string; reference?: string };
    if (!resp.ok()) {
      throw new BotError('form', body.error ?? `submission rejected (HTTP ${resp.status()})`, {
        retryable: resp.status() >= 500,
      });
    }

    const confirmation = page.locator(SELECTORS.confirmation).first();
    await confirmation.waitFor({ state: 'visible', timeout: 15_000 });
    const text = (await confirmation.textContent()) ?? '';
    logger().info({ confirmation: text }, 'booking confirmed');
  },

  async isChallenged(page: Page): Promise<boolean> {
    return (await detectChallenge(page)) !== null;
  },
};

/** DOM fallback when the API payload could not be sniffed. */
async function scrapeSlotsFromDom(page: Page): Promise<Slot[]> {
  try {
    await page.locator(SELECTORS.calendar).first().waitFor({ state: 'visible', timeout: 5000 });
    const rows = await page.$$eval(`${SELECTORS.calendar} .day.available`, (els) =>
      els.flatMap((el) => {
        const date = el.getAttribute('data-date') ?? '';
        const ids = (el.getAttribute('data-slot-ids') ?? '').split(',').filter(Boolean);
        return ids.map((id) => ({ id, date, time: id.slice(-5) }));
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      date: r.date,
      time: r.time,
      label: `${r.date} ${r.time}`,
      meta: { source: 'dom' },
    }));
  } catch (err) {
    logger().debug({ err }, 'DOM slot scrape failed');
    return [];
  }
}
