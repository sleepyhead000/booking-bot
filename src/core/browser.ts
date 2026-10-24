import { chromium, type Browser, type BrowserContext } from 'playwright';
import { resolve } from 'node:path';
import type { Config } from '../config/schema.js';
import { logger } from '../util/logger.js';
import { BotError } from '../util/errors.js';
import { stealthScript } from './stealth.js';

/** Playwright's proxy shape (not re-exported by the public typings). */
interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface ContextOptions {
  /** Reuse a persisted login (cookies + localStorage) if the file exists. */
  storageStatePath?: string | null;
  /** Override the proxy for this context (else taken from BOT_PROXY_URL). */
  proxy?: string;
  /** Extra HTTP headers applied to every request in this context. */
  headers?: Record<string, string>;
  /**
   * Record the session to a .webm (Playwright/Chromium). Used by the README
   * demo capture and by `--set browser.recordVideo=...` when debugging a run.
   */
  recordVideo?: { dir: string; size?: [number, number] };
}

/**
 * Owns the Chromium process for the whole run. One browser, one context per
 * session — contexts are cheap, browsers are not, and keeping a single browser
 * avoids leaking a fresh (and therefore suspicious) process per poll cycle.
 */
export class BrowserManager {
  private browser?: Browser;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get headless(): boolean {
    return this.config.browser.headless;
  }

  async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    const proxyUrl = this.proxyFromEnv();
    const launchOpts: Parameters<typeof chromium.launch>[0] = {
      headless: this.config.browser.headless,
      slowMo: this.config.browser.slowMo,
      args: [
        // Standard hardening: don't advertise automation, keep a stable surface.
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
      ],
    };
    if (proxyUrl) launchOpts.proxy = buildProxy(proxyUrl);

    logger().info(
      { headless: this.config.browser.headless, proxy: proxyUrl ? 'configured' : 'none' },
      'launching browser',
    );

    try {
      this.browser = await chromium.launch(launchOpts);
    } catch (err) {
      throw new BotError('config', `failed to launch chromium: ${(err as Error).message}`, {
        cause: err,
        retryable: false,
      });
    }
    return this.browser;
  }

  /**
   * Create a fresh context: consistent fingerprint (locale/timezone/viewport),
   * stealth init script, optional persisted session and proxy.
   */
  async newContext(opts: ContextOptions = {}): Promise<BrowserContext> {
    const browser = await this.launch();
    const [width, height] = this.config.browser.viewport;

    const contextOpts: Parameters<Browser['newContext']>[0] = {
      viewport: { width, height },
      locale: this.config.browser.locale,
      timezoneId: this.config.browser.timezoneId,
      // Headless Chrome advertises itself in the UA. Claim the real Chrome
      // build (same version number, no "Headless" marker) instead.
      userAgent: buildUserAgent(browser.version()),
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      bypassCSP: false,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      ...(opts.headers ? { extraHTTPHeaders: opts.headers } : {}),
    };

    const proxy = opts.proxy ?? this.proxyFromEnv();
    if (proxy) contextOpts.proxy = buildProxy(proxy);

    const statePath = opts.storageStatePath ? resolve(opts.storageStatePath) : undefined;
    if (statePath) contextOpts.storageState = statePath;

    if (opts.recordVideo) {
      const [width, height] = opts.recordVideo.size ?? [this.config.browser.viewport[0], this.config.browser.viewport[1]];
      contextOpts.recordVideo = { dir: resolve(opts.recordVideo.dir), size: { width, height } };
    }

    const context = await browser.newContext(contextOpts);

    // Stealth must run before any site script evaluates.
    await context.addInitScript(stealthScript());

    // Keep outgoing requests looking like they come from one consistent client.
    await context.setExtraHTTPHeaders({
      'accept-language': `${this.config.browser.locale},en;q=0.8`,
      ...(opts.headers ?? {}),
    });

    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    return context;
  }

  private proxyFromEnv(): string | undefined {
    return process.env.BOT_PROXY_URL?.trim() || undefined;
  }

  async close(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch (err) {
      logger().warn({ err }, 'error while closing browser');
    }
    this.browser = undefined;
  }
}

function buildProxy(url: string): ProxySettings {
  const parsed = new URL(url);
  const proxy: ProxySettings = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

/**
 * A stock Chrome UA for the exact Chromium build we launched: same version,
 * no "Headless" marker, OS token matching the machine (and the
 * navigator.platform the init script reports).
 */
export function buildUserAgent(version: string, platform: NodeJS.Platform = process.platform): string {
  const chrome = version.replace(/^[A-Za-z]+\//, '');
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}
