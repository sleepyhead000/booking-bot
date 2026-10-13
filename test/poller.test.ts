import { describe, it, expect } from 'vitest';
import { Poller } from '../src/monitor/poller.js';

function makePoller(overrides: Partial<ConstructorParameters<typeof Poller>[0]> = {}) {
  let seed = 0;
  const random = () => {
    // Deterministic pseudo-random in [0,1).
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return new Poller({
    minIntervalMs: 1000,
    maxIntervalMs: 2000,
    backoffMaxMs: 8000,
    maxEmptyCycles: 0,
    random,
    ...overrides,
  });
}

describe('poller', () => {
  it('keeps an idle-cycle delay inside the configured window', () => {
    const p = makePoller();
    const d = p.nextDelay();
    expect(d).toBeGreaterThanOrEqual(900); // −10% jitter floor
    expect(d).toBeLessThanOrEqual(2200); // +10% ceiling of max
  });

  it('produces different delays on successive idle cycles', () => {
    const p = makePoller({ backoffMaxMs: 0 });
    const seen = new Set<number>();
    for (let i = 0; i < 10; i++) {
      seen.add(p.nextDelay());
      p.recordEmpty();
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('backs off exponentially while results stay empty', () => {
    const p = makePoller();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(p.nextDelay());
      p.recordEmpty();
    }
    expect(delays[1]!).toBeGreaterThan(delays[0]! - 300);
    expect(delays[4]!).toBeGreaterThan(delays[1]!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(9000);
  });

  it('caps the backoff at backoffMaxMs', () => {
    const p = makePoller({ backoffMaxMs: 3000 });
    for (let i = 0; i < 12; i++) {
      expect(p.nextDelay()).toBeLessThanOrEqual(3400);
      p.recordEmpty();
    }
  });

  it('resets the backoff the moment a slot is found', () => {
    const p = makePoller();
    for (let i = 0; i < 5; i++) p.recordEmpty();
    p.recordHit();
    expect(p.emptyStreak).toBe(0);
    expect(p.nextDelay()).toBeLessThanOrEqual(2200);
  });

  it('stops after maxEmptyCycles, but not before', () => {
    const p = makePoller({ maxEmptyCycles: 3 });
    p.recordEmpty();
    p.recordEmpty();
    expect(p.exhausted).toBe(false);
    p.recordEmpty();
    expect(p.exhausted).toBe(true);
  });

  it('never stops when maxEmptyCycles is 0', () => {
    const p = makePoller({ maxEmptyCycles: 0 });
    for (let i = 0; i < 100; i++) p.recordEmpty();
    expect(p.exhausted).toBe(false);
  });

  it('counts cycles', () => {
    const p = makePoller();
    p.recordEmpty();
    p.recordHit();
    p.recordEmpty();
    expect(p.cycles).toBe(3);
  });
});
