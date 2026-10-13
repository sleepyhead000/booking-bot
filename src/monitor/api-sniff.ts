import type { Page, Response } from 'playwright';
import { logger } from '../util/logger.js';

/**
 * API response sniffer.
 *
 * Many portals load calendar availability with an XHR/fetch call. Watching that
 * response is faster and far more robust than scraping the rendered DOM: no
 * re-render races, no virtualised lists, no "is it stale?" questions.
 *
 * Adapters opt in by giving a URL pattern and a parser. The monitor then gets
 * the payload the portal itself uses, straight off the wire.
 */
export class ApiSniffer<T> {
  private readonly page: Page;
  private readonly pattern: RegExp;
  private readonly parse: (body: unknown) => T;
  private last?: { payload: T; at: number; url: string };
  private waiters: Array<{ resolve: (v: T) => void; timer: NodeJS.Timeout }> = [];
  private attached = false;

  constructor(page: Page, pattern: RegExp, parse: (body: unknown) => T) {
    this.page = page;
    this.pattern = pattern;
    this.parse = parse;
  }

  start(): void {
    if (this.attached) return;
    this.attached = true;
    this.page.on('response', this.onResponse);
  }

  stop(): void {
    if (!this.attached) return;
    this.attached = false;
    this.page.off('response', this.onResponse);
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
  }

  private readonly onResponse = (res: Response): void => {
    if (!this.pattern.test(res.url())) return;
    // Fire and forget: never block the response pipeline on our parsing.
    void this.handle(res);
  };

  private async handle(res: Response): Promise<void> {
    let body: unknown;
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      body = await res.json();
    } catch {
      return;
    }
    let payload: T;
    try {
      payload = this.parse(body);
    } catch (err) {
      logger().debug({ err, url: res.url() }, 'api-sniff: parser rejected payload');
      return;
    }
    this.last = { payload, at: Date.now(), url: res.url() };
    const pending = this.waiters.splice(0);
    for (const w of pending) {
      clearTimeout(w.timer);
      w.resolve(payload);
    }
  }

  /** Most recent payload seen (may predate this poll cycle). */
  latest(): T | null {
    return this.last?.payload ?? null;
  }

  /**
   * Wait for the *next* matching payload — i.e. one that arrives after this
   * call, which is what "trigger a refresh, then read its response" needs.
   * Returns null on timeout; callers should keep a DOM-scraping fallback.
   */
  async awaitNext(timeoutMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const entry: { resolve: (v: T) => void; timer: NodeJS.Timeout } = {
        resolve: (v) => {
          clearTimeout(entry.timer);
          resolve(v);
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== entry);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }
}
