import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/util/retry.js';
import { BotError } from '../src/util/errors.js';

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRetry(fn, { attempts: 3 })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until it succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('boom');
      return 'ok';
    });
    await expect(withRetry(fn, { attempts: 5, baseDelayMs: 1, random: () => 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always'));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, random: () => 0 })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops early when shouldRetry says no', async () => {
    const fn = vi.fn().mockRejectedValue(new BotError('auth', 'bad credentials', { retryable: false }));
    await expect(
      withRetry(fn, { attempts: 5, baseDelayMs: 1, shouldRetry: (e) => (e as BotError).retryable }),
    ).rejects.toThrow('bad credentials');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports the delay before each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('y');
    await withRetry(fn, { attempts: 3, baseDelayMs: 100, onRetry, random: () => 0 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![2]).toBeGreaterThan(0);
  });
});
