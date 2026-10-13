import { sleep } from './async.js';

export interface RetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each failure. */
  factor?: number;
  /** Return false to stop retrying (e.g. non-retryable BotError kinds). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Called before each wait — good for logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injected for tests; defaults to a real timer sleep. */
  random?: () => number;
}

/**
 * Run `fn` with exponential backoff + jitter. Jitter keeps retries off a
 * fixed cadence, which matters when the target site is watching for bots.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 15_000;
  const factor = opts.factor ?? 2;
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retry = opts.shouldRetry?.(err, attempt) ?? true;
      if (!retry || attempt === attempts) break;
      const exp = Math.min(max, base * Math.pow(factor, attempt - 1));
      const delay = Math.round(exp * (0.5 + random() * 0.5));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
