import type { Page } from 'playwright';
import type { Config } from '../config/schema.js';
import { BrowserManager } from './browser.js';
import { logger } from '../util/logger.js';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * `bot doctor` — launch a real browser, run the cheap automation-detection
 * probes against it, and print a verdict. This is the smoke test for the
 * stealth layer: run it after any Playwright or stealth change.
 */
export async function runDoctor(config: Config, opts: { url?: string; headed?: boolean } = {}): Promise<CheckResult[]> {
  const effective: Config = opts.headed ? { ...config, browser: { ...config.browser, headless: false } } : config;
  const manager = new BrowserManager(effective);
  const results: CheckResult[] = [];

  try {
    const context = await manager.newContext();
    const page = await context.newPage();

    const target = opts.url ?? 'about:blank';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
      logger().warn({ err: (err as Error).message }, 'doctor: navigation failed, probing blank page');
    });

    results.push(...(await probeStealth(page)));
    results.push(...(await probeConsistency(page)));
    if (opts.url && opts.url !== 'about:blank') {
      results.push(...(await probeExternal(page, opts.url)));
    }

    await context.close();
  } catch (err) {
    results.push({ name: 'browser-launch', pass: false, detail: (err as Error).message });
  } finally {
    await manager.close();
  }

  return results;
}

async function probeStealth(page: Page): Promise<CheckResult[]> {
  const facts = await page.evaluate(() => {
    const w = window as unknown as { chrome?: { runtime?: unknown } };
    return {
      webdriver: navigator.webdriver,
      hasChrome: typeof w.chrome?.runtime === 'object',
      languages: navigator.languages ? Array.from(navigator.languages) : [],
      plugins: navigator.plugins ? navigator.plugins.length : -1,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      stackLimit: (Error as unknown as { stackTraceLimit?: number }).stackTraceLimit ?? -1,
    };
  });

  const results: CheckResult[] = [
    {
      name: 'navigator.webdriver hidden',
      pass: facts.webdriver === undefined || facts.webdriver === false,
      detail: `webdriver=${String(facts.webdriver)}`,
    },
    {
      name: 'window.chrome present',
      pass: facts.hasChrome,
      detail: facts.hasChrome ? 'chrome.runtime exists' : 'missing — headless tell',
    },
    {
      name: 'plugins non-empty',
      pass: facts.plugins > 0,
      detail: `${facts.plugins} plugin(s)`,
    },
    {
      name: 'languages sane',
      pass: Array.isArray(facts.languages) && facts.languages.length > 0,
      detail: JSON.stringify(facts.languages),
    },
    {
      name: 'Error.stackTraceLimit',
      pass: facts.stackLimit >= 40,
      detail: String(facts.stackLimit),
    },
  ];

  try {
    const state = await page.evaluate(async () => {
      const r = await navigator.permissions.query({ name: 'notifications' as PermissionName });
      return r.state;
    });
    results.push({
      name: 'permissions.query(notifications)',
      pass: state === 'granted' || state === 'denied' || state === 'prompt',
      detail: state,
    });
  } catch (err) {
    results.push({
      name: 'permissions.query(notifications)',
      pass: false,
      detail: (err as Error).message,
    });
  }

  return results;
}

/** Flags internal inconsistencies (UA vs platform vs languages). */
async function probeConsistency(page: Page): Promise<CheckResult[]> {
  const ua = await page.evaluate(() => navigator.userAgent);
  const platform = await page.evaluate(() => navigator.platform);
  const headlessTell = /HeadlessChrome/i.test(ua);
  const platformOk = platform.length > 0;

  return [
    {
      name: 'no HeadlessChrome in UA',
      pass: !headlessTell,
      detail: headlessTell ? 'UA exposes headless' : 'clean',
    },
    {
      name: 'navigator.platform set',
      pass: platformOk,
      detail: platform,
    },
  ];
}

/**
 * Optional external probe. Points at any page you like (a bot-detection
 * service, the real portal, ...). We never hardcode a third-party URL.
 */
async function probeExternal(page: Page, url: string): Promise<CheckResult[]> {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = resp?.status() ?? 0;
    return [
      {
        name: `navigates ${new URL(url).host}`,
        pass: status > 0 && status < 400,
        detail: `HTTP ${status}`,
      },
    ];
  } catch (err) {
    return [{ name: `navigates ${new URL(url).host}`, pass: false, detail: (err as Error).message }];
  }
}
