import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { Config } from '../config/schema.js';
import { logger } from '../util/logger.js';

export interface SessionMeta {
  adapter: string;
  savedAt: string;
  /** Cheap marker so we can tell a logged-in session from an anonymous one. */
  loggedIn?: boolean;
}

/**
 * Cookie/localStorage persistence.
 *
 * Playwright's `storageState()` captures both cookies and localStorage, which
 * is exactly what most portals use to keep you signed in. We snapshot it after
 * every successful login (and periodically during long monitoring runs) so a
 * restart doesn't burn a login — and therefore an OTP — every time.
 */
export class SessionStore {
  private readonly dir: string;
  private readonly maxAgeMs: number;

  constructor(config: Config) {
    this.dir = resolve(config.session.dir);
    this.maxAgeMs = config.session.maxAgeMinutes * 60_000;
  }

  pathFor(adapterId: string): string {
    return resolve(this.dir, `${sanitize(adapterId)}.json`);
  }

  metaPath(adapterId: string): string {
    return resolve(this.dir, `${sanitize(adapterId)}.meta.json`);
  }

  exists(adapterId: string): boolean {
    return existsSync(this.pathFor(adapterId));
  }

  /** True when a session file exists and is younger than maxAgeMinutes. */
  isFresh(adapterId: string): boolean {
    const p = this.pathFor(adapterId);
    if (!existsSync(p)) return false;
    const age = Date.now() - statSync(p).mtimeMs;
    if (age > this.maxAgeMs) {
      logger().debug({ adapter: adapterId, ageMin: Math.round(age / 60000) }, 'session expired');
      return false;
    }
    return true;
  }

  readMeta(adapterId: string): SessionMeta | null {
    const p = this.metaPath(adapterId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  /** Persist cookies + localStorage from a live context. */
  async save(context: BrowserContext, adapterId: string, loggedIn = true): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const state = await context.storageState();
    writeFileSync(this.pathFor(adapterId), JSON.stringify(state, null, 2), 'utf8');
    const meta: SessionMeta = { adapter: adapterId, savedAt: new Date().toISOString(), loggedIn };
    writeFileSync(this.metaPath(adapterId), JSON.stringify(meta, null, 2), 'utf8');
    logger().debug({ adapter: adapterId, loggedIn }, 'session saved');
  }

  /** Drop a stale/invalid session so the next start performs a fresh login. */
  clear(adapterId: string): void {
    for (const p of [this.pathFor(adapterId), this.metaPath(adapterId)]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* best effort */
        }
      }
    }
    logger().debug({ adapter: adapterId }, 'session cleared');
  }

  /**
   * Which storage state (if any) should be handed to `newContext`.
   * Returns null when there is nothing usable, meaning "start anonymous".
   */
  stateToLoad(adapterId: string): string | null {
    if (!this.isFresh(adapterId)) return null;
    const meta = this.readMeta(adapterId);
    if (meta && meta.loggedIn === false) return null;
    return this.pathFor(adapterId);
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
