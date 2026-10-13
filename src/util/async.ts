/** Promise-based sleep + a few timing helpers used across the bot. */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleep for `ms` plus up to `jitterRatio` extra, chosen uniformly at random. */
export function sleepWithJitter(ms: number, jitterRatio = 0.3): Promise<void> {
  const jitter = ms * jitterRatio * Math.random();
  return sleep(Math.round(ms + jitter));
}

export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Random delay in [minMs, maxMs] — used for human-like pauses. */
export async function randomPause(minMs: number, maxMs: number): Promise<void> {
  await sleep(randomInt(minMs, maxMs));
}
