import type { Page } from 'playwright';
import type { Config } from '../config/schema.js';
import type { Notifier } from '../notify/index.js';
import type { ChallengeTask, SolverProvider } from '../solver/types.js';
import { getSolver } from '../solver/registry.js';
import { BotError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { sleep } from '../util/async.js';

/**
 * Anti-bot challenge detection + resolution.
 *
 * Detection runs inside the page (DOM signals only — no network probing), and
 * resolution has two modes:
 *   - an automated solver provider (when one is configured) which returns a
 *     token we inject into the challenge response field;
 *   - `manual`, where we notify the operator and simply wait for the
 *     challenge to clear (it does, for the interactive cases), or for you to
 *     solve it yourself in a headed browser.
 */

const DETECT_SCRIPT = `(() => {
  const task = { present: false, kind: 'unknown', sitekey: undefined, action: undefined, cdata: undefined };

  const demo = document.querySelector('[data-demo-challenge]');
  const cfFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="/cdn-cgi/challenge-platform/"]');
  const cfForm = document.querySelector('#challenge-form, #challenge-stage, input[name="cf_chl_opt"], #challenge-running');
  const turnstile = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [data-turnstile-widget]');
  const widget = document.querySelector('[data-sitekey]');
  const title = (document.title || '').toLowerCase();

  if (demo) { task.present = true; task.kind = 'turnstile'; }
  else if (cfFrame || cfForm || title.includes('just a moment')) {
    task.present = true;
    task.kind = cfForm || title.includes('just a moment') ? 'cloudflare-challenge' : 'turnstile';
  } else if (turnstile || (widget && widget.getAttribute('data-sitekey'))) {
    // A widget present but not yet failed is not a challenge; only report it
    // when the response field is empty AND the widget claims to be running.
    const w = widget ? widget.getAttribute('data-sitekey') : undefined;
    if (w) { task.present = true; task.kind = 'turnstile'; }
  }

  if (task.present) {
    const source = widget || document.querySelector('[data-sitekey]');
    task.sitekey = source ? (source.getAttribute('data-sitekey') || undefined) : undefined;
    task.action = source ? (source.getAttribute('data-action') || undefined) : undefined;
    task.cdata = source ? (source.getAttribute('data-cdata') || undefined) : undefined;
  }
  return task;
})()`;

const INJECT_TOKEN_SCRIPT = `(token) => {
  const fields = document.querySelectorAll(
    'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"], #cf-turnstile-response',
  );
  for (const f of fields) {
    f.value = token;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const widget = window.turnstile;
  if (widget && typeof widget.getResponse === 'function') {
    try { widget.getResponse && widget.callback && widget.callback(token); } catch (e) {}
  }
  // Common integration hooks some portals expose.
  for (const hook of ['onTurnstileSuccess', '__cfChlDone', 'cfChlCb']) {
    if (typeof window[hook] === 'function') { try { window[hook](token); } catch (e) {} }
  }
  return fields.length;
}`;

/**
 * Detect an anti-bot challenge on `page`. Pure DOM inspection, safe to call on
 * any page at any time (returns null if the page is mid-navigation).
 * Exported so adapters can implement `isChallenged` without a ChallengeGuard.
 */
/** What DETECT_SCRIPT returns. All fields are optional — it runs hostile. */
interface DetectResult {
  present?: boolean;
  kind?: ChallengeTask['kind'];
  sitekey?: string;
  action?: string;
  cdata?: string;
}

export async function detectChallenge(page: Page): Promise<ChallengeTask | null> {
  let raw: DetectResult | null = null;
  try {
    raw = (await page.evaluate(DETECT_SCRIPT)) as DetectResult;
  } catch {
    return null; // page navigating away mid-check is fine
  }
  if (!raw?.present) return null;
  return {
    url: page.url(),
    kind: raw.kind ?? 'unknown',
    sitekey: raw.sitekey,
    action: raw.action,
    cdata: raw.cdata,
  };
}

/**
 * Standalone wait, for code that has no ChallengeGuard (adapters that navigate
 * mid-flow, scripts, tests). Resolves true when the page is challenge-free,
 * false when the timeout elapsed with a challenge still present.
 */
export async function waitForChallengeClear(
  page: Page,
  timeoutMs: number,
  opts: { intervalMs?: number; onPage?: (task: ChallengeTask | null) => void } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const interval = opts.intervalMs ?? 1000;
  while (Date.now() < deadline) {
    const task = await detectChallenge(page);
    opts.onPage?.(task);
    if (!task) return true;
    await sleep(interval);
  }
  return (await detectChallenge(page)) === null;
}

export class ChallengeGuard {
  private readonly getPage: () => Page;

  /** `page` is late-bound: the guard is built before the browser context is. */
  constructor(getPage: () => Page, private readonly config: Config, private readonly notifier: Notifier) {
    this.getPage = getPage;
  }

  /** Detect a challenge on the current page. Null when there is none. */
  async detect(): Promise<ChallengeTask | null> {
    try {
      return await detectChallenge(this.getPage());
    } catch {
      return null; // no page yet (or it is mid-navigation)
    }
  }

  /**
   * Resolve any challenge currently blocking the page.
   * Throws BotError('challenge') when it cannot be cleared in time.
   */
  async ensureClear(label: string): Promise<void> {
    const task = await this.detect();
    if (!task) return;

    const since = Date.now();
    logger().warn({ kind: task.kind, url: task.url, label }, 'anti-bot challenge detected');
    await this.notifier
      .send({
        level: 'warn',
        title: `Challenge detected (${task.kind})`,
        body: `${label}\n${task.url}`,
      })
      .catch(() => undefined);

    const providerId = this.config.solver.provider;
    let provider: SolverProvider | null = null;
    try {
      provider = await getSolver(providerId);
    } catch (err) {
      logger().warn({ err, providerId }, 'solver provider unavailable, waiting for manual clearance');
    }

    const timeoutMs = this.config.solver.timeoutSec * 1000;

    if (provider && provider.id !== 'manual') {
      const result = await provider.solve(task, timeoutMs);
      logger().info({ provider: result.provider, ms: result.elapsedMs }, 'challenge token obtained');
      const injected = await this.getPage().evaluate(INJECT_TOKEN_SCRIPT, result.token).catch(() => 0);
      logger().debug({ injected }, 'token injected');
      await this.notifier
        .send({ level: 'info', title: 'Challenge solved', body: `provider: ${result.provider}` })
        .catch(() => undefined);
    } else if (this.config.browser.headless) {
      logger().info('manual solver mode: waiting for the challenge to clear');
    }

    await this.waitForClear(timeoutMs, label, since);
  }

  /** Poll until no challenge is present, or throw on timeout. */
  private async waitForClear(timeoutMs: number, label: string, since: number): Promise<void> {
    const deadline = since + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      const task = await this.detect();
      if (!task) {
        logger().info({ label, waitedMs: Date.now() - since }, 'challenge cleared');
        return;
      }
      attempt++;
      if (attempt % 6 === 0) {
        await this.notifier
          .send({ level: 'info', title: 'Still waiting on challenge', body: `${label} (${Math.round((Date.now() - since) / 1000)}s)` })
          .catch(() => undefined);
      }
      await sleep(1000);
    }
    throw new BotError('challenge', `anti-bot challenge did not clear within ${Math.round(timeoutMs / 1000)}s`, {
      retryable: true,
    });
  }
}
