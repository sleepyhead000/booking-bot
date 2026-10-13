import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { SessionStore } from '../src/core/session.js';
import { applyOverrides } from '../src/config/schema.js';

let dir: string;
let store: SessionStore;

const fakeContext = (marker = 'a') =>
  ({
    storageState: async () => ({ cookies: [{ name: 'sid', value: marker }], origins: [] }),
  }) as unknown as BrowserContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bot-session-'));
  const config = applyOverrides({ session: { dir, maxAgeMinutes: 60 } }, {});
  store = new SessionStore(config);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('reports no session when nothing has been saved', () => {
    expect(store.exists('reference')).toBe(false);
    expect(store.isFresh('reference')).toBe(false);
    expect(store.stateToLoad('reference')).toBeNull();
  });

  it('saves and reloads a session', async () => {
    await store.save(fakeContext(), 'reference');
    expect(store.exists('reference')).toBe(true);
    expect(store.isFresh('reference')).toBe(true);
    expect(store.stateToLoad('reference')).toBe(store.pathFor('reference'));
    expect(store.readMeta('reference')?.loggedIn).toBe(true);
  });

  it('treats a session older than maxAge as stale', async () => {
    await store.save(fakeContext(), 'reference');
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(store.pathFor('reference'), old, old);
    expect(store.isFresh('reference')).toBe(false);
    expect(store.stateToLoad('reference')).toBeNull();
  });

  it('ignores a session explicitly marked as logged out', async () => {
    await store.save(fakeContext(), 'reference', false);
    expect(store.isFresh('reference')).toBe(true);
    expect(store.stateToLoad('reference')).toBeNull();
  });

  it('clears both the state and the metadata', async () => {
    await store.save(fakeContext(), 'reference');
    store.clear('reference');
    expect(store.exists('reference')).toBe(false);
    expect(store.readMeta('reference')).toBeNull();
  });

  it('sanitises adapter ids into safe file names', async () => {
    await store.save(fakeContext(), 'my portal/v2');
    expect(store.pathFor('my portal/v2')).toContain('my_portal_v2');
    store.clear('my portal/v2');
  });

  it('keeps separate files per adapter', async () => {
    await store.save(fakeContext('a'), 'reference');
    await store.save(fakeContext('b'), 'other');
    expect(store.pathFor('reference')).not.toBe(store.pathFor('other'));
  });

  it('returns null for unreadable metadata', () => {
    writeFileSync(join(dir, 'broken.meta.json'), 'not json');
    expect(store.readMeta('broken')).toBeNull();
  });
});
