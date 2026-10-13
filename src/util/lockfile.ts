import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { BotError } from './errors.js';

/**
 * Single-instance lock.
 *
 * Two monitors on one portal double the request rate and can fight over the
 * same session file. Cheap insurance: an atomic-ish lock file carrying the pid,
 * with stale-lock recovery if the process is gone.
 */
export class LockFile {
  private held = false;
  private readonly path: string;

  constructor(path = 'storage/bot.lock') {
    this.path = resolve(path);
  }

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });

    if (existsSync(this.path)) {
      const holder = this.read();
      if (holder && isAlive(holder.pid)) {
        // Same pid: either we already own it (idempotent) or a second instance
        // inside this process is trying to start. Both are worth guarding.
        if (holder.pid === process.pid && this.held) return;
        throw new BotError(
          'config',
          `another instance is already running (pid ${holder.pid}, since ${holder.startedAt ?? 'unknown'})` +
            '. If that is wrong, delete storage/bot.lock.',
          { retryable: false },
        );
      }
      // Holder is gone — recover the stale lock.
      try {
        unlinkSync(this.path);
      } catch {
        /* race with another starter; the wx write below will arbitrate */
      }
    }

    try {
      writeFileSync(
        this.path,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
        { flag: 'wx' },
      );
      this.held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new BotError('config', 'another instance acquired the lock first', { retryable: false });
      }
      throw err;
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const holder = this.read();
      if (holder?.pid === process.pid && existsSync(this.path)) unlinkSync(this.path);
    } catch {
      /* best effort */
    }
  }

  private read(): { pid: number; startedAt: string } | null {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return null;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
