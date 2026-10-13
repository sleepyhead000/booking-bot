/**
 * Poll cadence controller.
 *
 * Two competing goals: notice a newly released slot quickly, and never look
 * like a metronome. So the base interval is randomised inside [min, max], and
 * every consecutive empty cycle backs off exponentially (capped) — while any
 * hit resets the backoff instantly.
 *
 * Pure logic, no timers: the runner sleeps for `nextDelay()` and then calls
 * `recordEmpty()` / `recordHit()`, which keeps this trivially unit-testable.
 */
export interface PollerOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  backoffMaxMs: number;
  /** 0 = poll forever. */
  maxEmptyCycles: number;
  random?: () => number;
}

export class Poller {
  private emptyCycles = 0;
  private totalCycles = 0;
  private readonly random: () => number;

  constructor(private readonly opts: PollerOptions) {
    this.random = opts.random ?? Math.random;
  }

  get emptyStreak(): number {
    return this.emptyCycles;
  }

  get cycles(): number {
    return this.totalCycles;
  }

  get exhausted(): boolean {
    return this.opts.maxEmptyCycles > 0 && this.emptyCycles >= this.opts.maxEmptyCycles;
  }

  /** Randomised delay for the next cycle, with backoff after empty results. */
  nextDelay(): number {
    const base = this.opts.minIntervalMs + this.random() * (this.opts.maxIntervalMs - this.opts.minIntervalMs);
    if (this.emptyCycles === 0) return Math.round(base);

    const backoff = Math.min(
      this.opts.backoffMaxMs,
      this.opts.minIntervalMs * Math.pow(2, Math.min(this.emptyCycles, 10)),
    );
    // Blend: never slower than backoff, never faster than the random base.
    const target = Math.max(base, backoff);
    const jitter = target * 0.2 * this.random();
    return Math.round(target - target * 0.1 + jitter);
  }

  recordEmpty(): void {
    this.totalCycles++;
    this.emptyCycles++;
  }

  recordHit(): void {
    this.totalCycles++;
    this.emptyCycles = 0;
  }

  stats(): { cycles: number; emptyStreak: number; exhausted: boolean } {
    return { cycles: this.totalCycles, emptyStreak: this.emptyCycles, exhausted: this.exhausted };
  }
}
