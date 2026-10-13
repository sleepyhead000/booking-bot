import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockFile } from '../src/util/lockfile.js';
import { BotError } from '../src/util/errors.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bot-lock-'));
  path = join(dir, 'bot.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LockFile', () => {
  it('creates the lock on acquire and removes it on release', () => {
    const lock = new LockFile(path);
    lock.acquire();
    expect(existsSync(path)).toBe(true);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('rejects a second instance while the holder is alive', () => {
    const holder = new LockFile(path);
    holder.acquire();
    const other = new LockFile(path);
    expect(() => other.acquire()).toThrow(BotError);
    holder.release();
  });

  it('steals a lock left behind by a dead process', () => {
    writeFileSync(path, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
    const lock = new LockFile(path);
    expect(() => lock.acquire()).not.toThrow();
    expect(existsSync(path)).toBe(true);
    lock.release();
  });

  it('tolerates a corrupt lock file', () => {
    writeFileSync(path, 'garbage');
    const lock = new LockFile(path);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });

  it('release is a no-op for an instance that never acquired the lock', () => {
    const mine = new LockFile(path);
    mine.acquire();
    const stranger = new LockFile(path);
    expect(() => stranger.release()).not.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(stranger.release()).toBeUndefined();
    mine.release();
    expect(existsSync(path)).toBe(false);
  });

  it('release is idempotent for the holder', () => {
    const mine = new LockFile(path);
    mine.acquire();
    mine.release();
    expect(() => mine.release()).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
